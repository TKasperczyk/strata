import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compact, OversizeError } from '../src/compact.js'
import { loadConfig, type Config } from '../src/config.js'
import type { Message, OutputEntry } from '../src/types.js'
import { DEFAULT_THINKING_CHARS_PER_TOKEN, hiddenByRow, imageDimensions, imageTokens, lastRequestEnd, thinkingRatio, type ApiMessage } from '../src/weights.js'

const SESSION = 'weights'
const SHOW = 'strata show weights'
const BUDGET_TOKENS = 4_000
const BUDGET_CHARS = BUDGET_TOKENS * 3.5
const SIGNATURE = 's'.repeat(4_000)

/** A PNG header carrying only the IHDR dimensions: all imageDimensions reads. */
function png(width: number, height: number): string {
  const head = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'ascii')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  return head.toString('base64')
}

/** A JPEG with one SOF0 segment. */
function jpeg(width: number, height: number): string {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 0, 0, 0, 0, 0, 0, 0])
  head.writeUInt16BE(height, 7)
  head.writeUInt16BE(width, 9)
  return head.toString('base64')
}

const user = (text: string): Message => ({ role: 'user', text, toolUses: [] })
const call = (id: string): Message => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: 'Read', input: { file_path: `/shot-${id}.png` } }] })
const result = (id: string, text = 'ok'): Message => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text, isError: false }] })
const answer = (text: string): Message => ({ role: 'assistant', text, toolUses: [] })
const thinkingRow = (): Message => ({ role: 'assistant', text: '', toolUses: [] })
const image = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })

/** One screenshot exchange: rows as the hook sees them, blocks as the API form has them. */
function shotTurn(n: number, size = 1200): { rows: Message[]; api: ApiMessage[] } {
  const id = `s${n}`
  return {
    rows: [user(`look at shot ${n}`), thinkingRow(), call(id), result(id), answer(`shot ${n} looks fine ${'.'.repeat(300)}`)],
    api: [
      { role: 'user', content: [{ type: 'text', text: `look at shot ${n}` }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: SIGNATURE }, { type: 'tool_use', id, name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [image(png(size, size))] }] },
      { role: 'assistant', content: [{ type: 'text', text: `shot ${n} looks fine ${'.'.repeat(300)}` }] }
    ]
  }
}

function turns(count: number, from = 0) {
  const all = Array.from({ length: count }, (_, k) => shotTurn(from + k))
  return { rows: all.flatMap(t => t.rows), api: all.flatMap(t => t.api) }
}

const materialize = (input: Message[], entries: OutputEntry[]) => entries.map(e => ('keep' in e ? input[e.keep] : e.built))

describe('image sizing', () => {
  it('reads PNG and JPEG dimensions and prices them at w*h/750', () => {
    expect(imageDimensions(png(1766, 2000))).toEqual([1766, 2000])
    expect(imageDimensions(jpeg(640, 480))).toEqual([640, 480])
    expect(imageTokens(png(1500, 1500))).toBe(3_000)
  })
})

describe('hiddenByRow', () => {
  it('puts result images on the result row and thinking on the response row', () => {
    const { rows, api } = shotTurn(0)
    const hidden = hiddenByRow(rows, api)
    expect(hidden.get(3)?.imageTokens).toBe(imageTokens(png(1200, 1200)))
    expect(hidden.get(3)?.images[0].toolUseId).toBe('s0')
    expect(hidden.get(2)?.thinkingChars).toBe(SIGNATURE.length)
  })

  it('attaches a pasted image to its prompt', () => {
    const rows = [user('what is in this picture?'), answer('a cat')]
    const api: ApiMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'what is in this picture?' }, image(png(800, 600))] },
      { role: 'assistant', content: [{ type: 'text', text: 'a cat' }] }
    ]
    expect(hiddenByRow(rows, api).get(0)?.images).toHaveLength(1)
  })
})

describe('third-pass regressions (weights)', () => {
  it('charges each thinking block of a regrouped response to the call it precedes', () => {
    const rows = [user('go'), thinkingRow(), call('a'), result('a'), thinkingRow(), call('b'), result('b')]
    // The engine regroups one streamed response across its own results.
    const api: ApiMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'A'.repeat(100) },
          { type: 'tool_use', id: 'a', name: 'Read', input: {} },
          { type: 'thinking', thinking: '', signature: 'B'.repeat(40_000) },
          { type: 'tool_use', id: 'b', name: 'Read', input: {} }
        ]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }, { type: 'tool_result', tool_use_id: 'b', content: 'ok' }] }
    ]
    const hidden = hiddenByRow(rows, api)
    expect(hidden.get(2)?.thinkingChars).toBe(100)
    expect(hidden.get(5)?.thinkingChars).toBe(40_000)
  })

  it('gives each image of merged prompts to the prompt it follows', () => {
    const rows = [user('first picture'), user('second picture'), answer('two pictures')]
    const api: ApiMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'first picture' }, image(png(100, 100)), { type: 'text', text: 'second picture' }, image(png(2000, 1500))] },
      { role: 'assistant', content: [{ type: 'text', text: 'two pictures' }] }
    ]
    const hidden = hiddenByRow(rows, api)
    expect(hidden.get(0)?.imageTokens).toBe(imageTokens(png(100, 100)))
    expect(hidden.get(1)?.imageTokens).toBe(imageTokens(png(2000, 1500)))
  })

  it('leaves the newest response out of calibration: the reading predates it', () => {
    const { rows, api } = turns(2)
    const fresh: Message[] = [user('think hard'), thinkingRow(), answer('done')]
    const freshApi: ApiMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'think hard' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'z'.repeat(40_000) }, { type: 'text', text: 'done' }] }
    ]
    const all = [...rows, ...fresh]
    expect(lastRequestEnd(all)).toBe(all.length - 2)
    const hidden = hiddenByRow(all, [...api, ...freshApi])
    const withoutFresh = hiddenByRow(rows, api)
    const reading = { tokens: 20_000, overhead: 1_000 }
    // The fresh response's 40k signature chars must not move the ratio.
    expect(thinkingRatio(all, hidden, reading)).toBeCloseTo(thinkingRatio([...rows, user('think hard')], withoutFresh, reading), 1)
  })
})

describe('thinkingRatio', () => {
  it('calibrates against the real window and falls back without a reading', () => {
    const { rows, api } = turns(3)
    const hidden = hiddenByRow(rows, api)
    expect(thinkingRatio(rows, hidden, undefined)).toBe(DEFAULT_THINKING_CHARS_PER_TOKEN)
    // The last request did not carry the final answer: calibration leaves it out.
    const visible = rows.slice(0, lastRequestEnd(rows)).reduce((n, m) => n + m.text.length + m.toolUses.reduce((k, u) => k + u.tool.length + JSON.stringify(u.input).length, 0) + (m.toolResults ?? []).reduce((k, r) => k + r.text.length, 0), 0) / 3.5
    const images = [...hidden.values()].reduce((n, h) => n + h.imageTokens, 0)
    // 3 signatures of 4,000 chars standing for 2,400 tokens: 5 chars per token.
    const ratio = thinkingRatio(rows, hidden, { tokens: Math.round(1_000 + visible + images + 2_400), overhead: 1_000 })
    expect(ratio).toBeCloseTo(5, 1)
  })
})

describe('compaction with the API form', () => {
  let dir: string
  let config: Config
  const noLedger = async (previous: string) => ({ ledger: previous, requests: 0 })
  const run = (messages: Message[], api?: ApiMessage[]) => compact({ sessionKey: SESSION, messages, showCommand: SHOW, ...(api ? { api } : {}) }, config, noLedger)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strata-weights-'))
    config = loadConfig({ dataDir: dir, budgetTokens: BUDGET_TOKENS, ledgerRebuildEvery: 0 })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('counts the images and thinking of rows it keeps whole against the budget', async () => {
    const { rows, api } = turns(8)
    const textOnly = await run(rows)
    rmSync(dir, { recursive: true, force: true })
    const weighted = await run(rows, api)
    expect(weighted.stats.hiddenChars).toBeGreaterThan(0)
    expect(weighted.stats.outputChars).toBeLessThanOrEqual(BUDGET_CHARS)
    // Seeing the weight, it keeps fewer rows verbatim than the text-only count did.
    expect(weighted.stats.tailStart).toBeGreaterThan(textOnly.stats.tailStart)
  })

  it('archives images as files and points rebuilt results at them', async () => {
    // Room for a masked middle: one screenshot exchange alone weighs ~10k chars.
    config = loadConfig({ dataDir: dir, budgetTokens: BUDGET_TOKENS * 3, ledgerRebuildEvery: 0 })
    const { rows, api } = turns(8)
    const { entries, stats } = await run(rows, api)
    expect(stats.mediaSaved).toBe(8)
    const files = readdirSync(join(dir, 'sessions', SESSION, 'media'))
    expect(files).toHaveLength(8)
    const rebuilt = materialize(rows, entries).flatMap(m => m.toolResults ?? []).find(r => r.text.includes('[strata:'))
    expect(rebuilt?.text).toMatch(/saved as .*media\/\d+-0\.png; open with Read/)
  })

  it('writes no image files when it declines', async () => {
    const { rows, api } = shotTurn(0, 6_000)
    await expect(run(rows, api)).rejects.toBeInstanceOf(OversizeError)
    expect(existsSync(join(dir, 'sessions', SESSION, 'media'))).toBe(false)
  })
})
