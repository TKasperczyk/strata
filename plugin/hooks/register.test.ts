import { describe, expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, ModelCompleteRequest, ModelCompleteResult, Next, ProcessRunResult, SessionMessage } from 'claude-code'
import { prepareLedger, strataCompact } from './register'

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
      `--session=${SESSION}`,
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

    await strataCompact(engine, { trigger: 'manual', instructions: '- focus on db', messages: MESSAGES }, builtIn, SESSION)
    expect(models).toHaveLength(1)
    expect(models[0]?.model).toBe('sonnet')
    expect(models[0]?.prompt).toContain('focus on db')
    const planCall = calls.find(c => c.argv.includes('ledger-plan'))
    expect(planCall?.argv).toContain('--sync')
    expect(planCall?.argv).toContain('--instructions=- focus on db')
    expect(JSON.parse(planCall?.stdin ?? '{}').instructions).toBe('- focus on db')
    const compactCalls = calls.filter(c => c.argv.includes('compact'))
    const sent = JSON.parse(compactCalls[1]?.stdin ?? '{}')
    expect(compactCalls[1]?.argv).toContain('--instructions=- focus on db')
    expect(sent.instructions).toBe('- focus on db')
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

    // tool.call validation errors return structured error results without invoking CLI
    const runsBeforeErr = runs.length
    const badRange = await $.tool.call({ tool: 'mcp__strata__show', seq: 10, last_seq: 5 })
    expect(badRange.isError).toBe(true)
    expect(String(badRange.result)).toContain('last_seq (5) must be >= seq (10)')
    const badQuery = await $.tool.call({ tool: 'mcp__strata__search', query: '' })
    expect(badQuery.isError).toBe(true)
    expect(runs.length).toBe(runsBeforeErr)

    // Fractional (0, 1) limit / max_matches must not floor to 0 and fail CLI validation
    await $.tool.call({ tool: 'mcp__strata__show', seq: 5, limit: 0.5 })
    const fracShowArgv = runs.at(-1)?.argv ?? []
    expect(fracShowArgv[fracShowArgv.indexOf('--limit') + 1]).toBe('20000')
    await $.tool.call({ tool: 'mcp__strata__search', query: 'ok', max_matches: 0.5 })
    const fracSearchArgv = runs.at(-1)?.argv ?? []
    expect(fracSearchArgv).not.toContain('--max')
  })

  test('session.end (/clear) cancels queued background prep and resets pending state', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { STRATA_TRIGGER_TOKENS: '1000' })
    const runs: Call[] = []
    on('session.usage', () => ({ value: { startedAt: 0, context: { ...BREAKDOWN, tokens: 800, percent: 1 } as never, rateLimits: [] } }))
    on('session.id', () => ({ value: SESSION }))
    on('session.messages', (_$, e) => ({ value: e?.as === 'api' ? API_FORM : MESSAGES }))
    on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
    on('process.run', (_$, e) => {
      runs.push({ argv: [...e.argv], stdin: e.init?.stdin })
      return { value: cli('{}') }
    })
    on('ui.log', () => ({ value: undefined }))
    on('turn.complete', () => ({ text: 'done' }))

    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    // User runs /clear before the queued timer fires.
    await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { id: SESSION } })
    await clock.advance(0)
    expect(runs).toHaveLength(0)
  })

  test('multi-chunk ledger execution trims oversized intermediate output section-aware, keeping Current state and Open items', async () => {
    const calls: Call[] = []
    const models: ModelCompleteRequest[] = []
    const stdout = JSON.stringify({ entries: [{ keep: 2 }], stats: { rawChars: 7000, outputChars: 3500, matched: 0, previousOutput: 0, cut: 2, ledgerThrough: 2 } })
    const bigChunk1 = [
      '## Dead ends',
      ...Array.from({ length: 40 }, (_, i) => `- Old dead end ${i} ${'d'.repeat(40)} (#${i})`),
      '',
      '## Current state',
      '- CRITICAL_STATE_ALIVE (#50)',
      '',
      '## Open items',
      '- CRITICAL_TODO_ALIVE (#51)'
    ].join('\n')
    let callIdx = 0
    const engine = fakeEngine(cli(stdout), calls, [], models, {
      onRun: argv =>
        argv.includes('ledger-plan')
          ? cli(JSON.stringify({ ...SAMPLE_PLAN, maxChars: 200, chunks: ['chunk-1', 'chunk-2'] }))
          : cli(stdout),
      onModel: () => {
        callIdx++
        return { isAnswered: true as const, text: callIdx === 1 ? bigChunk1 : '## Current state\n- final (#50)', usage: ZERO_USAGE }
      }
    })
    await strataCompact(engine, { trigger: 'manual', messages: MESSAGES }, builtIn, SESSION)
    expect(models).toHaveLength(2)
    // Chunk 2's prompt must still contain Current state and Open items (not chopped off by raw slice!).
    expect(models[1]?.prompt).toContain('CRITICAL_STATE_ALIVE')
    expect(models[1]?.prompt).toContain('CRITICAL_TODO_ALIVE')
    expect(models[1]?.prompt).not.toContain('Old dead end 0 ')
  })

  test('clamps plan.maxTokens to [1, 64_000] before calling $.model.complete', async () => {
    const stdout = JSON.stringify({ entries: [{ keep: 2 }], stats: { rawChars: 7000, outputChars: 3500, matched: 0, previousOutput: 0, cut: 2, ledgerThrough: 2 } })
    const runWithMaxTokens = async (rawMaxTokens: number) => {
      const models: ModelCompleteRequest[] = []
      const engine = fakeEngine(cli(stdout), [], [], models, {
        onRun: argv =>
          argv.includes('ledger-plan') ? cli(JSON.stringify({ ...SAMPLE_PLAN, maxTokens: rawMaxTokens })) : cli(stdout)
      })
      await strataCompact(engine, { trigger: 'manual', messages: MESSAGES }, builtIn, SESSION)
      return models[0]?.maxTokens
    }

    expect(await runWithMaxTokens(120_000)).toBe(64_000)
    expect(await runWithMaxTokens(64_001)).toBe(64_000)
    expect(await runWithMaxTokens(64_000)).toBe(64_000)
    expect(await runWithMaxTokens(2_500.9)).toBe(2_500)
    expect(await runWithMaxTokens(0)).toBe(1)
    expect(await runWithMaxTokens(-50)).toBe(1)
  })

  test('passes --session=<key> across ledger-plan, ledger-save, and compact for leading-dash session keys', async () => {
    const dashSession = '-sess-with-leading-dash'
    const calls: Call[] = []
    const models: ModelCompleteRequest[] = []
    const stdout = JSON.stringify({ entries: [{ keep: 2 }], stats: { rawChars: 7000, outputChars: 3500, matched: 0, previousOutput: 0, cut: 2, ledgerThrough: 2 } })
    const engine = fakeEngine(cli(stdout), calls, [], models, {
      withSession: true,
      onRun: argv => {
        if (argv.includes('ledger-plan')) return cli(JSON.stringify(SAMPLE_PLAN))
        if (argv.includes('ledger-save')) return cli(JSON.stringify({ saved: true, through: 2 }))
        return cli(stdout)
      }
    })

    await strataCompact(engine, { trigger: 'manual', messages: MESSAGES }, builtIn, dashSession)
    await prepareLedger(engine, dashSession)
    await prepareLedger(engine, dashSession, { through: 2 })

    expect(calls.length).toBe(6)
    for (const c of calls) {
      expect(c.argv).toContain(`--session=${dashSession}`)
      expect(c.argv).not.toContain('--session')
    }
  })

  test('retries once with the lower model output limit when $.model.complete refuses maxTokens, and does not retry unrelated errors', async () => {
    const stdout = JSON.stringify({ entries: [{ keep: 2 }], stats: { rawChars: 7000, outputChars: 3500, matched: 0, previousOutput: 0, cut: 2, ledgerThrough: 2 } })
    const models: ModelCompleteRequest[] = []
    let attempt = 0
    const engine = fakeEngine(cli(stdout), [], [], models, {
      onRun: argv =>
        argv.includes('ledger-plan')
          ? cli(JSON.stringify({ ...SAMPLE_PLAN, model: 'claude-3-5-haiku-20241022', maxTokens: 64_000, chunks: ['c1', 'c2'] }))
          : cli(stdout),
      onModel: req => {
        attempt++
        if (attempt === 1) throw new Error(`maxTokens ${req.maxTokens} exceeds claude-3-5-haiku-20241022 output limit of 8,192.`)
        return { isAnswered: true as const, text: '## Current state\n- recovered (#0)', usage: ZERO_USAGE }
      }
    })
    await strataCompact(engine, { trigger: 'manual', messages: MESSAGES }, builtIn, SESSION)
    // Chunk 1 tried 64,000 -> rejected -> retried with 8,192; chunk 2 reused 8,192 directly!
    expect(models.map(m => m.maxTokens)).toEqual([64_000, 8_192, 8_192])

    // Unrelated rejections (blocked model or HTTP 400 without valid cap) must NOT retry.
    const noRetryModels: ModelCompleteRequest[] = []
    const logs: string[] = []
    const blockedEngine = fakeEngine(cli(stdout), [], logs, noRetryModels, {
      onRun: argv => (argv.includes('ledger-plan') ? cli(JSON.stringify({ ...SAMPLE_PLAN, maxTokens: 24_000 })) : cli(stdout)),
      onModel: () => {
        throw new Error('maxTokens invalid (HTTP 400)')
      }
    })
    await strataCompact(blockedEngine, { trigger: 'manual', messages: MESSAGES }, builtIn, SESSION)
    expect(noRetryModels).toHaveLength(1)
    expect(logs.some(l => l.includes('HTTP 400'))).toBe(true)
  })

  test('trimIntermediateLedger drops empty low-priority sections before trimming Current state and avoids splitting surrogate pairs', async () => {
    const models: ModelCompleteRequest[] = []
    const stdout = JSON.stringify({ entries: [{ keep: 2 }], stats: { rawChars: 7000, outputChars: 3500, matched: 0, previousOutput: 0, cut: 2, ledgerThrough: 2 } })
    const chunk1WithEmptyDeadEnds = [
      '## Dead ends',
      '',
      '## Current state',
      '- FIRST_CRITICAL_BULLET (#1)',
      `- SECOND_BULLET ${'🚀'.repeat(20)} (#2)`
    ].join('\n')
    let callIdx = 0
    const engine = fakeEngine(cli(stdout), [], [], models, {
      onRun: argv =>
        argv.includes('ledger-plan')
          // maxChars * 2 = 120: fits Current state intact (~113 chars) once empty Dead ends (14 chars) is dropped!
          ? cli(JSON.stringify({ ...SAMPLE_PLAN, maxChars: 60, chunks: ['c1', 'c2'] }))
          : cli(stdout),
      onModel: () => {
        callIdx++
        return { isAnswered: true as const, text: callIdx === 1 ? chunk1WithEmptyDeadEnds : '## Current state\n- done (#2)', usage: ZERO_USAGE }
      }
    })
    await strataCompact(engine, { trigger: 'manual', messages: MESSAGES }, builtIn, SESSION)
    expect(models).toHaveLength(2)
    expect(models[1]?.prompt).toContain('FIRST_CRITICAL_BULLET')
    expect(models[1]?.prompt).not.toContain('## Dead ends')
    expect(models[1]?.prompt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  test('logs compaction declined when compact itself exits with EXIT_DECLINED (3)', async () => {
    const logs: string[] = []
    const result = await strataCompact(fakeEngine(cli('', 3, 'oversize'), [], logs, []), { trigger: 'plugin', messages: MESSAGES }, builtIn, SESSION)
    expect(result.messages?.[0]?.text).toBe('built-in summary')
    expect(logs.some(l => l.includes('compaction declined'))).toBe(true)
  })

  test('logs recoveredTail cleanly when continuity is recovered after truncated resume', async () => {
    const logs: string[] = []
    const stdout = JSON.stringify({
      entries: [{ built: HEADER }, { keep: 2 }],
      stats: { rawChars: 14_000, outputChars: 3_500, matched: 4, recoveredTail: true, previousOutput: 20, cut: 10, ledgerThrough: 10 }
    })
    await strataCompact(fakeEngine(cli(stdout), [], logs, []), { trigger: 'plugin', messages: MESSAGES }, builtIn, SESSION)
    expect(logs.some(l => l.includes('recovered branch from 4 tail rows after truncated resume'))).toBe(true)
    expect(logs.some(l => l.includes('only 4/20'))).toBe(false)
  })

  test('surfaces background prepare failures visibly (deduplicated) and reports last prep status in /strata', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { STRATA_TRIGGER_TOKENS: '1000' })
    const visibleLogs: string[] = []
    const debugLogs: string[] = []
    let failPlan = true
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('tool.register', (_$, e) => ({ value: { tool: `mcp__strata__${e.name}` } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { ...BREAKDOWN, tokens: 800, percent: 1 } as never, rateLimits: [] } }))
    on('session.id', () => ({ value: SESSION }))
    on('session.messages', (_$, e) => ({ value: e?.as === 'api' ? API_FORM : MESSAGES }))
    on('model.complete', () => ({ value: { isAnswered: true as const, text: '## Current state\n- recovered (#0)', usage: ZERO_USAGE } }))
    on('process.run', (_$, e) => {
      if (e.argv.includes('ledger-plan')) return { value: failPlan ? cli('', 1, 'plan crashed') : cli(JSON.stringify(SAMPLE_PLAN)) }
      if (e.argv.includes('ledger-save')) return { value: cli(JSON.stringify({ saved: true, through: 2 })) }
      if (e.argv.includes('status')) {
        return {
          value: cli(
            JSON.stringify({
              sessionKey: SESSION,
              archiveCount: 10,
              archiveBytes: 2048,
              mediaCount: 0,
              branchLength: 10,
              compactions: 1,
              lastCut: 4,
              ledgerThrough: 0,
              ledgerChars: 0,
              ledgerAge: 0,
              ledgerLag: 4
            })
          )
        }
      }
      return { value: cli('{}') }
    })
    on('ui.log', (_$, e) => {
      if (e.to === 'debug') debugLogs.push(e.text)
      else visibleLogs.push(e.text)
      return { value: undefined }
    })
    on('turn.complete', () => ({ text: 'done' }))

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    // First failure surfaces visibly.
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.advance(0)
    expect(visibleLogs.filter(l => l.includes('background ledger prep failed'))).toHaveLength(1)

    // Identical repeated failure is deduplicated to debug so it does not spam the UI.
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    await clock.advance(0)
    expect(visibleLogs.filter(l => l.includes('background ledger prep failed'))).toHaveLength(1)
    expect(debugLogs.some(l => l.includes('plan crashed'))).toBe(true)

    const statusFail = await $.command.run({ command: 'strata', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    expect(statusFail.text).toContain('background prep: idle (failed: plan failed (exit 1): plan crashed)')

    // Once background prep succeeds, /strata reflects the recovered status.
    failPlan = false
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' })
    await clock.advance(0)
    const statusOk = await $.command.run({ command: 'strata', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    expect(statusOk.text).toContain('background prep: idle (saved through 2)')
  })

  test('handles ledger-save saved:false, exit-3 decline as debug skip, and ignores stale-generation prep updates after session.end', async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { STRATA_TRIGGER_TOKENS: '1000' })
    const visibleLogs: string[] = []
    const debugLogs: string[] = []
    let mode: 'declined' | 'save-skipped' | 'stale-race' = 'declined'
    let resolveSlowPlan: ((v: ProcessRunResult) => void) | undefined
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
    on('tool.register', (_$, e) => ({ value: { tool: `mcp__strata__${e.name}` } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { ...BREAKDOWN, tokens: 800, percent: 1 } as never, rateLimits: [] } }))
    on('session.id', () => ({ value: SESSION }))
    on('session.messages', (_$, e) => ({ value: e?.as === 'api' ? API_FORM : MESSAGES }))
    on('model.complete', () => ({ value: { isAnswered: true as const, text: '## Current state\n- ok (#0)', usage: ZERO_USAGE } }))
    on('process.run', async (_$, e) => {
      if (e.argv.includes('ledger-plan')) {
        if (mode === 'declined') return { value: cli('', 3, 'oversize\n  at planCompaction') }
        if (mode === 'stale-race') {
          const val = await new Promise<ProcessRunResult>(resolve => {
            resolveSlowPlan = resolve
          })
          return { value: val }
        }
        return { value: cli(JSON.stringify(SAMPLE_PLAN)) }
      }
      if (e.argv.includes('ledger-save')) {
        return { value: cli(JSON.stringify({ saved: false, reason: 'existing ready ledger covers further on this branch', through: 10 })) }
      }
      if (e.argv.includes('status')) {
        return {
          value: cli(
            JSON.stringify({
              sessionKey: SESSION,
              archiveCount: 10,
              archiveBytes: 2048,
              mediaCount: 0,
              branchLength: 10,
              compactions: 1,
              lastCut: 4,
              ledgerThrough: 0,
              ledgerChars: 0,
              ledgerAge: 0,
              ledgerLag: 4
            })
          )
        }
      }
      return { value: cli('{}') }
    })
    on('ui.log', (_$, e) => {
      if (e.to === 'debug') debugLogs.push(e.text)
      else visibleLogs.push(e.text)
      return { value: undefined }
    })
    on('turn.complete', () => ({ text: 'done' }))

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

    // 1. Exit 3 (declined) is recorded as skipped in debug, not a visible failure.
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await clock.advance(0)
    expect(visibleLogs).toHaveLength(0)
    expect(debugLogs.some(l => l.includes('declined (oversize)'))).toBe(true)
    const statusDeclined = await $.command.run({ command: 'strata', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    expect(statusDeclined.text).toContain('skipped: declined (oversize)')

    // 2. ledger-save returning { saved: false } reports skipped, not "saved through".
    mode = 'save-skipped'
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    await clock.advance(0)
    const statusSkipped = await $.command.run({ command: 'strata', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    expect(statusSkipped.text).toContain('skipped: existing ready ledger covers further on this branch')
    expect(statusSkipped.text).not.toContain('saved through')

    // 3. Stale job finishing after session.end must not clobber the new session's status or log visibly.
    mode = 'stale-race'
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' })
    clock.advance(0)
    for (let i = 0; i < 4; i++) await Promise.resolve()
    await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { id: SESSION } })
    resolveSlowPlan?.(cli('', 1, 'old session crashed'))
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(visibleLogs).toHaveLength(0)
    const statusFresh = await $.command.run({ command: 'strata', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    expect(statusFresh.text).toContain('background prep: idle')
    expect(statusFresh.text).not.toContain('old session crashed')
  })
})
