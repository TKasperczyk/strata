import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import type { ArchivedMessage, Message, SessionState } from './types.js'

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

export function readArchive(dir: string): ArchivedMessage[] {
  const path = archivePath(dir)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as ArchivedMessage)
}

export function numberMessages(start: number, messages: Message[]): ArchivedMessage[] {
  return messages.map((m, i) => ({ ...m, seq: start + i }))
}

export function appendArchive(dir: string, archived: ArchivedMessage[]): void {
  mkdirSync(dir, { recursive: true })
  if (archived.length) appendFileSync(archivePath(dir), archived.map(m => JSON.stringify(m)).join('\n') + '\n')
}

export function readState(dir: string): SessionState {
  const path = join(dir, 'state.json')
  if (!existsSync(path)) return { ...INITIAL_STATE }
  return { ...INITIAL_STATE, ...(JSON.parse(readFileSync(path, 'utf-8')) as Partial<SessionState>) }
}

export function writeState(dir: string, state: SessionState): void {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'state.json')
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2))
  renameSync(`${path}.tmp`, path)
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
 * How many leading input messages repeat our last output, in order. A message
 * strata built (header, masked turns) may come back normalized by the engine;
 * it still counts only when every later message of that output matches too,
 * and at least one does. A rewind with an edited prompt regenerates what
 * follows, so it cannot satisfy that even when a reply happens to repeat.
 */
export function matchedPrefix(input: Message[], state: SessionState): number {
  const out = state.lastOutput
  const same = (i: number) => i < input.length && fingerprint(input[i]) === out[i].fp
  const restSame: boolean[] = new Array(out.length + 1).fill(true)
  for (let k = out.length - 1; k >= 0; k--) restSame[k] = restSame[k + 1] && same(k)
  let p = 0
  while (p < out.length && p < input.length) {
    const tolerated = out[p].seq === -1 && p + 1 < out.length && restSame[p + 1]
    if (!same(p) && !tolerated) break
    p++
  }
  return p
}
