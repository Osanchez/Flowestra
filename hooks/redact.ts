// Journal masking and storing less (0.11.0, decisions.md "Journal hardening: cleanup,
// masking, and multi-session fixes", section 3.5, as amended by A1: no retention).
// Pure: type-only imports, no `$`, no side effects.

import type { PluginOptions } from 'claude-code'
import type { EntryData } from './journal'

export type JournalPolicy = { masking: boolean; content: 'full' | 'capped' | 'index' }

const CONTENT_MODES: readonly string[] = ['full', 'capped', 'index']

// masking is on unless the setting is exactly `false`; content is the value when it is one
// of the three modes, else `full`. Never throws.
export const journalPolicy = (options: PluginOptions): JournalPolicy => {
  const o = options as Record<string, unknown> | null | undefined
  const c = o?.journalContent
  return {
    masking: o?.journalMasking !== false,
    content: typeof c === 'string' && CONTENT_MODES.includes(c) ? (c as JournalPolicy['content']) : 'full',
  }
}

// ---------------------------------------------------------------- masking

export type SecretPattern = {
  kind: string
  re: RegExp
  // Builds the replacement from the regex's match arguments; null keeps the match as is.
  replace: (args: string[]) => string | null
}

const tag = (kind: string): string => `[redacted:${kind}]`

const whole = (kind: string) => (): string => tag(kind)
// Keeps the first captured group, masks the rest.
const keepFirst = (kind: string) => (a: string[]): string => (a[1] ?? '') + tag(kind)

// In this order: anthropic-key before api-key.
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replace: whole('private-key') },
  { kind: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: whole('aws-key') },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g, replace: whole('github-token') },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, replace: whole('anthropic-key') },
  { kind: 'api-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, replace: whole('api-key') },
  { kind: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: whole('slack-token') },
  { kind: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: whole('google-key') },
  { kind: 'stripe-key', re: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}/g, replace: whole('stripe-key') },
  { kind: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: whole('npm-token') },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: whole('jwt') },
  {
    kind: 'auth-header',
    re: /\b((?:proxy-)?authorization\s*[:=]\s*(?:bearer|basic|token)\s+)[A-Za-z0-9._~+\/=-]{8,}/gi,
    replace: keepFirst('auth-header'),
  },
  {
    kind: 'url-password',
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:\/@]+:)[^\s@\/]{3,}(@)/gi,
    replace: a => (a[1] ?? '') + tag('url-password') + (a[2] ?? ''),
  },
  {
    kind: 'secret-value',
    re: /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|passw(?:or)?d|access[_-]?token|auth[_-]?token|private[_-]?key)[A-Za-z0-9_.-]*\s*[:=]\s*["']?)([A-Za-z0-9+\/_.=-]{12,})/gi,
    // Only a value holding a digit and a letter; maskSecrets also skips a value followed by `(` (a call).
    replace: a => {
      const value = a[2] ?? ''
      return /\d/.test(value) && /[A-Za-z]/.test(value) ? (a[1] ?? '') + tag('secret-value') : null
    },
  },
]

/** Replaces each credential-shaped match by `[redacted:<kind>]`; `kinds` counts the matches per kind. */
export function maskSecrets(text: string): { text: string; kinds: Record<string, number> } {
  const kinds: Record<string, number> = {}
  let out = text
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.re, (...args: unknown[]) => {
      // args: match, groups..., offset, string (no named groups in these patterns).
      const str = args[args.length - 1] as string
      const offset = args[args.length - 2] as number
      const match = args[0] as string
      const groups = args.slice(0, args.length - 2) as string[]
      if (p.kind === 'secret-value' && str.charAt(offset + match.length) === '(') return match
      const r = p.replace(groups)
      if (r === null) return match
      if (r !== match) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1
      return r
    })
  }
  return { text: out, kinds }
}

/** Masks one line (an audit line). */
export const maskLine = (text: string): string => maskSecrets(text).text

// ---------------------------------------------------------------- storing less

const CAP_OVER = 6000
const CAP_HEAD = 4000
const CAP_TAIL = 2000
const CUT_MARKER = /^\[cut by the journal: \d+ of \d+ characters not stored\]$/m

/** A text over 6,000 characters becomes its first 4,000, a marker line, and its last 2,000. Idempotent. */
export function capText(text: string): string {
  if (text.length <= CAP_OVER) return text
  if (CUT_MARKER.test(text)) return text
  const cut = text.length - CAP_HEAD - CAP_TAIL
  return text.slice(0, CAP_HEAD) + `\n[cut by the journal: ${cut} of ${text.length} characters not stored]\n` + text.slice(text.length - CAP_TAIL)
}

export const NOT_STORED = '(not stored: journal content is set to index)'

/** The entry data as it is written to the journal: stored less per `policy.content`, then masked when `policy.masking`. */
export function storedEntryData(d: EntryData, policy: JournalPolicy): EntryData {
  const text = (s: string): string => {
    const t = policy.content === 'index' ? NOT_STORED : policy.content === 'capped' ? capText(s) : s
    return policy.masking ? maskSecrets(t).text : t
  }
  const result = (r: string | null): string | null => (r === null ? null : text(r))
  return {
    ...d,
    brief: text(d.brief),
    result: result(d.result),
    resumes: d.resumes.map(r => ({ message: text(r.message), result: result(r.result) })),
  }
}
