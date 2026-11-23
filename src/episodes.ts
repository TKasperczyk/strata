import { safeSlicePrefix, safeSliceSuffix } from './mask.js'
import type { ArchivedMessage } from './types.js'

/** One user-prompted stretch of work, or several merged once the index overflows. */
export type Episode = {
  first: number
  last: number
  /** Episodes merged into this one (1 = a single prompt). */
  span: number
  prompts: string[]
  files: string[]
  commands: string[]
  toolCounts: Record<string, number>
  errors: number
  errorHints: string[]
  outcome: string
}

export type RenderIndexOptions = {
  /** Episodes reaching this seq or later (e.g., past a lagging ledger) are protected longest. */
  protectAfterSeq?: number
  /** Number of newest evicted episodes to protect before coarsening them (default 4). */
  protectRecent?: number
}

const FILE_KEYS = ['file_path', 'path', 'notebook_path']
const MAX_FILES = 6
const MAX_COMMANDS = 3
const MAX_ERROR_HINTS = 2
const PATH_CHARS = 80
const COMMAND_CHARS = 55
const ERROR_HINT_CHARS = 80
const LINE_CHARS = 600
const PROMPT_CHARS = 140
const OUTCOME_CHARS = 160
const DEFAULT_PROTECT_RECENT = 4
const SPECIFIC_ERROR_RE = /\b(error|failed|fail|exception|panic|fatal|denied|not found|enoent|eexist|eacces|econnrefused|typeerror|syntaxerror|referenceerror|assertionerror)\b/i
const GENERIC_EXIT_RE = /^(command\s+(failed|exited)\b.*|exit\s+code\s+\d+\b.*|exited\s+with\s+(code|status)\s+\d+\b.*)$/i
const FALLBACK_ERROR_RE = /\b(exit code|exited with)\b/i

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${safeSlicePrefix(flat, max)}…`
}

/** Keep the tail of a long path: the file name is the useful part. */
function shortPath(path: string): string {
  return path.length <= PATH_CHARS ? path : `…${safeSliceSuffix(path, PATH_CHARS - 1)}`
}

function compactCommand(raw: string): string {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  const first = lines.find(l => !l.startsWith('#')) ?? lines[0] ?? ''
  return oneLine(first, COMMAND_CHARS)
}

function compactErrorHint(raw: string): string {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length) return ''
  let picked: string | undefined
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SPECIFIC_ERROR_RE.test(lines[i]) && !GENERIC_EXIT_RE.test(lines[i])) {
      picked = lines[i]
      break
    }
  }
  if (!picked) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (FALLBACK_ERROR_RE.test(lines[i])) {
        picked = lines[i]
        break
      }
    }
  }
  return oneLine(picked ?? lines[0], ERROR_HINT_CHARS)
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
        commands: [],
        toolCounts: {},
        errors: 0,
        errorHints: [],
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
      if (u.tool === 'Bash' && typeof u.input.command === 'string') {
        const cmd = compactCommand(u.input.command)
        if (cmd && !current.commands.includes(cmd)) current.commands.push(cmd)
      }
    }
    for (const r of m.toolResults ?? []) {
      if (!r.isError) continue
      current.errors++
      const hint = compactErrorHint(r.text)
      if (hint && !current.errorHints.includes(hint)) current.errorHints.push(hint)
    }
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
    commands: [...new Set([...a.commands, ...b.commands])],
    toolCounts,
    errors: a.errors + b.errors,
    errorHints: [...new Set([...a.errorHints, ...b.errorHints])],
    outcome: b.outcome || a.outcome
  }
}

export function renderEpisode(e: Episode): string {
  const tools = Object.entries(e.toolCounts)
    .sort((x, y) => y[1] - x[1])
    .map(([tool, n]) => (n > 1 ? `${tool}×${n}` : tool))
    .join(' ')
  const shownFiles = e.files.slice(0, MAX_FILES).map(shortPath).join(', ')
  const files = e.files.length > MAX_FILES ? `${shownFiles} +${e.files.length - MAX_FILES} more` : shownFiles
  const shownCmds = e.commands.slice(0, MAX_COMMANDS).map(c => `\`${c}\``).join(', ')
  const cmds = e.commands.length > MAX_COMMANDS ? `${shownCmds} +${e.commands.length - MAX_COMMANDS} more` : shownCmds
  const hints = e.errorHints.slice(0, MAX_ERROR_HINTS).join('; ')
  const prompts = e.span === 1
    ? e.prompts.map(p => `"${p}"`).join(' ')
    : `${e.span} prompts, e.g. ${e.prompts.slice(0, 2).map(p => `"${oneLine(p, 60)}"`).join(' | ')}`
  const parts = [`[seq ${e.first}-${e.last}] ${prompts}`]
  if (tools) parts.push(`tools: ${tools}`)
  if (files) parts.push(`files: ${files}`)
  if (cmds) parts.push(`cmds: ${cmds}`)
  if (e.errors) parts.push(hints ? `errors: ${e.errors} (${hints})` : `errors: ${e.errors}`)
  if (e.outcome) parts.push(`ended: ${e.outcome}`)
  return oneLine(`- ${parts.join(' · ')}`, LINE_CHARS)
}

/**
 * Render the index within `maxChars`, coarsening older episodes before newer
 * ones and protecting episodes past `protectAfterSeq` (a lagging ledger gap)
 * longest. Within the same protection tier, merges the adjacent pair covering
 * the fewest episodes (oldest first on ties). Detail is lost in where to look,
 * never in what the archive holds.
 */
export function renderIndex(episodes: Episode[], maxChars: number, options: RenderIndexOptions = {}): string {
  if (maxChars <= 0 || episodes.length === 0) return ''
  const list = [...episodes]
  const protectRecent = options.protectRecent ?? DEFAULT_PROTECT_RECENT
  const recentSeq = protectRecent > 0 && episodes.length > protectRecent ? episodes[episodes.length - protectRecent].first : undefined
  const tier = (e: Episode): number => {
    if (options.protectAfterSeq !== undefined && e.last >= options.protectAfterSeq) return 2
    if (recentSeq !== undefined && e.last >= recentSeq) return 1
    return 0
  }

  const lengths = list.map(e => renderEpisode(e).length)
  let total = lengths.reduce((a, b) => a + b, 0) + Math.max(0, list.length - 1)
  while (list.length > 1 && total > maxChars) {
    let best = 0
    let bestTier = Math.max(tier(list[0]), tier(list[1]))
    let bestSpan = list[0].span + list[1].span
    for (let i = 1; i < list.length - 1; i++) {
      const pairTier = Math.max(tier(list[i]), tier(list[i + 1]))
      const pairSpan = list[i].span + list[i + 1].span
      if (pairTier < bestTier || (pairTier === bestTier && pairSpan < bestSpan)) {
        best = i
        bestTier = pairTier
        bestSpan = pairSpan
      }
    }
    const merged = merge(list[best], list[best + 1])
    const length = renderEpisode(merged).length
    // Replacing two lines separated by a newline with one line saves 1 newline too.
    total += length - lengths[best] - lengths[best + 1] - 1
    list.splice(best, 2, merged)
    lengths.splice(best, 2, length)
  }
  // A single merged line can still overflow a tiny allowance: the cap is hard.
  const index = list.map(renderEpisode).join('\n')
  if (index.length <= maxChars) return index
  return maxChars === 1 ? '…' : `${safeSlicePrefix(index, maxChars - 1)}…`
}
