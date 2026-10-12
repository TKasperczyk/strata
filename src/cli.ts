#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join, resolve } from 'path'
import { parseArgs } from 'util'
import { readArchive, sessionDir } from './archive.js'
import { compact, DeclineError, prepare, type CompactStats, type LedgerFn } from './compact.js'
import { estimateTokens, loadConfig } from './config.js'
import { messageChars, renderMessage } from './mask.js'
import { apiForm, readTranscriptWithBlocks } from './transcript.js'
import { DEFAULT_THINKING_CHARS_PER_TOKEN, hiddenByRow, type ApiMessage, type UsageReading } from './weights.js'
import type { Message } from './types.js'

const USAGE = `strata - layered, budget-bounded compaction for Claude Code

  strata compact --session <key> --in <messages.json|-> --out <result.json|-> [--instructions <text>] [--budget <tokens>] [--ledger sync|ready]
  strata prepare --session <key> --in <messages.json|-> [--budget <tokens>]
  strata show <session-key> <seq> [<last-seq>]
  strata replay <transcript.jsonl> [--budget <tokens>] [--trigger <tokens>] [--no-llm] [--keep] [--background]

Data lives in $STRATA_DATA_DIR (default ~/.strata).`

const SELF = resolve(process.argv[1])
const SHOW_COMMAND = (key: string) => `node ${SELF} show ${key}`

/** Offline stand-in for the ledger model: records how far it got, so lag is visible. */
const noLedger: LedgerFn = async (previous, span) => ({ ledger: `${previous}\n- folded through #${span.at(-1)?.seq}`.trim(), requests: 1 })

function fail(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}\n`)
  process.exit(2)
}

function budgetOverride(raw: string | undefined): { budgetTokens?: number } {
  if (raw === undefined) return {}
  const n = Number.parseInt(raw, 10)
  if (!(n > 0)) fail(`--budget must be a positive integer, got ${raw}`)
  return { budgetTokens: n }
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
      ledger: { type: 'string' }
    }
  })
  if (!values.session || !values.in || !values.out) fail('compact needs --session, --in and --out')
  if (values.ledger !== undefined && values.ledger !== 'sync' && values.ledger !== 'ready') fail(`--ledger must be sync or ready, got ${values.ledger}`)
  const config = loadConfig(budgetOverride(values.budget))
  // `-` reads stdin / writes stdout, which is how the plugin calls it.
  const { messages, api, usage } = JSON.parse(readFileSync(values.in === '-' ? 0 : values.in, 'utf-8')) as {
    messages: Message[]
    api?: ApiMessage[]
    usage?: UsageReading
  }
  const result = await compact(
    {
      sessionKey: values.session,
      messages,
      ...(values.instructions ? { instructions: values.instructions } : {}),
      ...(values.ledger ? { ledgerMode: values.ledger } : {}),
      ...(api ? { api } : {}),
      ...(usage ? { usage } : {}),
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
  const { values } = parseArgs({ args: argv, options: { session: { type: 'string' }, in: { type: 'string' }, budget: { type: 'string' } } })
  if (!values.session || !values.in) fail('prepare needs --session and --in')
  const { messages } = JSON.parse(readFileSync(values.in === '-' ? 0 : values.in, 'utf-8')) as { messages: Message[] }
  const result = await prepare({ sessionKey: values.session, messages, showCommand: SHOW_COMMAND(values.session) }, loadConfig(budgetOverride(values.budget)))
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function runShow(argv: string[]): void {
  const [key, first, last] = argv
  if (!key || first === undefined) fail('show needs <session-key> <seq>')
  const from = Number.parseInt(first, 10)
  const to = last === undefined ? from : Number.parseInt(last, 10)
  const archive = readArchive(sessionDir(loadConfig().dataDir, key))
  const picked = archive.filter(m => m.seq >= from && m.seq <= to)
  if (picked.length === 0) fail(`no archived messages in seq ${from}-${to} (archive holds ${archive.length})`)
  process.stdout.write(picked.map(m => renderMessage(m, m.seq)).join('\n\n') + '\n')
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
  const trigger = values.trigger ? Number.parseInt(values.trigger, 10) : config.budgetTokens * 2
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
      const prepared = await prepare({ sessionKey: key, messages: live, showCommand: SHOW_COMMAND(key) }, config, ledgerFn)
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
    // As the plugin does: a ready compaction that left the ledger behind catches it up from its own output.
    if (values.background && result.stats.ledgerThrough < result.stats.cut) {
      const caught = await prepare({ sessionKey: key, messages: live, showCommand: SHOW_COMMAND(key) }, config, ledgerFn)
      process.stdout.write(`   catch-up: ${JSON.stringify(caught)}\n`)
    }
  }
  process.stdout.write(`end: live ${tokens(live).toLocaleString('en-US')} est. tokens after ${compactions} compactions\n`)
  if (values.keep) process.stdout.write(`data kept in ${dataDir}\n`)
  else rmSync(dataDir, { recursive: true, force: true })
}

const [command, ...rest] = process.argv.slice(2)
const commands: Record<string, (argv: string[]) => unknown> = { compact: runCompact, prepare: runPrepare, show: runShow, replay: runReplay }
const run = command ? commands[command] : undefined
if (!run) fail(command ? `unknown command: ${command}` : 'no command given')
// Exit 3 means strata declined (too big, or thinking it cannot keep): the plugin
// falls back to the built-in compactor either way.
const EXIT_DECLINED = 3
Promise.resolve(run(rest)).catch(error => {
  process.stderr.write(`[strata] ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(error instanceof DeclineError ? EXIT_DECLINED : 1)
})
