import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { buildLedgerPrompt, ledgerRequests, renderSpan, resolveStandaloneModel, trimLedger } from '../src/ledger.js'
import type { ArchivedMessage } from '../src/types.js'

describe('ledger rendering and helpers', () => {
  const config = loadConfig({ budgetTokens: 20_000 })

  it('renderSpan preserves long Bash commands, normal results up to 2k, and error strings up to 6k', () => {
    const longCmd = `npm run test -- --grep "${'auth-flow-'.repeat(40)}"`
    const longNormal = `NORMAL_START_${'n'.repeat(1_500)}_NORMAL_END`
    const longError = `ERR_HEAD_${'e'.repeat(4_500)}_ROOT_CAUSE_ECONNREFUSED_5432`
    const hugeError = `HUGE_TOP_${'x'.repeat(9_000)}_HUGE_BOTTOM_PANIC`
    const span: ArchivedMessage[] = [
      { seq: 0, role: 'user', text: 'fix the DB tests', toolUses: [] },
      { seq: 1, role: 'assistant', text: 'Running tests', toolUses: [{ tool_use_id: 'b1', tool: 'Bash', input: { command: longCmd } }] },
      { seq: 2, role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'b1', text: longNormal, isError: false }] },
      { seq: 3, role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'b2', text: longError, isError: true }] },
      { seq: 4, role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'b3', text: hugeError, isError: true }] }
    ]
    const chunks = renderSpan(span, config)
    expect(chunks).toHaveLength(1)
    const rendered = chunks[0]
    expect(rendered).toContain(JSON.stringify(longCmd))
    expect(rendered).toContain('NORMAL_START_')
    expect(rendered).toContain('_NORMAL_END')
    expect(rendered).toContain('ROOT_CAUSE_ECONNREFUSED_5432')
    // Even an error > 6k keeps head + tail excerpts instead of an opaque stub!
    expect(rendered).toContain('HUGE_TOP_')
    expect(rendered).toContain('_HUGE_BOTTOM_PANIC')
  })

  it('splits large spans into multiple chunks according to ledgerChunkChars', () => {
    const smallChunkCfg = loadConfig({ ledgerChunkChars: 300 })
    const span: ArchivedMessage[] = Array.from({ length: 10 }, (_, seq) => ({
      seq,
      role: 'user',
      text: `message ${seq} ${'a'.repeat(100)}`,
      toolUses: []
    }))
    expect(ledgerRequests(span, smallChunkCfg)).toBeGreaterThan(2)

    // Single message with many large results must still split cleanly under ledgerChunkChars.
    const multiResultMsg: ArchivedMessage = {
      seq: 0,
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: Array.from({ length: 10 }, (_, i) => ({ tool_use_id: `r${i}`, text: 'E'.repeat(5_000), isError: true }))
    }
    const splitChunks = renderSpan([multiResultMsg], loadConfig({ ledgerChunkChars: 10_000 }))
    expect(splitChunks.length).toBeGreaterThanOrEqual(5)
    for (const c of splitChunks) expect(c.length).toBeLessThanOrEqual(10_000)
  })

  it('trimLedger preserves Current state and Open items when over budget', () => {
    const full = [
      '## Goal',
      '- Migrate session storage to SQLite (#0)',
      '',
      '## Constraints and preferences',
      '- Zero external daemon dependencies (#1)',
      '- Keep backward compatibility with JSONL archives (#2)',
      '',
      '## Decisions',
      '- Use better-sqlite3 for sync reads (#10)',
      '- Keep WAL mode enabled for concurrent readers (#15)',
      '- Store blobs under media/ on disk instead of inside SQLite (#22)',
      '- Use schema v2 with composite index on (session_id, seq) (#30)',
      '',
      '## Dead ends',
      '- Tried sql.js WASM build; failed with OOM on 120MB archives (#8)',
      '- Tried storing base64 images inline in JSONL; tripled read time (#12)',
      '- Tried flock via child process; deadlocked on macOS (#19)',
      '- Tried single-file lock without token check; raced under recovery (#25)',
      '',
      '## Current state',
      '- Branch feat/sqlite passes 42/42 unit tests (#40)',
      '- Migration script verified on 3 production transcripts (#41)',
      '',
      '## Open items',
      '- Add rollback test for interrupted migration (#42)',
      '- Update README with new env vars (#43)'
    ].join('\n')

    const maxChars = 550
    const trimmed = trimLedger(full, maxChars)
    expect(trimmed.length).toBeLessThanOrEqual(maxChars)
    // Critical trailing sections survive intact!
    expect(trimmed).toContain('## Current state')
    expect(trimmed).toContain('passes 42/42 unit tests (#40)')
    expect(trimmed).toContain('## Open items')
    expect(trimmed).toContain('Add rollback test for interrupted migration (#42)')
    // Lower-priority historical dead ends were trimmed first.
    expect(trimmed).not.toContain('Tried sql.js WASM build')
  })

  it('trimLedger strictly enforces maxChars even under extreme squeezes and plain text', () => {
    const plain = 'line '.repeat(500)
    expect(trimLedger(plain, 120).length).toBeLessThanOrEqual(120)
    expect(trimLedger(plain, 10).length).toBeLessThanOrEqual(10)
    expect(trimLedger(plain, 0)).toBe('')

    const structured = '## Dead ends\n- a\n## Current state\n- IMPORTANT_STATE\n## Open items\n- IMPORTANT_TODO'
    const tiny = trimLedger(structured, 80)
    expect(tiny.length).toBeLessThanOrEqual(80)
    expect(tiny).toContain('IMPORTANT_STATE')

    // Dropping a short bullet (shorter than the trim marker) in Current state must never wipe out the section!
    const shortBullet = [
      '## Current state',
      '- ok',
      '',
      '- Branch feat/sqlite passes 42/42 unit tests (#40)',
      '- Migration script verified on 3 production transcripts (#41)'
    ].join('\n')
    const kept = trimLedger(shortBullet, 110)
    expect(kept.length).toBeLessThanOrEqual(110)
    expect(kept).toContain('## Current state')
    expect(kept).toContain('Migration script verified')

    // Never splits UTF-16 surrogate pairs (emoji) when truncating.
    const emojiLedger = `## Current state\n- ${'🚀'.repeat(80)}`
    const cutEmoji = trimLedger(emojiLedger, 71)
    expect(cutEmoji.length).toBeLessThanOrEqual(71)
    expect(cutEmoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('resolves standalone model aliases and builds prompts with focus instructions', () => {
    expect(resolveStandaloneModel('sonnet')).toMatch(/^claude-sonnet-/)
    expect(resolveStandaloneModel('haiku')).toMatch(/^claude-haiku-/)
    expect(resolveStandaloneModel('opus')).toMatch(/^claude-opus-/)
    expect(resolveStandaloneModel('claude-custom-1')).toBe('claude-custom-1')

    const prompt = buildLedgerPrompt('## Goal\n- ship', '#1 user: hi', 5000, 'keep migration risks')
    expect(prompt).toContain('Current ledger:\n## Goal\n- ship')
    expect(prompt).toContain('keep migration risks')
    expect(prompt).toContain('#1 user: hi')
    expect(prompt).toContain('5,000')
  })
})
