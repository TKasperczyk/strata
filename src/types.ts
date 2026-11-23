// Mirrors the engine's SessionMessage shape (function-hook API, Claude Code 2.1.294).
// Kept structural so the CLI never depends on the engine's type package.

export type ToolUse = {
  tool_use_id: string
  tool: string
  input: Record<string, unknown>
  text?: string
  isError?: true
}

export type ToolResult = {
  tool_use_id: string
  text: string
  isError: boolean
}

export type Message = {
  role: 'user' | 'assistant'
  text: string
  toolUses: ToolUse[]
  toolResults?: ToolResult[]
}

/** An image the archive saved as a file: a tool result's (by id) or a prompt's. */
export type MediaRef = { toolUseId?: string; path: string }

/** A raw message as the archive stores it: one per line, `seq` = line index. */
export type ArchivedMessage = Message & { seq: number; media?: MediaRef[] }

/**
 * One entry of the compacted conversation the CLI hands back: either "keep the
 * engine's own message at this input index" (handle preserved, lossless) or a
 * message the CLI built.
 */
export type OutputEntry = { keep: number } | { built: Message }

export const HEADER_MARK = '[strata: compacted conversation]'

/** One message of the last compaction's output, as the next input should repeat it. */
export type OutputRecord = {
  fp: string
  /** Branch length this message accounts for: a rewind to here keeps branch.slice(0, upto). */
  upto: number
  /** Archive seq when it was a raw message passed through by handle; -1 when strata built it. */
  seq: number
  /** Message role, used to reject wrong-role false matches on normalized built messages. */
  role?: 'user' | 'assistant'
  /** True when this built message is strata's compaction header. */
  isHeader?: true
}

export type SessionState = {
  /**
   * The active conversation as archive seqs, in order. The archive keeps every
   * message ever seen; the branch drops what a rewind discarded.
   */
  branch: number[]
  lastOutput: OutputRecord[]
  ledger: string
  /** Branch prefix the ledger accounts for; only advances when an update succeeds. */
  ledgerThrough: number
  /** Incremental ledger updates since the last full rebuild. */
  ledgerAge: number
  compactions: number
  /** Branch cut row of the last compaction, for status/lag reporting. */
  lastCut?: number
}
