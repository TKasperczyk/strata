import type { ArchivedMessage } from './types.js'

/** One user-prompted stretch of work, or several merged once the index overflows. */
export type Episode = {
  first: number
  last: number
  /** Episodes merged into this one (1 = a single prompt). */
  span: number
  prompts: string[]
  files: string[]
  toolCounts: Record<string, number>
  errors: number
  outcome: string
}

const FILE_KEYS = ['file_path', 'path', 'notebook_path']
const MAX_FILES = 6
const PATH_CHARS = 80
const LINE_CHARS = 600
const PROMPT_CHARS = 140
const OUTCOME_CHARS = 160

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** Keep the tail of a long path: the file name is the useful part. */
function shortPath(path: string): string {
  return path.length <= PATH_CHARS ? path : `…${path.slice(-(PATH_CHARS - 1))}`
}

function isPrompt(m: ArchivedMessage): boolean {
  return m.role === 'user' && m.text.trim() !== '' && !(m.toolResults?.length)
}

export function segmentEpisodes(messages: ArchivedMessage[]): Episode[] {
  const episodes: Episode[] = []
  let current: Episode | undefined
  for (const m of messages) {
    if (!current || isPrompt(m)) {
      current = {
        first: m.seq,
        last: m.seq,
        span: 1,
        prompts: isPrompt(m) ? [oneLine(m.text, PROMPT_CHARS)] : [],
        files: [],
        toolCounts: {},
        errors: 0,
        outcome: ''
      }
      episodes.push(current)
    }
    current.last = m.seq
    if (m.role === 'assistant' && m.text.trim()) current.outcome = oneLine(m.text, OUTCOME_CHARS)
    for (const u of m.toolUses) {
      current.toolCounts[u.tool] = (current.toolCounts[u.tool] ?? 0) + 1
      for (const key of FILE_KEYS) {
        const value = u.input[key]
        if (typeof value === 'string' && !current.files.includes(value)) current.files.push(value)
      }
    }
    current.errors += (m.toolResults ?? []).filter(r => r.isError).length
  }
  return episodes
}

function merge(a: Episode, b: Episode): Episode {
  const toolCounts = { ...a.toolCounts }
  for (const [tool, n] of Object.entries(b.toolCounts)) toolCounts[tool] = (toolCounts[tool] ?? 0) + n
  return {
    first: a.first,
    last: b.last,
    span: a.span + b.span,
    prompts: [...a.prompts, ...b.prompts],
    files: [...new Set([...a.files, ...b.files])],
    toolCounts,
    errors: a.errors + b.errors,
    outcome: b.outcome || a.outcome
  }
}

export function renderEpisode(e: Episode): string {
  const tools = Object.entries(e.toolCounts)
    .sort((x, y) => y[1] - x[1])
    .map(([tool, n]) => (n > 1 ? `${tool}×${n}` : tool))
    .join(' ')
  const shown = e.files.slice(0, MAX_FILES).map(shortPath).join(', ')
  const files = e.files.length > MAX_FILES ? `${shown} +${e.files.length - MAX_FILES} more` : shown
  const prompts = e.span === 1
    ? e.prompts.map(p => `"${p}"`).join(' ')
    : `${e.span} prompts, e.g. ${e.prompts.slice(0, 2).map(p => `"${oneLine(p, 60)}"`).join(' | ')}`
  const parts = [`[seq ${e.first}-${e.last}] ${prompts}`]
  if (tools) parts.push(`tools: ${tools}`)
  if (files) parts.push(`files: ${files}`)
  if (e.errors) parts.push(`errors: ${e.errors}`)
  if (e.outcome) parts.push(`ended: ${e.outcome}`)
  return oneLine(`- ${parts.join(' · ')}`, LINE_CHARS)
}

/**
 * Render the index within `maxChars`, merging the adjacent pair that covers
 * the fewest episodes (oldest first on ties) until it fits. Detail is lost in
 * where to look, never in what the archive holds.
 */
export function renderIndex(episodes: Episode[], maxChars: number): string {
  const list = [...episodes]
  const lengths = list.map(e => renderEpisode(e).length + 1)
  let total = lengths.reduce((a, b) => a + b, 0)
  while (list.length > 1 && total > maxChars) {
    let best = 0
    for (let i = 1; i < list.length - 1; i++) {
      if (list[i].span + list[i + 1].span < list[best].span + list[best + 1].span) best = i
    }
    const merged = merge(list[best], list[best + 1])
    const length = renderEpisode(merged).length + 1
    total += length - lengths[best] - lengths[best + 1]
    list.splice(best, 2, merged)
    lengths.splice(best, 2, length)
  }
  // A single merged line can still overflow a tiny allowance: the cap is hard.
  const index = list.map(renderEpisode).join('\n')
  return index.length <= maxChars ? index : `${index.slice(0, Math.max(0, maxChars - 1))}…`
}
