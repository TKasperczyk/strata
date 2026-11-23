import Anthropic from '@anthropic-ai/sdk'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'

// Minimal standalone Anthropic client for offline CLI / `strata replay`.
// Live Claude Code plugin sessions use `$.model.complete` directly instead.
const OAUTH_BETAS_WITH_CLAUDE_CODE = 'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14'
const OAUTH_USER_AGENT = 'claude-cli/2.1.2 (external, cli)'
export const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude."

const KEYCHAIN_SERVICE_NAMES = [
  'Claude Code-credentials',
  'Claude Code - credentials',
  'Claude Code'
]

interface OAuthCredentials {
  accessToken: string
  expiresAt?: number
  apiKey?: string
}

interface ClaudeCodeCredentials {
  claudeAiOauth?: OAuthCredentials
}

/** Minimal fetch wrapper for OAuth `/v1/messages` (requires `?beta=true`). */
function createOAuthFetch(): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const url = new URL(raw)
    if (url.pathname === '/v1/messages' && !url.searchParams.has('beta')) url.searchParams.set('beta', 'true')
    const target = typeof input === 'string' || input instanceof URL ? url.toString() : new Request(url.toString(), input)
    return globalThis.fetch(target, init)
  }
}

function loadKeychainCredentials(): OAuthCredentials | null {
  for (const service of KEYCHAIN_SERVICE_NAMES) {
    try {
      const stdout = execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      const data = JSON.parse(stdout.trim()) as unknown
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      const oauth = (data as ClaudeCodeCredentials).claudeAiOauth
      if (oauth?.apiKey || oauth?.accessToken) return oauth
    } catch {
      continue
    }
  }
  return null
}

function loadFileCredentials(): OAuthCredentials | null {
  const path = join(homedir(), '.claude', '.credentials.json')
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as ClaudeCodeCredentials
    const oauth = data.claudeAiOauth
    if (oauth?.apiKey || oauth?.accessToken) return oauth
  } catch {
    // ignore corrupt credentials file
  }
  return null
}

/** Read-only credential lookup; never mutates Claude Code's credential store. */
export function loadCredentials(): OAuthCredentials | null {
  if (platform() === 'darwin') {
    const keychain = loadKeychainCredentials()
    if (keychain) return keychain
  }
  return loadFileCredentials()
}

export async function createAnthropicClient(): Promise<Anthropic | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN
  const baseURL = process.env.ANTHROPIC_BASE_URL

  if (apiKey) {
    return new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) })
  }

  if (authToken) {
    return new Anthropic({
      authToken,
      defaultHeaders: { 'anthropic-beta': OAUTH_BETAS_WITH_CLAUDE_CODE, 'user-agent': OAUTH_USER_AGENT },
      fetch: createOAuthFetch(),
      ...(baseURL ? { baseURL } : {})
    })
  }

  const creds = loadCredentials()
  if (!creds) return null

  if (creds.apiKey) {
    return new Anthropic({ apiKey: creds.apiKey, ...(baseURL ? { baseURL } : {}) })
  }

  if (!creds.accessToken || (creds.expiresAt !== undefined && creds.expiresAt <= Date.now())) return null

  return new Anthropic({
    authToken: creds.accessToken,
    defaultHeaders: { 'anthropic-beta': OAUTH_BETAS_WITH_CLAUDE_CODE, 'user-agent': OAUTH_USER_AGENT },
    fetch: createOAuthFetch(),
    ...(baseURL ? { baseURL } : {})
  })
}
