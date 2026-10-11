import { homedir } from 'os'
import { join } from 'path'

export type Config = {
  dataDir: string
  /** Target size of the compacted conversation, in estimated tokens. */
  budgetTokens: number
  /** Layer shares of the budget; the tail takes whatever the others leave. */
  shares: { pinned: number; ledger: number; index: number; middle: number }
  /** Tool-input string values longer than this are cut in the masked layer. */
  inputCapChars: number
  /** Tool results up to this size stay verbatim in the masked layer. */
  smallResultChars: number
  /** Error results up to this size stay verbatim (failure signals matter). */
  errorResultChars: number
  /** User text longer than this is cut in the masked layer (large pastes). */
  userTextCapChars: number
  ledgerModel: string
  /** Rebuild the ledger from the whole archive every N compactions; 0 disables. */
  ledgerRebuildEvery: number
  /** Max chars of rendered history sent in one ledger request. */
  ledgerChunkChars: number
  /**
   * A full rebuild reads the whole evicted history, so its cost grows with the
   * session; past this many requests it is skipped for an incremental update.
   */
  ledgerRebuildMaxRequests: number
  /** The background worker only runs once this much new history awaits the ledger. */
  prepareMinChars: number
}

function envInt(name: string, fallback: number, min = 1): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
}

/** The background worker waits for this share of the budget in new history before it runs. */
const PREPARE_MIN_SHARE = 0.05

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const budgetTokens = overrides.budgetTokens ?? envInt('STRATA_BUDGET_TOKENS', 100_000)
  return {
    dataDir: process.env.STRATA_DATA_DIR ?? join(homedir(), '.strata'),
    budgetTokens,
    shares: { pinned: 0.04, ledger: 0.06, index: 0.06, middle: 0.24 },
    inputCapChars: 200,
    smallResultChars: 300,
    errorResultChars: 1_000,
    userTextCapChars: 4_000,
    ledgerModel: process.env.STRATA_LEDGER_MODEL ?? 'claude-sonnet-5-5',
    ledgerRebuildEvery: envInt('STRATA_LEDGER_REBUILD_EVERY', 5, 0),
    ledgerChunkChars: 400_000,
    ledgerRebuildMaxRequests: 3,
    prepareMinChars: Math.round(budgetTokens * CHARS_PER_TOKEN * PREPARE_MIN_SHARE),
    ...overrides
  }
}

/** Char-based estimate; JSON-heavy agent content runs denser than prose. */
export const CHARS_PER_TOKEN = 3.5

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

export function budgetChars(config: Config): number {
  return config.budgetTokens * CHARS_PER_TOKEN
}

/** The character cap of one budget share (`config.shares`). */
export function shareChars(config: Config, share: keyof Config['shares']): number {
  return Math.floor(budgetChars(config) * config.shares[share])
}
