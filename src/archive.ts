import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import type { ArchivedMessage, Message, OutputRecord, SessionState } from './types.js'

export const INITIAL_STATE: SessionState = {
  branch: [],
  lastOutput: [],
  ledger: '',
  ledgerThrough: 0,
  ledgerAge: 0,
  compactions: 0
}

export function sessionDir(dataDir: string, sessionKey: string): string {
  if (!/^[A-Za-z0-9._:-]+$/.test(sessionKey)) throw new Error(`invalid session key: ${sessionKey}`)
  return join(dataDir, 'sessions', sessionKey)
}

export function archivePath(dir: string): string {
  return join(dir, 'archive.jsonl')
}

function isArchivedMessage(v: unknown): v is ArchivedMessage {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const m = v as Partial<ArchivedMessage>
  return (
    typeof m.seq === 'number' &&
    (m.role === 'user' || m.role === 'assistant') &&
    typeof m.text === 'string' &&
    Array.isArray(m.toolUses)
  )
}

/**
 * Read the session archive, tolerating a truncated trailing line (or any
 * corrupt JSONL line) left behind by an interrupted append.
 */
export function readArchive(dir: string): ArchivedMessage[] {
  const path = archivePath(dir)
  if (!existsSync(path)) return []
  const out: ArchivedMessage[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isArchivedMessage(parsed)) out.push(parsed)
    } catch {
      // Tolerate truncated trailing lines (or corrupt entries) without bricking the session.
    }
  }
  return out
}

export function numberMessages(start: number, messages: Message[]): ArchivedMessage[] {
  return messages.map((m, i) => ({ ...m, seq: start + i }))
}

/** Trim any incomplete/corrupt trailing line before appending so the JSONL file self-heals. */
function repairTrailingLine(path: string): void {
  if (!existsSync(path)) return
  const raw = readFileSync(path)
  if (raw.length === 0) return
  let end = raw.length
  while (end > 0 && (raw[end - 1] === 0x0a || raw[end - 1] === 0x0d)) end--
  const lastNl = raw.lastIndexOf(0x0a, Math.max(0, end - 1))
  const lastLine = raw.subarray(lastNl + 1, end).toString('utf-8').trim()
  if (!lastLine) return
  try {
    const parsed: unknown = JSON.parse(lastLine)
    if (!isArchivedMessage(parsed)) throw new Error('invalid archive row')
    if (raw[raw.length - 1] !== 0x0a) appendFileSync(path, '\n')
  } catch {
    truncateSync(path, lastNl >= 0 ? lastNl + 1 : 0)
  }
}

export function appendArchive(dir: string, archived: ArchivedMessage[]): void {
  if (!archived.length) return
  mkdirSync(dir, { recursive: true })
  const path = archivePath(dir)
  repairTrailingLine(path)
  appendFileSync(path, archived.map(m => JSON.stringify(m)).join('\n') + '\n')
}

function isOutputRecord(v: unknown): v is OutputRecord {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const r = v as Partial<OutputRecord>
  return typeof r.fp === 'string' && typeof r.upto === 'number' && typeof r.seq === 'number'
}

/** Read session state, falling back cleanly to INITIAL_STATE if corrupt. */
export function readState(dir: string): SessionState {
  const path = join(dir, 'state.json')
  if (!existsSync(path)) return { ...INITIAL_STATE }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SessionState> | null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...INITIAL_STATE }
    if (
      !Array.isArray(parsed.branch) ||
      !parsed.branch.every(n => typeof n === 'number') ||
      !Array.isArray(parsed.lastOutput) ||
      !parsed.lastOutput.every(isOutputRecord)
    ) {
      return { ...INITIAL_STATE }
    }
    return {
      branch: parsed.branch,
      lastOutput: parsed.lastOutput,
      ledger: typeof parsed.ledger === 'string' ? parsed.ledger : INITIAL_STATE.ledger,
      ledgerThrough: typeof parsed.ledgerThrough === 'number' ? parsed.ledgerThrough : INITIAL_STATE.ledgerThrough,
      ledgerAge: typeof parsed.ledgerAge === 'number' ? parsed.ledgerAge : INITIAL_STATE.ledgerAge,
      compactions: typeof parsed.compactions === 'number' ? parsed.compactions : INITIAL_STATE.compactions,
      ...(typeof parsed.lastCut === 'number' ? { lastCut: parsed.lastCut } : {})
    }
  } catch {
    return { ...INITIAL_STATE }
  }
}

function tempPath(target: string): string {
  return `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
}

export function writeState(dir: string, state: SessionState): void {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'state.json')
  const tmp = tempPath(path)
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    renameSync(tmp, path)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

/**
 * Identity of a message as it reappears in the next compaction's input: its
 * whole text and every result, so an edit anywhere changes it. Tool inputs and
 * a tool_use's mirrored result text are left out; the engine may normalize them.
 */
export function fingerprint(m: Message): string {
  const parts = [
    m.role,
    m.text,
    m.toolUses.map(u => `${u.tool_use_id}:${u.tool}`),
    (m.toolResults ?? []).map(r => [r.tool_use_id, r.isError, r.text])
  ]
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url')
}

/**
 * How many leading input messages repeat our last output, in order. Messages
 * strata built (header, masked turns; `seq === -1`) may come back normalized by
 * the engine across one or more positions; mismatches on built messages are
 * tolerated when the verbatim kept tail (every `seq >= 0` record after `p`, at
 * least one) still matches at its exact positions — or, if `lastOutput` has no
 * kept rows, when every later message matches (at most one normalized built
 * message). A rewind with an edited prompt drops or changes the kept tail, so
 * it cannot pass this check even when a reply happens to repeat.
 */
export function matchedPrefix(input: Message[], state: SessionState): number {
  const out = state.lastOutput
  const same = (i: number) => i < input.length && fingerprint(input[i]) === out[i].fp
  const keptMatchFrom: boolean[] = new Array(out.length + 1).fill(true)
  const hasKeptFrom: boolean[] = new Array(out.length + 1).fill(false)
  const restSame: boolean[] = new Array(out.length + 1).fill(true)
  for (let k = out.length - 1; k >= 0; k--) {
    const isKept = out[k].seq >= 0
    keptMatchFrom[k] = keptMatchFrom[k + 1] && (!isKept || same(k))
    hasKeptFrom[k] = hasKeptFrom[k + 1] || isKept
    restSame[k] = restSame[k + 1] && same(k)
  }

  let p = 0
  while (p < out.length && p < input.length) {
    if (same(p)) {
      p++
      continue
    }
    const tailIntact = hasKeptFrom[p + 1] && keptMatchFrom[p + 1]
    const fallbackIntact = !hasKeptFrom[0] && p + 1 < out.length && restSame[p + 1]
    if (out[p].seq === -1 && (tailIntact || fallbackIntact)) {
      p++
      continue
    }
    break
  }
  return p
}
