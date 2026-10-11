import { CHARS_PER_TOKEN } from './config.js'
import { messageChars } from './mask.js'
import type { Message } from './types.js'

/**
 * What the per-block rows a compaction hook receives leave out, recovered from
 * the Messages API form of the same conversation: images and thinking. Rows
 * kept verbatim carry this weight into the next request; strata's own budget
 * has to count it.
 */
export type ApiBlock = { type: string; [field: string]: unknown }
export type ApiMessage = { role: 'user' | 'assistant'; content: ApiBlock[] }

/** The real figures the plugin reads from the engine, for calibration. */
export type UsageReading = {
  /** Input tokens of the last request: everything in the window. */
  tokens?: number
  /** The part of that which is not messages: system prompt, tools, memory files. */
  overhead?: number
}

export type ImageRef = { toolUseId?: string; mediaType: string; data: string }

export type Hidden = {
  imageTokens: number
  /** Thinking as it goes back: signature (encrypted) plus any plain text. */
  thinkingChars: number
  images: ImageRef[]
}

/** Thinking chars per token when nothing can be calibrated; measured 2.8-5.0 on real sessions. */
export const DEFAULT_THINKING_CHARS_PER_TOKEN = 4
const RATIO_BOUNDS = [1.5, 8] as const
/** Tokens per image when its dimensions cannot be read. */
const UNKNOWN_IMAGE_TOKENS = 1_600
/** Anthropic's image cost: about width x height / 750 tokens. */
const PIXELS_PER_TOKEN = 750

/** Pixel dimensions from a base64 PNG, JPEG, GIF or WebP header, if readable. */
export function imageDimensions(base64: string): [number, number] | undefined {
  const head = Buffer.from(base64.slice(0, 120_000), 'base64')
  if (head.length > 24 && head.readUInt32BE(0) === 0x89504e47) return [head.readUInt32BE(16), head.readUInt32BE(20)]
  if (head.length > 10 && head.toString('ascii', 0, 3) === 'GIF') return [head.readUInt16LE(6), head.readUInt16LE(8)]
  if (head.length > 30 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') {
    const kind = head.toString('ascii', 12, 16)
    if (kind === 'VP8X') return [1 + head.readUIntLE(24, 3), 1 + head.readUIntLE(27, 3)]
    if (kind === 'VP8 ') return [head.readUInt16LE(26) & 0x3fff, head.readUInt16LE(28) & 0x3fff]
    if (kind === 'VP8L') {
      const bits = head.readUInt32LE(21)
      return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)]
    }
  }
  if (head.length > 4 && head[0] === 0xff && head[1] === 0xd8) {
    let i = 2
    while (i + 9 < head.length) {
      if (head[i] !== 0xff) {
        i++
        continue
      }
      const marker = head[i + 1]
      if (marker >= 0xc0 && marker <= 0xc3) return [head.readUInt16BE(i + 7), head.readUInt16BE(i + 5)]
      i += 2 + head.readUInt16BE(i + 2)
    }
  }
  return undefined
}

export function imageTokens(base64: string): number {
  const size = imageDimensions(base64)
  return size ? Math.ceil((size[0] * size[1]) / PIXELS_PER_TOKEN) : UNKNOWN_IMAGE_TOKENS
}

function imageRef(block: ApiBlock, toolUseId?: string): ImageRef | undefined {
  const source = block.source as { type?: string; media_type?: string; data?: string } | undefined
  if (block.type !== 'image' || source?.type !== 'base64' || typeof source.data !== 'string') return undefined
  return { ...(toolUseId ? { toolUseId } : {}), mediaType: source.media_type ?? 'image/png', data: source.data }
}

function thinkingChars(block: ApiBlock): number {
  if (block.type === 'thinking') return String(block.signature ?? '').length + String(block.thinking ?? '').length
  if (block.type === 'redacted_thinking') return String(block.data ?? '').length
  return 0
}

function emptyHidden(): Hidden {
  return { imageTokens: 0, thinkingChars: 0, images: [] }
}

/**
 * Attach each API message's images and thinking to the input rows they belong
 * to. Tool results and their images match by tool_use_id; a response's
 * thinking goes to the row of its first call or text; a pasted image goes to
 * its prompt's row, or the next image-only row. Placement only has to be right
 * to the exchange: strata moves whole exchanges, never single rows.
 */
export function hiddenByRow(input: Message[], api: ApiMessage[]): Map<number, Hidden> {
  const hidden = new Map<number, Hidden>()
  const at = (row: number) => {
    let h = hidden.get(row)
    if (!h) hidden.set(row, (h = emptyHidden()))
    return h
  }
  const callRow = new Map<string, number>()
  const resultRow = new Map<string, number>()
  input.forEach((m, i) => {
    for (const u of m.toolUses) callRow.set(u.tool_use_id, i)
    for (const r of m.toolResults ?? []) resultRow.set(r.tool_use_id, i)
  })
  // Rows are in conversation order; searching forward from the last match keeps repeats apart.
  let cursor = 0
  const findForward = (test: (m: Message) => boolean): number | undefined => {
    for (let i = cursor; i < input.length; i++) if (test(input[i])) return i
    return undefined
  }

  for (const message of api) {
    if (message.role === 'assistant') {
      const thinking = message.content.reduce((n, b) => n + thinkingChars(b), 0)
      const firstCall = message.content.find(b => b.type === 'tool_use')
      const firstText = message.content.find(b => b.type === 'text' && String(b.text ?? '').trim())
      let anchor = firstCall ? callRow.get(String(firstCall.id)) : undefined
      if (anchor === undefined && firstText) {
        const text = String(firstText.text).trim()
        anchor = findForward(m => m.role === 'assistant' && m.text.trim() === text)
      }
      anchor ??= findForward(m => m.role === 'assistant')
      if (anchor === undefined) continue
      cursor = anchor
      if (thinking) at(anchor).thinkingChars += thinking
      continue
    }
    let promptAnchor: number | undefined
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        const id = String(block.tool_use_id)
        const row = resultRow.get(id)
        if (row === undefined) continue
        cursor = Math.max(cursor, row)
        const content = Array.isArray(block.content) ? (block.content as ApiBlock[]) : []
        for (const inner of content) {
          const ref = imageRef(inner, id)
          if (!ref) continue
          at(row).images.push(ref)
          at(row).imageTokens += imageTokens(ref.data)
        }
      } else if (block.type === 'text' && promptAnchor === undefined) {
        const text = String(block.text ?? '').trim()
        if (text) promptAnchor = findForward(m => m.role === 'user' && !m.toolResults?.length && m.text.trim() === text)
      } else if (block.type === 'image') {
        const ref = imageRef(block)
        if (!ref) continue
        const row = promptAnchor ?? findForward(m => m.role === 'user' && !m.toolResults?.length && !m.text.trim())
        if (row === undefined) continue
        cursor = row
        at(row).images.push(ref)
        at(row).imageTokens += imageTokens(ref.data)
      }
    }
    if (promptAnchor !== undefined) cursor = promptAnchor
  }
  return hidden
}

/**
 * Thinking chars per token for this session: the real window minus overhead
 * minus what strata can see is thinking. Falls back to the default when the
 * reading is missing or makes no sense.
 */
export function thinkingRatio(input: Message[], hidden: Map<number, Hidden>, usage: UsageReading | undefined): number {
  const thinking = [...hidden.values()].reduce((n, h) => n + h.thinkingChars, 0)
  if (!thinking || usage?.tokens === undefined || usage.overhead === undefined) return DEFAULT_THINKING_CHARS_PER_TOKEN
  const visible = input.reduce((n, m) => n + messageChars(m), 0) / CHARS_PER_TOKEN + [...hidden.values()].reduce((n, h) => n + h.imageTokens, 0)
  const thinkingTokens = usage.tokens - usage.overhead - visible
  if (thinkingTokens <= 0) return DEFAULT_THINKING_CHARS_PER_TOKEN
  return Math.min(RATIO_BOUNDS[1], Math.max(RATIO_BOUNDS[0], thinking / thinkingTokens))
}

/** A row's hidden weight in the char units strata budgets in. */
export function hiddenChars(h: Hidden | undefined, ratio: number): number {
  if (!h) return 0
  return Math.round((h.imageTokens + h.thinkingChars / ratio) * CHARS_PER_TOKEN)
}
