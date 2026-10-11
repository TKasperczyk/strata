import { createHash } from 'crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { fingerprint } from './archive.js'
import type { ArchivedMessage } from './types.js'

/**
 * A ledger the background worker prepared. Only the worker writes it, always
 * whole (write + rename); a compaction adopts it when the branch still starts
 * with exactly the rows it covers, and never writes it.
 */
export type ReadyLedger = {
  ledger: string
  /** Branch rows the ledger covers: rows[0..through). */
  through: number
  /**
   * Hash of those rows' fingerprints and archive seqs: a rewind or replacement
   * invalidates it, and so does a compaction that numbered the rows differently
   * from the snapshot the worker planned on (its citations would point wrong).
   */
  prefixHash: string
  /** Incremental updates since its last full rebuild. */
  age: number
  preparedAt: string
}

const READY_FILE = 'ready-ledger.json'
const LOCK_FILE = 'prepare.lock'
/** A lock older than this belongs to a worker that died without cleaning up. */
const STALE_LOCK_MS = 15 * 60 * 1000

export function prefixHash(rows: ArchivedMessage[], through: number): string {
  const hash = createHash('sha256')
  for (const m of rows.slice(0, through)) hash.update(`${m.seq}:${fingerprint(m)}`)
  return hash.digest('base64url')
}

export function readReady(dir: string): ReadyLedger | undefined {
  const path = join(dir, READY_FILE)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ReadyLedger
  } catch {
    return undefined
  }
}

export function writeReady(dir: string, ready: ReadyLedger): void {
  const path = join(dir, READY_FILE)
  writeFileSync(`${path}.tmp`, JSON.stringify(ready))
  renameSync(`${path}.tmp`, path)
}

/** The ready ledger if it still describes the start of this branch. */
export function compatibleReady(dir: string, rows: ArchivedMessage[]): ReadyLedger | undefined {
  const ready = readReady(dir)
  if (!ready || ready.through > rows.length) return undefined
  return prefixHash(rows, ready.through) === ready.prefixHash ? ready : undefined
}

/** One prepare job per session: an exclusive lock file, reclaimed when stale. */
export function tryLock(dir: string): (() => void) | undefined {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, LOCK_FILE)
  if (existsSync(path) && Date.now() - statSync(path).mtimeMs > STALE_LOCK_MS) rmSync(path, { force: true })
  try {
    closeSync(openSync(path, 'wx'))
  } catch {
    return undefined
  }
  return () => rmSync(path, { force: true })
}
