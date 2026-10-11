import type { Register } from 'claude-code'

// A plugin's own $.session.compact() runs every hook but that plugin's, so the
// plugin that answers compactions (strata) cannot also start them: this one does.
// Its thresholds mirror strata's (STRATA_TRIGGER_TOKENS, STRATA_AUTO).
const DEFAULT_TRIGGER_TOKENS = 400_000

let compacting = false

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.isAborted || compacting) return result
    if ((await $.env.get('STRATA_AUTO')) === '0') return result
    const configured = Number.parseInt((await $.env.get('STRATA_TRIGGER_TOKENS')) ?? '', 10)
    const trigger = configured > 0 ? configured : DEFAULT_TRIGGER_TOKENS
    if (((await $.session.usage()).context.tokens ?? 0) < trigger) return result
    compacting = true
    // After the turn has settled: compaction is refused while a turn runs.
    $.clock.after(0, () => {
      $.session
        .compact()
        .catch(error => $.ui.log(`strata-trigger: compaction refused: ${String(error)}`, { to: 'debug' }))
        .finally(() => (compacting = false))
    })
    return result
  })
}
