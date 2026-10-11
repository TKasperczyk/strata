import type { Config } from './config.js'
import { maskMessage, messageChars } from './mask.js'
import type { ArchivedMessage, Message, ToolResult, ToolUse } from './types.js'

/**
 * The smallest stretch of rows that can be moved, masked or rebuilt on its
 * own: a user prompt, or a tool exchange. The engine hands over one row per
 * content block, so one assistant response can span several rows with tool
 * results interleaved between them; splitting such a stretch orphans calls or
 * results. Bounds index into the branch's rows.
 */
export type Unit = { start: number; end: number; kind: 'prompt' | 'exchange' }

const NON_TEXT_PLACEHOLDER = (seq: number) =>
  `[strata: a message with non-text content (image or document) was here, seq ${seq}; only its text is archived]`

function mediaNote(paths: string[]): string {
  return `[strata: ${paths.length === 1 ? 'an image was' : `${paths.length} images were`} here, saved as ${paths.join(', ')}; open with Read to view]`
}

/** A rebuilt row loses its images: point at the files the archive saved instead. */
function withMedia(row: ArchivedMessage, viewed: Message): Message {
  if (!row.media?.length) return viewed
  const loose = row.media.filter(m => m.toolUseId === undefined).map(m => m.path)
  const text = loose.length ? [viewed.text, mediaNote(loose)].filter(Boolean).join('\n') : viewed.text
  const toolResults = viewed.toolResults?.map(r => {
    const paths = row.media!.filter(m => m.toolUseId === r.tool_use_id).map(m => m.path)
    return paths.length ? { ...r, text: `${r.text}\n${mediaNote(paths)}` } : r
  })
  return { ...viewed, text, ...(toolResults ? { toolResults } : {}) }
}

export function isPrompt(m: Message): boolean {
  return m.role === 'user' && !(m.toolResults?.length)
}

/**
 * `whole[i]` says whether the engine still holds row i as its own message. A
 * unit starts wherever that changes with no call open, so a unit never mixes
 * rows strata rebuilt with rows the engine can pass through whole (images,
 * thinking and all), on this compaction and every later one.
 */
export function segmentUnits(rows: Message[], whole: boolean[] = []): Unit[] {
  const units: Unit[] = []
  let i = 0
  while (i < rows.length) {
    if (isPrompt(rows[i])) {
      units.push({ start: i, end: i + 1, kind: 'prompt' })
      i++
      continue
    }
    // An exchange runs until every call it opened is answered and a new
    // response starts; a prompt ends it even with calls still open.
    const open = new Set<string>()
    let j = i
    while (j < rows.length) {
      const row = rows[j]
      if (isPrompt(row)) break
      const handoff = whole[j] !== whole[j - 1]
      if (j > i && open.size === 0 && (handoff || (row.role === 'assistant' && rows[j - 1].role === 'user'))) break
      for (const u of row.toolUses) open.add(u.tool_use_id)
      for (const r of row.toolResults ?? []) open.delete(r.tool_use_id)
      j++
    }
    units.push({ start: i, end: j, kind: 'exchange' })
    i = j
  }
  return units
}

export type RebuildMode = 'raw' | 'masked'

/**
 * A unit as plain Messages-API turns: one assistant message holding every
 * call of the exchange, then one user message holding every result. Calls
 * without a result and results without a call are dropped, empty messages
 * are never emitted (the engine would turn them into "(no content)").
 */
export function rebuildUnit(rows: ArchivedMessage[], mode: RebuildMode, config: Config): Message[] {
  const view = (m: ArchivedMessage): Message => withMedia(m, mode === 'masked' ? maskMessage(m, m.seq, config) : m)
  if (rows.length === 1 && isPrompt(rows[0])) {
    const m = view(rows[0])
    return [{ role: 'user', text: m.text.trim() ? m.text : NON_TEXT_PLACEHOLDER(rows[0].seq), toolUses: [] }]
  }
  const texts: string[] = []
  const uses: ToolUse[] = []
  const results: ToolResult[] = []
  const userTexts: string[] = []
  for (const row of rows) {
    const m = view(row)
    if (m.role === 'assistant') {
      if (m.text.trim()) texts.push(m.text)
      uses.push(...m.toolUses)
    } else {
      if (m.text.trim()) userTexts.push(m.text)
      results.push(...(m.toolResults ?? []))
    }
  }
  const answered = new Set(results.map(r => r.tool_use_id))
  const called = new Set(uses.map(u => u.tool_use_id))
  const pairedUses = uses.filter(u => answered.has(u.tool_use_id))
  const pairedResults = results.filter(r => called.has(r.tool_use_id))
  const out: Message[] = []
  if (texts.length || pairedUses.length) out.push({ role: 'assistant', text: texts.join('\n'), toolUses: pairedUses })
  if (pairedResults.length || userTexts.length) {
    out.push({ role: 'user', text: userTexts.join('\n'), toolUses: [], ...(pairedResults.length ? { toolResults: pairedResults } : {}) })
  }
  return out
}

export function unitChars(messages: Message[]): number {
  return messages.reduce((n, m) => n + messageChars(m), 0)
}
