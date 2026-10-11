import { describe, expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, Next, ProcessRunResult, SessionMessage } from 'claude-code'
import { strataCompact } from './register.ts'

const SESSION = 'sess-1'
const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'old prompt', toolUses: [], handle: 'h0' },
  { role: 'assistant', text: 'old answer', toolUses: [], handle: 'h1' },
  { role: 'user', text: 'latest prompt', toolUses: [], handle: 'h2' }
]
const HEADER = { role: 'user' as const, text: '[strata: compacted conversation] ...', toolUses: [] }
const BUILT_IN = { messages: [{ role: 'user' as const, text: 'built-in summary', toolUses: [] }] }

type Call = { argv: readonly string[]; stdin?: string }

/** The slice of `$` strataCompact touches; the test kit's `$` has no session.id. */
const API_FORM = [{ role: 'user', content: [{ type: 'text', text: 'old prompt' }] }]
const BREAKDOWN = {
  tokens: 90_000,
  window: 1_000_000,
  breakdown: {
    categories: [
      { name: 'System prompt', tokens: 2_000, kind: 'used' },
      { name: 'System tools', tokens: 40_000, kind: 'used' },
      { name: 'Messages', tokens: 48_000, kind: 'used' },
      { name: 'Free space', tokens: 910_000, kind: 'free' }
    ]
  }
}

function fakeEngine(result: ProcessRunResult, calls: Call[], logs: string[], env: Record<string, string> = {}, withSession = false): EngineInterface {
  return {
    env: { get: async (name: string) => env[name] },
    ...(withSession
      ? { session: { messages: async () => API_FORM, usage: async () => ({ startedAt: 0, context: BREAKDOWN, rateLimits: [] }) } }
      : {}),
    plugin: { root: '/plugins/strata/plugin' },
    process: {
      run: async (argv: readonly string[], init?: { stdin?: string }) => {
        calls.push({ argv, stdin: init?.stdin })
        return result
      }
    },
    ui: { log: (text: string) => void logs.push(text) },
    // Timers fire at once here: what they start is awaited through the calls array.
    clock: { after: (_ms: number, fn: () => void) => (fn(), { cancel: () => undefined }) }
  } as unknown as EngineInterface
}

function cli(stdout: string, exitCode = 0): ProcessRunResult {
  return { exitCode, stdout, stderr: exitCode ? 'boom' : '', isStdoutTruncated: false, isStderrTruncated: false }
}

const builtIn = (async () => BUILT_IN) as unknown as Next<'session.compact'>

describe('strataCompact', () => {
  test('maps CLI entries back onto engine messages, keeping handles', async () => {
    const calls: Call[] = []
    const logs: string[] = []
    const stdout = JSON.stringify({ entries: [{ built: HEADER }, { keep: 1 }, { keep: 2 }], stats: { rawChars: 7000, outputChars: 3500, matched: 0, previousOutput: 0, cut: 0, ledgerThrough: 0 } })
    const result = await strataCompact(fakeEngine(cli(stdout), calls, logs), { trigger: 'manual', messages: MESSAGES }, builtIn, SESSION)
    expect(result.messages?.map(m => m.text)).toEqual([HEADER.text, 'old answer', 'latest prompt'])
    expect(result.messages?.[1]?.handle).toBe('h1')
    expect(calls[0]?.argv).toEqual(['node', '/plugins/strata/plugin/bin/strata.mjs', 'compact', '--session', SESSION, '--in', '-', '--out', '-'])
    expect(JSON.parse(calls[0]?.stdin ?? '{}').messages).toHaveLength(3)
    // The engine prefixes the plugin's name; the line itself is the result.
    expect(logs.some(l => /branch text -> .* live/.test(l))).toBe(true)
  })

  test('falls back to the built-in compactor when the CLI fails', async () => {
    const result = await strataCompact(fakeEngine(cli('', 1), [], []), { trigger: 'auto', messages: MESSAGES }, builtIn, SESSION)
    expect(result.messages?.[0]?.text).toBe('built-in summary')
  })

  test('falls back when the CLI points at a message that does not exist', async () => {
    const stdout = JSON.stringify({ entries: [{ keep: 9 }], stats: { rawChars: 1, outputChars: 1, matched: 0, previousOutput: 0, cut: 0, ledgerThrough: 0 } })
    const result = await strataCompact(fakeEngine(cli(stdout), [], []), { trigger: 'auto', messages: MESSAGES }, builtIn, SESSION)
    expect(result.messages?.[0]?.text).toBe('built-in summary')
  })

  test('its own trigger compacts with the ready ledger; /compact may update it', async () => {
    const calls: Call[] = []
    const stdout = JSON.stringify({ entries: [{ keep: 2 }], stats: { rawChars: 1, outputChars: 1, matched: 0, previousOutput: 0, cut: 0, ledgerThrough: 0 } })
    await strataCompact(fakeEngine(cli(stdout), calls, []), { trigger: 'plugin', messages: MESSAGES }, builtIn, SESSION)
    await strataCompact(fakeEngine(cli(stdout), calls, []), { trigger: 'manual', messages: MESSAGES }, builtIn, SESSION)
    expect(calls[0]?.argv.slice(-2)).toEqual(['--ledger', 'ready'])
    expect(calls[1]?.argv).not.toContain('--ledger')
  })

  test('a lagging ready compaction catches the ledger up from its own output', async () => {
    const calls: Call[] = []
    const stdout = JSON.stringify({ entries: [{ built: HEADER }, { keep: 2 }], stats: { rawChars: 7000, outputChars: 3500, matched: 0, previousOutput: 0, cut: 40, ledgerThrough: 10 } })
    const engine = fakeEngine(cli(stdout), calls, [])
    await strataCompact(engine, { trigger: 'plugin', messages: MESSAGES }, builtIn, SESSION)
    const prep = calls.find(c => c.argv.includes('prepare'))
    expect(prep?.argv).toContain(SESSION)
    expect(JSON.parse(prep?.stdin ?? '{}').messages.map((m: { text: string }) => m.text)).toEqual([HEADER.text, 'latest prompt'])
  })

  test('sends the API form and the real token figures along with the rows', async () => {
    const calls: Call[] = []
    const stdout = JSON.stringify({ entries: [{ keep: 2 }], stats: { rawChars: 1, outputChars: 1, matched: 0, previousOutput: 0, cut: 0, ledgerThrough: 0 } })
    await strataCompact(fakeEngine(cli(stdout), calls, [], {}, true), { trigger: 'manual', messages: MESSAGES }, builtIn, SESSION)
    const sent = JSON.parse(calls[0]?.stdin ?? '{}')
    expect(sent.api).toEqual(API_FORM)
    expect(sent.usage).toEqual({ tokens: 90_000, overhead: 42_000 })
  })

  test('STRATA_AUTO=0 also stops the catch-up after a compaction', async () => {
    const calls: Call[] = []
    const stdout = JSON.stringify({ entries: [{ built: HEADER }, { keep: 2 }], stats: { rawChars: 7000, outputChars: 3500, matched: 0, previousOutput: 0, cut: 40, ledgerThrough: 10 } })
    await strataCompact(fakeEngine(cli(stdout), calls, [], { STRATA_AUTO: '0' }), { trigger: 'manual', messages: MESSAGES }, builtIn, SESSION)
    expect(calls.some(c => c.argv.includes('prepare'))).toBe(false)
  })

  test('between the prepare mark and the trigger, prepares in the background', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { STRATA_TRIGGER_TOKENS: '1000' })
    const runs: string[][] = []
    on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 800, window: 1_000_000, percent: 1 }, rateLimits: [] } }))
    on('session.id', () => ({ value: SESSION }))
    on('session.messages', () => ({ value: MESSAGES }))
    on('process.run', (_$, e) => {
      runs.push([...e.argv])
      return { value: cli('{"prepared":true}') }
    })
    on('ui.log', () => ({ value: undefined }))
    on('turn.complete', () => ({ text: 'done' }))
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.advance(0)
    expect(runs.some(argv => argv.includes('prepare'))).toBe(true)
  })

  test('the registered hook skips precompute', async ($, on) => {
    on('session.compact', () => BUILT_IN)
    const result = await $.session.compact({ trigger: 'precompute', messages: MESSAGES })
    expect(result.skip).toBe('strata compacts on demand')
  })
})
