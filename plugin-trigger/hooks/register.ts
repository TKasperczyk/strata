import type { EngineInterface, Register } from 'claude-code'

// A plugin's own $.session.compact() runs every hook but that plugin's, so the
// plugin that answers compactions (strata) cannot also start them: this one does.
// Its thresholds mirror strata's (STRATA_TRIGGER_TOKENS, STRATA_AUTO).
const DEFAULT_TRIGGER_TOKENS = 400_000
/** A compaction that has not settled by now is presumed lost, so triggering can resume. */
const STUCK_AFTER_MS = 10 * 60 * 1000
const STATUS_COMMAND = 'strata-status'

/** What the last turns saw and did, for /strata-status; module state, reset by a reload. */
const status = {
  lastTokens: undefined as number | undefined,
  lastCheckedAt: undefined as number | undefined,
  compactingSince: undefined as number | undefined,
  lastOutcome: 'no compaction started yet'
}

async function triggerTokens($: EngineInterface): Promise<number> {
  const configured = Number.parseInt((await $.env.get('STRATA_TRIGGER_TOKENS')) ?? '', 10)
  return configured > 0 ? configured : DEFAULT_TRIGGER_TOKENS
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: STATUS_COMMAND, description: 'Shows what strata-trigger last saw and did' })
    return next(e)
  })

  on('command.run', { command: STATUS_COMMAND }, async $ => {
    const now = await $.clock.now()
    const ago = (at?: number) => (at === undefined ? 'never' : `${Math.round((now - at) / 1000)}s ago`)
    const auto = (await $.env.get('STRATA_AUTO')) !== '0'
    return {
      text: [
        `strata-trigger: ${auto ? 'on' : 'off (STRATA_AUTO=0)'}, trigger ${(await triggerTokens($)).toLocaleString('en-US')} tokens`,
        `last turn saw ${status.lastTokens?.toLocaleString('en-US') ?? 'no reading'} tokens (${ago(status.lastCheckedAt)})`,
        status.compactingSince === undefined ? 'no compaction in flight' : `compaction in flight since ${ago(status.compactingSince)}`,
        `last outcome: ${status.lastOutcome}`
      ].join('\n')
    }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.isAborted) return result
    if ((await $.env.get('STRATA_AUTO')) === '0') return result
    const now = await $.clock.now()
    const tokens = (await $.session.usage()).context.tokens
    status.lastTokens = tokens
    status.lastCheckedAt = now
    if (status.compactingSince !== undefined) {
      if (now - status.compactingSince < STUCK_AFTER_MS) return result
      $.ui.log(`strata-trigger: a compaction started ${Math.round((now - status.compactingSince) / 60000)} min ago never settled; triggering again`)
    }
    if ((tokens ?? 0) < (await triggerTokens($))) return result
    status.compactingSince = now
    // After the turn has settled: compaction is refused while a turn runs.
    $.clock.after(0, () => {
      $.session
        .compact()
        .then(answer => {
          status.lastOutcome = 'skip' in answer && answer.skip ? `skipped: ${answer.skip}` : `compacted from ${tokens?.toLocaleString('en-US')} tokens`
        })
        .catch(error => {
          status.lastOutcome = `refused: ${describe(error)}`
          // Shown, not just debug-logged: a silent refusal looks exactly like "never triggered".
          $.ui.log(`strata-trigger: compaction refused, will retry after the next turn: ${describe(error)}`)
        })
        .finally(() => (status.compactingSince = undefined))
    })
    return result
  })
}
