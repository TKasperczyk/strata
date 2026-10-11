import { appendArchive, archivePath, fingerprint, matchedPrefix, numberMessages, readArchive, readState, sessionDir, writeState } from './archive.js'
import { budgetChars, shareChars, type Config } from './config.js'
import { renderIndex, segmentEpisodes } from './episodes.js'
import { ledgerRequests, updateLedger, type LedgerUpdate } from './ledger.js'
import { messageChars } from './mask.js'
import { compatibleReady, prefixHash, tryLock, writeReady } from './ready.js'
import type { ArchivedMessage, Message, OutputEntry, OutputRecord, SessionState } from './types.js'
import { isPrompt as isUnitPrompt, rebuildUnit, segmentUnits, unitChars, type Unit } from './units.js'

export const HEADER_MARK = '[strata: compacted conversation]'

export type CompactInput = {
  sessionKey: string
  messages: Message[]
  instructions?: string
  /** How the model can print one archived message, e.g. `strata show <key> <seq>`. */
  showCommand: string
  /**
   * `sync` (default) brings the ledger up to the cut with model calls; `ready`
   * uses the newest ledger already prepared and calls no model, so the
   * compaction is instant and the ledger may lag the cut.
   */
  ledgerMode?: 'sync' | 'ready'
}

export type CompactStats = {
  archived: number
  newRaw: number
  /** Leading input messages that repeated our last output. */
  matched: number
  /** True when the whole last output came back unchanged (the normal case). */
  matchedPrevious: boolean
  /** Length of the last output (0 on a session's first compaction). */
  previousOutput: number
  branch: number
  cut: number
  tailStart: number
  rawChars: number
  outputChars: number
  layers: { header: number; middle: number; tail: number }
  ledgerRequests: number
  /** Branch rows the ledger covers; less than `cut` when it lags. */
  ledgerThrough: number
  ledgerError?: string
}

export type CompactResult = { entries: OutputEntry[]; stats: CompactStats }

export type LedgerFn = (previous: string, span: ArchivedMessage[], config: Config, focus?: string) => Promise<LedgerUpdate>

/** strata declines this compaction; the caller should run the built-in compactor. */
export class DeclineError extends Error {}

/** What must stay verbatim (the latest response) is larger than the whole budget. */
export class OversizeError extends DeclineError {}

/** The latest response's thinking can only be kept by the engine's own rows, and some are gone. */
export class UnpreservableError extends DeclineError {}

function isPrompt(m: Message): boolean {
  return m.role === 'user' && m.text.trim() !== '' && !(m.toolResults?.length)
}

type Reconciled = {
  all: ArchivedMessage[]
  /** New messages, numbered but not yet written: the archive grows only when a compaction succeeds. */
  pending: ArchivedMessage[]
  branch: number[]
  /** Input index of each archive seq the engine handed over as its own message. */
  inputBySeq: Map<number, number>
  matched: number
  /** The branch no longer holds everything the ledger was built from. */
  ledgerStale: boolean
}

/**
 * Work out the active branch from the input. The leading messages that repeat
 * our last output stand for the branch prefix they covered (all of it when the
 * whole output came back; less after a rewind); everything after them is new.
 */
function reconcile(dir: string, input: Message[], state: SessionState): Reconciled {
  const archive = readArchive(dir)
  const matched = matchedPrefix(input, state)
  const base = matched > 0 ? state.branch.slice(0, state.lastOutput[matched - 1].upto) : []
  const inputBySeq = new Map<number, number>()
  for (let i = 0; i < matched; i++) {
    if (state.lastOutput[i].seq >= 0) inputBySeq.set(state.lastOutput[i].seq, i)
  }
  // A stray header of ours past the matched part is derived content, never history.
  const fresh = input.map((_, i) => i).slice(matched).filter(i => !input[i].text.startsWith(HEADER_MARK))
  const pending = numberMessages(archive.length, fresh.map(i => input[i]))
  fresh.forEach((inputIndex, k) => inputBySeq.set(pending[k].seq, inputIndex))
  return {
    all: [...archive, ...pending],
    pending,
    branch: [...base, ...pending.map(m => m.seq)],
    inputBySeq,
    matched,
    ledgerStale: base.length < state.ledgerThrough
  }
}

const SECTION_TITLE_SLACK = 200

function headerPreamble(input: CompactInput, dir: string): string {
  return `${HEADER_MARK} Older turns of this session were moved out of context. Every message's text is archived in ${archivePath(dir)} (one JSON message per line; line N+1 is seq N). Print one with \`${input.showCommand} <seq> [<last-seq>]\`. "[strata elided …]" markers in the turns below point to archived tool results; read the archive or re-run the tool when you need the exact text. Never treat the index or ledger as proof that work happened: verify against files, git, or the archive before relying on it.`
}

function buildHeader(input: CompactInput, dir: string, evicted: ArchivedMessage[], ledger: string, ledgerThrough: number, config: Config): string {
  const pinned = evicted.find(isPrompt)
  const sections = [headerPreamble(input, dir)]
  if (pinned) sections.push(`## Original request (seq ${pinned.seq})\n${pinned.text.slice(0, shareChars(config, 'pinned'))}`)
  if (ledger) {
    // A ledger that lags the cut says so, so the gap is looked up, not assumed empty.
    const lag = ledgerThrough < evicted.length
      ? `\n\n(This ledger covers archived history only up to seq ${evicted[Math.max(0, ledgerThrough - 1)]?.seq ?? 0}; for seq ${evicted[ledgerThrough]?.seq} onward use the episode index and the archive.)`
      : ''
    sections.push(`## Session ledger\n${ledger}${lag}`)
  }
  const index = renderIndex(segmentEpisodes(evicted), shareChars(config, 'index'))
  if (index) sections.push(`## Archived episodes (oldest first)\n${index}`)
  return sections.join('\n\n')
}

/** A true upper bound on the header without its ledger: every other part is hard-capped. */
function headerBoundWithoutLedger(input: CompactInput, dir: string, config: Config): number {
  const LAG_NOTE_CHARS = 200
  return headerPreamble(input, dir).length + shareChars(config, 'pinned') + shareChars(config, 'index') + SECTION_TITLE_SLACK + LAG_NOTE_CHARS
}

/** The ledger shown in the header, cut to the room the rest of the output leaves. */
function fitLedger(ledger: string, room: number): string {
  const MIN_USEFUL = 200
  if (ledger.length <= room) return ledger
  if (room < MIN_USEFUL) return ''
  const NOTE = '\n…[ledger cut to fit this compaction]'
  return `${ledger.slice(0, room - NOTE.length)}${NOTE}`
}

type Layout = { cut: number; tail: number }

/**
 * Choose, in whole units, what is evicted (< cut), masked (cut..tail) and
 * verbatim (>= tail), then shed until the total fits `budget`: evict the
 * oldest masked unit, else move the oldest verbatim unit into the masked
 * layer. Units from `protectedFrom` on always stay verbatim.
 */
function layout(verbatim: number[], masked: number[], protectedFrom: number, header: number, budget: number, config: Config): Layout {
  const { pinned, ledger, index, middle } = config.shares
  const full = budgetChars(config)
  const sum = (sizes: number[], from: number, to: number) => sizes.slice(from, to).reduce((a, b) => a + b, 0)
  const fill = (sizes: number[], end: number, cap: number) => {
    let start = end
    while (start > 0 && sum(sizes, start - 1, end) <= cap) start--
    return start
  }
  let tail = Math.min(fill(verbatim, verbatim.length, full * (1 - pinned - ledger - index - middle)), protectedFrom)
  let cut = fill(masked, tail, full * middle)
  const total = () => (cut > 0 ? header : 0) + sum(masked, cut, tail) + sum(verbatim, tail, verbatim.length)
  while (total() > budget) {
    if (cut < tail) cut++
    else if (tail < protectedFrom) tail++
    else {
      const kept = sum(verbatim, protectedFrom, verbatim.length)
      throw new OversizeError(`the latest response needs ~${kept} chars verbatim${cut > 0 ? ` plus a ${header}-char header` : ''}, over the ${budget}-char budget`)
    }
  }
  return { cut, tail }
}

/**
 * The first unit that must stay verbatim, and whether it is protected for its
 * thinking: the unit holding the latest response's opening thinking row (an
 * assistant row with no text and no calls), else the last unit. Rebuilt
 * messages lose thinking blocks, and with manual extended thinking the final
 * assistant turn must keep its own.
 */
function protectedUnit(rows: Message[], units: Unit[]): { from: number; thinking: boolean } {
  let lastPrompt = -1
  rows.forEach((m, i) => {
    if (isUnitPrompt(m)) lastPrompt = i
  })
  let thinking = -1
  for (let i = rows.length - 1; i > lastPrompt; i--) {
    const m = rows[i]
    if (m.role === 'assistant' && !m.text.trim() && m.toolUses.length === 0) {
      thinking = i
      break
    }
  }
  if (thinking < 0) return { from: units.length - 1, thinking: false }
  return { from: units.findIndex(u => u.start <= thinking && thinking < u.end), thinking: true }
}

type LedgerState = { ledger: string; ledgerThrough: number; ledgerAge: number; requests: number; error?: string }

/**
 * The newest ledger that still fits this branch: the committed one, unless a
 * rewind made it stale, or the background worker's, when it covers more.
 */
function bestLedger(dir: string, state: SessionState, rows: ArchivedMessage[], ledgerStale: boolean): LedgerState {
  // After a rewind the old ledger may describe the abandoned branch: drop it,
  // and the empty ledger forces a full rebuild until one succeeds.
  const committed: LedgerState = ledgerStale
    ? { ledger: '', ledgerThrough: 0, ledgerAge: 0, requests: 0 }
    : { ledger: state.ledger, ledgerThrough: state.ledgerThrough, ledgerAge: state.ledgerAge, requests: 0 }
  const ready = compatibleReady(dir, rows)
  if (ready && ready.ledger && (!committed.ledger || ready.through > committed.ledgerThrough)) {
    return { ledger: ready.ledger, ledgerThrough: ready.through, ledgerAge: ready.age, requests: 0 }
  }
  return committed
}

/** Bring `base` up to `cutRow` with model calls. Failure keeps the cursor where it was. */
async function advanceLedger(
  base: LedgerState,
  rows: ArchivedMessage[],
  cutRow: number,
  config: Config,
  ledgerFn: LedgerFn,
  focus?: string
): Promise<LedgerState> {
  if (cutRow === 0 || (base.ledger && cutRow <= base.ledgerThrough)) return base
  const due = !base.ledger || (config.ledgerRebuildEvery > 0 && base.ledgerAge + 1 >= config.ledgerRebuildEvery)
  // A rebuild of a very long history costs more each time: past the cap, update instead.
  const rebuild = !base.ledger || (due && ledgerRequests(rows.slice(0, cutRow), config) <= config.ledgerRebuildMaxRequests)
  try {
    const update = rebuild
      ? await ledgerFn('', rows.slice(0, cutRow), config, focus)
      : await ledgerFn(base.ledger, rows.slice(base.ledgerThrough, cutRow), config, focus)
    return { ledger: update.ledger, ledgerThrough: cutRow, ledgerAge: rebuild ? 0 : base.ledgerAge + 1, requests: update.requests }
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) }
  }
}

type Plan = {
  dir: string
  state: SessionState
  reconciled: Reconciled
  rows: ArchivedMessage[]
  units: Unit[]
  handles: Array<Array<number | undefined>>
  whole: boolean[]
  rawBuilt: Message[][]
  maskedBuilt: Message[][]
  verbatim: number[]
  cut: number
  tail: number
  cutRow: number
}

/** Everything a compaction decides, computed without writing anything. */
function planCompaction(input: CompactInput, config: Config): Plan {
  const dir = sessionDir(config.dataDir, input.sessionKey)
  const state = readState(dir)
  const reconciled = reconcile(dir, input.messages, state)
  const { all, branch, inputBySeq } = reconciled
  const rows = branch.map(seq => all[seq])
  const units = segmentUnits(rows, rows.map(m => inputBySeq.has(m.seq)))
  if (units.length === 0) throw new Error('nothing to compact')

  // Size each unit as it would actually be emitted: the engine's own rows when
  // every row has a handle (unanswered calls included), else the rebuild.
  const handles = units.map(u => rows.slice(u.start, u.end).map(m => inputBySeq.get(m.seq)))
  const whole = handles.map(h => h.every(i => i !== undefined))
  const guard = protectedUnit(rows, units)
  if (guard.thinking && whole.slice(guard.from).some(w => !w)) {
    throw new UnpreservableError('the latest response opens with thinking that only the engine still holds, and part of it was already rebuilt')
  }
  const rawBuilt = units.map(u => rebuildUnit(rows.slice(u.start, u.end), 'raw', config))
  const maskedBuilt = units.map(u => rebuildUnit(rows.slice(u.start, u.end), 'masked', config))
  const verbatim = units.map((u, k) => (whole[k] ? rows.slice(u.start, u.end).reduce((n, m) => n + messageChars(m), 0) : unitChars(rawBuilt[k])))
  const budget = budgetChars(config)
  const fixed = [verbatim, maskedBuilt.map(unitChars), guard.from, headerBoundWithoutLedger(input, dir, config)] as const
  // Leave the ledger its share when there is room; squeeze it out before giving up.
  let picked: Layout
  try {
    picked = layout(...fixed, budget - shareChars(config, 'ledger'), config)
  } catch (error) {
    if (!(error instanceof OversizeError)) throw error
    picked = layout(...fixed, budget, config)
  }
  return { dir, state, reconciled, rows, units, handles, whole, rawBuilt, maskedBuilt, verbatim, ...picked, cutRow: units[picked.cut].start }
}

export async function compact(input: CompactInput, config: Config, ledgerFn: LedgerFn = updateLedger): Promise<CompactResult> {
  const plan = planCompaction(input, config)
  const { dir, state, rows, units, handles, whole, rawBuilt, maskedBuilt, verbatim, cut, tail, cutRow } = plan
  const { all, pending, branch, matched, ledgerStale } = plan.reconciled
  const tailRow = units[tail].start
  const budget = budgetChars(config)

  const base = bestLedger(dir, state, rows, ledgerStale)
  const ledger = input.ledgerMode === 'ready' ? base : await advanceLedger(base, rows, cutRow, config, ledgerFn, input.instructions)

  const entries: OutputEntry[] = []
  const records: OutputRecord[] = []
  const layers = { header: 0, middle: 0, tail: 0 }
  const emitBuilt = (m: Message, upto: number, layer: keyof typeof layers) => {
    entries.push({ built: m })
    records.push({ fp: fingerprint(m), upto, seq: -1 })
    layers[layer] += messageChars(m)
  }
  const body: Array<() => void> = []
  for (let u = cut; u < tail; u++) {
    for (const m of maskedBuilt[u]) body.push(() => emitBuilt(m, units[u].end, 'middle'))
  }
  for (let u = tail; u < units.length; u++) {
    const { start, end } = units[u]
    if (whole[u]) {
      // The engine's own rows, whole and in order: thinking, images and response grouping intact.
      handles[u].forEach((inputIndex, k) => {
        body.push(() => {
          entries.push({ keep: inputIndex! })
          records.push({ fp: fingerprint(input.messages[inputIndex!]), upto: start + k + 1, seq: rows[start + k].seq })
          layers.tail += messageChars(rows[start + k])
        })
      })
    } else {
      for (const m of rawBuilt[u]) body.push(() => emitBuilt(m, end, 'tail'))
    }
  }
  if (cutRow > 0) {
    const evicted = rows.slice(0, cutRow)
    const bodyChars = maskedBuilt.slice(cut, tail).reduce((n, b) => n + unitChars(b), 0) + verbatim.slice(tail).reduce((a, b) => a + b, 0)
    const withoutLedger = buildHeader(input, dir, evicted, '', ledger.ledgerThrough, config).length
    const shown = fitLedger(ledger.ledger, budget - bodyChars - withoutLedger - SECTION_TITLE_SLACK)
    emitBuilt({ role: 'user', text: buildHeader(input, dir, evicted, shown, ledger.ledgerThrough, config), toolUses: [] }, cutRow, 'header')
  }
  for (const emit of body) emit()

  const outputChars = layers.header + layers.middle + layers.tail
  if (outputChars > budget) throw new OversizeError(`assembled output is ${outputChars} chars, over the ${budget}-char budget`)

  // Commit only now: a rejected compaction leaves archive and state untouched.
  appendArchive(dir, pending)
  writeState(dir, {
    branch,
    lastOutput: records,
    ledger: ledger.ledger,
    ledgerThrough: ledger.ledgerThrough,
    ledgerAge: ledger.ledgerAge,
    compactions: state.compactions + 1
  })

  return {
    entries,
    stats: {
      archived: all.length,
      newRaw: pending.length,
      matched,
      matchedPrevious: state.lastOutput.length > 0 && matched === state.lastOutput.length,
      previousOutput: state.lastOutput.length,
      branch: branch.length,
      cut: cutRow,
      tailStart: tailRow,
      rawChars: rows.reduce((n, m) => n + messageChars(m), 0),
      outputChars,
      layers,
      ledgerRequests: ledger.requests,
      ledgerThrough: ledger.ledgerThrough,
      ...(ledger.error ? { ledgerError: ledger.error } : {})
    }
  }
}

export type PrepareResult =
  | { prepared: true; through: number; requests: number }
  | { prepared: false; reason: string }

/**
 * Background ledger preparation over a snapshot of the conversation: plan the
 * compaction that would happen now and fold everything it would evict into a
 * ready ledger. Writes only the ready-ledger file, never the archive or state,
 * so it can run while the session goes on and while a compaction commits.
 */
export async function prepare(input: CompactInput, config: Config, ledgerFn: LedgerFn = updateLedger): Promise<PrepareResult> {
  const plan = planCompaction(input, config)
  const { dir, state, rows, cutRow } = plan
  const base = bestLedger(dir, state, rows, plan.reconciled.ledgerStale)
  const awaiting = rows.slice(base.ledgerThrough, cutRow).reduce((n, m) => n + messageChars(m), 0)
  if (base.ledger && awaiting < config.prepareMinChars) return { prepared: false, reason: `only ${awaiting} chars await the ledger` }
  const release = tryLock(dir)
  if (!release) return { prepared: false, reason: 'another prepare job is running' }
  try {
    const next = await advanceLedger(base, rows, cutRow, config, ledgerFn, input.instructions)
    if (next.error) return { prepared: false, reason: `ledger update failed: ${next.error}` }
    if (next.ledgerThrough === base.ledgerThrough && next.ledger === base.ledger) return { prepared: false, reason: 'nothing new to fold in' }
    writeReady(dir, {
      ledger: next.ledger,
      through: next.ledgerThrough,
      prefixHash: prefixHash(rows, next.ledgerThrough),
      age: next.ledgerAge,
      preparedAt: new Date().toISOString()
    })
    return { prepared: true, through: next.ledgerThrough, requests: next.requests }
  } finally {
    release()
  }
}
