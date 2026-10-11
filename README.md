# strata

Layered, budget-bounded compaction for Claude Code. It replaces the built-in "summarize everything" compaction with:

1. **A text archive.** The text of every message the session produced goes into `~/.strata/sessions/<session-id>/archive.jsonl`: prompts, replies, tool calls and full tool results. Images, documents and thinking blocks are not archived. They survive only while their message stays in the verbatim tail, and a placeholder marks where one was.
2. **Rebuilt from the active branch every time.** Each compaction rebuilds the live context from the archive under a fixed, enforced token budget. It never summarizes a previous summary, so the size stays flat however many compactions run. A rewind drops the abandoned branch from the live context; the archive keeps it.

Everything is laid out in whole units: a prompt, or a tool exchange, meaning an assistant response with every call and result it opened. The engine hands over one row per content block, with results interleaved between a response's calls. A unit is therefore never split, and a rebuilt exchange becomes one assistant turn plus one results turn, keeping every call paired with its result. The latest response always stays verbatim, from its opening thinking row on, because a rebuilt message loses its thinking block, and with manual extended thinking the final assistant turn must keep its own. strata declines instead, so the CLI exits 3 and the plugin falls back to the built-in compactor, in two cases: that response alone exceeds the budget, or part of it was already rebuilt by an earlier compaction, so its thinking can no longer be kept (this only happens after a rewind). A rejected compaction writes nothing, so a retry never archives anything twice.

The rebuilt context has these layers, oldest first:

| Layer | Default share | Contents |
|---|---|---|
| Header: original request | 4% | The first user prompt of the archived part. |
| Header: ledger | 6% | A state document (goal, constraints, decisions with reasons, dead ends, current state, open items). The ledger model rewrites it each compaction, with `#seq` citations into the archive, and rebuilds it from the whole archive every 5 compactions. |
| Header: episode index | 6% | One deterministic line per archived prompt-turn: prompt, tools, files, errors, outcome. Adjacent lines merge into coarser ones when it overflows. |
| Masked middle | 24% | User and assistant text verbatim. Tool calls kept with shortened arguments. Large tool results replaced by `[strata elided … archive seq N]`. Tool calls are never dropped, which avoids the fabricated-work failure seen in fast-jev-compaction #65. |
| Verbatim tail | rest | The newest units, passed through as the engine's own messages (thinking, images and response grouping intact). |

The model can recover anything with `node dist/cli.js show <session> <seq> [<last>]`, or by reading the archive file. The header tells it how.

## Self-trigger and background ledger

strata compacts on its own, so it works with `autoCompactEnabled: false`. That takes two plugins, because a plugin's own `$.session.compact()` skips every hook of that plugin: `strata-trigger` (`plugin-trigger/`) starts the compaction, and `strata` (`plugin/`) answers it. Load both. After every main-loop turn they read the context size (`$.session.usage()`, which is free) and then:

- **Past `STRATA_PREPARE_TOKENS`** (default 3/4 of the trigger), it starts `strata prepare` in the background. That job folds everything the next compaction would evict into a ready ledger (`ready-ledger.json`). You keep working while it runs. It writes only that file, never the archive or state. The file is tied to the exact history it covers, so a rewind or replacement invalidates it. Only one job runs per session.
- **Past `STRATA_TRIGGER_TOKENS`** (default 400000), `strata-trigger` compacts between turns, and `strata` answers with `--ledger ready`: deterministic assembly plus the newest ready ledger, with no model call, so it takes about 1-2 s. A ledger that lags the cut says so in the header, and the gap is still covered by the episode index and the archive. Right afterwards, `strata` catches the ledger up in the background, planning on exactly the output it just produced.

A manual `/compact` still brings the ledger fully up to date first, so it waits on the model. Set `STRATA_AUTO=0` to turn off the self-trigger.

Each compaction rewrites the start of the conversation, so the next request misses the prompt cache. Keep the trigger well above the post-compaction size, which is about the budget plus your system prompt and tools. That makes compactions rare: roughly once per `trigger - retained size` tokens of new work.

## Layout

- `src/`: the CLI and core logic. Model calls use the same SDK client and auth as [claude-memory](https://github.com/TKasperczyk/claude-memory) (`src/anthropic.ts`, copied over): `ANTHROPIC_API_KEY`, then `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`, then `~/.claude/.credentials.json`.
- `plugin/`: a Claude Code function-hook plugin. It answers `session.compact` by piping the transcript to `dist/cli.js compact --in - --out -`.
  - If anything fails (non-zero exit, timeout, bad output), it falls back to the built-in compactor.
  - Precompute dispatches are skipped.
  - Subagent compactions use the built-in compactor.

## Use

```bash
pnpm install && pnpm build
pnpm test                       # core invariants
claude plugin test plugin          # compaction hook and background ledger
claude plugin test plugin-trigger  # self-trigger

# Offline: replay a real transcript and watch the live context across compactions
node dist/cli.js replay ~/.claude/projects/<proj>/<session>.jsonl --budget 30000 --trigger 60000 [--no-llm] [--keep] [--background]

# Live: load both plugins for one session (strata answers compactions, strata-trigger starts them)
claude --plugin-dir ~/Programming/strata/plugin --plugin-dir ~/Programming/strata/plugin-trigger
```

## Settings (env)

| Variable | Default | Meaning |
|---|---|---|
| `STRATA_BUDGET_TOKENS` | `100000` | Size of the rebuilt context (chars / 3.5 estimate). Set Claude Code's trigger well above it, e.g. `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. |
| `STRATA_LEDGER_MODEL` | `claude-sonnet-5-5` | Model that writes the ledger. |
| `STRATA_LEDGER_REBUILD_EVERY` | `5` | Rebuild the ledger from the whole archive every N compactions (0 = never). Skipped for an incremental update once a rebuild would take more than 3 model requests, so long sessions don't pay a cost that keeps growing. |
| `STRATA_TRIGGER_TOKENS` | `400000` | Plugin: compact on its own once the context passes this. |
| `STRATA_PREPARE_TOKENS` | 3/4 of trigger | Plugin: start preparing the ledger in the background past this. |
| `STRATA_AUTO` | on | Plugin: `0` turns off the self-trigger and background preparation. |
| `STRATA_DATA_DIR` | `~/.strata` | Where archives and per-session state live. |

## Known limits

- The archive holds full tool output, including anything sensitive that passed through the session. It stays local, but treat `~/.strata` like your transcripts.
- Recognizing its own previous output depends on the engine returning those messages unchanged. One rewritten strata-built message is tolerated, but only when every later message of the previous output still matches by position. A rewind with an edited prompt regenerates everything after it, so it can't pass that check even when a reply happens to repeat. If recognition fails, everything after the mismatch is archived as new history, so it shows up twice. The plugin's log line and the `matched` stat show when this happened.
- When nothing of the previous output comes back (a foreign compaction, or the conversation was replaced), the ledger is dropped and rebuilt from the new branch, because the old one may describe history that is no longer active.
- A response is detected by row patterns. The hook's message projection carries no response ID, so a response split by its own tool results may be cut into two units. The thinking-row protection above keeps the latest response intact. Older responses lose only their thinking blocks, which the API doesn't require for earlier turns. Reading the full API-form messages (`$.session.messages({ as: 'api' })`) would fix this and the image/document limit, at the cost of a larger refactor.
- The ledger cursor advances only when an update succeeds, so a failed ledger call is retried on the next compaction.
- The ledger is the only LLM-written layer and is updated from its previous version. The periodic full rebuild and the `#seq` citations bound how far it can drift, but they don't eliminate it.
- Token counts are character estimates, not tokenizer counts.
- Function hooks are early access in Claude Code (built against 2.1.294), and the `session.compact` contract may change.
