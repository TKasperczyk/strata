import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from './anthropic.js'
import { estimateTokens, shareChars, type Config } from './config.js'
import { maskMessage, renderMessage, safeSlicePrefix } from './mask.js'
import type { ArchivedMessage } from './types.js'

export const LEDGER_SYSTEM_PROMPT = `You maintain the state ledger of a long Claude Code session whose older turns are being moved out of the live context into an archive.

The ledger is a STATE document, not a history. Rewrite it so it reflects the session as of the newest history you are given. Use exactly these sections:

## Goal
## Constraints and preferences   (what the user asked for or ruled out, in their terms)
## Decisions                     (what was chosen and WHY; mark replaced ones "SUPERSEDED by #seq")
## Dead ends                     (approaches tried that failed, and the failure signal)
## Current state                 (what exists now: files, branches, services, test status)
## Open items

Rules:
- Every bullet cites the archive seq numbers it rests on, like (#412) or (#400-415).
- Keep facts exact: names, paths, commands, error strings, numbers. Never round or paraphrase them.
- Do not invent anything the history does not show. If something is unclear, say so.
- Drop bullets that are no longer true, but keep decisions and dead ends: those prevent repeated mistakes.
- Output only the ledger markdown, nothing else.`

const STANDALONE_MODEL_ALIASES: Record<string, string> = {
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
  opus: 'claude-opus-4-6'
}

/** Resolve short model aliases (`sonnet`, `haiku`, `opus`) for direct SDK calls. */
export function resolveStandaloneModel(model: string): string {
  return STANDALONE_MODEL_ALIASES[model.trim().toLowerCase()] ?? model
}

/**
 * Richer masking caps used when rendering evicted history for the ledger LLM:
 * `ledgerChunkChars` is 400k, so the ledger model should see full commands,
 * error strings, and failure signals rather than tiny middle-layer stubs.
 */
export function ledgerMaskConfig(config: Config): Config {
  return {
    ...config,
    inputCapChars: Math.max(config.inputCapChars, 1_500),
    smallResultChars: Math.max(config.smallResultChars, 2_000),
    errorResultChars: Math.max(config.errorResultChars, 6_000),
    userTextCapChars: Math.max(config.userTextCapChars, 12_000),
    assistantTextCapChars: Math.max(config.assistantTextCapChars, 8_000)
  }
}

export function renderSpan(messages: ArchivedMessage[], config: Config): string[] {
  const maskCfg = ledgerMaskConfig(config)
  const maxChunk = Math.max(1, config.ledgerChunkChars)
  const chunks: string[] = []
  let current = ''
  const pushPiece = (piece: string) => {
    if (!piece) return
    const bounded =
      piece.length + 1 <= maxChunk
        ? piece
        : maxChunk > 18
          ? `${safeSlicePrefix(piece, maxChunk - 17)}…[chunk capped]`
          : safeSlicePrefix(piece, Math.max(1, maxChunk - 1))
    if (current && current.length + bounded.length + 1 > maxChunk) {
      chunks.push(current)
      current = ''
    }
    current += `${bounded}\n`
  }
  for (const m of messages) {
    const rendered = renderMessage(maskMessage(m, m.seq, maskCfg), m.seq)
    if (!rendered) continue
    if (rendered.length + 1 <= maxChunk) {
      pushPiece(rendered)
    } else {
      // Split multi-block messages across chunks so no single chunk exceeds ledgerChunkChars.
      for (const line of rendered.split('\n')) pushPiece(line)
    }
  }
  if (current) chunks.push(current)
  return chunks
}

export function buildLedgerPrompt(previous: string, chunk: string, maxChars: number, focus?: string): string {
  return [
    `Current ledger:\n${previous || '(empty: this is the first eviction)'}`,
    focus ? `The user asked this compaction to keep or stress: ${focus}` : '',
    `Newly archived history (#seq prefixes are archive seq numbers; "[strata elided …]" marks results kept only in the archive):\n${chunk}`,
    `Write the updated ledger. Stay under ${maxChars.toLocaleString('en-US')} characters.`
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Maximum output tokens permitted by Claude Code's `$.model.complete`
 * (`ModelCompleteRequest.maxTokens`, capped at 64,000 for non-streaming calls).
 */
export const MAX_LEDGER_TOKENS = 64_000

export function ledgerMaxTokens(maxChars: number): number {
  if (!Number.isFinite(maxChars)) return maxChars === Infinity ? MAX_LEDGER_TOKENS : 2_000
  return Math.min(MAX_LEDGER_TOKENS, Math.max(2_000, estimateTokens(maxChars) * 2))
}

type Section = {
  heading: string
  priority: number
  keepNewest: boolean
  lines: string[]
  trimmed: boolean
}

function sectionMeta(heading: string): { priority: number; keepNewest: boolean } {
  const lower = heading.toLowerCase()
  if (lower.includes('current state')) return { priority: 6, keepNewest: true }
  if (lower.includes('open item')) return { priority: 5, keepNewest: true }
  if (lower.includes('goal')) return { priority: 4, keepNewest: false }
  if (lower.includes('constraint') || lower.includes('preference')) return { priority: 3, keepNewest: false }
  if (lower.includes('decision')) return { priority: 2, keepNewest: true }
  if (lower.includes('dead end')) return { priority: 1, keepNewest: true }
  return { priority: 0, keepNewest: true }
}

function renderSections(preamble: string, sections: Section[]): string {
  const blocks: string[] = []
  if (preamble) blocks.push(preamble)
  for (const s of sections) {
    const body: string[] = []
    if (s.trimmed && s.keepNewest) body.push('…[older items trimmed]')
    body.push(...s.lines)
    if (s.trimmed && !s.keepNewest) body.push('…[trimmed]')
    blocks.push(body.length ? `${s.heading}\n${body.join('\n')}` : s.heading)
  }
  return blocks.join('\n\n')
}

/**
 * Enforce `maxChars` on a ledger without chopping off `## Current state` and
 * `## Open items` first. Trims lower-priority historical sections (`Dead ends`,
 * `Decisions`, `Constraints`, `Goal`) before touching `Open items` or
 * `Current state`, and guarantees `result.length <= maxChars`.
 */
export function trimLedger(ledger: string, maxChars: number, note = '\n…[ledger cut to its budget]'): string {
  if (maxChars <= 0) return ''
  if (ledger.length <= maxChars) return ledger

  const rawLines = ledger.split('\n')
  const preambleLines: string[] = []
  const sections: Section[] = []
  for (const line of rawLines) {
    if (line.startsWith('## ')) {
      const meta = sectionMeta(line)
      sections.push({ heading: line, ...meta, lines: [], trimmed: false })
    } else if (sections.length === 0) {
      preambleLines.push(line)
    } else if (line.trim()) {
      sections[sections.length - 1].lines.push(line)
    }
  }

  if (sections.length === 0) {
    if (maxChars <= note.length) return safeSlicePrefix(ledger, maxChars)
    return `${safeSlicePrefix(ledger, maxChars - note.length).trimEnd()}${note}`
  }

  let preamble = preambleLines.join('\n').trim()
  let current = renderSections(preamble, sections)

  // Drop preamble first if present.
  if (current.length > maxChars && preamble) {
    preamble = ''
    current = renderSections(preamble, sections)
  }

  // Trim lines from lowest-priority sections first while protecting Current state
  // and Open items. Every step strictly decreases remaining sections, lines,
  // trim markers, or line length, guaranteeing termination without wiping out
  // surviving high-priority sections when a short bullet is removed.
  while (current.length > maxChars && sections.length > 0) {
    const ordered = [...sections].sort((a, b) => a.priority - b.priority)
    const empty = ordered.find(s => s.lines.length === 0)
    if (empty) {
      sections.splice(sections.indexOf(empty), 1)
      current = renderSections(preamble, sections)
      continue
    }
    const s = ordered[0]
    if (s.lines.length > 1) {
      if (s.keepNewest) s.lines.shift()
      else s.lines.pop()
      s.trimmed = true
    } else {
      const overflow = current.length - maxChars
      const markerDelta = s.trimmed ? 0 : (s.keepNewest ? '…[older items trimmed]\n'.length : '\n…[trimmed]'.length)
      const target = s.lines[0].length - overflow - markerDelta - 1
      if (target >= 24 && target < s.lines[0].length) {
        s.lines[0] = `${safeSlicePrefix(s.lines[0], target).trimEnd()}…`
        s.trimmed = true
      } else if (sections.length > 1) {
        sections.splice(sections.indexOf(s), 1)
      } else if (s.trimmed) {
        // Reclaim trim-marker room on the final surviving section before truncating its text.
        s.trimmed = false
      } else {
        const room = maxChars - s.heading.length - 2
        if (room >= 1 && room < s.lines[0].length) {
          s.lines[0] = `${safeSlicePrefix(s.lines[0], room).trimEnd()}…`
        } else {
          break
        }
      }
    }
    current = renderSections(preamble, sections)
  }

  if (current.length <= maxChars) return current
  if (maxChars <= note.length) return safeSlicePrefix(current, maxChars)
  return `${safeSlicePrefix(current, maxChars - note.length).trimEnd()}${note}`
}

export type LedgerUpdate = { ledger: string; requests: number }

/** How many model requests folding `span` into a ledger would take. */
export function ledgerRequests(span: ArchivedMessage[], config: Config): number {
  return renderSpan(span, config).length
}

/**
 * Fold newly evicted history into the ledger, chunk by chunk, via the
 * standalone Anthropic client (used for offline CLI / replay). Live Claude Code
 * sessions call `$.model.complete` in the plugin instead.
 */
export async function updateLedger(
  previous: string,
  span: ArchivedMessage[],
  config: Config,
  focus?: string
): Promise<LedgerUpdate> {
  const chunks = renderSpan(span, config)
  if (chunks.length === 0) return { ledger: previous, requests: 0 }
  const client = await createAnthropicClient()
  if (!client) throw new Error('No authentication available for the ledger model')

  const maxChars = shareChars(config, 'ledger')
  let ledger = previous
  for (const chunk of chunks) {
    const response = await client.messages.create({
      model: resolveStandaloneModel(config.ledgerModel),
      max_tokens: ledgerMaxTokens(maxChars),
      system: [
        { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
        { type: 'text', text: LEDGER_SYSTEM_PROMPT }
      ],
      messages: [
        {
          role: 'user',
          content: buildLedgerPrompt(ledger, chunk, maxChars, focus)
        }
      ]
    })
    const text = response.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()
    if (!text) throw new Error(`ledger model returned no text (stop_reason ${response.stop_reason})`)
    ledger = trimLedger(text, maxChars)
  }
  return { ledger, requests: chunks.length }
}
