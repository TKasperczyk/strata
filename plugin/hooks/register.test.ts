import { describe, expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, ModelCompleteRequest, ModelCompleteResult, Next, ProcessRunResult, SessionMessage } from 'claude-code'
import { strataCompact } from './register'

const SESSION = 'sess-1'
const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'old prompt', toolUses: [], handle: 'h0' },
  { role: 'assistant', text: 'old answer', toolUses: [], handle: 'h1' },
  { role: 'user', text: 'latest prompt', toolUses: [], handle: 'h2' }
]
const HEADER = { role: 'user' as const, text: '[strata: compacted conversation] ...', toolUses: [] }
const BUILT_IN = { messages: [{ role: 'user' as const, text: 'built-in summary', toolUses: [] }] }

type Call = { argv: readonly string[]; stdin?: string }

const API_FORM = [{ role: 'user' as const, content: [{ type: 'text', text: 'old prompt' }] }]
const BREAKDOWN = {
  tokens: 90_000,
  window: 1_000_000,
  breakdown: {
    categories: [
      { name: 'System prompt', tokens: 2_000, kind: 'used' as const },
      { name: 'System tools', tokens: 40_000, kind: 'used' as const },
      { name: 'Messages', tokens: 48_000, kind: 'used' as const },
      { name: 'Free space', tokens: 910_000, kind: 'free' as const }
    ]
  }
}

const SAMPLE_PLAN = {
  needed: true,
  previous: '',
  chunks: ['#0 user: old prompt\n'],
  maxChars: 5_000,
  maxTokens: 2_000,
  system: 'SYS',
  model: 'sonnet',
  through: 2,
  prefixHash: 'hash-2',
  age: 0
}

const ZERO_USAGE = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

function cli(stdout: string, exitCode = 0, stderr = ''): ProcessRunResult {
  return { exitCode, stdout, stderr: stderr || (exitCode ? 'boom' : ''), isStdoutTruncated: false, isStderrTruncated: false }
}

type FakeOptions = {
  onRun?: (argv: readonly string[], stdin?: string) => ProcessRunResult
  onModel?: (req: ModelCompleteRequest) => ModelCompleteResult
  env?: Record<string, string>
  withSession?: boolean
}

function fakeEngine(
  defaultResult: ProcessRunResult,
  calls: Call[],
  logs: string[],
  modelCalls: ModelCompleteRequest[],
  opts: FakeOptions = {}
): EngineInterface {
  return {
    env: { get: async (name: string) => opts.env?.[name] },
    ...(opts.withSession
      ? {
          session: {
            messages: async (args?: { as?: string }) => (args?.as === 'api' ? API_FORM : MESSAGES),
            usage: async () => ({ startedAt: 0, context: BREAKDOWN, rateLimits: [] })
          }
        }
      : {}),
    model: {
      complete: async (req: ModelCompleteRequest) => {
        modelCalls.push(req)
        return opts.onModel
          ? opts.onModel(req)
          : { isAnswered: true as const, text: '## Current state\n- folded (#0)', usage: ZERO_USAGE }
      }
    },
    plugin: { root: '/plugins/strata/plugin' },
    process: {
      run: async (argv: readonly string[], init?: { stdin?: string }) => {
        calls.push({ argv, stdin: init?.stdin })
        if (opts.onRun) return opts.onRun(argv, init?.stdin)
        if (argv.includes('ledger-plan')) return cli(JSON.stringify({ needed: false, reason: 'nothing evicted' }))
        if (argv.includes('ledger-save')) return cli(JSON.stringify({ saved: true, through: 2 }))
        return defaultResult
      }
    },
    ui: { log: (text: string) => void logs.push(text) },
    // Timers fire at once here: what they start is awaited through the calls array.
    clock: { after: (_ms: number, fn: () => void) => (fn(), { cancel: () => undefined }) }
  } as unknown as EngineInterface
}

const builtIn = (async () => BUILT_IN) as unknown as Next<'session.compact'>

describe('strataCompact', () => {
  test('maps CLI entries back onto engine messages, keeping handles', async () => {
    const calls: Call[] = []
    const logs: string[] = []
    const models: ModelCompleteRequest[] = []
    const stdout = JSON.stringify({ entries: [{ built: HEADER }, { keep: 1 }, { keep: 2 }], stats: { rawChars: 7000, outputChars: 3500, matched: 0, previousOutput: 0, cut: 0, ledgerThrough: 0 } })
    const result = await strataCompact(fakeEngine(cli(stdout), calls, logs, models), { trigger: 'manual', messages: MESSAGES }, builtIn, SESSION)
    expect(result.messages?.map(m => m.text)).toEqual([HEADER.text, 'old answer', 'latest prompt'])
    expect(result.messages?.[1]?.handle).toBe('h1')
    const compactCall = calls.find(c => c.argv.includes('compact'))
    expect(compactCall?.argv).toEqual([
      'node',
      '/plugins/strata/plugin/bin/strata.mjs',
      'compact',
      '--session',
      SESSION,
      '--in',
      '-',
      '--out',
      '-',
      '--ledger',
      'ready',
      '--native-tools'
    ])
    expect(JSON.parse(compactCall?.stdin ?? '{}').messages).toHaveLength(3)
    expect(logs.some(l => /branch text -> .* live/.test(l))).toBe(true)
  })

  test('falls back to the built-in compactor when the CLI fails', async () => {
    const result = await strataCompact(fakeEngine(cli('', 1), [], [], []), { trigger: 'auto', messages: MESSAGES }, builtIn, SESSION)
    expect(result.messages?.[0]?.text).toBe('built-in summary')
  })

  test('falls back when the CLI points at a message that does not exist', async () => {
    const stdout = JSON.stringify({ entries: [{ keep: 9 }], stats: { rawChars: 1, outputChars: 1, matched: 0, previousOutput: 0, cut: 0, ledgerThrough: 0 } })
    const result = await strataCompact(fakeEngine(cli(stdout), [], [], []), { trigger: 'auto', messages: MESSAGES }, builtIn, SESSION)
    expect(result.messages?.[0]?.text).toBe('built-in summary')
  })

  test('its own trigger skips model.complete; /compact runs ledger-plan + $.model.complete and forwards preparedLedger', async () => {
    const calls: Call[] = []
    const models: ModelCompleteRequest[] = []
    const stdout = JSON.stringify({ entries: [{ keep: 2 }], stats: { rawChars: 7000, outputChars: 3500, matched: 0, previousOutput: 0, cut: 2, ledgerThrough: 2 } })
    const engine = fakeEngine(cli(stdout), calls, [], models, {
      onRun: argv => {
        if (argv.includes('ledger-plan')) return cli(JSON.stringify({ ...SAMPLE_PLAN, focus: 'focus on db' }))
        return cli(stdout)
      }
    })
    await strataCompact(engine, { trigger: 'plugin', messages: MESSAGES }, builtIn, SESSION)
    expect(models).toHaveLength(0)
    expect(calls.some(c => c.argv.includes('ledger-plan'))).toBe(false)

    await strataCompact(engine, { trigger: 'manual', instructions: 'focus on db', messages: MESSAGES }, builtIn, SESSION)
    expect(models).toHaveLength(1)
    expect(models[0]?.model).toBe('sonnet')
    expect(models[0]?.prompt).toContain('focus on db')
    const planCall = calls.find(c => c.argv.includes('ledger-plan'))
    expect(planCall?.argv).toContain('--sync')
    expect(planCall?.argv).toContain('focus on db')
    const compactCalls = calls.filter(c => c.argv.includes('compact'))
    const sent = JSON.parse(compactCalls[1]?.stdin ?? '{}')
    expect(sent.preparedLedger).toEqual({
      ledger: '## Current state\n- folded (#0)',
      through: 2,
      prefixHash: 'hash-2',
      age: 0,
      requests: 1
    })
  })

  test('sync /compact falls back without calling $.model.complete when ledger-plan declines (exit 3)', async () => {
    const models: ModelCompleteRequest[] = []
    const engine = fakeEngine(cli(''), [], [], models, {
      onRun: argv => (argv.includes('ledger-plan') ? cli('', 3, 'oversize') : cli(''))
    })
    const result = await strataCompact(engine, { trigger: 'manual', messages: MESSAGES }, builtIn, SESSION)
    expect(result.messages?.[0]?.text).toBe('built-in summary')
    expect(models).toHaveLength(0)
  })

  test('sync /compact completes with --ledger ready and logs ledgerError when $.model.complete fails', async () => {
    const calls: Call[] = []
    const logs: string[] = []
    const models: ModelCompleteRequest[] = []
    const stdout = JSON.stringify({ entries: [{ built: HEADER }, { keep: 2 }], stats: { rawChars: 7000, outputChars: 3500, matched: 0, previousOutput: 0, cut: 2, ledgerThrough: 0, ledgerError: 'ledger model failed: api-error (rate_limit HTTP 429)' } })
    const engine = fakeEngine(cli(stdout), calls, logs, models, {
      onRun: argv => (argv.includes('ledger-plan') ? cli(JSON.stringify(SAMPLE_PLAN)) : cli(stdout)),
      onModel: () => ({ isAnswered: false as const, reason: 'api-error' as const, status: 429, error: 'rate_limit' as const, usage: ZERO_USAGE }),
      env: { STRATA_AUTO: '0' }
    })
    const result = await strataCompact(engine, { trigger: 'manual', messages: MESSAGES }, builtIn, SESSION)
    expect(result.messages).toHaveLength(2)
    const compactCall = calls.find(c => c.argv.includes('compact'))
    expect(JSON.parse(compactCall?.stdin ?? '{}').ledgerError).toContain('rate_limit')
    expect(logs.some(l => l.includes('rate_limit'))).toBe(true)
  })

  test('a lagging ready compaction catches the ledger up via explicit --through <cut> + $.model.complete + ledger-save', async () => {
    const calls: Call[] = []
    const models: ModelCompleteRequest[] = []
    const stdout = JSON.stringify({ entries: [{ built: HEADER }, { keep: 2 }], stats: { rawChars: 7000, outputChars: 3500, matched: 0, previousOutput: 0, cut: 40, ledgerThrough: 10 } })
    const engine = fakeEngine(cli(stdout), calls, [], models, {
      onRun: argv => {
        if (argv.includes('ledger-plan')) return cli(JSON.stringify({ ...SAMPLE_PLAN, through: 40 }))
        if (argv.includes('ledger-save')) return cli(JSON.stringify({ saved: true, through: 40 }))
        return cli(stdout)
      }
    })
    await strataCompact(engine, { trigger: 'plugin', messages: MESSAGES }, builtIn, SESSION)
    for (let i = 0; i < 6; i++) await Promise.resolve()
    const plan = calls.find(c => c.argv.includes('ledger-plan'))
    expect(plan?.argv).toContain('--through')
    expect(plan?.argv).toContain('40')
    expect(plan?.stdin).toBeUndefined()
    expect(models).toHaveLength(1)
    const save = calls.find(c => c.argv.includes('ledger-save'))
    expect(save).toBeDefined()
    expect(JSON.parse(save?.stdin ?? '{}').through).toBe(40)
  })

  test('sends the API form and the real token figures along with the rows', async () => {
    const calls: Call[] = []
    const stdout = JSON.stringify({ entries: [{ keep: 2 }], stats: { rawChars: 1, outputChars: 1, matched: 0, previousOutput: 0, cut: 0, ledgerThrough: 0 } })
    await strataCompact(fakeEngine(cli(stdout), calls, [], [], { withSession: true }), { trigger: 'manual', messages: MESSAGES }, builtIn, SESSION)
    const compactCall = calls.find(c => c.argv.includes('compact'))
    const sent = JSON.parse(compactCall?.stdin ?? '{}')
    expect(sent.api).toEqual(API_FORM)
    expect(sent.usage).toEqual({ tokens: 90_000, overhead: 42_000 })
  })

  test('STRATA_AUTO=0 also stops the catch-up after a compaction', async () => {
    const calls: Call[] = []
    const stdout = JSON.stringify({ entries: [{ built: HEADER }, { keep: 2 }], stats: { rawChars: 7000, outputChars: 3500, matched: 0, previousOutput: 0, cut: 40, ledgerThrough: 10 } })
    await strataCompact(fakeEngine(cli(stdout), calls, [], [], { env: { STRATA_AUTO: '0' } }), { trigger: 'plugin', messages: MESSAGES }, builtIn, SESSION)
    expect(calls.some(c => c.argv.includes('ledger-plan'))).toBe(false)
  })

  test('between the prepare mark and the trigger, prepares in the background with hiddenContext and $.model.complete', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { STRATA_TRIGGER_TOKENS: '1000' })
    const runs: Call[] = []
    const modelPrompts: string[] = []
    on('session.usage', () => ({ value: { startedAt: 0, context: { ...BREAKDOWN, tokens: 800, percent: 1 } as never, rateLimits: [] } }))
    on('session.id', () => ({ value: SESSION }))
    on('session.messages', (_$, e) => ({ value: e?.as === 'api' ? API_FORM : MESSAGES }))
    on('model.complete', (_$, e) => {
      modelPrompts.push(e.prompt)
      return { value: { isAnswered: true as const, text: '## Current state\n- prepared (#0)', usage: ZERO_USAGE } }
    })
    on('process.run', (_$, e) => {
      runs.push({ argv: [...e.argv], stdin: e.init?.stdin })
      if (e.argv.includes('ledger-plan')) return { value: cli(JSON.stringify(SAMPLE_PLAN)) }
      if (e.argv.includes('ledger-save')) return { value: cli(JSON.stringify({ saved: true, through: 2 })) }
      return { value: cli('{}') }
    })
    on('ui.log', () => ({ value: undefined }))
    on('turn.complete', () => ({ text: 'done' }))
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.advance(0)
    const planRun = runs.find(r => r.argv.includes('ledger-plan'))
    expect(planRun).toBeDefined()
    const planPayload = JSON.parse(planRun?.stdin ?? '{}')
    expect(planPayload.api).toEqual(API_FORM)
    expect(planPayload.usage).toEqual({ tokens: 800, overhead: 42_000 })
    expect(modelPrompts).toHaveLength(1)
    expect(runs.some(r => r.argv.includes('ledger-save'))).toBe(true)
  })

  test('the registered hook skips precompute', async ($, on) => {
    on('session.compact', () => BUILT_IN)
    const result = await $.session.compact({ trigger: 'precompute', messages: MESSAGES })
    expect(result.skip).toBe('strata compacts on demand')
  })

  test('session.start registers archive tools and /strata command, tool.check auto-allows, and tool.call / command.run work', async ($, on) => {
    mock.env(on, {})
    const toolsRegistered: string[] = []
    const commandsRegistered: string[] = []
    const runs: Call[] = []
    on('tool.register', (_$, e) => {
      toolsRegistered.push(e.name)
      return { value: { tool: `mcp__strata__${e.name}` } }
    })
    on('command.register', (_$, e) => {
      commandsRegistered.push(e.name)
      return { value: { command: e.name } }
    })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('session.id', () => ({ value: SESSION }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 120_000, window: 1_000_000, percent: 12 }, rateLimits: [] } }))
    let coreDecision: 'ask' | 'deny' = 'ask'
    on('tool.check', () => ({ decision: coreDecision, ...(coreDecision === 'deny' ? { reason: 'policy denied' } : {}) }))
    on('process.run', (_$, e) => {
      runs.push({ argv: [...e.argv], stdin: e.init?.stdin })
      if (e.argv.includes('show')) return { value: cli('#5 user: hello world\n') }
      if (e.argv.includes('search')) return { value: cli('strata search "--flag" (active branch, 1 match):\n- #5 (user): --flag\n') }
      if (e.argv.includes('status')) {
        return {
          value: cli(
            JSON.stringify({
              sessionKey: SESSION,
              archiveCount: 40,
              archiveBytes: 20480,
              mediaCount: 2,
              branchLength: 36,
              compactions: 3,
              lastCut: 20,
              ledgerThrough: 18,
              ledgerChars: 1200,
              ledgerAge: 2,
              ledgerLag: 2,
              readyLedger: { through: 20, chars: 1300, age: 3, preparedAt: '2026-10-12T12:00:00Z', compatible: true }
            })
          )
        }
      }
      return { value: cli('') }
    })

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(toolsRegistered).toEqual(['show', 'search'])
    expect(commandsRegistered).toEqual(['strata'])

    // tool.check auto-allows read-only strata tools unless core denies
    const allowVerdict = await $.tool.check({ tool: 'mcp__strata__show', input: { seq: 5 } })
    expect(allowVerdict.decision).toBe('allow')
    coreDecision = 'deny'
    const denyVerdict = await $.tool.check({ tool: 'mcp__strata__search', input: { query: 'x' } })
    expect(denyVerdict.decision).toBe('deny')
    coreDecision = 'ask'

    // tool.call for show with offset/limit pagination
    const shown = await $.tool.call({ tool: 'mcp__strata__show', seq: 5, last_seq: 6, offset: 10, limit: 500 })
    expect(shown.result).toBe('#5 user: hello world')
    const showArgv = runs.find(r => r.argv.includes('show'))?.argv
    expect(showArgv).toContain('--offset')
    expect(showArgv).toContain('10')
    expect(showArgv).toContain('--limit')
    expect(showArgv).toContain('500')

    // tool.call for search passes flags before `--` so queries starting with `--` work safely
    const found = await $.tool.call({ tool: 'mcp__strata__search', query: '--flag', errors_only: true, role: 'user' })
    expect(String(found.result)).toContain('#5 (user)')
    const searchArgv = runs.find(r => r.argv.includes('search'))?.argv ?? []
    expect(searchArgv.indexOf('--errors')).toBeLessThan(searchArgv.indexOf('--'))
    expect(searchArgv.at(-1)).toBe('--flag')

    // /strata status command
    const status = await $.command.run({ command: 'strata', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    expect(status.text).toContain('archive: 40 messages')
    expect(status.text).toContain('active branch 36 rows')
    expect(status.text).toContain('compactions: 3')
    expect(status.text).toContain('lags cut by 2 rows')
    expect(status.text).toContain('ready ledger: 1,300 chars')
  })
})
