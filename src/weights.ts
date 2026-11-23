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

export type Calibration = {
  /** Calibrated thinking signature chars per token. */
  thinkingRatio: number
  /** Calibrated visible-text chars per token. */
  charsPerToken: number
}

/** Thinking chars per token when nothing can be calibrated; measured 2.8-5.0 on real sessions. */
export const DEFAULT_THINKING_CHARS_PER_TOKEN = 4
const RATIO_BOUNDS = [1.5, 8] as const
const TEXT_RATIO_BOUNDS = [2.0, 5.0] as const
/** Tokens per image when its dimensions cannot be read. */
const UNKNOWN_IMAGE_TOKENS = 1_600
/** Anthropic's image cost: about width x height / 750 tokens, after downscaling. */
const PIXELS_PER_TOKEN = 750
/** Anthropic downscales images past 1568px on the long edge or ~1.15-1.20 MP (~1,600 tokens). */
const MAX_IMAGE_LONG_EDGE = 1_568
const MAX_IMAGE_TOKENS = 1_600

/** Pixel dimensions from a base64 PNG, JPEG, GIF or WebP header, if readable. */
export function imageDimensions(base64: string): [number, number] | undefined {
  const head = Buffer.from(base64.slice(0, 120_000), 'base64')
  if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47) return [head.readUInt32BE(16), head.readUInt32BE(20)]
  if (head.length >= 10 && head.toString('ascii', 0, 3) === 'GIF') return [head.readUInt16LE(6), head.readUInt16LE(8)]
  if (head.length >= 30 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') {
    const kind = head.toString('ascii', 12, 16)
    if (kind === 'VP8X') return [1 + head.readUIntLE(24, 3), 1 + head.readUIntLE(27, 3)]
    if (kind === 'VP8 ') return [head.readUInt16LE(26) & 0x3fff, head.readUInt16LE(28) & 0x3fff]
    if (kind === 'VP8L') {
      const bits = head.readUInt32LE(21)
      return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)]
    }
  }
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
    let i = 2
    while (i < head.length) {
      if (head[i] !== 0xff) {
        i++
        continue
      }
      // JPEG permits arbitrary 0xFF fill bytes before a marker byte.
      while (i < head.length && head[i] === 0xff) i++
      if (i >= head.length) break
      const marker = head[i++]
      // Standalone markers (byte-stuffed 0x00, TEM 0x01, RST0-7 0xD0-0xD7, SOI 0xD8) have no length field.
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
      // EOI (0xD9) or Start of Scan (0xDA): SOF must precede image data.
      if (marker === 0xd9 || marker === 0xda) break
      if (i + 2 > head.length) break
      const len = head.readUInt16BE(i)
      if (len < 2) break
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) {
        if (i + 7 > head.length) break
        return [head.readUInt16BE(i + 5), head.readUInt16BE(i + 3)]
      }
      i += len
    }
  }
  return undefined
}

export function imageTokens(base64: string): number {
  const size = imageDimensions(base64)
  if (!size || size[0] <= 0 || size[1] <= 0) return UNKNOWN_IMAGE_TOKENS
  const [w, h] = size
  const edgeScale = Math.min(1, MAX_IMAGE_LONG_EDGE / Math.max(w, h))
  const scaledPixels = w * edgeScale * (h * edgeScale)
  return Math.min(MAX_IMAGE_TOKENS, Math.ceil(scaledPixels / PIXELS_PER_TOKEN))
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
 * Match an API text block against a SessionMessage's `text` starting at
 * `fromOffset`. Multiple text blocks on one row are joined with `\n` in
 * SessionMessage.text, so a block matches either the whole trimmed text or a
 * line-bounded segment within it. Returns the next offset within the row and
 * whether the row's text has now been fully consumed.
 */
function matchTextBlock(
  rowText: string,
  blockText: string,
  fromOffset = 0
): { end: number; consumedAll: boolean } | undefined {
  const trimmed = rowText.trim()
  if (fromOffset === 0 && trimmed === blockText) return { end: trimmed.length, consumedAll: true }
  if (!trimmed.includes('\n')) return undefined
  let idx = trimmed.indexOf(blockText, fromOffset)
  while (idx !== -1) {
    let start = idx
    while (start > 0 && trimmed[start - 1] !== '\n' && (trimmed[start - 1] === ' ' || trimmed[start - 1] === '\t' || trimmed[start - 1] === '\r')) start--
    const startOk = start === 0 || trimmed[start - 1] === '\n'
    let end = idx + blockText.length
    while (end < trimmed.length && trimmed[end] !== '\n' && (trimmed[end] === ' ' || trimmed[end] === '\t' || trimmed[end] === '\r')) end++
    const endOk = end === trimmed.length || trimmed[end] === '\n'
    if (startOk && endOk) {
      const next = end < trimmed.length && trimmed[end] === '\n' ? end + 1 : end
      return { end: next, consumedAll: next >= trimmed.length }
    }
    idx = trimmed.indexOf(blockText, idx + 1)
  }
  return undefined
}

function isEmptyPrompt(m: Message): boolean {
  return m.role === 'user' && !m.toolResults?.length && !m.text.trim()
}

/**
 * Attach each API message's images and thinking to the input rows they belong
 * to. Tool results and their images match by tool_use_id; a response's
 * thinking goes to the row of its first call or text; a pasted image goes to
 * its prompt's row (whether it precedes or follows the prompt's text), or else
 * the image-only prompt row(s). Placement only has to be right to the exchange:
 * strata moves whole exchanges, never single rows.
 */
export function hiddenByRow(input: Message[], api: ApiMessage[]): Map<number, Hidden> {
  const hidden = new Map<number, Hidden>()
  const at = (row: number) => {
    let h = hidden.get(row)
    if (!h) hidden.set(row, (h = emptyHidden()))
    return h
  }
  const attachImage = (row: number, ref: ImageRef) => {
    const h = at(row)
    h.images.push(ref)
    h.imageTokens += imageTokens(ref.data)
  }
  const callRow = new Map<string, number>()
  const resultRow = new Map<string, number>()
  input.forEach((m, i) => {
    for (const u of m.toolUses) callRow.set(u.tool_use_id, i)
    for (const r of m.toolResults ?? []) resultRow.set(r.tool_use_id, i)
  })
  // Rows are in conversation order; searching forward from (cursor, cursorOffset) keeps repeats apart
  // and lets multi-text-block rows advance cleanly once their final block is matched.
  let cursor = 0
  let cursorOffset = 0
  const advanceCursor = (row: number, offset = 0) => {
    if (row > cursor) {
      cursor = row
      cursorOffset = offset
    } else if (row === cursor && offset > cursorOffset) {
      cursorOffset = offset
    }
  }
  const findForward = (test: (m: Message) => boolean, from = cursor): number | undefined => {
    for (let i = from; i < input.length; i++) if (test(input[i])) return i
    return undefined
  }
  const findTextMatch = (role: 'user' | 'assistant', text: string) => {
    for (let i = cursor; i < input.length; i++) {
      const m = input[i]
      if (m.role !== role) continue
      if (role === 'user' && m.toolResults?.length) continue
      const match = matchTextBlock(m.text, text, i === cursor ? cursorOffset : 0)
      if (match) return { row: i, ...match }
    }
    return undefined
  }

  for (const message of api) {
    if (message.role === 'assistant') {
      // The engine regroups one streamed response's blocks across its own tool
      // results, so one message can span several exchanges. Each thinking block
      // belongs to the call or text that follows it, not to the message's first.
      let pending = 0
      let last: number | undefined
      for (const block of message.content) {
        pending += thinkingChars(block)
        let row: number | undefined
        if (block.type === 'tool_use') {
          row = callRow.get(String(block.id))
          if (row !== undefined) advanceCursor(row)
        } else if (block.type === 'text' && String(block.text ?? '').trim()) {
          const text = String(block.text).trim()
          const hit = findTextMatch('assistant', text)
          if (hit) {
            row = hit.row
            advanceCursor(hit.consumedAll ? hit.row + 1 : hit.row, hit.consumedAll ? 0 : hit.end)
          }
        }
        if (row === undefined) continue
        last = row
        if (pending) at(row).thinkingChars += pending
        pending = 0
      }
      // Thinking with nothing after it (an answer still to come) stays with the response.
      if (pending) {
        const row = last ?? findForward(m => m.role === 'assistant')
        if (row !== undefined) at(row).thinkingChars += pending
      }
      continue
    }

    // Consecutive prompts merge into one message. Images may either follow their
    // prompt's text ([text, image]), precede it ([image, text]), or appear alone
    // on image-only user rows ([image]). Buffer images until boundaries reveal
    // whether contiguous empty-text prompt rows own them.
    let promptAnchor: number | undefined
    const pendingImages: ImageRef[] = []
    const afterAnchorImages: ImageRef[] = []
    const flushAfterAnchor = (limit: number) => {
      if (promptAnchor === undefined || !afterAnchorImages.length) return
      const emptyAfter: number[] = []
      for (let k = promptAnchor + 1; k < limit && isEmptyPrompt(input[k]); k++) emptyAfter.push(k)
      if (!emptyAfter.length) {
        for (const ref of afterAnchorImages) attachImage(promptAnchor, ref)
      } else if (afterAnchorImages.length <= emptyAfter.length) {
        afterAnchorImages.forEach((ref, idx) => attachImage(emptyAfter[idx], ref))
        advanceCursor(emptyAfter[afterAnchorImages.length - 1] + 1)
      } else {
        const forAnchor = afterAnchorImages.length - emptyAfter.length
        for (let i = 0; i < forAnchor; i++) attachImage(promptAnchor, afterAnchorImages[i])
        emptyAfter.forEach((emptyRow, idx) => attachImage(emptyRow, afterAnchorImages[forAnchor + idx]))
        advanceCursor(emptyAfter[emptyAfter.length - 1] + 1)
      }
      afterAnchorImages.length = 0
    }

    for (const block of message.content) {
      if (block.type === 'tool_result') {
        const id = String(block.tool_use_id)
        const row = resultRow.get(id)
        if (row === undefined) continue
        flushAfterAnchor(row)
        promptAnchor = undefined
        advanceCursor(row)
        const content = Array.isArray(block.content) ? (block.content as ApiBlock[]) : []
        for (const inner of content) {
          const ref = imageRef(inner, id)
          if (ref) attachImage(row, ref)
        }
      } else if (block.type === 'text') {
        const text = String(block.text ?? '').trim()
        const hit = text ? findTextMatch('user', text) : undefined
        if (hit) {
          if (pendingImages.length) {
            const emptyBefore: number[] = []
            for (let k = hit.row - 1; k >= cursor && isEmptyPrompt(input[k]); k--) emptyBefore.unshift(k)
            if (emptyBefore.length) {
              pendingImages.forEach((ref, idx) => attachImage(emptyBefore[Math.min(idx, emptyBefore.length - 1)], ref))
            } else {
              for (const ref of pendingImages) attachImage(hit.row, ref)
            }
            pendingImages.length = 0
          }
          if (promptAnchor !== undefined && afterAnchorImages.length) {
            if (hit.row === promptAnchor) {
              for (const ref of afterAnchorImages) attachImage(promptAnchor, ref)
              afterAnchorImages.length = 0
            } else {
              flushAfterAnchor(hit.row)
            }
          }
          promptAnchor = hit.row
          advanceCursor(hit.consumedAll ? hit.row + 1 : hit.row, hit.consumedAll ? 0 : hit.end)
        }
      } else if (block.type === 'image') {
        const ref = imageRef(block)
        if (!ref) continue
        if (promptAnchor !== undefined) afterAnchorImages.push(ref)
        else pendingImages.push(ref)
      }
    }
    flushAfterAnchor(input.length)
    if (pendingImages.length) {
      const firstEmpty = findForward(isEmptyPrompt)
      if (firstEmpty !== undefined) {
        const emptyRows: number[] = []
        for (let k = firstEmpty; k < input.length && isEmptyPrompt(input[k]) && emptyRows.length < pendingImages.length; k++) {
          emptyRows.push(k)
        }
        pendingImages.forEach((ref, idx) => attachImage(emptyRows[Math.min(idx, emptyRows.length - 1)], ref))
        advanceCursor(emptyRows[emptyRows.length - 1] + 1)
      }
    }
  }
  return hidden
}

/**
 * Where the last request's input ended: before the final assistant response,
 * whose output (thinking included) the engine's token reading does not cover,
 * along with anything after it.
 */
export function lastRequestEnd(input: Message[]): number {
  let end = input.length
  while (end > 0 && input[end - 1].role !== 'assistant') end--
  while (end > 0 && input[end - 1].role === 'assistant') end--
  return end
}

/**
 * Jointly calibrate thinking chars/token and visible-text chars/token against
 * the last request's real token reading, partitioning any residual by prior
 * variance so neither small thinking shares nor missing thinking distort the
 * estimate, and the residual is never double-counted.
 */
export function calibrateWeights(input: Message[], hidden: Map<number, Hidden>, usage: UsageReading | undefined): Calibration {
  const fallback: Calibration = { thinkingRatio: DEFAULT_THINKING_CHARS_PER_TOKEN, charsPerToken: CHARS_PER_TOKEN }
  if (usage?.tokens === undefined || usage.overhead === undefined) return fallback
  const end = lastRequestEnd(input)
  const seen = [...hidden.entries()].filter(([row]) => row < end).map(([, h]) => h)
  const thinking = seen.reduce((n, h) => n + h.thinkingChars, 0)
  const images = seen.reduce((n, h) => n + h.imageTokens, 0)
  const textChars = input.slice(0, end).reduce((n, m) => n + messageChars(m), 0)
  const actualNonImage = usage.tokens - usage.overhead - images
  if (actualNonImage <= 0) return fallback

  const textEst = textChars / CHARS_PER_TOKEN
  const thinkingEst = thinking / DEFAULT_THINKING_CHARS_PER_TOKEN
  const residual = actualNonImage - (textEst + thinkingEst)

  // Prior uncertainty: text heuristic (~15%), encrypted thinking ratio (~40%),
  // plus image/framing floor so tiny contexts shrink gently toward defaults.
  const sigmaText = textChars >= 1_000 ? 0.15 * textEst : 0
  const sigmaThink = thinking > 0 ? 0.4 * thinkingEst : 0
  const sigmaFloor = 0.02 * images + 100
  const vText = sigmaText * sigmaText
  const vThink = sigmaThink * sigmaThink
  const vTotal = vText + vThink + sigmaFloor * sigmaFloor

  let calibratedThinking = DEFAULT_THINKING_CHARS_PER_TOKEN
  if (thinking > 0) {
    const thinkingTokens = thinkingEst + residual * (vThink / vTotal)
    calibratedThinking =
      thinkingTokens > 0
        ? Math.min(RATIO_BOUNDS[1], Math.max(RATIO_BOUNDS[0], thinking / thinkingTokens))
        : RATIO_BOUNDS[1]
  }

  let calibratedText = CHARS_PER_TOKEN
  if (textChars >= 1_000) {
    const textTokens = textEst + residual * (vText / vTotal)
    calibratedText =
      textTokens > 0
        ? Math.min(TEXT_RATIO_BOUNDS[1], Math.max(TEXT_RATIO_BOUNDS[0], textChars / textTokens))
        : TEXT_RATIO_BOUNDS[1]
  }

  return { thinkingRatio: calibratedThinking, charsPerToken: calibratedText }
}

/**
 * Thinking chars per token for this session, calibrated against the last
 * request's real token reading. Falls back to the default when the reading is
 * missing, makes no sense, or thinking is too small a share of context.
 */
export function thinkingRatio(input: Message[], hidden: Map<number, Hidden>, usage: UsageReading | undefined): number {
  return calibrateWeights(input, hidden, usage).thinkingRatio
}

/** Visible-text chars per token for this session, calibrated against the last request. */
export function textCharsPerToken(input: Message[], hidden: Map<number, Hidden>, usage: UsageReading | undefined): number {
  return calibrateWeights(input, hidden, usage).charsPerToken
}

/** A row's hidden weight in the char units strata budgets in. */
export function hiddenChars(h: Hidden | undefined, ratio: number): number {
  if (!h) return 0
  return Math.round((h.imageTokens + h.thinkingChars / ratio) * CHARS_PER_TOKEN)
}

/**
 * Extra (or saved) char-budget weight for a row's visible text when real text
 * density differs from CHARS_PER_TOKEN.
 */
export function calibratedTextChars(rawChars: number, charsPerToken: number): number {
  if (charsPerToken === CHARS_PER_TOKEN) return rawChars
  return Math.round(rawChars * (CHARS_PER_TOKEN / charsPerToken))
}
