import { describe, expect, test } from 'claude-code/testing'

import type { TaskSlot, Unit } from '../types'
import {
  CONTEXT_ITEM_CAP, CONTEXT_TOTAL_CAP, ENTRY_SPLIT_BYTES, INDEX_LINE_MAX,
  auditPath, auditTaskPart, buildEntry, configRoot, contextLine, entryContext, entryName, entryPath, escapeSections, extractContext,
  entryFromText, fitLine, hashHex, headingSection, indexText, journalRoot, lineKey, mergeShardTexts, mergeShards, parseContextItem,
  parseEntryFileName, parseShard, parseStateJson, parseStateWriter, phaseDir, phaseIndexLine, phaseIndexPath, repoIndexLine, repoIndexPath,
  repoKey, resultPartName, rootIndexLine, rootIndexPath, shardLine, shardPath, stateJson, stateJsonPath, stateMd,
  stateBakPath, stateMdPath, stateUnreadablePath, taskLineOf, phaseLineOfData, CONTEXT_STATUS, taskDir, taskIndexLine, taskIndexPath, unescapeSections, utf8Length, withContext,
} from './journal'
import type { EntryData } from './journal'

const T0 = Date.UTC(2026, 10, 15, 9, 8, 7)
const LONG = 'x'.repeat(400)

describe('repo key', () => {
  test('basename lower-cased, [a-z0-9-] only, plus 6 hex of a hash of the root', () => {
    const k = repoKey('/Users/Me/Dev/My_Repo.v2')
    expect(k).toMatch(/^my-repo-v2-[0-9a-f]{6}$/)
    expect(k).toBe(repoKey('/Users/Me/Dev/My_Repo.v2'))
  })
  test('two clones named alike get different keys', () => {
    expect(repoKey('/a/app')).not.toBe(repoKey('/b/app'))
    expect(repoKey('/a/app').startsWith('app-')).toBe(true)
  })
  test('a trailing slash, a Windows path and an empty basename', () => {
    expect(repoKey('/a/app/').startsWith('app-')).toBe(true)
    expect(repoKey('C:\\Dev\\App').startsWith('app-')).toBe(true)
    expect(repoKey('/').startsWith('repo-')).toBe(true)
  })
  test('the hash is stable and 8 hex long', () => {
    expect(hashHex('abc')).toBe('1a47e90b')
    expect(hashHex('')).toBe('811c9dc5')
  })
})

describe('names and paths', () => {
  test('entry name in UTC from epoch ms', () => {
    expect(entryName(T0, 'u3', 'a1b2c3d4e5f6')).toBe('20261115-090807-u3-a1b2c3d4')
  })
  test('every path of the layout', () => {
    const r = '/c/flowestra/journal'
    expect(rootIndexPath(r)).toBe('/c/flowestra/journal/index.md')
    expect(repoIndexPath(r, 'app-123456')).toBe('/c/flowestra/journal/app-123456/index.md')
    expect(taskDir(r, 'k', 'wb-ui')).toBe('/c/flowestra/journal/k/wb-ui')
    expect(taskIndexPath(r, 'k', 'wb-ui')).toBe('/c/flowestra/journal/k/wb-ui/index.md')
    expect(stateMdPath(r, 'k', 'wb-ui')).toBe('/c/flowestra/journal/k/wb-ui/state.md')
    expect(stateJsonPath(r, 'k', 'wb-ui')).toBe('/c/flowestra/journal/k/wb-ui/state.json')
    expect(phaseDir(r, 'k', 'wb-ui', 'testing')).toBe('/c/flowestra/journal/k/wb-ui/testing')
    expect(phaseIndexPath(r, 'k', 'wb-ui', 'testing')).toBe('/c/flowestra/journal/k/wb-ui/testing/index.md')
    expect(entryPath(r, 'k', 'wb-ui', 'testing', 'e1')).toBe('/c/flowestra/journal/k/wb-ui/testing/e1.md')
    expect(resultPartName('e1', 1)).toBe('e1.result.md')
    expect(resultPartName('e1', 2)).toBe('e1.result.2.md')
  })
  test('a folder shard path uses the first 8 characters of the session id', () => {
    expect(shardPath('/j/k/t', '0123456789abcdef')).toBe('/j/k/t/.shards/01234567.tsv')
  })
  test('a trailing slash on the root is not doubled', () => {
    expect(rootIndexPath('/j/')).toBe('/j/index.md')
  })
})

describe('config root (B3.5)', () => {
  const base = { configDir: null, home: null, userProfile: null, pluginRoot: '/plug' }
  test('CLAUDE_CONFIG_DIR when set and not empty', () => {
    expect(configRoot({ ...base, configDir: '/cfg', home: '/h' })).toBe('/cfg')
  })
  test('else HOME/.claude (an empty configDir does not count)', () => {
    expect(configRoot({ ...base, configDir: '', home: '/h' })).toBe('/h/.claude')
  })
  test('else USERPROFILE/.claude', () => {
    expect(configRoot({ ...base, home: '', userProfile: 'C:/Users/me' })).toBe('C:/Users/me/.claude')
  })
  test('else the plugin root data folder', () => {
    expect(configRoot(base)).toBe('/plug/data')
  })
  test('audit file and journal root derive from it', () => {
    expect(auditPath('/cfg', 'sess-1')).toBe('/cfg/flowestra/audit/sess-1.log')
    expect(journalRoot('/cfg')).toBe('/cfg/flowestra/journal')
  })
})

const data = (over: Partial<EntryData> = {}): EntryData => ({
  taskId: 'wb-ui', unitId: 'u3', label: 'Write reducers', audit: 'write reducers | sonnet | step 2 | tests',
  tier: 'sonnet', kind: 'implement', phase: 'executing', wave: 2,
  agentId: 'a1b2c3d4e5f6', subagentType: 'general-purpose', model: 'claude-sonnet-5-5', sessionId: 'sess-123456789',
  cwd: '/repo', context: [], spawnedMs: T0, endedMs: T0 + 5000, status: 'done', verdict: 'accepted', verdictMs: T0 + 9000,
  brief: 'Do the thing.', result: 'Done: it works.', resumes: [],
  ...over,
})

describe('entry text', () => {
  test('header lines, then Brief and Result', () => {
    const { text, parts } = buildEntry('e1', data())
    expect(parts).toEqual([])
    expect(text).toBe(
      [
        '# wb-ui · u3 · Write reducers',
        'audit: write reducers | sonnet | step 2 | tests',
        'tier: sonnet · kind: implement · phase: executing · wave: 2',
        'agent: a1b2c3d4e5f6 · type: general-purpose · model: claude-sonnet-5-5 · session: sess-123456789',
        'cwd: /repo · context: none',
        'spawned: 2026-11-15T09:08:07.000Z · ended: 2026-11-15T09:08:12.000Z · status: done',
        'verdict: accepted · at 2026-11-15T09:08:16.000Z',
        '## Brief',
        'Do the thing.',
        '## Result',
        'Done: it works.',
        '',
      ].join('\n'),
    )
  })
  test('a running, unchecked entry', () => {
    const { text } = buildEntry('e1', data({ endedMs: null, status: 'running', verdict: null, verdictMs: null, result: null, phase: null }))
    expect(text).toContain('phase: unset')
    expect(text).toContain('ended: running · status: running')
    expect(text).toContain('verdict: unchecked\n## Brief')
    expect(text.endsWith('## Result\n\n')).toBe(true)
  })
  test('a resumed run adds Message 2 and Result 2', () => {
    const { text } = buildEntry('e1', data({ resumes: [{ message: 'Continue.', result: 'More.' }] }))
    expect(text).toContain('## Result\nDone: it works.\n## Message 2\nContinue.\n## Result 2\nMore.\n')
  })
  test('the context line lists each item with its status', () => {
    const items = [{ item: 'wb:u1', status: 'inlined 12 chars' }, { item: '/d.md#x', status: 'cut at 5 of 9' }, { item: '/e.md', status: 'path only' }]
    expect(contextLine(items)).toBe('wb:u1 (inlined 12 chars), /d.md#x (cut at 5 of 9), /e.md (path only)')
    expect(contextLine([])).toBe('none')
    expect(buildEntry('e1', data({ context: items })).text).toContain('cwd: /repo · context: wb:u1 (inlined 12 chars)')
  })
  test('line breaks in a header value do not break the header', () => {
    const { text } = buildEntry('e1', data({ label: 'a\nb', audit: 'x\ny' }))
    expect(text.split('\n')[0]).toBe('# wb-ui · u3 · a b')
    expect(text.split('\n')[1]).toBe('audit: x y')
  })
  test('under 3.5 MiB stays whole', () => {
    const { parts, text } = buildEntry('e1', data({ result: 'r'.repeat(1024 * 1024) }))
    expect(parts).toEqual([])
    expect(text.length).toBeGreaterThan(1024 * 1024)
  })
  test('over 3.5 MiB splits the result into parts under 4 MiB, and the header says so', () => {
    const big = 'r'.repeat(ENTRY_SPLIT_BYTES + 10)
    const { text, parts } = buildEntry('e1', data({ result: big, resumes: [{ message: 'again', result: 'small' }] }))
    expect(parts.map(p => p.name)).toEqual(['e1.result.md', 'e1.result.2.md', 'e1.result.3.md'])
    expect(parts.map(p => p.text).join('')).toBe(big + 'small')
    for (const p of parts) expect(utf8Length(p.text)).toBeLessThan(4 * 1024 * 1024)
    expect(utf8Length(text)).toBeLessThan(4 * 1024 * 1024)
    const header = text.split('\n## Brief')[0] ?? ''
    expect(header).toContain('results: stored beside this file, over 3.5 MiB: e1.result.md, e1.result.2.md, e1.result.3.md')
    expect(text).toContain('## Result\n(stored in e1.result.md, e1.result.2.md)\n')
    expect(text).toContain('## Result 2\n(stored in e1.result.3.md)\n')
    expect(text).not.toContain('rrrrr')
  })
  test('a split counts bytes, not characters, and never cuts a surrogate pair', () => {
    const emoji = '😀' // 4 bytes, 2 UTF-16 units
    const big = emoji.repeat(Math.ceil((ENTRY_SPLIT_BYTES + 100) / 4))
    const { parts } = buildEntry('e', data({ result: big }))
    expect(parts.length).toBe(2)
    expect(parts.map(p => p.text).join('')).toBe(big)
    for (const p of parts) expect(utf8Length(p.text) <= 4 * 1024 * 1024).toBe(true)
  })
  test('utf8Length', () => {
    expect(utf8Length('aé€😀')).toBe(1 + 2 + 3 + 4)
  })
})

describe('index lines', () => {
  const all = (): string[] => [
    rootIndexLine({ repoKey: 'app-123456', root: `/${LONG}`, openTasks: 2, tasks: 5, updatedMs: T0 }),
    repoIndexLine({ taskId: 'wb-ui', status: 'open', phase: 'testing', entries: 12, updatedMs: T0, title: LONG }),
    taskIndexLine({ phase: 'testing', entries: 12, accepted: 3, rejected: 1, unchecked: 8, updatedMs: T0 }),
    phaseIndexLine({
      file: `20261115-090807-u3-a1b2c3d4.md`, unitId: 'u3', tier: 'sonnet', kind: 'implement', status: 'done',
      verdict: 'accepted', briefChars: 123456, resultChars: 654321, audit: `${LONG} | sonnet | step | check`,
    }),
  ]
  test('the fields as the spec says', () => {
    expect(rootIndexLine({ repoKey: 'app-123456', root: '/a/app', openTasks: 1, tasks: 2, updatedMs: T0 })).toBe(
      'app-123456 | /a/app | 1 | 2 | 2026-11-15T09:08:07.000Z',
    )
    expect(repoIndexLine({ taskId: 'wb-ui', status: 'closed', phase: null, entries: 3, updatedMs: T0, title: 'UI' })).toBe(
      'wb-ui | closed | unset | 3 | 2026-11-15T09:08:07.000Z | UI',
    )
    expect(taskIndexLine({ phase: 'design', entries: 1, accepted: 0, rejected: 0, unchecked: 1, updatedMs: T0 })).toBe(
      'design | 1 | 0/0/1 | 2026-11-15T09:08:07.000Z',
    )
    expect(
      phaseIndexLine({ file: 'e.md', unitId: 'u1', tier: 'haiku', kind: 'locate', status: 'running', verdict: null, briefChars: 10, resultChars: null, audit: 'find x | haiku | s | c' }),
    ).toBe('e.md | u1 | haiku | locate | running | unchecked | 10 | - | find x')
  })
  test('no line passes 160 characters with long inputs, and the key stays whole', () => {
    for (const l of all()) expect(l.length).toBeLessThanOrEqual(INDEX_LINE_MAX)
    expect(lineKey(all()[1] ?? '')).toBe('wb-ui')
    expect(lineKey(all()[3] ?? '')).toBe('20261115-090807-u3-a1b2c3d4.md')
  })
  test('the longest free-text field is cut first, ending in an ellipsis', () => {
    const l = repoIndexLine({ taskId: 'wb-ui', status: 'open', phase: 'testing', entries: 12, updatedMs: T0, title: LONG })
    expect(l.startsWith('wb-ui | open | testing | 12 | 2026-11-15T09:08:07.000Z | x')).toBe(true)
    expect(l.endsWith('…')).toBe(true)
    expect(l.length).toBe(160)
  })
  test('fitLine falls back to the other fields, then to the line', () => {
    expect(fitLine(['k', LONG, LONG], [], 50).length).toBeLessThanOrEqual(50)
    expect(fitLine([LONG, 'b'], [], 50).length).toBeLessThanOrEqual(50)
    expect(fitLine(['a', 'b'], [1], 50)).toBe('a | b')
  })
  test('a pipe, tab or newline inside a field does not add a field', () => {
    expect(fitLine(['k', 'a | b\tc\nd'], [1])).toBe('k | a / b c d')
  })
  test('audit task part is the first segment, at most 60', () => {
    expect(auditTaskPart('find x | haiku | s')).toBe('find x')
    expect(auditTaskPart(LONG).length).toBe(60)
    expect(auditTaskPart(null)).toBe('')
  })
  test('index text: first line, one line per child, the task index ends in state.md', () => {
    expect(indexText('repo', 'app-123456', ['a | 1', 'b | 2'], T0)).toBe('# repo app-123456 · 2 · updated 2026-11-15T09:08:07.000Z\na | 1\nb | 2\n')
    expect(indexText('task', 'wb-ui', ['design | 1'], T0)).toBe('# task wb-ui · 1 · updated 2026-11-15T09:08:07.000Z\ndesign | 1\nstate.md\n')
    expect(indexText('phase', 'testing', [], T0)).toBe('# phase testing · 0 · updated 2026-11-15T09:08:07.000Z\n')
  })
})

describe('shards', () => {
  test('a shard line is time, tab, key, tab, line, and parses back', () => {
    const s = shardLine(T0, 'wb-ui', 'wb-ui | open | x')
    expect(s).toBe('2026-11-15T09:08:07.000Z\twb-ui\twb-ui | open | x')
    expect(parseShard(`${s}\n`)).toEqual([{ at: '2026-11-15T09:08:07.000Z', key: 'wb-ui', line: 'wb-ui | open | x' }])
  })
  test('parsing skips blank and malformed lines', () => {
    expect(parseShard('\nnot a shard line\n2026\tonly-two\n\tk\tl\n')).toEqual([])
    expect(parseShard('2026-11-15T09:08:07.000Z\tk\tk | 1\r\n')).toEqual([{ at: '2026-11-15T09:08:07.000Z', key: 'k', line: 'k | 1' }])
  })
  test('the merge keeps the newest line per key, in key order', () => {
    const a = [shardLine(T0, 'b', 'b | old'), shardLine(T0 + 1000, 'a', 'a | new')].join('\n')
    const b = [shardLine(T0 + 2000, 'b', 'b | new'), shardLine(T0 - 1000, 'a', 'a | older'), shardLine(T0, 'c', 'c | only')].join('\n')
    expect(mergeShardTexts([a, b])).toEqual(['a | new', 'b | new', 'c | only'])
    expect(mergeShardTexts([b, a])).toEqual(['a | new', 'b | new', 'c | only'])
  })
  test('within one shard the newest line wins too; an equal time takes the later one', () => {
    const s = [shardLine(T0, 'k', 'k | 1'), shardLine(T0 + 5, 'k', 'k | 2'), shardLine(T0, 'k', 'k | 0')].join('\n')
    expect(mergeShardTexts([s])).toEqual(['k | 2'])
    expect(mergeShards([parseShard(shardLine(T0, 'k', 'k | first')), parseShard(shardLine(T0, 'k', 'k | second'))])).toEqual(['k | second'])
  })
  test('no shards, no lines', () => {
    expect(mergeShardTexts([])).toEqual([])
  })
})

const unit = (over: Partial<Unit> = {}): Unit => ({
  id: 'u1', label: 'Write reducers', wave: 1, dependsOn: ['u0'], declared: null, tier: 'sonnet', kind: 'implement',
  audit: 'a | b', verdict: 'accepted', spec: '/spec.md', context: ['wb:u0', '/d.md#x'], ...over,
})
const slot = (over: Partial<TaskSlot> = {}): TaskSlot => ({
  taskId: 'wb-ui', task: 'Build the UI', repo: '/repo', phase: 'executing', wave: 2,
  units: [unit(), unit({ id: 'u2', dependsOn: [], declared: 'pending', tier: null, kind: null, audit: null, verdict: null, spec: null, context: [] })],
  status: 'open', activeAt: 1234, ...over,
})
const input = (s: TaskSlot = slot()) => ({
  slot: s, sessionId: 'abcdefgh-1234', updatedMs: T0, unitStates: { u1: 'done', u2: 'pending' },
  latestEntries: { u1: '/j/k/wb-ui/executing/e1.md' }, recentEntries: ['/1', '/2', '/3', '/4', '/5', '/6'],
})

describe('state.md and state.json', () => {
  test('state.md: header, one line per unit, the five newest entries', () => {
    const t = stateMd(input())
    const lines = t.split('\n')
    expect(lines.slice(0, 4)).toEqual([
      'task wb-ui · open · Build the UI',
      'repo: /repo',
      'executing · wave 2',
      'updated 2026-11-15T09:08:07.000Z by session abcdefgh',
    ])
    expect(t).toContain('id | label | tier | kind | state | verdict | dependsOn | spec | latest entry')
    expect(t).toContain('u1 | Write reducers | sonnet | implement | done | accepted | u0 | /spec.md | /j/k/wb-ui/executing/e1.md')
    expect(t).toContain('u2 | Write reducers | - | - | pending | unchecked | - | - | -')
    expect(t).toContain('newest entries:\n/1\n/2\n/3\n/4\n/5\n')
    expect(t).not.toContain('/6')
  })
  test('state.md with no phase, title, repo or entries', () => {
    const t = stateMd({ ...input(slot({ phase: null, wave: null, task: null, repo: null, units: [] })), recentEntries: [] })
    expect(t).toContain('task wb-ui · open · -\nrepo: -\nunset · wave -\n')
    expect(t.endsWith('newest entries:\nnone\n')).toBe(true)
  })
  test('state.json round-trips the slot exactly', () => {
    for (const s of [slot(), slot({ status: 'closed', phase: null, wave: null, task: null, repo: null, units: [] })]) {
      expect(parseStateJson(stateJson(input(s)))).toEqual(s)
    }
  })
  test('state.json says who wrote it', () => {
    expect(parseStateWriter(stateJson(input()))).toEqual({ session: 'abcdefgh-1234', updatedMs: T0 })
    expect(parseStateWriter('{}')).toBeNull()
  })
  test('malformed or wrong-shape text parses to null, never throws', () => {
    const good = JSON.parse(stateJson(input())) as Record<string, unknown>
    const bad: string[] = [
      '', 'not json', '{', 'null', '[]', '42', '"s"', '{}', '{"shape":"state-1"}', '{"shape":"state-1","slot":null}',
      '{"shape":"state-9","slot":{}}',
      JSON.stringify({ ...good, slot: { ...slot(), status: 'weird' } }),
      JSON.stringify({ ...good, slot: { ...slot(), phase: 'nope' } }),
      JSON.stringify({ ...good, slot: { ...slot(), taskId: 7 } }),
      JSON.stringify({ ...good, slot: { ...slot(), units: [{ id: 'u1' }] } }),
      JSON.stringify({ ...good, slot: { ...slot(), units: [unit({ tier: 'gpt' as never })] } }),
      JSON.stringify({ ...good, slot: { ...slot(), units: [unit({ context: [1] as never })] } }),
      JSON.stringify({ ...good, slot: { ...slot(), units: 'x' } }),
      JSON.stringify({ ...good, slot: { ...slot(), activeAt: 'now' } }),
    ]
    for (const t of bad) expect(parseStateJson(t)).toBeNull()
  })
})

describe('context items', () => {
  test('a task:unit pair is an entry', () => {
    expect(parseContextItem('wb-ui:u3')).toEqual({ kind: 'entry', taskId: 'wb-ui', unitId: 'u3' })
  })
  test('an absolute path, with or without a heading', () => {
    expect(parseContextItem('/a/b.md')).toEqual({ kind: 'path', path: '/a/b.md', heading: null })
    expect(parseContextItem('/a/b.md#Build decisions')).toEqual({ kind: 'path', path: '/a/b.md', heading: 'Build decisions' })
    expect(parseContextItem('/a/b.md#')).toEqual({ kind: 'path', path: '/a/b.md', heading: null })
    expect(parseContextItem('C:\\a\\b.md')).toEqual({ kind: 'path', path: 'C:\\a\\b.md', heading: null })
  })
  test('anything else is null', () => {
    expect(parseContextItem('')).toBeNull()
    expect(parseContextItem('rel/path.md')).toBeNull()
    expect(parseContextItem('wb-ui:')).toBeNull()
  })
})

const DOC = ['# Title', 'intro', '## A', 'a body', '```', '## not a heading', '```', '### A1', 'deep', '## B', 'b body', '# Top', 'top body'].join('\n')

describe('extraction rules', () => {
  test('path#heading: the section up to the next heading of the same or a higher level', () => {
    expect(headingSection(DOC, 'A')).toBe('## A\na body\n```\n## not a heading\n```\n### A1\ndeep')
    expect(headingSection(DOC, '## b')).toBe('## B\nb body')
    expect(headingSection(DOC, 'A1')).toBe('### A1\ndeep')
    expect(headingSection(DOC, 'Top')).toBe('# Top\ntop body')
    expect(headingSection(DOC, 'Missing')).toBeNull()
  })
  test('0.14.0: a dated heading (a decisions entry) runs to the next dated heading, past its own inner headings', () => {
    const doc = ['# Decisions', '## 2026-11-16 · New', 'intro', '## 1. Inner', 'inner body', '### U1 · Unit', 'unit body', '---', '## 2026-11-15 · Old', 'old body', '## Inner of old', 'x'].join('\n')
    expect(headingSection(doc, '2026-11-16 · New')).toBe('## 2026-11-16 · New\nintro\n## 1. Inner\ninner body\n### U1 · Unit\nunit body\n---')
    expect(headingSection(doc, '2026-11-15 · Old')).toBe('## 2026-11-15 · Old\nold body\n## Inner of old\nx')
    expect(headingSection(doc, 'U1 · Unit')).toBe('### U1 · Unit\nunit body\n---')
    expect(headingSection(doc, '1. Inner')).toBe('## 1. Inner\ninner body\n### U1 · Unit\nunit body\n---')
    const higher = ['## 2026-11-16 · New', 'a', '## inner', 'b', '# Appendix', 'c'].join('\n')
    expect(headingSection(higher, '2026-11-16 · New')).toBe('## 2026-11-16 · New\na\n## inner\nb')
  })
  test('a journal entry gives its header and Result, not Brief or Message', () => {
    const { text } = buildEntry('e1', data({ brief: 'SECRET BRIEF', resumes: [{ message: 'SECRET MSG', result: 'second' }] }))
    const got = entryContext(text)
    expect(got).toContain('# wb-ui · u3 · Write reducers')
    expect(got).toContain('verdict: accepted')
    expect(got).toContain('## Result\nDone: it works.')
    expect(got).toContain('## Result 2\nsecond')
    expect(got).not.toContain('SECRET')
    expect(got).not.toContain('## Brief')
  })
  test('extractContext dispatches on the item: entry, heading, whole text', () => {
    const { text } = buildEntry('e1', data())
    expect(extractContext({ kind: 'entry', taskId: 'wb-ui', unitId: 'u3' }, text)).toBe(entryContext(text))
    expect(extractContext({ kind: 'path', path: '/d.md', heading: 'B' }, DOC)).toBe('## B\nb body')
    expect(extractContext({ kind: 'path', path: '/d.md', heading: 'Nope' }, DOC)).toBeNull()
    expect(extractContext({ kind: 'path', path: '/d.md', heading: null }, DOC)).toBe(DOC)
  })
})

describe('escaped section lines', () => {
  test('each kind of section line gets one backslash, and loses it again', () => {
    for (const l of ['## Brief', '## Result', '## Result 2', '## Message 12']) {
      expect(escapeSections(l)).toBe(`\\${l}`)
      expect(unescapeSections(`\\${l}`)).toBe(l)
    }
  })
  test('a line with trailing spaces counts; text around it is kept', () => {
    expect(escapeSections('a\n## Result  \t\nb')).toBe('a\n\\## Result  \t\nb')
    expect(unescapeSections('a\n\\## Result  \nb')).toBe('a\n## Result  \nb')
  })
  test('already-backslashed lines get one more, and give one back', () => {
    expect(escapeSections('\\## Brief\n\\\\## Result 3')).toBe('\\\\## Brief\n\\\\\\## Result 3')
    expect(unescapeSections('\\\\## Brief')).toBe('\\## Brief')
  })
  test('a text with no section line is unchanged; look-alikes are not section lines', () => {
    const t = 'plain\n## Results\n## Result x\n ## Brief\n## Message\n### Result\n\\## Other'
    expect(escapeSections(t)).toBe(t)
    expect(unescapeSections(t)).toBe(t)
    expect(unescapeSections('## Result')).toBe('## Result') // no backslash: left alone
  })
  test('the round trip holds', () => {
    const t = ['## Brief', '\\## Result', '\\\\## Message 2  ', 'x', '## Result 10', '', '## Result'].join('\n')
    expect(unescapeSections(escapeSections(t))).toBe(t)
    expect(unescapeSections(escapeSections(''))).toBe('')
  })
  test('buildEntry escapes brief, messages and results; entryContext gives a result back whole and exact', () => {
    const result = 'start\n## Result\nmiddle\n## Message 2\n\\## Brief\nend'
    const { text } = buildEntry('e1', data({ brief: '## Brief\nreal', result, resumes: [{ message: '## Result 2', result }] }))
    expect(text).toContain('## Brief\n\\## Brief\nreal\n## Result\nstart\n\\## Result\n')
    expect(text).toContain('## Message 2\n\\## Result 2\n## Result 2\nstart\n')
    const got = entryContext(text)
    expect(got).toContain(`## Result\n${result}\n## Result 2\n${result}`)
    expect(got.endsWith(result)).toBe(true)
    expect(got).not.toContain('real')
  })
  test('a split result is stored escaped', () => {
    const { parts } = buildEntry('e1', data({ result: `## Result\n${'r'.repeat(ENTRY_SPLIT_BYTES)}` }))
    expect(parts[0]?.text.startsWith('\\## Result\n')).toBe(true)
  })
})

describe('context block (W3)', () => {
  test('no items: the prompt is unchanged', () => {
    expect(withContext('P', [])).toEqual({ prompt: 'P', status: [] })
  })
  test('appends a heading line and the text per item, with status', () => {
    const r = withContext('Do it.', [{ item: 'a', path: '/a.md', text: 'AAA' }, { item: 'b', path: '/b.md', text: 'BB' }])
    expect(r.prompt).toBe('Do it.\n\nContext (inlined by the Agent Board from /a.md):\nAAA\n\nContext (inlined by the Agent Board from /b.md):\nBB')
    expect(r.status).toEqual([{ item: 'a', status: 'inlined 3 chars' }, { item: 'b', status: 'inlined 2 chars' }])
  })
  test('an item over 32,000 characters is cut, with the marker', () => {
    const text = 'y'.repeat(CONTEXT_ITEM_CAP + 500)
    const r = withContext('P', [{ item: 'a', path: '/a.md', text }])
    expect(r.status).toEqual([{ item: 'a', status: `cut at ${CONTEXT_ITEM_CAP} of ${CONTEXT_ITEM_CAP + 500}` }])
    expect(r.prompt.endsWith(`\n[cut at ${CONTEXT_ITEM_CAP} of ${CONTEXT_ITEM_CAP + 500} characters; the rest is at /a.md]`)).toBe(true)
    expect(r.prompt).toContain('y'.repeat(CONTEXT_ITEM_CAP))
    expect(r.prompt).not.toContain('y'.repeat(CONTEXT_ITEM_CAP + 1))
  })
  test('exactly 32,000 characters is not cut', () => {
    const r = withContext('P', [{ item: 'a', path: '/a.md', text: 'y'.repeat(CONTEXT_ITEM_CAP) }])
    expect(r.status).toEqual([{ item: 'a', status: `inlined ${CONTEXT_ITEM_CAP} chars` }])
    expect(r.prompt).not.toContain('[cut')
  })
  test('the total cap is 96,000 in the order given; past it, path only', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map(k => ({ item: k, path: `/${k}.md`, text: k.repeat(CONTEXT_ITEM_CAP - 10_000) }))
    const r = withContext('P', items)
    expect(CONTEXT_TOTAL_CAP).toBe(96_000)
    // 22,000 each: a, b, c, d fit (88,000); e gets the 8,000 left
    expect(r.status.map(s => s.status)).toEqual([
      'inlined 22000 chars', 'inlined 22000 chars', 'inlined 22000 chars', 'inlined 22000 chars', 'cut at 8000 of 22000',
    ])
    const more = withContext('P', [...items, { item: 'f', path: '/f.md', text: 'fff' }])
    expect(more.status[5]).toEqual({ item: 'f', status: 'path only' })
    expect(more.prompt).toContain('Context (inlined by the Agent Board from /f.md):\n[cut at 0 of 3 characters; the rest is at /f.md]')
  })
  test('the total of inlined text never passes 96,000', () => {
    const items = [1, 2, 3, 4].map(i => ({ item: `i${i}`, path: `/${i}.md`, text: 'z'.repeat(CONTEXT_ITEM_CAP * 2) }))
    const r = withContext('', items)
    expect(r.prompt.split('z').length - 1).toBe(CONTEXT_TOTAL_CAP)
    expect(r.status.map(s => s.status)).toEqual([
      'cut at 32000 of 64000', 'cut at 32000 of 64000', 'cut at 32000 of 64000', 'path only',
    ])
  })
})

describe('U3 additions (0.11.0): file names, state copies, moved line logic', () => {
  test('parseEntryFileName: a real name gives the unit id and the 8-character agent part', () => {
    const name = `${entryName(T0, 'u3', 'a1b2c3d4e5f6')}.md`
    expect(name).toBe('20261115-090807-u3-a1b2c3d4.md')
    expect(parseEntryFileName(name)).toEqual({ unitId: 'u3', agent8: 'a1b2c3d4' })
  })
  test('parseEntryFileName: unit ids and agent parts that hold dashes', () => {
    expect(parseEntryFileName(`${entryName(T0, 'wb-ui-u-2', 'agent-abcdef12')}.md`)).toEqual({ unitId: 'wb-ui-u-2', agent8: 'agent-ab' })
    expect(parseEntryFileName('20261115-090807-u-x-12345678.md')).toEqual({ unitId: 'u-x', agent8: '12345678' })
    expect(parseEntryFileName('20261115-090807-u-x-1-2-3-4-.md')).toEqual({ unitId: 'u-x', agent8: '1-2-3-4-' })
  })
  test('parseEntryFileName: rejects part files, index.md, state.md, short names and other shapes', () => {
    const e = entryName(T0, 'u3', 'a1b2c3d4')
    for (const n of [
      `${e}.result.md`, `${e}.result.2.md`, `${e}.result.10.md`, 'index.md', 'state.md', 'state.json', '.shards', '',
      '20261115-090807-u3-a1b2c3d4', '20261115-090807-u3-a1b2c3d4.txt',
      '20261115-090807--a1b2c3d4.md', '20261115-090807-u3-a1b2c3d.md', '20261115-090807-a1b2c3d4.md',
      'x0261115-090807-u3-a1b2c3d4.md', '20261115_090807-u3-a1b2c3d4.md', '20261115-090807-u3_a1b2c3d4.md',
    ]) expect(parseEntryFileName(n)).toBeNull()
  })
  test('state copy paths', () => {
    expect(stateBakPath('/j', 'app-123456', 'wb-ui')).toBe('/j/app-123456/wb-ui/state.bak.json')
    expect(stateUnreadablePath('/j', 'app-123456', 'wb-ui', T0)).toBe('/j/app-123456/wb-ui/state.unreadable-20261115-090807.json')
  })
  test('phaseLineOfData is the documented phase line for the data, in the same fields', () => {
    const d = data()
    const line = phaseLineOfData('20261115-090807-u3-a1b2c3d4.md', d)
    expect(line).toBe(`20261115-090807-u3-a1b2c3d4.md | ${d.unitId} | sonnet | implement | done | accepted | ${d.brief.length} | ${'Done: it works.'.length} | write reducers`)
    expect(line).toBe(phaseIndexLine({
      file: '20261115-090807-u3-a1b2c3d4.md', unitId: d.unitId, tier: 'sonnet', kind: 'implement', status: 'done', verdict: 'accepted',
      briefChars: d.brief.length, resultChars: 15, audit: d.audit,
    }))
  })
  test('phaseLineOfData sums the results of every run, and shows dashes for none', () => {
    const d = data({ resumes: [{ message: 'm', result: 'more' }, { message: 'n', result: null }] })
    expect(phaseLineOfData('f.md', d).split(' | ')[7]).toBe(String('Done: it works.'.length + 4))
    const none = phaseLineOfData('f.md', data({ result: null, resumes: [], verdict: null, tier: null, kind: null, audit: null, status: 'running' }))
    expect(none.startsWith(`f.md | u3 | - | - | running | unchecked | ${'Do the thing.'.length} | - |`)).toBe(true)
  })
  test('taskLineOf counts the verdicts of the phase lines', () => {
    const lines = [
      'a.md | u1 | sonnet | implement | done | accepted | 1 | 2 | x',
      'b.md | u2 | sonnet | implement | done | rejected | 1 | 2 | x',
      'c.md | u3 | sonnet | implement | done | unchecked | 1 | 2 | x',
      'd.md | u4 | sonnet | implement | done | accepted | 1 | 2 | x',
    ]
    expect(taskLineOf('executing', lines, T0)).toBe('executing | 4 | 2/1/1 | 2026-11-15T09:08:07.000Z')
    expect(taskLineOf('testing', [], T0)).toBe('testing | 0 | 0/0/0 | 2026-11-15T09:08:07.000Z')
  })
  test('entryFromText round-trips an entry built by buildEntry, with its context items', () => {
    const d = data({
      context: [{ item: '/docs/d.md#A', status: 'inlined 19 chars' }, { item: 'wb-ui:u-1', status: 'cut at 32000 of 40000' }, { item: '/f.md', status: 'path only' }],
      resumes: [{ message: 'one more', result: 'more answer' }],
    })
    expect(entryFromText(buildEntry('e1', d).text)).toEqual(d)
    const running = data({ endedMs: null, status: 'running', verdict: null, verdictMs: null, result: null, phase: null, wave: null })
    expect(entryFromText(buildEntry('e1', running).text)).toEqual(running)
    expect(entryFromText('not an entry')).toBeNull()
    expect(entryFromText('')).toBeNull()
  })
  test('CONTEXT_STATUS reads the three status forms of the context line', () => {
    const got = [...'a (inlined 5 chars), b (cut at 2 of 9), c d (path only)'.matchAll(CONTEXT_STATUS)].map(m => [m[1], m[2]])
    expect(got).toEqual([['a', 'inlined 5 chars'], ['b', 'cut at 2 of 9'], ['c d', 'path only']])
  })
  test('torn input: an entry cut inside its header parses to null', () => {
    const text = buildEntry('e1', data()).text
    expect(entryFromText(text.slice(0, text.indexOf('verdict:') + 4))).toBeNull()
    expect(entryFromText(text.slice(0, text.indexOf('## Brief') - 1))).toBeNull()
    expect(entryFromText(text.slice(0, 30))).toBeNull()
  })
  test('torn input: an entry cut inside its result parses, with the shorter result', () => {
    const d = data({ result: 'abcdefghij'.repeat(10) })
    const text = buildEntry('e1', d).text
    const cut = text.indexOf('## Result\n') + '## Result\n'.length + 30
    const got = entryFromText(text.slice(0, cut))
    expect(got).not.toBeNull()
    expect(got?.result).toBe('abcdefghij'.repeat(3))
    expect(got?.brief).toBe(d.brief)
  })
  test('torn input: a state.json cut half way parses to null', () => {
    const full = stateJson(input())
    expect(parseStateJson(full)).not.toBeNull()
    expect(parseStateJson(full.slice(0, Math.floor(full.length / 2)))).toBeNull()
  })
  test('torn input: a shard line cut in its third field is still kept, with the cut line', () => {
    const line = shardLine(T0, 'k', 'k | a | b | c | d | e')
    const cut = line.slice(0, line.length - 6)
    expect(cut.split('\t')).toHaveLength(3)
    expect(parseShard(cut)).toEqual([{ at: '2026-11-15T09:08:07.000Z', key: 'k', line: 'k | a | b | c |' }])
    expect(parseShard(line.slice(0, line.lastIndexOf('\t') + 1))).toEqual([])
  })
})
