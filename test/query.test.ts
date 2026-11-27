import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compact } from '../src/compact.js'
import { loadConfig, type Config } from '../src/config.js'
import { formatSessionStatus, searchArchive, sessionStatus, showArchive } from '../src/query.js'
import { writeReady, prefixHash, readReady } from '../src/ready.js'
import { appendArchive, readArchive, sessionDir } from '../src/archive.js'
import type { Message } from '../src/types.js'

const SESSION = 'query-sess'
const SHOW = 'strata show query-sess'

const user = (text: string): Message => ({ role: 'user', text, toolUses: [] })
const assistant = (text: string): Message => ({ role: 'assistant', text, toolUses: [] })
const call = (id: string, command: string): Message => ({
  role: 'assistant',
  text: '',
  toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command } }]
})
const res = (id: string, text: string, isError = false): Message => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text, isError }]
})

describe('archive query, search, and status', () => {
  let dir: string
  let config: Config
  const noLedger = async (prev: string) => ({ ledger: prev || '## Current state\n- active (#0)', requests: 1 })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strata-query-'))
    config = loadConfig({ dataDir: dir, budgetTokens: 2_000, ledgerRebuildEvery: 0 })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('paginates archived messages with offset and limit', async () => {
    const msgs = [
      user('start'),
      call('b1', 'cat huge.log'),
      res('b1', `START_LOG_${'L'.repeat(5_000)}_END_LOG`),
      assistant('finished reading log')
    ]
    await compact({ sessionKey: SESSION, messages: msgs, showCommand: SHOW }, config, noLedger)
    const sdir = join(dir, 'sessions', SESSION)

    const page1 = showArchive(sdir, { from: 2, offset: 0, limit: 500 })
    expect(page1.found).toBe(true)
    expect(page1.hasMore).toBe(true)
    expect(page1.nextOffset).toBe(500)
    expect(page1.text).toContain('START_LOG_')
    expect(page1.text).toContain('pass offset=500 to continue')

    const pageEnd = showArchive(sdir, { from: 2, offset: page1.totalChars - 50, limit: 500 })
    expect(pageEnd.hasMore).toBe(false)
    expect(pageEnd.text).toContain('_END_LOG')

    const pastEnd = showArchive(sdir, { from: 2, offset: 99_999, limit: 500 })
    expect(pastEnd.found).toBe(true)
    expect(pastEnd.returnedChars).toBe(0)
    expect(pastEnd.text).toContain('past end of output')

    const missing = showArchive(sdir, { from: 999 })
    expect(missing.found).toBe(false)
  })

  it('searches active branch by default, supports filters and regex, and excludes rewound branches', async () => {
    const first = [
      user('deploy staging'),
      call('c1', 'deploy --flag-alpha'),
      res('c1', 'Error: ECONNREFUSED on port 9090', true),
      assistant('staging failed on port 9090'),
      user('P'.repeat(4_000))
    ]
    const r1 = await compact({ sessionKey: SESSION, messages: first, showCommand: SHOW }, config, noLedger)
    const out1 = r1.entries.map(e => ('keep' in e ? first[e.keep] : e.built))

    // Rewind right after seq 0/header and take a different branch without "ECONNREFUSED"
    const rewound = [out1[0], user('switch to local dev'), assistant('local dev works on port 3000')]
    await compact({ sessionKey: SESSION, messages: rewound, showCommand: SHOW }, config, noLedger)
    const sdir = join(dir, 'sessions', SESSION)

    // Active branch only: does not find the abandoned branch's error unless all-branches is set,
    // and notes how many off-branch archived messages were skipped.
    const activeOnly = searchArchive(sdir, { query: 'ECONNREFUSED' })
    expect(activeOnly.branchScoped).toBe(true)
    expect(activeOnly.offBranchCount).toBeGreaterThan(0)
    expect(activeOnly.totalMatches).toBe(0)
    expect(activeOnly.formatted).toContain('outside active branch skipped (include with all_branches=true or --all-branches)')

    const allBranches = searchArchive(sdir, { query: 'ECONNREFUSED', branchOnly: false, errorsOnly: true })
    expect(allBranches.branchScoped).toBe(false)
    expect(allBranches.offBranchCount).toBe(0)
    expect(allBranches.totalMatches).toBe(1)
    expect(allBranches.matches[0].hasError).toBe(true)
    expect(allBranches.formatted).not.toContain('outside active branch skipped')

    const regexHit = searchArchive(sdir, { query: 'port \\d{4}', regex: true, role: 'assistant' })
    expect(regexHit.totalMatches).toBe(1)
    expect(regexHit.matches[0].snippet).toContain('port 3000')

    expect(() => searchArchive(sdir, { query: '[unclosed', regex: true })).toThrow(/invalid regex/)
  })

  it('reports accurate sessionStatus including ledger lag and ready-ledger compatibility', async () => {
    const msgs = Array.from({ length: 12 }, (_, n) => [
      user(`prompt ${n}`),
      call(`c${n}`, `echo ${n}`),
      res(`c${n}`, 'x'.repeat(2_000)),
      assistant(`done ${n}`)
    ]).flat()
    const compacted = await compact({ sessionKey: SESSION, messages: msgs, showCommand: SHOW, ledgerMode: 'ready' }, config, noLedger)
    const sdir = join(dir, 'sessions', SESSION)
    const status1 = sessionStatus(sdir, SESSION)
    expect(status1.archiveCount).toBe(msgs.length)
    expect(status1.branchLength).toBe(msgs.length)
    expect(status1.compactions).toBe(1)
    expect(status1.lastCut).toBe(compacted.stats.cut)
    expect(status1.ledgerLag).toBe(compacted.stats.cut)
    expect(status1.readyLedger).toBeUndefined()

    const archived = readArchive(sdir)
    writeReady(sdir, {
      ledger: '## Current state\n- ready (#0)',
      through: compacted.stats.cut,
      prefixHash: prefixHash(archived, compacted.stats.cut),
      age: 0,
      preparedAt: '2026-10-12T12:00:00.000Z'
    })
    const status2 = sessionStatus(sdir, SESSION)
    expect(status2.readyLedger?.compatible).toBe(true)
    expect(formatSessionStatus(status2)).toContain('ready ledger:')
    expect(formatSessionStatus(status2)).toContain('compatible')
  })

  it('CLI handles show pagination, search with leading-dash queries, status --json, and ledger-plan/save', async () => {
    const msgs = Array.from({ length: 10 }, (_, n) => [
      user(`task ${n} with --weird-flag`),
      call(`k${n}`, `run --weird-flag ${n}`),
      res(`k${n}`, 'R'.repeat(3_000)),
      assistant(`completed ${n}`)
    ]).flat()
    const cliPath = resolve('dist/cli.js')
    const env = { ...process.env, STRATA_DATA_DIR: dir }

    // 1. ledger-plan over stdin
    const planOut = execFileSync('node', [cliPath, 'ledger-plan', '--session', SESSION, '--in', '-', '--budget', '2000', '--sync'], {
      input: JSON.stringify({ messages: msgs }),
      env,
      encoding: 'utf-8'
    })
    const plan = JSON.parse(planOut)
    expect(plan.needed).toBe(true)

    // 2. ledger-save over stdin
    const saveOut = execFileSync('node', [cliPath, 'ledger-save', '--session', SESSION, '--in', '-'], {
      input: JSON.stringify({ ledger: '## Current state\n- saved via CLI (#0)', through: plan.through, prefixHash: plan.prefixHash, age: plan.age }),
      env,
      encoding: 'utf-8'
    })
    expect(JSON.parse(saveOut).saved).toBe(true)

    // 3. compact adopting ready ledger + --native-tools
    const compactOut = execFileSync('node', [cliPath, 'compact', '--session', SESSION, '--in', '-', '--out', '-', '--budget', '2000', '--ledger', 'ready', '--native-tools'], {
      input: JSON.stringify({ messages: msgs }),
      env,
      encoding: 'utf-8'
    })
    const compacted = JSON.parse(compactOut)
    expect(compacted.stats.ledgerThrough).toBe(plan.through)
    expect(compacted.entries[0].built.text).toContain('mcp__strata__show')
    expect(compacted.entries[0].built.text).toContain('mcp__strata__search')

    // 4. show with --offset and --limit
    const showOut = execFileSync('node', [cliPath, 'show', '--offset', '0', '--limit', '120', '--', SESSION, '2'], { env, encoding: 'utf-8' })
    expect(showOut).toContain('pass offset=120 to continue')

    // 5. search for a query starting with "--"
    const searchOut = execFileSync('node', [cliPath, 'search', '--', SESSION, '--weird-flag'], { env, encoding: 'utf-8' })
    expect(searchOut).toContain('strata search "--weird-flag"')
    expect(searchOut).toContain('#0')

    // 6. status --json
    const statusOut = execFileSync('node', [cliPath, 'status', '--json', '--', SESSION], { env, encoding: 'utf-8' })
    const st = JSON.parse(statusOut)
    expect(st.compactions).toBe(1)
    expect(st.ledgerLag).toBe(0)

    // 7. ledger-save rejects a stale shallower `through` on the same committed branch
    const arch = readArchive(join(dir, 'sessions', SESSION))
    const deeper = execFileSync('node', [cliPath, 'ledger-save', '--session', SESSION, '--in', '-'], {
      input: JSON.stringify({ ledger: '## Current state\n- deep', through: 20, prefixHash: prefixHash(arch, 20), age: 1 }),
      env,
      encoding: 'utf-8'
    })
    expect(JSON.parse(deeper).saved).toBe(true)
    const shallower = execFileSync('node', [cliPath, 'ledger-save', '--session', SESSION, '--in', '-'], {
      input: JSON.stringify({ ledger: '## Current state\n- stale', through: 10, prefixHash: prefixHash(arch, 10), age: 0 }),
      env,
      encoding: 'utf-8'
    })
    expect(JSON.parse(shallower).saved).toBe(false)
    expect(readReady(join(dir, 'sessions', SESSION))?.through).toBe(20)

    // 8. leading-dash instructions via `--instructions=...` parse cleanly
    const dashPlan = execFileSync('node', [cliPath, 'ledger-plan', `--session=${SESSION}`, '--in', '-', '--budget', '2000', '--sync', '--instructions=- keep auth notes'], {
      input: JSON.stringify({ messages: msgs }),
      env,
      encoding: 'utf-8'
    })
    expect(JSON.parse(dashPlan).focus).toBe('- keep auth notes')

    // 9. leading-dash session keys work end-to-end across all CLI subcommands and cap maxTokens at 64k for 1M budgets
    const dashSession = '-leading-dash-sess'
    const dashPlanOut = execFileSync('node', [cliPath, 'ledger-plan', `--session=${dashSession}`, '--in', '-', '--budget', '2000', '--sync'], {
      input: JSON.stringify({ messages: msgs }),
      env,
      encoding: 'utf-8'
    })
    const dashParsed = JSON.parse(dashPlanOut)
    expect(dashParsed.needed).toBe(true)

    const dashSaveOut = execFileSync('node', [cliPath, 'ledger-save', `--session=${dashSession}`, '--in', '-'], {
      input: JSON.stringify({ ledger: '## Current state\n- dash saved (#0)', through: dashParsed.through, prefixHash: dashParsed.prefixHash, age: dashParsed.age }),
      env,
      encoding: 'utf-8'
    })
    expect(JSON.parse(dashSaveOut).saved).toBe(true)

    const dashCompactOut = execFileSync('node', [cliPath, 'compact', `--session=${dashSession}`, '--in', '-', '--out', '-', '--budget', '2000', '--ledger', 'ready', '--native-tools'], {
      input: JSON.stringify({ messages: msgs }),
      env,
      encoding: 'utf-8'
    })
    const dashCompacted = JSON.parse(dashCompactOut)
    expect(dashCompacted.stats.ledgerThrough).toBe(dashParsed.through)
    expect(dashCompacted.entries[0].built.text).toContain(`show -- ${dashSession}`)

    const dashShowOut = execFileSync('node', [cliPath, 'show', '--', dashSession, '0'], { env, encoding: 'utf-8' })
    expect(dashShowOut).toContain('task 0')
    const dashSearchOut = execFileSync('node', [cliPath, 'search', '--', dashSession, '--weird-flag'], { env, encoding: 'utf-8' })
    expect(dashSearchOut).toContain('#0')
    const dashStatusOut = execFileSync('node', [cliPath, 'status', '--json', '--', dashSession], { env, encoding: 'utf-8' })
    expect(JSON.parse(dashStatusOut).sessionKey).toBe(dashSession)

    // 10. ledger-plan caps maxTokens at 64,000 even when --budget is 1,000,000
    const hugeBudgetPlan = execFileSync('node', [cliPath, 'ledger-plan', `--session=${dashSession}`, '--through', '10', '--budget', '1000000', '--sync', '--instructions=refocus'], {
      env,
      encoding: 'utf-8'
    })
    const hugeParsed = JSON.parse(hugeBudgetPlan)
    expect(hugeParsed.needed).toBe(true)
    expect(hugeParsed.maxTokens).toBe(64_000)
  })

  it('shows media-only/empty rows cleanly, never splits emoji surrogate pairs on pagination, and marks pre-compaction ready ledgers pending', () => {
    const sdir = join(dir, 'sessions', 'media-sess')
    appendArchive(sdir, [
      { seq: 0, role: 'user', text: '', toolUses: [], media: [{ path: '/tmp/0-0.png' }] },
      { seq: 1, role: 'assistant', text: '', toolUses: [] },
      { seq: 2, role: 'user', text: '🚀'.repeat(40), toolUses: [] }
    ])
    const mediaRow = showArchive(sdir, { from: 0 })
    expect(mediaRow.found).toBe(true)
    expect(mediaRow.text).toContain('#0 media: /tmp/0-0.png')

    const emptyRow = showArchive(sdir, { from: 1 })
    expect(emptyRow.found).toBe(true)
    expect(emptyRow.text).toContain('empty or non-text message')

    // Paginating right through an emoji boundary must not produce lone surrogates.
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    let offset = 0
    let reassembled = ''
    for (let guard = 0; guard < 50; guard++) {
      const page = showArchive(sdir, { from: 2, offset, limit: 15 })
      const body = page.text.split('\n\n[strata show:')[0]
      expect(body).not.toMatch(loneSurrogate)
      reassembled += body
      if (!page.hasMore) break
      offset = page.nextOffset!
    }
    expect(reassembled).toBe(`#2 user: ${'🚀'.repeat(40)}`)

    // Pre-compaction ready ledger (through > committed branch length) reports 'pending', not 'stale'.
    const pendingDir = join(dir, 'sessions', 'pending-sess')
    writeReady(pendingDir, { ledger: '## Current state\n- prepped', through: 25, prefixHash: 'live-hash', age: 0, preparedAt: '2026-11-23T00:00:00Z' })
    const st = sessionStatus(pendingDir, 'pending-sess')
    expect(st.readyLedger?.status).toBe('pending')
    expect(formatSessionStatus(st)).toContain('(pending, prepared')
  })

  it('CLI replay --background --no-llm handles multi-compaction transcripts and prepare declines gracefully', () => {
    const cliPath = resolve('dist/cli.js')
    const transcript = join(dir, 'sample.jsonl')
    const lines: string[] = []
    for (let n = 0; n < 25; n++) {
      lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `step ${n}: inspect module ${n}` } }))
      lines.push(JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: 's'.repeat(1_200) },
            { type: 'tool_use', id: `u${n}`, name: 'Read', input: { file_path: `/src/m${n}.ts` } }
          ]
        }
      }))
      lines.push(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `u${n}`, content: 'C'.repeat(4_000) }] }
      }))
      lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: `Finished step ${n}.` } }))
    }
    writeFileSync(transcript, lines.join('\n') + '\n')
    const out = execFileSync('node', [cliPath, 'replay', transcript, '--budget', '4000', '--trigger', '8000', '--no-llm', '--background'], {
      encoding: 'utf-8'
    })
    expect(out).toContain('prepare at')
    expect(out).toContain('#1 archived')
    expect(out).toContain('end: live')
  })

  it('rejects . and .. session keys, exits 3 when ledger-plan declines, rejects prototype command names, and handles huge budgets without RangeError', () => {
    // 1. sessionDir rejects "." and ".." traversal while allowing leading dashes and internal dots
    expect(() => sessionDir(dir, '.')).toThrow(/invalid session key/)
    expect(() => sessionDir(dir, '..')).toThrow(/invalid session key/)
    expect(sessionDir(dir, '-leading-dash')).toBe(join(dir, 'sessions', '-leading-dash'))
    expect(sessionDir(dir, 'a..b')).toBe(join(dir, 'sessions', 'a..b'))

    const cliPath = resolve('dist/cli.js')
    const env = { ...process.env, STRATA_DATA_DIR: dir }
    const smallMsgs = [user('hi'), assistant('ok')]

    for (const badKey of ['.', '..']) {
      const r = spawnSync('node', [cliPath, 'compact', `--session=${badKey}`, '--in', '-', '--out', '-', '--budget', '2000', '--ledger', 'ready'], {
        input: JSON.stringify({ messages: smallMsgs }),
        env,
        encoding: 'utf-8'
      })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('invalid session key')
    }
    expect(existsSync(join(dir, 'state.json'))).toBe(false)
    expect(existsSync(join(dir, 'sessions', 'state.json'))).toBe(false)

    // 2. Synchronous ledger-plan DeclineError exits with EXIT_DECLINED (3), not 1
    const oversizeMsgs = [user('hi'), assistant('X'.repeat(5_000))]
    const declined = spawnSync('node', [cliPath, 'ledger-plan', '--session=decline-sess', '--in', '-', '--budget', '100', '--sync'], {
      input: JSON.stringify({ messages: oversizeMsgs }),
      env,
      encoding: 'utf-8'
    })
    expect(declined.status).toBe(3)
    expect(declined.stderr).toContain('[strata]')

    // 3. Prototype property names like `toString` are rejected as unknown commands
    const protoCmd = spawnSync('node', [cliPath, 'toString'], { env, encoding: 'utf-8' })
    expect(protoCmd.status).toBe(2)
    expect(protoCmd.stderr).toContain('unknown command: toString')

    // 4. Extreme --budget values do not throw RangeError in makeHeaderSizer
    const hugeBudget = spawnSync('node', [cliPath, 'ledger-plan', '--session=huge-budget', '--in', '-', '--budget', '99999999999999', '--sync'], {
      input: JSON.stringify({ messages: smallMsgs }),
      env,
      encoding: 'utf-8'
    })
    expect(hugeBudget.status).toBe(0)
    expect(JSON.parse(hugeBudget.stdout).needed).toBe(false)
  })
})
