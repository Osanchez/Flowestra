import { describe, expect, test } from 'claude-code/testing'

import type { EntryData } from './journal'
import {
  NOT_STORED,
  SECRET_PATTERNS,
  capText,
  journalPolicy,
  maskLine,
  maskSecrets,
  storedEntryData,
} from './redact'

// Obviously fake credentials, assembled from parts so this file holds no real-looking secret.
const AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP'
const GITHUB = 'ghp' + '_' + 'a1B2'.repeat(9)
const ANTHROPIC = 'sk-ant' + '-' + 'FAKE0123456789FAKE0123'
const OPENAI = 'sk' + '-' + 'FAKE0123456789FAKE0123'
const SLACK = 'xox' + 'b-' + '1234567890-FAKEFAKE'
const GOOGLE = 'AI' + 'za' + 'abcdefghij0123456789ABCDEFGHIJ01234'
const STRIPE = 'sk' + '_live_' + 'FAKEFAKEFAKE0123'
const NPM = 'npm' + '_' + 'A1'.repeat(18)
const JWT = 'eyJ' + 'hbGciOiJIUzI1NiJ9' + '.' + 'eyJ' + 'zdWIiOiJmYWtlIn0' + '.' + 'ZmFrZXNpZ25hdHVyZQ'
const KEY_BLOCK = '-----BEGIN RSA PRIVATE' + ' KEY-----\nMIIFAKEFAKEFAKE\nabc123\n-----END RSA PRIVATE' + ' KEY-----'

describe('each pattern kind is caught', () => {
  const cases: [string, string, string][] = [
    ['private-key', 'before\n' + KEY_BLOCK + '\nafter', 'before\n[redacted:private-key]\nafter'],
    ['aws-key', 'id ' + AWS + ' end', 'id [redacted:aws-key] end'],
    ['github-token', 'token ' + GITHUB, 'token [redacted:github-token]'],
    ['anthropic-key', 'key ' + ANTHROPIC, 'key [redacted:anthropic-key]'],
    ['api-key', 'key ' + OPENAI, 'key [redacted:api-key]'],
    ['slack-token', 'hook ' + SLACK, 'hook [redacted:slack-token]'],
    ['google-key', 'g ' + GOOGLE + ' x', 'g [redacted:google-key] x'],
    ['stripe-key', 'pay ' + STRIPE, 'pay [redacted:stripe-key]'],
    ['npm-token', 'npm ' + NPM, 'npm [redacted:npm-token]'],
    ['jwt', 'jwt ' + JWT, 'jwt [redacted:jwt]'],
    ['auth-header', 'Authorization: Bearer abcdef123456', 'Authorization: Bearer [redacted:auth-header]'],
    ['url-password', 'postgres://user:hunter2pw@db.example.com/app', 'postgres://user:[redacted:url-password]@db.example.com/app'],
    ['secret-value', 'PASSWORD=abc123def456ghi', 'PASSWORD=[redacted:secret-value]'],
  ]
  for (const [kind, input, expected] of cases) {
    test(kind, () => {
      const r = maskSecrets(input)
      expect(r.text).toBe(expected)
      expect(r.kinds).toEqual({ [kind]: 1 })
    })
  }

  test('the table lists every kind, anthropic before api-key', () => {
    const kinds = SECRET_PATTERNS.map(p => p.kind)
    expect(kinds).toEqual([
      'private-key', 'aws-key', 'github-token', 'anthropic-key', 'api-key', 'slack-token', 'google-key',
      'stripe-key', 'npm-token', 'jwt', 'auth-header', 'url-password', 'secret-value',
    ])
  })

  test('a quoted assignment keeps its prefix', () => {
    expect(maskSecrets('api_key: "abc123def456ghi789"').text).toBe('api_key: "[redacted:secret-value]"')
  })

  test('maskLine masks one line', () => {
    expect(maskLine('spawn ' + AWS)).toBe('spawn [redacted:aws-key]')
  })

  test('several in one text are all counted', () => {
    const r = maskSecrets(AWS + ' and ' + GITHUB + ' and ' + 'ASIA' + 'ABCDEFGHIJKLMNOP')
    expect(r.text).toBe('[redacted:aws-key] and [redacted:github-token] and [redacted:aws-key]')
    expect(r.kinds).toEqual({ 'aws-key': 2, 'github-token': 1 })
  })
})

describe('idempotence', () => {
  test('masking twice equals masking once', () => {
    const all = [KEY_BLOCK, AWS, GITHUB, ANTHROPIC, OPENAI, SLACK, GOOGLE, STRIPE, NPM, JWT,
      'Authorization: Bearer abcdef123456', 'postgres://user:hunter2pw@db.example.com/app',
      'PASSWORD=abc123def456ghi', 'api_key: "abc123def456ghi789"'].join('\n')
    const once = maskSecrets(all).text
    expect(maskSecrets(once).text).toBe(once)
    expect(maskSecrets(once).kinds).toEqual({})
  })
})

describe('ordinary text is unchanged', () => {
  const samples = [
    'const token = parseToken(input)',
    'const secret = getSecret()',
    'password = getPasswordFromVault()',
    'let password = "short"',
    'the password is hunter',
    'if (apiKey == null) throw new Error("missing api key")',
    'function sk(a: number) { return a + 1 }  // task-1 sk-short',
    'See https://example.com/docs/page and http://localhost:3000/path',
    'user@example.com wrote: Authorization is required',
    'git commit 3f786850e387550fdab836ed7e6dc881de23001b',
    'Prose with a colon: value, a list - one, two; and "quotes".',
    'secret_hash: abcdefabcdef',
  ]
  for (const s of samples) {
    test(s, () => {
      expect(maskSecrets(s).text).toBe(s)
      expect(maskSecrets(s).kinds).toEqual({})
    })
  }

  test('a long value followed by a call is left alone', () => {
    expect(maskSecrets('secret = abc123def456ghi789(x)').text).toBe('secret = abc123def456ghi789(x)')
  })

  test('a long value with no digit is left alone', () => {
    expect(maskSecrets('password = abcdefghijklmnop').text).toBe('password = abcdefghijklmnop')
  })
})

describe('capText', () => {
  test('6,000 characters or fewer are unchanged', () => {
    const s = 'a'.repeat(6000)
    expect(capText(s)).toBe(s)
    expect(capText('')).toBe('')
  })

  test('6,001 characters keep the first 4,000 and the last 2,000', () => {
    const s = 'a'.repeat(3000) + 'b'.repeat(1000) + 'c' + 'd'.repeat(1000) + 'e'.repeat(1000)
    expect(s.length).toBe(6001)
    const r = capText(s)
    expect(r).toBe(s.slice(0, 4000) + '\n[cut by the journal: 1 of 6001 characters not stored]\n' + s.slice(4001))
    expect(r.startsWith(s.slice(0, 4000))).toBe(true)
    expect(r.endsWith(s.slice(-2000))).toBe(true)
  })

  test('the marker counts the characters not stored', () => {
    const r = capText('x'.repeat(10000))
    expect(r).toContain('[cut by the journal: 4000 of 10000 characters not stored]')
  })

  test('an already capped text is unchanged', () => {
    const once = capText('x'.repeat(10000))
    expect(once.length > 6000).toBe(true)
    expect(capText(once)).toBe(once)
  })
})

const entry = (over: Partial<EntryData> = {}): EntryData => ({
  taskId: 'task-1',
  unitId: 'U1',
  label: 'Build redact',
  audit: null,
  tier: 'sonnet',
  kind: null,
  phase: null,
  wave: 1,
  agentId: 'a1',
  subagentType: null,
  model: null,
  sessionId: 's1',
  cwd: null,
  context: [],
  spawnedMs: 1000,
  endedMs: null,
  status: 'running',
  verdict: null,
  verdictMs: null,
  brief: 'brief text',
  result: null,
  resumes: [],
  ...over,
})

describe('storedEntryData', () => {
  const big = 'y'.repeat(7000)
  const d = entry({
    brief: 'use ' + AWS,
    result: big,
    resumes: [{ message: 'again ' + GITHUB, result: null }, { message: 'm', result: 'r' }],
  })

  test('full and masking off changes nothing', () => {
    expect(storedEntryData(d, { masking: false, content: 'full' })).toEqual(d)
  })

  test('full and masking on masks the brief, messages and results', () => {
    const r = storedEntryData(d, { masking: true, content: 'full' })
    expect(r.brief).toBe('use [redacted:aws-key]')
    expect(r.result).toBe(big)
    expect(r.resumes).toEqual([{ message: 'again [redacted:github-token]', result: null }, { message: 'm', result: 'r' }])
  })

  test('capped cuts long texts', () => {
    const r = storedEntryData(d, { masking: false, content: 'capped' })
    expect(r.result).toBe(capText(big))
    expect(r.brief).toBe('use ' + AWS)
  })

  test('index replaces brief, messages and non-null results; null stays null', () => {
    const r = storedEntryData(d, { masking: true, content: 'index' })
    expect(NOT_STORED).toBe('(not stored: journal content is set to index)')
    expect(r.brief).toBe('(not stored: journal content is set to index)')
    expect(r.result).toBe('(not stored: journal content is set to index)')
    expect(r.resumes).toEqual([
      { message: '(not stored: journal content is set to index)', result: null },
      { message: '(not stored: journal content is set to index)', result: '(not stored: journal content is set to index)' },
    ])
    expect(storedEntryData(entry(), { masking: false, content: 'index' }).result).toBeNull()
  })

  test('other fields and the input are untouched', () => {
    const before = JSON.stringify(d)
    const r = storedEntryData(d, { masking: true, content: 'capped' })
    expect(r.label).toBe('Build redact')
    expect(r.taskId).toBe('task-1')
    expect(JSON.stringify(d)).toBe(before)
  })

  test('storing twice equals storing once', () => {
    const p = { masking: true, content: 'capped' as const }
    const once = storedEntryData(d, p)
    expect(storedEntryData(once, p)).toEqual(once)
  })
})

describe('journalPolicy', () => {
  test('defaults', () => {
    expect(journalPolicy({})).toEqual({ masking: true, content: 'full' })
    expect(journalPolicy(undefined as never)).toEqual({ masking: true, content: 'full' })
    expect(journalPolicy(null as never)).toEqual({ masking: true, content: 'full' })
  })

  test('masking is off only for exactly false', () => {
    expect(journalPolicy({ journalMasking: false })).toEqual({ masking: false, content: 'full' })
    expect(journalPolicy({ journalMasking: 'false' })).toEqual({ masking: true, content: 'full' })
    expect(journalPolicy({ journalMasking: 0 })).toEqual({ masking: true, content: 'full' })
    expect(journalPolicy({ journalMasking: true })).toEqual({ masking: true, content: 'full' })
  })

  test('content takes one of the three strings, else full', () => {
    expect(journalPolicy({ journalContent: 'capped' }).content).toBe('capped')
    expect(journalPolicy({ journalContent: 'index' }).content).toBe('index')
    expect(journalPolicy({ journalContent: 'full' }).content).toBe('full')
    expect(journalPolicy({ journalContent: 'other' }).content).toBe('full')
    expect(journalPolicy({ journalContent: 3 }).content).toBe('full')
    expect(journalPolicy({ journalContent: [] }).content).toBe('full')
  })

  test('there is no days field', () => {
    expect(Object.keys(journalPolicy({ journalRetentionDays: 30 })).sort()).toEqual(['content', 'masking'])
  })
})
