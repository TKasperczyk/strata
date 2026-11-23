import type { Config } from './config.js'
import type { Message, ToolResult, ToolUse } from './types.js'

export const STUB_PREFIX = '[strata elided'

export function messageChars(m: Message): number {
  let n = m.text.length
  // A tool_use's `text` mirrors the paired tool_result, which the API carries once.
  for (const u of m.toolUses) n += u.tool.length + JSON.stringify(u.input).length
  for (const r of m.toolResults ?? []) n += r.text.length
  return n
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[+${text.length - max} chars]`
}

function cutWithSeq(text: string, max: number, seq: number): string {
  if (text.length <= max) return text
  if (max < 80) return cut(text, max)
  const head = Math.floor(max * 0.65)
  const tail = max - head
  const omitted = text.length - head - tail
  const note = `\n…[strata omitted ${omitted.toLocaleString('en-US')} chars; full text is archive seq ${seq}]…\n`
  const shortened = `${text.slice(0, head)}${note}${tail > 0 ? text.slice(-tail) : ''}`
  return shortened.length < text.length ? shortened : text
}

function capInput(value: unknown, max: number): unknown {
  if (typeof value === 'string') return cut(value, max)
  if (Array.isArray(value)) return value.map(v => capInput(v, max))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capInput(v, max)]))
  }
  return value
}

export function stub(chars: number, seq: number): string {
  return `${STUB_PREFIX} a ${chars.toLocaleString('en-US')}-char tool result; full text is archive seq ${seq}]`
}

export function maskResultText(text: string, isError: boolean, seq: number, config: Config): string {
  const keep = isError ? config.errorResultChars : config.smallResultChars
  if (text.length <= keep) return text
  const header = stub(text.length, seq)
  if (keep <= 0) return header
  const head = isError ? Math.floor(keep * 0.5) : Math.floor(keep * 0.6)
  const tail = keep - head
  const excerpt = `${header}\n${text.slice(0, head)}\n…\n${tail > 0 ? text.slice(-tail) : ''}`
  return excerpt.length < text.length ? excerpt : text
}

/**
 * The masked form of a raw message: prose is bounded with head+tail excerpts,
 * tool calls keep their name and shortened arguments (without mirrored result
 * text, which lives on the paired result row with its own seq), and large tool
 * results become an archive pointer with head+tail excerpts. Tool calls are
 * never dropped, so every claim of work keeps its evidence.
 */
export function maskMessage(m: Message, seq: number, config: Config): Message {
  if (m.role === 'user') {
    return {
      role: 'user',
      text: cutWithSeq(m.text, config.userTextCapChars, seq),
      toolUses: [],
      ...(m.toolResults
        ? {
            toolResults: m.toolResults.map((r): ToolResult => ({
              ...r,
              text: maskResultText(r.text, r.isError, seq, config)
            }))
          }
        : {})
    }
  }
  return {
    role: 'assistant',
    text: cutWithSeq(m.text, config.assistantTextCapChars, seq),
    toolUses: m.toolUses.map((u): ToolUse => ({
      tool_use_id: u.tool_use_id,
      tool: u.tool,
      input: capInput(u.input, config.inputCapChars) as Record<string, unknown>
    }))
  }
}

/** One-line-per-block plain rendering, used for ledger prompts and `show`. */
export function renderMessage(m: Message, seq: number): string {
  const lines: string[] = []
  if (m.text) lines.push(`#${seq} ${m.role}: ${m.text}`)
  for (const u of m.toolUses) lines.push(`#${seq} call ${u.tool} ${JSON.stringify(u.input)}`)
  for (const r of m.toolResults ?? []) lines.push(`#${seq} result${r.isError ? ' (error)' : ''}: ${r.text}`)
  return lines.join('\n')
}
