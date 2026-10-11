import { CLAUDE_CODE_SYSTEM_PROMPT, createAnthropicClient } from './anthropic.js'
import { estimateTokens, shareChars, type Config } from './config.js'
import { maskMessage, renderMessage } from './mask.js'
import type { ArchivedMessage } from './types.js'

const LEDGER_SYSTEM_PROMPT = `You maintain the state ledger of a long Claude Code session whose older turns are being moved out of the live context into an archive.

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

function renderSpan(messages: ArchivedMessage[], config: Config): string[] {
  const chunks: string[] = []
  let current = ''
  for (const m of messages) {
    const line = renderMessage(maskMessage(m, m.seq, config), m.seq)
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

export type LedgerUpdate = { ledger: string; requests: number }

/** How many model requests folding `span` into a ledger would take. */
export function ledgerRequests(span: ArchivedMessage[], config: Config): number {
  return renderSpan(span, config).length
}

/**
 * Fold newly evicted history into the ledger, chunk by chunk. Returns the
 * previous ledger unchanged when there is nothing to fold or no auth.
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
      model: config.ledgerModel,
      max_tokens: Math.max(2_000, estimateTokens(maxChars) * 2),
      system: [
        { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT },
        { type: 'text', text: LEDGER_SYSTEM_PROMPT }
      ],
      messages: [
        {
          role: 'user',
          content: [
            `Current ledger:\n${ledger || '(empty: this is the first eviction)'}`,
            focus ? `The user asked this compaction to keep or stress: ${focus}` : '',
            `Newly archived history (#seq prefixes are archive seq numbers; "[strata elided …]" marks results kept only in the archive):\n${chunk}`,
            `Write the updated ledger. Stay under ${maxChars.toLocaleString('en-US')} characters.`
          ]
            .filter(Boolean)
            .join('\n\n')
        }
      ]
    })
    const text = response.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()
    if (!text) throw new Error(`ledger model returned no text (stop_reason ${response.stop_reason})`)
    // The size limit is asked for in the prompt and enforced here.
    ledger = text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…[ledger cut to its budget]`
  }
  return { ledger, requests: chunks.length }
}
