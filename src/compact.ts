import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { appendArchive, archivePath, fingerprint, matchedPrefix, numberMessages, readArchive, readState, sessionDir, writeState } from './archive.js'
import { budgetChars, shareChars, type Config } from './config.js'
import { renderEpisode, renderIndex, segmentEpisodes } from './episodes.js'
import { LEDGER_SYSTEM_PROMPT, ledgerMaskConfig, ledgerMaxTokens, ledgerRequests, renderSpan, trimLedger, updateLedger, type LedgerUpdate } from './ledger.js'
import { maskMessage, messageChars, renderMessage, safeSlicePrefix } from './mask.js'
import { acquireLock, compatibleReady, prefixHash, tryLock, writeReady } from './ready.js'
import { HEADER_MARK, type ArchivedMessage, type Message, type OutputEntry, type OutputRecord, type SessionState } from './types.js'
import { isPrompt as isUnitPrompt, rebuildUnit, segmentUnits, type Unit } from './units.js'
import { calibratedTextChars, calibrateWeights, hiddenByRow, hiddenChars, type ApiMessage, type Hidden, type UsageReading } from './weights.js'

export { HEADER_MARK }

export type PreparedLedger = {
  ledger: string
  through: number
  prefixHash: string
  age: number
  requests: number
}

export type CompactInput = {
  sessionKey: string
  messages: Message[]
  instructions?: string
  /** How the model can print one archived message, e.g. `strata show <key> <seq>`. */
  showCommand: string
  /** When true, the compaction header advertises the native `mcp__strata__show`/`search` tools. */
  hasNativeTools?: boolean
  /**
   * `sync` (default) brings the ledger up to the cut with model calls; `ready`
   * uses the newest ledger already prepared and calls no model, so the
   * compaction is instant and the ledger may lag the cut.
   */
  ledgerMode?: 'sync' | 'ready'
  /**
   * Pre-computed ledger produced by the host plugin via `$.model.complete`.
   * Adopted directly when its `prefixHash` matches the planned branch prefix.
   */
  preparedLedger?: PreparedLedger
  /** Error reported by the host plugin's ledger model call, surfaced in stats. */
  ledgerError?: string
  /**
   * The same conversation in Messages API form, and the engine's real token
   * figures: what lets strata count the images and thinking the rows leave
   * out, and archive the images. Without them strata budgets text alone.
   */
  api?: ApiMessage[]
  usage?: UsageReading
}

export type PrepareInput =
  | (CompactInput & { through?: undefined })
  | {
      sessionKey: string
      /** Explicit committed branch row count to catch the ledger up through (reads archive + state directly). */
      through: number
      instructions?: string
      showCommand?: string
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
  /** Of the tail, what images and thinking weigh (char units): invisible in the rows. */
  hiddenChars: number
  /** Thinking signature chars per token, calibrated against the real window. */
  thinkingRatio: number
  /** Visible-text chars per token, calibrated against the real window. */
  charsPerToken: number
  /** Images saved to the archive's media folder by this compaction. */
  mediaSaved: number
  ledgerRequests: number
  /** Branch rows the ledger covers; less than `cut` when it lags. */
  ledgerThrough: number
  ledgerError?: string
}

export type CompactResult = { entries: OutputEntry[]; stats: CompactStats }

export type LedgerFn = (previous: string, span: ArchivedMessage[], config: Config, focus?: string) => Promise<LedgerUpdate>

export type LedgerPlan =
  | { needed: false; reason: string }
  | {
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

/** strata declines this compaction; the caller should run the built-in compactor. */
export class DeclineError extends Error {}

/** What must stay verbatim (the latest response) is larger than the whole budget. */
export class OversizeError extends DeclineError {}

/** The latest response's thinking can only be kept by the engine's own rows, and some are gone. */
export class UnpreservableError extends DeclineError {}

const MEDIA_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp'
}

export function mediaExtension(mediaType: string): string {
  const mime = mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (MEDIA_EXT[mime]) return MEDIA_EXT[mime]
  const raw = mime.split('/')[1]?.replace(/[^a-z0-9]/g, '').slice(0, 8)
  return raw || 'png'
}

function isPrompt(m: Message): boolean {
  return m.role === 'user' && m.text.trim() !== '' && !(m.toolResults?.length)
}

type Reconciled = {
  all: ArchivedMessage[]
  bySeq: Map<number, ArchivedMessage>
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
  const nextSeq = archive.reduce((max, m) => Math.max(max, m.seq + 1), archive.length)
  const pending = numberMessages(nextSeq, fresh.map(i => input[i]))
  fresh.forEach((inputIndex, k) => inputBySeq.set(pending[k].seq, inputIndex))
  const all = [...archive, ...pending]
  const bySeq = new Map<number, ArchivedMessage>(all.map(m => [m.seq, m]))
  const branch = [...base, ...pending.map(m => m.seq)].filter(seq => bySeq.has(seq))
  return {
    all,
    bySeq,
    pending,
    branch,
    inputBySeq,
    matched,
    ledgerStale: base.length < state.ledgerThrough
  }
}

function headerPreamble(input: CompactInput, dir: string): string {
  const access = input.hasNativeTools
    ? `Inspect archived messages with \`mcp__strata__show\` (supports \`seq\`, \`last_seq\`, \`offset\`, \`limit\`) or search the active branch with \`mcp__strata__search\`, or run \`${input.showCommand} <seq> [<last-seq>]\`.`
    : `Print one with \`${input.showCommand} <seq> [<last-seq>]\`.`
  return `${HEADER_MARK} Older turns of this session were moved out of context. Every message's text is archived in ${archivePath(dir)} (one JSON message per line; line N+1 is seq N), and its images as files under ${join(dir, 'media')}. ${access} "[strata elided …]" markers in the turns below point to archived tool results; read the archive or re-run the tool when you need the exact text. Never treat the index or ledger as proof that work happened: verify against files, git, or the archive before relying on it.`
}

function buildHeader(
  input: CompactInput,
  dir: string,
  evicted: ArchivedMessage[],
  ledger: string,
  ledgerThrough: number,
  config: Config
): string {
  const pinned = evicted.find(isPrompt)
  const sections = [headerPreamble(input, dir)]
  if (pinned) sections.push(`## Original request (seq ${pinned.seq})\n${safeSlicePrefix(pinned.text, shareChars(config, 'pinned'))}`)
  if (ledger) {
    // A ledger that lags the cut says so, so the gap is looked up, not assumed empty.
    const lag = ledgerThrough < evicted.length
      ? `\n\n(This ledger covers archived history only up to seq ${evicted[Math.max(0, ledgerThrough - 1)]?.seq ?? 0}; for seq ${evicted[ledgerThrough]?.seq} onward use the episode index and the archive.)`
      : ''
    sections.push(`## Session ledger\n${ledger}${lag}`)
  }
  const protectAfterSeq = ledgerThrough < evicted.length ? evicted[ledgerThrough]?.seq : undefined
  const index = renderIndex(segmentEpisodes(evicted), shareChars(config, 'index'), { protectAfterSeq })
  if (index) sections.push(`## Archived episodes (oldest first)\n${index}`)
  return sections.join('\n\n')
}

/** The ledger shown in the header, cut section-aware to the room the rest of the output leaves. */
function fitLedger(ledger: string, room: number): string {
  const MIN_USEFUL = 200
  if (ledger.length <= room) return ledger
  if (room < MIN_USEFUL) return ''
  return trimLedger(ledger, room, '\n…[ledger cut to fit this compaction]')
}

type Layout = { cut: number; tail: number }

/**
 * Choose, in whole units, what is evicted (< cut), masked (cut..tail) and
 * verbatim (>= tail). Unused header slack flows first to the verbatim tail
 * (above the masked middle's share target) and then — along with any tail unit
 * quantization slack — to the masked middle, rather than hard-capping layers
 * against worst-case header bounds. Units from `protectedFrom` on always stay
 * verbatim.
 */
function layout(
  verbatim: number[],
  masked: number[],
  protectedFrom: number,
  headerAt: (cut: number) => number,
  budget: number,
  config: Config
): Layout {
  const { pinned, ledger, index, middle } = config.shares
  const tailShare = Math.max(0.1, 1 - pinned - ledger - index - middle)
  const tailFraction = tailShare / (tailShare + middle)
  const middleFloor = budget * middle * 0.5
  const sum = (sizes: number[], from: number, to: number) => sizes.slice(from, to).reduce((a, b) => a + b, 0)
  const fill = (sizes: number[], end: number, cap: number) => {
    let start = end
    let acc = 0
    while (start > 0 && acc + sizes[start - 1] <= cap) {
      start--
      acc += sizes[start]
    }
    return start
  }

  const fitsWithoutEviction = sum(masked, 0, protectedFrom) + sum(verbatim, protectedFrom, verbatim.length) <= budget
  let h = fitsWithoutEviction || protectedFrom === 0 ? 0 : headerAt(protectedFrom)
  let tail = protectedFrom
  let cut = 0
  for (let iter = 0; iter < 4; iter++) {
    const available = Math.max(0, budget - h)
    // Unused header slack flows proportionally to tail (~71%) and middle (~29%).
    const tailCap = available * tailFraction
    tail = Math.min(fill(verbatim, verbatim.length, tailCap), protectedFrom)
    let tailUsed = sum(verbatim, tail, verbatim.length)
    // If a single large unit just before tail left the verbatim tail starved (< half its share),
    // let tail absorb that unit as long as the masked middle keeps at least half its nominal share.
    if (tail > 0 && tailUsed < tailCap * 0.5 && tailUsed + verbatim[tail - 1] <= available - middleFloor) {
      tail--
      tailUsed += verbatim[tail]
    }
    // Unused tail quantization slack flows into the masked middle.
    const middleCap = Math.max(0, available - tailUsed)
    cut = fill(masked, tail, middleCap)
    const nextH = cut > 0 ? headerAt(cut) : 0
    if (nextH === h) break
    h = nextH
  }

  const total = () => (cut > 0 ? headerAt(cut) : 0) + sum(masked, cut, tail) + sum(verbatim, tail, verbatim.length)
  while (total() > budget) {
    if (cut < tail) cut++
    else if (tail < protectedFrom) tail++
    else {
      const kept = sum(verbatim, protectedFrom, verbatim.length)
      const hdr = cut > 0 ? headerAt(cut) : 0
      throw new OversizeError(`the latest response needs ~${kept} chars verbatim${cut > 0 ? ` plus a ${hdr}-char header` : ''}, over the ${budget}-char budget`)
    }
  }

  // Pack any remaining slack into additional masked middle units using the exact header size.
  while (cut > 0) {
    const candidate = cut - 1
    const nextTotal = (candidate > 0 ? headerAt(candidate) : 0) + sum(masked, candidate, tail) + sum(verbatim, tail, verbatim.length)
    if (nextTotal <= budget) cut = candidate
    else break
  }

  // When nothing is evicted (cut === 0) and masked middle leaves room unused, let
  // unused middle slack promote turns back into the verbatim tail (up to budget - middleFloor).
  while (cut === 0 && tail > 0) {
    const nextTailUsed = sum(verbatim, tail - 1, verbatim.length)
    const nextTotal = sum(masked, 0, tail - 1) + nextTailUsed
    if (nextTotal <= budget && nextTailUsed <= budget - middleFloor) tail--
    else break
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

type LedgerWork = {
  previous: string
  span: ArchivedMessage[]
  chunks: string[]
  focus?: string
  targetThrough: number
  nextAge: number
}

/**
 * Decide whether the ledger needs updating and what span/chunks to fold in.
 * Shared by `advanceLedger` (sync CLI), `prepare` (background CLI) and
 * `planLedger` (plugin `$.model.complete`). Honours explicit `focus` even when
 * `base.ledger` already covers `cutRow`.
 */
function chooseLedgerWork(
  base: LedgerState,
  rows: ArchivedMessage[],
  cutRow: number,
  config: Config,
  focus: string | undefined,
  enforceMinChars: boolean
): { work?: LedgerWork; reason?: string } {
  const cleanFocus = focus?.trim() || undefined
  if (cutRow <= 0) return { reason: 'nothing evicted yet' }
  if (enforceMinChars && base.ledger && !cleanFocus) {
    const awaiting = rows.slice(base.ledgerThrough, cutRow).reduce((n, m) => n + messageChars(m), 0)
    if (awaiting < config.prepareMinChars) return { reason: `only ${awaiting} chars await the ledger` }
  }
  if (base.ledger && cutRow <= base.ledgerThrough && !cleanFocus) return { reason: 'ledger already covers the cut' }

  let previous: string
  let span: ArchivedMessage[]
  let chunks: string[]
  let nextAge: number

  if (base.ledger && cutRow <= base.ledgerThrough && cleanFocus) {
    // Explicit `/compact <instructions>` when the ledger already covers cutRow:
    // refocus the ledger against the evicted history (bounded by rebuild cap).
    const fullSpan = rows.slice(0, cutRow)
    const fullChunks = renderSpan(fullSpan, config)
    const maxChunks = Math.max(1, config.ledgerRebuildMaxRequests)
    previous = base.ledger
    if (fullChunks.length <= maxChunks) {
      span = fullSpan
      chunks = fullChunks
      nextAge = 0
    } else {
      // Keep the newest rows whose masked ledger rendering fits within the request cap.
      const maskCfg = ledgerMaskConfig(config)
      const capChars = maxChunks * config.ledgerChunkChars
      let start = fullSpan.length
      let acc = 0
      while (start > 0) {
        const m = fullSpan[start - 1]
        const len = renderMessage(maskMessage(m, m.seq, maskCfg), m.seq).length + 1
        if (acc > 0 && acc + len > capChars) break
        start--
        acc += len
      }
      span = fullSpan.slice(start)
      chunks = renderSpan(span, config)
      while (chunks.length > maxChunks && span.length > 1) {
        span = span.slice(1)
        chunks = renderSpan(span, config)
      }
      if (chunks.length > maxChunks) chunks = chunks.slice(-maxChunks)
      nextAge = base.ledgerAge + 1
    }
  } else {
    const due = !base.ledger || (config.ledgerRebuildEvery > 0 && base.ledgerAge + 1 >= config.ledgerRebuildEvery)
    // A rebuild of a very long history costs more each time: past the cap, update instead.
    const rebuild = !base.ledger || (due && ledgerRequests(rows.slice(0, cutRow), config) <= config.ledgerRebuildMaxRequests)
    previous = rebuild ? '' : base.ledger
    span = rebuild ? rows.slice(0, cutRow) : rows.slice(base.ledgerThrough, cutRow)
    chunks = renderSpan(span, config)
    nextAge = rebuild ? 0 : base.ledgerAge + 1
  }

  if (chunks.length === 0) return { reason: 'nothing new to fold in' }
  return {
    work: {
      previous,
      span,
      chunks,
      ...(cleanFocus ? { focus: cleanFocus } : {}),
      targetThrough: cutRow,
      nextAge
    }
  }
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
  const { work } = chooseLedgerWork(base, rows, cutRow, config, focus, false)
  if (!work) return base
  try {
    const update = await ledgerFn(work.previous, work.span, config, work.focus)
    return {
      ledger: trimLedger(update.ledger, shareChars(config, 'ledger')),
      ledgerThrough: work.targetThrough,
      ledgerAge: work.nextAge,
      requests: update.requests
    }
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) }
  }
}

type Plan = {
  hidden: Map<number, Hidden>
  ratio: number
  charsPerToken: number
  /** Image files to write at commit, for rows archived by this compaction. */
  mediaWrites: Array<{ path: string; data: string }>
  dir: string
  state: SessionState
  reconciled: Reconciled
  rows: ArchivedMessage[]
  base: LedgerState
  adoptedLedger?: LedgerState
  units: Unit[]
  handles: Array<Array<number | undefined>>
  whole: boolean[]
  rawBuilt: Message[][]
  maskedBuilt: Message[][]
  maskedSizes: number[]
  verbatim: number[]
  cut: number
  tail: number
  cutRow: number
}

/** Everything a compaction decides, computed without writing anything. */
function planCompaction(input: CompactInput, config: Config, reserveFullLedger?: boolean): Plan {
  const dir = sessionDir(config.dataDir, input.sessionKey)
  const state = readState(dir)
  const reconciled = reconcile(dir, input.messages, state)
  const { bySeq, branch, inputBySeq, pending, ledgerStale } = reconciled
  const hidden = input.api ? hiddenByRow(input.messages, input.api) : new Map<number, Hidden>()
  const cal = calibrateWeights(input.messages, hidden, input.usage)
  const ratio = cal.thinkingRatio
  const charsPerToken = cal.charsPerToken
  // New rows carrying images get archive files; rebuilt copies will point at them.
  const mediaWrites: Array<{ path: string; data: string }> = []
  for (const row of pending) {
    const images = hidden.get(inputBySeq.get(row.seq)!)?.images ?? []
    if (!images.length) continue
    row.media = images.map((image, k) => {
      const path = join(dir, 'media', `${row.seq}-${k}.${mediaExtension(image.mediaType)}`)
      mediaWrites.push({ path, data: image.data })
      return { ...(image.toolUseId ? { toolUseId: image.toolUseId } : {}), path }
    })
  }
  const rows = branch.map(seq => bySeq.get(seq)!)
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
  const scaledMessagesChars = (msgs: Message[]) =>
    msgs.reduce((n, m) => n + calibratedTextChars(messageChars(m), charsPerToken), 0)
  const maskedSizes = maskedBuilt.map(scaledMessagesChars)
  // Rows kept whole carry images, thinking, and real text density; rebuilt body rows carry calibrated text density too.
  const rowChars = (m: ArchivedMessage) =>
    calibratedTextChars(messageChars(m), charsPerToken) + hiddenChars(hidden.get(inputBySeq.get(m.seq)!), ratio)
  const verbatim = units.map((u, k) => (whole[k] ? rows.slice(u.start, u.end).reduce((n, m) => n + rowChars(m), 0) : scaledMessagesChars(rawBuilt[k])))
  const base = bestLedger(dir, state, rows, ledgerStale)
  const budget = budgetChars(config)
  const ledgerCap = shareChars(config, 'ledger')

  // Adopt a valid host-computed ledger right here so layout sizes against its
  // actual length and exact `ledgerThrough` instead of wasting the full 6% cap.
  const provided = input.preparedLedger
  const adoptedLedger: LedgerState | undefined =
    provided && provided.through <= rows.length && prefixHash(rows, provided.through) === provided.prefixHash
      ? {
          ledger: trimLedger(provided.ledger, ledgerCap),
          ledgerThrough: provided.through,
          ledgerAge: provided.age,
          requests: provided.requests
        }
      : undefined
  const knownLedger = adoptedLedger ?? base
  const ledgerKnown = adoptedLedger !== undefined || input.ledgerError !== undefined || input.ledgerMode === 'ready'
  const fullReserve = reserveFullLedger ?? !ledgerKnown
  const preferredLedgerChars = fullReserve ? ledgerCap : Math.min(knownLedger.ledger.length, ledgerCap)

  const makeHeaderSizer = (ledgerChars: number) => {
    const cache = new Map<number, number>()
    const placeholder = ledgerChars > 0 ? 'x'.repeat(ledgerChars) : ''
    const indexCap = shareChars(config, 'index')
    return (cut: number): number => {
      if (cut <= 0) return 0
      const hit = cache.get(cut)
      if (hit !== undefined) return hit
      const evicted = rows.slice(0, units[cut].start)
      if (!fullReserve) {
        const size = buildHeader(input, dir, evicted, placeholder, knownLedger.ledgerThrough, config).length
        cache.set(cut, size)
        return size
      }
      // In sync/prepare mode, the final ledgerThrough is not known yet. Bound the
      // episode index across all possible protectAfterSeq values (never above indexCap)
      // so assembly can never overflow the budget due to index merge-order variance.
      const episodes = segmentEpisodes(evicted)
      const fullIdxLen = episodes.map(renderEpisode).join('\n').length
      const baseProtect = base.ledgerThrough < evicted.length ? evicted[base.ledgerThrough]?.seq : undefined
      const baseIdxLen = renderIndex(episodes, indexCap, { protectAfterSeq: baseProtect }).length
      const indexSlack = fullIdxLen > indexCap ? Math.max(0, indexCap - baseIdxLen) : 0
      let size = buildHeader(input, dir, evicted, placeholder, base.ledgerThrough, config).length + indexSlack
      if (placeholder && base.ledgerThrough < evicted.length && evicted.length > 1) {
        // Also bound the lag notice with the widest seq numbers in `evicted`.
        const maxLagHeader = buildHeader(input, dir, evicted, placeholder, evicted.length - 1, config).length
        const lagProtect = evicted[evicted.length - 1]?.seq
        const lagIdxLen = renderIndex(episodes, indexCap, { protectAfterSeq: lagProtect }).length
        const lagSlack = fullIdxLen > indexCap ? Math.max(0, indexCap - lagIdxLen) : 0
        size = Math.max(size, maxLagHeader + lagSlack)
      }
      cache.set(cut, size)
      return size
    }
  }

  // Leave the ledger its room when possible; squeeze it out before giving up.
  let picked: Layout
  try {
    picked = layout(verbatim, maskedSizes, guard.from, makeHeaderSizer(preferredLedgerChars), budget, config)
  } catch (error) {
    if (!(error instanceof OversizeError) || preferredLedgerChars === 0) throw error
    picked = layout(verbatim, maskedSizes, guard.from, makeHeaderSizer(0), budget, config)
  }
  return {
    hidden,
    ratio,
    charsPerToken,
    mediaWrites,
    dir,
    state,
    reconciled,
    rows,
    base,
    ...(adoptedLedger ? { adoptedLedger } : {}),
    units,
    handles,
    whole,
    rawBuilt,
    maskedBuilt,
    maskedSizes,
    verbatim,
    ...picked,
    cutRow: units[picked.cut].start
  }
}

export async function compact(input: CompactInput, config: Config, ledgerFn: LedgerFn = updateLedger): Promise<CompactResult> {
  const dir = sessionDir(config.dataDir, input.sessionKey)
  const release = await acquireLock(dir, 'compact.lock')
  try {
    const plan = planCompaction(input, config)
    const {
      state,
      rows,
      base,
      adoptedLedger,
      units,
      handles,
      whole,
      rawBuilt,
      maskedBuilt,
      maskedSizes,
      verbatim,
      cut,
      tail,
      cutRow,
      hidden,
      ratio,
      charsPerToken,
      mediaWrites
    } = plan
    const { all, pending, branch, matched } = plan.reconciled
    const tailRow = units[tail].start
    const budget = budgetChars(config)

    let ledger: LedgerState
    if (adoptedLedger) {
      ledger = adoptedLedger
    } else if (input.ledgerError) {
      ledger = { ...base, error: input.ledgerError }
    } else if (input.ledgerMode === 'ready') {
      ledger = base
    } else {
      ledger = await advanceLedger(base, rows, cutRow, config, ledgerFn, input.instructions)
    }

    const entries: OutputEntry[] = []
    const records: OutputRecord[] = []
    const layers = { header: 0, middle: 0, tail: 0 }
    let tailHidden = 0
    const emitBuilt = (m: Message, upto: number, layer: keyof typeof layers) => {
      entries.push({ built: m })
      records.push({
        fp: fingerprint(m),
        upto,
        seq: -1,
        role: m.role,
        ...(layer === 'header' ? { isHeader: true as const } : {})
      })
      layers[layer] += layer === 'header' ? messageChars(m) : calibratedTextChars(messageChars(m), charsPerToken)
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
            records.push({
              fp: fingerprint(input.messages[inputIndex!]),
              upto: start + k + 1,
              seq: rows[start + k].seq,
              role: rows[start + k].role
            })
            const extra = hiddenChars(hidden.get(inputIndex!), ratio)
            tailHidden += extra
            layers.tail += calibratedTextChars(messageChars(rows[start + k]), charsPerToken) + extra
          })
        })
      } else {
        for (const m of rawBuilt[u]) body.push(() => emitBuilt(m, end, 'tail'))
      }
    }
    if (cutRow > 0) {
      const evicted = rows.slice(0, cutRow)
      const bodyChars = maskedSizes.slice(cut, tail).reduce((a, b) => a + b, 0) + verbatim.slice(tail).reduce((a, b) => a + b, 0)
      const emptyHeader = buildHeader(input, dir, evicted, '', ledger.ledgerThrough, config).length
      const probeHeader = buildHeader(input, dir, evicted, 'x', ledger.ledgerThrough, config).length
      const ledgerWrapper = probeHeader - emptyHeader - 1
      const shown = fitLedger(ledger.ledger, budget - bodyChars - emptyHeader - ledgerWrapper)
      emitBuilt({ role: 'user', text: buildHeader(input, dir, evicted, shown, ledger.ledgerThrough, config), toolUses: [] }, cutRow, 'header')
    }
    for (const emit of body) emit()

    const outputChars = layers.header + layers.middle + layers.tail
    if (outputChars > budget) throw new OversizeError(`assembled output is ${outputChars} chars, over the ${budget}-char budget`)

    // Commit only now: a rejected compaction leaves archive and state untouched.
    if (mediaWrites.length) mkdirSync(join(dir, 'media'), { recursive: true })
    for (const { path, data } of mediaWrites) writeFileSync(path, Buffer.from(data, 'base64'))
    appendArchive(dir, pending)
    writeState(dir, {
      branch,
      lastOutput: records,
      ledger: ledger.ledger,
      ledgerThrough: ledger.ledgerThrough,
      ledgerAge: ledger.ledgerAge,
      compactions: state.compactions + 1,
      lastCut: cutRow
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
        hiddenChars: tailHidden,
        thinkingRatio: Math.round(ratio * 100) / 100,
        charsPerToken: Math.round(charsPerToken * 100) / 100,
        mediaSaved: mediaWrites.length,
        ledgerRequests: ledger.requests,
        ledgerThrough: ledger.ledgerThrough,
        ...(ledger.error ? { ledgerError: ledger.error } : {})
      }
    }
  } finally {
    release()
  }
}

function resolvePrepareTarget(
  input: PrepareInput,
  config: Config
): { dir: string; rows: ArchivedMessage[]; cutRow: number; base: LedgerState; enforceMinChars: boolean } {
  if ('through' in input && input.through !== undefined) {
    const dir = sessionDir(config.dataDir, input.sessionKey)
    const state = readState(dir)
    const archive = readArchive(dir)
    const bySeq = new Map<number, ArchivedMessage>(archive.map(m => [m.seq, m]))
    const rows = state.branch.map(seq => bySeq.get(seq)).filter((m): m is ArchivedMessage => m !== undefined)
    const cutRow = Math.min(Math.max(0, Math.floor(input.through)), rows.length)
    const base = bestLedger(dir, state, rows, false)
    return { dir, rows, cutRow, base, enforceMinChars: false }
  }
  const plan = planCompaction(input, config, true)
  return { dir: plan.dir, rows: plan.rows, cutRow: plan.cutRow, base: plan.base, enforceMinChars: true }
}

/**
 * Pure, read-only ledger plan used by the Claude Code plugin to run model
 * completions via `$.model.complete`. Throws `DeclineError` if the planned
 * compaction itself would decline, so no model call is wasted.
 */
export function planLedger(input: PrepareInput, config: Config, options: { enforceMinChars?: boolean } = {}): LedgerPlan {
  const target = resolvePrepareTarget(input, config)
  const enforceMinChars = options.enforceMinChars ?? target.enforceMinChars
  const { work, reason } = chooseLedgerWork(target.base, target.rows, target.cutRow, config, input.instructions, enforceMinChars)
  if (!work) return { needed: false, reason: reason ?? 'nothing new to fold in' }
  const maxChars = shareChars(config, 'ledger')
  return {
    needed: true,
    previous: work.previous,
    chunks: work.chunks,
    ...(work.focus ? { focus: work.focus } : {}),
    maxChars,
    maxTokens: ledgerMaxTokens(maxChars),
    system: LEDGER_SYSTEM_PROMPT,
    model: config.ledgerModel,
    through: work.targetThrough,
    prefixHash: prefixHash(target.rows, work.targetThrough),
    age: work.nextAge
  }
}

export type PrepareResult =
  | { prepared: true; through: number; requests: number }
  | { prepared: false; reason: string }

/**
 * Background ledger preparation over a snapshot of the conversation (or an
 * explicit committed `through` cut): fold everything evicted into a ready
 * ledger. Writes only `ready-ledger.json`, never the archive or state, so it
 * can run while the session goes on and while a compaction commits.
 */
export async function prepare(input: PrepareInput, config: Config, ledgerFn: LedgerFn = updateLedger): Promise<PrepareResult> {
  const target = resolvePrepareTarget(input, config)
  const { dir, rows, cutRow, base, enforceMinChars } = target
  const { work, reason } = chooseLedgerWork(base, rows, cutRow, config, input.instructions, enforceMinChars)
  if (!work) return { prepared: false, reason: reason ?? 'nothing new to fold in' }
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
