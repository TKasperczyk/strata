import { describe, expect, mock, test } from 'claude-code/testing'
import type { Register } from 'claude-code'

const BUILT_IN = { messages: [{ role: 'user' as const, text: 'built-in summary', toolUses: [] }] }
const TRIGGER = '1000'
const usageAt = (tokens: number) => () => ({ value: { startedAt: 0, context: { tokens, window: 1_000_000, percent: 1 }, rateLimits: [] } })
const turn = (agentId?: string) => ({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' as const, ...(agentId ? { agentId } : {}) })
const statusCmd = { command: 'strata-status', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }

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

  test('/strata-status reports thresholds, last turn reading, and outcome; resets on session.start', { plugins: [{ name: 'strata', register: standIn }] }, async ($, on) => {
    recordLogs(on)
    const clock = mock.clock(on)
    mock.env(on, { STRATA_TRIGGER_TOKENS: TRIGGER })
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('session.usage', usageAt(5000))
    on('session.compact', () => BUILT_IN)
    on('turn.complete', () => ({ text: 'done' }))

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const initial = await $.command.run(statusCmd)
    expect(initial.text).toContain('strata-trigger: on, trigger 1,000 tokens')
    expect(initial.text).toContain('last turn saw no reading tokens')
    expect(initial.text).toContain('last outcome: no compaction started yet')

    await $.turn.complete(turn())
    await clock.advance(0)
    const after = await $.command.run(statusCmd)
    expect(after.text).toContain('last turn saw 5,000 tokens')
    expect(after.text).toContain('no compaction in flight')
    expect(after.text).toContain('last outcome: compacted from 5,000 tokens')

    // A new session resets module-level state cleanly.
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const reset = await $.command.run(statusCmd)
    expect(reset.text).toContain('last turn saw no reading tokens')
    expect(reset.text).toContain('last outcome: no compaction started yet')
  })

  test('session.end (/clear) resets module-level status and ignores late settlement from prior session', async ($, on) => {
    recordLogs(on)
    const clock = mock.clock(on)
    mock.env(on, { STRATA_TRIGGER_TOKENS: TRIGGER })
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
    on('session.usage', usageAt(5000))
    let resolvePrior: ((v: typeof BUILT_IN) => void) | undefined
    on('session.compact', () => new Promise<typeof BUILT_IN>(resolve => { resolvePrior = resolve }))
    on('turn.complete', () => ({ text: 'done' }))

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await clock.advance(0)
    expect((await $.command.run(statusCmd)).text).toContain('compaction in flight since')

    // /clear fires session.end without session.start.
    await $.session.end({ reason: 'clear', sessionId: 'old-sess', resume: { id: 'old-sess' } })
    const cleared = await $.command.run(statusCmd)
    expect(cleared.text).toContain('no compaction in flight')
    expect(cleared.text).toContain('last turn saw no reading tokens')
    expect(cleared.text).toContain('last outcome: no compaction started yet')

    // Late settlement from the cleared session must NOT overwrite the fresh session's outcome.
    resolvePrior?.(BUILT_IN)
    await Promise.resolve()
    await Promise.resolve()
    expect((await $.command.run(statusCmd)).text).toContain('last outcome: no compaction started yet')
  })

  test('surfaces compaction refusals, records them in /strata-status, and retries on the next turn', async ($, on) => {
    const logs = recordLogs(on)
    const clock = mock.clock(on)
    mock.env(on, { STRATA_TRIGGER_TOKENS: TRIGGER })
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('session.usage', usageAt(5000))
    let attempts = 0
    on('session.compact', () => {
      attempts++
      if (attempts === 1) throw new Error('turn still running')
      return BUILT_IN
    })
    on('turn.complete', () => ({ text: 'done' }))

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await clock.advance(0)
    expect(attempts).toBe(1)
    expect(logs.some(l => l.includes('compaction refused, will retry after the next turn:'))).toBe(true)
    const refusedStatus = await $.command.run(statusCmd)
    expect(refusedStatus.text).toContain('last outcome: refused:')
    expect(refusedStatus.text).toContain('no compaction in flight')

    // Next turn retries and succeeds.
    await $.turn.complete(turn())
    await clock.advance(0)
    expect(attempts).toBe(2)
    const okStatus = await $.command.run(statusCmd)
    expect(okStatus.text).toContain('last outcome: compacted from 5,000 tokens')
  })

  test('recovers from a stuck compaction and ignores a late settlement from the abandoned attempt', async ($, on) => {
    const logs = recordLogs(on)
    const clock = mock.clock(on)
    mock.env(on, { STRATA_TRIGGER_TOKENS: TRIGGER })
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('session.usage', usageAt(5000))
    const resolvers: Array<{ resolve: (v: typeof BUILT_IN) => void; reject: (e: Error) => void }> = []
    on('session.compact', () => new Promise<typeof BUILT_IN>((resolve, reject) => {
      resolvers.push({ resolve, reject })
    }))
    on('turn.complete', () => ({ text: 'done' }))

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

    // Turn 1 starts attempt #1, which hangs.
    await $.turn.complete(turn())
    await clock.advance(0)
    expect(resolvers).toHaveLength(1)

    // Turn 2 before 10 minutes: must NOT start a second compaction.
    await clock.advance(5 * 60 * 1000)
    await $.turn.complete(turn())
    await clock.advance(0)
    expect(resolvers).toHaveLength(1)

    // Turn 3 past 10 minutes: abandons attempt #1 and starts attempt #2.
    await clock.advance(6 * 60 * 1000)
    await $.turn.complete(turn())
    await clock.advance(0)
    expect(resolvers).toHaveLength(2)
    expect(logs.some(l => l.includes('never settled; triggering again'))).toBe(true)

    // Attempt #1 now rejects late: MUST NOT clear attempt #2's compactingSince or overwrite lastOutcome!
    resolvers[0]!.reject(new Error('late stale failure'))
    await Promise.resolve()
    await Promise.resolve()
    const midStatus = await $.command.run(statusCmd)
    expect(midStatus.text).toContain('compaction in flight since')
    expect(midStatus.text).not.toContain('late stale failure')

    // Turn 4 while attempt #2 is still in flight: must NOT start attempt #3!
    await $.turn.complete(turn())
    await clock.advance(0)
    expect(resolvers).toHaveLength(2)

    // Attempt #2 resolves cleanly: clears in-flight state and updates outcome.
    resolvers[1]!.resolve(BUILT_IN)
    await Promise.resolve()
    await Promise.resolve()
    const doneStatus = await $.command.run(statusCmd)
    expect(doneStatus.text).toContain('no compaction in flight')
    expect(doneStatus.text).toContain('last outcome: compacted from 5,000 tokens')
  })

  test('clears stuck state without triggering when tokens dropped below trigger', async ($, on) => {
    const logs = recordLogs(on)
    const clock = mock.clock(on)
    mock.env(on, { STRATA_TRIGGER_TOKENS: TRIGGER })
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    let tokens = 5000
    on('session.usage', () => ({ value: { startedAt: 0, context: { tokens, window: 1_000_000, percent: 1 }, rateLimits: [] } }))
    let compactCalls = 0
    on('session.compact', () => {
      compactCalls++
      return new Promise<typeof BUILT_IN>(() => undefined)
    })
    on('turn.complete', () => ({ text: 'done' }))

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await clock.advance(0)
    expect(compactCalls).toBe(1)

    // 11 minutes later, context is now below trigger: clears stuck state without triggering.
    tokens = 200
    await clock.advance(11 * 60 * 1000)
    await $.turn.complete(turn())
    await clock.advance(0)
    expect(compactCalls).toBe(1)
    expect(logs.some(l => l.includes('clearing stuck state'))).toBe(true)
    const st = await $.command.run(statusCmd)
    expect(st.text).toContain('no compaction in flight')
  })
})
