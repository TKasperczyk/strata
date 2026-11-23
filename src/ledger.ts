import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from './anthropic.js'
import { estimateTokens, shareChars, type Config } from './config.js'
import { maskMessage, renderMessage } from './mask.js'
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
  const chunks: string[] = []
  let current = ''
  for (const m of messages) {
    const line = renderMessage(maskMessage(m, m.seq, maskCfg), m.seq)
    if (!line) continue
    if (current && current.length + line.length > config.ledgerChunkChars) {
      chunks.push(current)
      current = ''
    }
    current += `${line}\n`
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

export function ledgerMaxTokens(maxChars: number): number {
  return Math.max(2_000, estimateTokens(maxChars) * 2)
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
    } else {
      sections[sections.length - 1].lines.push(line)
    }
  }
  for (const s of sections) {
    while (s.lines.length && !s.lines[0].trim()) s.lines.shift()
    while (s.lines.length && !s.lines[s.lines.length - 1].trim()) s.lines.pop()
  }

  if (sections.length === 0) {
    if (maxChars <= note.length) return ledger.slice(0, maxChars)
    return `${ledger.slice(0, maxChars - note.length).trimEnd()}${note}`
  }

  let preamble = preambleLines.join('\n').trim()
  let current = renderSections(preamble, sections)

  // Drop preamble first if present.
  if (current.length > maxChars && preamble) {
    preamble = ''
    current = renderSections(preamble, sections)
  }

  // Pass 1: trim lines from lowest-priority sections first, keeping at least
  // a short tail/head in each section before collapsing it further.
  while (current.length > maxChars && sections.length > 0) {
    const prevLen = current.length
    const ordered = [...sections].sort((a, b) => a.priority - b.priority)
    const withLines = ordered.find(s => s.lines.length > 0)
    if (withLines) {
      if (withLines.lines.length > 1) {
        if (withLines.keepNewest) withLines.lines.shift()
        else withLines.lines.pop()
        withLines.trimmed = true
      } else {
        const overflow = current.length - maxChars
        const line = withLines.lines[0]
        const target = line.length - overflow - 16
        if (target >= 40) {
          withLines.lines[0] = `${line.slice(0, target)}…`
          withLines.trimmed = true
        } else {
          withLines.lines.length = 0
          withLines.trimmed = true
        }
      }
    } else {
      // Every section is down to heading + marker; drop lowest-priority section.
      const victim = ordered[0]
      const idx = sections.indexOf(victim)
      if (idx >= 0) sections.splice(idx, 1)
    }
    current = renderSections(preamble, sections)
    if (current.length >= prevLen) {
      // Safety valve: drop lowest-priority section to guarantee strict progress.
      const victim = [...sections].sort((a, b) => a.priority - b.priority)[0]
      if (!victim) break
      sections.splice(sections.indexOf(victim), 1)
      current = renderSections(preamble, sections)
    }
  }

  if (current.length <= maxChars) return current
  if (maxChars <= note.length) return current.slice(0, maxChars)
  return `${current.slice(0, maxChars - note.length).trimEnd()}${note}`
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
