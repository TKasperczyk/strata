import type { EngineInterface, ModelCompleteResult, Next, Register, SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code'

declare module 'claude-code' {
  interface McpToolInputs {
    mcp__strata__show: {
      seq: number
      last_seq?: number
      offset?: number
      limit?: number
    }
    mcp__strata__search: {
      query: string
      regex?: boolean
      role?: 'user' | 'assistant'
      errors_only?: boolean
      from_seq?: number
      to_seq?: number
      all_branches?: boolean
      max_matches?: number
    }
  }
}

// The CLI owns the archive, layout, and query commands on disk; this module
// runs live ledger completions through Claude Code's `$.model.complete`, maps
// compaction results back onto engine handles, serves native read-only archive
// tools, and keeps the ledger prepared in the background. The sibling plugin
// strata-trigger starts compactions when the context passes the trigger.
const CLI_TIMEOUT_MS = 2 * 60 * 1000
const TOOL_TIMEOUT_MS = 30 * 1000
const LEDGER_CALL_TIMEOUT_MS = 2 * 60 * 1000
/** Claude Code's `$.model.complete` refuses `maxTokens` above 64,000. */
const MAX_MODEL_TOKENS = 64_000
const DEFAULT_TRIGGER_TOKENS = 900_000
/** Start preparing the ledger this far below the trigger (never below half of it), so it is ready in time. */
const PREPARE_HEADROOM_TOKENS = 100_000
// chars / 3.5 tokens per char / 1000, for "123k" in log lines
const CHARS_PER_KTOKEN = 3500
const EXIT_DECLINED = 3

const SHOW_TOOL = 'mcp__strata__show'
const SEARCH_TOOL = 'mcp__strata__search'
const STATUS_COMMAND = 'strata'

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

type LedgerPlanNeeded = {
  needed: true
  previous: string
  chunks: string[]
  focus?: string
  maxChars: number
  maxTokens: number
  system: string
  model: string
  through: number
  prefixHash: string
  age: number
}

type LedgerPlan = { needed: false; reason: string } | LedgerPlanNeeded

type PreparedLedger = {
  ledger: string
  through: number
  prefixHash: string
  age: number
  requests: number
}

type CliSessionStatus = {
  sessionKey: string
  archiveCount: number
  archiveBytes: number
  mediaCount: number
  branchLength: number
  compactions: number
  lastCut?: number
  ledgerThrough: number
  ledgerChars: number
  ledgerAge: number
  ledgerLag: number
  readyLedger?: {
    through: number
    chars: number
    age: number
    preparedAt: string
    compatible: boolean
    status?: 'compatible' | 'pending' | 'stale'
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function describeModelFailure(res: Extract<ModelCompleteResult, { isAnswered: false }>): string {
  if (res.reason === 'api-error') return `api-error (${res.error}${res.status !== null ? ` HTTP ${res.status}` : ''})`
  return res.reason
}

function buildLedgerPrompt(previous: string, chunk: string, maxChars: number, focus?: string): string {
  return [
    `Current ledger:\n${previous || '(empty: this is the first eviction)'}`,
    focus ? `The user asked this compaction to keep or stress: ${focus}` : '',
    `Newly archived history (#seq prefixes are archive seq numbers; "[strata elided …]" marks results kept only in the archive):\n${chunk}`,
    `Write the updated ledger. Stay under ${maxChars.toLocaleString('en-US')} characters.`
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** The CLI ships inside the plugin as one bundled file, so an installed copy needs only node. */
function cli($: EngineInterface): string[] {
  return ['node', `${$.plugin.root}/bin/strata.mjs`]
}

/** Compact section-aware trim for intermediate multi-chunk ledger outputs, preserving Current state and Open items. */
function trimIntermediateLedger(ledger: string, maxChars: number): string {
  if (ledger.length <= maxChars) return ledger
  const priorityOf = (h: string) => {
    const l = h.toLowerCase()
    if (l.includes('current state')) return 6
    if (l.includes('open item')) return 5
    if (l.includes('goal')) return 4
    if (l.includes('constraint') || l.includes('preference')) return 3
    if (l.includes('decision')) return 2
    if (l.includes('dead end')) return 1
    return 0
  }
  const sections: Array<{ heading: string; priority: number; lines: string[] }> = []
  for (const line of ledger.split('\n')) {
    if (line.startsWith('## ')) sections.push({ heading: line, priority: priorityOf(line), lines: [] })
    else if (sections.length > 0 && line.trim()) sections[sections.length - 1]!.lines.push(line)
  }
  if (!sections.length) return ledger.slice(0, maxChars)
  const render = () => sections.map(s => (s.lines.length ? `${s.heading}\n${s.lines.join('\n')}` : s.heading)).join('\n\n')
  let out = render()
  while (out.length > maxChars && sections.length > 0) {
    const ordered = [...sections].sort((a, b) => a.priority - b.priority)
    const target = ordered.find(s => s.lines.length > 0)
    if (target && target.lines.length > 1) target.lines.shift()
    else if (sections.length > 1) sections.splice(sections.indexOf(ordered[0]!), 1)
    else break
    out = render()
  }
  return out.length <= maxChars ? out : out.slice(0, maxChars)
}

/** Run every chunk of a ledger plan through Claude Code's `$.model.complete`. */
async function executeLedgerPlan($: EngineInterface, plan: LedgerPlanNeeded): Promise<PreparedLedger> {
  // Defense in depth: `$.model.complete` refuses maxTokens outside [1, 64_000].
  const maxTokens =
    typeof plan.maxTokens === 'number' && Number.isFinite(plan.maxTokens)
      ? Math.min(MAX_MODEL_TOKENS, Math.max(1, Math.floor(plan.maxTokens)))
      : 2_000
  let ledger = plan.previous
  for (const chunk of plan.chunks) {
    const reply = await $.model.complete({
      model: plan.model,
      system: plan.system,
      prompt: buildLedgerPrompt(ledger, chunk, plan.maxChars, plan.focus),
      maxTokens,
      timeoutMs: LEDGER_CALL_TIMEOUT_MS
    })
    if (!reply.isAnswered) throw new Error(`ledger model failed: ${describeModelFailure(reply)}`)
    const text = reply.text.trim()
    if (!text) throw new Error('ledger model returned empty text')
    // Bound intermediate chunk outputs section-aware so Current state / Open items survive multi-chunk runs.
    ledger = plan.chunks.length > 1 ? trimIntermediateLedger(text, plan.maxChars * 2) : text
  }
  return {
    ledger,
    through: plan.through,
    prefixHash: plan.prefixHash,
    age: plan.age,
    requests: plan.chunks.length
  }
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

export type PrepareTarget = { through: number }

/**
 * Fold evicted history into a ready ledger, off the user's path, using
 * `$.model.complete`. Pre-compaction prep snapshots the session along with its
 * hidden weights (`api` and `usage`); post-compaction catch-up passes an
 * explicit `--through <cut>` against the already-committed archive and branch.
 */
export async function prepareLedger($: EngineInterface, session: string, target?: PrepareTarget): Promise<void> {
  let planRun
  if (target?.through !== undefined) {
    planRun = await $.process.run([...cli($), 'ledger-plan', `--session=${session}`, '--through', String(target.through)], {
      timeoutMs: CLI_TIMEOUT_MS
    })
  } else {
    const [rawMessages, hidden] = await Promise.all([$.session.messages(), hiddenContext($)])
    planRun = await $.process.run([...cli($), 'ledger-plan', `--session=${session}`, '--in', '-'], {
      stdin: JSON.stringify({ messages: rawMessages.map(plain), ...hidden }),
      timeoutMs: CLI_TIMEOUT_MS
    })
  }
  if (planRun.exitCode !== 0 || planRun.isStdoutTruncated) {
    $.ui.log(`ledger prep plan failed (exit ${planRun.exitCode}): ${planRun.stderr.slice(-300)}`, { to: 'debug' })
    return
  }
  const plan = JSON.parse(planRun.stdout) as LedgerPlan
  if (!plan.needed) {
    $.ui.log(`ledger prep skipped: ${plan.reason}`, { to: 'debug' })
    return
  }
  const prepared = await executeLedgerPlan($, plan)
  const saveRun = await $.process.run([...cli($), 'ledger-save', `--session=${session}`, '--in', '-'], {
    stdin: JSON.stringify(prepared),
    timeoutMs: CLI_TIMEOUT_MS
  })
  $.ui.log(`ledger prep ${saveRun.exitCode === 0 ? saveRun.stdout.trim() : `save failed (exit ${saveRun.exitCode}): ${saveRun.stderr.slice(-300)}`}`, { to: 'debug' })
}

// One background ledger job in flight per session; reset cleanly on session.start and session.end (/clear, /resume).
let preparing = false
let sessionGen = 0
let pendingCatchUp: { session: string; through: number } | undefined

function resetBackgroundState(): void {
  sessionGen++
  preparing = false
  pendingCatchUp = undefined
}

function prepareInBackground($: EngineInterface, session: string, target?: PrepareTarget): void {
  if (preparing) {
    // Do not lose a post-compaction catch-up if pre-compaction prep is still finishing.
    if (target?.through !== undefined) pendingCatchUp = { session, through: target.through }
    return
  }
  preparing = true
  const gen = sessionGen
  $.clock.after(0, () => {
    if (gen !== sessionGen) return
    prepareLedger($, session, target)
      .catch(error => $.ui.log(`ledger prep failed: ${describe(error)}`, { to: 'debug' }))
      .finally(() => {
        if (gen !== sessionGen) return
        preparing = false
        const queued = pendingCatchUp
        pendingCatchUp = undefined
        if (queued) prepareInBackground($, queued.session, { through: queued.through })
      })
  })
}

/** The hook's work, split out so tests can supply the session id the test kit lacks. */
export async function strataCompact(
  $: EngineInterface,
  e: SessionCompactInput,
  next: Next<'session.compact'>,
  session: string
): Promise<SessionCompactResult> {
  const snapshot = e.messages.map(plain)
  const hidden = await hiddenContext($)
  let preparedLedger: PreparedLedger | undefined
  let ledgerError: string | undefined

  // strata-trigger compacts with the ready ledger so the user never waits.
  // /compact (and auto, or any compaction with explicit instructions) brings the ledger up to date via $.model.complete first.
  if (e.trigger !== 'plugin' || e.instructions) {
    const planArgv = [...cli($), 'ledger-plan', `--session=${session}`, '--in', '-', '--sync']
    if (e.instructions) planArgv.push(`--instructions=${e.instructions}`)
    const planRun = await $.process.run(planArgv, {
      stdin: JSON.stringify({ messages: snapshot, ...hidden, ...(e.instructions ? { instructions: e.instructions } : {}) }),
      timeoutMs: CLI_TIMEOUT_MS
    })
    if (planRun.exitCode === EXIT_DECLINED) {
      $.ui.log(`compaction declined, using the built-in compactor. ${planRun.stderr.slice(-500)}`)
      return next(e)
    }
    if (planRun.exitCode !== 0 || planRun.isStdoutTruncated) {
      ledgerError = `ledger plan failed (exit ${planRun.exitCode})`
    } else {
      try {
        const plan = JSON.parse(planRun.stdout) as LedgerPlan
        if (plan.needed) preparedLedger = await executeLedgerPlan($, plan)
      } catch (error) {
        ledgerError = describe(error)
      }
    }
  }

  const argv = [...cli($), 'compact', `--session=${session}`, '--in', '-', '--out', '-', '--ledger', 'ready', '--native-tools']
  if (e.instructions) argv.push(`--instructions=${e.instructions}`)
  const run = await $.process.run(argv, {
    stdin: JSON.stringify({
      messages: snapshot,
      ...hidden,
      ...(e.instructions ? { instructions: e.instructions } : {}),
      ...(preparedLedger ? { preparedLedger } : {}),
      ...(ledgerError ? { ledgerError } : {})
    }),
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
  const { rawChars, outputChars, matched, previousOutput, cut, ledgerThrough, hiddenChars, mediaSaved } = result.stats
  const reportedError = result.stats.ledgerError ?? ledgerError
  const notes = [
    hiddenChars ? `${k(hiddenChars)} of it images/thinking` : '',
    mediaSaved ? `${mediaSaved} images archived` : '',
    matched < previousOutput ? `only ${matched}/${previousOutput} of the last output was recognised; the rest was archived as new` : '',
    ledgerThrough < cut ? `ledger lags the cut by ${cut - ledgerThrough} messages` : '',
    reportedError ? `ledger not updated: ${reportedError}` : ''
  ].filter(Boolean)
  $.ui.log(`${k(rawChars)} branch text -> ${k(outputChars)} live${notes.length ? ` (${notes.join('; ')})` : ''}`)
  // A ready-mode compaction can leave the ledger behind the cut: catch it up
  // in the background through the exact committed cut.
  if (ledgerThrough < cut && (await thresholds($)).auto) prepareInBackground($, session, { through: cut })
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
    prepare: positiveInt(await $.env.get('STRATA_PREPARE_TOKENS')) ?? Math.max(Math.round(trigger / 2), trigger - PREPARE_HEADROOM_TOKENS)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    resetBackgroundState()
    await Promise.all([
      $.tool.register({
        name: 'show',
        description: 'Read one or more archived messages from the current strata session archive by sequence number, with character-offset pagination.',
        inputSchema: {
          type: 'object',
          properties: {
            seq: { type: 'integer', minimum: 0, description: 'Starting archive sequence number (from #seq citations or [strata elided … archive seq N])' },
            last_seq: { type: 'integer', minimum: 0, description: 'Optional inclusive ending sequence number' },
            offset: { type: 'integer', minimum: 0, description: 'Character offset into the rendered output for pagination (default 0)' },
            limit: { type: 'integer', minimum: 1, maximum: 100000, description: 'Maximum characters to return (default 20000)' }
          },
          required: ['seq']
        },
        isDeferred: false
      }),
      $.tool.register({
        name: 'search',
        description: 'Search archived messages in the current strata session (scoped to the active branch by default). Returns matching #seq numbers and snippets.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Case-insensitive substring (or regex when regex=true) to search for' },
            regex: { type: 'boolean', description: 'Treat query as a regular expression (default false)' },
            role: { type: 'string', enum: ['user', 'assistant'], description: 'Filter matches by message role' },
            errors_only: { type: 'boolean', description: 'Only search messages containing tool errors' },
            from_seq: { type: 'integer', minimum: 0, description: 'Minimum archive seq to include' },
            to_seq: { type: 'integer', minimum: 0, description: 'Maximum archive seq to include' },
            all_branches: { type: 'boolean', description: 'Include rewound/abandoned branches (default false: active branch only)' },
            max_matches: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum matches to return (default 20)' }
          },
          required: ['query']
        },
        isDeferred: false
      }),
      $.command.register({
        name: STATUS_COMMAND,
        description: 'Shows strata archive, compaction, ledger, and background-prep status for this session'
      })
    ])
    return next(e)
  })

  // /clear and /resume fire session.end (never session.start), so reset background prep state here too.
  on('session.end', (_$, e, next) => {
    resetBackgroundState()
    return next(e)
  })

  on('tool.check', { tool: SHOW_TOOL }, async (_$, e, next) => {
    const verdict = await next(e)
    return verdict.decision === 'deny' ? verdict : { decision: 'allow', reason: 'read-only strata archive lookup' }
  }).catch((_$, e, next) => next(e))

  on('tool.check', { tool: SEARCH_TOOL }, async (_$, e, next) => {
    const verdict = await next(e)
    return verdict.decision === 'deny' ? verdict : { decision: 'allow', reason: 'read-only strata archive lookup' }
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: SHOW_TOOL }, async ($, e) => {
    const seq = typeof e.seq === 'number' && Number.isFinite(e.seq) ? Math.floor(e.seq) : -1
    if (seq < 0) return { isError: true, result: 'seq must be a non-negative integer', text: 'seq must be a non-negative integer' }
    const lastSeq = typeof e.last_seq === 'number' && Number.isFinite(e.last_seq) ? Math.floor(e.last_seq) : undefined
    if (lastSeq !== undefined && lastSeq < seq) {
      const msg = `last_seq (${lastSeq}) must be >= seq (${seq})`
      return { isError: true, result: msg, text: msg }
    }
    const session = await $.session.id()
    const argv = [...cli($), 'show']
    const offset = typeof e.offset === 'number' && Number.isFinite(e.offset) && e.offset >= 0 ? Math.floor(e.offset) : 0
    const limit = typeof e.limit === 'number' && Number.isFinite(e.limit) && e.limit > 0 ? Math.min(100_000, Math.floor(e.limit)) : 20_000
    argv.push('--offset', String(offset), '--limit', String(limit), '--', session, String(seq))
    if (lastSeq !== undefined) argv.push(String(lastSeq))
    const run = await $.process.run(argv, { timeoutMs: TOOL_TIMEOUT_MS })
    if (run.exitCode !== 0) {
      const msg = (run.stderr || run.stdout || `strata show failed (exit ${run.exitCode})`).trim()
      return { isError: true, result: msg, text: msg }
    }
    return { result: run.stdout.trimEnd() }
  }).catch(() => ({ isError: true, result: 'strata show failed', text: 'strata show failed' }))

  on('tool.call', { tool: SEARCH_TOOL }, async ($, e) => {
    const query = typeof e.query === 'string' ? e.query : ''
    if (!query) return { isError: true, result: 'query must be a non-empty string', text: 'query must be a non-empty string' }
    const session = await $.session.id()
    const argv = [...cli($), 'search']
    if (e.all_branches === true) argv.push('--all-branches')
    if (e.regex === true) argv.push('--regex')
    if (e.errors_only === true) argv.push('--errors')
    if (e.role === 'user' || e.role === 'assistant') argv.push('--role', e.role)
    if (typeof e.from_seq === 'number' && Number.isFinite(e.from_seq) && e.from_seq >= 0) argv.push('--from', String(Math.floor(e.from_seq)))
    if (typeof e.to_seq === 'number' && Number.isFinite(e.to_seq) && e.to_seq >= 0) argv.push('--to', String(Math.floor(e.to_seq)))
    if (typeof e.max_matches === 'number' && Number.isFinite(e.max_matches) && e.max_matches > 0) argv.push('--max', String(Math.min(100, Math.floor(e.max_matches))))
    argv.push('--', session, query)
    const run = await $.process.run(argv, { timeoutMs: TOOL_TIMEOUT_MS })
    if (run.exitCode !== 0) {
      const msg = (run.stderr || run.stdout || `strata search failed (exit ${run.exitCode})`).trim()
      return { isError: true, result: msg, text: msg }
    }
    return { result: run.stdout.trimEnd() }
  }).catch(() => ({ isError: true, result: 'strata search failed', text: 'strata search failed' }))

  on('command.run', { command: STATUS_COMMAND }, async $ => {
    const [session, limits, usage] = await Promise.all([$.session.id(), thresholds($), $.session.usage()])
    const run = await $.process.run([...cli($), 'status', '--json', '--', session], { timeoutMs: TOOL_TIMEOUT_MS })
    const tokens = usage.context.tokens
    const header = `strata: session ${session}, auto ${limits.auto ? 'on' : 'off (STRATA_AUTO=0)'}, prepare ${limits.prepare.toLocaleString('en-US')} / trigger ${limits.trigger.toLocaleString('en-US')} tokens, context ${tokens?.toLocaleString('en-US') ?? 'unknown'} tokens`
    if (run.exitCode !== 0) {
      return { text: `${header}\nstatus unavailable (exit ${run.exitCode}): ${run.stderr.slice(-200).trim()}` }
    }
    const s = JSON.parse(run.stdout) as CliSessionStatus
    const kb = (s.archiveBytes / 1024).toFixed(1)
    const ledgerLine = s.ledgerChars > 0
      ? `ledger: ${s.ledgerChars.toLocaleString('en-US')} chars covering ${s.ledgerThrough} rows (age ${s.ledgerAge}${s.ledgerLag > 0 ? `, lags cut by ${s.ledgerLag} rows` : s.lastCut !== undefined ? ', up to date' : ''})`
      : `ledger: empty${s.ledgerLag > 0 ? ` (lags cut by ${s.ledgerLag} rows)` : ''}`
    const readyStatus = s.readyLedger?.status ?? (s.readyLedger?.compatible ? 'compatible' : 'stale')
    const readyLine = s.readyLedger
      ? `ready ledger: ${s.readyLedger.chars.toLocaleString('en-US')} chars covering ${s.readyLedger.through} rows (${readyStatus}, prepared ${s.readyLedger.preparedAt})`
      : 'ready ledger: none'
    return {
      text: [
        header,
        `archive: ${s.archiveCount} messages (${kb} KB), ${s.mediaCount} media files, active branch ${s.branchLength} rows`,
        `compactions: ${s.compactions}${s.lastCut !== undefined ? ` (last cut at row ${s.lastCut})` : ''}`,
        ledgerLine,
        `${readyLine} | background prep: ${preparing ? 'running' : 'idle'}`
      ].join('\n')
    }
  }).catch(() => ({ text: 'strata: failed to read status' }))

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
