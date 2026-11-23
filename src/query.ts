import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { archivePath, readArchive, readState } from './archive.js'
import { renderMessage } from './mask.js'
import { prefixHash, readReady } from './ready.js'
import type { ArchivedMessage } from './types.js'

export type ShowOptions = {
  from: number
  to?: number
  offset?: number
  limit?: number
}

export type ShowResult = {
  found: boolean
  archiveCount: number
  seqs: number[]
  totalChars: number
  offset: number
  returnedChars: number
  hasMore: boolean
  nextOffset?: number
  text: string
}

export function showArchive(dir: string, options: ShowOptions): ShowResult {
  const from = options.from
  const to = options.to ?? from
  const archive = readArchive(dir)
  const picked = archive.filter(m => m.seq >= from && m.seq <= to)
  if (picked.length === 0) {
    return {
      found: false,
      archiveCount: archive.length,
      seqs: [],
      totalChars: 0,
      offset: 0,
      returnedChars: 0,
      hasMore: false,
      text: ''
    }
  }
  const full = picked.map(m => renderMessage(m, m.seq)).join('\n\n')
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  const limit = options.limit !== undefined && options.limit > 0 ? Math.floor(options.limit) : undefined
  if (offset >= full.length) {
    return {
      found: true,
      archiveCount: archive.length,
      seqs: picked.map(m => m.seq),
      totalChars: full.length,
      offset,
      returnedChars: 0,
      hasMore: false,
      text: `[strata show: offset ${offset} is past end of output (${full.length} chars)]`
    }
  }
  const slice = limit !== undefined ? full.slice(offset, offset + limit) : full.slice(offset)
  const end = offset + slice.length
  const hasMore = end < full.length
  const footer = hasMore || offset > 0
    ? `\n\n[strata show: chars ${offset}-${end} of ${full.length}${hasMore ? `; pass offset=${end} to continue` : ' (end)'}]`
    : ''
  return {
    found: true,
    archiveCount: archive.length,
    seqs: picked.map(m => m.seq),
    totalChars: full.length,
    offset,
    returnedChars: slice.length,
    hasMore,
    ...(hasMore ? { nextOffset: end } : {}),
    text: `${slice}${footer}`
  }
}

export type SearchOptions = {
  query: string
  regex?: boolean
  /** Default true: only search messages in the active branch (`state.branch`). */
  branchOnly?: boolean
  role?: 'user' | 'assistant'
  errorsOnly?: boolean
  fromSeq?: number
  toSeq?: number
  maxMatches?: number
  contextChars?: number
}

export type SearchMatch = {
  seq: number
  role: 'user' | 'assistant'
  hasError: boolean
  snippet: string
}

export type SearchResult = {
  query: string
  branchScoped: boolean
  scanned: number
  totalMatches: number
  matches: SearchMatch[]
  formatted: string
}

function makeSnippet(rendered: string, index: number, matchLen: number, contextChars: number): string {
  const half = Math.max(20, Math.floor(contextChars / 2))
  const start = Math.max(0, index - half)
  const end = Math.min(rendered.length, index + matchLen + half)
  const body = rendered.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < rendered.length ? '…' : ''}`
}

export function searchArchive(dir: string, options: SearchOptions): SearchResult {
  const query = options.query
  if (!query) throw new Error('search query must not be empty')
  let matcher: (text: string) => { index: number; length: number } | undefined
  if (options.regex) {
    let re: RegExp
    try {
      re = new RegExp(query, 'i')
    } catch (error) {
      throw new Error(`invalid regex "${query}": ${error instanceof Error ? error.message : String(error)}`)
    }
    matcher = text => {
      const m = re.exec(text)
      return m ? { index: m.index, length: m[0].length } : undefined
    }
  } else {
    const needle = query.toLowerCase()
    matcher = text => {
      const index = text.toLowerCase().indexOf(needle)
      return index >= 0 ? { index, length: needle.length } : undefined
    }
  }

  const archive = readArchive(dir)
  const state = readState(dir)
  const branchOnly = options.branchOnly !== false
  const branchSet = branchOnly && state.branch.length > 0 ? new Set(state.branch) : undefined
  const branchScoped = branchSet !== undefined
  const maxMatches = Math.min(100, Math.max(1, Math.floor(options.maxMatches ?? 20)))
  const contextChars = Math.max(40, Math.floor(options.contextChars ?? 180))

  const candidates = archive.filter(m => {
    if (branchSet && !branchSet.has(m.seq)) return false
    if (options.role && m.role !== options.role) return false
    if (options.fromSeq !== undefined && m.seq < options.fromSeq) return false
    if (options.toSeq !== undefined && m.seq > options.toSeq) return false
    if (options.errorsOnly && !(m.toolResults ?? []).some(r => r.isError)) return false
    return true
  })

  const matches: SearchMatch[] = []
  let totalMatches = 0
  for (const m of candidates) {
    const rendered = renderMessage(m, m.seq)
    const hit = matcher(rendered)
    if (!hit) continue
    totalMatches++
    if (matches.length < maxMatches) {
      matches.push({
        seq: m.seq,
        role: m.role,
        hasError: (m.toolResults ?? []).some(r => r.isError),
        snippet: makeSnippet(rendered, hit.index, hit.length, contextChars)
      })
    }
  }

  const header = `strata search "${query}" (${branchScoped ? 'active branch' : 'full archive'}, ${totalMatches} match${totalMatches === 1 ? '' : 'es'} across ${candidates.length} messages${totalMatches > matches.length ? `, showing first ${matches.length}` : ''}):`
  const lines = matches.length
    ? [header, ...matches.map(m => `- #${m.seq} (${m.role}${m.hasError ? ', error' : ''}): ${m.snippet}`)]
    : [header, '(no matches)']
  return {
    query,
    branchScoped,
    scanned: candidates.length,
    totalMatches,
    matches,
    formatted: lines.join('\n')
  }
}

export type SessionStatus = {
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
  }
}

export function sessionStatus(dir: string, sessionKey: string): SessionStatus {
  const archive = readArchive(dir)
  const archPath = archivePath(dir)
  const archiveBytes = existsSync(archPath) ? statSync(archPath).size : 0
  const mediaDir = join(dir, 'media')
  const mediaCount = existsSync(mediaDir) ? readdirSync(mediaDir).length : 0
  const state = readState(dir)
  const bySeq = new Map<number, ArchivedMessage>(archive.map(m => [m.seq, m]))
  const rows = state.branch.map(seq => bySeq.get(seq)).filter((m): m is ArchivedMessage => m !== undefined)
  const ready = readReady(dir)
  const readyCompatible = ready !== undefined && ready.through <= rows.length && prefixHash(rows, ready.through) === ready.prefixHash
  const ledgerLag = state.lastCut !== undefined ? Math.max(0, state.lastCut - state.ledgerThrough) : 0

  return {
    sessionKey,
    archiveCount: archive.length,
    archiveBytes,
    mediaCount,
    branchLength: state.branch.length,
    compactions: state.compactions,
    ...(state.lastCut !== undefined ? { lastCut: state.lastCut } : {}),
    ledgerThrough: state.ledgerThrough,
    ledgerChars: state.ledger.length,
    ledgerAge: state.ledgerAge,
    ledgerLag,
    ...(ready
      ? {
          readyLedger: {
            through: ready.through,
            chars: ready.ledger.length,
            age: ready.age,
            preparedAt: ready.preparedAt,
            compatible: readyCompatible
          }
        }
      : {})
  }
}

export function formatSessionStatus(s: SessionStatus): string {
  const kb = (s.archiveBytes / 1024).toFixed(1)
  const ledgerLine = s.ledgerChars > 0
    ? `ledger: ${s.ledgerChars.toLocaleString('en-US')} chars, covers ${s.ledgerThrough} rows (age ${s.ledgerAge}${s.ledgerLag > 0 ? `, lags cut by ${s.ledgerLag} rows` : s.lastCut !== undefined ? ', up to date' : ''})`
    : `ledger: empty${s.ledgerLag > 0 ? ` (lags cut by ${s.ledgerLag} rows)` : ''}`
  const readyLine = s.readyLedger
    ? `ready ledger: ${s.readyLedger.chars.toLocaleString('en-US')} chars, covers ${s.readyLedger.through} rows (${s.readyLedger.compatible ? 'compatible' : 'stale'}, prepared ${s.readyLedger.preparedAt})`
    : 'ready ledger: none'
  return [
    `archive: ${s.archiveCount} messages (${kb} KB), ${s.mediaCount} media files, active branch ${s.branchLength} rows`,
    `compactions: ${s.compactions}${s.lastCut !== undefined ? ` (last cut at row ${s.lastCut})` : ''}`,
    ledgerLine,
    readyLine
  ].join('\n')
}
