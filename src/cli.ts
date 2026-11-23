#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { parseArgs } from 'util'
import { sessionDir } from './archive.js'
import { compact, DeclineError, planLedger, prepare, type CompactStats, type LedgerFn, type PreparedLedger } from './compact.js'
import { estimateTokens, loadConfig, shareChars } from './config.js'
import { trimLedger } from './ledger.js'
import { messageChars } from './mask.js'
import { formatSessionStatus, searchArchive, sessionStatus, showArchive } from './query.js'
import { readReady, writeReady } from './ready.js'
import { apiForm, readTranscriptWithBlocks } from './transcript.js'
import { DEFAULT_THINKING_CHARS_PER_TOKEN, hiddenByRow, type ApiMessage, type UsageReading } from './weights.js'
import type { Message } from './types.js'

const USAGE = `strata - layered, budget-bounded compaction for Claude Code

  strata compact --session <key> --in <messages.json|-> --out <result.json|-> [--instructions <text>] [--budget <tokens>] [--ledger sync|ready] [--native-tools]
  strata prepare --session <key> (--in <messages.json|-> | --through <cut>) [--instructions <text>] [--budget <tokens>]
  strata ledger-plan --session <key> (--in <messages.json|-> | --through <cut>) [--instructions <text>] [--budget <tokens>] [--sync]
  strata ledger-save --session <key> --in <ready.json|-> [--budget <tokens>]
  strata show <session-key> <seq> [<last-seq>] [--offset <chars>] [--limit <chars>]
  strata search <session-key> <query> [--all-branches] [--role user|assistant] [--errors] [--regex] [--max <n>] [--from <seq>] [--to <seq>]
  strata status <session-key> [--json]
  strata replay <transcript.jsonl> [--budget <tokens>] [--trigger <tokens>] [--no-llm] [--keep] [--background]

Data lives in $STRATA_DATA_DIR (default ~/.strata).`

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`
}

const SELF = resolve(process.argv[1])
const SHOW_COMMAND = (key: string) => `node ${shellQuote(SELF)} show ${shellQuote(key)}`

/** Offline stand-in for the ledger model: records how far it got, so lag is visible. */
const noLedger: LedgerFn = async (previous, span) => ({ ledger: `${previous}\n- folded through #${span.at(-1)?.seq}`.trim(), requests: 1 })

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`)
  process.exit(2)
}

function parseIntArg(name: string, raw: string | undefined, min: number): number | undefined {
  if (raw === undefined) return undefined
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < min) fail(`${name} must be an integer >= ${min}, got ${raw}`)
  return n
}

function budgetOverride(raw: string | undefined): { budgetTokens?: number } {
  const n = parseIntArg('--budget', raw, 1)
  return n !== undefined ? { budgetTokens: n } : {}
}

function readJsonInput<T>(source: string): T {
  return JSON.parse(readFileSync(source === '-' ? 0 : source, 'utf-8')) as T
}

async function runCompact(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: 'string' },
      in: { type: 'string' },
      out: { type: 'string' },
      instructions: { type: 'string' },
      budget: { type: 'string' },
      ledger: { type: 'string' },
      'native-tools': { type: 'boolean' }
    }
  })
  if (!values.session || !values.in || !values.out) fail('compact needs --session, --in and --out')
  if (values.ledger !== undefined && values.ledger !== 'sync' && values.ledger !== 'ready') fail(`--ledger must be sync or ready, got ${values.ledger}`)
  const config = loadConfig(budgetOverride(values.budget))
  // `-` reads stdin / writes stdout, which is how the plugin calls it.
  const payload = readJsonInput<{
    messages: Message[]
    api?: ApiMessage[]
    usage?: UsageReading
    preparedLedger?: PreparedLedger
    ledgerError?: string
  }>(values.in)
  const result = await compact(
    {
      sessionKey: values.session,
      messages: payload.messages,
      ...(values.instructions ? { instructions: values.instructions } : {}),
      ...(values.ledger ? { ledgerMode: values.ledger } : {}),
      ...(values['native-tools'] ? { hasNativeTools: true } : {}),
      ...(payload.api ? { api: payload.api } : {}),
      ...(payload.usage ? { usage: payload.usage } : {}),
      ...(payload.preparedLedger ? { preparedLedger: payload.preparedLedger } : {}),
      ...(payload.ledgerError ? { ledgerError: payload.ledgerError } : {}),
      showCommand: SHOW_COMMAND(values.session)
    },
    config
  )
  if (values.out === '-') process.stdout.write(JSON.stringify(result))
  else writeFileSync(values.out, JSON.stringify(result))
  process.stderr.write(`[strata] ${summarize(result.stats)}\n`)
}

/** Background ledger preparation; prints one JSON line, never touches archive or state. */
async function runPrepare(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: 'string' },
      in: { type: 'string' },
      through: { type: 'string' },
      instructions: { type: 'string' },
      budget: { type: 'string' }
    }
  })
  if (!values.session || (!values.in && values.through === undefined)) fail('prepare needs --session and either --in or --through')
  const config = loadConfig(budgetOverride(values.budget))
  if (values.through !== undefined) {
    const through = parseIntArg('--through', values.through, 0)!
    const result = await prepare(
      { sessionKey: values.session, through, ...(values.instructions ? { instructions: values.instructions } : {}) },
      config
    )
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  const { messages, api, usage } = readJsonInput<{ messages: Message[]; api?: ApiMessage[]; usage?: UsageReading }>(values.in!)
  const result = await prepare(
    {
      sessionKey: values.session,
      messages,
      ...(api ? { api } : {}),
      ...(usage ? { usage } : {}),
      ...(values.instructions ? { instructions: values.instructions } : {}),
      showCommand: SHOW_COMMAND(values.session)
    },
    config
  )
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

/** Read-only ledger update plan for the host plugin's `$.model.complete` loop. */
function runLedgerPlan(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: 'string' },
      in: { type: 'string' },
      through: { type: 'string' },
      instructions: { type: 'string' },
      budget: { type: 'string' },
      sync: { type: 'boolean' }
    }
  })
  if (!values.session || (!values.in && values.through === undefined)) fail('ledger-plan needs --session and either --in or --through')
  const config = loadConfig(budgetOverride(values.budget))
  const options = values.sync ? { enforceMinChars: false } : {}
  if (values.through !== undefined) {
    const through = parseIntArg('--through', values.through, 0)!
    const plan = planLedger(
      { sessionKey: values.session, through, ...(values.instructions ? { instructions: values.instructions } : {}) },
      config,
      options
    )
    process.stdout.write(`${JSON.stringify(plan)}\n`)
    return
  }
  const { messages, api, usage } = readJsonInput<{ messages: Message[]; api?: ApiMessage[]; usage?: UsageReading }>(values.in!)
  const plan = planLedger(
    {
      sessionKey: values.session,
      messages,
      ...(api ? { api } : {}),
      ...(usage ? { usage } : {}),
      ...(values.instructions ? { instructions: values.instructions } : {}),
      showCommand: SHOW_COMMAND(values.session)
    },
    config,
    options
  )
  process.stdout.write(`${JSON.stringify(plan)}\n`)
}

/** Save a ready ledger computed by the host plugin via `$.model.complete`. */
function runLedgerSave(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: 'string' },
      in: { type: 'string' },
      budget: { type: 'string' }
    }
  })
  if (!values.session || !values.in) fail('ledger-save needs --session and --in')
  const config = loadConfig(budgetOverride(values.budget))
  const dir = sessionDir(config.dataDir, values.session)
  const payload = readJsonInput<{ ledger: string; through: number; prefixHash: string; age: number }>(values.in)
  if (typeof payload.ledger !== 'string' || typeof payload.through !== 'number' || typeof payload.prefixHash !== 'string' || typeof payload.age !== 'number') {
    fail('ledger-save input must contain ledger, through, prefixHash and age')
  }
  const existing = readReady(dir)
  if (existing && existing.prefixHash === payload.prefixHash && existing.through >= payload.through) {
    process.stdout.write(`${JSON.stringify({ saved: false, reason: 'already saved for this prefix', through: existing.through })}\n`)
    return
  }
  writeReady(dir, {
    ledger: trimLedger(payload.ledger, shareChars(config, 'ledger')),
    through: payload.through,
    prefixHash: payload.prefixHash,
    age: payload.age,
    preparedAt: new Date().toISOString()
  })
  process.stdout.write(`${JSON.stringify({ saved: true, through: payload.through })}\n`)
}

function runShow(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      offset: { type: 'string' },
      limit: { type: 'string' }
    }
  })
  const [key, first, last] = positionals
  if (!key || first === undefined) fail('show needs <session-key> <seq> [<last-seq>]')
  const from = parseIntArg('<seq>', first, 0)!
  const to = last === undefined ? from : parseIntArg('<last-seq>', last, from)!
  const offset = parseIntArg('--offset', values.offset, 0)
  const limit = parseIntArg('--limit', values.limit, 1)
  const result = showArchive(sessionDir(loadConfig().dataDir, key), { from, to, offset, limit })
  if (!result.found) fail(`no archived messages in seq ${from}-${to} (archive holds ${result.archiveCount})`)
  process.stdout.write(`${result.text}\n`)
}

function runSearch(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'all-branches': { type: 'boolean' },
      role: { type: 'string' },
      errors: { type: 'boolean' },
      regex: { type: 'boolean' },
      max: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' }
    }
  })
  const [key, ...queryParts] = positionals
  const query = queryParts.join(' ')
  if (!key || !query) fail('search needs <session-key> <query>')
  if (values.role !== undefined && values.role !== 'user' && values.role !== 'assistant') {
    fail(`--role must be user or assistant, got ${values.role}`)
  }
  const result = searchArchive(sessionDir(loadConfig().dataDir, key), {
    query,
    branchOnly: !values['all-branches'],
    ...(values.role ? { role: values.role } : {}),
    ...(values.errors ? { errorsOnly: true } : {}),
    ...(values.regex ? { regex: true } : {}),
    maxMatches: parseIntArg('--max', values.max, 1),
    fromSeq: parseIntArg('--from', values.from, 0),
    toSeq: parseIntArg('--to', values.to, 0)
  })
  process.stdout.write(`${result.formatted}\n`)
}

function runStatus(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' }
    }
  })
  const [key] = positionals
  if (!key) fail('status needs <session-key>')
  const status = sessionStatus(sessionDir(loadConfig().dataDir, key), key)
  if (values.json) process.stdout.write(`${JSON.stringify(status)}\n`)
  else process.stdout.write(`${formatSessionStatus(status)}\n`)
}

function summarize(s: CompactStats): string {
  const k = (chars: number) => `${Math.round(estimateTokens(chars) / 1000)}k`
  return [
    `archived ${s.archived} (+${s.newRaw}${s.matchedPrevious ? '' : `, matched ${s.matched}`}) branch ${s.branch}`,
    `raw ${k(s.rawChars)} -> out ${k(s.outputChars)}`,
    `header ${k(s.layers.header)} middle ${k(s.layers.middle)} tail ${k(s.layers.tail)}${s.hiddenChars ? ` (${k(s.hiddenChars)} images/thinking)` : ''}`,
    s.mediaSaved ? `${s.mediaSaved} images archived` : '',
    `cut ${s.cut} tail@${s.tailStart}`,
    s.ledgerRequests ? `ledger x${s.ledgerRequests}` : '',
    s.ledgerThrough < s.cut ? `ledger lags ${s.cut - s.ledgerThrough} rows` : '',
    s.ledgerError ? `LEDGER ERROR: ${s.ledgerError}` : ''
  ]
    .filter(Boolean)
    .join(' | ')
}

/**
 * Feed a real transcript through strata as if it were live: messages arrive
 * one at a time, and whenever the live context passes the trigger it is
 * compacted and replaced by strata's output. Shows whether the context stays
 * bounded across many compactions.
 */
async function runReplay(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      budget: { type: 'string' },
      trigger: { type: 'string' },
      'no-llm': { type: 'boolean' },
      keep: { type: 'boolean' },
      // Emulate the plugin: prepare the ledger 100k below the trigger (at least half of it), compact instantly at the trigger.
      background: { type: 'boolean' }
    }
  })
  const path = positionals[0]
  if (!path) fail('replay needs a transcript path')
  const dataDir = mkdtempSync(join(tmpdir(), 'strata-replay-'))
  const config = loadConfig({ dataDir, ...budgetOverride(values.budget) })
  const trigger = values.trigger ? parseIntArg('--trigger', values.trigger, 1)! : config.budgetTokens * 2
  const key = `replay-${basename(path, '.jsonl')}`
  const { messages: raw, blocks } = readTranscriptWithBlocks(path)
  // Live size as the engine would count it: text plus the images and thinking the rows hide,
  // computed once per message (rows strata built carry none).
  const weight = new Map<Message, number>()
  const tokensOf = (m: Message) => {
    let w = weight.get(m)
    if (w === undefined) {
      const hidden = hiddenByRow([m], apiForm([m], blocks)).get(0)
      w = estimateTokens(messageChars(m)) + (hidden ? hidden.imageTokens + Math.round(hidden.thinkingChars / DEFAULT_THINKING_CHARS_PER_TOKEN) : 0)
      weight.set(m, w)
    }
    return w
  }
  const tokens = (ms: Message[]) => ms.reduce((n, m) => n + tokensOf(m), 0)

  process.stdout.write(`${raw.length} messages, ${tokens(raw).toLocaleString('en-US')} est. tokens raw; budget ${config.budgetTokens}, trigger ${trigger}\n`)
  const ledgerFn = values['no-llm'] ? noLedger : undefined
  const PREPARE_HEADROOM_TOKENS = 100_000
  const prepareAt = Math.max(Math.round(trigger / 2), trigger - PREPARE_HEADROOM_TOKENS)
  let live: Message[] = []
  let compactions = 0
  let preparedThisCycle = false
  for (const m of raw) {
    live.push(m)
    const size = tokens(live)
    if (values.background && size >= prepareAt && size < trigger && !preparedThisCycle) {
      preparedThisCycle = true
      const prepared = await prepare(
        { sessionKey: key, messages: live, api: apiForm(live, blocks), showCommand: SHOW_COMMAND(key) },
        config,
        ledgerFn
      )
      process.stdout.write(`   prepare at ${Math.round(size / 1000)}k: ${JSON.stringify(prepared)}\n`)
    }
    if (size < trigger) continue
    preparedThisCycle = false
    let result
    try {
      result = await compact(
        { sessionKey: key, messages: live, api: apiForm(live, blocks), showCommand: SHOW_COMMAND(key), ...(values.background ? { ledgerMode: 'ready' as const } : {}) },
        config,
        ledgerFn
      )
    } catch (error) {
      if (!(error instanceof DeclineError)) throw error
      // Live, the plugin falls back to the built-in compactor here; replay can only stop.
      process.stdout.write(`#${compactions + 1} declined, stopping: ${error.message}\n`)
      break
    }
    live = result.entries.map(e => ('keep' in e ? live[e.keep] : e.built))
    compactions++
    process.stdout.write(`#${compactions} ${summarize(result.stats)}\n`)
    // As the plugin does: a ready compaction that left the ledger behind catches it up through the committed cut.
    if (values.background && result.stats.ledgerThrough < result.stats.cut) {
      const caught = await prepare({ sessionKey: key, through: result.stats.cut }, config, ledgerFn)
      process.stdout.write(`   catch-up: ${JSON.stringify(caught)}\n`)
    }
  }
  process.stdout.write(`end: live ${tokens(live).toLocaleString('en-US')} est. tokens after ${compactions} compactions\n`)
  if (values.keep) process.stdout.write(`data kept in ${dataDir}\n`)
  else rmSync(dataDir, { recursive: true, force: true })
}

const [command, ...rest] = process.argv.slice(2)
const commands: Record<string, (argv: string[]) => unknown> = {
  compact: runCompact,
  prepare: runPrepare,
  'ledger-plan': runLedgerPlan,
  'ledger-save': runLedgerSave,
  show: runShow,
  search: runSearch,
  status: runStatus,
  replay: runReplay
}
const run = command ? commands[command] : undefined
if (!run) fail(command ? `unknown command: ${command}` : 'no command given')
// Exit 3 means strata declined (too big, or thinking it cannot keep): the plugin
// falls back to the built-in compactor either way.
const EXIT_DECLINED = 3
Promise.resolve(run(rest)).catch(error => {
  process.stderr.write(`[strata] ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(error instanceof DeclineError ? EXIT_DECLINED : 1)
})
