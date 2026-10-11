import { describe, expect, mock, test } from 'claude-code/testing'
import type { Register } from 'claude-code'

const BUILT_IN = { messages: [{ role: 'user' as const, text: 'built-in summary', toolUses: [] }] }
const TRIGGER = '1000'
const usageAt = (tokens: number) => () => ({ value: { startedAt: 0, context: { tokens, window: 1_000_000, percent: 1 }, rateLimits: [] } })
const turn = (agentId?: string) => ({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' as const, ...(agentId ? { agentId } : {}) })

const ANSWERED = 'stand-in answered the compaction'

/**
 * Stands in for strata: a different plugin, so the compaction must reach its
 * hook. Inline plugins run in their own environment; it reports through
 * $.ui.log, which the test's own hook beneath records.
 */
const standIn: Register = on => {
  on('session.compact', ($, e) => {
    // A literal: the inline plugin is evaluated on its own, without this file's constants.
    $.ui.log(`stand-in answered the compaction (${e.trigger})`)
    return { messages: [{ role: 'user', text: 'compacted by stand-in', toolUses: [] }] }
  })
}

function recordLogs(on: Parameters<Register>[0]): string[] {
  const logs: string[] = []
  on('ui.log', (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  return logs
}

describe('strata-trigger', () => {
  test('past the trigger, compacts through the other plugin\'s hook', { plugins: [{ name: 'strata', register: standIn }] }, async ($, on) => {
    const logs = recordLogs(on)
    const clock = mock.clock(on)
    mock.env(on, { STRATA_TRIGGER_TOKENS: TRIGGER })
    on('session.usage', usageAt(5000))
    on('session.compact', () => BUILT_IN)
    on('turn.complete', () => ({ text: 'done' }))
    await $.turn.complete(turn())
    await clock.advance(0)
    expect(logs.filter(l => l.startsWith(ANSWERED))).toHaveLength(1)
  })

  test('below the trigger, or on a subagent turn: nothing', { plugins: [{ name: 'strata', register: standIn }] }, async ($, on) => {
    const logs = recordLogs(on)
    const clock = mock.clock(on)
    mock.env(on, { STRATA_TRIGGER_TOKENS: TRIGGER })
    on('session.usage', usageAt(500))
    on('session.compact', () => BUILT_IN)
    on('turn.complete', () => ({ text: 'done' }))
    await $.turn.complete(turn())
    await $.turn.complete(turn('sub'))
    await clock.advance(0)
    expect(logs.filter(l => l.startsWith(ANSWERED))).toHaveLength(0)
  })

  test('STRATA_AUTO=0 turns it off', { plugins: [{ name: 'strata', register: standIn }] }, async ($, on) => {
    const logs = recordLogs(on)
    const clock = mock.clock(on)
    mock.env(on, { STRATA_TRIGGER_TOKENS: TRIGGER, STRATA_AUTO: '0' })
    on('session.usage', usageAt(5000))
    on('session.compact', () => BUILT_IN)
    on('turn.complete', () => ({ text: 'done' }))
    await $.turn.complete(turn())
    await clock.advance(0)
    expect(logs.filter(l => l.startsWith(ANSWERED))).toHaveLength(0)
  })
})
