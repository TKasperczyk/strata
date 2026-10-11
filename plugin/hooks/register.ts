import type { EngineInterface, Next, Register, SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code'

// The CLI does the work (archive, layering, ledger model call); this module
// only hands it the transcript and maps its answer back onto engine messages,
// and keeps the ledger prepared in the background. The sibling plugin
// strata-trigger starts compactions when the context passes the trigger.
const CLI_TIMEOUT_MS = 5 * 60 * 1000
/** A background ledger job may take several model calls; the host caps a run at ten minutes. */
const PREPARE_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_TRIGGER_TOKENS = 400_000
/** Start preparing the ledger this far below the trigger, so it is ready in time. */
const PREPARE_FRACTION = 0.75
// chars / 3.5 tokens per char / 1000, for "123k" in log lines
const CHARS_PER_KTOKEN = 3500

type Built = Pick<SessionMessage, 'role' | 'text' | 'toolUses' | 'toolResults'>
type Entry = { keep: number } | { built: Built }
type CliResult = {
  entries: Entry[]
  stats: {
    outputChars: number
    rawChars: number
    matched: number
    previousOutput: number
    cut: number
    ledgerThrough: number
    hiddenChars?: number
    mediaSaved?: number
    ledgerError?: string
  }
}

function plain(m: SessionMessage): Built {
  return {
    role: m.role,
    text: m.text,
    // `result` is the tool's stored record: bulky, and the CLI never reads it.
    toolUses: m.toolUses.map(({ result: _result, ...use }) => use),
    ...(m.toolResults ? { toolResults: m.toolResults.map(({ result: _result, ...r }) => r) } : {})
  }
}

/** The CLI ships inside the plugin as one bundled file, so an installed copy needs only node. */
function cli($: EngineInterface): string[] {
  return ['node', `${$.plugin.root}/bin/strata.mjs`]
}

/**
 * Fold what the next compaction would evict into a ready ledger, off the
 * user's path. `messages` is the conversation to plan on: the session's own
 * by default, or the output a compaction just produced (its archive numbering
 * is then exactly the committed one, so the result is never rejected for it).
 */
export async function prepareLedger($: EngineInterface, session: string, messages?: Built[]): Promise<void> {
  const snapshot = messages ?? (await $.session.messages()).map(plain)
  const run = await $.process.run([...cli($), 'prepare', '--session', session, '--in', '-'], {
    stdin: JSON.stringify({ messages: snapshot }),
    timeoutMs: PREPARE_TIMEOUT_MS
  })
  $.ui.log(`ledger prep ${run.exitCode === 0 ? run.stdout.trim() : `failed (exit ${run.exitCode}): ${run.stderr.slice(-300)}`}`, { to: 'debug' })
}

// One background ledger job in flight per module instance; the CLI also locks per session.
let preparing = false

function prepareInBackground($: EngineInterface, session: string, messages?: Built[]): void {
  if (preparing) return
  preparing = true
  $.clock.after(0, () => {
    prepareLedger($, session, messages)
      .catch(error => $.ui.log(`ledger prep failed: ${String(error)}`, { to: 'debug' }))
      .finally(() => (preparing = false))
  })
}

/**
 * What the rows leave out: the conversation in Messages API form (images,
 * thinking) and the engine's real token figures to calibrate against. Best
 * effort: without it strata budgets the rows' text alone, as before.
 */
async function hiddenContext($: EngineInterface): Promise<{ api?: unknown; usage?: { tokens?: number; overhead?: number } }> {
  try {
    const [api, usage] = await Promise.all([$.session.messages({ as: 'api' }), $.session.usage({ breakdown: 'summary' })])
    const categories = usage.context.breakdown?.categories ?? []
    const messages = categories.find(c => c.name === 'Messages')
    const overhead = messages
      ? categories.filter(c => c.kind === 'used' && c !== messages).reduce((n, c) => n + c.tokens, 0)
      : undefined
    return { api, usage: { ...(usage.context.tokens !== undefined ? { tokens: usage.context.tokens } : {}), ...(overhead !== undefined ? { overhead } : {}) } }
  } catch (error) {
    $.ui.log(`could not read the API form, budgeting text only: ${String(error)}`, { to: 'debug' })
    return {}
  }
}

/** The hook's work, split out so tests can supply the session id the test kit lacks. */
export async function strataCompact(
  $: EngineInterface,
  e: SessionCompactInput,
  next: Next<'session.compact'>,
  session: string
): Promise<SessionCompactResult> {
  const argv = [...cli($), 'compact', '--session', session, '--in', '-', '--out', '-']
  if (e.instructions) argv.push('--instructions', e.instructions)
  // strata's own trigger must not make the user wait: use the ledger the
  // background job prepared. /compact may take the time to bring it up to date.
  if (e.trigger === 'plugin') argv.push('--ledger', 'ready')
  const run = await $.process.run(argv, {
    stdin: JSON.stringify({ messages: e.messages.map(plain), ...(await hiddenContext($)) }),
    timeoutMs: CLI_TIMEOUT_MS
  })
  if (run.exitCode !== 0 || run.isStdoutTruncated) {
    $.ui.log(`compaction failed (exit ${run.exitCode}), using the built-in compactor. ${run.stderr.slice(-500)}`)
    return next(e)
  }
  const result = JSON.parse(run.stdout) as CliResult
  const messages: Built[] = []
  for (const entry of result.entries) {
    const message = 'keep' in entry ? e.messages[entry.keep] : entry.built
    if (!message) {
      $.ui.log('the CLI referenced a message that does not exist, using the built-in compactor')
      return next(e)
    }
    messages.push(message)
  }
  const k = (chars: number) => `${Math.round(chars / CHARS_PER_KTOKEN)}k`
  const { rawChars, outputChars, matched, previousOutput, cut, ledgerThrough, ledgerError, hiddenChars, mediaSaved } = result.stats
  const notes = [
    hiddenChars ? `${k(hiddenChars)} of it images/thinking` : '',
    mediaSaved ? `${mediaSaved} images archived` : '',
    matched < previousOutput ? `only ${matched}/${previousOutput} of the last output was recognised; the rest was archived as new` : '',
    ledgerThrough < cut ? `ledger lags the cut by ${cut - ledgerThrough} messages` : '',
    ledgerError ? `ledger not updated: ${ledgerError}` : ''
  ].filter(Boolean)
  $.ui.log(`${k(rawChars)} branch text -> ${k(outputChars)} live${notes.length ? ` (${notes.join('; ')})` : ''}`)
  // A ready-mode compaction can leave the ledger behind the cut: catch it up
  // now, planning on exactly this output so nothing else has to run first.
  if (ledgerThrough < cut && (await thresholds($)).auto) prepareInBackground($, session, messages.map(plain))
  return { messages }
}

export type Thresholds = { auto: boolean; trigger: number; prepare: number }

function positiveInt(raw: string | undefined): number | undefined {
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10)
  return n > 0 ? n : undefined
}

export async function thresholds($: EngineInterface): Promise<Thresholds> {
  const trigger = positiveInt(await $.env.get('STRATA_TRIGGER_TOKENS')) ?? DEFAULT_TRIGGER_TOKENS
  return {
    auto: (await $.env.get('STRATA_AUTO')) !== '0',
    trigger,
    prepare: positiveInt(await $.env.get('STRATA_PREPARE_TOKENS')) ?? Math.round(trigger * PREPARE_FRACTION)
  }
}

export const register: Register = on => {
  on('session.compact', async ($, e, next) => {
    // Ahead-of-time summaries would be thrown away: strata answers the real one.
    if (e.trigger === 'precompute') return { skip: 'strata compacts on demand' }
    // Subagent transcripts keep the built-in compactor for now.
    if (e.agentId) return next(e)
    return strataCompact($, e, next, await $.session.id())
  }).catch(($, e, next) => {
    // Any failure (timeout, bad JSON) falls back to the engine's own compaction.
    $.ui.log('compaction hook failed, using the built-in compactor')
    return next(e)
  })

  // Between the prepare mark and the trigger, ready the ledger in the
  // background. Starting compactions is strata-trigger's job: a plugin's own
  // $.session.compact() skips every hook of that plugin, this one included.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.isAborted) return result
    const limits = await thresholds($)
    const tokens = (await $.session.usage()).context.tokens ?? 0
    if (limits.auto && tokens >= limits.prepare && tokens < limits.trigger) prepareInBackground($, await $.session.id())
    return result
  })
}
