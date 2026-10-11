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

function maskResultText(text: string, isError: boolean, seq: number, config: Config): string {
  const keep = isError ? config.errorResultChars : config.smallResultChars
  return text.length <= keep ? text : stub(text.length, seq)
}

/**
 * The masked form of a raw message: prose stays verbatim, tool calls keep
 * their name and shortened arguments, large results become archive pointers.
 * Tool calls are never dropped, so every claim of work keeps its evidence.
 */
export function maskMessage(m: Message, seq: number, config: Config): Message {
  if (m.role === 'user') {
    return {
      role: 'user',
      text: cut(m.text, config.userTextCapChars),
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
    text: m.text,
    toolUses: m.toolUses.map((u): ToolUse => ({
      tool_use_id: u.tool_use_id,
      tool: u.tool,
      input: capInput(u.input, config.inputCapChars) as Record<string, unknown>,
      ...(u.text !== undefined ? { text: maskResultText(u.text, u.isError === true, seq, config) } : {}),
      ...(u.isError ? { isError: true as const } : {})
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
