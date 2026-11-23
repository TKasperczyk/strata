import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readArchive, readState } from '../src/archive.js'
import { compact, HEADER_MARK, mediaExtension, OversizeError, planLedger, prepare, UnpreservableError, type LedgerFn } from '../src/compact.js'
import { readReady, tryLock } from '../src/ready.js'
import { loadConfig, type Config } from '../src/config.js'
import { renderEpisode, renderIndex, segmentEpisodes } from '../src/episodes.js'
import { maskMessage, messageChars, STUB_PREFIX } from '../src/mask.js'
import type { Message, OutputEntry } from '../src/types.js'
import { segmentUnits } from '../src/units.js'
import type { ApiMessage } from '../src/weights.js'

const SESSION = 'test-session'
const SHOW = 'strata show test-session'
const BIG_RESULT = 'x'.repeat(8_000)
const SMALL_RESULT = 'y'.repeat(1_000)
const BUDGET_TOKENS = 4_000
const BUDGET_CHARS = BUDGET_TOKENS * 3.5
const ANSWER_DETAIL = 'detail '.repeat(60)

let dir: string
let config: Config
let ledgerSpans: number[][]
const fakeLedger: LedgerFn = async (previous, span) => {
  ledgerSpans.push(span.map(m => m.seq))
  return { ledger: `${previous}\n- covered through #${span.at(-1)?.seq}`.trim(), requests: 1 }
}

const user = (text: string): Message => ({ role: 'user', text, toolUses: [] })
const call = (id: string, text = '', result = BIG_RESULT): Message => ({ role: 'assistant', text, toolUses: [{ tool_use_id: id, tool: 'Read', input: { file_path: `/src/${id}.ts` }, text: result }] })
const resultsOf = (result: string, ...ids: string[]): Message => ({ role: 'user', text: '', toolUses: [], toolResults: ids.map(id => ({ tool_use_id: id, text: result, isError: false })) })
const results = (...ids: string[]): Message => resultsOf(BIG_RESULT, ...ids)
const answer = (text: string): Message => ({ role: 'assistant', text: `${text} ${ANSWER_DETAIL}`, toolUses: [] })
const thinkingOnly = (): Message => ({ role: 'assistant', text: '', toolUses: [] })

/** One prompt → assistant tool call → large result → assistant answer. */
function turn(n: number): Message[] {
  return [user(`prompt ${n}: please do step ${n}`), call(`t${n}`, `Running step ${n}.`), results(`t${n}`), answer(`Step ${n} done.`)]
}

/**
 * A streamed response split per block, opening with a thinking row, with a
 * result landing between its calls. Small results: as the latest response it
 * must stay verbatim, so it has to fit the budget.
 */
function interleaved(n: number, result = SMALL_RESULT): Message[] {
  return [user(`prompt ${n}`), thinkingOnly(), call(`x${n}`, '', result), call(`y${n}`, '', result), resultsOf(result, `x${n}`), call(`z${n}`, '', result), resultsOf(result, `y${n}`, `z${n}`), answer(`done ${n}`)]
}

function materialize(input: Message[], entries: OutputEntry[]): Message[] {
  return entries.map(e => ('keep' in e ? input[e.keep] : e.built))
}

function chars(messages: Message[]): number {
  return messages.reduce((n, m) => n + messageChars(m), 0)
}

/**
 * Messages-API validity of built output: merge same-role runs into turns,
 * then every call must be answered by the very next turn and every result
 * must answer a call from the turn before.
 */
function assertPaired(messages: Message[]): void {
  const turns: Message[] = []
  for (const m of messages) {
    const last = turns.at(-1)
    if (last && last.role === m.role) {
      turns[turns.length - 1] = { ...last, toolUses: [...last.toolUses, ...m.toolUses], toolResults: [...(last.toolResults ?? []), ...(m.toolResults ?? [])] }
    } else turns.push({ ...m, toolResults: [...(m.toolResults ?? [])] })
  }
  turns.forEach((t, i) => {
    const calls = t.toolUses.map(u => u.tool_use_id)
    const answered = (turns[i + 1]?.toolResults ?? []).map(r => r.tool_use_id)
    expect(answered, `turn ${i} calls`).toEqual(expect.arrayContaining(calls))
    const prevCalls = (turns[i - 1]?.toolUses ?? []).map(u => u.tool_use_id)
    expect(prevCalls, `turn ${i} results`).toEqual(expect.arrayContaining((t.toolResults ?? []).map(r => r.tool_use_id)))
  })
}

const run = (messages: Message[], ledger: LedgerFn = fakeLedger) => compact({ sessionKey: SESSION, messages, showCommand: SHOW }, config, ledger)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'strata-test-'))
  config = loadConfig({ dataDir: dir, budgetTokens: BUDGET_TOKENS, ledgerRebuildEvery: 0 })
  ledgerSpans = []
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('segmentUnits', () => {
  it('keeps a streamed response and its interleaved results in one exchange', () => {
    const units = segmentUnits(interleaved(0))
    expect(units.map(u => [u.kind, u.end - u.start])).toEqual([['prompt', 1], ['exchange', 6], ['exchange', 1]])
  })
})

describe('compact', () => {
  it('keeps the live context within budget across many compactions', async () => {
    let live: Message[] = []
    const sizes: number[] = []
    for (let n = 0; n < 40; n++) {
      live.push(...(n % 3 === 0 ? interleaved(n) : turn(n)))
      if (chars(live) < BUDGET_CHARS * 2) continue
      live = materialize(live, (await run(live)).entries)
      sizes.push(chars(live))
    }
    expect(sizes.length).toBeGreaterThan(5)
    for (const size of sizes) expect(size).toBeLessThanOrEqual(BUDGET_CHARS)
  })

  it('archives every raw message exactly once and recognises its own output', async () => {
    let live: Message[] = []
    let total = 0
    let compactions = 0
    for (let n = 0; n < 20; n++) {
      const next = turn(n)
      live.push(...next)
      total += next.length
      if (chars(live) < BUDGET_CHARS * 2) continue
      const { entries, stats } = await run(live)
      if (compactions++ > 0) expect(stats.matchedPrevious).toBe(true)
      live = materialize(live, entries)
    }
    const lines = readFileSync(join(dir, 'sessions', SESSION, 'archive.jsonl'), 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(total)
  })

  it('rebuilds interleaved exchanges as valid paired turns, with no empty messages', async () => {
    const live = [...Array.from({ length: 6 }, (_, n) => interleaved(n, BIG_RESULT)).flat(), ...turn(99)]
    const { entries } = await run(live)
    const out = materialize(live, entries)
    expect(out[0].text.startsWith(HEADER_MARK)).toBe(true)
    assertPaired(entries.filter(e => 'built' in e).map(e => (e as { built: Message }).built))
    for (const e of entries) if ('built' in e) expect(chars([e.built])).toBeGreaterThan(0)
  })

  it('never evicts one call of a response while keeping its result', async () => {
    // prompt → call a → call b (same response, consecutive rows) → results a,b
    const live = [...turn(0), user('next'), call('a', 'A'.repeat(3_000)), call('b'), results('a', 'b'), answer('ok')]
    const { entries } = await run(live)
    const out = materialize(live, entries)
    const calls = new Set(out.flatMap(m => m.toolUses.map(u => u.tool_use_id)))
    const answered = new Set(out.flatMap(m => (m.toolResults ?? []).map(r => r.tool_use_id)))
    expect(calls).toEqual(answered)
  })

  it('keeps the newest exchange verbatim by handle, every row, in order', async () => {
    // The interleaved exchange carries three large results: give it room to fit.
    config = loadConfig({ dataDir: dir, budgetTokens: BUDGET_TOKENS * 3, ledgerRebuildEvery: 0 })
    const live = [...Array.from({ length: 8 }, (_, n) => turn(n)).flat(), ...interleaved(99).slice(0, 7)]
    const { entries } = await run(live)
    const kept = entries.filter((e): e is { keep: number } => 'keep' in e).map(e => e.keep)
    const exchangeStart = live.length - 6
    expect(kept.slice(-6)).toEqual([0, 1, 2, 3, 4, 5].map(k => exchangeStart + k))
  })

  it('masks large results in the middle layer', async () => {
    const live = Array.from({ length: 12 }, (_, n) => turn(n)).flat()
    const { entries } = await run(live)
    const built = entries.filter(e => 'built' in e).map(e => (e as { built: Message }).built)
    expect(built.some(m => (m.toolResults ?? []).some(r => r.text.startsWith(STUB_PREFIX)))).toBe(true)
  })

  it('enforces the budget when one middle message is huge', async () => {
    const live = [...turn(0), user('explain'), answer('H'.repeat(BUDGET_CHARS)), ...turn(1), ...turn(2)]
    const { entries } = await run(live)
    expect(chars(materialize(live, entries))).toBeLessThanOrEqual(BUDGET_CHARS)
  })

  it('refuses when the newest exchange alone exceeds the budget', async () => {
    const huge: Message = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'h', text: 'z'.repeat(BUDGET_CHARS * 2), isError: false }] }
    const live = [...turn(0), user('read the big file'), call('h'), huge]
    await expect(run(live)).rejects.toBeInstanceOf(OversizeError)
  })

  it('drops a rewound branch instead of resurrecting it', async () => {
    const first = Array.from({ length: 10 }, (_, n) => turn(n)).flat()
    const { entries } = await run(first)
    const out = materialize(first, entries)
    // The user rewinds to just after the header and takes a different path.
    const rewound = [out[0], user('different direction'), answer('new plan')]
    const { stats } = await run(rewound)
    expect(stats.matched).toBe(1)
    const state = JSON.parse(readFileSync(join(dir, 'sessions', SESSION, 'state.json'), 'utf-8'))
    const archived = readFileSync(join(dir, 'sessions', SESSION, 'archive.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    const branchTexts = state.branch.map((seq: number) => archived[seq].text)
    expect(branchTexts).toContain('different direction')
    expect(branchTexts.filter((t: string) => t.startsWith('prompt 9'))).toHaveLength(0)
  })

  it('still recognises its output when the engine rewrites one built message', async () => {
    let live = Array.from({ length: 12 }, (_, n) => turn(n)).flat()
    const { entries } = await run(live)
    live = materialize(live, entries)
    const builtAt = entries.findIndex((e, i) => i > 0 && 'built' in e)
    live[builtAt] = { ...live[builtAt], text: `${live[builtAt].text} (normalized)` }
    live.push(...turn(50))
    const { stats } = await run(live)
    expect(stats.matchedPrevious).toBe(true)
    expect(stats.newRaw).toBe(4)
  })

  it('treats a repeated short prompt as new history', async () => {
    const first = [...turn(0), user('go'), answer('a'), ...turn(1)]
    await run(first)
    // A foreign compaction replaced our output; "go" arrives again.
    const { stats } = await run([user('summary by someone else'), user('go'), answer('b')])
    expect(stats.newRaw).toBe(3)
  })

  it('retries a failed ledger span on the next compaction', async () => {
    let live = Array.from({ length: 12 }, (_, n) => turn(n)).flat()
    live = materialize(live, (await run(live)).entries)
    const broken: LedgerFn = async () => {
      throw new Error('no auth')
    }
    live.push(...Array.from({ length: 6 }, (_, n) => turn(20 + n)).flat())
    const failed = await run(live, broken)
    expect(failed.stats.ledgerError).toBe('no auth')
    live = materialize(live, failed.entries)
    live.push(...Array.from({ length: 6 }, (_, n) => turn(40 + n)).flat())
    await run(live)
    const [initial, retried] = ledgerSpans
    expect(retried[0]).toBe(initial.at(-1)! + 1)
  })
})

describe('second-review regressions', () => {
  const archiveLines = () => {
    try {
      return readFileSync(join(dir, 'sessions', SESSION, 'archive.jsonl'), 'utf-8').trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  it('N8: a rejected compaction archives nothing, so retries do not duplicate', async () => {
    const huge = resultsOf('z'.repeat(BUDGET_CHARS * 2), 'h')
    const live = [user('read it'), call('h'), huge]
    await expect(run(live)).rejects.toBeInstanceOf(OversizeError)
    await expect(run(live)).rejects.toBeInstanceOf(OversizeError)
    expect(archiveLines()).toHaveLength(0)
  })

  it('N6: an unanswered call is sized as emitted, not as rebuilt', async () => {
    const write: Message = { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'w', tool: 'Write', input: { content: 'c'.repeat(BUDGET_CHARS * 2) } }] }
    await expect(run([user('write it'), write])).rejects.toBeInstanceOf(OversizeError)
  })

  it('N5: a huge evicted path cannot push the header over budget', async () => {
    const longPath: Message = { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'p', tool: 'Read', input: { file_path: `/${'d/'.repeat(1_000)}f.ts` }, text: BIG_RESULT }] }
    const live = [user('read'), longPath, results('p'), ...Array.from({ length: 6 }, (_, n) => turn(n)).flat()]
    const { entries } = await run(live)
    expect(chars(materialize(live, entries))).toBeLessThanOrEqual(BUDGET_CHARS)
  })

  it('N7: squeezes the ledger instead of refusing output that fits', async () => {
    const latest = user('L'.repeat(Math.floor(BUDGET_CHARS * 0.6)))
    const live = [user('short'), answer('O'.repeat(2_200)), latest]
    const { entries } = await run(live)
    expect(chars(materialize(live, entries))).toBeLessThanOrEqual(BUDGET_CHARS)
  })

  it('N2: a replaced conversation drops the old ledger and rebuilds from the new branch', async () => {
    const abandoned: LedgerFn = async () => ({ ledger: 'ABANDONED: deploy the old branch', requests: 1 })
    const first = Array.from({ length: 10 }, (_, n) => turn(n)).flat()
    await run(first, abandoned)
    // Nothing of the last output comes back, so the rows the ledger covered are gone.
    // (Rewinding to just after the header keeps them: that ledger stays valid.)
    const rewound = [user('new direction'), ...Array.from({ length: 10 }, (_, n) => turn(100 + n)).flat()]
    // The rebuild fails too: the abandoned ledger must still not come back.
    const second = await run(rewound, async () => {
      throw new Error('ledger down')
    })
    expect(second.stats.ledgerError).toBe('ledger down')
    const header = materialize(rewound, second.entries)[0]
    expect(header.text).not.toContain('ABANDONED')
    const state = JSON.parse(readFileSync(join(dir, 'sessions', SESSION, 'state.json'), 'utf-8'))
    expect(state.ledger).not.toContain('ABANDONED')
  })

  it('N3: new rows after a rewind keep their handles even next to a rebuilt row', async () => {
    const first = [user('ask'), answer('old response'), user('P'.repeat(Math.floor(BUDGET_CHARS * 0.7)))]
    const out = materialize(first, (await run(first)).entries)
    const responseAt = out.findIndex(m => m.text.startsWith('old response'))
    const live = [...out.slice(0, responseAt + 1), call('img', '', SMALL_RESULT), resultsOf(SMALL_RESULT, 'img')]
    const { entries } = await run(live)
    const kept = entries.filter((e): e is { keep: number } => 'keep' in e).map(e => e.keep)
    expect(kept).toEqual(expect.arrayContaining([live.length - 2, live.length - 1]))
  })

  it('N4: the latest response stays verbatim from its thinking row on', async () => {
    config = loadConfig({ dataDir: dir, budgetTokens: BUDGET_TOKENS * 3, ledgerRebuildEvery: 0 })
    // thinking → call a → result a → call b → result b, one response split by its result
    const response = [thinkingOnly(), call('a', '', SMALL_RESULT), resultsOf(SMALL_RESULT, 'a'), call('b', '', SMALL_RESULT), resultsOf(SMALL_RESULT, 'b')]
    const live = [...Array.from({ length: 10 }, (_, n) => turn(n)).flat(), user('go'), ...response]
    const { entries } = await run(live)
    const kept = entries.filter((e): e is { keep: number } => 'keep' in e).map(e => e.keep)
    const from = live.length - response.length
    expect(kept).toEqual(expect.arrayContaining(response.map((_, k) => from + k)))
  })
})

describe('third-review regressions', () => {
  it('N1: a rewound, edited prompt is not absorbed by an identical regenerated reply', async () => {
    const first = [user('Keep the red design. Reply OK.'), { role: 'assistant' as const, text: 'OK', toolUses: [] }, user('P'.repeat(Math.floor(BUDGET_CHARS * 0.9)))]
    const out = materialize(first, (await run(first)).entries)
    expect(out.some(m => m.text.startsWith('Keep the red design'))).toBe(true)
    // Rewind to the first prompt, edit it, and get the same "OK" back.
    const { stats } = await run([user('Use the blue design. Reply OK.'), { role: 'assistant', text: 'OK', toolUses: [] }])
    expect(stats.matched).toBe(0)
    expect(stats.newRaw).toBe(2)
  })

  it('N3: rows the engine holds whole stay whole on later compactions too', async () => {
    const first = [user('ask'), answer('old response'), user('P'.repeat(Math.floor(BUDGET_CHARS * 0.7)))]
    const out = materialize(first, (await run(first)).entries)
    const responseAt = out.findIndex(m => m.text.startsWith('old response'))
    let live = [...out.slice(0, responseAt + 1), call('img', '', SMALL_RESULT), resultsOf(SMALL_RESULT, 'img')]
    live = materialize(live, (await run(live)).entries)
    const imageRows = [live.length - 2, live.length - 1]
    live.push(answer('done'))
    const { entries } = await run(live)
    const kept = entries.filter((e): e is { keep: number } => 'keep' in e).map(e => e.keep)
    expect(kept).toEqual(expect.arrayContaining(imageRows))
  })

  it('N4: declines when the latest response\'s thinking was already rebuilt', async () => {
    const response = [thinkingOnly(), call('t', '', 'r'.repeat(500)), resultsOf('r'.repeat(500), 't')]
    const first = [user('do it'), ...response, user('L'.repeat(Math.floor(BUDGET_CHARS * 0.9)))]
    const out = materialize(first, (await run(first)).entries)
    // Rewind away the later prompt: the rebuilt exchange becomes the latest response.
    const rewound = out.slice(0, out.findIndex(m => m.text.startsWith('LLLL')))
    await expect(run(rewound)).rejects.toBeInstanceOf(UnpreservableError)
  })
})

describe('background ledger', () => {
  const sessionPath = (file: string) => join(dir, 'sessions', SESSION, file)
  const prep = (messages: Message[], ledger: LedgerFn = fakeLedger) => prepare({ sessionKey: SESSION, messages, showCommand: SHOW }, config, ledger)
  const runReady = (messages: Message[]) =>
    compact({ sessionKey: SESSION, messages, showCommand: SHOW, ledgerMode: 'ready' }, config, async () => {
      throw new Error('ready mode must not call the ledger model')
    })

  beforeEach(() => {
    config = loadConfig({ dataDir: dir, budgetTokens: BUDGET_TOKENS, ledgerRebuildEvery: 0, prepareMinChars: 1 })
  })

  it('ready mode never waits on the model and says when the ledger lags', async () => {
    const live = Array.from({ length: 12 }, (_, n) => turn(n)).flat()
    const { entries, stats } = await runReady(live)
    expect(stats.ledgerThrough).toBe(0)
    expect(stats.cut).toBeGreaterThan(0)
    expect(materialize(live, entries)[0].text).not.toContain('## Session ledger')
  })

  it('prepare writes only the ready ledger; a ready compaction adopts it', async () => {
    const live = Array.from({ length: 12 }, (_, n) => turn(n)).flat()
    const prepared = await prep(live)
    expect(prepared.prepared).toBe(true)
    expect(() => readFileSync(sessionPath('archive.jsonl'))).toThrow()
    expect(() => readFileSync(sessionPath('state.json'))).toThrow()
    const ready = readReady(join(dir, 'sessions', SESSION))!
    live.push(...turn(50))
    const { entries, stats } = await runReady(live)
    expect(stats.ledgerThrough).toBe(ready.through)
    const header = materialize(live, entries)[0].text
    expect(header).toContain(ready.ledger.split('\n')[0])
    if (stats.ledgerThrough < stats.cut) expect(header).toContain('covers archived history only up to seq')
  })

  it('ignores a ready ledger whose history was replaced', async () => {
    await prep(Array.from({ length: 12 }, (_, n) => turn(n)).flat())
    const other = Array.from({ length: 12 }, (_, n) => turn(200 + n)).flat()
    const { stats } = await runReady(other)
    expect(stats.ledgerThrough).toBe(0)
  })

  it('rejects a ready ledger planned on a snapshot that a compaction has since numbered differently', async () => {
    // Codex's race: the worker snapshots, a compaction commits that same
    // history first, then the worker plans on its stale snapshot.
    const snapshot = Array.from({ length: 12 }, (_, n) => turn(n)).flat()
    // The committed ledger covers nothing, so the stale one would look like progress.
    const out = materialize(snapshot, (await run(snapshot, async () => { throw new Error('down') })).entries)
    const stale = await prep(snapshot)
    expect(stale.prepared).toBe(true)
    // The stale plan numbered the snapshot as new rows after the 48 now archived.
    const staleLedger = readReady(join(dir, 'sessions', SESSION))!.ledger
    expect(staleLedger).toMatch(/#(4[89]|[5-9]\d)/)
    const before = JSON.parse(readFileSync(sessionPath('state.json'), 'utf-8')).ledger
    const { entries } = await runReady([...out, ...turn(60)])
    const after = JSON.parse(readFileSync(sessionPath('state.json'), 'utf-8')).ledger
    expect(after).toBe(before)
    expect(materialize([...out, ...turn(60)], entries)[0].text).not.toContain(staleLedger)
  })

  it('skips when too little new history awaits the ledger', async () => {
    config = loadConfig({ dataDir: dir, budgetTokens: BUDGET_TOKENS, ledgerRebuildEvery: 0, prepareMinChars: 10_000_000 })
    const live = Array.from({ length: 12 }, (_, n) => turn(n)).flat()
    await prep(live)
    const second = await prep(live)
    expect(second).toEqual({ prepared: false, reason: expect.stringContaining('await the ledger') })
  })

  it('runs one prepare job per session', async () => {
    const release = tryLock(join(dir, 'sessions', SESSION))!
    try {
      const result = await prep(Array.from({ length: 12 }, (_, n) => turn(n)).flat())
      expect(result).toEqual({ prepared: false, reason: 'another prepare job is running' })
    } finally {
      release()
    }
  })

  it('updates incrementally instead of rebuilding a history past the rebuild cap', async () => {
    config = loadConfig({ dataDir: dir, budgetTokens: BUDGET_TOKENS, ledgerRebuildEvery: 1, ledgerRebuildMaxRequests: 0 })
    let live = Array.from({ length: 12 }, (_, n) => turn(n)).flat()
    live = materialize(live, (await run(live)).entries)
    live.push(...Array.from({ length: 8 }, (_, n) => turn(30 + n)).flat())
    const previous: string[] = []
    await run(live, async (prev, span) => {
      previous.push(prev)
      return { ledger: `${prev}+`, requests: 1 }
    })
    expect(previous[0]).not.toBe('')
  })
})

describe('config', () => {
  it('accepts 0 for STRATA_LEDGER_REBUILD_EVERY', () => {
    process.env.STRATA_LEDGER_REBUILD_EVERY = '0'
    try {
      expect(loadConfig().ledgerRebuildEvery).toBe(0)
    } finally {
      delete process.env.STRATA_LEDGER_REBUILD_EVERY
    }
  })
})

describe('renderIndex', () => {
  it('coarsens episodes until the index fits', () => {
    const archived = Array.from({ length: 60 }, (_, n) => turn(n)).flat().map((m, seq) => ({ ...m, seq }))
    const episodes = segmentEpisodes(archived)
    const full = episodes.map(renderEpisode).join('\n')
    const index = renderIndex(episodes, full.length / 4)
    expect(index.length).toBeLessThanOrEqual(full.length / 4)
    expect(index).toContain('[seq 0-')
    expect(index).toContain(`-${archived.length - 1}]`)
  })

  it('protects newest evicted episodes and rows past ledgerThrough before older episodes', () => {
    const archived = Array.from({ length: 40 }, (_, n) => turn(n)).flat().map((m, seq) => ({ ...m, seq }))
    const episodes = segmentEpisodes(archived)
    const full = episodes.map(renderEpisode).join('\n')
    const protectAfterSeq = episodes[34].first
    const index = renderIndex(episodes, Math.floor(full.length * 0.45), { protectAfterSeq })
    // Every episode from 34 onward (the lagging gap) must remain unmerged at single-episode resolution.
    for (let k = 34; k < 40; k++) {
      expect(index).toContain(`[seq ${episodes[k].first}-${episodes[k].last}]`)
    }
    // Older episodes absorbed the coarsening instead.
    expect(index).toContain('prompts, e.g.')
  })

  it('captures compact Bash command and error hints in episode summaries', () => {
    const msgs: Message[] = [
      user('run the test suite'),
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b1', tool: 'Bash', input: { command: 'pnpm test --filter auth\necho done' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'b1', text: 'running tests...\nFAIL src/auth.test.ts\nTypeError: token is undefined\nExit code 1', isError: true }] },
      answer('investigating failure')
    ]
    const episodes = segmentEpisodes(msgs.map((m, seq) => ({ ...m, seq })))
    const rendered = renderEpisode(episodes[0])
    expect(rendered).toContain('cmds: `pnpm test --filter auth`')
    // Must prefer the real error line over a trailing generic "Exit code 1".
    expect(rendered).toContain('errors: 1 (TypeError: token is undefined)')
    expect(renderIndex(episodes, 0)).toBe('')
  })
})

describe('v0.3 improvements and edge cases', () => {
  it('lets unused header and tail slack flow to verbatim tail and masked middle', async () => {
    // Realistic budget (50k tokens = 175k chars) with short original prompt and compact turns:
    // old hard caps left ~15-25% unused; slack flow should achieve >85% utilization.
    config = loadConfig({ dataDir: dir, budgetTokens: 20_000, ledgerRebuildEvery: 0 })
    const budget = 20_000 * 3.5
    const live = Array.from({ length: 60 }, (_, n) => turn(n)).flat()
    const { stats } = await compact({ sessionKey: SESSION, messages: live, showCommand: SHOW, ledgerMode: 'ready' }, config, fakeLedger)
    expect(stats.outputChars).toBeLessThanOrEqual(budget)
    expect(stats.outputChars).toBeGreaterThan(budget * 0.85)
  })

  it('maskMessage keeps head+tail excerpts, caps huge assistant replies, and omits mirrored toolUses text', () => {
    const hugeNormal = `HEAD_MARKER_${'a'.repeat(5_000)}_TAIL_MARKER`
    const hugeError = `ERR_TOP_${'e'.repeat(5_000)}_ERR_BOTTOM_CODE_42`
    const userRes: Message = {
      role: 'user',
      text: 'ok',
      toolUses: [],
      toolResults: [
        { tool_use_id: 'u1', text: hugeNormal, isError: false },
        { tool_use_id: 'u2', text: hugeError, isError: true }
      ]
    }
    const maskedRes = maskMessage(userRes, 42, config)
    expect(maskedRes.toolResults?.[0].text.startsWith(STUB_PREFIX)).toBe(true)
    expect(maskedRes.toolResults?.[0].text).toContain('archive seq 42')
    expect(maskedRes.toolResults?.[0].text).toContain('HEAD_MARKER_')
    expect(maskedRes.toolResults?.[0].text).toContain('_TAIL_MARKER')
    expect(maskedRes.toolResults?.[1].text.startsWith(STUB_PREFIX)).toBe(true)
    expect(maskedRes.toolResults?.[1].text).toContain('ERR_TOP_')
    expect(maskedRes.toolResults?.[1].text).toContain('_ERR_BOTTOM_CODE_42')

    const hugeAssistant: Message = {
      role: 'assistant',
      text: `START_PROSE_${'p'.repeat(10_000)}_END_CONCLUSION`,
      toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: { file_path: '/a.ts' }, text: hugeNormal, isError: true }]
    }
    const maskedAsst = maskMessage(hugeAssistant, 41, config)
    expect(maskedAsst.text.length).toBeLessThan(5_000)
    expect(maskedAsst.text).toContain('START_PROSE_')
    expect(maskedAsst.text).toContain('_END_CONCLUSION')
    expect(maskedAsst.text).toContain('archive seq 41')
    // Mirrored text/isError must be omitted on built ToolUse so assistant seq is never stamped onto result text.
    expect(maskedAsst.toolUses[0].text).toBeUndefined()
    expect(maskedAsst.toolUses[0].isError).toBeUndefined()
  })

  it('honours /compact <instructions> even when the ledger already covers cutRow', async () => {
    const live = Array.from({ length: 12 }, (_, n) => turn(n)).flat()
    // First compact catches ledger up to cutRow.
    const first = await run(live)
    const out = materialize(live, first.entries)
    let seenFocus: string | undefined
    let called = 0
    const refocusLedger: LedgerFn = async (prev, _span, _cfg, focus) => {
      called++
      seenFocus = focus
      return { ledger: `${prev}\n- refocused: ${focus}`.trim(), requests: 1 }
    }
    // Second compact on the exact same output (cutRow <= ledgerThrough) with instructions!
    const second = await compact(
      { sessionKey: SESSION, messages: out, instructions: 'preserve auth migration details', showCommand: SHOW },
      config,
      refocusLedger
    )
    expect(called).toBe(1)
    expect(seenFocus).toBe('preserve auth migration details')
    expect(materialize(out, second.entries)[0].text).toContain('refocused: preserve auth migration details')
  })

  it('tolerates normalization across multiple built messages when the verbatim kept tail matches', async () => {
    config = loadConfig({ dataDir: dir, budgetTokens: BUDGET_TOKENS * 2, ledgerRebuildEvery: 0 })
    let live = Array.from({ length: 18 }, (_, n) => turn(n)).flat()
    const first = await run(live)
    live = materialize(live, first.entries)
    const builtIndices = first.entries.map((e, i) => ('built' in e ? i : -1)).filter(i => i > 0)
    expect(builtIndices.length).toBeGreaterThanOrEqual(3)
    // Normalize 3 separate built messages while keeping the verbatim tail untouched.
    for (const idx of builtIndices.slice(0, 3)) {
      live[idx] = { ...live[idx], text: `${live[idx].text} [normalized]` }
    }
    live.push(...turn(99))
    const second = await run(live)
    expect(second.stats.matchedPrevious).toBe(true)
    expect(second.stats.newRaw).toBe(4)
  })

  it('prepare accounts for hidden weights (api) and supports explicit through catch-up', async () => {
    config = loadConfig({ dataDir: dir, budgetTokens: BUDGET_TOKENS, ledgerRebuildEvery: 0, prepareMinChars: 1 })
    const sig = 's'.repeat(8_000)
    const rows = Array.from({ length: 24 }, (_, n) => [user(`p${n}`), thinkingOnly(), call(`c${n}`, '', 'ok'), resultsOf('ok', `c${n}`), answer(`a${n}`)]).flat()
    const api: ApiMessage[] = Array.from({ length: 24 }, (_, n) => [
      { role: 'user' as const, content: [{ type: 'text', text: `p${n}` }] },
      { role: 'assistant' as const, content: [{ type: 'thinking', thinking: '', signature: sig }, { type: 'tool_use', id: `c${n}`, name: 'Read', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: `c${n}`, content: 'ok' }] },
      { role: 'assistant' as const, content: [{ type: 'text', text: `a${n} ${ANSWER_DETAIL}` }] }
    ]).flat()
    // Without api, rows are tiny (~5k chars) -> nothing evicted!
    const textOnly = await prepare({ sessionKey: SESSION, messages: rows, showCommand: SHOW }, config, fakeLedger)
    expect(textOnly.prepared).toBe(false)
    // With api, thinking weighs ~32k tokens -> prepare evicts and folds into ready ledger!
    const weighted = await prepare({ sessionKey: SESSION, messages: rows, api, showCommand: SHOW }, config, fakeLedger)
    expect(weighted.prepared).toBe(true)

    // Explicit through catch-up after a ready compaction that left the ledger lagging:
    rmSync(dir, { recursive: true, force: true })
    const bigLive = Array.from({ length: 12 }, (_, n) => turn(n)).flat()
    const compacted = await compact({ sessionKey: SESSION, messages: bigLive, showCommand: SHOW, ledgerMode: 'ready' }, config, fakeLedger)
    expect(compacted.stats.ledgerThrough).toBe(0)
    expect(compacted.stats.cut).toBeGreaterThan(0)
    // High prepareMinChars must NOT block explicit post-compaction catch-up via `through`.
    const strictCfg = loadConfig({ dataDir: dir, budgetTokens: BUDGET_TOKENS, ledgerRebuildEvery: 0, prepareMinChars: 10_000_000 })
    const caught = await prepare({ sessionKey: SESSION, through: compacted.stats.cut }, strictCfg, fakeLedger)
    expect(caught).toEqual({ prepared: true, through: compacted.stats.cut, requests: 1 })
    expect(readReady(join(dir, 'sessions', SESSION))?.through).toBe(compacted.stats.cut)
  })

  it('planLedger and preparedLedger round-trip cleanly and reject mismatched prefixHash', async () => {
    const live = Array.from({ length: 12 }, (_, n) => turn(n)).flat()
    const plan = planLedger({ sessionKey: SESSION, messages: live, showCommand: SHOW }, config, { enforceMinChars: false })
    expect(plan.needed).toBe(true)
    if (!plan.needed) return
    const result = await compact(
      {
        sessionKey: SESSION,
        messages: live,
        showCommand: SHOW,
        ledgerMode: 'ready',
        preparedLedger: { ledger: '## Current state\n- computed via model.complete (#0)', through: plan.through, prefixHash: plan.prefixHash, age: plan.age, requests: plan.chunks.length }
      },
      config,
      async () => {
        throw new Error('must not call ledgerFn when preparedLedger is accepted')
      }
    )
    expect(result.stats.ledgerThrough).toBe(plan.through)
    expect(materialize(live, result.entries)[0].text).toContain('computed via model.complete')
  })

  it('tolerates truncated trailing lines in archive.jsonl and corrupt state.json', async () => {
    const live = Array.from({ length: 12 }, (_, n) => turn(n)).flat()
    const first = await run(live)
    const sdir = join(dir, 'sessions', SESSION)
    // Append a truncated trailing line simulating a crash mid-write.
    appendFileSync(join(sdir, 'archive.jsonl'), '{"seq":999,"role":"user","text":"trun')
    expect(readArchive(sdir)).toHaveLength(live.length)
    // Next compaction self-heals archive.jsonl and keeps numbering contiguous.
    const nextLive = [...materialize(live, first.entries), ...turn(50)]
    const second = await run(nextLive)
    expect(second.stats.archived).toBe(live.length + 4)
    expect(readArchive(sdir)).toHaveLength(live.length + 4)

    // Corrupt state.json falls back to INITIAL_STATE instead of throwing.
    writeFileSync(join(sdir, 'state.json'), '{not valid json')
    expect(readState(sdir).compactions).toBe(0)
    const recovered = await run(turn(60))
    expect(recovered.stats.branch).toBe(4)
  })

  it('reclaims stale locks safely and never lets a timed-out holder delete a newer lock', () => {
    const sdir = join(dir, 'sessions', SESSION)
    const firstRelease = tryLock(sdir, 'test.lock', 100)!
    expect(firstRelease).toBeDefined()
    expect(tryLock(sdir, 'test.lock', 100)).toBeUndefined()
    // Backdate lock file to make it stale.
    const old = new Date(Date.now() - 10_000)
    utimesSync(join(sdir, 'test.lock'), old, old)
    const secondRelease = tryLock(sdir, 'test.lock', 100)!
    expect(secondRelease).toBeDefined()
    // First holder releasing late must NOT unlink second holder's lock!
    firstRelease()
    expect(tryLock(sdir, 'test.lock', 100)).toBeUndefined()
    secondRelease()
    expect(tryLock(sdir, 'test.lock', 100)).toBeDefined()
  })

  it('sanitizes image mediaType extensions against path traversal and parameters', () => {
    expect(mediaExtension('image/png')).toBe('png')
    expect(mediaExtension('image/jpeg; charset=utf-8')).toBe('jpg')
    expect(mediaExtension('image/svg+xml')).toBe('svgxml')
    expect(mediaExtension('image/../../etc/passwd')).toBe('png')
    expect(mediaExtension('')).toBe('png')
  })

  it('throws OversizeError (never TypeError) when a single unit exceeds the budget', async () => {
    const singleOversize = [user('x'.repeat(BUDGET_CHARS + 5_000))]
    await expect(run(singleOversize)).rejects.toBeInstanceOf(OversizeError)
  })

  it('reclaims unused middle slack into verbatim tail when cut === 0 and sizes preparedLedger without wasting the 6% cap', async () => {
    const cfg200k = loadConfig({ dataDir: dir, budgetTokens: 200_000, ledgerRebuildEvery: 0 })
    const budget = 200_000 * 3.5
    const turns120 = Array.from({ length: 120 }, (_, n) => turn(n)).flat()
    const noEvict = await compact({ sessionKey: 'slack-cut0', messages: turns120, showCommand: 'strata show slack-cut0', ledgerMode: 'ready' }, cfg200k)
    expect(noEvict.stats.cut).toBe(0)
    expect(noEvict.stats.outputChars).toBeLessThanOrEqual(budget)
    expect(noEvict.stats.outputChars).toBeGreaterThan(budget * 0.9)

    // With 400 turns and a short preparedLedger, layout uses its actual length instead of wasting 42k chars.
    const turns400 = Array.from({ length: 400 }, (_, n) => turn(n)).flat()
    const plan = planLedger({ sessionKey: 'slack-prep', messages: turns400, showCommand: 'strata show slack-prep' }, cfg200k, { enforceMinChars: false })
    expect(plan.needed).toBe(true)
    if (!plan.needed) return
    const withPrepared = await compact(
      {
        sessionKey: 'slack-prep',
        messages: turns400,
        showCommand: 'strata show slack-prep',
        ledgerMode: 'ready',
        preparedLedger: { ledger: '## Current state\n- compact (#0)', through: plan.through, prefixHash: plan.prefixHash, age: plan.age, requests: 1 }
      },
      cfg200k
    )
    expect(withPrepared.stats.outputChars).toBeLessThanOrEqual(budget)
    expect(withPrepared.stats.outputChars).toBeGreaterThan(budget * 0.98)
  })

  it('rejects a foreign wrong-role or non-strata-header prefix even when a generic tail matches', async () => {
    const live = Array.from({ length: 12 }, (_, n) => turn(n)).flat()
    const first = await run(live)
    const out = materialize(live, first.entries)
    const firstKeep = first.entries.findIndex(e => 'keep' in e)
    expect(firstKeep).toBeGreaterThan(0)
    // Replace all built messages before the kept tail with wrong-role foreign messages.
    const forged = out.map((m, i) => (i < firstKeep ? { role: m.role === 'user' ? ('assistant' as const) : ('user' as const), text: `foreign ${i}`, toolUses: [] } : m))
    const second = await run(forged)
    expect(second.stats.matched).toBe(0)
    expect(second.stats.matchedPrevious).toBe(false)
  })

  it('self-heals multiple corrupt trailing lines in archive.jsonl and avoids splitting emoji surrogates in maskMessage', async () => {
    const live = Array.from({ length: 12 }, (_, n) => turn(n)).flat()
    const first = await run(live)
    const sdir = join(dir, 'sessions', SESSION)
    appendFileSync(join(sdir, 'archive.jsonl'), '{"seq":998,"broken\n{"seq":999,"also-broken')
    const second = await run([...materialize(live, first.entries), ...turn(80)])
    expect(second.stats.archived).toBe(live.length + 4)
    expect(readArchive(sdir)).toHaveLength(live.length + 4)

    const emojiResult: Message = {
      role: 'user',
      text: '🔥'.repeat(3_000),
      toolUses: [],
      toolResults: [{ tool_use_id: 'e1', text: '🚀'.repeat(1_000), isError: false }]
    }
    const masked = maskMessage(emojiResult, 5, config)
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    expect(masked.text).not.toMatch(loneSurrogate)
    expect(masked.toolResults?.[0].text).not.toMatch(loneSurrogate)
  })

  it('scales masked middle consistently with calibrated text density on dense non-thinking sessions', async () => {
    const denseTurns = Array.from({ length: 16 }, (_, n) => turn(n)).flat()
    // 2.0 chars/token (1.75x denser than 3.5) -> real budget in raw chars must shrink accordingly.
    const denseUsage = { tokens: Math.round(chars(denseTurns.slice(0, -1)) / 2.0) + 1_000, overhead: 1_000 }
    const defaultRun = await run(denseTurns)
    rmSync(dir, { recursive: true, force: true })
    const denseRun = await compact({ sessionKey: SESSION, messages: denseTurns, showCommand: SHOW, usage: denseUsage }, config, fakeLedger)
    expect(denseRun.stats.charsPerToken).toBeLessThan(2.5)
    expect(denseRun.stats.outputChars).toBeLessThanOrEqual(BUDGET_CHARS)
    const rawOutChars = chars(materialize(denseTurns, denseRun.entries))
    expect(rawOutChars).toBeLessThan(chars(materialize(denseTurns, defaultRun.entries)))
  })
})
