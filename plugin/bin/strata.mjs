#!/usr/bin/env node
// Bundled by esbuild from src/ (pnpm bundle); do not edit.

// src/cli.ts
import { mkdtempSync, readFileSync as readFileSync5, rmSync as rmSync3, writeFileSync as writeFileSync4 } from "fs";
import { tmpdir } from "os";
import { basename, join as join7, resolve } from "path";
import { parseArgs } from "util";

// src/archive.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
var INITIAL_STATE = {
  branch: [],
  lastOutput: [],
  ledger: "",
  ledgerThrough: 0,
  ledgerAge: 0,
  compactions: 0
};
function sessionDir(dataDir, sessionKey) {
  if (!/^[A-Za-z0-9._:-]+$/.test(sessionKey)) throw new Error(`invalid session key: ${sessionKey}`);
  return join(dataDir, "sessions", sessionKey);
}
function archivePath(dir) {
  return join(dir, "archive.jsonl");
}
function isArchivedMessage(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const m = v;
  return typeof m.seq === "number" && (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && Array.isArray(m.toolUses);
}
function readArchive(dir) {
  const path2 = archivePath(dir);
  if (!existsSync(path2)) return [];
  const out = [];
  for (const line of readFileSync(path2, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (isArchivedMessage(parsed)) out.push(parsed);
    } catch {
    }
  }
  return out;
}
function numberMessages(start, messages) {
  return messages.map((m, i) => ({ ...m, seq: start + i }));
}
function repairTrailingLine(path2) {
  if (!existsSync(path2)) return;
  const raw = readFileSync(path2);
  if (raw.length === 0) return;
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === 10 || raw[end - 1] === 13)) end--;
  const lastNl = raw.lastIndexOf(10, Math.max(0, end - 1));
  const lastLine = raw.subarray(lastNl + 1, end).toString("utf-8").trim();
  if (!lastLine) return;
  try {
    const parsed = JSON.parse(lastLine);
    if (!isArchivedMessage(parsed)) throw new Error("invalid archive row");
    if (raw[raw.length - 1] !== 10) appendFileSync(path2, "\n");
  } catch {
    truncateSync(path2, lastNl >= 0 ? lastNl + 1 : 0);
  }
}
function appendArchive(dir, archived) {
  if (!archived.length) return;
  mkdirSync(dir, { recursive: true });
  const path2 = archivePath(dir);
  repairTrailingLine(path2);
  appendFileSync(path2, archived.map((m) => JSON.stringify(m)).join("\n") + "\n");
}
function isOutputRecord(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v;
  return typeof r.fp === "string" && typeof r.upto === "number" && typeof r.seq === "number";
}
function readState(dir) {
  const path2 = join(dir, "state.json");
  if (!existsSync(path2)) return { ...INITIAL_STATE };
  try {
    const parsed = JSON.parse(readFileSync(path2, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...INITIAL_STATE };
    if (!Array.isArray(parsed.branch) || !parsed.branch.every((n) => typeof n === "number") || !Array.isArray(parsed.lastOutput) || !parsed.lastOutput.every(isOutputRecord)) {
      return { ...INITIAL_STATE };
    }
    return {
      branch: parsed.branch,
      lastOutput: parsed.lastOutput,
      ledger: typeof parsed.ledger === "string" ? parsed.ledger : INITIAL_STATE.ledger,
      ledgerThrough: typeof parsed.ledgerThrough === "number" ? parsed.ledgerThrough : INITIAL_STATE.ledgerThrough,
      ledgerAge: typeof parsed.ledgerAge === "number" ? parsed.ledgerAge : INITIAL_STATE.ledgerAge,
      compactions: typeof parsed.compactions === "number" ? parsed.compactions : INITIAL_STATE.compactions,
      ...typeof parsed.lastCut === "number" ? { lastCut: parsed.lastCut } : {}
    };
  } catch {
    return { ...INITIAL_STATE };
  }
}
function tempPath(target) {
  return `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
}
function writeState(dir, state) {
  mkdirSync(dir, { recursive: true });
  const path2 = join(dir, "state.json");
  const tmp = tempPath(path2);
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, path2);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
function fingerprint(m) {
  const parts = [
    m.role,
    m.text,
    m.toolUses.map((u) => `${u.tool_use_id}:${u.tool}`),
    (m.toolResults ?? []).map((r) => [r.tool_use_id, r.isError, r.text])
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url");
}
function matchedPrefix(input, state) {
  const out = state.lastOutput;
  const same = (i) => i < input.length && fingerprint(input[i]) === out[i].fp;
  const keptMatchFrom = new Array(out.length + 1).fill(true);
  const hasKeptFrom = new Array(out.length + 1).fill(false);
  const restSame = new Array(out.length + 1).fill(true);
  for (let k = out.length - 1; k >= 0; k--) {
    const isKept = out[k].seq >= 0;
    keptMatchFrom[k] = keptMatchFrom[k + 1] && (!isKept || same(k));
    hasKeptFrom[k] = hasKeptFrom[k + 1] || isKept;
    restSame[k] = restSame[k + 1] && same(k);
  }
  let p = 0;
  while (p < out.length && p < input.length) {
    if (same(p)) {
      p++;
      continue;
    }
    const tailIntact = hasKeptFrom[p + 1] && keptMatchFrom[p + 1];
    const fallbackIntact = !hasKeptFrom[0] && p + 1 < out.length && restSame[p + 1];
    if (out[p].seq === -1 && (tailIntact || fallbackIntact)) {
      p++;
      continue;
    }
    break;
  }
  return p;
}

// src/compact.ts
import { mkdirSync as mkdirSync3, writeFileSync as writeFileSync3 } from "fs";
import { join as join5 } from "path";

// src/config.ts
import { homedir } from "os";
import { join as join2 } from "path";
function envInt(name, fallback, min = 1) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
}
var PREPARE_MIN_SHARE = 0.05;
function loadConfig(overrides = {}) {
  const budgetTokens = overrides.budgetTokens ?? envInt("STRATA_BUDGET_TOKENS", 2e5);
  return {
    dataDir: process.env.STRATA_DATA_DIR ?? join2(homedir(), ".strata"),
    budgetTokens,
    shares: { pinned: 0.04, ledger: 0.06, index: 0.06, middle: 0.24 },
    inputCapChars: 200,
    smallResultChars: 300,
    errorResultChars: 1e3,
    userTextCapChars: 4e3,
    assistantTextCapChars: 4e3,
    ledgerModel: process.env.STRATA_LEDGER_MODEL ?? "sonnet",
    ledgerRebuildEvery: envInt("STRATA_LEDGER_REBUILD_EVERY", 5, 0),
    ledgerChunkChars: 4e5,
    ledgerRebuildMaxRequests: 3,
    prepareMinChars: Math.round(budgetTokens * CHARS_PER_TOKEN * PREPARE_MIN_SHARE),
    ...overrides
  };
}
var CHARS_PER_TOKEN = 3.5;
function estimateTokens(chars) {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
function budgetChars(config) {
  return config.budgetTokens * CHARS_PER_TOKEN;
}
function shareChars(config, share) {
  return Math.floor(budgetChars(config) * config.shares[share]);
}

// src/episodes.ts
var FILE_KEYS = ["file_path", "path", "notebook_path"];
var MAX_FILES = 6;
var MAX_COMMANDS = 3;
var MAX_ERROR_HINTS = 2;
var PATH_CHARS = 80;
var COMMAND_CHARS = 55;
var ERROR_HINT_CHARS = 80;
var LINE_CHARS = 600;
var PROMPT_CHARS = 140;
var OUTCOME_CHARS = 160;
var DEFAULT_PROTECT_RECENT = 4;
var ERROR_LINE_RE = /\b(error|failed|fail|exception|panic|fatal|denied|not found|exit code|enoent|eexist|eacces|typeerror|syntaxerror|referenceerror)\b/i;
function oneLine(text, max) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}\u2026`;
}
function shortPath(path2) {
  return path2.length <= PATH_CHARS ? path2 : `\u2026${path2.slice(-(PATH_CHARS - 1))}`;
}
function compactCommand(raw) {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines.find((l) => !l.startsWith("#")) ?? lines[0] ?? "";
  return oneLine(first, COMMAND_CHARS);
}
function compactErrorHint(raw) {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return "";
  let picked;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ERROR_LINE_RE.test(lines[i])) {
      picked = lines[i];
      break;
    }
  }
  return oneLine(picked ?? lines[0], ERROR_HINT_CHARS);
}
function isPrompt(m) {
  return m.role === "user" && m.text.trim() !== "" && !m.toolResults?.length;
}
function segmentEpisodes(messages) {
  const episodes = [];
  let current;
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
        outcome: ""
      };
      episodes.push(current);
    }
    current.last = m.seq;
    if (m.role === "assistant" && m.text.trim()) current.outcome = oneLine(m.text, OUTCOME_CHARS);
    for (const u of m.toolUses) {
      current.toolCounts[u.tool] = (current.toolCounts[u.tool] ?? 0) + 1;
      for (const key of FILE_KEYS) {
        const value = u.input[key];
        if (typeof value === "string" && !current.files.includes(value)) current.files.push(value);
      }
      if (u.tool === "Bash" && typeof u.input.command === "string") {
        const cmd = compactCommand(u.input.command);
        if (cmd && !current.commands.includes(cmd)) current.commands.push(cmd);
      }
    }
    for (const r of m.toolResults ?? []) {
      if (!r.isError) continue;
      current.errors++;
      const hint = compactErrorHint(r.text);
      if (hint && !current.errorHints.includes(hint)) current.errorHints.push(hint);
    }
  }
  return episodes;
}
function merge(a, b) {
  const toolCounts = { ...a.toolCounts };
  for (const [tool, n] of Object.entries(b.toolCounts)) toolCounts[tool] = (toolCounts[tool] ?? 0) + n;
  return {
    first: a.first,
    last: b.last,
    span: a.span + b.span,
    prompts: [...a.prompts, ...b.prompts],
    files: [.../* @__PURE__ */ new Set([...a.files, ...b.files])],
    commands: [.../* @__PURE__ */ new Set([...a.commands, ...b.commands])],
    toolCounts,
    errors: a.errors + b.errors,
    errorHints: [.../* @__PURE__ */ new Set([...a.errorHints, ...b.errorHints])],
    outcome: b.outcome || a.outcome
  };
}
function renderEpisode(e) {
  const tools = Object.entries(e.toolCounts).sort((x, y) => y[1] - x[1]).map(([tool, n]) => n > 1 ? `${tool}\xD7${n}` : tool).join(" ");
  const shownFiles = e.files.slice(0, MAX_FILES).map(shortPath).join(", ");
  const files = e.files.length > MAX_FILES ? `${shownFiles} +${e.files.length - MAX_FILES} more` : shownFiles;
  const shownCmds = e.commands.slice(0, MAX_COMMANDS).map((c) => `\`${c}\``).join(", ");
  const cmds = e.commands.length > MAX_COMMANDS ? `${shownCmds} +${e.commands.length - MAX_COMMANDS} more` : shownCmds;
  const hints = e.errorHints.slice(0, MAX_ERROR_HINTS).join("; ");
  const prompts = e.span === 1 ? e.prompts.map((p) => `"${p}"`).join(" ") : `${e.span} prompts, e.g. ${e.prompts.slice(0, 2).map((p) => `"${oneLine(p, 60)}"`).join(" | ")}`;
  const parts = [`[seq ${e.first}-${e.last}] ${prompts}`];
  if (tools) parts.push(`tools: ${tools}`);
  if (files) parts.push(`files: ${files}`);
  if (cmds) parts.push(`cmds: ${cmds}`);
  if (e.errors) parts.push(hints ? `errors: ${e.errors} (${hints})` : `errors: ${e.errors}`);
  if (e.outcome) parts.push(`ended: ${e.outcome}`);
  return oneLine(`- ${parts.join(" \xB7 ")}`, LINE_CHARS);
}
function renderIndex(episodes, maxChars, options = {}) {
  const list = [...episodes];
  const protectRecent = options.protectRecent ?? DEFAULT_PROTECT_RECENT;
  const recentSeq = protectRecent > 0 && episodes.length > protectRecent ? episodes[episodes.length - protectRecent].first : void 0;
  const tier = (e) => {
    if (options.protectAfterSeq !== void 0 && e.last >= options.protectAfterSeq) return 2;
    if (recentSeq !== void 0 && e.last >= recentSeq) return 1;
    return 0;
  };
  const lengths = list.map((e) => renderEpisode(e).length + 1);
  let total = lengths.reduce((a, b) => a + b, 0);
  while (list.length > 1 && total > maxChars) {
    let best = 0;
    let bestTier = Math.max(tier(list[0]), tier(list[1]));
    let bestSpan = list[0].span + list[1].span;
    for (let i = 1; i < list.length - 1; i++) {
      const pairTier = Math.max(tier(list[i]), tier(list[i + 1]));
      const pairSpan = list[i].span + list[i + 1].span;
      if (pairTier < bestTier || pairTier === bestTier && pairSpan < bestSpan) {
        best = i;
        bestTier = pairTier;
        bestSpan = pairSpan;
      }
    }
    const merged = merge(list[best], list[best + 1]);
    const length = renderEpisode(merged).length + 1;
    total += length - lengths[best] - lengths[best + 1];
    list.splice(best, 2, merged);
    lengths.splice(best, 2, length);
  }
  const index = list.map(renderEpisode).join("\n");
  return index.length <= maxChars ? index : `${index.slice(0, Math.max(0, maxChars - 1))}\u2026`;
}

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/tslib.mjs
function __classPrivateFieldSet(receiver, state, value, kind, f) {
  if (kind === "m")
    throw new TypeError("Private method is not writable");
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
}
function __classPrivateFieldGet(receiver, state, kind, f) {
  if (kind === "a" && !f)
    throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver))
    throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/utils/uuid.mjs
var uuid4 = function() {
  const { crypto } = globalThis;
  if (crypto?.randomUUID) {
    uuid4 = crypto.randomUUID.bind(crypto);
    return crypto.randomUUID();
  }
  const u8 = new Uint8Array(1);
  const randomByte = crypto ? () => crypto.getRandomValues(u8)[0] : () => Math.random() * 255 & 255;
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (+c ^ randomByte() & 15 >> +c / 4).toString(16));
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/errors.mjs
function isAbortError(err) {
  return typeof err === "object" && err !== null && // Spec-compliant fetch implementations
  ("name" in err && err.name === "AbortError" || // Expo fetch
  "message" in err && String(err.message).includes("FetchRequestCanceledException"));
}
var castToError = (err) => {
  if (err instanceof Error)
    return err;
  if (typeof err === "object" && err !== null) {
    try {
      if (Object.prototype.toString.call(err) === "[object Error]") {
        const error = new Error(err.message, err.cause ? { cause: err.cause } : {});
        if (err.stack)
          error.stack = err.stack;
        if (err.cause && !error.cause)
          error.cause = err.cause;
        if (err.name)
          error.name = err.name;
        return error;
      }
    } catch {
    }
    try {
      return new Error(JSON.stringify(err));
    } catch {
    }
  }
  return new Error(err);
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/core/error.mjs
var AnthropicError = class extends Error {
};
var APIError = class _APIError extends AnthropicError {
  constructor(status, error, message, headers, type) {
    super(`${_APIError.makeMessage(status, error, message)}`);
    this.status = status;
    this.headers = headers;
    this.requestID = headers?.get("request-id");
    this.error = error;
    this.type = type ?? null;
  }
  static makeMessage(status, error, message) {
    const msg = error?.message ? typeof error.message === "string" ? error.message : JSON.stringify(error.message) : error ? JSON.stringify(error) : message;
    if (status && msg) {
      return `${status} ${msg}`;
    }
    if (status) {
      return `${status} status code (no body)`;
    }
    if (msg) {
      return msg;
    }
    return "(no status code or body)";
  }
  static generate(status, errorResponse, message, headers) {
    if (!status || !headers) {
      return new APIConnectionError({ message, cause: castToError(errorResponse) });
    }
    const error = errorResponse;
    const type = error?.["error"]?.["type"];
    if (status === 400) {
      return new BadRequestError(status, error, message, headers, type);
    }
    if (status === 401) {
      return new AuthenticationError(status, error, message, headers, type);
    }
    if (status === 403) {
      return new PermissionDeniedError(status, error, message, headers, type);
    }
    if (status === 404) {
      return new NotFoundError(status, error, message, headers, type);
    }
    if (status === 409) {
      return new ConflictError(status, error, message, headers, type);
    }
    if (status === 422) {
      return new UnprocessableEntityError(status, error, message, headers, type);
    }
    if (status === 429) {
      return new RateLimitError(status, error, message, headers, type);
    }
    if (status >= 500) {
      return new InternalServerError(status, error, message, headers, type);
    }
    return new _APIError(status, error, message, headers, type);
  }
};
var APIUserAbortError = class extends APIError {
  constructor({ message } = {}) {
    super(void 0, void 0, message || "Request was aborted.", void 0);
  }
};
var APIConnectionError = class extends APIError {
  constructor({ message, cause }) {
    super(void 0, void 0, message || "Connection error.", void 0);
    if (cause)
      this.cause = cause;
  }
};
var APIConnectionTimeoutError = class extends APIConnectionError {
  constructor({ message } = {}) {
    super({ message: message ?? "Request timed out." });
  }
};
var BadRequestError = class extends APIError {
};
var AuthenticationError = class extends APIError {
};
var PermissionDeniedError = class extends APIError {
};
var NotFoundError = class extends APIError {
};
var ConflictError = class extends APIError {
};
var UnprocessableEntityError = class extends APIError {
};
var RateLimitError = class extends APIError {
};
var InternalServerError = class extends APIError {
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/utils/values.mjs
var startsWithSchemeRegexp = /^[a-z][a-z0-9+.-]*:/i;
var isAbsoluteURL = (url) => {
  return startsWithSchemeRegexp.test(url);
};
var isArray = (val) => (isArray = Array.isArray, isArray(val));
var isReadonlyArray = isArray;
function maybeObj(x) {
  if (typeof x !== "object") {
    return {};
  }
  return x ?? {};
}
function isEmptyObj(obj) {
  if (!obj)
    return true;
  for (const _k in obj)
    return false;
  return true;
}
function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
var validatePositiveInteger = (name, n) => {
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new AnthropicError(`${name} must be an integer`);
  }
  if (n < 0) {
    throw new AnthropicError(`${name} must be a positive integer`);
  }
  return n;
};
var safeJSON = (text) => {
  try {
    return JSON.parse(text);
  } catch (err) {
    return void 0;
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/utils/sleep.mjs
var sleep = (ms) => new Promise((resolve2) => setTimeout(resolve2, ms));

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/version.mjs
var VERSION = "0.90.0";

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/detect-platform.mjs
var isRunningInBrowser = () => {
  return (
    // @ts-ignore
    typeof window !== "undefined" && // @ts-ignore
    typeof window.document !== "undefined" && // @ts-ignore
    typeof navigator !== "undefined"
  );
};
function getDetectedPlatform() {
  if (typeof Deno !== "undefined" && Deno.build != null) {
    return "deno";
  }
  if (typeof EdgeRuntime !== "undefined") {
    return "edge";
  }
  if (Object.prototype.toString.call(typeof globalThis.process !== "undefined" ? globalThis.process : 0) === "[object process]") {
    return "node";
  }
  return "unknown";
}
var getPlatformProperties = () => {
  const detectedPlatform = getDetectedPlatform();
  if (detectedPlatform === "deno") {
    return {
      "X-Stainless-Lang": "js",
      "X-Stainless-Package-Version": VERSION,
      "X-Stainless-OS": normalizePlatform(Deno.build.os),
      "X-Stainless-Arch": normalizeArch(Deno.build.arch),
      "X-Stainless-Runtime": "deno",
      "X-Stainless-Runtime-Version": typeof Deno.version === "string" ? Deno.version : Deno.version?.deno ?? "unknown"
    };
  }
  if (typeof EdgeRuntime !== "undefined") {
    return {
      "X-Stainless-Lang": "js",
      "X-Stainless-Package-Version": VERSION,
      "X-Stainless-OS": "Unknown",
      "X-Stainless-Arch": `other:${EdgeRuntime}`,
      "X-Stainless-Runtime": "edge",
      "X-Stainless-Runtime-Version": globalThis.process.version
    };
  }
  if (detectedPlatform === "node") {
    return {
      "X-Stainless-Lang": "js",
      "X-Stainless-Package-Version": VERSION,
      "X-Stainless-OS": normalizePlatform(globalThis.process.platform ?? "unknown"),
      "X-Stainless-Arch": normalizeArch(globalThis.process.arch ?? "unknown"),
      "X-Stainless-Runtime": "node",
      "X-Stainless-Runtime-Version": globalThis.process.version ?? "unknown"
    };
  }
  const browserInfo = getBrowserInfo();
  if (browserInfo) {
    return {
      "X-Stainless-Lang": "js",
      "X-Stainless-Package-Version": VERSION,
      "X-Stainless-OS": "Unknown",
      "X-Stainless-Arch": "unknown",
      "X-Stainless-Runtime": `browser:${browserInfo.browser}`,
      "X-Stainless-Runtime-Version": browserInfo.version
    };
  }
  return {
    "X-Stainless-Lang": "js",
    "X-Stainless-Package-Version": VERSION,
    "X-Stainless-OS": "Unknown",
    "X-Stainless-Arch": "unknown",
    "X-Stainless-Runtime": "unknown",
    "X-Stainless-Runtime-Version": "unknown"
  };
};
function getBrowserInfo() {
  if (typeof navigator === "undefined" || !navigator) {
    return null;
  }
  const browserPatterns = [
    { key: "edge", pattern: /Edge(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "ie", pattern: /MSIE(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "ie", pattern: /Trident(?:.*rv\:(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "chrome", pattern: /Chrome(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "firefox", pattern: /Firefox(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/ },
    { key: "safari", pattern: /(?:Version\W+(\d+)\.(\d+)(?:\.(\d+))?)?(?:\W+Mobile\S*)?\W+Safari/ }
  ];
  for (const { key, pattern } of browserPatterns) {
    const match = pattern.exec(navigator.userAgent);
    if (match) {
      const major = match[1] || 0;
      const minor = match[2] || 0;
      const patch = match[3] || 0;
      return { browser: key, version: `${major}.${minor}.${patch}` };
    }
  }
  return null;
}
var normalizeArch = (arch) => {
  if (arch === "x32")
    return "x32";
  if (arch === "x86_64" || arch === "x64")
    return "x64";
  if (arch === "arm")
    return "arm";
  if (arch === "aarch64" || arch === "arm64")
    return "arm64";
  if (arch)
    return `other:${arch}`;
  return "unknown";
};
var normalizePlatform = (platform2) => {
  platform2 = platform2.toLowerCase();
  if (platform2.includes("ios"))
    return "iOS";
  if (platform2 === "android")
    return "Android";
  if (platform2 === "darwin")
    return "MacOS";
  if (platform2 === "win32")
    return "Windows";
  if (platform2 === "freebsd")
    return "FreeBSD";
  if (platform2 === "openbsd")
    return "OpenBSD";
  if (platform2 === "linux")
    return "Linux";
  if (platform2)
    return `Other:${platform2}`;
  return "Unknown";
};
var _platformHeaders;
var getPlatformHeaders = () => {
  return _platformHeaders ?? (_platformHeaders = getPlatformProperties());
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/shims.mjs
function getDefaultFetch() {
  if (typeof fetch !== "undefined") {
    return fetch;
  }
  throw new Error("`fetch` is not defined as a global; Either pass `fetch` to the client, `new Anthropic({ fetch })` or polyfill the global, `globalThis.fetch = fetch`");
}
function makeReadableStream(...args) {
  const ReadableStream = globalThis.ReadableStream;
  if (typeof ReadableStream === "undefined") {
    throw new Error("`ReadableStream` is not defined as a global; You will need to polyfill it, `globalThis.ReadableStream = ReadableStream`");
  }
  return new ReadableStream(...args);
}
function ReadableStreamFrom(iterable) {
  let iter = Symbol.asyncIterator in iterable ? iterable[Symbol.asyncIterator]() : iterable[Symbol.iterator]();
  return makeReadableStream({
    start() {
    },
    async pull(controller) {
      const { done, value } = await iter.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    async cancel() {
      await iter.return?.();
    }
  });
}
function ReadableStreamToAsyncIterable(stream) {
  if (stream[Symbol.asyncIterator])
    return stream;
  const reader = stream.getReader();
  return {
    async next() {
      try {
        const result = await reader.read();
        if (result?.done)
          reader.releaseLock();
        return result;
      } catch (e) {
        reader.releaseLock();
        throw e;
      }
    },
    async return() {
      const cancelPromise = reader.cancel();
      reader.releaseLock();
      await cancelPromise;
      return { done: true, value: void 0 };
    },
    [Symbol.asyncIterator]() {
      return this;
    }
  };
}
async function CancelReadableStream(stream) {
  if (stream === null || typeof stream !== "object")
    return;
  if (stream[Symbol.asyncIterator]) {
    await stream[Symbol.asyncIterator]().return?.();
    return;
  }
  const reader = stream.getReader();
  const cancelPromise = reader.cancel();
  reader.releaseLock();
  await cancelPromise;
}

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/request-options.mjs
var FallbackEncoder = ({ headers, body }) => {
  return {
    bodyHeaders: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  };
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/utils/query.mjs
function stringifyQuery(query) {
  return Object.entries(query).filter(([_, value]) => typeof value !== "undefined").map(([key, value]) => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    }
    if (value === null) {
      return `${encodeURIComponent(key)}=`;
    }
    throw new AnthropicError(`Cannot stringify type ${typeof value}; Expected string, number, boolean, or null. If you need to pass nested query parameters, you can manually encode them, e.g. { query: { 'foo[key1]': value1, 'foo[key2]': value2 } }, and please open a GitHub issue requesting better support for your use case.`);
  }).join("&");
}

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/utils/bytes.mjs
function concatBytes(buffers) {
  let length = 0;
  for (const buffer of buffers) {
    length += buffer.length;
  }
  const output = new Uint8Array(length);
  let index = 0;
  for (const buffer of buffers) {
    output.set(buffer, index);
    index += buffer.length;
  }
  return output;
}
var encodeUTF8_;
function encodeUTF8(str) {
  let encoder;
  return (encodeUTF8_ ?? (encoder = new globalThis.TextEncoder(), encodeUTF8_ = encoder.encode.bind(encoder)))(str);
}
var decodeUTF8_;
function decodeUTF8(bytes) {
  let decoder;
  return (decodeUTF8_ ?? (decoder = new globalThis.TextDecoder(), decodeUTF8_ = decoder.decode.bind(decoder)))(bytes);
}

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/decoders/line.mjs
var _LineDecoder_buffer;
var _LineDecoder_carriageReturnIndex;
var LineDecoder = class {
  constructor() {
    _LineDecoder_buffer.set(this, void 0);
    _LineDecoder_carriageReturnIndex.set(this, void 0);
    __classPrivateFieldSet(this, _LineDecoder_buffer, new Uint8Array(), "f");
    __classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, null, "f");
  }
  decode(chunk) {
    if (chunk == null) {
      return [];
    }
    const binaryChunk = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : typeof chunk === "string" ? encodeUTF8(chunk) : chunk;
    __classPrivateFieldSet(this, _LineDecoder_buffer, concatBytes([__classPrivateFieldGet(this, _LineDecoder_buffer, "f"), binaryChunk]), "f");
    const lines = [];
    let patternIndex;
    while ((patternIndex = findNewlineIndex(__classPrivateFieldGet(this, _LineDecoder_buffer, "f"), __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f"))) != null) {
      if (patternIndex.carriage && __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") == null) {
        __classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, patternIndex.index, "f");
        continue;
      }
      if (__classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") != null && (patternIndex.index !== __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") + 1 || patternIndex.carriage)) {
        lines.push(decodeUTF8(__classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(0, __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") - 1)));
        __classPrivateFieldSet(this, _LineDecoder_buffer, __classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(__classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f")), "f");
        __classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, null, "f");
        continue;
      }
      const endIndex = __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") !== null ? patternIndex.preceding - 1 : patternIndex.preceding;
      const line = decodeUTF8(__classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(0, endIndex));
      lines.push(line);
      __classPrivateFieldSet(this, _LineDecoder_buffer, __classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(patternIndex.index), "f");
      __classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, null, "f");
    }
    return lines;
  }
  flush() {
    if (!__classPrivateFieldGet(this, _LineDecoder_buffer, "f").length) {
      return [];
    }
    return this.decode("\n");
  }
};
_LineDecoder_buffer = /* @__PURE__ */ new WeakMap(), _LineDecoder_carriageReturnIndex = /* @__PURE__ */ new WeakMap();
LineDecoder.NEWLINE_CHARS = /* @__PURE__ */ new Set(["\n", "\r"]);
LineDecoder.NEWLINE_REGEXP = /\r\n|[\n\r]/g;
function findNewlineIndex(buffer, startIndex) {
  const newline = 10;
  const carriage = 13;
  for (let i = startIndex ?? 0; i < buffer.length; i++) {
    if (buffer[i] === newline) {
      return { preceding: i, index: i + 1, carriage: false };
    }
    if (buffer[i] === carriage) {
      return { preceding: i, index: i + 1, carriage: true };
    }
  }
  return null;
}
function findDoubleNewlineIndex(buffer) {
  const newline = 10;
  const carriage = 13;
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i] === newline && buffer[i + 1] === newline) {
      return i + 2;
    }
    if (buffer[i] === carriage && buffer[i + 1] === carriage) {
      return i + 2;
    }
    if (buffer[i] === carriage && buffer[i + 1] === newline && i + 3 < buffer.length && buffer[i + 2] === carriage && buffer[i + 3] === newline) {
      return i + 4;
    }
  }
  return -1;
}

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/utils/log.mjs
var levelNumbers = {
  off: 0,
  error: 200,
  warn: 300,
  info: 400,
  debug: 500
};
var parseLogLevel = (maybeLevel, sourceName, client) => {
  if (!maybeLevel) {
    return void 0;
  }
  if (hasOwn(levelNumbers, maybeLevel)) {
    return maybeLevel;
  }
  loggerFor(client).warn(`${sourceName} was set to ${JSON.stringify(maybeLevel)}, expected one of ${JSON.stringify(Object.keys(levelNumbers))}`);
  return void 0;
};
function noop() {
}
function makeLogFn(fnLevel, logger, logLevel) {
  if (!logger || levelNumbers[fnLevel] > levelNumbers[logLevel]) {
    return noop;
  } else {
    return logger[fnLevel].bind(logger);
  }
}
var noopLogger = {
  error: noop,
  warn: noop,
  info: noop,
  debug: noop
};
var cachedLoggers = /* @__PURE__ */ new WeakMap();
function loggerFor(client) {
  const logger = client.logger;
  const logLevel = client.logLevel ?? "off";
  if (!logger) {
    return noopLogger;
  }
  const cachedLogger = cachedLoggers.get(logger);
  if (cachedLogger && cachedLogger[0] === logLevel) {
    return cachedLogger[1];
  }
  const levelLogger = {
    error: makeLogFn("error", logger, logLevel),
    warn: makeLogFn("warn", logger, logLevel),
    info: makeLogFn("info", logger, logLevel),
    debug: makeLogFn("debug", logger, logLevel)
  };
  cachedLoggers.set(logger, [logLevel, levelLogger]);
  return levelLogger;
}
var formatRequestDetails = (details) => {
  if (details.options) {
    details.options = { ...details.options };
    delete details.options["headers"];
  }
  if (details.headers) {
    details.headers = Object.fromEntries((details.headers instanceof Headers ? [...details.headers] : Object.entries(details.headers)).map(([name, value]) => [
      name,
      name.toLowerCase() === "x-api-key" || name.toLowerCase() === "authorization" || name.toLowerCase() === "cookie" || name.toLowerCase() === "set-cookie" ? "***" : value
    ]));
  }
  if ("retryOfRequestLogID" in details) {
    if (details.retryOfRequestLogID) {
      details.retryOf = details.retryOfRequestLogID;
    }
    delete details.retryOfRequestLogID;
  }
  return details;
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/core/streaming.mjs
var _Stream_client;
var Stream = class _Stream {
  constructor(iterator, controller, client) {
    this.iterator = iterator;
    _Stream_client.set(this, void 0);
    this.controller = controller;
    __classPrivateFieldSet(this, _Stream_client, client, "f");
  }
  static fromSSEResponse(response, controller, client) {
    let consumed = false;
    const logger = client ? loggerFor(client) : console;
    async function* iterator() {
      if (consumed) {
        throw new AnthropicError("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
      }
      consumed = true;
      let done = false;
      try {
        for await (const sse of _iterSSEMessages(response, controller)) {
          if (sse.event === "completion") {
            try {
              yield JSON.parse(sse.data);
            } catch (e) {
              logger.error(`Could not parse message into JSON:`, sse.data);
              logger.error(`From chunk:`, sse.raw);
              throw e;
            }
          }
          if (sse.event === "message_start" || sse.event === "message_delta" || sse.event === "message_stop" || sse.event === "content_block_start" || sse.event === "content_block_delta" || sse.event === "content_block_stop" || sse.event === "message" || sse.event === "user.message" || sse.event === "user.interrupt" || sse.event === "user.tool_confirmation" || sse.event === "user.custom_tool_result" || sse.event === "agent.message" || sse.event === "agent.thinking" || sse.event === "agent.tool_use" || sse.event === "agent.tool_result" || sse.event === "agent.mcp_tool_use" || sse.event === "agent.mcp_tool_result" || sse.event === "agent.custom_tool_use" || sse.event === "agent.thread_context_compacted" || sse.event === "session.status_running" || sse.event === "session.status_idle" || sse.event === "session.status_rescheduled" || sse.event === "session.status_terminated" || sse.event === "session.error" || sse.event === "session.deleted" || sse.event === "span.model_request_start" || sse.event === "span.model_request_end") {
            try {
              yield JSON.parse(sse.data);
            } catch (e) {
              logger.error(`Could not parse message into JSON:`, sse.data);
              logger.error(`From chunk:`, sse.raw);
              throw e;
            }
          }
          if (sse.event === "ping") {
            continue;
          }
          if (sse.event === "error") {
            const body = safeJSON(sse.data) ?? sse.data;
            const type = body?.error?.type;
            throw new APIError(void 0, body, void 0, response.headers, type);
          }
        }
        done = true;
      } catch (e) {
        if (isAbortError(e))
          return;
        throw e;
      } finally {
        if (!done)
          controller.abort();
      }
    }
    return new _Stream(iterator, controller, client);
  }
  /**
   * Generates a Stream from a newline-separated ReadableStream
   * where each item is a JSON value.
   */
  static fromReadableStream(readableStream, controller, client) {
    let consumed = false;
    async function* iterLines() {
      const lineDecoder = new LineDecoder();
      const iter = ReadableStreamToAsyncIterable(readableStream);
      for await (const chunk of iter) {
        for (const line of lineDecoder.decode(chunk)) {
          yield line;
        }
      }
      for (const line of lineDecoder.flush()) {
        yield line;
      }
    }
    async function* iterator() {
      if (consumed) {
        throw new AnthropicError("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
      }
      consumed = true;
      let done = false;
      try {
        for await (const line of iterLines()) {
          if (done)
            continue;
          if (line)
            yield JSON.parse(line);
        }
        done = true;
      } catch (e) {
        if (isAbortError(e))
          return;
        throw e;
      } finally {
        if (!done)
          controller.abort();
      }
    }
    return new _Stream(iterator, controller, client);
  }
  [(_Stream_client = /* @__PURE__ */ new WeakMap(), Symbol.asyncIterator)]() {
    return this.iterator();
  }
  /**
   * Splits the stream into two streams which can be
   * independently read from at different speeds.
   */
  tee() {
    const left = [];
    const right = [];
    const iterator = this.iterator();
    const teeIterator = (queue) => {
      return {
        next: () => {
          if (queue.length === 0) {
            const result = iterator.next();
            left.push(result);
            right.push(result);
          }
          return queue.shift();
        }
      };
    };
    return [
      new _Stream(() => teeIterator(left), this.controller, __classPrivateFieldGet(this, _Stream_client, "f")),
      new _Stream(() => teeIterator(right), this.controller, __classPrivateFieldGet(this, _Stream_client, "f"))
    ];
  }
  /**
   * Converts this stream to a newline-separated ReadableStream of
   * JSON stringified values in the stream
   * which can be turned back into a Stream with `Stream.fromReadableStream()`.
   */
  toReadableStream() {
    const self = this;
    let iter;
    return makeReadableStream({
      async start() {
        iter = self[Symbol.asyncIterator]();
      },
      async pull(ctrl) {
        try {
          const { value, done } = await iter.next();
          if (done)
            return ctrl.close();
          const bytes = encodeUTF8(JSON.stringify(value) + "\n");
          ctrl.enqueue(bytes);
        } catch (err) {
          ctrl.error(err);
        }
      },
      async cancel() {
        await iter.return?.();
      }
    });
  }
};
async function* _iterSSEMessages(response, controller) {
  if (!response.body) {
    controller.abort();
    if (typeof globalThis.navigator !== "undefined" && globalThis.navigator.product === "ReactNative") {
      throw new AnthropicError(`The default react-native fetch implementation does not support streaming. Please use expo/fetch: https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api`);
    }
    throw new AnthropicError(`Attempted to iterate over a response with no body`);
  }
  const sseDecoder = new SSEDecoder();
  const lineDecoder = new LineDecoder();
  const iter = ReadableStreamToAsyncIterable(response.body);
  for await (const sseChunk of iterSSEChunks(iter)) {
    for (const line of lineDecoder.decode(sseChunk)) {
      const sse = sseDecoder.decode(line);
      if (sse)
        yield sse;
    }
  }
  for (const line of lineDecoder.flush()) {
    const sse = sseDecoder.decode(line);
    if (sse)
      yield sse;
  }
}
async function* iterSSEChunks(iterator) {
  let data = new Uint8Array();
  for await (const chunk of iterator) {
    if (chunk == null) {
      continue;
    }
    const binaryChunk = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : typeof chunk === "string" ? encodeUTF8(chunk) : chunk;
    let newData = new Uint8Array(data.length + binaryChunk.length);
    newData.set(data);
    newData.set(binaryChunk, data.length);
    data = newData;
    let patternIndex;
    while ((patternIndex = findDoubleNewlineIndex(data)) !== -1) {
      yield data.slice(0, patternIndex);
      data = data.slice(patternIndex);
    }
  }
  if (data.length > 0) {
    yield data;
  }
}
var SSEDecoder = class {
  constructor() {
    this.event = null;
    this.data = [];
    this.chunks = [];
  }
  decode(line) {
    if (line.endsWith("\r")) {
      line = line.substring(0, line.length - 1);
    }
    if (!line) {
      if (!this.event && !this.data.length)
        return null;
      const sse = {
        event: this.event,
        data: this.data.join("\n"),
        raw: this.chunks
      };
      this.event = null;
      this.data = [];
      this.chunks = [];
      return sse;
    }
    this.chunks.push(line);
    if (line.startsWith(":")) {
      return null;
    }
    let [fieldname, _, value] = partition(line, ":");
    if (value.startsWith(" ")) {
      value = value.substring(1);
    }
    if (fieldname === "event") {
      this.event = value;
    } else if (fieldname === "data") {
      this.data.push(value);
    }
    return null;
  }
};
function partition(str, delimiter) {
  const index = str.indexOf(delimiter);
  if (index !== -1) {
    return [str.substring(0, index), delimiter, str.substring(index + delimiter.length)];
  }
  return [str, "", ""];
}

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/parse.mjs
async function defaultParseResponse(client, props) {
  const { response, requestLogID, retryOfRequestLogID, startTime } = props;
  const body = await (async () => {
    if (props.options.stream) {
      loggerFor(client).debug("response", response.status, response.url, response.headers, response.body);
      if (props.options.__streamClass) {
        return props.options.__streamClass.fromSSEResponse(response, props.controller);
      }
      return Stream.fromSSEResponse(response, props.controller);
    }
    if (response.status === 204) {
      return null;
    }
    if (props.options.__binaryResponse) {
      return response;
    }
    const contentType = response.headers.get("content-type");
    const mediaType = contentType?.split(";")[0]?.trim();
    const isJSON = mediaType?.includes("application/json") || mediaType?.endsWith("+json");
    if (isJSON) {
      const contentLength = response.headers.get("content-length");
      if (contentLength === "0") {
        return void 0;
      }
      const json = await response.json();
      return addRequestID(json, response);
    }
    const text = await response.text();
    return text;
  })();
  loggerFor(client).debug(`[${requestLogID}] response parsed`, formatRequestDetails({
    retryOfRequestLogID,
    url: response.url,
    status: response.status,
    body,
    durationMs: Date.now() - startTime
  }));
  return body;
}
function addRequestID(value, response) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return Object.defineProperty(value, "_request_id", {
    value: response.headers.get("request-id"),
    enumerable: false
  });
}

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/core/api-promise.mjs
var _APIPromise_client;
var APIPromise = class _APIPromise extends Promise {
  constructor(client, responsePromise, parseResponse = defaultParseResponse) {
    super((resolve2) => {
      resolve2(null);
    });
    this.responsePromise = responsePromise;
    this.parseResponse = parseResponse;
    _APIPromise_client.set(this, void 0);
    __classPrivateFieldSet(this, _APIPromise_client, client, "f");
  }
  _thenUnwrap(transform) {
    return new _APIPromise(__classPrivateFieldGet(this, _APIPromise_client, "f"), this.responsePromise, async (client, props) => addRequestID(transform(await this.parseResponse(client, props), props), props.response));
  }
  /**
   * Gets the raw `Response` instance instead of parsing the response
   * data.
   *
   * If you want to parse the response body but still get the `Response`
   * instance, you can use {@link withResponse()}.
   *
   * 👋 Getting the wrong TypeScript type for `Response`?
   * Try setting `"moduleResolution": "NodeNext"` or add `"lib": ["DOM"]`
   * to your `tsconfig.json`.
   */
  asResponse() {
    return this.responsePromise.then((p) => p.response);
  }
  /**
   * Gets the parsed response data, the raw `Response` instance and the ID of the request,
   * returned via the `request-id` header which is useful for debugging requests and resporting
   * issues to Anthropic.
   *
   * If you just want to get the raw `Response` instance without parsing it,
   * you can use {@link asResponse()}.
   *
   * 👋 Getting the wrong TypeScript type for `Response`?
   * Try setting `"moduleResolution": "NodeNext"` or add `"lib": ["DOM"]`
   * to your `tsconfig.json`.
   */
  async withResponse() {
    const [data, response] = await Promise.all([this.parse(), this.asResponse()]);
    return { data, response, request_id: response.headers.get("request-id") };
  }
  parse() {
    if (!this.parsedPromise) {
      this.parsedPromise = this.responsePromise.then((data) => this.parseResponse(__classPrivateFieldGet(this, _APIPromise_client, "f"), data));
    }
    return this.parsedPromise;
  }
  then(onfulfilled, onrejected) {
    return this.parse().then(onfulfilled, onrejected);
  }
  catch(onrejected) {
    return this.parse().catch(onrejected);
  }
  finally(onfinally) {
    return this.parse().finally(onfinally);
  }
};
_APIPromise_client = /* @__PURE__ */ new WeakMap();

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/core/pagination.mjs
var _AbstractPage_client;
var AbstractPage = class {
  constructor(client, response, body, options) {
    _AbstractPage_client.set(this, void 0);
    __classPrivateFieldSet(this, _AbstractPage_client, client, "f");
    this.options = options;
    this.response = response;
    this.body = body;
  }
  hasNextPage() {
    const items = this.getPaginatedItems();
    if (!items.length)
      return false;
    return this.nextPageRequestOptions() != null;
  }
  async getNextPage() {
    const nextOptions = this.nextPageRequestOptions();
    if (!nextOptions) {
      throw new AnthropicError("No next page expected; please check `.hasNextPage()` before calling `.getNextPage()`.");
    }
    return await __classPrivateFieldGet(this, _AbstractPage_client, "f").requestAPIList(this.constructor, nextOptions);
  }
  async *iterPages() {
    let page = this;
    yield page;
    while (page.hasNextPage()) {
      page = await page.getNextPage();
      yield page;
    }
  }
  async *[(_AbstractPage_client = /* @__PURE__ */ new WeakMap(), Symbol.asyncIterator)]() {
    for await (const page of this.iterPages()) {
      for (const item of page.getPaginatedItems()) {
        yield item;
      }
    }
  }
};
var PagePromise = class extends APIPromise {
  constructor(client, request, Page2) {
    super(client, request, async (client2, props) => new Page2(client2, props.response, await defaultParseResponse(client2, props), props.options));
  }
  /**
   * Allow auto-paginating iteration on an unawaited list call, eg:
   *
   *    for await (const item of client.items.list()) {
   *      console.log(item)
   *    }
   */
  async *[Symbol.asyncIterator]() {
    const page = await this;
    for await (const item of page) {
      yield item;
    }
  }
};
var Page = class extends AbstractPage {
  constructor(client, response, body, options) {
    super(client, response, body, options);
    this.data = body.data || [];
    this.has_more = body.has_more || false;
    this.first_id = body.first_id || null;
    this.last_id = body.last_id || null;
  }
  getPaginatedItems() {
    return this.data ?? [];
  }
  hasNextPage() {
    if (this.has_more === false) {
      return false;
    }
    return super.hasNextPage();
  }
  nextPageRequestOptions() {
    if (this.options.query?.["before_id"]) {
      const first_id = this.first_id;
      if (!first_id) {
        return null;
      }
      return {
        ...this.options,
        query: {
          ...maybeObj(this.options.query),
          before_id: first_id
        }
      };
    }
    const cursor = this.last_id;
    if (!cursor) {
      return null;
    }
    return {
      ...this.options,
      query: {
        ...maybeObj(this.options.query),
        after_id: cursor
      }
    };
  }
};
var PageCursor = class extends AbstractPage {
  constructor(client, response, body, options) {
    super(client, response, body, options);
    this.data = body.data || [];
    this.next_page = body.next_page || null;
  }
  getPaginatedItems() {
    return this.data ?? [];
  }
  nextPageRequestOptions() {
    const cursor = this.next_page;
    if (!cursor) {
      return null;
    }
    return {
      ...this.options,
      query: {
        ...maybeObj(this.options.query),
        page: cursor
      }
    };
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/uploads.mjs
var checkFileSupport = () => {
  if (typeof File === "undefined") {
    const { process: process2 } = globalThis;
    const isOldNode = typeof process2?.versions?.node === "string" && parseInt(process2.versions.node.split(".")) < 20;
    throw new Error("`File` is not defined as a global, which is required for file uploads." + (isOldNode ? " Update to Node 20 LTS or newer, or set `globalThis.File` to `import('node:buffer').File`." : ""));
  }
};
function makeFile(fileBits, fileName, options) {
  checkFileSupport();
  return new File(fileBits, fileName ?? "unknown_file", options);
}
function getName(value, stripPath) {
  const val = typeof value === "object" && value !== null && ("name" in value && value.name && String(value.name) || "url" in value && value.url && String(value.url) || "filename" in value && value.filename && String(value.filename) || "path" in value && value.path && String(value.path)) || "";
  return stripPath ? val.split(/[\\/]/).pop() || void 0 : val;
}
var isAsyncIterable = (value) => value != null && typeof value === "object" && typeof value[Symbol.asyncIterator] === "function";
var multipartFormRequestOptions = async (opts, fetch2, stripFilenames = true) => {
  return { ...opts, body: await createForm(opts.body, fetch2, stripFilenames) };
};
var supportsFormDataMap = /* @__PURE__ */ new WeakMap();
function supportsFormData(fetchObject) {
  const fetch2 = typeof fetchObject === "function" ? fetchObject : fetchObject.fetch;
  const cached = supportsFormDataMap.get(fetch2);
  if (cached)
    return cached;
  const promise = (async () => {
    try {
      const FetchResponse = "Response" in fetch2 ? fetch2.Response : (await fetch2("data:,")).constructor;
      const data = new FormData();
      if (data.toString() === await new FetchResponse(data).text()) {
        return false;
      }
      return true;
    } catch {
      return true;
    }
  })();
  supportsFormDataMap.set(fetch2, promise);
  return promise;
}
var createForm = async (body, fetch2, stripFilenames = true) => {
  if (!await supportsFormData(fetch2)) {
    throw new TypeError("The provided fetch function does not support file uploads with the current global FormData class.");
  }
  const form = new FormData();
  await Promise.all(Object.entries(body || {}).map(([key, value]) => addFormValue(form, key, value, stripFilenames)));
  return form;
};
var isNamedBlob = (value) => value instanceof Blob && "name" in value;
var addFormValue = async (form, key, value, stripFilenames) => {
  if (value === void 0)
    return;
  if (value == null) {
    throw new TypeError(`Received null for "${key}"; to pass null in FormData, you must use the string 'null'`);
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    form.append(key, String(value));
  } else if (value instanceof Response) {
    let options = {};
    const contentType = value.headers.get("Content-Type");
    if (contentType) {
      options = { type: contentType };
    }
    form.append(key, makeFile([await value.blob()], getName(value, stripFilenames), options));
  } else if (isAsyncIterable(value)) {
    form.append(key, makeFile([await new Response(ReadableStreamFrom(value)).blob()], getName(value, stripFilenames)));
  } else if (isNamedBlob(value)) {
    form.append(key, makeFile([value], getName(value, stripFilenames), { type: value.type }));
  } else if (Array.isArray(value)) {
    await Promise.all(value.map((entry) => addFormValue(form, key + "[]", entry, stripFilenames)));
  } else if (typeof value === "object") {
    await Promise.all(Object.entries(value).map(([name, prop]) => addFormValue(form, `${key}[${name}]`, prop, stripFilenames)));
  } else {
    throw new TypeError(`Invalid value given to form, expected a string, number, boolean, object, Array, File or Blob but got ${value} instead`);
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/to-file.mjs
var isBlobLike = (value) => value != null && typeof value === "object" && typeof value.size === "number" && typeof value.type === "string" && typeof value.text === "function" && typeof value.slice === "function" && typeof value.arrayBuffer === "function";
var isFileLike = (value) => value != null && typeof value === "object" && typeof value.name === "string" && typeof value.lastModified === "number" && isBlobLike(value);
var isResponseLike = (value) => value != null && typeof value === "object" && typeof value.url === "string" && typeof value.blob === "function";
async function toFile(value, name, options) {
  checkFileSupport();
  value = await value;
  name || (name = getName(value, true));
  if (isFileLike(value)) {
    if (value instanceof File && name == null && options == null) {
      return value;
    }
    return makeFile([await value.arrayBuffer()], name ?? value.name, {
      type: value.type,
      lastModified: value.lastModified,
      ...options
    });
  }
  if (isResponseLike(value)) {
    const blob = await value.blob();
    name || (name = new URL(value.url).pathname.split(/[\\/]/).pop());
    return makeFile(await getBytes(blob), name, options);
  }
  const parts = await getBytes(value);
  if (!options?.type) {
    const type = parts.find((part) => typeof part === "object" && "type" in part && part.type);
    if (typeof type === "string") {
      options = { ...options, type };
    }
  }
  return makeFile(parts, name, options);
}
async function getBytes(value) {
  let parts = [];
  if (typeof value === "string" || ArrayBuffer.isView(value) || // includes Uint8Array, Buffer, etc.
  value instanceof ArrayBuffer) {
    parts.push(value);
  } else if (isBlobLike(value)) {
    parts.push(value instanceof Blob ? value : await value.arrayBuffer());
  } else if (isAsyncIterable(value)) {
    for await (const chunk of value) {
      parts.push(...await getBytes(chunk));
    }
  } else {
    const constructor = value?.constructor?.name;
    throw new Error(`Unexpected data type: ${typeof value}${constructor ? `; constructor: ${constructor}` : ""}${propsForError(value)}`);
  }
  return parts;
}
function propsForError(value) {
  if (typeof value !== "object" || value === null)
    return "";
  const props = Object.getOwnPropertyNames(value);
  return `; props: [${props.map((p) => `"${p}"`).join(", ")}]`;
}

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/core/resource.mjs
var APIResource = class {
  constructor(client) {
    this._client = client;
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/headers.mjs
var brand_privateNullableHeaders = Symbol.for("brand.privateNullableHeaders");
function* iterateHeaders(headers) {
  if (!headers)
    return;
  if (brand_privateNullableHeaders in headers) {
    const { values, nulls } = headers;
    yield* values.entries();
    for (const name of nulls) {
      yield [name, null];
    }
    return;
  }
  let shouldClear = false;
  let iter;
  if (headers instanceof Headers) {
    iter = headers.entries();
  } else if (isReadonlyArray(headers)) {
    iter = headers;
  } else {
    shouldClear = true;
    iter = Object.entries(headers ?? {});
  }
  for (let row of iter) {
    const name = row[0];
    if (typeof name !== "string")
      throw new TypeError("expected header name to be a string");
    const values = isReadonlyArray(row[1]) ? row[1] : [row[1]];
    let didClear = false;
    for (const value of values) {
      if (value === void 0)
        continue;
      if (shouldClear && !didClear) {
        didClear = true;
        yield [name, null];
      }
      yield [name, value];
    }
  }
}
var buildHeaders = (newHeaders) => {
  const targetHeaders = new Headers();
  const nullHeaders = /* @__PURE__ */ new Set();
  for (const headers of newHeaders) {
    const seenHeaders = /* @__PURE__ */ new Set();
    for (const [name, value] of iterateHeaders(headers)) {
      const lowerName = name.toLowerCase();
      if (!seenHeaders.has(lowerName)) {
        targetHeaders.delete(name);
        seenHeaders.add(lowerName);
      }
      if (value === null) {
        targetHeaders.delete(name);
        nullHeaders.add(lowerName);
      } else {
        targetHeaders.append(name, value);
        nullHeaders.delete(lowerName);
      }
    }
  }
  return { [brand_privateNullableHeaders]: true, values: targetHeaders, nulls: nullHeaders };
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/utils/path.mjs
function encodeURIPath(str) {
  return str.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@]+/g, encodeURIComponent);
}
var EMPTY = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.create(null));
var createPathTagFunction = (pathEncoder = encodeURIPath) => function path2(statics, ...params) {
  if (statics.length === 1)
    return statics[0];
  let postPath = false;
  const invalidSegments = [];
  const path3 = statics.reduce((previousValue, currentValue, index) => {
    if (/[?#]/.test(currentValue)) {
      postPath = true;
    }
    const value = params[index];
    let encoded = (postPath ? encodeURIComponent : pathEncoder)("" + value);
    if (index !== params.length && (value == null || typeof value === "object" && // handle values from other realms
    value.toString === Object.getPrototypeOf(Object.getPrototypeOf(value.hasOwnProperty ?? EMPTY) ?? EMPTY)?.toString)) {
      encoded = value + "";
      invalidSegments.push({
        start: previousValue.length + currentValue.length,
        length: encoded.length,
        error: `Value of type ${Object.prototype.toString.call(value).slice(8, -1)} is not a valid path parameter`
      });
    }
    return previousValue + currentValue + (index === params.length ? "" : encoded);
  }, "");
  const pathOnly = path3.split(/[?#]/, 1)[0];
  const invalidSegmentPattern = /(?<=^|\/)(?:\.|%2e){1,2}(?=\/|$)/gi;
  let match;
  while ((match = invalidSegmentPattern.exec(pathOnly)) !== null) {
    invalidSegments.push({
      start: match.index,
      length: match[0].length,
      error: `Value "${match[0]}" can't be safely passed as a path parameter`
    });
  }
  invalidSegments.sort((a, b) => a.start - b.start);
  if (invalidSegments.length > 0) {
    let lastEnd = 0;
    const underline = invalidSegments.reduce((acc, segment) => {
      const spaces = " ".repeat(segment.start - lastEnd);
      const arrows = "^".repeat(segment.length);
      lastEnd = segment.start + segment.length;
      return acc + spaces + arrows;
    }, "");
    throw new AnthropicError(`Path parameters result in path with invalid segments:
${invalidSegments.map((e) => e.error).join("\n")}
${path3}
${underline}`);
  }
  return path3;
};
var path = /* @__PURE__ */ createPathTagFunction(encodeURIPath);

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/beta/environments.mjs
var Environments = class extends APIResource {
  /**
   * Create a new environment with the specified configuration.
   *
   * @example
   * ```ts
   * const betaEnvironment =
   *   await client.beta.environments.create({
   *     name: 'python-data-analysis',
   *   });
   * ```
   */
  create(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/environments?beta=true", {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Retrieve a specific environment by ID.
   *
   * @example
   * ```ts
   * const betaEnvironment =
   *   await client.beta.environments.retrieve(
   *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
   *   );
   * ```
   */
  retrieve(environmentID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/environments/${environmentID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Update an existing environment's configuration.
   *
   * @example
   * ```ts
   * const betaEnvironment =
   *   await client.beta.environments.update(
   *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
   *   );
   * ```
   */
  update(environmentID, params, options) {
    const { betas, ...body } = params;
    return this._client.post(path`/v1/environments/${environmentID}?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List environments with pagination support.
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaEnvironment of client.beta.environments.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/environments?beta=true", PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Delete an environment by ID. Returns a confirmation of the deletion.
   *
   * @example
   * ```ts
   * const betaEnvironmentDeleteResponse =
   *   await client.beta.environments.delete(
   *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
   *   );
   * ```
   */
  delete(environmentID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.delete(path`/v1/environments/${environmentID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Archive an environment by ID. Archived environments cannot be used to create new
   * sessions.
   *
   * @example
   * ```ts
   * const betaEnvironment =
   *   await client.beta.environments.archive(
   *     'env_011CZkZ9X2dpNyB7HsEFoRfW',
   *   );
   * ```
   */
  archive(environmentID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.post(path`/v1/environments/${environmentID}/archive?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/lib/stainless-helper-header.mjs
var SDK_HELPER_SYMBOL = Symbol("anthropic.sdk.stainlessHelper");
function wasCreatedByStainlessHelper(value) {
  return typeof value === "object" && value !== null && SDK_HELPER_SYMBOL in value;
}
function collectStainlessHelpers(tools, messages) {
  const helpers = /* @__PURE__ */ new Set();
  if (tools) {
    for (const tool of tools) {
      if (wasCreatedByStainlessHelper(tool)) {
        helpers.add(tool[SDK_HELPER_SYMBOL]);
      }
    }
  }
  if (messages) {
    for (const message of messages) {
      if (wasCreatedByStainlessHelper(message)) {
        helpers.add(message[SDK_HELPER_SYMBOL]);
      }
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (wasCreatedByStainlessHelper(block)) {
            helpers.add(block[SDK_HELPER_SYMBOL]);
          }
        }
      }
    }
  }
  return Array.from(helpers);
}
function stainlessHelperHeader(tools, messages) {
  const helpers = collectStainlessHelpers(tools, messages);
  if (helpers.length === 0)
    return {};
  return { "x-stainless-helper": helpers.join(", ") };
}
function stainlessHelperHeaderFromFile(file) {
  if (wasCreatedByStainlessHelper(file)) {
    return { "x-stainless-helper": file[SDK_HELPER_SYMBOL] };
  }
  return {};
}

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/beta/files.mjs
var Files = class extends APIResource {
  /**
   * List Files
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const fileMetadata of client.beta.files.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/files", Page, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Delete File
   *
   * @example
   * ```ts
   * const deletedFile = await client.beta.files.delete(
   *   'file_id',
   * );
   * ```
   */
  delete(fileID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.delete(path`/v1/files/${fileID}`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Download File
   *
   * @example
   * ```ts
   * const response = await client.beta.files.download(
   *   'file_id',
   * );
   *
   * const content = await response.blob();
   * console.log(content);
   * ```
   */
  download(fileID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/files/${fileID}/content`, {
      ...options,
      headers: buildHeaders([
        {
          "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString(),
          Accept: "application/binary"
        },
        options?.headers
      ]),
      __binaryResponse: true
    });
  }
  /**
   * Get File Metadata
   *
   * @example
   * ```ts
   * const fileMetadata =
   *   await client.beta.files.retrieveMetadata('file_id');
   * ```
   */
  retrieveMetadata(fileID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/files/${fileID}`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Upload File
   *
   * @example
   * ```ts
   * const fileMetadata = await client.beta.files.upload({
   *   file: fs.createReadStream('path/to/file'),
   * });
   * ```
   */
  upload(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/files", multipartFormRequestOptions({
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString() },
        stainlessHelperHeaderFromFile(body.file),
        options?.headers
      ])
    }, this._client));
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/beta/models.mjs
var Models = class extends APIResource {
  /**
   * Get a specific model.
   *
   * The Models API response can be used to determine information about a specific
   * model or resolve a model alias to a model ID.
   *
   * @example
   * ```ts
   * const betaModelInfo = await client.beta.models.retrieve(
   *   'model_id',
   * );
   * ```
   */
  retrieve(modelID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/models/${modelID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
        options?.headers
      ])
    });
  }
  /**
   * List available models.
   *
   * The Models API response can be used to determine which models are available for
   * use in the API. More recently released models are listed first.
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaModelInfo of client.beta.models.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/models?beta=true", Page, {
      query,
      ...options,
      headers: buildHeaders([
        { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
        options?.headers
      ])
    });
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/beta/user-profiles.mjs
var UserProfiles = class extends APIResource {
  /**
   * Create User Profile
   *
   * @example
   * ```ts
   * const betaUserProfile =
   *   await client.beta.userProfiles.create();
   * ```
   */
  create(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/user_profiles?beta=true", {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Get User Profile
   *
   * @example
   * ```ts
   * const betaUserProfile =
   *   await client.beta.userProfiles.retrieve(
   *     'uprof_011CZkZCu8hGbp5mYRQgUmz9',
   *   );
   * ```
   */
  retrieve(userProfileID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/user_profiles/${userProfileID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Update User Profile
   *
   * @example
   * ```ts
   * const betaUserProfile =
   *   await client.beta.userProfiles.update(
   *     'uprof_011CZkZCu8hGbp5mYRQgUmz9',
   *   );
   * ```
   */
  update(userProfileID, params, options) {
    const { betas, ...body } = params;
    return this._client.post(path`/v1/user_profiles/${userProfileID}?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List User Profiles
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaUserProfile of client.beta.userProfiles.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/user_profiles?beta=true", PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Create Enrollment URL
   *
   * @example
   * ```ts
   * const betaUserProfileEnrollmentURL =
   *   await client.beta.userProfiles.createEnrollmentURL(
   *     'uprof_011CZkZCu8hGbp5mYRQgUmz9',
   *   );
   * ```
   */
  createEnrollmentURL(userProfileID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.post(path`/v1/user_profiles/${userProfileID}/enrollment_url?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() },
        options?.headers
      ])
    });
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/beta/agents/versions.mjs
var Versions = class extends APIResource {
  /**
   * List Agent Versions
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaManagedAgentsAgent of client.beta.agents.versions.list(
   *   'agent_011CZkYpogX7uDKUyvBTophP',
   * )) {
   *   // ...
   * }
   * ```
   */
  list(agentID, params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList(path`/v1/agents/${agentID}/versions?beta=true`, PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/beta/agents/agents.mjs
var Agents = class extends APIResource {
  constructor() {
    super(...arguments);
    this.versions = new Versions(this._client);
  }
  /**
   * Create Agent
   *
   * @example
   * ```ts
   * const betaManagedAgentsAgent =
   *   await client.beta.agents.create({
   *     model: 'claude-sonnet-4-6',
   *     name: 'My First Agent',
   *   });
   * ```
   */
  create(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/agents?beta=true", {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Get Agent
   *
   * @example
   * ```ts
   * const betaManagedAgentsAgent =
   *   await client.beta.agents.retrieve(
   *     'agent_011CZkYpogX7uDKUyvBTophP',
   *   );
   * ```
   */
  retrieve(agentID, params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.get(path`/v1/agents/${agentID}?beta=true`, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Update Agent
   *
   * @example
   * ```ts
   * const betaManagedAgentsAgent =
   *   await client.beta.agents.update(
   *     'agent_011CZkYpogX7uDKUyvBTophP',
   *     { version: 1 },
   *   );
   * ```
   */
  update(agentID, params, options) {
    const { betas, ...body } = params;
    return this._client.post(path`/v1/agents/${agentID}?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List Agents
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaManagedAgentsAgent of client.beta.agents.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/agents?beta=true", PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Archive Agent
   *
   * @example
   * ```ts
   * const betaManagedAgentsAgent =
   *   await client.beta.agents.archive(
   *     'agent_011CZkYpogX7uDKUyvBTophP',
   *   );
   * ```
   */
  archive(agentID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.post(path`/v1/agents/${agentID}/archive?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
};
Agents.Versions = Versions;

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/constants.mjs
var MODEL_NONSTREAMING_TOKENS = {
  "claude-opus-4-20250514": 8192,
  "claude-opus-4-0": 8192,
  "claude-4-opus-20250514": 8192,
  "anthropic.claude-opus-4-20250514-v1:0": 8192,
  "claude-opus-4@20250514": 8192,
  "claude-opus-4-1-20250805": 8192,
  "anthropic.claude-opus-4-1-20250805-v1:0": 8192,
  "claude-opus-4-1@20250805": 8192
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/lib/beta-parser.mjs
function getOutputFormat(params) {
  return params?.output_format ?? params?.output_config?.format;
}
function maybeParseBetaMessage(message, params, opts) {
  const outputFormat = getOutputFormat(params);
  if (!params || !("parse" in (outputFormat ?? {}))) {
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type === "text") {
          const parsedBlock = Object.defineProperty({ ...block }, "parsed_output", {
            value: null,
            enumerable: false
          });
          return Object.defineProperty(parsedBlock, "parsed", {
            get() {
              opts.logger.warn("The `parsed` property on `text` blocks is deprecated, please use `parsed_output` instead.");
              return null;
            },
            enumerable: false
          });
        }
        return block;
      }),
      parsed_output: null
    };
  }
  return parseBetaMessage(message, params, opts);
}
function parseBetaMessage(message, params, opts) {
  let firstParsedOutput = null;
  const content = message.content.map((block) => {
    if (block.type === "text") {
      const parsedOutput = parseBetaOutputFormat(params, block.text);
      if (firstParsedOutput === null) {
        firstParsedOutput = parsedOutput;
      }
      const parsedBlock = Object.defineProperty({ ...block }, "parsed_output", {
        value: parsedOutput,
        enumerable: false
      });
      return Object.defineProperty(parsedBlock, "parsed", {
        get() {
          opts.logger.warn("The `parsed` property on `text` blocks is deprecated, please use `parsed_output` instead.");
          return parsedOutput;
        },
        enumerable: false
      });
    }
    return block;
  });
  return {
    ...message,
    content,
    parsed_output: firstParsedOutput
  };
}
function parseBetaOutputFormat(params, content) {
  const outputFormat = getOutputFormat(params);
  if (outputFormat?.type !== "json_schema") {
    return null;
  }
  try {
    if ("parse" in outputFormat) {
      return outputFormat.parse(content);
    }
    return JSON.parse(content);
  } catch (error) {
    throw new AnthropicError(`Failed to parse structured output: ${error}`);
  }
}

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/_vendor/partial-json-parser/parser.mjs
var tokenize = (input) => {
  let current = 0;
  let tokens = [];
  while (current < input.length) {
    let char = input[current];
    if (char === "\\") {
      current++;
      continue;
    }
    if (char === "{") {
      tokens.push({
        type: "brace",
        value: "{"
      });
      current++;
      continue;
    }
    if (char === "}") {
      tokens.push({
        type: "brace",
        value: "}"
      });
      current++;
      continue;
    }
    if (char === "[") {
      tokens.push({
        type: "paren",
        value: "["
      });
      current++;
      continue;
    }
    if (char === "]") {
      tokens.push({
        type: "paren",
        value: "]"
      });
      current++;
      continue;
    }
    if (char === ":") {
      tokens.push({
        type: "separator",
        value: ":"
      });
      current++;
      continue;
    }
    if (char === ",") {
      tokens.push({
        type: "delimiter",
        value: ","
      });
      current++;
      continue;
    }
    if (char === '"') {
      let value = "";
      let danglingQuote = false;
      char = input[++current];
      while (char !== '"') {
        if (current === input.length) {
          danglingQuote = true;
          break;
        }
        if (char === "\\") {
          current++;
          if (current === input.length) {
            danglingQuote = true;
            break;
          }
          value += char + input[current];
          char = input[++current];
        } else {
          value += char;
          char = input[++current];
        }
      }
      char = input[++current];
      if (!danglingQuote) {
        tokens.push({
          type: "string",
          value
        });
      }
      continue;
    }
    let WHITESPACE = /\s/;
    if (char && WHITESPACE.test(char)) {
      current++;
      continue;
    }
    let NUMBERS = /[0-9]/;
    if (char && NUMBERS.test(char) || char === "-" || char === ".") {
      let value = "";
      if (char === "-") {
        value += char;
        char = input[++current];
      }
      while (char && NUMBERS.test(char) || char === ".") {
        value += char;
        char = input[++current];
      }
      tokens.push({
        type: "number",
        value
      });
      continue;
    }
    let LETTERS = /[a-z]/i;
    if (char && LETTERS.test(char)) {
      let value = "";
      while (char && LETTERS.test(char)) {
        if (current === input.length) {
          break;
        }
        value += char;
        char = input[++current];
      }
      if (value == "true" || value == "false" || value === "null") {
        tokens.push({
          type: "name",
          value
        });
      } else {
        current++;
        continue;
      }
      continue;
    }
    current++;
  }
  return tokens;
};
var strip = (tokens) => {
  if (tokens.length === 0) {
    return tokens;
  }
  let lastToken = tokens[tokens.length - 1];
  switch (lastToken.type) {
    case "separator":
      tokens = tokens.slice(0, tokens.length - 1);
      return strip(tokens);
      break;
    case "number":
      let lastCharacterOfLastToken = lastToken.value[lastToken.value.length - 1];
      if (lastCharacterOfLastToken === "." || lastCharacterOfLastToken === "-") {
        tokens = tokens.slice(0, tokens.length - 1);
        return strip(tokens);
      }
    case "string":
      let tokenBeforeTheLastToken = tokens[tokens.length - 2];
      if (tokenBeforeTheLastToken?.type === "delimiter") {
        tokens = tokens.slice(0, tokens.length - 1);
        return strip(tokens);
      } else if (tokenBeforeTheLastToken?.type === "brace" && tokenBeforeTheLastToken.value === "{") {
        tokens = tokens.slice(0, tokens.length - 1);
        return strip(tokens);
      }
      break;
    case "delimiter":
      tokens = tokens.slice(0, tokens.length - 1);
      return strip(tokens);
      break;
  }
  return tokens;
};
var unstrip = (tokens) => {
  let tail = [];
  tokens.map((token) => {
    if (token.type === "brace") {
      if (token.value === "{") {
        tail.push("}");
      } else {
        tail.splice(tail.lastIndexOf("}"), 1);
      }
    }
    if (token.type === "paren") {
      if (token.value === "[") {
        tail.push("]");
      } else {
        tail.splice(tail.lastIndexOf("]"), 1);
      }
    }
  });
  if (tail.length > 0) {
    tail.reverse().map((item) => {
      if (item === "}") {
        tokens.push({
          type: "brace",
          value: "}"
        });
      } else if (item === "]") {
        tokens.push({
          type: "paren",
          value: "]"
        });
      }
    });
  }
  return tokens;
};
var generate = (tokens) => {
  let output = "";
  tokens.map((token) => {
    switch (token.type) {
      case "string":
        output += '"' + token.value + '"';
        break;
      default:
        output += token.value;
        break;
    }
  });
  return output;
};
var partialParse = (input) => JSON.parse(generate(unstrip(strip(tokenize(input)))));

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/lib/BetaMessageStream.mjs
var _BetaMessageStream_instances;
var _BetaMessageStream_currentMessageSnapshot;
var _BetaMessageStream_params;
var _BetaMessageStream_connectedPromise;
var _BetaMessageStream_resolveConnectedPromise;
var _BetaMessageStream_rejectConnectedPromise;
var _BetaMessageStream_endPromise;
var _BetaMessageStream_resolveEndPromise;
var _BetaMessageStream_rejectEndPromise;
var _BetaMessageStream_listeners;
var _BetaMessageStream_ended;
var _BetaMessageStream_errored;
var _BetaMessageStream_aborted;
var _BetaMessageStream_catchingPromiseCreated;
var _BetaMessageStream_response;
var _BetaMessageStream_request_id;
var _BetaMessageStream_logger;
var _BetaMessageStream_getFinalMessage;
var _BetaMessageStream_getFinalText;
var _BetaMessageStream_handleError;
var _BetaMessageStream_beginRequest;
var _BetaMessageStream_addStreamEvent;
var _BetaMessageStream_endRequest;
var _BetaMessageStream_accumulateMessage;
var JSON_BUF_PROPERTY = "__json_buf";
function tracksToolInput(content) {
  return content.type === "tool_use" || content.type === "server_tool_use" || content.type === "mcp_tool_use";
}
var BetaMessageStream = class _BetaMessageStream {
  constructor(params, opts) {
    _BetaMessageStream_instances.add(this);
    this.messages = [];
    this.receivedMessages = [];
    _BetaMessageStream_currentMessageSnapshot.set(this, void 0);
    _BetaMessageStream_params.set(this, null);
    this.controller = new AbortController();
    _BetaMessageStream_connectedPromise.set(this, void 0);
    _BetaMessageStream_resolveConnectedPromise.set(this, () => {
    });
    _BetaMessageStream_rejectConnectedPromise.set(this, () => {
    });
    _BetaMessageStream_endPromise.set(this, void 0);
    _BetaMessageStream_resolveEndPromise.set(this, () => {
    });
    _BetaMessageStream_rejectEndPromise.set(this, () => {
    });
    _BetaMessageStream_listeners.set(this, {});
    _BetaMessageStream_ended.set(this, false);
    _BetaMessageStream_errored.set(this, false);
    _BetaMessageStream_aborted.set(this, false);
    _BetaMessageStream_catchingPromiseCreated.set(this, false);
    _BetaMessageStream_response.set(this, void 0);
    _BetaMessageStream_request_id.set(this, void 0);
    _BetaMessageStream_logger.set(this, void 0);
    _BetaMessageStream_handleError.set(this, (error) => {
      __classPrivateFieldSet(this, _BetaMessageStream_errored, true, "f");
      if (isAbortError(error)) {
        error = new APIUserAbortError();
      }
      if (error instanceof APIUserAbortError) {
        __classPrivateFieldSet(this, _BetaMessageStream_aborted, true, "f");
        return this._emit("abort", error);
      }
      if (error instanceof AnthropicError) {
        return this._emit("error", error);
      }
      if (error instanceof Error) {
        const anthropicError = new AnthropicError(error.message);
        anthropicError.cause = error;
        return this._emit("error", anthropicError);
      }
      return this._emit("error", new AnthropicError(String(error)));
    });
    __classPrivateFieldSet(this, _BetaMessageStream_connectedPromise, new Promise((resolve2, reject) => {
      __classPrivateFieldSet(this, _BetaMessageStream_resolveConnectedPromise, resolve2, "f");
      __classPrivateFieldSet(this, _BetaMessageStream_rejectConnectedPromise, reject, "f");
    }), "f");
    __classPrivateFieldSet(this, _BetaMessageStream_endPromise, new Promise((resolve2, reject) => {
      __classPrivateFieldSet(this, _BetaMessageStream_resolveEndPromise, resolve2, "f");
      __classPrivateFieldSet(this, _BetaMessageStream_rejectEndPromise, reject, "f");
    }), "f");
    __classPrivateFieldGet(this, _BetaMessageStream_connectedPromise, "f").catch(() => {
    });
    __classPrivateFieldGet(this, _BetaMessageStream_endPromise, "f").catch(() => {
    });
    __classPrivateFieldSet(this, _BetaMessageStream_params, params, "f");
    __classPrivateFieldSet(this, _BetaMessageStream_logger, opts?.logger ?? console, "f");
  }
  get response() {
    return __classPrivateFieldGet(this, _BetaMessageStream_response, "f");
  }
  get request_id() {
    return __classPrivateFieldGet(this, _BetaMessageStream_request_id, "f");
  }
  /**
   * Returns the `MessageStream` data, the raw `Response` instance and the ID of the request,
   * returned vie the `request-id` header which is useful for debugging requests and resporting
   * issues to Anthropic.
   *
   * This is the same as the `APIPromise.withResponse()` method.
   *
   * This method will raise an error if you created the stream using `MessageStream.fromReadableStream`
   * as no `Response` is available.
   */
  async withResponse() {
    __classPrivateFieldSet(this, _BetaMessageStream_catchingPromiseCreated, true, "f");
    const response = await __classPrivateFieldGet(this, _BetaMessageStream_connectedPromise, "f");
    if (!response) {
      throw new Error("Could not resolve a `Response` object");
    }
    return {
      data: this,
      response,
      request_id: response.headers.get("request-id")
    };
  }
  /**
   * Intended for use on the frontend, consuming a stream produced with
   * `.toReadableStream()` on the backend.
   *
   * Note that messages sent to the model do not appear in `.on('message')`
   * in this context.
   */
  static fromReadableStream(stream) {
    const runner = new _BetaMessageStream(null);
    runner._run(() => runner._fromReadableStream(stream));
    return runner;
  }
  static createMessage(messages, params, options, { logger } = {}) {
    const runner = new _BetaMessageStream(params, { logger });
    for (const message of params.messages) {
      runner._addMessageParam(message);
    }
    __classPrivateFieldSet(runner, _BetaMessageStream_params, { ...params, stream: true }, "f");
    runner._run(() => runner._createMessage(messages, { ...params, stream: true }, { ...options, headers: { ...options?.headers, "X-Stainless-Helper-Method": "stream" } }));
    return runner;
  }
  _run(executor) {
    executor().then(() => {
      this._emitFinal();
      this._emit("end");
    }, __classPrivateFieldGet(this, _BetaMessageStream_handleError, "f"));
  }
  _addMessageParam(message) {
    this.messages.push(message);
  }
  _addMessage(message, emit = true) {
    this.receivedMessages.push(message);
    if (emit) {
      this._emit("message", message);
    }
  }
  async _createMessage(messages, params, options) {
    const signal = options?.signal;
    let abortHandler;
    if (signal) {
      if (signal.aborted)
        this.controller.abort();
      abortHandler = this.controller.abort.bind(this.controller);
      signal.addEventListener("abort", abortHandler);
    }
    try {
      __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_beginRequest).call(this);
      const { response, data: stream } = await messages.create({ ...params, stream: true }, { ...options, signal: this.controller.signal }).withResponse();
      this._connected(response);
      for await (const event of stream) {
        __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_addStreamEvent).call(this, event);
      }
      if (stream.controller.signal?.aborted) {
        throw new APIUserAbortError();
      }
      __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_endRequest).call(this);
    } finally {
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  }
  _connected(response) {
    if (this.ended)
      return;
    __classPrivateFieldSet(this, _BetaMessageStream_response, response, "f");
    __classPrivateFieldSet(this, _BetaMessageStream_request_id, response?.headers.get("request-id"), "f");
    __classPrivateFieldGet(this, _BetaMessageStream_resolveConnectedPromise, "f").call(this, response);
    this._emit("connect");
  }
  get ended() {
    return __classPrivateFieldGet(this, _BetaMessageStream_ended, "f");
  }
  get errored() {
    return __classPrivateFieldGet(this, _BetaMessageStream_errored, "f");
  }
  get aborted() {
    return __classPrivateFieldGet(this, _BetaMessageStream_aborted, "f");
  }
  abort() {
    this.controller.abort();
  }
  /**
   * Adds the listener function to the end of the listeners array for the event.
   * No checks are made to see if the listener has already been added. Multiple calls passing
   * the same combination of event and listener will result in the listener being added, and
   * called, multiple times.
   * @returns this MessageStream, so that calls can be chained
   */
  on(event, listener) {
    const listeners = __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] = []);
    listeners.push({ listener });
    return this;
  }
  /**
   * Removes the specified listener from the listener array for the event.
   * off() will remove, at most, one instance of a listener from the listener array. If any single
   * listener has been added multiple times to the listener array for the specified event, then
   * off() must be called multiple times to remove each instance.
   * @returns this MessageStream, so that calls can be chained
   */
  off(event, listener) {
    const listeners = __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event];
    if (!listeners)
      return this;
    const index = listeners.findIndex((l) => l.listener === listener);
    if (index >= 0)
      listeners.splice(index, 1);
    return this;
  }
  /**
   * Adds a one-time listener function for the event. The next time the event is triggered,
   * this listener is removed and then invoked.
   * @returns this MessageStream, so that calls can be chained
   */
  once(event, listener) {
    const listeners = __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] = []);
    listeners.push({ listener, once: true });
    return this;
  }
  /**
   * This is similar to `.once()`, but returns a Promise that resolves the next time
   * the event is triggered, instead of calling a listener callback.
   * @returns a Promise that resolves the next time given event is triggered,
   * or rejects if an error is emitted.  (If you request the 'error' event,
   * returns a promise that resolves with the error).
   *
   * Example:
   *
   *   const message = await stream.emitted('message') // rejects if the stream errors
   */
  emitted(event) {
    return new Promise((resolve2, reject) => {
      __classPrivateFieldSet(this, _BetaMessageStream_catchingPromiseCreated, true, "f");
      if (event !== "error")
        this.once("error", reject);
      this.once(event, resolve2);
    });
  }
  async done() {
    __classPrivateFieldSet(this, _BetaMessageStream_catchingPromiseCreated, true, "f");
    await __classPrivateFieldGet(this, _BetaMessageStream_endPromise, "f");
  }
  get currentMessage() {
    return __classPrivateFieldGet(this, _BetaMessageStream_currentMessageSnapshot, "f");
  }
  /**
   * @returns a promise that resolves with the the final assistant Message response,
   * or rejects if an error occurred or the stream ended prematurely without producing a Message.
   * If structured outputs were used, this will be a ParsedMessage with a `parsed` field.
   */
  async finalMessage() {
    await this.done();
    return __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_getFinalMessage).call(this);
  }
  /**
   * @returns a promise that resolves with the the final assistant Message's text response, concatenated
   * together if there are more than one text blocks.
   * Rejects if an error occurred or the stream ended prematurely without producing a Message.
   */
  async finalText() {
    await this.done();
    return __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_getFinalText).call(this);
  }
  _emit(event, ...args) {
    if (__classPrivateFieldGet(this, _BetaMessageStream_ended, "f"))
      return;
    if (event === "end") {
      __classPrivateFieldSet(this, _BetaMessageStream_ended, true, "f");
      __classPrivateFieldGet(this, _BetaMessageStream_resolveEndPromise, "f").call(this);
    }
    const listeners = __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event];
    if (listeners) {
      __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] = listeners.filter((l) => !l.once);
      listeners.forEach(({ listener }) => listener(...args));
    }
    if (event === "abort") {
      const error = args[0];
      if (!__classPrivateFieldGet(this, _BetaMessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
        Promise.reject(error);
      }
      __classPrivateFieldGet(this, _BetaMessageStream_rejectConnectedPromise, "f").call(this, error);
      __classPrivateFieldGet(this, _BetaMessageStream_rejectEndPromise, "f").call(this, error);
      this._emit("end");
      return;
    }
    if (event === "error") {
      const error = args[0];
      if (!__classPrivateFieldGet(this, _BetaMessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
        Promise.reject(error);
      }
      __classPrivateFieldGet(this, _BetaMessageStream_rejectConnectedPromise, "f").call(this, error);
      __classPrivateFieldGet(this, _BetaMessageStream_rejectEndPromise, "f").call(this, error);
      this._emit("end");
    }
  }
  _emitFinal() {
    const finalMessage = this.receivedMessages.at(-1);
    if (finalMessage) {
      this._emit("finalMessage", __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_getFinalMessage).call(this));
    }
  }
  async _fromReadableStream(readableStream, options) {
    const signal = options?.signal;
    let abortHandler;
    if (signal) {
      if (signal.aborted)
        this.controller.abort();
      abortHandler = this.controller.abort.bind(this.controller);
      signal.addEventListener("abort", abortHandler);
    }
    try {
      __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_beginRequest).call(this);
      this._connected(null);
      const stream = Stream.fromReadableStream(readableStream, this.controller);
      for await (const event of stream) {
        __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_addStreamEvent).call(this, event);
      }
      if (stream.controller.signal?.aborted) {
        throw new APIUserAbortError();
      }
      __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_endRequest).call(this);
    } finally {
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  }
  [(_BetaMessageStream_currentMessageSnapshot = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_params = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_connectedPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_resolveConnectedPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_rejectConnectedPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_endPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_resolveEndPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_rejectEndPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_listeners = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_ended = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_errored = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_aborted = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_catchingPromiseCreated = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_response = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_request_id = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_logger = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_handleError = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_instances = /* @__PURE__ */ new WeakSet(), _BetaMessageStream_getFinalMessage = function _BetaMessageStream_getFinalMessage2() {
    if (this.receivedMessages.length === 0) {
      throw new AnthropicError("stream ended without producing a Message with role=assistant");
    }
    return this.receivedMessages.at(-1);
  }, _BetaMessageStream_getFinalText = function _BetaMessageStream_getFinalText2() {
    if (this.receivedMessages.length === 0) {
      throw new AnthropicError("stream ended without producing a Message with role=assistant");
    }
    const textBlocks = this.receivedMessages.at(-1).content.filter((block) => block.type === "text").map((block) => block.text);
    if (textBlocks.length === 0) {
      throw new AnthropicError("stream ended without producing a content block with type=text");
    }
    return textBlocks.join(" ");
  }, _BetaMessageStream_beginRequest = function _BetaMessageStream_beginRequest2() {
    if (this.ended)
      return;
    __classPrivateFieldSet(this, _BetaMessageStream_currentMessageSnapshot, void 0, "f");
  }, _BetaMessageStream_addStreamEvent = function _BetaMessageStream_addStreamEvent2(event) {
    if (this.ended)
      return;
    const messageSnapshot = __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_accumulateMessage).call(this, event);
    this._emit("streamEvent", event, messageSnapshot);
    switch (event.type) {
      case "content_block_delta": {
        const content = messageSnapshot.content.at(-1);
        switch (event.delta.type) {
          case "text_delta": {
            if (content.type === "text") {
              this._emit("text", event.delta.text, content.text || "");
            }
            break;
          }
          case "citations_delta": {
            if (content.type === "text") {
              this._emit("citation", event.delta.citation, content.citations ?? []);
            }
            break;
          }
          case "input_json_delta": {
            if (tracksToolInput(content) && content.input) {
              this._emit("inputJson", event.delta.partial_json, content.input);
            }
            break;
          }
          case "thinking_delta": {
            if (content.type === "thinking") {
              this._emit("thinking", event.delta.thinking, content.thinking);
            }
            break;
          }
          case "signature_delta": {
            if (content.type === "thinking") {
              this._emit("signature", content.signature);
            }
            break;
          }
          case "compaction_delta": {
            if (content.type === "compaction" && content.content) {
              this._emit("compaction", content.content);
            }
            break;
          }
          default:
            checkNever(event.delta);
        }
        break;
      }
      case "message_stop": {
        this._addMessageParam(messageSnapshot);
        this._addMessage(maybeParseBetaMessage(messageSnapshot, __classPrivateFieldGet(this, _BetaMessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _BetaMessageStream_logger, "f") }), true);
        break;
      }
      case "content_block_stop": {
        this._emit("contentBlock", messageSnapshot.content.at(-1));
        break;
      }
      case "message_start": {
        __classPrivateFieldSet(this, _BetaMessageStream_currentMessageSnapshot, messageSnapshot, "f");
        break;
      }
      case "content_block_start":
      case "message_delta":
        break;
    }
  }, _BetaMessageStream_endRequest = function _BetaMessageStream_endRequest2() {
    if (this.ended) {
      throw new AnthropicError(`stream has ended, this shouldn't happen`);
    }
    const snapshot = __classPrivateFieldGet(this, _BetaMessageStream_currentMessageSnapshot, "f");
    if (!snapshot) {
      throw new AnthropicError(`request ended without sending any chunks`);
    }
    __classPrivateFieldSet(this, _BetaMessageStream_currentMessageSnapshot, void 0, "f");
    return maybeParseBetaMessage(snapshot, __classPrivateFieldGet(this, _BetaMessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _BetaMessageStream_logger, "f") });
  }, _BetaMessageStream_accumulateMessage = function _BetaMessageStream_accumulateMessage2(event) {
    let snapshot = __classPrivateFieldGet(this, _BetaMessageStream_currentMessageSnapshot, "f");
    if (event.type === "message_start") {
      if (snapshot) {
        throw new AnthropicError(`Unexpected event order, got ${event.type} before receiving "message_stop"`);
      }
      return event.message;
    }
    if (!snapshot) {
      throw new AnthropicError(`Unexpected event order, got ${event.type} before "message_start"`);
    }
    switch (event.type) {
      case "message_stop":
        return snapshot;
      case "message_delta":
        snapshot.container = event.delta.container;
        snapshot.stop_reason = event.delta.stop_reason;
        snapshot.stop_sequence = event.delta.stop_sequence;
        snapshot.usage.output_tokens = event.usage.output_tokens;
        snapshot.context_management = event.context_management;
        if (event.usage.input_tokens != null) {
          snapshot.usage.input_tokens = event.usage.input_tokens;
        }
        if (event.usage.cache_creation_input_tokens != null) {
          snapshot.usage.cache_creation_input_tokens = event.usage.cache_creation_input_tokens;
        }
        if (event.usage.cache_read_input_tokens != null) {
          snapshot.usage.cache_read_input_tokens = event.usage.cache_read_input_tokens;
        }
        if (event.usage.server_tool_use != null) {
          snapshot.usage.server_tool_use = event.usage.server_tool_use;
        }
        if (event.usage.iterations != null) {
          snapshot.usage.iterations = event.usage.iterations;
        }
        return snapshot;
      case "content_block_start":
        snapshot.content.push(event.content_block);
        return snapshot;
      case "content_block_delta": {
        const snapshotContent = snapshot.content.at(event.index);
        switch (event.delta.type) {
          case "text_delta": {
            if (snapshotContent?.type === "text") {
              snapshot.content[event.index] = {
                ...snapshotContent,
                text: (snapshotContent.text || "") + event.delta.text
              };
            }
            break;
          }
          case "citations_delta": {
            if (snapshotContent?.type === "text") {
              snapshot.content[event.index] = {
                ...snapshotContent,
                citations: [...snapshotContent.citations ?? [], event.delta.citation]
              };
            }
            break;
          }
          case "input_json_delta": {
            if (snapshotContent && tracksToolInput(snapshotContent)) {
              let jsonBuf = snapshotContent[JSON_BUF_PROPERTY] || "";
              jsonBuf += event.delta.partial_json;
              const newContent = { ...snapshotContent };
              Object.defineProperty(newContent, JSON_BUF_PROPERTY, {
                value: jsonBuf,
                enumerable: false,
                writable: true
              });
              if (jsonBuf) {
                try {
                  newContent.input = partialParse(jsonBuf);
                } catch (err) {
                  const error = new AnthropicError(`Unable to parse tool parameter JSON from model. Please retry your request or adjust your prompt. Error: ${err}. JSON: ${jsonBuf}`);
                  __classPrivateFieldGet(this, _BetaMessageStream_handleError, "f").call(this, error);
                }
              }
              snapshot.content[event.index] = newContent;
            }
            break;
          }
          case "thinking_delta": {
            if (snapshotContent?.type === "thinking") {
              snapshot.content[event.index] = {
                ...snapshotContent,
                thinking: snapshotContent.thinking + event.delta.thinking
              };
            }
            break;
          }
          case "signature_delta": {
            if (snapshotContent?.type === "thinking") {
              snapshot.content[event.index] = {
                ...snapshotContent,
                signature: event.delta.signature
              };
            }
            break;
          }
          case "compaction_delta": {
            if (snapshotContent?.type === "compaction") {
              snapshot.content[event.index] = {
                ...snapshotContent,
                content: (snapshotContent.content || "") + event.delta.content
              };
            }
            break;
          }
          default:
            checkNever(event.delta);
        }
        return snapshot;
      }
      case "content_block_stop":
        return snapshot;
    }
  }, Symbol.asyncIterator)]() {
    const pushQueue = [];
    const readQueue = [];
    let done = false;
    this.on("streamEvent", (event) => {
      const reader = readQueue.shift();
      if (reader) {
        reader.resolve(event);
      } else {
        pushQueue.push(event);
      }
    });
    this.on("end", () => {
      done = true;
      for (const reader of readQueue) {
        reader.resolve(void 0);
      }
      readQueue.length = 0;
    });
    this.on("abort", (err) => {
      done = true;
      for (const reader of readQueue) {
        reader.reject(err);
      }
      readQueue.length = 0;
    });
    this.on("error", (err) => {
      done = true;
      for (const reader of readQueue) {
        reader.reject(err);
      }
      readQueue.length = 0;
    });
    return {
      next: async () => {
        if (!pushQueue.length) {
          if (done) {
            return { value: void 0, done: true };
          }
          return new Promise((resolve2, reject) => readQueue.push({ resolve: resolve2, reject })).then((chunk2) => chunk2 ? { value: chunk2, done: false } : { value: void 0, done: true });
        }
        const chunk = pushQueue.shift();
        return { value: chunk, done: false };
      },
      return: async () => {
        this.abort();
        return { value: void 0, done: true };
      }
    };
  }
  toReadableStream() {
    const stream = new Stream(this[Symbol.asyncIterator].bind(this), this.controller);
    return stream.toReadableStream();
  }
};
function checkNever(x) {
}

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/lib/tools/ToolError.mjs
var ToolError = class extends Error {
  constructor(content) {
    const message = typeof content === "string" ? content : content.map((block) => {
      if (block.type === "text")
        return block.text;
      return `[${block.type}]`;
    }).join(" ");
    super(message);
    this.name = "ToolError";
    this.content = content;
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/lib/tools/CompactionControl.mjs
var DEFAULT_TOKEN_THRESHOLD = 1e5;
var DEFAULT_SUMMARY_PROMPT = `You have been working on the task described above but have not yet completed it. Write a continuation summary that will allow you (or another instance of yourself) to resume work efficiently in a future context window where the conversation history will be replaced with this summary. Your summary should be structured, concise, and actionable. Include:
1. Task Overview
The user's core request and success criteria
Any clarifications or constraints they specified
2. Current State
What has been completed so far
Files created, modified, or analyzed (with paths if relevant)
Key outputs or artifacts produced
3. Important Discoveries
Technical constraints or requirements uncovered
Decisions made and their rationale
Errors encountered and how they were resolved
What approaches were tried that didn't work (and why)
4. Next Steps
Specific actions needed to complete the task
Any blockers or open questions to resolve
Priority order if multiple steps remain
5. Context to Preserve
User preferences or style requirements
Domain-specific details that aren't obvious
Any promises made to the user
Be concise but complete\u2014err on the side of including information that would prevent duplicate work or repeated mistakes. Write in a way that enables immediate resumption of the task.
Wrap your summary in <summary></summary> tags.`;

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/lib/tools/BetaToolRunner.mjs
var _BetaToolRunner_instances;
var _BetaToolRunner_consumed;
var _BetaToolRunner_mutated;
var _BetaToolRunner_state;
var _BetaToolRunner_options;
var _BetaToolRunner_message;
var _BetaToolRunner_toolResponse;
var _BetaToolRunner_completion;
var _BetaToolRunner_iterationCount;
var _BetaToolRunner_checkAndCompact;
var _BetaToolRunner_generateToolResponse;
function promiseWithResolvers() {
  let resolve2;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve2 = res;
    reject = rej;
  });
  return { promise, resolve: resolve2, reject };
}
var BetaToolRunner = class {
  constructor(client, params, options) {
    _BetaToolRunner_instances.add(this);
    this.client = client;
    _BetaToolRunner_consumed.set(this, false);
    _BetaToolRunner_mutated.set(this, false);
    _BetaToolRunner_state.set(this, void 0);
    _BetaToolRunner_options.set(this, void 0);
    _BetaToolRunner_message.set(this, void 0);
    _BetaToolRunner_toolResponse.set(this, void 0);
    _BetaToolRunner_completion.set(this, void 0);
    _BetaToolRunner_iterationCount.set(this, 0);
    __classPrivateFieldSet(this, _BetaToolRunner_state, {
      params: {
        // You can't clone the entire params since there are functions as handlers.
        // You also don't really need to clone params.messages, but it probably will prevent a foot gun
        // somewhere.
        ...params,
        messages: structuredClone(params.messages)
      }
    }, "f");
    const helpers = collectStainlessHelpers(params.tools, params.messages);
    const helperValue = ["BetaToolRunner", ...helpers].join(", ");
    __classPrivateFieldSet(this, _BetaToolRunner_options, {
      ...options,
      headers: buildHeaders([{ "x-stainless-helper": helperValue }, options?.headers])
    }, "f");
    __classPrivateFieldSet(this, _BetaToolRunner_completion, promiseWithResolvers(), "f");
    if (params.compactionControl?.enabled) {
      console.warn('Anthropic: The `compactionControl` parameter is deprecated and will be removed in a future version. Use server-side compaction instead by passing `edits: [{ type: "compact_20260112" }]` in the params passed to `toolRunner()`. See https://platform.claude.com/docs/en/build-with-claude/compaction');
    }
  }
  async *[(_BetaToolRunner_consumed = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_mutated = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_state = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_options = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_message = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_toolResponse = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_completion = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_iterationCount = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_instances = /* @__PURE__ */ new WeakSet(), _BetaToolRunner_checkAndCompact = async function _BetaToolRunner_checkAndCompact2() {
    const compactionControl = __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.compactionControl;
    if (!compactionControl || !compactionControl.enabled) {
      return false;
    }
    let tokensUsed = 0;
    if (__classPrivateFieldGet(this, _BetaToolRunner_message, "f") !== void 0) {
      try {
        const message = await __classPrivateFieldGet(this, _BetaToolRunner_message, "f");
        const totalInputTokens = message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0);
        tokensUsed = totalInputTokens + message.usage.output_tokens;
      } catch {
        return false;
      }
    }
    const threshold = compactionControl.contextTokenThreshold ?? DEFAULT_TOKEN_THRESHOLD;
    if (tokensUsed < threshold) {
      return false;
    }
    const model = compactionControl.model ?? __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.model;
    const summaryPrompt = compactionControl.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT;
    const messages = __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages;
    if (messages[messages.length - 1].role === "assistant") {
      const lastMessage = messages[messages.length - 1];
      if (Array.isArray(lastMessage.content)) {
        const nonToolBlocks = lastMessage.content.filter((block) => block.type !== "tool_use");
        if (nonToolBlocks.length === 0) {
          messages.pop();
        } else {
          lastMessage.content = nonToolBlocks;
        }
      }
    }
    const response = await this.client.beta.messages.create({
      model,
      messages: [
        ...messages,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: summaryPrompt
            }
          ]
        }
      ],
      max_tokens: __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.max_tokens
    }, {
      signal: __classPrivateFieldGet(this, _BetaToolRunner_options, "f").signal,
      headers: buildHeaders([__classPrivateFieldGet(this, _BetaToolRunner_options, "f").headers, { "x-stainless-helper": "compaction" }])
    });
    if (response.content[0]?.type !== "text") {
      throw new AnthropicError("Expected text response for compaction");
    }
    __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages = [
      {
        role: "user",
        content: response.content
      }
    ];
    return true;
  }, Symbol.asyncIterator)]() {
    var _a2;
    if (__classPrivateFieldGet(this, _BetaToolRunner_consumed, "f")) {
      throw new AnthropicError("Cannot iterate over a consumed stream");
    }
    __classPrivateFieldSet(this, _BetaToolRunner_consumed, true, "f");
    __classPrivateFieldSet(this, _BetaToolRunner_mutated, true, "f");
    __classPrivateFieldSet(this, _BetaToolRunner_toolResponse, void 0, "f");
    try {
      while (true) {
        let stream;
        try {
          if (__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.max_iterations && __classPrivateFieldGet(this, _BetaToolRunner_iterationCount, "f") >= __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.max_iterations) {
            break;
          }
          __classPrivateFieldSet(this, _BetaToolRunner_mutated, false, "f");
          __classPrivateFieldSet(this, _BetaToolRunner_toolResponse, void 0, "f");
          __classPrivateFieldSet(this, _BetaToolRunner_iterationCount, (_a2 = __classPrivateFieldGet(this, _BetaToolRunner_iterationCount, "f"), _a2++, _a2), "f");
          __classPrivateFieldSet(this, _BetaToolRunner_message, void 0, "f");
          const { max_iterations, compactionControl, ...params } = __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params;
          if (params.stream) {
            stream = this.client.beta.messages.stream({ ...params }, __classPrivateFieldGet(this, _BetaToolRunner_options, "f"));
            __classPrivateFieldSet(this, _BetaToolRunner_message, stream.finalMessage(), "f");
            __classPrivateFieldGet(this, _BetaToolRunner_message, "f").catch(() => {
            });
            yield stream;
          } else {
            __classPrivateFieldSet(this, _BetaToolRunner_message, this.client.beta.messages.create({ ...params, stream: false }, __classPrivateFieldGet(this, _BetaToolRunner_options, "f")), "f");
            yield __classPrivateFieldGet(this, _BetaToolRunner_message, "f");
          }
          const isCompacted = await __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_checkAndCompact).call(this);
          if (!isCompacted) {
            if (!__classPrivateFieldGet(this, _BetaToolRunner_mutated, "f")) {
              const { role, content } = await __classPrivateFieldGet(this, _BetaToolRunner_message, "f");
              __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages.push({ role, content });
            }
            const toolMessage = await __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_generateToolResponse).call(this, __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages.at(-1));
            if (toolMessage) {
              __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages.push(toolMessage);
            } else if (!__classPrivateFieldGet(this, _BetaToolRunner_mutated, "f")) {
              break;
            }
          }
        } finally {
          if (stream) {
            stream.abort();
          }
        }
      }
      if (!__classPrivateFieldGet(this, _BetaToolRunner_message, "f")) {
        throw new AnthropicError("ToolRunner concluded without a message from the server");
      }
      __classPrivateFieldGet(this, _BetaToolRunner_completion, "f").resolve(await __classPrivateFieldGet(this, _BetaToolRunner_message, "f"));
    } catch (error) {
      __classPrivateFieldSet(this, _BetaToolRunner_consumed, false, "f");
      __classPrivateFieldGet(this, _BetaToolRunner_completion, "f").promise.catch(() => {
      });
      __classPrivateFieldGet(this, _BetaToolRunner_completion, "f").reject(error);
      __classPrivateFieldSet(this, _BetaToolRunner_completion, promiseWithResolvers(), "f");
      throw error;
    }
  }
  setMessagesParams(paramsOrMutator) {
    if (typeof paramsOrMutator === "function") {
      __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params = paramsOrMutator(__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params);
    } else {
      __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params = paramsOrMutator;
    }
    __classPrivateFieldSet(this, _BetaToolRunner_mutated, true, "f");
    __classPrivateFieldSet(this, _BetaToolRunner_toolResponse, void 0, "f");
  }
  setRequestOptions(optionsOrMutator) {
    if (typeof optionsOrMutator === "function") {
      __classPrivateFieldSet(this, _BetaToolRunner_options, optionsOrMutator(__classPrivateFieldGet(this, _BetaToolRunner_options, "f")), "f");
    } else {
      __classPrivateFieldSet(this, _BetaToolRunner_options, { ...__classPrivateFieldGet(this, _BetaToolRunner_options, "f"), ...optionsOrMutator }, "f");
    }
  }
  /**
   * Get the tool response for the last message from the assistant.
   * Avoids redundant tool executions by caching results.
   *
   * @returns A promise that resolves to a BetaMessageParam containing tool results, or null if no tools need to be executed
   *
   * @example
   * const toolResponse = await runner.generateToolResponse();
   * if (toolResponse) {
   *   console.log('Tool results:', toolResponse.content);
   * }
   */
  async generateToolResponse(signal = __classPrivateFieldGet(this, _BetaToolRunner_options, "f").signal) {
    const message = await __classPrivateFieldGet(this, _BetaToolRunner_message, "f") ?? this.params.messages.at(-1);
    if (!message) {
      return null;
    }
    return __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_generateToolResponse).call(this, message, signal);
  }
  /**
   * Wait for the async iterator to complete. This works even if the async iterator hasn't yet started, and
   * will wait for an instance to start and go to completion.
   *
   * @returns A promise that resolves to the final BetaMessage when the iterator completes
   *
   * @example
   * // Start consuming the iterator
   * for await (const message of runner) {
   *   console.log('Message:', message.content);
   * }
   *
   * // Meanwhile, wait for completion from another part of the code
   * const finalMessage = await runner.done();
   * console.log('Final response:', finalMessage.content);
   */
  done() {
    return __classPrivateFieldGet(this, _BetaToolRunner_completion, "f").promise;
  }
  /**
   * Returns a promise indicating that the stream is done. Unlike .done(), this will eagerly read the stream:
   * * If the iterator has not been consumed, consume the entire iterator and return the final message from the
   * assistant.
   * * If the iterator has been consumed, waits for it to complete and returns the final message.
   *
   * @returns A promise that resolves to the final BetaMessage from the conversation
   * @throws {AnthropicError} If no messages were processed during the conversation
   *
   * @example
   * const finalMessage = await runner.runUntilDone();
   * console.log('Final response:', finalMessage.content);
   */
  async runUntilDone() {
    if (!__classPrivateFieldGet(this, _BetaToolRunner_consumed, "f")) {
      for await (const _ of this) {
      }
    }
    return this.done();
  }
  /**
   * Get the current parameters being used by the ToolRunner.
   *
   * @returns A readonly view of the current ToolRunnerParams
   *
   * @example
   * const currentParams = runner.params;
   * console.log('Current model:', currentParams.model);
   * console.log('Message count:', currentParams.messages.length);
   */
  get params() {
    return __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params;
  }
  /**
   * Add one or more messages to the conversation history.
   *
   * @param messages - One or more BetaMessageParam objects to add to the conversation
   *
   * @example
   * runner.pushMessages(
   *   { role: 'user', content: 'Also, what about the weather in NYC?' }
   * );
   *
   * @example
   * // Adding multiple messages
   * runner.pushMessages(
   *   { role: 'user', content: 'What about NYC?' },
   *   { role: 'user', content: 'And Boston?' }
   * );
   */
  pushMessages(...messages) {
    this.setMessagesParams((params) => ({
      ...params,
      messages: [...params.messages, ...messages]
    }));
  }
  /**
   * Makes the ToolRunner directly awaitable, equivalent to calling .runUntilDone()
   * This allows using `await runner` instead of `await runner.runUntilDone()`
   */
  then(onfulfilled, onrejected) {
    return this.runUntilDone().then(onfulfilled, onrejected);
  }
};
_BetaToolRunner_generateToolResponse = async function _BetaToolRunner_generateToolResponse2(lastMessage, signal = __classPrivateFieldGet(this, _BetaToolRunner_options, "f").signal) {
  if (__classPrivateFieldGet(this, _BetaToolRunner_toolResponse, "f") !== void 0) {
    return __classPrivateFieldGet(this, _BetaToolRunner_toolResponse, "f");
  }
  __classPrivateFieldSet(this, _BetaToolRunner_toolResponse, generateToolResponse(__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params, lastMessage, {
    ...__classPrivateFieldGet(this, _BetaToolRunner_options, "f"),
    signal
  }), "f");
  return __classPrivateFieldGet(this, _BetaToolRunner_toolResponse, "f");
};
async function generateToolResponse(params, lastMessage = params.messages.at(-1), requestOptions) {
  if (!lastMessage || lastMessage.role !== "assistant" || !lastMessage.content || typeof lastMessage.content === "string") {
    return null;
  }
  const toolUseBlocks = lastMessage.content.filter((content) => content.type === "tool_use");
  if (toolUseBlocks.length === 0) {
    return null;
  }
  const toolResults = await Promise.all(toolUseBlocks.map(async (toolUse) => {
    const tool = params.tools.find((t) => ("name" in t ? t.name : t.mcp_server_name) === toolUse.name);
    if (!tool || !("run" in tool)) {
      return {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: `Error: Tool '${toolUse.name}' not found`,
        is_error: true
      };
    }
    try {
      let input = toolUse.input;
      if ("parse" in tool && tool.parse) {
        input = tool.parse(input);
      }
      const result = await tool.run(input, {
        toolUseBlock: toolUse,
        signal: requestOptions?.signal
      });
      return {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result
      };
    } catch (error) {
      return {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: error instanceof ToolError ? error.content : `Error: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true
      };
    }
  }));
  return {
    role: "user",
    content: toolResults
  };
}

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/decoders/jsonl.mjs
var JSONLDecoder = class _JSONLDecoder {
  constructor(iterator, controller) {
    this.iterator = iterator;
    this.controller = controller;
  }
  async *decoder() {
    const lineDecoder = new LineDecoder();
    for await (const chunk of this.iterator) {
      for (const line of lineDecoder.decode(chunk)) {
        yield JSON.parse(line);
      }
    }
    for (const line of lineDecoder.flush()) {
      yield JSON.parse(line);
    }
  }
  [Symbol.asyncIterator]() {
    return this.decoder();
  }
  static fromResponse(response, controller) {
    if (!response.body) {
      controller.abort();
      if (typeof globalThis.navigator !== "undefined" && globalThis.navigator.product === "ReactNative") {
        throw new AnthropicError(`The default react-native fetch implementation does not support streaming. Please use expo/fetch: https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api`);
      }
      throw new AnthropicError(`Attempted to iterate over a response with no body`);
    }
    return new _JSONLDecoder(ReadableStreamToAsyncIterable(response.body), controller);
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/beta/messages/batches.mjs
var Batches = class extends APIResource {
  /**
   * Send a batch of Message creation requests.
   *
   * The Message Batches API can be used to process multiple Messages API requests at
   * once. Once a Message Batch is created, it begins processing immediately. Batches
   * can take up to 24 hours to complete.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const betaMessageBatch =
   *   await client.beta.messages.batches.create({
   *     requests: [
   *       {
   *         custom_id: 'my-custom-id-1',
   *         params: {
   *           max_tokens: 1024,
   *           messages: [
   *             { content: 'Hello, world', role: 'user' },
   *           ],
   *           model: 'claude-opus-4-6',
   *         },
   *       },
   *     ],
   *   });
   * ```
   */
  create(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/messages/batches?beta=true", {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * This endpoint is idempotent and can be used to poll for Message Batch
   * completion. To access the results of a Message Batch, make a request to the
   * `results_url` field in the response.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const betaMessageBatch =
   *   await client.beta.messages.batches.retrieve(
   *     'message_batch_id',
   *   );
   * ```
   */
  retrieve(messageBatchID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/messages/batches/${messageBatchID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List all Message Batches within a Workspace. Most recently created batches are
   * returned first.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaMessageBatch of client.beta.messages.batches.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/messages/batches?beta=true", Page, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Delete a Message Batch.
   *
   * Message Batches can only be deleted once they've finished processing. If you'd
   * like to delete an in-progress batch, you must first cancel it.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const betaDeletedMessageBatch =
   *   await client.beta.messages.batches.delete(
   *     'message_batch_id',
   *   );
   * ```
   */
  delete(messageBatchID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.delete(path`/v1/messages/batches/${messageBatchID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Batches may be canceled any time before processing ends. Once cancellation is
   * initiated, the batch enters a `canceling` state, at which time the system may
   * complete any in-progress, non-interruptible requests before finalizing
   * cancellation.
   *
   * The number of canceled requests is specified in `request_counts`. To determine
   * which requests were canceled, check the individual results within the batch.
   * Note that cancellation may not result in any canceled requests if they were
   * non-interruptible.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const betaMessageBatch =
   *   await client.beta.messages.batches.cancel(
   *     'message_batch_id',
   *   );
   * ```
   */
  cancel(messageBatchID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.post(path`/v1/messages/batches/${messageBatchID}/cancel?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Streams the results of a Message Batch as a `.jsonl` file.
   *
   * Each line in the file is a JSON object containing the result of a single request
   * in the Message Batch. Results are not guaranteed to be in the same order as
   * requests. Use the `custom_id` field to match results to requests.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const betaMessageBatchIndividualResponse =
   *   await client.beta.messages.batches.results(
   *     'message_batch_id',
   *   );
   * ```
   */
  async results(messageBatchID, params = {}, options) {
    const batch = await this.retrieve(messageBatchID);
    if (!batch.results_url) {
      throw new AnthropicError(`No batch \`results_url\`; Has it finished processing? ${batch.processing_status} - ${batch.id}`);
    }
    const { betas } = params ?? {};
    return this._client.get(batch.results_url, {
      ...options,
      headers: buildHeaders([
        {
          "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString(),
          Accept: "application/binary"
        },
        options?.headers
      ]),
      stream: true,
      __binaryResponse: true
    })._thenUnwrap((_, props) => JSONLDecoder.fromResponse(props.response, props.controller));
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.mjs
var DEPRECATED_MODELS = {
  "claude-1.3": "November 6th, 2024",
  "claude-1.3-100k": "November 6th, 2024",
  "claude-instant-1.1": "November 6th, 2024",
  "claude-instant-1.1-100k": "November 6th, 2024",
  "claude-instant-1.2": "November 6th, 2024",
  "claude-3-sonnet-20240229": "July 21st, 2025",
  "claude-3-opus-20240229": "January 5th, 2026",
  "claude-2.1": "July 21st, 2025",
  "claude-2.0": "July 21st, 2025",
  "claude-3-7-sonnet-latest": "February 19th, 2026",
  "claude-3-7-sonnet-20250219": "February 19th, 2026"
};
var MODELS_TO_WARN_WITH_THINKING_ENABLED = ["claude-mythos-preview", "claude-opus-4-6"];
var Messages = class extends APIResource {
  constructor() {
    super(...arguments);
    this.batches = new Batches(this._client);
  }
  create(params, options) {
    const modifiedParams = transformOutputFormat(params);
    const { betas, ...body } = modifiedParams;
    if (body.model in DEPRECATED_MODELS) {
      console.warn(`The model '${body.model}' is deprecated and will reach end-of-life on ${DEPRECATED_MODELS[body.model]}
Please migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.`);
    }
    if (MODELS_TO_WARN_WITH_THINKING_ENABLED.includes(body.model) && body.thinking && body.thinking.type === "enabled") {
      console.warn(`Using Claude with ${body.model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking`);
    }
    let timeout = this._client._options.timeout;
    if (!body.stream && timeout == null) {
      const maxNonstreamingTokens = MODEL_NONSTREAMING_TOKENS[body.model] ?? void 0;
      timeout = this._client.calculateNonstreamingTimeout(body.max_tokens, maxNonstreamingTokens);
    }
    const helperHeader = stainlessHelperHeader(body.tools, body.messages);
    return this._client.post("/v1/messages?beta=true", {
      body,
      timeout: timeout ?? 6e5,
      ...options,
      headers: buildHeaders([
        { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
        helperHeader,
        options?.headers
      ]),
      stream: modifiedParams.stream ?? false
    });
  }
  /**
   * Send a structured list of input messages with text and/or image content, along with an expected `output_format` and
   * the response will be automatically parsed and available in the `parsed_output` property of the message.
   *
   * @example
   * ```ts
   * const message = await client.beta.messages.parse({
   *   model: 'claude-3-5-sonnet-20241022',
   *   max_tokens: 1024,
   *   messages: [{ role: 'user', content: 'What is 2+2?' }],
   *   output_format: zodOutputFormat(z.object({ answer: z.number() }), 'math'),
   * });
   *
   * console.log(message.parsed_output?.answer); // 4
   * ```
   */
  parse(params, options) {
    options = {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...params.betas ?? [], "structured-outputs-2025-12-15"].toString() },
        options?.headers
      ])
    };
    return this.create(params, options).then((message) => parseBetaMessage(message, params, { logger: this._client.logger ?? console }));
  }
  /**
   * Create a Message stream
   */
  stream(body, options) {
    return BetaMessageStream.createMessage(this, body, options);
  }
  /**
   * Count the number of tokens in a Message.
   *
   * The Token Count API can be used to count the number of tokens in a Message,
   * including tools, images, and documents, without creating it.
   *
   * Learn more about token counting in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/token-counting)
   *
   * @example
   * ```ts
   * const betaMessageTokensCount =
   *   await client.beta.messages.countTokens({
   *     messages: [{ content: 'Hello, world', role: 'user' }],
   *     model: 'claude-opus-4-6',
   *   });
   * ```
   */
  countTokens(params, options) {
    const modifiedParams = transformOutputFormat(params);
    const { betas, ...body } = modifiedParams;
    return this._client.post("/v1/messages/count_tokens?beta=true", {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "token-counting-2024-11-01"].toString() },
        options?.headers
      ])
    });
  }
  toolRunner(body, options) {
    return new BetaToolRunner(this._client, body, options);
  }
};
function transformOutputFormat(params) {
  if (!params.output_format) {
    return params;
  }
  if (params.output_config?.format) {
    throw new AnthropicError("Both output_format and output_config.format were provided. Please use only output_config.format (output_format is deprecated).");
  }
  const { output_format, ...rest2 } = params;
  return {
    ...rest2,
    output_config: {
      ...params.output_config,
      format: output_format
    }
  };
}
Messages.Batches = Batches;
Messages.BetaToolRunner = BetaToolRunner;
Messages.ToolError = ToolError;

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/beta/sessions/events.mjs
var Events = class extends APIResource {
  /**
   * List Events
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaManagedAgentsSessionEvent of client.beta.sessions.events.list(
   *   'sesn_011CZkZAtmR3yMPDzynEDxu7',
   * )) {
   *   // ...
   * }
   * ```
   */
  list(sessionID, params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList(path`/v1/sessions/${sessionID}/events?beta=true`, PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Send Events
   *
   * @example
   * ```ts
   * const betaManagedAgentsSendSessionEvents =
   *   await client.beta.sessions.events.send(
   *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
   *     {
   *       events: [
   *         {
   *           content: [
   *             {
   *               text: 'Where is my order #1234?',
   *               type: 'text',
   *             },
   *           ],
   *           type: 'user.message',
   *         },
   *       ],
   *     },
   *   );
   * ```
   */
  send(sessionID, params, options) {
    const { betas, ...body } = params;
    return this._client.post(path`/v1/sessions/${sessionID}/events?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Stream Events
   *
   * @example
   * ```ts
   * const betaManagedAgentsStreamSessionEvents =
   *   await client.beta.sessions.events.stream(
   *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
   *   );
   * ```
   */
  stream(sessionID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/sessions/${sessionID}/events/stream?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ]),
      stream: true
    });
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/beta/sessions/resources.mjs
var Resources = class extends APIResource {
  /**
   * Get Session Resource
   *
   * @example
   * ```ts
   * const resource =
   *   await client.beta.sessions.resources.retrieve(
   *     'sesrsc_011CZkZBJq5dWxk9fVLNcPht',
   *     { session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7' },
   *   );
   * ```
   */
  retrieve(resourceID, params, options) {
    const { session_id, betas } = params;
    return this._client.get(path`/v1/sessions/${session_id}/resources/${resourceID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Update Session Resource
   *
   * @example
   * ```ts
   * const resource =
   *   await client.beta.sessions.resources.update(
   *     'sesrsc_011CZkZBJq5dWxk9fVLNcPht',
   *     {
   *       session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7',
   *       authorization_token: 'ghp_exampletoken',
   *     },
   *   );
   * ```
   */
  update(resourceID, params, options) {
    const { session_id, betas, ...body } = params;
    return this._client.post(path`/v1/sessions/${session_id}/resources/${resourceID}?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List Session Resources
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaManagedAgentsSessionResource of client.beta.sessions.resources.list(
   *   'sesn_011CZkZAtmR3yMPDzynEDxu7',
   * )) {
   *   // ...
   * }
   * ```
   */
  list(sessionID, params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList(path`/v1/sessions/${sessionID}/resources?beta=true`, PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Delete Session Resource
   *
   * @example
   * ```ts
   * const betaManagedAgentsDeleteSessionResource =
   *   await client.beta.sessions.resources.delete(
   *     'sesrsc_011CZkZBJq5dWxk9fVLNcPht',
   *     { session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7' },
   *   );
   * ```
   */
  delete(resourceID, params, options) {
    const { session_id, betas } = params;
    return this._client.delete(path`/v1/sessions/${session_id}/resources/${resourceID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Add Session Resource
   *
   * @example
   * ```ts
   * const betaManagedAgentsFileResource =
   *   await client.beta.sessions.resources.add(
   *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
   *     {
   *       file_id: 'file_011CNha8iCJcU1wXNR6q4V8w',
   *       type: 'file',
   *     },
   *   );
   * ```
   */
  add(sessionID, params, options) {
    const { betas, ...body } = params;
    return this._client.post(path`/v1/sessions/${sessionID}/resources?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/beta/sessions/sessions.mjs
var Sessions = class extends APIResource {
  constructor() {
    super(...arguments);
    this.events = new Events(this._client);
    this.resources = new Resources(this._client);
  }
  /**
   * Create Session
   *
   * @example
   * ```ts
   * const betaManagedAgentsSession =
   *   await client.beta.sessions.create({
   *     agent: 'agent_011CZkYpogX7uDKUyvBTophP',
   *     environment_id: 'env_011CZkZ9X2dpNyB7HsEFoRfW',
   *   });
   * ```
   */
  create(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/sessions?beta=true", {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Get Session
   *
   * @example
   * ```ts
   * const betaManagedAgentsSession =
   *   await client.beta.sessions.retrieve(
   *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
   *   );
   * ```
   */
  retrieve(sessionID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/sessions/${sessionID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Update Session
   *
   * @example
   * ```ts
   * const betaManagedAgentsSession =
   *   await client.beta.sessions.update(
   *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
   *   );
   * ```
   */
  update(sessionID, params, options) {
    const { betas, ...body } = params;
    return this._client.post(path`/v1/sessions/${sessionID}?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List Sessions
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaManagedAgentsSession of client.beta.sessions.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/sessions?beta=true", PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Delete Session
   *
   * @example
   * ```ts
   * const betaManagedAgentsDeletedSession =
   *   await client.beta.sessions.delete(
   *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
   *   );
   * ```
   */
  delete(sessionID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.delete(path`/v1/sessions/${sessionID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Archive Session
   *
   * @example
   * ```ts
   * const betaManagedAgentsSession =
   *   await client.beta.sessions.archive(
   *     'sesn_011CZkZAtmR3yMPDzynEDxu7',
   *   );
   * ```
   */
  archive(sessionID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.post(path`/v1/sessions/${sessionID}/archive?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
};
Sessions.Events = Events;
Sessions.Resources = Resources;

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/beta/skills/versions.mjs
var Versions2 = class extends APIResource {
  /**
   * Create Skill Version
   *
   * @example
   * ```ts
   * const version = await client.beta.skills.versions.create(
   *   'skill_id',
   * );
   * ```
   */
  create(skillID, params = {}, options) {
    const { betas, ...body } = params ?? {};
    return this._client.post(path`/v1/skills/${skillID}/versions?beta=true`, multipartFormRequestOptions({
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
        options?.headers
      ])
    }, this._client));
  }
  /**
   * Get Skill Version
   *
   * @example
   * ```ts
   * const version = await client.beta.skills.versions.retrieve(
   *   'version',
   *   { skill_id: 'skill_id' },
   * );
   * ```
   */
  retrieve(version, params, options) {
    const { skill_id, betas } = params;
    return this._client.get(path`/v1/skills/${skill_id}/versions/${version}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List Skill Versions
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const versionListResponse of client.beta.skills.versions.list(
   *   'skill_id',
   * )) {
   *   // ...
   * }
   * ```
   */
  list(skillID, params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList(path`/v1/skills/${skillID}/versions?beta=true`, PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Delete Skill Version
   *
   * @example
   * ```ts
   * const version = await client.beta.skills.versions.delete(
   *   'version',
   *   { skill_id: 'skill_id' },
   * );
   * ```
   */
  delete(version, params, options) {
    const { skill_id, betas } = params;
    return this._client.delete(path`/v1/skills/${skill_id}/versions/${version}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
        options?.headers
      ])
    });
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/beta/skills/skills.mjs
var Skills = class extends APIResource {
  constructor() {
    super(...arguments);
    this.versions = new Versions2(this._client);
  }
  /**
   * Create Skill
   *
   * @example
   * ```ts
   * const skill = await client.beta.skills.create();
   * ```
   */
  create(params = {}, options) {
    const { betas, ...body } = params ?? {};
    return this._client.post("/v1/skills?beta=true", multipartFormRequestOptions({
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
        options?.headers
      ])
    }, this._client, false));
  }
  /**
   * Get Skill
   *
   * @example
   * ```ts
   * const skill = await client.beta.skills.retrieve('skill_id');
   * ```
   */
  retrieve(skillID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/skills/${skillID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List Skills
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const skillListResponse of client.beta.skills.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/skills?beta=true", PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Delete Skill
   *
   * @example
   * ```ts
   * const skill = await client.beta.skills.delete('skill_id');
   * ```
   */
  delete(skillID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.delete(path`/v1/skills/${skillID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() },
        options?.headers
      ])
    });
  }
};
Skills.Versions = Versions2;

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/beta/vaults/credentials.mjs
var Credentials = class extends APIResource {
  /**
   * Create Credential
   *
   * @example
   * ```ts
   * const betaManagedAgentsCredential =
   *   await client.beta.vaults.credentials.create(
   *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
   *     {
   *       auth: {
   *         token: 'bearer_exampletoken',
   *         mcp_server_url:
   *           'https://example-server.modelcontextprotocol.io/sse',
   *         type: 'static_bearer',
   *       },
   *     },
   *   );
   * ```
   */
  create(vaultID, params, options) {
    const { betas, ...body } = params;
    return this._client.post(path`/v1/vaults/${vaultID}/credentials?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Get Credential
   *
   * @example
   * ```ts
   * const betaManagedAgentsCredential =
   *   await client.beta.vaults.credentials.retrieve(
   *     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
   *     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
   *   );
   * ```
   */
  retrieve(credentialID, params, options) {
    const { vault_id, betas } = params;
    return this._client.get(path`/v1/vaults/${vault_id}/credentials/${credentialID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Update Credential
   *
   * @example
   * ```ts
   * const betaManagedAgentsCredential =
   *   await client.beta.vaults.credentials.update(
   *     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
   *     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
   *   );
   * ```
   */
  update(credentialID, params, options) {
    const { vault_id, betas, ...body } = params;
    return this._client.post(path`/v1/vaults/${vault_id}/credentials/${credentialID}?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List Credentials
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaManagedAgentsCredential of client.beta.vaults.credentials.list(
   *   'vlt_011CZkZDLs7fYzm1hXNPeRjv',
   * )) {
   *   // ...
   * }
   * ```
   */
  list(vaultID, params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList(path`/v1/vaults/${vaultID}/credentials?beta=true`, PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Delete Credential
   *
   * @example
   * ```ts
   * const betaManagedAgentsDeletedCredential =
   *   await client.beta.vaults.credentials.delete(
   *     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
   *     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
   *   );
   * ```
   */
  delete(credentialID, params, options) {
    const { vault_id, betas } = params;
    return this._client.delete(path`/v1/vaults/${vault_id}/credentials/${credentialID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Archive Credential
   *
   * @example
   * ```ts
   * const betaManagedAgentsCredential =
   *   await client.beta.vaults.credentials.archive(
   *     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
   *     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
   *   );
   * ```
   */
  archive(credentialID, params, options) {
    const { vault_id, betas } = params;
    return this._client.post(path`/v1/vaults/${vault_id}/credentials/${credentialID}/archive?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/beta/vaults/vaults.mjs
var Vaults = class extends APIResource {
  constructor() {
    super(...arguments);
    this.credentials = new Credentials(this._client);
  }
  /**
   * Create Vault
   *
   * @example
   * ```ts
   * const betaManagedAgentsVault =
   *   await client.beta.vaults.create({
   *     display_name: 'Example vault',
   *   });
   * ```
   */
  create(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/vaults?beta=true", {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Get Vault
   *
   * @example
   * ```ts
   * const betaManagedAgentsVault =
   *   await client.beta.vaults.retrieve(
   *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
   *   );
   * ```
   */
  retrieve(vaultID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/vaults/${vaultID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Update Vault
   *
   * @example
   * ```ts
   * const betaManagedAgentsVault =
   *   await client.beta.vaults.update(
   *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
   *   );
   * ```
   */
  update(vaultID, params, options) {
    const { betas, ...body } = params;
    return this._client.post(path`/v1/vaults/${vaultID}?beta=true`, {
      body,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * List Vaults
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const betaManagedAgentsVault of client.beta.vaults.list()) {
   *   // ...
   * }
   * ```
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/vaults?beta=true", PageCursor, {
      query,
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Delete Vault
   *
   * @example
   * ```ts
   * const betaManagedAgentsDeletedVault =
   *   await client.beta.vaults.delete(
   *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
   *   );
   * ```
   */
  delete(vaultID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.delete(path`/v1/vaults/${vaultID}?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
  /**
   * Archive Vault
   *
   * @example
   * ```ts
   * const betaManagedAgentsVault =
   *   await client.beta.vaults.archive(
   *     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
   *   );
   * ```
   */
  archive(vaultID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.post(path`/v1/vaults/${vaultID}/archive?beta=true`, {
      ...options,
      headers: buildHeaders([
        { "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() },
        options?.headers
      ])
    });
  }
};
Vaults.Credentials = Credentials;

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/beta/beta.mjs
var Beta = class extends APIResource {
  constructor() {
    super(...arguments);
    this.models = new Models(this._client);
    this.messages = new Messages(this._client);
    this.agents = new Agents(this._client);
    this.environments = new Environments(this._client);
    this.sessions = new Sessions(this._client);
    this.vaults = new Vaults(this._client);
    this.files = new Files(this._client);
    this.skills = new Skills(this._client);
    this.userProfiles = new UserProfiles(this._client);
  }
};
Beta.Models = Models;
Beta.Messages = Messages;
Beta.Agents = Agents;
Beta.Environments = Environments;
Beta.Sessions = Sessions;
Beta.Vaults = Vaults;
Beta.Files = Files;
Beta.Skills = Skills;
Beta.UserProfiles = UserProfiles;

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/completions.mjs
var Completions = class extends APIResource {
  create(params, options) {
    const { betas, ...body } = params;
    return this._client.post("/v1/complete", {
      body,
      timeout: this._client._options.timeout ?? 6e5,
      ...options,
      headers: buildHeaders([
        { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
        options?.headers
      ]),
      stream: params.stream ?? false
    });
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/lib/parser.mjs
function getOutputFormat2(params) {
  return params?.output_config?.format;
}
function maybeParseMessage(message, params, opts) {
  const outputFormat = getOutputFormat2(params);
  if (!params || !("parse" in (outputFormat ?? {}))) {
    return {
      ...message,
      content: message.content.map((block) => {
        if (block.type === "text") {
          const parsedBlock = Object.defineProperty({ ...block }, "parsed_output", {
            value: null,
            enumerable: false
          });
          return parsedBlock;
        }
        return block;
      }),
      parsed_output: null
    };
  }
  return parseMessage(message, params, opts);
}
function parseMessage(message, params, opts) {
  let firstParsedOutput = null;
  const content = message.content.map((block) => {
    if (block.type === "text") {
      const parsedOutput = parseOutputFormat(params, block.text);
      if (firstParsedOutput === null) {
        firstParsedOutput = parsedOutput;
      }
      const parsedBlock = Object.defineProperty({ ...block }, "parsed_output", {
        value: parsedOutput,
        enumerable: false
      });
      return parsedBlock;
    }
    return block;
  });
  return {
    ...message,
    content,
    parsed_output: firstParsedOutput
  };
}
function parseOutputFormat(params, content) {
  const outputFormat = getOutputFormat2(params);
  if (outputFormat?.type !== "json_schema") {
    return null;
  }
  try {
    if ("parse" in outputFormat) {
      return outputFormat.parse(content);
    }
    return JSON.parse(content);
  } catch (error) {
    throw new AnthropicError(`Failed to parse structured output: ${error}`);
  }
}

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/lib/MessageStream.mjs
var _MessageStream_instances;
var _MessageStream_currentMessageSnapshot;
var _MessageStream_params;
var _MessageStream_connectedPromise;
var _MessageStream_resolveConnectedPromise;
var _MessageStream_rejectConnectedPromise;
var _MessageStream_endPromise;
var _MessageStream_resolveEndPromise;
var _MessageStream_rejectEndPromise;
var _MessageStream_listeners;
var _MessageStream_ended;
var _MessageStream_errored;
var _MessageStream_aborted;
var _MessageStream_catchingPromiseCreated;
var _MessageStream_response;
var _MessageStream_request_id;
var _MessageStream_logger;
var _MessageStream_getFinalMessage;
var _MessageStream_getFinalText;
var _MessageStream_handleError;
var _MessageStream_beginRequest;
var _MessageStream_addStreamEvent;
var _MessageStream_endRequest;
var _MessageStream_accumulateMessage;
var JSON_BUF_PROPERTY2 = "__json_buf";
function tracksToolInput2(content) {
  return content.type === "tool_use" || content.type === "server_tool_use";
}
var MessageStream = class _MessageStream {
  constructor(params, opts) {
    _MessageStream_instances.add(this);
    this.messages = [];
    this.receivedMessages = [];
    _MessageStream_currentMessageSnapshot.set(this, void 0);
    _MessageStream_params.set(this, null);
    this.controller = new AbortController();
    _MessageStream_connectedPromise.set(this, void 0);
    _MessageStream_resolveConnectedPromise.set(this, () => {
    });
    _MessageStream_rejectConnectedPromise.set(this, () => {
    });
    _MessageStream_endPromise.set(this, void 0);
    _MessageStream_resolveEndPromise.set(this, () => {
    });
    _MessageStream_rejectEndPromise.set(this, () => {
    });
    _MessageStream_listeners.set(this, {});
    _MessageStream_ended.set(this, false);
    _MessageStream_errored.set(this, false);
    _MessageStream_aborted.set(this, false);
    _MessageStream_catchingPromiseCreated.set(this, false);
    _MessageStream_response.set(this, void 0);
    _MessageStream_request_id.set(this, void 0);
    _MessageStream_logger.set(this, void 0);
    _MessageStream_handleError.set(this, (error) => {
      __classPrivateFieldSet(this, _MessageStream_errored, true, "f");
      if (isAbortError(error)) {
        error = new APIUserAbortError();
      }
      if (error instanceof APIUserAbortError) {
        __classPrivateFieldSet(this, _MessageStream_aborted, true, "f");
        return this._emit("abort", error);
      }
      if (error instanceof AnthropicError) {
        return this._emit("error", error);
      }
      if (error instanceof Error) {
        const anthropicError = new AnthropicError(error.message);
        anthropicError.cause = error;
        return this._emit("error", anthropicError);
      }
      return this._emit("error", new AnthropicError(String(error)));
    });
    __classPrivateFieldSet(this, _MessageStream_connectedPromise, new Promise((resolve2, reject) => {
      __classPrivateFieldSet(this, _MessageStream_resolveConnectedPromise, resolve2, "f");
      __classPrivateFieldSet(this, _MessageStream_rejectConnectedPromise, reject, "f");
    }), "f");
    __classPrivateFieldSet(this, _MessageStream_endPromise, new Promise((resolve2, reject) => {
      __classPrivateFieldSet(this, _MessageStream_resolveEndPromise, resolve2, "f");
      __classPrivateFieldSet(this, _MessageStream_rejectEndPromise, reject, "f");
    }), "f");
    __classPrivateFieldGet(this, _MessageStream_connectedPromise, "f").catch(() => {
    });
    __classPrivateFieldGet(this, _MessageStream_endPromise, "f").catch(() => {
    });
    __classPrivateFieldSet(this, _MessageStream_params, params, "f");
    __classPrivateFieldSet(this, _MessageStream_logger, opts?.logger ?? console, "f");
  }
  get response() {
    return __classPrivateFieldGet(this, _MessageStream_response, "f");
  }
  get request_id() {
    return __classPrivateFieldGet(this, _MessageStream_request_id, "f");
  }
  /**
   * Returns the `MessageStream` data, the raw `Response` instance and the ID of the request,
   * returned vie the `request-id` header which is useful for debugging requests and resporting
   * issues to Anthropic.
   *
   * This is the same as the `APIPromise.withResponse()` method.
   *
   * This method will raise an error if you created the stream using `MessageStream.fromReadableStream`
   * as no `Response` is available.
   */
  async withResponse() {
    __classPrivateFieldSet(this, _MessageStream_catchingPromiseCreated, true, "f");
    const response = await __classPrivateFieldGet(this, _MessageStream_connectedPromise, "f");
    if (!response) {
      throw new Error("Could not resolve a `Response` object");
    }
    return {
      data: this,
      response,
      request_id: response.headers.get("request-id")
    };
  }
  /**
   * Intended for use on the frontend, consuming a stream produced with
   * `.toReadableStream()` on the backend.
   *
   * Note that messages sent to the model do not appear in `.on('message')`
   * in this context.
   */
  static fromReadableStream(stream) {
    const runner = new _MessageStream(null);
    runner._run(() => runner._fromReadableStream(stream));
    return runner;
  }
  static createMessage(messages, params, options, { logger } = {}) {
    const runner = new _MessageStream(params, { logger });
    for (const message of params.messages) {
      runner._addMessageParam(message);
    }
    __classPrivateFieldSet(runner, _MessageStream_params, { ...params, stream: true }, "f");
    runner._run(() => runner._createMessage(messages, { ...params, stream: true }, { ...options, headers: { ...options?.headers, "X-Stainless-Helper-Method": "stream" } }));
    return runner;
  }
  _run(executor) {
    executor().then(() => {
      this._emitFinal();
      this._emit("end");
    }, __classPrivateFieldGet(this, _MessageStream_handleError, "f"));
  }
  _addMessageParam(message) {
    this.messages.push(message);
  }
  _addMessage(message, emit = true) {
    this.receivedMessages.push(message);
    if (emit) {
      this._emit("message", message);
    }
  }
  async _createMessage(messages, params, options) {
    const signal = options?.signal;
    let abortHandler;
    if (signal) {
      if (signal.aborted)
        this.controller.abort();
      abortHandler = this.controller.abort.bind(this.controller);
      signal.addEventListener("abort", abortHandler);
    }
    try {
      __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_beginRequest).call(this);
      const { response, data: stream } = await messages.create({ ...params, stream: true }, { ...options, signal: this.controller.signal }).withResponse();
      this._connected(response);
      for await (const event of stream) {
        __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_addStreamEvent).call(this, event);
      }
      if (stream.controller.signal?.aborted) {
        throw new APIUserAbortError();
      }
      __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_endRequest).call(this);
    } finally {
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  }
  _connected(response) {
    if (this.ended)
      return;
    __classPrivateFieldSet(this, _MessageStream_response, response, "f");
    __classPrivateFieldSet(this, _MessageStream_request_id, response?.headers.get("request-id"), "f");
    __classPrivateFieldGet(this, _MessageStream_resolveConnectedPromise, "f").call(this, response);
    this._emit("connect");
  }
  get ended() {
    return __classPrivateFieldGet(this, _MessageStream_ended, "f");
  }
  get errored() {
    return __classPrivateFieldGet(this, _MessageStream_errored, "f");
  }
  get aborted() {
    return __classPrivateFieldGet(this, _MessageStream_aborted, "f");
  }
  abort() {
    this.controller.abort();
  }
  /**
   * Adds the listener function to the end of the listeners array for the event.
   * No checks are made to see if the listener has already been added. Multiple calls passing
   * the same combination of event and listener will result in the listener being added, and
   * called, multiple times.
   * @returns this MessageStream, so that calls can be chained
   */
  on(event, listener) {
    const listeners = __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] = []);
    listeners.push({ listener });
    return this;
  }
  /**
   * Removes the specified listener from the listener array for the event.
   * off() will remove, at most, one instance of a listener from the listener array. If any single
   * listener has been added multiple times to the listener array for the specified event, then
   * off() must be called multiple times to remove each instance.
   * @returns this MessageStream, so that calls can be chained
   */
  off(event, listener) {
    const listeners = __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event];
    if (!listeners)
      return this;
    const index = listeners.findIndex((l) => l.listener === listener);
    if (index >= 0)
      listeners.splice(index, 1);
    return this;
  }
  /**
   * Adds a one-time listener function for the event. The next time the event is triggered,
   * this listener is removed and then invoked.
   * @returns this MessageStream, so that calls can be chained
   */
  once(event, listener) {
    const listeners = __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] = []);
    listeners.push({ listener, once: true });
    return this;
  }
  /**
   * This is similar to `.once()`, but returns a Promise that resolves the next time
   * the event is triggered, instead of calling a listener callback.
   * @returns a Promise that resolves the next time given event is triggered,
   * or rejects if an error is emitted.  (If you request the 'error' event,
   * returns a promise that resolves with the error).
   *
   * Example:
   *
   *   const message = await stream.emitted('message') // rejects if the stream errors
   */
  emitted(event) {
    return new Promise((resolve2, reject) => {
      __classPrivateFieldSet(this, _MessageStream_catchingPromiseCreated, true, "f");
      if (event !== "error")
        this.once("error", reject);
      this.once(event, resolve2);
    });
  }
  async done() {
    __classPrivateFieldSet(this, _MessageStream_catchingPromiseCreated, true, "f");
    await __classPrivateFieldGet(this, _MessageStream_endPromise, "f");
  }
  get currentMessage() {
    return __classPrivateFieldGet(this, _MessageStream_currentMessageSnapshot, "f");
  }
  /**
   * @returns a promise that resolves with the the final assistant Message response,
   * or rejects if an error occurred or the stream ended prematurely without producing a Message.
   * If structured outputs were used, this will be a ParsedMessage with a `parsed_output` field.
   */
  async finalMessage() {
    await this.done();
    return __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_getFinalMessage).call(this);
  }
  /**
   * @returns a promise that resolves with the the final assistant Message's text response, concatenated
   * together if there are more than one text blocks.
   * Rejects if an error occurred or the stream ended prematurely without producing a Message.
   */
  async finalText() {
    await this.done();
    return __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_getFinalText).call(this);
  }
  _emit(event, ...args) {
    if (__classPrivateFieldGet(this, _MessageStream_ended, "f"))
      return;
    if (event === "end") {
      __classPrivateFieldSet(this, _MessageStream_ended, true, "f");
      __classPrivateFieldGet(this, _MessageStream_resolveEndPromise, "f").call(this);
    }
    const listeners = __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event];
    if (listeners) {
      __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] = listeners.filter((l) => !l.once);
      listeners.forEach(({ listener }) => listener(...args));
    }
    if (event === "abort") {
      const error = args[0];
      if (!__classPrivateFieldGet(this, _MessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
        Promise.reject(error);
      }
      __classPrivateFieldGet(this, _MessageStream_rejectConnectedPromise, "f").call(this, error);
      __classPrivateFieldGet(this, _MessageStream_rejectEndPromise, "f").call(this, error);
      this._emit("end");
      return;
    }
    if (event === "error") {
      const error = args[0];
      if (!__classPrivateFieldGet(this, _MessageStream_catchingPromiseCreated, "f") && !listeners?.length) {
        Promise.reject(error);
      }
      __classPrivateFieldGet(this, _MessageStream_rejectConnectedPromise, "f").call(this, error);
      __classPrivateFieldGet(this, _MessageStream_rejectEndPromise, "f").call(this, error);
      this._emit("end");
    }
  }
  _emitFinal() {
    const finalMessage = this.receivedMessages.at(-1);
    if (finalMessage) {
      this._emit("finalMessage", __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_getFinalMessage).call(this));
    }
  }
  async _fromReadableStream(readableStream, options) {
    const signal = options?.signal;
    let abortHandler;
    if (signal) {
      if (signal.aborted)
        this.controller.abort();
      abortHandler = this.controller.abort.bind(this.controller);
      signal.addEventListener("abort", abortHandler);
    }
    try {
      __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_beginRequest).call(this);
      this._connected(null);
      const stream = Stream.fromReadableStream(readableStream, this.controller);
      for await (const event of stream) {
        __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_addStreamEvent).call(this, event);
      }
      if (stream.controller.signal?.aborted) {
        throw new APIUserAbortError();
      }
      __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_endRequest).call(this);
    } finally {
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  }
  [(_MessageStream_currentMessageSnapshot = /* @__PURE__ */ new WeakMap(), _MessageStream_params = /* @__PURE__ */ new WeakMap(), _MessageStream_connectedPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_resolveConnectedPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_rejectConnectedPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_endPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_resolveEndPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_rejectEndPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_listeners = /* @__PURE__ */ new WeakMap(), _MessageStream_ended = /* @__PURE__ */ new WeakMap(), _MessageStream_errored = /* @__PURE__ */ new WeakMap(), _MessageStream_aborted = /* @__PURE__ */ new WeakMap(), _MessageStream_catchingPromiseCreated = /* @__PURE__ */ new WeakMap(), _MessageStream_response = /* @__PURE__ */ new WeakMap(), _MessageStream_request_id = /* @__PURE__ */ new WeakMap(), _MessageStream_logger = /* @__PURE__ */ new WeakMap(), _MessageStream_handleError = /* @__PURE__ */ new WeakMap(), _MessageStream_instances = /* @__PURE__ */ new WeakSet(), _MessageStream_getFinalMessage = function _MessageStream_getFinalMessage2() {
    if (this.receivedMessages.length === 0) {
      throw new AnthropicError("stream ended without producing a Message with role=assistant");
    }
    return this.receivedMessages.at(-1);
  }, _MessageStream_getFinalText = function _MessageStream_getFinalText2() {
    if (this.receivedMessages.length === 0) {
      throw new AnthropicError("stream ended without producing a Message with role=assistant");
    }
    const textBlocks = this.receivedMessages.at(-1).content.filter((block) => block.type === "text").map((block) => block.text);
    if (textBlocks.length === 0) {
      throw new AnthropicError("stream ended without producing a content block with type=text");
    }
    return textBlocks.join(" ");
  }, _MessageStream_beginRequest = function _MessageStream_beginRequest2() {
    if (this.ended)
      return;
    __classPrivateFieldSet(this, _MessageStream_currentMessageSnapshot, void 0, "f");
  }, _MessageStream_addStreamEvent = function _MessageStream_addStreamEvent2(event) {
    if (this.ended)
      return;
    const messageSnapshot = __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_accumulateMessage).call(this, event);
    this._emit("streamEvent", event, messageSnapshot);
    switch (event.type) {
      case "content_block_delta": {
        const content = messageSnapshot.content.at(-1);
        switch (event.delta.type) {
          case "text_delta": {
            if (content.type === "text") {
              this._emit("text", event.delta.text, content.text || "");
            }
            break;
          }
          case "citations_delta": {
            if (content.type === "text") {
              this._emit("citation", event.delta.citation, content.citations ?? []);
            }
            break;
          }
          case "input_json_delta": {
            if (tracksToolInput2(content) && content.input) {
              this._emit("inputJson", event.delta.partial_json, content.input);
            }
            break;
          }
          case "thinking_delta": {
            if (content.type === "thinking") {
              this._emit("thinking", event.delta.thinking, content.thinking);
            }
            break;
          }
          case "signature_delta": {
            if (content.type === "thinking") {
              this._emit("signature", content.signature);
            }
            break;
          }
          default:
            checkNever2(event.delta);
        }
        break;
      }
      case "message_stop": {
        this._addMessageParam(messageSnapshot);
        this._addMessage(maybeParseMessage(messageSnapshot, __classPrivateFieldGet(this, _MessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _MessageStream_logger, "f") }), true);
        break;
      }
      case "content_block_stop": {
        this._emit("contentBlock", messageSnapshot.content.at(-1));
        break;
      }
      case "message_start": {
        __classPrivateFieldSet(this, _MessageStream_currentMessageSnapshot, messageSnapshot, "f");
        break;
      }
      case "content_block_start":
      case "message_delta":
        break;
    }
  }, _MessageStream_endRequest = function _MessageStream_endRequest2() {
    if (this.ended) {
      throw new AnthropicError(`stream has ended, this shouldn't happen`);
    }
    const snapshot = __classPrivateFieldGet(this, _MessageStream_currentMessageSnapshot, "f");
    if (!snapshot) {
      throw new AnthropicError(`request ended without sending any chunks`);
    }
    __classPrivateFieldSet(this, _MessageStream_currentMessageSnapshot, void 0, "f");
    return maybeParseMessage(snapshot, __classPrivateFieldGet(this, _MessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _MessageStream_logger, "f") });
  }, _MessageStream_accumulateMessage = function _MessageStream_accumulateMessage2(event) {
    let snapshot = __classPrivateFieldGet(this, _MessageStream_currentMessageSnapshot, "f");
    if (event.type === "message_start") {
      if (snapshot) {
        throw new AnthropicError(`Unexpected event order, got ${event.type} before receiving "message_stop"`);
      }
      return event.message;
    }
    if (!snapshot) {
      throw new AnthropicError(`Unexpected event order, got ${event.type} before "message_start"`);
    }
    switch (event.type) {
      case "message_stop":
        return snapshot;
      case "message_delta":
        snapshot.stop_reason = event.delta.stop_reason;
        snapshot.stop_sequence = event.delta.stop_sequence;
        snapshot.usage.output_tokens = event.usage.output_tokens;
        if (event.usage.input_tokens != null) {
          snapshot.usage.input_tokens = event.usage.input_tokens;
        }
        if (event.usage.cache_creation_input_tokens != null) {
          snapshot.usage.cache_creation_input_tokens = event.usage.cache_creation_input_tokens;
        }
        if (event.usage.cache_read_input_tokens != null) {
          snapshot.usage.cache_read_input_tokens = event.usage.cache_read_input_tokens;
        }
        if (event.usage.server_tool_use != null) {
          snapshot.usage.server_tool_use = event.usage.server_tool_use;
        }
        return snapshot;
      case "content_block_start":
        snapshot.content.push({ ...event.content_block });
        return snapshot;
      case "content_block_delta": {
        const snapshotContent = snapshot.content.at(event.index);
        switch (event.delta.type) {
          case "text_delta": {
            if (snapshotContent?.type === "text") {
              snapshot.content[event.index] = {
                ...snapshotContent,
                text: (snapshotContent.text || "") + event.delta.text
              };
            }
            break;
          }
          case "citations_delta": {
            if (snapshotContent?.type === "text") {
              snapshot.content[event.index] = {
                ...snapshotContent,
                citations: [...snapshotContent.citations ?? [], event.delta.citation]
              };
            }
            break;
          }
          case "input_json_delta": {
            if (snapshotContent && tracksToolInput2(snapshotContent)) {
              let jsonBuf = snapshotContent[JSON_BUF_PROPERTY2] || "";
              jsonBuf += event.delta.partial_json;
              const newContent = { ...snapshotContent };
              Object.defineProperty(newContent, JSON_BUF_PROPERTY2, {
                value: jsonBuf,
                enumerable: false,
                writable: true
              });
              if (jsonBuf) {
                newContent.input = partialParse(jsonBuf);
              }
              snapshot.content[event.index] = newContent;
            }
            break;
          }
          case "thinking_delta": {
            if (snapshotContent?.type === "thinking") {
              snapshot.content[event.index] = {
                ...snapshotContent,
                thinking: snapshotContent.thinking + event.delta.thinking
              };
            }
            break;
          }
          case "signature_delta": {
            if (snapshotContent?.type === "thinking") {
              snapshot.content[event.index] = {
                ...snapshotContent,
                signature: event.delta.signature
              };
            }
            break;
          }
          default:
            checkNever2(event.delta);
        }
        return snapshot;
      }
      case "content_block_stop":
        return snapshot;
    }
  }, Symbol.asyncIterator)]() {
    const pushQueue = [];
    const readQueue = [];
    let done = false;
    this.on("streamEvent", (event) => {
      const reader = readQueue.shift();
      if (reader) {
        reader.resolve(event);
      } else {
        pushQueue.push(event);
      }
    });
    this.on("end", () => {
      done = true;
      for (const reader of readQueue) {
        reader.resolve(void 0);
      }
      readQueue.length = 0;
    });
    this.on("abort", (err) => {
      done = true;
      for (const reader of readQueue) {
        reader.reject(err);
      }
      readQueue.length = 0;
    });
    this.on("error", (err) => {
      done = true;
      for (const reader of readQueue) {
        reader.reject(err);
      }
      readQueue.length = 0;
    });
    return {
      next: async () => {
        if (!pushQueue.length) {
          if (done) {
            return { value: void 0, done: true };
          }
          return new Promise((resolve2, reject) => readQueue.push({ resolve: resolve2, reject })).then((chunk2) => chunk2 ? { value: chunk2, done: false } : { value: void 0, done: true });
        }
        const chunk = pushQueue.shift();
        return { value: chunk, done: false };
      },
      return: async () => {
        this.abort();
        return { value: void 0, done: true };
      }
    };
  }
  toReadableStream() {
    const stream = new Stream(this[Symbol.asyncIterator].bind(this), this.controller);
    return stream.toReadableStream();
  }
};
function checkNever2(x) {
}

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/messages/batches.mjs
var Batches2 = class extends APIResource {
  /**
   * Send a batch of Message creation requests.
   *
   * The Message Batches API can be used to process multiple Messages API requests at
   * once. Once a Message Batch is created, it begins processing immediately. Batches
   * can take up to 24 hours to complete.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const messageBatch = await client.messages.batches.create({
   *   requests: [
   *     {
   *       custom_id: 'my-custom-id-1',
   *       params: {
   *         max_tokens: 1024,
   *         messages: [
   *           { content: 'Hello, world', role: 'user' },
   *         ],
   *         model: 'claude-opus-4-6',
   *       },
   *     },
   *   ],
   * });
   * ```
   */
  create(body, options) {
    return this._client.post("/v1/messages/batches", { body, ...options });
  }
  /**
   * This endpoint is idempotent and can be used to poll for Message Batch
   * completion. To access the results of a Message Batch, make a request to the
   * `results_url` field in the response.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const messageBatch = await client.messages.batches.retrieve(
   *   'message_batch_id',
   * );
   * ```
   */
  retrieve(messageBatchID, options) {
    return this._client.get(path`/v1/messages/batches/${messageBatchID}`, options);
  }
  /**
   * List all Message Batches within a Workspace. Most recently created batches are
   * returned first.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * // Automatically fetches more pages as needed.
   * for await (const messageBatch of client.messages.batches.list()) {
   *   // ...
   * }
   * ```
   */
  list(query = {}, options) {
    return this._client.getAPIList("/v1/messages/batches", Page, { query, ...options });
  }
  /**
   * Delete a Message Batch.
   *
   * Message Batches can only be deleted once they've finished processing. If you'd
   * like to delete an in-progress batch, you must first cancel it.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const deletedMessageBatch =
   *   await client.messages.batches.delete('message_batch_id');
   * ```
   */
  delete(messageBatchID, options) {
    return this._client.delete(path`/v1/messages/batches/${messageBatchID}`, options);
  }
  /**
   * Batches may be canceled any time before processing ends. Once cancellation is
   * initiated, the batch enters a `canceling` state, at which time the system may
   * complete any in-progress, non-interruptible requests before finalizing
   * cancellation.
   *
   * The number of canceled requests is specified in `request_counts`. To determine
   * which requests were canceled, check the individual results within the batch.
   * Note that cancellation may not result in any canceled requests if they were
   * non-interruptible.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const messageBatch = await client.messages.batches.cancel(
   *   'message_batch_id',
   * );
   * ```
   */
  cancel(messageBatchID, options) {
    return this._client.post(path`/v1/messages/batches/${messageBatchID}/cancel`, options);
  }
  /**
   * Streams the results of a Message Batch as a `.jsonl` file.
   *
   * Each line in the file is a JSON object containing the result of a single request
   * in the Message Batch. Results are not guaranteed to be in the same order as
   * requests. Use the `custom_id` field to match results to requests.
   *
   * Learn more about the Message Batches API in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
   *
   * @example
   * ```ts
   * const messageBatchIndividualResponse =
   *   await client.messages.batches.results('message_batch_id');
   * ```
   */
  async results(messageBatchID, options) {
    const batch = await this.retrieve(messageBatchID);
    if (!batch.results_url) {
      throw new AnthropicError(`No batch \`results_url\`; Has it finished processing? ${batch.processing_status} - ${batch.id}`);
    }
    return this._client.get(batch.results_url, {
      ...options,
      headers: buildHeaders([{ Accept: "application/binary" }, options?.headers]),
      stream: true,
      __binaryResponse: true
    })._thenUnwrap((_, props) => JSONLDecoder.fromResponse(props.response, props.controller));
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/messages/messages.mjs
var Messages2 = class extends APIResource {
  constructor() {
    super(...arguments);
    this.batches = new Batches2(this._client);
  }
  create(body, options) {
    if (body.model in DEPRECATED_MODELS2) {
      console.warn(`The model '${body.model}' is deprecated and will reach end-of-life on ${DEPRECATED_MODELS2[body.model]}
Please migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.`);
    }
    if (MODELS_TO_WARN_WITH_THINKING_ENABLED2.includes(body.model) && body.thinking && body.thinking.type === "enabled") {
      console.warn(`Using Claude with ${body.model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking`);
    }
    let timeout = this._client._options.timeout;
    if (!body.stream && timeout == null) {
      const maxNonstreamingTokens = MODEL_NONSTREAMING_TOKENS[body.model] ?? void 0;
      timeout = this._client.calculateNonstreamingTimeout(body.max_tokens, maxNonstreamingTokens);
    }
    const helperHeader = stainlessHelperHeader(body.tools, body.messages);
    return this._client.post("/v1/messages", {
      body,
      timeout: timeout ?? 6e5,
      ...options,
      headers: buildHeaders([helperHeader, options?.headers]),
      stream: body.stream ?? false
    });
  }
  /**
   * Send a structured list of input messages with text and/or image content, along with an expected `output_config.format` and
   * the response will be automatically parsed and available in the `parsed_output` property of the message.
   *
   * @example
   * ```ts
   * const message = await client.messages.parse({
   *   model: 'claude-sonnet-4-5-20250929',
   *   max_tokens: 1024,
   *   messages: [{ role: 'user', content: 'What is 2+2?' }],
   *   output_config: {
   *     format: zodOutputFormat(z.object({ answer: z.number() })),
   *   },
   * });
   *
   * console.log(message.parsed_output?.answer); // 4
   * ```
   */
  parse(params, options) {
    return this.create(params, options).then((message) => parseMessage(message, params, { logger: this._client.logger ?? console }));
  }
  /**
   * Create a Message stream.
   *
   * If `output_config.format` is provided with a parseable format (like `zodOutputFormat()`),
   * the final message will include a `parsed_output` property with the parsed content.
   *
   * @example
   * ```ts
   * const stream = client.messages.stream({
   *   model: 'claude-sonnet-4-5-20250929',
   *   max_tokens: 1024,
   *   messages: [{ role: 'user', content: 'What is 2+2?' }],
   *   output_config: {
   *     format: zodOutputFormat(z.object({ answer: z.number() })),
   *   },
   * });
   *
   * const message = await stream.finalMessage();
   * console.log(message.parsed_output?.answer); // 4
   * ```
   */
  stream(body, options) {
    return MessageStream.createMessage(this, body, options, { logger: this._client.logger ?? console });
  }
  /**
   * Count the number of tokens in a Message.
   *
   * The Token Count API can be used to count the number of tokens in a Message,
   * including tools, images, and documents, without creating it.
   *
   * Learn more about token counting in our
   * [user guide](https://docs.claude.com/en/docs/build-with-claude/token-counting)
   *
   * @example
   * ```ts
   * const messageTokensCount =
   *   await client.messages.countTokens({
   *     messages: [{ content: 'Hello, world', role: 'user' }],
   *     model: 'claude-opus-4-6',
   *   });
   * ```
   */
  countTokens(body, options) {
    return this._client.post("/v1/messages/count_tokens", { body, ...options });
  }
};
var DEPRECATED_MODELS2 = {
  "claude-1.3": "November 6th, 2024",
  "claude-1.3-100k": "November 6th, 2024",
  "claude-instant-1.1": "November 6th, 2024",
  "claude-instant-1.1-100k": "November 6th, 2024",
  "claude-instant-1.2": "November 6th, 2024",
  "claude-3-sonnet-20240229": "July 21st, 2025",
  "claude-3-opus-20240229": "January 5th, 2026",
  "claude-2.1": "July 21st, 2025",
  "claude-2.0": "July 21st, 2025",
  "claude-3-7-sonnet-latest": "February 19th, 2026",
  "claude-3-7-sonnet-20250219": "February 19th, 2026",
  "claude-3-5-haiku-latest": "February 19th, 2026",
  "claude-3-5-haiku-20241022": "February 19th, 2026",
  "claude-opus-4-0": "June 15th, 2026",
  "claude-opus-4-20250514": "June 15th, 2026",
  "claude-sonnet-4-0": "June 15th, 2026",
  "claude-sonnet-4-20250514": "June 15th, 2026"
};
var MODELS_TO_WARN_WITH_THINKING_ENABLED2 = ["claude-mythos-preview", "claude-opus-4-6"];
Messages2.Batches = Batches2;

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/resources/models.mjs
var Models2 = class extends APIResource {
  /**
   * Get a specific model.
   *
   * The Models API response can be used to determine information about a specific
   * model or resolve a model alias to a model ID.
   */
  retrieve(modelID, params = {}, options) {
    const { betas } = params ?? {};
    return this._client.get(path`/v1/models/${modelID}`, {
      ...options,
      headers: buildHeaders([
        { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
        options?.headers
      ])
    });
  }
  /**
   * List available models.
   *
   * The Models API response can be used to determine which models are available for
   * use in the API. More recently released models are listed first.
   */
  list(params = {}, options) {
    const { betas, ...query } = params ?? {};
    return this._client.getAPIList("/v1/models", Page, {
      query,
      ...options,
      headers: buildHeaders([
        { ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
        options?.headers
      ])
    });
  }
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/internal/utils/env.mjs
var readEnv = (env) => {
  if (typeof globalThis.process !== "undefined") {
    return globalThis.process.env?.[env]?.trim() || void 0;
  }
  if (typeof globalThis.Deno !== "undefined") {
    return globalThis.Deno.env?.get?.(env)?.trim() || void 0;
  }
  return void 0;
};

// node_modules/.pnpm/@anthropic-ai+sdk@0.90.0/node_modules/@anthropic-ai/sdk/client.mjs
var _BaseAnthropic_instances;
var _a;
var _BaseAnthropic_encoder;
var _BaseAnthropic_baseURLOverridden;
var HUMAN_PROMPT = "\\n\\nHuman:";
var AI_PROMPT = "\\n\\nAssistant:";
var BaseAnthropic = class {
  /**
   * API Client for interfacing with the Anthropic API.
   *
   * @param {string | null | undefined} [opts.apiKey=process.env['ANTHROPIC_API_KEY'] ?? null]
   * @param {string | null | undefined} [opts.authToken=process.env['ANTHROPIC_AUTH_TOKEN'] ?? null]
   * @param {string} [opts.baseURL=process.env['ANTHROPIC_BASE_URL'] ?? https://api.anthropic.com] - Override the default base URL for the API.
   * @param {number} [opts.timeout=10 minutes] - The maximum amount of time (in milliseconds) the client will wait for a response before timing out.
   * @param {MergedRequestInit} [opts.fetchOptions] - Additional `RequestInit` options to be passed to `fetch` calls.
   * @param {Fetch} [opts.fetch] - Specify a custom `fetch` function implementation.
   * @param {number} [opts.maxRetries=2] - The maximum number of times the client will retry a request.
   * @param {HeadersLike} opts.defaultHeaders - Default headers to include with every request to the API.
   * @param {Record<string, string | undefined>} opts.defaultQuery - Default query parameters to include with every request to the API.
   * @param {boolean} [opts.dangerouslyAllowBrowser=false] - By default, client-side use of this library is not allowed, as it risks exposing your secret API credentials to attackers.
   */
  constructor({ baseURL = readEnv("ANTHROPIC_BASE_URL"), apiKey = readEnv("ANTHROPIC_API_KEY") ?? null, authToken = readEnv("ANTHROPIC_AUTH_TOKEN") ?? null, ...opts } = {}) {
    _BaseAnthropic_instances.add(this);
    _BaseAnthropic_encoder.set(this, void 0);
    const options = {
      apiKey,
      authToken,
      ...opts,
      baseURL: baseURL || `https://api.anthropic.com`
    };
    if (!options.dangerouslyAllowBrowser && isRunningInBrowser()) {
      throw new AnthropicError("It looks like you're running in a browser-like environment.\n\nThis is disabled by default, as it risks exposing your secret API credentials to attackers.\nIf you understand the risks and have appropriate mitigations in place,\nyou can set the `dangerouslyAllowBrowser` option to `true`, e.g.,\n\nnew Anthropic({ apiKey, dangerouslyAllowBrowser: true });\n");
    }
    this.baseURL = options.baseURL;
    this.timeout = options.timeout ?? _a.DEFAULT_TIMEOUT;
    this.logger = options.logger ?? console;
    const defaultLogLevel = "warn";
    this.logLevel = defaultLogLevel;
    this.logLevel = parseLogLevel(options.logLevel, "ClientOptions.logLevel", this) ?? parseLogLevel(readEnv("ANTHROPIC_LOG"), "process.env['ANTHROPIC_LOG']", this) ?? defaultLogLevel;
    this.fetchOptions = options.fetchOptions;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetch = options.fetch ?? getDefaultFetch();
    __classPrivateFieldSet(this, _BaseAnthropic_encoder, FallbackEncoder, "f");
    this._options = options;
    this.apiKey = typeof apiKey === "string" ? apiKey : null;
    this.authToken = authToken;
  }
  /**
   * Create a new client instance re-using the same options given to the current client with optional overriding.
   */
  withOptions(options) {
    const client = new this.constructor({
      ...this._options,
      baseURL: this.baseURL,
      maxRetries: this.maxRetries,
      timeout: this.timeout,
      logger: this.logger,
      logLevel: this.logLevel,
      fetch: this.fetch,
      fetchOptions: this.fetchOptions,
      apiKey: this.apiKey,
      authToken: this.authToken,
      ...options
    });
    return client;
  }
  defaultQuery() {
    return this._options.defaultQuery;
  }
  validateHeaders({ values, nulls }) {
    if (values.get("x-api-key") || values.get("authorization")) {
      return;
    }
    if (this.apiKey && values.get("x-api-key")) {
      return;
    }
    if (nulls.has("x-api-key")) {
      return;
    }
    if (this.authToken && values.get("authorization")) {
      return;
    }
    if (nulls.has("authorization")) {
      return;
    }
    throw new Error('Could not resolve authentication method. Expected either apiKey or authToken to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted');
  }
  async authHeaders(opts) {
    return buildHeaders([await this.apiKeyAuth(opts), await this.bearerAuth(opts)]);
  }
  async apiKeyAuth(opts) {
    if (this.apiKey == null) {
      return void 0;
    }
    return buildHeaders([{ "X-Api-Key": this.apiKey }]);
  }
  async bearerAuth(opts) {
    if (this.authToken == null) {
      return void 0;
    }
    return buildHeaders([{ Authorization: `Bearer ${this.authToken}` }]);
  }
  /**
   * Basic re-implementation of `qs.stringify` for primitive types.
   */
  stringifyQuery(query) {
    return stringifyQuery(query);
  }
  getUserAgent() {
    return `${this.constructor.name}/JS ${VERSION}`;
  }
  defaultIdempotencyKey() {
    return `stainless-node-retry-${uuid4()}`;
  }
  makeStatusError(status, error, message, headers) {
    return APIError.generate(status, error, message, headers);
  }
  buildURL(path2, query, defaultBaseURL) {
    const baseURL = !__classPrivateFieldGet(this, _BaseAnthropic_instances, "m", _BaseAnthropic_baseURLOverridden).call(this) && defaultBaseURL || this.baseURL;
    const url = isAbsoluteURL(path2) ? new URL(path2) : new URL(baseURL + (baseURL.endsWith("/") && path2.startsWith("/") ? path2.slice(1) : path2));
    const defaultQuery = this.defaultQuery();
    const pathQuery = Object.fromEntries(url.searchParams);
    if (!isEmptyObj(defaultQuery) || !isEmptyObj(pathQuery)) {
      query = { ...pathQuery, ...defaultQuery, ...query };
    }
    if (typeof query === "object" && query && !Array.isArray(query)) {
      url.search = this.stringifyQuery(query);
    }
    return url.toString();
  }
  _calculateNonstreamingTimeout(maxTokens) {
    const defaultTimeout = 10 * 60;
    const expectedTimeout = 60 * 60 * maxTokens / 128e3;
    if (expectedTimeout > defaultTimeout) {
      throw new AnthropicError("Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#streaming-responses for more details");
    }
    return defaultTimeout * 1e3;
  }
  /**
   * Used as a callback for mutating the given `FinalRequestOptions` object.
   */
  async prepareOptions(options) {
  }
  /**
   * Used as a callback for mutating the given `RequestInit` object.
   *
   * This is useful for cases where you want to add certain headers based off of
   * the request properties, e.g. `method` or `url`.
   */
  async prepareRequest(request, { url, options }) {
  }
  get(path2, opts) {
    return this.methodRequest("get", path2, opts);
  }
  post(path2, opts) {
    return this.methodRequest("post", path2, opts);
  }
  patch(path2, opts) {
    return this.methodRequest("patch", path2, opts);
  }
  put(path2, opts) {
    return this.methodRequest("put", path2, opts);
  }
  delete(path2, opts) {
    return this.methodRequest("delete", path2, opts);
  }
  methodRequest(method, path2, opts) {
    return this.request(Promise.resolve(opts).then((opts2) => {
      return { method, path: path2, ...opts2 };
    }));
  }
  request(options, remainingRetries = null) {
    return new APIPromise(this, this.makeRequest(options, remainingRetries, void 0));
  }
  async makeRequest(optionsInput, retriesRemaining, retryOfRequestLogID) {
    const options = await optionsInput;
    const maxRetries = options.maxRetries ?? this.maxRetries;
    if (retriesRemaining == null) {
      retriesRemaining = maxRetries;
    }
    await this.prepareOptions(options);
    const { req, url, timeout } = await this.buildRequest(options, {
      retryCount: maxRetries - retriesRemaining
    });
    await this.prepareRequest(req, { url, options });
    const requestLogID = "log_" + (Math.random() * (1 << 24) | 0).toString(16).padStart(6, "0");
    const retryLogStr = retryOfRequestLogID === void 0 ? "" : `, retryOf: ${retryOfRequestLogID}`;
    const startTime = Date.now();
    loggerFor(this).debug(`[${requestLogID}] sending request`, formatRequestDetails({
      retryOfRequestLogID,
      method: options.method,
      url,
      options,
      headers: req.headers
    }));
    if (options.signal?.aborted) {
      throw new APIUserAbortError();
    }
    const controller = new AbortController();
    const response = await this.fetchWithTimeout(url, req, timeout, controller).catch(castToError);
    const headersTime = Date.now();
    if (response instanceof globalThis.Error) {
      const retryMessage = `retrying, ${retriesRemaining} attempts remaining`;
      if (options.signal?.aborted) {
        throw new APIUserAbortError();
      }
      const isTimeout = isAbortError(response) || /timed? ?out/i.test(String(response) + ("cause" in response ? String(response.cause) : ""));
      if (retriesRemaining) {
        loggerFor(this).info(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} - ${retryMessage}`);
        loggerFor(this).debug(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} (${retryMessage})`, formatRequestDetails({
          retryOfRequestLogID,
          url,
          durationMs: headersTime - startTime,
          message: response.message
        }));
        return this.retryRequest(options, retriesRemaining, retryOfRequestLogID ?? requestLogID);
      }
      loggerFor(this).info(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} - error; no more retries left`);
      loggerFor(this).debug(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} (error; no more retries left)`, formatRequestDetails({
        retryOfRequestLogID,
        url,
        durationMs: headersTime - startTime,
        message: response.message
      }));
      if (isTimeout) {
        throw new APIConnectionTimeoutError();
      }
      throw new APIConnectionError({ cause: response });
    }
    const specialHeaders = [...response.headers.entries()].filter(([name]) => name === "request-id").map(([name, value]) => ", " + name + ": " + JSON.stringify(value)).join("");
    const responseInfo = `[${requestLogID}${retryLogStr}${specialHeaders}] ${req.method} ${url} ${response.ok ? "succeeded" : "failed"} with status ${response.status} in ${headersTime - startTime}ms`;
    if (!response.ok) {
      const shouldRetry = await this.shouldRetry(response);
      if (retriesRemaining && shouldRetry) {
        const retryMessage2 = `retrying, ${retriesRemaining} attempts remaining`;
        await CancelReadableStream(response.body);
        loggerFor(this).info(`${responseInfo} - ${retryMessage2}`);
        loggerFor(this).debug(`[${requestLogID}] response error (${retryMessage2})`, formatRequestDetails({
          retryOfRequestLogID,
          url: response.url,
          status: response.status,
          headers: response.headers,
          durationMs: headersTime - startTime
        }));
        return this.retryRequest(options, retriesRemaining, retryOfRequestLogID ?? requestLogID, response.headers);
      }
      const retryMessage = shouldRetry ? `error; no more retries left` : `error; not retryable`;
      loggerFor(this).info(`${responseInfo} - ${retryMessage}`);
      const errText = await response.text().catch((err2) => castToError(err2).message);
      const errJSON = safeJSON(errText);
      const errMessage = errJSON ? void 0 : errText;
      loggerFor(this).debug(`[${requestLogID}] response error (${retryMessage})`, formatRequestDetails({
        retryOfRequestLogID,
        url: response.url,
        status: response.status,
        headers: response.headers,
        message: errMessage,
        durationMs: Date.now() - startTime
      }));
      const err = this.makeStatusError(response.status, errJSON, errMessage, response.headers);
      throw err;
    }
    loggerFor(this).info(responseInfo);
    loggerFor(this).debug(`[${requestLogID}] response start`, formatRequestDetails({
      retryOfRequestLogID,
      url: response.url,
      status: response.status,
      headers: response.headers,
      durationMs: headersTime - startTime
    }));
    return { response, options, controller, requestLogID, retryOfRequestLogID, startTime };
  }
  getAPIList(path2, Page2, opts) {
    return this.requestAPIList(Page2, opts && "then" in opts ? opts.then((opts2) => ({ method: "get", path: path2, ...opts2 })) : { method: "get", path: path2, ...opts });
  }
  requestAPIList(Page2, options) {
    const request = this.makeRequest(options, null, void 0);
    return new PagePromise(this, request, Page2);
  }
  async fetchWithTimeout(url, init, ms, controller) {
    const { signal, method, ...options } = init || {};
    const abort = this._makeAbort(controller);
    if (signal)
      signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, ms);
    const isReadableBody = globalThis.ReadableStream && options.body instanceof globalThis.ReadableStream || typeof options.body === "object" && options.body !== null && Symbol.asyncIterator in options.body;
    const fetchOptions = {
      signal: controller.signal,
      ...isReadableBody ? { duplex: "half" } : {},
      method: "GET",
      ...options
    };
    if (method) {
      fetchOptions.method = method.toUpperCase();
    }
    try {
      return await this.fetch.call(void 0, url, fetchOptions);
    } finally {
      clearTimeout(timeout);
    }
  }
  async shouldRetry(response) {
    const shouldRetryHeader = response.headers.get("x-should-retry");
    if (shouldRetryHeader === "true")
      return true;
    if (shouldRetryHeader === "false")
      return false;
    if (response.status === 408)
      return true;
    if (response.status === 409)
      return true;
    if (response.status === 429)
      return true;
    if (response.status >= 500)
      return true;
    return false;
  }
  async retryRequest(options, retriesRemaining, requestLogID, responseHeaders) {
    let timeoutMillis;
    const retryAfterMillisHeader = responseHeaders?.get("retry-after-ms");
    if (retryAfterMillisHeader) {
      const timeoutMs = parseFloat(retryAfterMillisHeader);
      if (!Number.isNaN(timeoutMs)) {
        timeoutMillis = timeoutMs;
      }
    }
    const retryAfterHeader = responseHeaders?.get("retry-after");
    if (retryAfterHeader && !timeoutMillis) {
      const timeoutSeconds = parseFloat(retryAfterHeader);
      if (!Number.isNaN(timeoutSeconds)) {
        timeoutMillis = timeoutSeconds * 1e3;
      } else {
        timeoutMillis = Date.parse(retryAfterHeader) - Date.now();
      }
    }
    if (timeoutMillis === void 0) {
      const maxRetries = options.maxRetries ?? this.maxRetries;
      timeoutMillis = this.calculateDefaultRetryTimeoutMillis(retriesRemaining, maxRetries);
    }
    await sleep(timeoutMillis);
    return this.makeRequest(options, retriesRemaining - 1, requestLogID);
  }
  calculateDefaultRetryTimeoutMillis(retriesRemaining, maxRetries) {
    const initialRetryDelay = 0.5;
    const maxRetryDelay = 8;
    const numRetries = maxRetries - retriesRemaining;
    const sleepSeconds = Math.min(initialRetryDelay * Math.pow(2, numRetries), maxRetryDelay);
    const jitter = 1 - Math.random() * 0.25;
    return sleepSeconds * jitter * 1e3;
  }
  calculateNonstreamingTimeout(maxTokens, maxNonstreamingTokens) {
    const maxTime = 60 * 60 * 1e3;
    const defaultTime = 60 * 10 * 1e3;
    const expectedTime = maxTime * maxTokens / 128e3;
    if (expectedTime > defaultTime || maxNonstreamingTokens != null && maxTokens > maxNonstreamingTokens) {
      throw new AnthropicError("Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#long-requests for more details");
    }
    return defaultTime;
  }
  async buildRequest(inputOptions, { retryCount = 0 } = {}) {
    const options = { ...inputOptions };
    const { method, path: path2, query, defaultBaseURL } = options;
    const url = this.buildURL(path2, query, defaultBaseURL);
    if ("timeout" in options)
      validatePositiveInteger("timeout", options.timeout);
    options.timeout = options.timeout ?? this.timeout;
    const { bodyHeaders, body } = this.buildBody({ options });
    const reqHeaders = await this.buildHeaders({ options: inputOptions, method, bodyHeaders, retryCount });
    const req = {
      method,
      headers: reqHeaders,
      ...options.signal && { signal: options.signal },
      ...globalThis.ReadableStream && body instanceof globalThis.ReadableStream && { duplex: "half" },
      ...body && { body },
      ...this.fetchOptions ?? {},
      ...options.fetchOptions ?? {}
    };
    return { req, url, timeout: options.timeout };
  }
  async buildHeaders({ options, method, bodyHeaders, retryCount }) {
    let idempotencyHeaders = {};
    if (this.idempotencyHeader && method !== "get") {
      if (!options.idempotencyKey)
        options.idempotencyKey = this.defaultIdempotencyKey();
      idempotencyHeaders[this.idempotencyHeader] = options.idempotencyKey;
    }
    const headers = buildHeaders([
      idempotencyHeaders,
      {
        Accept: "application/json",
        "User-Agent": this.getUserAgent(),
        "X-Stainless-Retry-Count": String(retryCount),
        ...options.timeout ? { "X-Stainless-Timeout": String(Math.trunc(options.timeout / 1e3)) } : {},
        ...getPlatformHeaders(),
        ...this._options.dangerouslyAllowBrowser ? { "anthropic-dangerous-direct-browser-access": "true" } : void 0,
        "anthropic-version": "2023-06-01"
      },
      await this.authHeaders(options),
      this._options.defaultHeaders,
      bodyHeaders,
      options.headers
    ]);
    this.validateHeaders(headers);
    return headers.values;
  }
  _makeAbort(controller) {
    return () => controller.abort();
  }
  buildBody({ options: { body, headers: rawHeaders } }) {
    if (!body) {
      return { bodyHeaders: void 0, body: void 0 };
    }
    const headers = buildHeaders([rawHeaders]);
    if (
      // Pass raw type verbatim
      ArrayBuffer.isView(body) || body instanceof ArrayBuffer || body instanceof DataView || typeof body === "string" && // Preserve legacy string encoding behavior for now
      headers.values.has("content-type") || // `Blob` is superset of `File`
      globalThis.Blob && body instanceof globalThis.Blob || // `FormData` -> `multipart/form-data`
      body instanceof FormData || // `URLSearchParams` -> `application/x-www-form-urlencoded`
      body instanceof URLSearchParams || // Send chunked stream (each chunk has own `length`)
      globalThis.ReadableStream && body instanceof globalThis.ReadableStream
    ) {
      return { bodyHeaders: void 0, body };
    } else if (typeof body === "object" && (Symbol.asyncIterator in body || Symbol.iterator in body && "next" in body && typeof body.next === "function")) {
      return { bodyHeaders: void 0, body: ReadableStreamFrom(body) };
    } else if (typeof body === "object" && headers.values.get("content-type") === "application/x-www-form-urlencoded") {
      return {
        bodyHeaders: { "content-type": "application/x-www-form-urlencoded" },
        body: this.stringifyQuery(body)
      };
    } else {
      return __classPrivateFieldGet(this, _BaseAnthropic_encoder, "f").call(this, { body, headers });
    }
  }
};
_a = BaseAnthropic, _BaseAnthropic_encoder = /* @__PURE__ */ new WeakMap(), _BaseAnthropic_instances = /* @__PURE__ */ new WeakSet(), _BaseAnthropic_baseURLOverridden = function _BaseAnthropic_baseURLOverridden2() {
  return this.baseURL !== "https://api.anthropic.com";
};
BaseAnthropic.Anthropic = _a;
BaseAnthropic.HUMAN_PROMPT = HUMAN_PROMPT;
BaseAnthropic.AI_PROMPT = AI_PROMPT;
BaseAnthropic.DEFAULT_TIMEOUT = 6e5;
BaseAnthropic.AnthropicError = AnthropicError;
BaseAnthropic.APIError = APIError;
BaseAnthropic.APIConnectionError = APIConnectionError;
BaseAnthropic.APIConnectionTimeoutError = APIConnectionTimeoutError;
BaseAnthropic.APIUserAbortError = APIUserAbortError;
BaseAnthropic.NotFoundError = NotFoundError;
BaseAnthropic.ConflictError = ConflictError;
BaseAnthropic.RateLimitError = RateLimitError;
BaseAnthropic.BadRequestError = BadRequestError;
BaseAnthropic.AuthenticationError = AuthenticationError;
BaseAnthropic.InternalServerError = InternalServerError;
BaseAnthropic.PermissionDeniedError = PermissionDeniedError;
BaseAnthropic.UnprocessableEntityError = UnprocessableEntityError;
BaseAnthropic.toFile = toFile;
var Anthropic = class extends BaseAnthropic {
  constructor() {
    super(...arguments);
    this.completions = new Completions(this);
    this.messages = new Messages2(this);
    this.models = new Models2(this);
    this.beta = new Beta(this);
  }
};
Anthropic.Completions = Completions;
Anthropic.Messages = Messages2;
Anthropic.Models = Models2;
Anthropic.Beta = Beta;

// src/anthropic.ts
import { execFileSync } from "child_process";
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { homedir as homedir2, platform } from "os";
import { join as join3 } from "path";
var OAUTH_BETAS_WITH_CLAUDE_CODE = "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14";
var OAUTH_USER_AGENT = "claude-cli/2.1.2 (external, cli)";
var CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
var KEYCHAIN_SERVICE_NAMES = [
  "Claude Code-credentials",
  "Claude Code - credentials",
  "Claude Code"
];
function createOAuthFetch() {
  return async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) url.searchParams.set("beta", "true");
    return globalThis.fetch(url.toString(), init);
  };
}
function loadKeychainCredentials() {
  for (const service of KEYCHAIN_SERVICE_NAMES) {
    try {
      const stdout = execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
        encoding: "utf-8",
        timeout: 5e3,
        stdio: ["pipe", "pipe", "pipe"]
      });
      const data = JSON.parse(stdout.trim());
      if (!data || typeof data !== "object" || Array.isArray(data)) continue;
      const oauth = data.claudeAiOauth;
      if (oauth?.apiKey || oauth?.accessToken) return oauth;
    } catch {
      continue;
    }
  }
  return null;
}
function loadFileCredentials() {
  const path2 = join3(homedir2(), ".claude", ".credentials.json");
  if (!existsSync2(path2)) return null;
  try {
    const data = JSON.parse(readFileSync2(path2, "utf-8"));
    const oauth = data.claudeAiOauth;
    if (oauth?.apiKey || oauth?.accessToken) return oauth;
  } catch {
  }
  return null;
}
function loadCredentials() {
  if (platform() === "darwin") {
    const keychain = loadKeychainCredentials();
    if (keychain) return keychain;
  }
  return loadFileCredentials();
}
async function createAnthropicClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  if (apiKey) {
    return new Anthropic({ apiKey, ...baseURL ? { baseURL } : {} });
  }
  if (authToken) {
    return new Anthropic({
      authToken,
      defaultHeaders: { "anthropic-beta": OAUTH_BETAS_WITH_CLAUDE_CODE, "user-agent": OAUTH_USER_AGENT },
      fetch: createOAuthFetch(),
      ...baseURL ? { baseURL } : {}
    });
  }
  const creds = loadCredentials();
  if (!creds) return null;
  if (creds.apiKey) {
    return new Anthropic({ apiKey: creds.apiKey, ...baseURL ? { baseURL } : {} });
  }
  if (!creds.accessToken || creds.expiresAt !== void 0 && creds.expiresAt <= Date.now()) return null;
  return new Anthropic({
    authToken: creds.accessToken,
    defaultHeaders: { "anthropic-beta": OAUTH_BETAS_WITH_CLAUDE_CODE, "user-agent": OAUTH_USER_AGENT },
    fetch: createOAuthFetch(),
    ...baseURL ? { baseURL } : {}
  });
}

// src/mask.ts
var STUB_PREFIX = "[strata elided";
function messageChars(m) {
  let n = m.text.length;
  for (const u of m.toolUses) n += u.tool.length + JSON.stringify(u.input).length;
  for (const r of m.toolResults ?? []) n += r.text.length;
  return n;
}
function cut(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}\u2026[+${text.length - max} chars]`;
}
function cutWithSeq(text, max, seq) {
  if (text.length <= max) return text;
  if (max < 80) return cut(text, max);
  const head = Math.floor(max * 0.65);
  const tail = max - head;
  const omitted = text.length - head - tail;
  const note = `
\u2026[strata omitted ${omitted.toLocaleString("en-US")} chars; full text is archive seq ${seq}]\u2026
`;
  const shortened = `${text.slice(0, head)}${note}${tail > 0 ? text.slice(-tail) : ""}`;
  return shortened.length < text.length ? shortened : text;
}
function capInput(value, max) {
  if (typeof value === "string") return cut(value, max);
  if (Array.isArray(value)) return value.map((v) => capInput(v, max));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capInput(v, max)]));
  }
  return value;
}
function stub(chars, seq) {
  return `${STUB_PREFIX} a ${chars.toLocaleString("en-US")}-char tool result; full text is archive seq ${seq}]`;
}
function maskResultText(text, isError, seq, config) {
  const keep = isError ? config.errorResultChars : config.smallResultChars;
  if (text.length <= keep) return text;
  const header = stub(text.length, seq);
  if (keep <= 0) return header;
  const head = isError ? Math.floor(keep * 0.5) : Math.floor(keep * 0.6);
  const tail = keep - head;
  const excerpt = `${header}
${text.slice(0, head)}
\u2026
${tail > 0 ? text.slice(-tail) : ""}`;
  return excerpt.length < text.length ? excerpt : text;
}
function maskMessage(m, seq, config) {
  if (m.role === "user") {
    return {
      role: "user",
      text: cutWithSeq(m.text, config.userTextCapChars, seq),
      toolUses: [],
      ...m.toolResults ? {
        toolResults: m.toolResults.map((r) => ({
          ...r,
          text: maskResultText(r.text, r.isError, seq, config)
        }))
      } : {}
    };
  }
  return {
    role: "assistant",
    text: cutWithSeq(m.text, config.assistantTextCapChars, seq),
    toolUses: m.toolUses.map((u) => ({
      tool_use_id: u.tool_use_id,
      tool: u.tool,
      input: capInput(u.input, config.inputCapChars)
    }))
  };
}
function renderMessage(m, seq) {
  const lines = [];
  if (m.text) lines.push(`#${seq} ${m.role}: ${m.text}`);
  for (const u of m.toolUses) lines.push(`#${seq} call ${u.tool} ${JSON.stringify(u.input)}`);
  for (const r of m.toolResults ?? []) lines.push(`#${seq} result${r.isError ? " (error)" : ""}: ${r.text}`);
  return lines.join("\n");
}

// src/ledger.ts
var LEDGER_SYSTEM_PROMPT = `You maintain the state ledger of a long Claude Code session whose older turns are being moved out of the live context into an archive.

The ledger is a STATE document, not a history. Rewrite it so it reflects the session as of the newest history you are given. Use exactly these sections:

## Goal
## Constraints and preferences   (what the user asked for or ruled out, in their terms)
## Decisions                     (what was chosen and WHY; mark replaced ones "SUPERSEDED by #seq")
## Dead ends                     (approaches tried that failed, and the failure signal)
## Current state                 (what exists now: files, branches, services, test status)
## Open items

Rules:
- Every bullet cites the archive seq numbers it rests on, like (#412) or (#400-415).
- Keep facts exact: names, paths, commands, error strings, numbers. Never round or paraphrase them.
- Do not invent anything the history does not show. If something is unclear, say so.
- Drop bullets that are no longer true, but keep decisions and dead ends: those prevent repeated mistakes.
- Output only the ledger markdown, nothing else.`;
var STANDALONE_MODEL_ALIASES = {
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
  opus: "claude-opus-4-6"
};
function resolveStandaloneModel(model) {
  return STANDALONE_MODEL_ALIASES[model.trim().toLowerCase()] ?? model;
}
function ledgerMaskConfig(config) {
  return {
    ...config,
    inputCapChars: Math.max(config.inputCapChars, 1500),
    smallResultChars: Math.max(config.smallResultChars, 2e3),
    errorResultChars: Math.max(config.errorResultChars, 6e3),
    userTextCapChars: Math.max(config.userTextCapChars, 12e3),
    assistantTextCapChars: Math.max(config.assistantTextCapChars, 8e3)
  };
}
function renderSpan(messages, config) {
  const maskCfg = ledgerMaskConfig(config);
  const chunks = [];
  let current = "";
  for (const m of messages) {
    const line = renderMessage(maskMessage(m, m.seq, maskCfg), m.seq);
    if (!line) continue;
    if (current && current.length + line.length > config.ledgerChunkChars) {
      chunks.push(current);
      current = "";
    }
    current += `${line}
`;
  }
  if (current) chunks.push(current);
  return chunks;
}
function buildLedgerPrompt(previous, chunk, maxChars, focus) {
  return [
    `Current ledger:
${previous || "(empty: this is the first eviction)"}`,
    focus ? `The user asked this compaction to keep or stress: ${focus}` : "",
    `Newly archived history (#seq prefixes are archive seq numbers; "[strata elided \u2026]" marks results kept only in the archive):
${chunk}`,
    `Write the updated ledger. Stay under ${maxChars.toLocaleString("en-US")} characters.`
  ].filter(Boolean).join("\n\n");
}
function ledgerMaxTokens(maxChars) {
  return Math.max(2e3, estimateTokens(maxChars) * 2);
}
function sectionMeta(heading) {
  const lower = heading.toLowerCase();
  if (lower.includes("current state")) return { priority: 6, keepNewest: true };
  if (lower.includes("open item")) return { priority: 5, keepNewest: true };
  if (lower.includes("goal")) return { priority: 4, keepNewest: false };
  if (lower.includes("constraint") || lower.includes("preference")) return { priority: 3, keepNewest: false };
  if (lower.includes("decision")) return { priority: 2, keepNewest: true };
  if (lower.includes("dead end")) return { priority: 1, keepNewest: true };
  return { priority: 0, keepNewest: true };
}
function renderSections(preamble, sections) {
  const blocks = [];
  if (preamble) blocks.push(preamble);
  for (const s of sections) {
    const body = [];
    if (s.trimmed && s.keepNewest) body.push("\u2026[older items trimmed]");
    body.push(...s.lines);
    if (s.trimmed && !s.keepNewest) body.push("\u2026[trimmed]");
    blocks.push(body.length ? `${s.heading}
${body.join("\n")}` : s.heading);
  }
  return blocks.join("\n\n");
}
function trimLedger(ledger, maxChars, note = "\n\u2026[ledger cut to its budget]") {
  if (maxChars <= 0) return "";
  if (ledger.length <= maxChars) return ledger;
  const rawLines = ledger.split("\n");
  const preambleLines = [];
  const sections = [];
  for (const line of rawLines) {
    if (line.startsWith("## ")) {
      const meta = sectionMeta(line);
      sections.push({ heading: line, ...meta, lines: [], trimmed: false });
    } else if (sections.length === 0) {
      preambleLines.push(line);
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }
  for (const s of sections) {
    while (s.lines.length && !s.lines[0].trim()) s.lines.shift();
    while (s.lines.length && !s.lines[s.lines.length - 1].trim()) s.lines.pop();
  }
  if (sections.length === 0) {
    if (maxChars <= note.length) return ledger.slice(0, maxChars);
    return `${ledger.slice(0, maxChars - note.length).trimEnd()}${note}`;
  }
  let preamble = preambleLines.join("\n").trim();
  let current = renderSections(preamble, sections);
  if (current.length > maxChars && preamble) {
    preamble = "";
    current = renderSections(preamble, sections);
  }
  while (current.length > maxChars && sections.length > 0) {
    const prevLen = current.length;
    const ordered = [...sections].sort((a, b) => a.priority - b.priority);
    const withLines = ordered.find((s) => s.lines.length > 0);
    if (withLines) {
      if (withLines.lines.length > 1) {
        if (withLines.keepNewest) withLines.lines.shift();
        else withLines.lines.pop();
        withLines.trimmed = true;
      } else {
        const overflow = current.length - maxChars;
        const line = withLines.lines[0];
        const target = line.length - overflow - 16;
        if (target >= 40) {
          withLines.lines[0] = `${line.slice(0, target)}\u2026`;
          withLines.trimmed = true;
        } else {
          withLines.lines.length = 0;
          withLines.trimmed = true;
        }
      }
    } else {
      const victim = ordered[0];
      const idx = sections.indexOf(victim);
      if (idx >= 0) sections.splice(idx, 1);
    }
    current = renderSections(preamble, sections);
    if (current.length >= prevLen) {
      const victim = [...sections].sort((a, b) => a.priority - b.priority)[0];
      if (!victim) break;
      sections.splice(sections.indexOf(victim), 1);
      current = renderSections(preamble, sections);
    }
  }
  if (current.length <= maxChars) return current;
  if (maxChars <= note.length) return current.slice(0, maxChars);
  return `${current.slice(0, maxChars - note.length).trimEnd()}${note}`;
}
function ledgerRequests(span, config) {
  return renderSpan(span, config).length;
}
async function updateLedger(previous, span, config, focus) {
  const chunks = renderSpan(span, config);
  if (chunks.length === 0) return { ledger: previous, requests: 0 };
  const client = await createAnthropicClient();
  if (!client) throw new Error("No authentication available for the ledger model");
  const maxChars = shareChars(config, "ledger");
  let ledger = previous;
  for (const chunk of chunks) {
    const response = await client.messages.create({
      model: resolveStandaloneModel(config.ledgerModel),
      max_tokens: ledgerMaxTokens(maxChars),
      system: [
        { type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT },
        { type: "text", text: LEDGER_SYSTEM_PROMPT }
      ],
      messages: [
        {
          role: "user",
          content: buildLedgerPrompt(ledger, chunk, maxChars, focus)
        }
      ]
    });
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    if (!text) throw new Error(`ledger model returned no text (stop_reason ${response.stop_reason})`);
    ledger = trimLedger(text, maxChars);
  }
  return { ledger, requests: chunks.length };
}

// src/ready.ts
import { createHash as createHash2 } from "crypto";
import { closeSync, existsSync as existsSync3, mkdirSync as mkdirSync2, openSync, readFileSync as readFileSync3, renameSync as renameSync2, rmSync as rmSync2, statSync, writeFileSync as writeFileSync2, writeSync } from "fs";
import { join as join4 } from "path";
var READY_FILE = "ready-ledger.json";
var LOCK_FILE = "prepare.lock";
var STALE_LOCK_MS = 15 * 60 * 1e3;
function prefixHash(rows, through) {
  const hash = createHash2("sha256");
  for (const m of rows.slice(0, through)) hash.update(`${m.seq}:${fingerprint(m)}`);
  return hash.digest("base64url");
}
function readReady(dir) {
  const path2 = join4(dir, READY_FILE);
  if (!existsSync3(path2)) return void 0;
  try {
    const parsed = JSON.parse(readFileSync3(path2, "utf-8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.ledger !== "string" || typeof parsed.through !== "number" || typeof parsed.prefixHash !== "string" || typeof parsed.age !== "number") {
      return void 0;
    }
    return parsed;
  } catch {
    return void 0;
  }
}
function writeReady(dir, ready) {
  mkdirSync2(dir, { recursive: true });
  const path2 = join4(dir, READY_FILE);
  const tmp = `${path2}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync2(tmp, JSON.stringify(ready));
    renameSync2(tmp, path2);
  } catch (error) {
    rmSync2(tmp, { force: true });
    throw error;
  }
}
function compatibleReady(dir, rows) {
  const ready = readReady(dir);
  if (!ready || ready.through > rows.length) return void 0;
  return prefixHash(rows, ready.through) === ready.prefixHash ? ready : void 0;
}
function createExclusiveLock(path2, token) {
  let fd;
  try {
    fd = openSync(path2, "wx");
  } catch (error) {
    const code = error.code;
    if (code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  return true;
}
function makeRelease(path2, token) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync3(path2, "utf-8") === token) rmSync2(path2, { force: true });
    } catch {
    }
  };
}
function tryLock(dir, lockFile = LOCK_FILE, staleMs = STALE_LOCK_MS) {
  mkdirSync2(dir, { recursive: true });
  const path2 = join4(dir, lockFile);
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  if (createExclusiveLock(path2, token)) return makeRelease(path2, token);
  let mtimeMs;
  let ownerToken;
  try {
    mtimeMs = statSync(path2).mtimeMs;
    ownerToken = readFileSync3(path2, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return createExclusiveLock(path2, token) ? makeRelease(path2, token) : void 0;
    }
    return void 0;
  }
  if (Date.now() - mtimeMs <= staleMs) return void 0;
  try {
    if (readFileSync3(path2, "utf-8") === ownerToken && statSync(path2).mtimeMs === mtimeMs) {
      rmSync2(path2, { force: true });
    }
  } catch {
  }
  return createExclusiveLock(path2, token) ? makeRelease(path2, token) : void 0;
}
async function acquireLock(dir, lockFile, options = {}) {
  const waitMs = options.waitMs ?? 5e3;
  const pollMs = options.pollMs ?? 25;
  const staleMs = options.staleMs ?? 5 * 60 * 1e3;
  const deadline = Date.now() + waitMs;
  while (true) {
    const release = tryLock(dir, lockFile, staleMs);
    if (release) return release;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${lockFile}`);
    await new Promise((resolve2) => setTimeout(resolve2, pollMs));
  }
}

// src/units.ts
var NON_TEXT_PLACEHOLDER = (seq) => `[strata: a message with non-text content (image or document) was here, seq ${seq}; only its text is archived]`;
function mediaNote(paths) {
  return `[strata: ${paths.length === 1 ? "an image was" : `${paths.length} images were`} here, saved as ${paths.join(", ")}; open with Read to view]`;
}
function withMedia(row, viewed) {
  if (!row.media?.length) return viewed;
  const loose = row.media.filter((m) => m.toolUseId === void 0).map((m) => m.path);
  const text = loose.length ? [viewed.text, mediaNote(loose)].filter(Boolean).join("\n") : viewed.text;
  const toolResults = viewed.toolResults?.map((r) => {
    const paths = row.media.filter((m) => m.toolUseId === r.tool_use_id).map((m) => m.path);
    return paths.length ? { ...r, text: `${r.text}
${mediaNote(paths)}` } : r;
  });
  return { ...viewed, text, ...toolResults ? { toolResults } : {} };
}
function isPrompt2(m) {
  return m.role === "user" && !m.toolResults?.length;
}
function segmentUnits(rows, whole = []) {
  const units = [];
  let i = 0;
  while (i < rows.length) {
    if (isPrompt2(rows[i])) {
      units.push({ start: i, end: i + 1, kind: "prompt" });
      i++;
      continue;
    }
    const open = /* @__PURE__ */ new Set();
    let j = i;
    while (j < rows.length) {
      const row = rows[j];
      if (isPrompt2(row)) break;
      const handoff = whole[j] !== whole[j - 1];
      if (j > i && open.size === 0 && (handoff || row.role === "assistant" && rows[j - 1].role === "user")) break;
      for (const u of row.toolUses) open.add(u.tool_use_id);
      for (const r of row.toolResults ?? []) open.delete(r.tool_use_id);
      j++;
    }
    units.push({ start: i, end: j, kind: "exchange" });
    i = j;
  }
  return units;
}
function rebuildUnit(rows, mode, config) {
  const view = (m) => withMedia(m, mode === "masked" ? maskMessage(m, m.seq, config) : m);
  if (rows.length === 1 && isPrompt2(rows[0])) {
    const m = view(rows[0]);
    return [{ role: "user", text: m.text.trim() ? m.text : NON_TEXT_PLACEHOLDER(rows[0].seq), toolUses: [] }];
  }
  const texts = [];
  const uses = [];
  const results = [];
  const userTexts = [];
  for (const row of rows) {
    const m = view(row);
    if (m.role === "assistant") {
      if (m.text.trim()) texts.push(m.text);
      uses.push(...m.toolUses);
    } else {
      if (m.text.trim()) userTexts.push(m.text);
      results.push(...m.toolResults ?? []);
    }
  }
  const answered = new Set(results.map((r) => r.tool_use_id));
  const called = new Set(uses.map((u) => u.tool_use_id));
  const pairedUses = uses.filter((u) => answered.has(u.tool_use_id));
  const pairedResults = results.filter((r) => called.has(r.tool_use_id));
  const out = [];
  if (texts.length || pairedUses.length) out.push({ role: "assistant", text: texts.join("\n"), toolUses: pairedUses });
  if (pairedResults.length || userTexts.length) {
    out.push({ role: "user", text: userTexts.join("\n"), toolUses: [], ...pairedResults.length ? { toolResults: pairedResults } : {} });
  }
  return out;
}
function unitChars(messages) {
  return messages.reduce((n, m) => n + messageChars(m), 0);
}

// src/weights.ts
var DEFAULT_THINKING_CHARS_PER_TOKEN = 4;
var RATIO_BOUNDS = [1.5, 8];
var TEXT_RATIO_BOUNDS = [2, 5];
var UNKNOWN_IMAGE_TOKENS = 1600;
var PIXELS_PER_TOKEN = 750;
var MAX_IMAGE_LONG_EDGE = 1568;
var MAX_IMAGE_TOKENS = 1600;
function imageDimensions(base64) {
  const head = Buffer.from(base64.slice(0, 12e4), "base64");
  if (head.length >= 24 && head.readUInt32BE(0) === 2303741511) return [head.readUInt32BE(16), head.readUInt32BE(20)];
  if (head.length >= 10 && head.toString("ascii", 0, 3) === "GIF") return [head.readUInt16LE(6), head.readUInt16LE(8)];
  if (head.length >= 30 && head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") {
    const kind = head.toString("ascii", 12, 16);
    if (kind === "VP8X") return [1 + head.readUIntLE(24, 3), 1 + head.readUIntLE(27, 3)];
    if (kind === "VP8 ") return [head.readUInt16LE(26) & 16383, head.readUInt16LE(28) & 16383];
    if (kind === "VP8L") {
      const bits = head.readUInt32LE(21);
      return [1 + (bits & 16383), 1 + (bits >> 14 & 16383)];
    }
  }
  if (head.length >= 4 && head[0] === 255 && head[1] === 216) {
    let i = 2;
    while (i < head.length) {
      if (head[i] !== 255) {
        i++;
        continue;
      }
      while (i < head.length && head[i] === 255) i++;
      if (i >= head.length) break;
      const marker = head[i++];
      if (marker === 0 || marker === 1 || marker >= 208 && marker <= 216) continue;
      if (marker === 217 || marker === 218) break;
      if (i + 2 > head.length) break;
      const len = head.readUInt16BE(i);
      if (len < 2) break;
      const isSof = marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204;
      if (isSof) {
        if (i + 7 > head.length) break;
        return [head.readUInt16BE(i + 5), head.readUInt16BE(i + 3)];
      }
      i += len;
    }
  }
  return void 0;
}
function imageTokens(base64) {
  const size = imageDimensions(base64);
  if (!size || size[0] <= 0 || size[1] <= 0) return UNKNOWN_IMAGE_TOKENS;
  const [w, h] = size;
  const edgeScale = Math.min(1, MAX_IMAGE_LONG_EDGE / Math.max(w, h));
  const scaledPixels = w * edgeScale * (h * edgeScale);
  return Math.min(MAX_IMAGE_TOKENS, Math.ceil(scaledPixels / PIXELS_PER_TOKEN));
}
function imageRef(block, toolUseId) {
  const source = block.source;
  if (block.type !== "image" || source?.type !== "base64" || typeof source.data !== "string") return void 0;
  return { ...toolUseId ? { toolUseId } : {}, mediaType: source.media_type ?? "image/png", data: source.data };
}
function thinkingChars(block) {
  if (block.type === "thinking") return String(block.signature ?? "").length + String(block.thinking ?? "").length;
  if (block.type === "redacted_thinking") return String(block.data ?? "").length;
  return 0;
}
function emptyHidden() {
  return { imageTokens: 0, thinkingChars: 0, images: [] };
}
function hasTextBlock(rowText, blockText) {
  const trimmed = rowText.trim();
  if (trimmed === blockText) return true;
  if (!trimmed.includes("\n")) return false;
  let idx = trimmed.indexOf(blockText);
  while (idx !== -1) {
    let start = idx;
    while (start > 0 && trimmed[start - 1] !== "\n" && (trimmed[start - 1] === " " || trimmed[start - 1] === "	" || trimmed[start - 1] === "\r")) start--;
    const startOk = start === 0 || trimmed[start - 1] === "\n";
    let end = idx + blockText.length;
    while (end < trimmed.length && trimmed[end] !== "\n" && (trimmed[end] === " " || trimmed[end] === "	" || trimmed[end] === "\r")) end++;
    const endOk = end === trimmed.length || trimmed[end] === "\n";
    if (startOk && endOk) return true;
    idx = trimmed.indexOf(blockText, idx + 1);
  }
  return false;
}
function isEmptyPrompt(m) {
  return m.role === "user" && !m.toolResults?.length && !m.text.trim();
}
function hiddenByRow(input, api) {
  const hidden = /* @__PURE__ */ new Map();
  const at = (row) => {
    let h = hidden.get(row);
    if (!h) hidden.set(row, h = emptyHidden());
    return h;
  };
  const attachImage = (row, ref) => {
    const h = at(row);
    h.images.push(ref);
    h.imageTokens += imageTokens(ref.data);
  };
  const callRow = /* @__PURE__ */ new Map();
  const resultRow = /* @__PURE__ */ new Map();
  input.forEach((m, i) => {
    for (const u of m.toolUses) callRow.set(u.tool_use_id, i);
    for (const r of m.toolResults ?? []) resultRow.set(r.tool_use_id, i);
  });
  let cursor = 0;
  const findForward = (test, from = cursor) => {
    for (let i = from; i < input.length; i++) if (test(input[i])) return i;
    return void 0;
  };
  const assistantRowWithText = (text) => findForward((m) => m.role === "assistant" && hasTextBlock(m.text, text));
  const promptRowWithText = (text) => findForward((m) => m.role === "user" && !m.toolResults?.length && hasTextBlock(m.text, text));
  for (const message of api) {
    if (message.role === "assistant") {
      let pending = 0;
      let last;
      for (const block of message.content) {
        pending += thinkingChars(block);
        let row;
        let advancePast = false;
        if (block.type === "tool_use") {
          row = callRow.get(String(block.id));
        } else if (block.type === "text" && String(block.text ?? "").trim()) {
          const text = String(block.text).trim();
          row = assistantRowWithText(text);
          if (row !== void 0 && input[row].text.trim() === text) advancePast = true;
        }
        if (row === void 0) continue;
        cursor = Math.max(cursor, advancePast ? row + 1 : row);
        last = row;
        if (pending) at(row).thinkingChars += pending;
        pending = 0;
      }
      if (pending) {
        const row = last ?? findForward((m) => m.role === "assistant");
        if (row !== void 0) at(row).thinkingChars += pending;
      }
      continue;
    }
    let promptAnchor;
    const pendingImages = [];
    for (const block of message.content) {
      if (block.type === "tool_result") {
        const id = String(block.tool_use_id);
        const row = resultRow.get(id);
        if (row === void 0) continue;
        cursor = Math.max(cursor, row);
        const content = Array.isArray(block.content) ? block.content : [];
        for (const inner of content) {
          const ref = imageRef(inner, id);
          if (ref) attachImage(row, ref);
        }
      } else if (block.type === "text") {
        const text = String(block.text ?? "").trim();
        const row = text ? promptRowWithText(text) : void 0;
        if (row !== void 0) {
          if (pendingImages.length) {
            const emptyBefore = [];
            for (let k = row - 1; k >= cursor && isEmptyPrompt(input[k]); k--) emptyBefore.unshift(k);
            if (emptyBefore.length) {
              pendingImages.forEach((ref, idx) => attachImage(emptyBefore[Math.min(idx, emptyBefore.length - 1)], ref));
            } else {
              for (const ref of pendingImages) attachImage(row, ref);
            }
            pendingImages.length = 0;
          }
          promptAnchor = row;
          const exact = input[row].text.trim() === text;
          cursor = Math.max(cursor, exact ? row + 1 : row);
        }
      } else if (block.type === "image") {
        const ref = imageRef(block);
        if (!ref) continue;
        if (promptAnchor !== void 0) attachImage(promptAnchor, ref);
        else pendingImages.push(ref);
      }
    }
    if (pendingImages.length) {
      const firstEmpty = findForward(isEmptyPrompt);
      if (firstEmpty !== void 0) {
        const emptyRows = [];
        for (let k = firstEmpty; k < input.length && isEmptyPrompt(input[k]) && emptyRows.length < pendingImages.length; k++) {
          emptyRows.push(k);
        }
        pendingImages.forEach((ref, idx) => attachImage(emptyRows[Math.min(idx, emptyRows.length - 1)], ref));
        cursor = Math.max(cursor, emptyRows[emptyRows.length - 1] + 1);
      }
    }
  }
  return hidden;
}
function lastRequestEnd(input) {
  let end = input.length;
  while (end > 0 && input[end - 1].role !== "assistant") end--;
  while (end > 0 && input[end - 1].role === "assistant") end--;
  return end;
}
function calibrateWeights(input, hidden, usage) {
  const fallback = { thinkingRatio: DEFAULT_THINKING_CHARS_PER_TOKEN, charsPerToken: CHARS_PER_TOKEN };
  if (usage?.tokens === void 0 || usage.overhead === void 0) return fallback;
  const end = lastRequestEnd(input);
  const seen = [...hidden.entries()].filter(([row]) => row < end).map(([, h]) => h);
  const thinking = seen.reduce((n, h) => n + h.thinkingChars, 0);
  const images = seen.reduce((n, h) => n + h.imageTokens, 0);
  const textChars = input.slice(0, end).reduce((n, m) => n + messageChars(m), 0);
  const actualNonImage = usage.tokens - usage.overhead - images;
  if (actualNonImage <= 0) return fallback;
  const textEst = textChars / CHARS_PER_TOKEN;
  const thinkingEst = thinking / DEFAULT_THINKING_CHARS_PER_TOKEN;
  const residual = actualNonImage - (textEst + thinkingEst);
  const sigmaText = textChars >= 1e3 ? 0.15 * textEst : 0;
  const sigmaThink = thinking > 0 ? 0.4 * thinkingEst : 0;
  const sigmaFloor = 0.02 * images + 100;
  const vText = sigmaText * sigmaText;
  const vThink = sigmaThink * sigmaThink;
  const vTotal = vText + vThink + sigmaFloor * sigmaFloor;
  let calibratedThinking = DEFAULT_THINKING_CHARS_PER_TOKEN;
  if (thinking > 0) {
    const thinkingTokens = thinkingEst + residual * (vThink / vTotal);
    if (thinkingTokens > 0) {
      calibratedThinking = Math.min(RATIO_BOUNDS[1], Math.max(RATIO_BOUNDS[0], thinking / thinkingTokens));
    }
  }
  let calibratedText = CHARS_PER_TOKEN;
  if (textChars >= 1e3) {
    const textTokens = textEst + residual * (vText / vTotal);
    if (textTokens > 0) {
      calibratedText = Math.min(TEXT_RATIO_BOUNDS[1], Math.max(TEXT_RATIO_BOUNDS[0], textChars / textTokens));
    }
  }
  return { thinkingRatio: calibratedThinking, charsPerToken: calibratedText };
}
function hiddenChars(h, ratio) {
  if (!h) return 0;
  return Math.round((h.imageTokens + h.thinkingChars / ratio) * CHARS_PER_TOKEN);
}
function calibratedTextChars(rawChars, charsPerToken) {
  if (charsPerToken === CHARS_PER_TOKEN) return rawChars;
  return Math.round(rawChars * (CHARS_PER_TOKEN / charsPerToken));
}

// src/compact.ts
var HEADER_MARK = "[strata: compacted conversation]";
var DeclineError = class extends Error {
};
var OversizeError = class extends DeclineError {
};
var UnpreservableError = class extends DeclineError {
};
var MEDIA_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp"
};
function mediaExtension(mediaType) {
  const mime = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (MEDIA_EXT[mime]) return MEDIA_EXT[mime];
  const raw = mime.split("/")[1]?.replace(/[^a-z0-9]/g, "").slice(0, 8);
  return raw || "png";
}
function isPrompt3(m) {
  return m.role === "user" && m.text.trim() !== "" && !m.toolResults?.length;
}
function reconcile(dir, input, state) {
  const archive = readArchive(dir);
  const matched = matchedPrefix(input, state);
  const base = matched > 0 ? state.branch.slice(0, state.lastOutput[matched - 1].upto) : [];
  const inputBySeq = /* @__PURE__ */ new Map();
  for (let i = 0; i < matched; i++) {
    if (state.lastOutput[i].seq >= 0) inputBySeq.set(state.lastOutput[i].seq, i);
  }
  const fresh = input.map((_, i) => i).slice(matched).filter((i) => !input[i].text.startsWith(HEADER_MARK));
  const nextSeq = archive.length ? Math.max(archive.length, archive[archive.length - 1].seq + 1) : 0;
  const pending = numberMessages(nextSeq, fresh.map((i) => input[i]));
  fresh.forEach((inputIndex, k) => inputBySeq.set(pending[k].seq, inputIndex));
  const all = [...archive, ...pending];
  const bySeq = new Map(all.map((m) => [m.seq, m]));
  const branch = [...base, ...pending.map((m) => m.seq)].filter((seq) => bySeq.has(seq));
  return {
    all,
    bySeq,
    pending,
    branch,
    inputBySeq,
    matched,
    ledgerStale: base.length < state.ledgerThrough
  };
}
function headerPreamble(input, dir) {
  const access = input.hasNativeTools ? `Inspect archived messages with \`mcp__strata__show\` (supports \`seq\`, \`last_seq\`, \`offset\`, \`limit\`) or search the active branch with \`mcp__strata__search\`, or run \`${input.showCommand} <seq> [<last-seq>]\`.` : `Print one with \`${input.showCommand} <seq> [<last-seq>]\`.`;
  return `${HEADER_MARK} Older turns of this session were moved out of context. Every message's text is archived in ${archivePath(dir)} (one JSON message per line; line N+1 is seq N), and its images as files under ${join5(dir, "media")}. ${access} "[strata elided \u2026]" markers in the turns below point to archived tool results; read the archive or re-run the tool when you need the exact text. Never treat the index or ledger as proof that work happened: verify against files, git, or the archive before relying on it.`;
}
function buildHeader(input, dir, evicted, ledger, ledgerThrough, config) {
  const pinned = evicted.find(isPrompt3);
  const sections = [headerPreamble(input, dir)];
  if (pinned) sections.push(`## Original request (seq ${pinned.seq})
${pinned.text.slice(0, shareChars(config, "pinned"))}`);
  if (ledger) {
    const lag = ledgerThrough < evicted.length ? `

(This ledger covers archived history only up to seq ${evicted[Math.max(0, ledgerThrough - 1)]?.seq ?? 0}; for seq ${evicted[ledgerThrough]?.seq} onward use the episode index and the archive.)` : "";
    sections.push(`## Session ledger
${ledger}${lag}`);
  }
  const protectAfterSeq = ledgerThrough < evicted.length ? evicted[ledgerThrough]?.seq : void 0;
  const index = renderIndex(segmentEpisodes(evicted), shareChars(config, "index"), { protectAfterSeq });
  if (index) sections.push(`## Archived episodes (oldest first)
${index}`);
  return sections.join("\n\n");
}
function fitLedger(ledger, room) {
  const MIN_USEFUL = 200;
  if (ledger.length <= room) return ledger;
  if (room < MIN_USEFUL) return "";
  return trimLedger(ledger, room, "\n\u2026[ledger cut to fit this compaction]");
}
function layout(verbatim, masked, protectedFrom, headerAt, budget, config) {
  const { pinned, ledger, index, middle } = config.shares;
  const tailShare = Math.max(0.1, 1 - pinned - ledger - index - middle);
  const tailFraction = tailShare / (tailShare + middle);
  const middleFloor = budget * middle * 0.5;
  const sum = (sizes, from, to) => sizes.slice(from, to).reduce((a, b) => a + b, 0);
  const fill = (sizes, end, cap) => {
    let start = end;
    let acc = 0;
    while (start > 0 && acc + sizes[start - 1] <= cap) {
      start--;
      acc += sizes[start];
    }
    return start;
  };
  const fitsWithoutEviction = sum(masked, 0, protectedFrom) + sum(verbatim, protectedFrom, verbatim.length) <= budget;
  let h = fitsWithoutEviction ? 0 : headerAt(Math.max(1, protectedFrom));
  let tail = protectedFrom;
  let cut2 = 0;
  for (let iter = 0; iter < 4; iter++) {
    const available = Math.max(0, budget - h);
    const tailCap = available * tailFraction;
    tail = Math.min(fill(verbatim, verbatim.length, tailCap), protectedFrom);
    let tailUsed = sum(verbatim, tail, verbatim.length);
    if (tail > 0 && tailUsed < tailCap * 0.5 && tailUsed + verbatim[tail - 1] <= available - middleFloor) {
      tail--;
      tailUsed += verbatim[tail];
    }
    const middleCap = Math.max(0, available - tailUsed);
    cut2 = fill(masked, tail, middleCap);
    const nextH = cut2 > 0 ? headerAt(cut2) : 0;
    if (nextH === h) break;
    h = nextH;
  }
  const total = () => (cut2 > 0 ? headerAt(cut2) : 0) + sum(masked, cut2, tail) + sum(verbatim, tail, verbatim.length);
  while (total() > budget) {
    if (cut2 < tail) cut2++;
    else if (tail < protectedFrom) tail++;
    else {
      const kept = sum(verbatim, protectedFrom, verbatim.length);
      const hdr = cut2 > 0 ? headerAt(cut2) : 0;
      throw new OversizeError(`the latest response needs ~${kept} chars verbatim${cut2 > 0 ? ` plus a ${hdr}-char header` : ""}, over the ${budget}-char budget`);
    }
  }
  while (cut2 > 0) {
    const candidate = cut2 - 1;
    const nextTotal = (candidate > 0 ? headerAt(candidate) : 0) + sum(masked, candidate, tail) + sum(verbatim, tail, verbatim.length);
    if (nextTotal <= budget) cut2 = candidate;
    else break;
  }
  return { cut: cut2, tail };
}
function protectedUnit(rows, units) {
  let lastPrompt = -1;
  rows.forEach((m, i) => {
    if (isPrompt2(m)) lastPrompt = i;
  });
  let thinking = -1;
  for (let i = rows.length - 1; i > lastPrompt; i--) {
    const m = rows[i];
    if (m.role === "assistant" && !m.text.trim() && m.toolUses.length === 0) {
      thinking = i;
      break;
    }
  }
  if (thinking < 0) return { from: units.length - 1, thinking: false };
  return { from: units.findIndex((u) => u.start <= thinking && thinking < u.end), thinking: true };
}
function bestLedger(dir, state, rows, ledgerStale) {
  const committed = ledgerStale ? { ledger: "", ledgerThrough: 0, ledgerAge: 0, requests: 0 } : { ledger: state.ledger, ledgerThrough: state.ledgerThrough, ledgerAge: state.ledgerAge, requests: 0 };
  const ready = compatibleReady(dir, rows);
  if (ready && ready.ledger && (!committed.ledger || ready.through > committed.ledgerThrough)) {
    return { ledger: ready.ledger, ledgerThrough: ready.through, ledgerAge: ready.age, requests: 0 };
  }
  return committed;
}
function chooseLedgerWork(base, rows, cutRow, config, focus, enforceMinChars) {
  const cleanFocus = focus?.trim() || void 0;
  if (cutRow <= 0) return { reason: "nothing evicted yet" };
  if (enforceMinChars && base.ledger && !cleanFocus) {
    const awaiting = rows.slice(base.ledgerThrough, cutRow).reduce((n, m) => n + messageChars(m), 0);
    if (awaiting < config.prepareMinChars) return { reason: `only ${awaiting} chars await the ledger` };
  }
  if (base.ledger && cutRow <= base.ledgerThrough && !cleanFocus) return { reason: "ledger already covers the cut" };
  let previous;
  let span;
  let chunks;
  let nextAge;
  if (base.ledger && cutRow <= base.ledgerThrough && cleanFocus) {
    const fullSpan = rows.slice(0, cutRow);
    const fullChunks = renderSpan(fullSpan, config);
    const maxChunks = Math.max(1, config.ledgerRebuildMaxRequests);
    previous = base.ledger;
    if (fullChunks.length <= maxChunks) {
      span = fullSpan;
      chunks = fullChunks;
      nextAge = 0;
    } else {
      const capChars = maxChunks * config.ledgerChunkChars;
      let start = fullSpan.length;
      let acc = 0;
      while (start > 0 && acc + messageChars(fullSpan[start - 1]) <= capChars) {
        start--;
        acc += messageChars(fullSpan[start]);
      }
      span = fullSpan.slice(Math.min(start, fullSpan.length - 1));
      chunks = renderSpan(span, config).slice(-maxChunks);
      nextAge = base.ledgerAge + 1;
    }
  } else {
    const due = !base.ledger || config.ledgerRebuildEvery > 0 && base.ledgerAge + 1 >= config.ledgerRebuildEvery;
    const rebuild = !base.ledger || due && ledgerRequests(rows.slice(0, cutRow), config) <= config.ledgerRebuildMaxRequests;
    previous = rebuild ? "" : base.ledger;
    span = rebuild ? rows.slice(0, cutRow) : rows.slice(base.ledgerThrough, cutRow);
    chunks = renderSpan(span, config);
    nextAge = rebuild ? 0 : base.ledgerAge + 1;
  }
  if (chunks.length === 0) return { reason: "nothing new to fold in" };
  return {
    work: {
      previous,
      span,
      chunks,
      ...cleanFocus ? { focus: cleanFocus } : {},
      targetThrough: cutRow,
      nextAge
    }
  };
}
async function advanceLedger(base, rows, cutRow, config, ledgerFn, focus) {
  const { work } = chooseLedgerWork(base, rows, cutRow, config, focus, false);
  if (!work) return base;
  try {
    const update = await ledgerFn(work.previous, work.span, config, work.focus);
    return {
      ledger: trimLedger(update.ledger, shareChars(config, "ledger")),
      ledgerThrough: work.targetThrough,
      ledgerAge: work.nextAge,
      requests: update.requests
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}
function planCompaction(input, config, reserveFullLedger) {
  const dir = sessionDir(config.dataDir, input.sessionKey);
  const state = readState(dir);
  const reconciled = reconcile(dir, input.messages, state);
  const { bySeq, branch, inputBySeq, pending, ledgerStale } = reconciled;
  const hidden = input.api ? hiddenByRow(input.messages, input.api) : /* @__PURE__ */ new Map();
  const cal = calibrateWeights(input.messages, hidden, input.usage);
  const ratio = cal.thinkingRatio;
  const charsPerToken = cal.charsPerToken;
  const mediaWrites = [];
  for (const row of pending) {
    const images = hidden.get(inputBySeq.get(row.seq))?.images ?? [];
    if (!images.length) continue;
    row.media = images.map((image, k) => {
      const path2 = join5(dir, "media", `${row.seq}-${k}.${mediaExtension(image.mediaType)}`);
      mediaWrites.push({ path: path2, data: image.data });
      return { ...image.toolUseId ? { toolUseId: image.toolUseId } : {}, path: path2 };
    });
  }
  const rows = branch.map((seq) => bySeq.get(seq));
  const units = segmentUnits(rows, rows.map((m) => inputBySeq.has(m.seq)));
  if (units.length === 0) throw new Error("nothing to compact");
  const handles = units.map((u) => rows.slice(u.start, u.end).map((m) => inputBySeq.get(m.seq)));
  const whole = handles.map((h) => h.every((i) => i !== void 0));
  const guard = protectedUnit(rows, units);
  if (guard.thinking && whole.slice(guard.from).some((w) => !w)) {
    throw new UnpreservableError("the latest response opens with thinking that only the engine still holds, and part of it was already rebuilt");
  }
  const rawBuilt = units.map((u) => rebuildUnit(rows.slice(u.start, u.end), "raw", config));
  const maskedBuilt = units.map((u) => rebuildUnit(rows.slice(u.start, u.end), "masked", config));
  const maskedSizes = maskedBuilt.map(unitChars);
  const rowChars = (m) => calibratedTextChars(messageChars(m), charsPerToken) + hiddenChars(hidden.get(inputBySeq.get(m.seq)), ratio);
  const verbatim = units.map((u, k) => whole[k] ? rows.slice(u.start, u.end).reduce((n, m) => n + rowChars(m), 0) : unitChars(rawBuilt[k]));
  const base = bestLedger(dir, state, rows, ledgerStale);
  const budget = budgetChars(config);
  const ledgerCap = shareChars(config, "ledger");
  const fullReserve = reserveFullLedger ?? (input.ledgerMode !== "ready" || input.preparedLedger !== void 0);
  const preferredLedgerChars = fullReserve ? ledgerCap : Math.min(base.ledger.length, ledgerCap);
  const makeHeaderSizer = (ledgerChars) => {
    const cache = /* @__PURE__ */ new Map();
    const placeholder = ledgerChars > 0 ? "x".repeat(ledgerChars) : "";
    return (cut2) => {
      if (cut2 <= 0) return 0;
      const hit = cache.get(cut2);
      if (hit !== void 0) return hit;
      const evicted = rows.slice(0, units[cut2].start);
      let size = buildHeader(input, dir, evicted, placeholder, base.ledgerThrough, config).length;
      if (fullReserve) {
        size = Math.max(size, buildHeader(input, dir, evicted, placeholder, evicted.length, config).length);
      }
      cache.set(cut2, size);
      return size;
    };
  };
  let picked;
  try {
    picked = layout(verbatim, maskedSizes, guard.from, makeHeaderSizer(preferredLedgerChars), budget, config);
  } catch (error) {
    if (!(error instanceof OversizeError) || preferredLedgerChars === 0) throw error;
    picked = layout(verbatim, maskedSizes, guard.from, makeHeaderSizer(0), budget, config);
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
    units,
    handles,
    whole,
    rawBuilt,
    maskedBuilt,
    verbatim,
    ...picked,
    cutRow: units[picked.cut].start
  };
}
async function compact(input, config, ledgerFn = updateLedger) {
  const dir = sessionDir(config.dataDir, input.sessionKey);
  const release = await acquireLock(dir, "compact.lock");
  try {
    const plan = planCompaction(input, config);
    const { state, rows, base, units, handles, whole, rawBuilt, maskedBuilt, verbatim, cut: cut2, tail, cutRow, hidden, ratio, charsPerToken, mediaWrites } = plan;
    const { all, pending, branch, matched } = plan.reconciled;
    const tailRow = units[tail].start;
    const budget = budgetChars(config);
    let ledger;
    const provided = input.preparedLedger;
    if (provided && provided.through <= rows.length && prefixHash(rows, provided.through) === provided.prefixHash) {
      ledger = {
        ledger: trimLedger(provided.ledger, shareChars(config, "ledger")),
        ledgerThrough: provided.through,
        ledgerAge: provided.age,
        requests: provided.requests
      };
    } else if (input.ledgerError) {
      ledger = { ...base, error: input.ledgerError };
    } else if (input.ledgerMode === "ready") {
      ledger = base;
    } else {
      ledger = await advanceLedger(base, rows, cutRow, config, ledgerFn, input.instructions);
    }
    const entries = [];
    const records = [];
    const layers = { header: 0, middle: 0, tail: 0 };
    let tailHidden = 0;
    const emitBuilt = (m, upto, layer) => {
      entries.push({ built: m });
      records.push({ fp: fingerprint(m), upto, seq: -1 });
      layers[layer] += messageChars(m);
    };
    const body = [];
    for (let u = cut2; u < tail; u++) {
      for (const m of maskedBuilt[u]) body.push(() => emitBuilt(m, units[u].end, "middle"));
    }
    for (let u = tail; u < units.length; u++) {
      const { start, end } = units[u];
      if (whole[u]) {
        handles[u].forEach((inputIndex, k) => {
          body.push(() => {
            entries.push({ keep: inputIndex });
            records.push({ fp: fingerprint(input.messages[inputIndex]), upto: start + k + 1, seq: rows[start + k].seq });
            const extra = hiddenChars(hidden.get(inputIndex), ratio);
            tailHidden += extra;
            layers.tail += calibratedTextChars(messageChars(rows[start + k]), charsPerToken) + extra;
          });
        });
      } else {
        for (const m of rawBuilt[u]) body.push(() => emitBuilt(m, end, "tail"));
      }
    }
    if (cutRow > 0) {
      const evicted = rows.slice(0, cutRow);
      const bodyChars = maskedBuilt.slice(cut2, tail).reduce((n, b) => n + unitChars(b), 0) + verbatim.slice(tail).reduce((a, b) => a + b, 0);
      const emptyHeader = buildHeader(input, dir, evicted, "", ledger.ledgerThrough, config).length;
      const probeHeader = buildHeader(input, dir, evicted, "x", ledger.ledgerThrough, config).length;
      const ledgerWrapper = probeHeader - emptyHeader - 1;
      const shown = fitLedger(ledger.ledger, budget - bodyChars - emptyHeader - ledgerWrapper);
      emitBuilt({ role: "user", text: buildHeader(input, dir, evicted, shown, ledger.ledgerThrough, config), toolUses: [] }, cutRow, "header");
    }
    for (const emit of body) emit();
    const outputChars = layers.header + layers.middle + layers.tail;
    if (outputChars > budget) throw new OversizeError(`assembled output is ${outputChars} chars, over the ${budget}-char budget`);
    if (mediaWrites.length) mkdirSync3(join5(dir, "media"), { recursive: true });
    for (const { path: path2, data } of mediaWrites) writeFileSync3(path2, Buffer.from(data, "base64"));
    appendArchive(dir, pending);
    writeState(dir, {
      branch,
      lastOutput: records,
      ledger: ledger.ledger,
      ledgerThrough: ledger.ledgerThrough,
      ledgerAge: ledger.ledgerAge,
      compactions: state.compactions + 1,
      lastCut: cutRow
    });
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
        ...ledger.error ? { ledgerError: ledger.error } : {}
      }
    };
  } finally {
    release();
  }
}
function resolvePrepareTarget(input, config) {
  if ("through" in input && input.through !== void 0) {
    const dir = sessionDir(config.dataDir, input.sessionKey);
    const state = readState(dir);
    const archive = readArchive(dir);
    const bySeq = new Map(archive.map((m) => [m.seq, m]));
    const rows = state.branch.map((seq) => bySeq.get(seq)).filter((m) => m !== void 0);
    const cutRow = Math.min(Math.max(0, Math.floor(input.through)), rows.length);
    const base = bestLedger(dir, state, rows, false);
    return { dir, rows, cutRow, base, enforceMinChars: false };
  }
  const plan = planCompaction(input, config, true);
  return { dir: plan.dir, rows: plan.rows, cutRow: plan.cutRow, base: plan.base, enforceMinChars: true };
}
function planLedger(input, config, options = {}) {
  const target = resolvePrepareTarget(input, config);
  const enforceMinChars = options.enforceMinChars ?? target.enforceMinChars;
  const { work, reason } = chooseLedgerWork(target.base, target.rows, target.cutRow, config, input.instructions, enforceMinChars);
  if (!work) return { needed: false, reason: reason ?? "nothing new to fold in" };
  const maxChars = shareChars(config, "ledger");
  return {
    needed: true,
    previous: work.previous,
    chunks: work.chunks,
    ...work.focus ? { focus: work.focus } : {},
    maxChars,
    maxTokens: ledgerMaxTokens(maxChars),
    system: LEDGER_SYSTEM_PROMPT,
    model: config.ledgerModel,
    through: work.targetThrough,
    prefixHash: prefixHash(target.rows, work.targetThrough),
    age: work.nextAge
  };
}
async function prepare(input, config, ledgerFn = updateLedger) {
  const target = resolvePrepareTarget(input, config);
  const { dir, rows, cutRow, base, enforceMinChars } = target;
  const { work, reason } = chooseLedgerWork(base, rows, cutRow, config, input.instructions, enforceMinChars);
  if (!work) return { prepared: false, reason: reason ?? "nothing new to fold in" };
  const release = tryLock(dir);
  if (!release) return { prepared: false, reason: "another prepare job is running" };
  try {
    const next = await advanceLedger(base, rows, cutRow, config, ledgerFn, input.instructions);
    if (next.error) return { prepared: false, reason: `ledger update failed: ${next.error}` };
    if (next.ledgerThrough === base.ledgerThrough && next.ledger === base.ledger) return { prepared: false, reason: "nothing new to fold in" };
    writeReady(dir, {
      ledger: next.ledger,
      through: next.ledgerThrough,
      prefixHash: prefixHash(rows, next.ledgerThrough),
      age: next.ledgerAge,
      preparedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    return { prepared: true, through: next.ledgerThrough, requests: next.requests };
  } finally {
    release();
  }
}

// src/query.ts
import { existsSync as existsSync4, readdirSync, statSync as statSync2 } from "fs";
import { join as join6 } from "path";
function showArchive(dir, options) {
  const from = options.from;
  const to = options.to ?? from;
  const archive = readArchive(dir);
  const picked = archive.filter((m) => m.seq >= from && m.seq <= to);
  if (picked.length === 0) {
    return {
      found: false,
      archiveCount: archive.length,
      seqs: [],
      totalChars: 0,
      offset: 0,
      returnedChars: 0,
      hasMore: false,
      text: ""
    };
  }
  const full = picked.map((m) => renderMessage(m, m.seq)).join("\n\n");
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = options.limit !== void 0 && options.limit > 0 ? Math.floor(options.limit) : void 0;
  if (offset >= full.length) {
    return {
      found: true,
      archiveCount: archive.length,
      seqs: picked.map((m) => m.seq),
      totalChars: full.length,
      offset,
      returnedChars: 0,
      hasMore: false,
      text: `[strata show: offset ${offset} is past end of output (${full.length} chars)]`
    };
  }
  const slice = limit !== void 0 ? full.slice(offset, offset + limit) : full.slice(offset);
  const end = offset + slice.length;
  const hasMore = end < full.length;
  const footer = hasMore || offset > 0 ? `

[strata show: chars ${offset}-${end} of ${full.length}${hasMore ? `; pass offset=${end} to continue` : " (end)"}]` : "";
  return {
    found: true,
    archiveCount: archive.length,
    seqs: picked.map((m) => m.seq),
    totalChars: full.length,
    offset,
    returnedChars: slice.length,
    hasMore,
    ...hasMore ? { nextOffset: end } : {},
    text: `${slice}${footer}`
  };
}
function makeSnippet(rendered, index, matchLen, contextChars) {
  const half = Math.max(20, Math.floor(contextChars / 2));
  const start = Math.max(0, index - half);
  const end = Math.min(rendered.length, index + matchLen + half);
  const body = rendered.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "\u2026" : ""}${body}${end < rendered.length ? "\u2026" : ""}`;
}
function searchArchive(dir, options) {
  const query = options.query;
  if (!query) throw new Error("search query must not be empty");
  let matcher;
  if (options.regex) {
    let re;
    try {
      re = new RegExp(query, "i");
    } catch (error) {
      throw new Error(`invalid regex "${query}": ${error instanceof Error ? error.message : String(error)}`);
    }
    matcher = (text) => {
      const m = re.exec(text);
      return m ? { index: m.index, length: m[0].length } : void 0;
    };
  } else {
    const needle = query.toLowerCase();
    matcher = (text) => {
      const index = text.toLowerCase().indexOf(needle);
      return index >= 0 ? { index, length: needle.length } : void 0;
    };
  }
  const archive = readArchive(dir);
  const state = readState(dir);
  const branchOnly = options.branchOnly !== false;
  const branchSet = branchOnly && state.branch.length > 0 ? new Set(state.branch) : void 0;
  const branchScoped = branchSet !== void 0;
  const maxMatches = Math.min(100, Math.max(1, Math.floor(options.maxMatches ?? 20)));
  const contextChars = Math.max(40, Math.floor(options.contextChars ?? 180));
  const candidates = archive.filter((m) => {
    if (branchSet && !branchSet.has(m.seq)) return false;
    if (options.role && m.role !== options.role) return false;
    if (options.fromSeq !== void 0 && m.seq < options.fromSeq) return false;
    if (options.toSeq !== void 0 && m.seq > options.toSeq) return false;
    if (options.errorsOnly && !(m.toolResults ?? []).some((r) => r.isError)) return false;
    return true;
  });
  const matches = [];
  let totalMatches = 0;
  for (const m of candidates) {
    const rendered = renderMessage(m, m.seq);
    const hit = matcher(rendered);
    if (!hit) continue;
    totalMatches++;
    if (matches.length < maxMatches) {
      matches.push({
        seq: m.seq,
        role: m.role,
        hasError: (m.toolResults ?? []).some((r) => r.isError),
        snippet: makeSnippet(rendered, hit.index, hit.length, contextChars)
      });
    }
  }
  const header = `strata search "${query}" (${branchScoped ? "active branch" : "full archive"}, ${totalMatches} match${totalMatches === 1 ? "" : "es"} across ${candidates.length} messages${totalMatches > matches.length ? `, showing first ${matches.length}` : ""}):`;
  const lines = matches.length ? [header, ...matches.map((m) => `- #${m.seq} (${m.role}${m.hasError ? ", error" : ""}): ${m.snippet}`)] : [header, "(no matches)"];
  return {
    query,
    branchScoped,
    scanned: candidates.length,
    totalMatches,
    matches,
    formatted: lines.join("\n")
  };
}
function sessionStatus(dir, sessionKey) {
  const archive = readArchive(dir);
  const archPath = archivePath(dir);
  const archiveBytes = existsSync4(archPath) ? statSync2(archPath).size : 0;
  const mediaDir = join6(dir, "media");
  const mediaCount = existsSync4(mediaDir) ? readdirSync(mediaDir).length : 0;
  const state = readState(dir);
  const bySeq = new Map(archive.map((m) => [m.seq, m]));
  const rows = state.branch.map((seq) => bySeq.get(seq)).filter((m) => m !== void 0);
  const ready = readReady(dir);
  const readyCompatible = ready !== void 0 && ready.through <= rows.length && prefixHash(rows, ready.through) === ready.prefixHash;
  const ledgerLag = state.lastCut !== void 0 ? Math.max(0, state.lastCut - state.ledgerThrough) : 0;
  return {
    sessionKey,
    archiveCount: archive.length,
    archiveBytes,
    mediaCount,
    branchLength: state.branch.length,
    compactions: state.compactions,
    ...state.lastCut !== void 0 ? { lastCut: state.lastCut } : {},
    ledgerThrough: state.ledgerThrough,
    ledgerChars: state.ledger.length,
    ledgerAge: state.ledgerAge,
    ledgerLag,
    ...ready ? {
      readyLedger: {
        through: ready.through,
        chars: ready.ledger.length,
        age: ready.age,
        preparedAt: ready.preparedAt,
        compatible: readyCompatible
      }
    } : {}
  };
}
function formatSessionStatus(s) {
  const kb = (s.archiveBytes / 1024).toFixed(1);
  const ledgerLine = s.ledgerChars > 0 ? `ledger: ${s.ledgerChars.toLocaleString("en-US")} chars, covers ${s.ledgerThrough} rows (age ${s.ledgerAge}${s.ledgerLag > 0 ? `, lags cut by ${s.ledgerLag} rows` : s.lastCut !== void 0 ? ", up to date" : ""})` : `ledger: empty${s.ledgerLag > 0 ? ` (lags cut by ${s.ledgerLag} rows)` : ""}`;
  const readyLine = s.readyLedger ? `ready ledger: ${s.readyLedger.chars.toLocaleString("en-US")} chars, covers ${s.readyLedger.through} rows (${s.readyLedger.compatible ? "compatible" : "stale"}, prepared ${s.readyLedger.preparedAt})` : "ready ledger: none";
  return [
    `archive: ${s.archiveCount} messages (${kb} KB), ${s.mediaCount} media files, active branch ${s.branchLength} rows`,
    `compactions: ${s.compactions}${s.lastCut !== void 0 ? ` (last cut at row ${s.lastCut})` : ""}`,
    ledgerLine,
    readyLine
  ].join("\n");
}

// src/transcript.ts
import { readFileSync as readFileSync4 } from "fs";
function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => c && typeof c === "object" && "text" in c ? String(c.text) : "").join("");
  }
  return "";
}
function readTranscriptWithBlocks(path2) {
  const messages = [];
  const blockMap = /* @__PURE__ */ new Map();
  const toolUses = /* @__PURE__ */ new Map();
  for (const line of readFileSync4(path2, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.isSidechain || row.isMeta || row.isCompactSummary) continue;
    if (row.type !== "user" && row.type !== "assistant" || !row.message) continue;
    const content = row.message.content;
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content ?? [];
    if (row.type === "assistant") {
      const target = { role: "assistant", text: "", toolUses: [] };
      messages.push(target);
      blockMap.set(target, blocks);
      for (const b of blocks) {
        if (b.type === "text" && b.text) target.text = target.text ? `${target.text}
${b.text}` : b.text;
        if (b.type === "tool_use" && b.id) {
          const use = { tool_use_id: b.id, tool: b.name ?? "unknown", input: b.input ?? {} };
          target.toolUses.push(use);
          toolUses.set(b.id, use);
        }
      }
      continue;
    }
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    const results = blocks.filter((b) => b.type === "tool_result" && b.tool_use_id).map((b) => ({ tool_use_id: b.tool_use_id, text: resultText(b.content), isError: b.is_error === true }));
    for (const r of results) {
      const use = toolUses.get(r.tool_use_id);
      if (use) {
        use.text = r.text;
        if (r.isError) use.isError = true;
      }
    }
    const hasMedia = blocks.some((b) => b.type === "image" || b.type === "document");
    if (!text && results.length === 0 && !hasMedia) continue;
    const message = { role: "user", text, toolUses: [], ...results.length ? { toolResults: results } : {} };
    messages.push(message);
    blockMap.set(message, blocks);
  }
  return { messages, blocks: blockMap };
}
function apiForm(live, blocks) {
  const api = [];
  for (const m of live) {
    const own = blocks.get(m) ?? [{ type: "text", text: m.text }];
    const last = api.at(-1);
    if (last && last.role === m.role) last.content.push(...own);
    else api.push({ role: m.role, content: [...own] });
  }
  return api;
}

// src/cli.ts
var USAGE = `strata - layered, budget-bounded compaction for Claude Code

  strata compact --session <key> --in <messages.json|-> --out <result.json|-> [--instructions <text>] [--budget <tokens>] [--ledger sync|ready] [--native-tools]
  strata prepare --session <key> (--in <messages.json|-> | --through <cut>) [--instructions <text>] [--budget <tokens>]
  strata ledger-plan --session <key> (--in <messages.json|-> | --through <cut>) [--instructions <text>] [--budget <tokens>] [--sync]
  strata ledger-save --session <key> --in <ready.json|-> [--budget <tokens>]
  strata show <session-key> <seq> [<last-seq>] [--offset <chars>] [--limit <chars>]
  strata search <session-key> <query> [--all-branches] [--role user|assistant] [--errors] [--regex] [--max <n>] [--from <seq>] [--to <seq>]
  strata status <session-key> [--json]
  strata replay <transcript.jsonl> [--budget <tokens>] [--trigger <tokens>] [--no-llm] [--keep] [--background]

Data lives in $STRATA_DATA_DIR (default ~/.strata).`;
function shellQuote(value) {
  return /^[A-Za-z0-9_./:@-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
var SELF = resolve(process.argv[1]);
var SHOW_COMMAND = (key) => `node ${shellQuote(SELF)} show ${shellQuote(key)}`;
var noLedger = async (previous, span) => ({ ledger: `${previous}
- folded through #${span.at(-1)?.seq}`.trim(), requests: 1 });
function fail(message) {
  process.stderr.write(`${message}

${USAGE}
`);
  process.exit(2);
}
function parseIntArg(name, raw, min) {
  if (raw === void 0) return void 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) fail(`${name} must be an integer >= ${min}, got ${raw}`);
  return n;
}
function budgetOverride(raw) {
  const n = parseIntArg("--budget", raw, 1);
  return n !== void 0 ? { budgetTokens: n } : {};
}
function readJsonInput(source) {
  return JSON.parse(readFileSync5(source === "-" ? 0 : source, "utf-8"));
}
async function runCompact(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: "string" },
      in: { type: "string" },
      out: { type: "string" },
      instructions: { type: "string" },
      budget: { type: "string" },
      ledger: { type: "string" },
      "native-tools": { type: "boolean" }
    }
  });
  if (!values.session || !values.in || !values.out) fail("compact needs --session, --in and --out");
  if (values.ledger !== void 0 && values.ledger !== "sync" && values.ledger !== "ready") fail(`--ledger must be sync or ready, got ${values.ledger}`);
  const config = loadConfig(budgetOverride(values.budget));
  const payload = readJsonInput(values.in);
  const result = await compact(
    {
      sessionKey: values.session,
      messages: payload.messages,
      ...values.instructions ? { instructions: values.instructions } : {},
      ...values.ledger ? { ledgerMode: values.ledger } : {},
      ...values["native-tools"] ? { hasNativeTools: true } : {},
      ...payload.api ? { api: payload.api } : {},
      ...payload.usage ? { usage: payload.usage } : {},
      ...payload.preparedLedger ? { preparedLedger: payload.preparedLedger } : {},
      ...payload.ledgerError ? { ledgerError: payload.ledgerError } : {},
      showCommand: SHOW_COMMAND(values.session)
    },
    config
  );
  if (values.out === "-") process.stdout.write(JSON.stringify(result));
  else writeFileSync4(values.out, JSON.stringify(result));
  process.stderr.write(`[strata] ${summarize(result.stats)}
`);
}
async function runPrepare(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: "string" },
      in: { type: "string" },
      through: { type: "string" },
      instructions: { type: "string" },
      budget: { type: "string" }
    }
  });
  if (!values.session || !values.in && values.through === void 0) fail("prepare needs --session and either --in or --through");
  const config = loadConfig(budgetOverride(values.budget));
  if (values.through !== void 0) {
    const through = parseIntArg("--through", values.through, 0);
    const result2 = await prepare(
      { sessionKey: values.session, through, ...values.instructions ? { instructions: values.instructions } : {} },
      config
    );
    process.stdout.write(`${JSON.stringify(result2)}
`);
    return;
  }
  const { messages, api, usage } = readJsonInput(values.in);
  const result = await prepare(
    {
      sessionKey: values.session,
      messages,
      ...api ? { api } : {},
      ...usage ? { usage } : {},
      ...values.instructions ? { instructions: values.instructions } : {},
      showCommand: SHOW_COMMAND(values.session)
    },
    config
  );
  process.stdout.write(`${JSON.stringify(result)}
`);
}
function runLedgerPlan(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: "string" },
      in: { type: "string" },
      through: { type: "string" },
      instructions: { type: "string" },
      budget: { type: "string" },
      sync: { type: "boolean" }
    }
  });
  if (!values.session || !values.in && values.through === void 0) fail("ledger-plan needs --session and either --in or --through");
  const config = loadConfig(budgetOverride(values.budget));
  const options = values.sync ? { enforceMinChars: false } : {};
  if (values.through !== void 0) {
    const through = parseIntArg("--through", values.through, 0);
    const plan2 = planLedger(
      { sessionKey: values.session, through, ...values.instructions ? { instructions: values.instructions } : {} },
      config,
      options
    );
    process.stdout.write(`${JSON.stringify(plan2)}
`);
    return;
  }
  const { messages, api, usage } = readJsonInput(values.in);
  const plan = planLedger(
    {
      sessionKey: values.session,
      messages,
      ...api ? { api } : {},
      ...usage ? { usage } : {},
      ...values.instructions ? { instructions: values.instructions } : {},
      showCommand: SHOW_COMMAND(values.session)
    },
    config,
    options
  );
  process.stdout.write(`${JSON.stringify(plan)}
`);
}
function runLedgerSave(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      session: { type: "string" },
      in: { type: "string" },
      budget: { type: "string" }
    }
  });
  if (!values.session || !values.in) fail("ledger-save needs --session and --in");
  const config = loadConfig(budgetOverride(values.budget));
  const dir = sessionDir(config.dataDir, values.session);
  const payload = readJsonInput(values.in);
  if (typeof payload.ledger !== "string" || typeof payload.through !== "number" || typeof payload.prefixHash !== "string" || typeof payload.age !== "number") {
    fail("ledger-save input must contain ledger, through, prefixHash and age");
  }
  const existing = readReady(dir);
  if (existing && existing.prefixHash === payload.prefixHash && existing.through >= payload.through) {
    process.stdout.write(`${JSON.stringify({ saved: false, reason: "already saved for this prefix", through: existing.through })}
`);
    return;
  }
  writeReady(dir, {
    ledger: trimLedger(payload.ledger, shareChars(config, "ledger")),
    through: payload.through,
    prefixHash: payload.prefixHash,
    age: payload.age,
    preparedAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  process.stdout.write(`${JSON.stringify({ saved: true, through: payload.through })}
`);
}
function runShow(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      offset: { type: "string" },
      limit: { type: "string" }
    }
  });
  const [key, first, last] = positionals;
  if (!key || first === void 0) fail("show needs <session-key> <seq> [<last-seq>]");
  const from = parseIntArg("<seq>", first, 0);
  const to = last === void 0 ? from : parseIntArg("<last-seq>", last, from);
  const offset = parseIntArg("--offset", values.offset, 0);
  const limit = parseIntArg("--limit", values.limit, 1);
  const result = showArchive(sessionDir(loadConfig().dataDir, key), { from, to, offset, limit });
  if (!result.found) fail(`no archived messages in seq ${from}-${to} (archive holds ${result.archiveCount})`);
  process.stdout.write(`${result.text}
`);
}
function runSearch(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "all-branches": { type: "boolean" },
      role: { type: "string" },
      errors: { type: "boolean" },
      regex: { type: "boolean" },
      max: { type: "string" },
      from: { type: "string" },
      to: { type: "string" }
    }
  });
  const [key, ...queryParts] = positionals;
  const query = queryParts.join(" ");
  if (!key || !query) fail("search needs <session-key> <query>");
  if (values.role !== void 0 && values.role !== "user" && values.role !== "assistant") {
    fail(`--role must be user or assistant, got ${values.role}`);
  }
  const result = searchArchive(sessionDir(loadConfig().dataDir, key), {
    query,
    branchOnly: !values["all-branches"],
    ...values.role ? { role: values.role } : {},
    ...values.errors ? { errorsOnly: true } : {},
    ...values.regex ? { regex: true } : {},
    maxMatches: parseIntArg("--max", values.max, 1),
    fromSeq: parseIntArg("--from", values.from, 0),
    toSeq: parseIntArg("--to", values.to, 0)
  });
  process.stdout.write(`${result.formatted}
`);
}
function runStatus(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" }
    }
  });
  const [key] = positionals;
  if (!key) fail("status needs <session-key>");
  const status = sessionStatus(sessionDir(loadConfig().dataDir, key), key);
  if (values.json) process.stdout.write(`${JSON.stringify(status)}
`);
  else process.stdout.write(`${formatSessionStatus(status)}
`);
}
function summarize(s) {
  const k = (chars) => `${Math.round(estimateTokens(chars) / 1e3)}k`;
  return [
    `archived ${s.archived} (+${s.newRaw}${s.matchedPrevious ? "" : `, matched ${s.matched}`}) branch ${s.branch}`,
    `raw ${k(s.rawChars)} -> out ${k(s.outputChars)}`,
    `header ${k(s.layers.header)} middle ${k(s.layers.middle)} tail ${k(s.layers.tail)}${s.hiddenChars ? ` (${k(s.hiddenChars)} images/thinking)` : ""}`,
    s.mediaSaved ? `${s.mediaSaved} images archived` : "",
    `cut ${s.cut} tail@${s.tailStart}`,
    s.ledgerRequests ? `ledger x${s.ledgerRequests}` : "",
    s.ledgerThrough < s.cut ? `ledger lags ${s.cut - s.ledgerThrough} rows` : "",
    s.ledgerError ? `LEDGER ERROR: ${s.ledgerError}` : ""
  ].filter(Boolean).join(" | ");
}
async function runReplay(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      budget: { type: "string" },
      trigger: { type: "string" },
      "no-llm": { type: "boolean" },
      keep: { type: "boolean" },
      // Emulate the plugin: prepare the ledger 100k below the trigger (at least half of it), compact instantly at the trigger.
      background: { type: "boolean" }
    }
  });
  const path2 = positionals[0];
  if (!path2) fail("replay needs a transcript path");
  const dataDir = mkdtempSync(join7(tmpdir(), "strata-replay-"));
  const config = loadConfig({ dataDir, ...budgetOverride(values.budget) });
  const trigger = values.trigger ? parseIntArg("--trigger", values.trigger, 1) : config.budgetTokens * 2;
  const key = `replay-${basename(path2, ".jsonl")}`;
  const { messages: raw, blocks } = readTranscriptWithBlocks(path2);
  const weight = /* @__PURE__ */ new Map();
  const tokensOf = (m) => {
    let w = weight.get(m);
    if (w === void 0) {
      const hidden = hiddenByRow([m], apiForm([m], blocks)).get(0);
      w = estimateTokens(messageChars(m)) + (hidden ? hidden.imageTokens + Math.round(hidden.thinkingChars / DEFAULT_THINKING_CHARS_PER_TOKEN) : 0);
      weight.set(m, w);
    }
    return w;
  };
  const tokens = (ms) => ms.reduce((n, m) => n + tokensOf(m), 0);
  process.stdout.write(`${raw.length} messages, ${tokens(raw).toLocaleString("en-US")} est. tokens raw; budget ${config.budgetTokens}, trigger ${trigger}
`);
  const ledgerFn = values["no-llm"] ? noLedger : void 0;
  const PREPARE_HEADROOM_TOKENS = 1e5;
  const prepareAt = Math.max(Math.round(trigger / 2), trigger - PREPARE_HEADROOM_TOKENS);
  let live = [];
  let compactions = 0;
  let preparedThisCycle = false;
  for (const m of raw) {
    live.push(m);
    const size = tokens(live);
    if (values.background && size >= prepareAt && size < trigger && !preparedThisCycle) {
      preparedThisCycle = true;
      const prepared = await prepare(
        { sessionKey: key, messages: live, api: apiForm(live, blocks), showCommand: SHOW_COMMAND(key) },
        config,
        ledgerFn
      );
      process.stdout.write(`   prepare at ${Math.round(size / 1e3)}k: ${JSON.stringify(prepared)}
`);
    }
    if (size < trigger) continue;
    preparedThisCycle = false;
    let result;
    try {
      result = await compact(
        { sessionKey: key, messages: live, api: apiForm(live, blocks), showCommand: SHOW_COMMAND(key), ...values.background ? { ledgerMode: "ready" } : {} },
        config,
        ledgerFn
      );
    } catch (error) {
      if (!(error instanceof DeclineError)) throw error;
      process.stdout.write(`#${compactions + 1} declined, stopping: ${error.message}
`);
      break;
    }
    live = result.entries.map((e) => "keep" in e ? live[e.keep] : e.built);
    compactions++;
    process.stdout.write(`#${compactions} ${summarize(result.stats)}
`);
    if (values.background && result.stats.ledgerThrough < result.stats.cut) {
      const caught = await prepare({ sessionKey: key, through: result.stats.cut }, config, ledgerFn);
      process.stdout.write(`   catch-up: ${JSON.stringify(caught)}
`);
    }
  }
  process.stdout.write(`end: live ${tokens(live).toLocaleString("en-US")} est. tokens after ${compactions} compactions
`);
  if (values.keep) process.stdout.write(`data kept in ${dataDir}
`);
  else rmSync3(dataDir, { recursive: true, force: true });
}
var [command, ...rest] = process.argv.slice(2);
var commands = {
  compact: runCompact,
  prepare: runPrepare,
  "ledger-plan": runLedgerPlan,
  "ledger-save": runLedgerSave,
  show: runShow,
  search: runSearch,
  status: runStatus,
  replay: runReplay
};
var run = command ? commands[command] : void 0;
if (!run) fail(command ? `unknown command: ${command}` : "no command given");
var EXIT_DECLINED = 3;
Promise.resolve(run(rest)).catch((error) => {
  process.stderr.write(`[strata] ${error instanceof Error ? error.stack : String(error)}
`);
  process.exit(error instanceof DeclineError ? EXIT_DECLINED : 1);
});
