import { readFileSync } from 'fs'
import type { Message, ToolUse } from './types.js'

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }
type Row = {
  type?: string
  isSidechain?: boolean
  isMeta?: boolean
  isCompactSummary?: boolean
  message?: { role?: string; content?: string | Block[] }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(c => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('')
  }
  return ''
}

/**
 * Read a Claude Code transcript (~/.claude/projects/<project>/<session>.jsonl)
 * as the raw main-thread history, in the engine's SessionMessage shape: one
 * message per transcript row, as the engine hands a `session.compact` hook one
 * per content block, so a streamed response stays split across interleaved
 * tool results exactly as strata will see it live. Earlier compaction
 * summaries are skipped so replay sees what really happened.
 */
export function readTranscript(path: string): Message[] {
  const messages: Message[] = []
  const toolUses = new Map<string, ToolUse>()
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    let row: Row
    try {
      row = JSON.parse(line) as Row
    } catch {
      continue
    }
    if (row.isSidechain || row.isMeta || row.isCompactSummary) continue
    if ((row.type !== 'user' && row.type !== 'assistant') || !row.message) continue
    const content = row.message.content
    const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content ?? []

    if (row.type === 'assistant') {
      const target: Message = { role: 'assistant', text: '', toolUses: [] }
      messages.push(target)
      for (const b of blocks) {
        if (b.type === 'text' && b.text) target.text = target.text ? `${target.text}\n${b.text}` : b.text
        if (b.type === 'tool_use' && b.id) {
          const use: ToolUse = { tool_use_id: b.id, tool: b.name ?? 'unknown', input: (b.input as Record<string, unknown>) ?? {} }
          target.toolUses.push(use)
          toolUses.set(b.id, use)
        }
      }
      continue
    }

    const text = blocks.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')
    const results = blocks
      .filter(b => b.type === 'tool_result' && b.tool_use_id)
      .map(b => ({ tool_use_id: b.tool_use_id as string, text: resultText(b.content), isError: b.is_error === true }))
    for (const r of results) {
      const use = toolUses.get(r.tool_use_id)
      if (use) {
        use.text = r.text
        if (r.isError) use.isError = true
      }
    }
    if (!text && results.length === 0) continue
    messages.push({ role: 'user', text, toolUses: [], ...(results.length ? { toolResults: results } : {}) })
  }
  return messages
}
