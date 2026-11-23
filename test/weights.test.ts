import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compact, OversizeError } from '../src/compact.js'
import { CHARS_PER_TOKEN, loadConfig, type Config } from '../src/config.js'
import type { Message, OutputEntry } from '../src/types.js'
import {
  calibrateWeights,
  DEFAULT_THINKING_CHARS_PER_TOKEN,
  hiddenByRow,
  imageDimensions,
  imageTokens,
  lastRequestEnd,
  textCharsPerToken,
  thinkingRatio,
  type ApiMessage
} from '../src/weights.js'

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

/** A JPEG with 0xFF fill bytes, APP0 segment, standalone markers (TEM + RST0), and progressive SOF2. */
function jpegWithFillAndStandalone(width: number, height: number): string {
  const parts = [
    // SOI
    0xff, 0xd8,
    // 0xFF fill bytes before APP0 (length = 6, 4 payload bytes)
    0xff, 0xff, 0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46,
    // Standalone TEM (0x01) and RST0 (0xD0) with no length field
    0xff, 0x01,
    0xff, 0xff, 0xd0,
    // Progressive SOF2 (0xC2) with fill byte
    0xff, 0xff, 0xc2, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0, 0, 0, 0, 0, 0, 0
  ]
  return Buffer.from(parts).toString('base64')
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
  it('reads PNG and JPEG dimensions and applies Anthropic downscaling caps', () => {
    expect(imageDimensions(png(1766, 2000))).toEqual([1766, 2000])
    expect(imageDimensions(jpeg(640, 480))).toEqual([640, 480])
    // Small image: exact ceil(w*h/750)
    expect(imageTokens(png(800, 600))).toBe(640)
    expect(imageTokens(jpeg(640, 480))).toBe(410)
    // High-res square image: capped at Anthropic's ~1,600-token ceiling
    expect(imageTokens(png(1500, 1500))).toBe(1_600)
    expect(imageTokens(png(4000, 3000))).toBe(1_600)
    // Wide panorama: long edge scaled to 1568px, preserving aspect ratio (3000x600 -> 1568x313.6 -> 656 tokens)
    expect(imageTokens(png(3000, 600))).toBe(656)
    // Invalid / zero dimensions fall back safely
    expect(imageTokens(png(0, 0))).toBe(1_600)
  })

  it('parses JPEGs with 0xFF fill bytes, standalone markers (TEM/RST), and progressive SOF2', () => {
    expect(imageDimensions(jpegWithFillAndStandalone(1024, 768))).toEqual([1024, 768])
    // Stops cleanly at SOS (0xDA) without crashing
    const sosOnly = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0, 0, 0, 0, 0, 0]).toString('base64')
    expect(imageDimensions(sosOnly)).toBeUndefined()
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

  it('attaches pasted images that precede prompt text ([image, text]) without mis-advancing cursor', () => {
    // A later empty-text user row exists — an unbuffered scanner would jump cursor to row 2!
    const rows = [user('describe this screenshot'), answer('looks good'), user(''), answer('second image')]
    const api: ApiMessage[] = [
      { role: 'user', content: [image(png(800, 600)), { type: 'text', text: 'describe this screenshot' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'looks good' }] },
      { role: 'user', content: [image(png(400, 400))] },
      { role: 'assistant', content: [{ type: 'text', text: 'second image' }] }
    ]
    const hidden = hiddenByRow(rows, api)
    expect(hidden.get(0)?.images).toHaveLength(1)
    expect(hidden.get(0)?.imageTokens).toBe(imageTokens(png(800, 600)))
    expect(hidden.get(2)?.images).toHaveLength(1)
    expect(hidden.get(2)?.imageTokens).toBe(imageTokens(png(400, 400)))
  })

  it('distinguishes a merged image-only prompt before a text prompt from [image, text]', () => {
    const rows = [user(''), user('and here is my question'), answer('got it')]
    const api: ApiMessage[] = [
      { role: 'user', content: [image(png(500, 500)), { type: 'text', text: 'and here is my question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'got it' }] }
    ]
    const hidden = hiddenByRow(rows, api)
    expect(hidden.get(0)?.images).toHaveLength(1)
    expect(hidden.get(1)).toBeUndefined()
  })

  it('matches multi-text-block messages joined by newline in SessionMessage.text', () => {
    const rows = [user('first part\nsecond part'), thinkingRow(), answer('reply part 1\nreply part 2')]
    const api: ApiMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'first part' }, { type: 'text', text: 'second part' }, image(png(600, 600))] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'X'.repeat(500) },
          { type: 'text', text: 'reply part 1' },
          { type: 'thinking', thinking: '', signature: 'Y'.repeat(700) },
          { type: 'text', text: 'reply part 2' }
        ]
      }
    ]
    const hidden = hiddenByRow(rows, api)
    expect(hidden.get(0)?.images).toHaveLength(1)
    expect(hidden.get(2)?.thinkingChars).toBe(1200)
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

describe('thinkingRatio and textCharsPerToken calibration', () => {
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

  it('does not blow up thinkingRatio when thinking is a tiny share of a noisy text context', () => {
    const rows = [
      user('A'.repeat(350_000)), // 100k est tokens at 3.5 chars/token
      thinkingRow(),
      call('c0'),
      result('c0', 'B'.repeat(350_000)), // another 100k est tokens
      answer('done')
    ]
    const api: ApiMessage[] = [
      { role: 'user', content: [{ type: 'text', text: rows[0].text }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's'.repeat(4_000) }, { type: 'tool_use', id: 'c0', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c0', content: rows[3].toolResults![0].text }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
    ]
    const hidden = hiddenByRow(rows, api)
    // Real visible text ran +10% denser (+20k tokens) than chars/3.5; thinking is only ~1k tokens.
    const cal = calibrateWeights(rows, hidden, { tokens: 1_000 + 220_000 + 1_000, overhead: 1_000 })
    // thinkingRatio must stay near default 4.0 instead of collapsing to 1.5!
    expect(cal.thinkingRatio).toBeGreaterThan(3.5)
    expect(cal.thinkingRatio).toBeLessThan(4.2)
    // Instead, text density absorbs the +10% discrepancy (~3.18 chars/token).
    expect(cal.charsPerToken).toBeLessThan(3.3)
    expect(cal.charsPerToken).toBeGreaterThan(3.0)
  })

  it('calibrates textCharsPerToken when there is no thinking at all', () => {
    const rows = [user('x'.repeat(250_000)), answer('done')]
    const hidden = new Map()
    // 250k chars of dense JSON really took 100k tokens -> 2.5 chars/token
    const cpt = textCharsPerToken(rows, hidden, { tokens: 105_000, overhead: 5_000 })
    expect(cpt).toBeCloseTo(2.5, 1)
    expect(textCharsPerToken(rows, hidden, undefined)).toBe(CHARS_PER_TOKEN)
  })
})

describe('compaction with the API form', () => {
  let dir: string
  let config: Config
  const noLedger = async (previous: string) => ({ ledger: previous, requests: 0 })
  const run = (messages: Message[], api?: ApiMessage[], usage?: { tokens?: number; overhead?: number }) =>
    compact({ sessionKey: SESSION, messages, showCommand: SHOW, ...(api ? { api } : {}), ...(usage ? { usage } : {}) }, config, noLedger)

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
    // Room for a masked middle: one screenshot exchange alone weighs ~9k chars.
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
    // Budget smaller than one 1,600-token image + 1,000-token thinking response (~2,600 tokens).
    config = loadConfig({ dataDir: dir, budgetTokens: 1_500, ledgerRebuildEvery: 0 })
    const { rows, api } = shotTurn(0, 2_000)
    await expect(run(rows, api)).rejects.toBeInstanceOf(OversizeError)
    expect(existsSync(join(dir, 'sessions', SESSION, 'media'))).toBe(false)
  })
})
