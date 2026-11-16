import { expect, test } from 'claude-code/testing'

import type { AgentBox, Board, LogEntry, TaskSlot, Unit } from '../types'
import { LOG_MAX, LOG_SHAPE, emptyLog, logDiff, logPush } from './log'
import { MAIN_ID, emptyBoard } from './state'

const T0 = 1_000_000
const AT = T0 + 50_000

const mk = (id: string, over: Partial<AgentBox> = {}): AgentBox => ({
  id,
  label: `Do ${id}`,
  type: 'general-purpose',
  model: 'claude-opus-5-5',
  unitId: null,
  name: null,
  parentId: null,
  status: 'running',
  reason: null,
  tokens: null,
  tokensPartial: false,
  startedAt: T0,
  endedAt: null,
  lastEventAt: null,
  lastTool: null,
  briefChars: null,
  resultChars: null,
  flow: { dir: null, at: null },
  taskId: null,
  routed: null,
  peakIn: null,
  ...over,
})

const boardOf = (boxes: AgentBox[], over: Partial<Board> = {}): Board => {
  const b = emptyBoard(T0)
  for (const x of boxes) {
    b.agents[x.id] = x
    b.order.push(x.id)
  }
  return { ...b, ...over }
}

const HAIKU = 'claude-haiku-5-5-20261001'
const SONNET = 'claude-sonnet-5-5'
const OPUS_AUDIT = 'design the log | opus | §2 trigger: design work | orchestrator reviews'
const SONNET_AUDIT = 'write the tests | sonnet | §1 step 3: one repo, criteria written | plugin test run'
const HAIKU_AUDIT = 'find callers | haiku | §1 step 2: read-only lookup | lead re-greps'

const unit = (id: string, over: Partial<Unit> = {}): Unit => ({
  id,
  label: `Unit ${id}`,
  wave: 1,
  dependsOn: [],
  declared: null,
  tier: 'opus',
  kind: 'design',
  audit: OPUS_AUDIT,
  verdict: null,
  spec: null,
  context: [],
  ...over,
})

const sonnetUnit = (id: string, over: Partial<Unit> = {}): Unit => unit(id, { tier: 'sonnet', kind: 'tests', audit: SONNET_AUDIT, ...over })
const haikuUnit = (id: string, over: Partial<Unit> = {}): Unit => unit(id, { tier: 'haiku', kind: 'locate', audit: HAIKU_AUDIT, ...over })
/** A unit the orchestrator carries out itself: no tier. */
const ownUnit = (id: string, over: Partial<Unit> = {}): Unit =>
  unit(id, { tier: null, kind: null, audit: null, declared: 'pending', ...over })

/** The entries without the audit ones, for tests about something else. */
const noAudit = (entries: LogEntry[]): LogEntry[] => entries.filter(e => e.kind !== 'audit')
const NO_AUDIT = 'no audit line (policy §9)'

const entry = (n: number): LogEntry => ({ at: n, kind: 'phase', who: 'lead', text: `phase → ${n}` })

test('the log starts empty under its own shape tag', () => {
  expect(LOG_SHAPE).toBe('log-1')
  expect(LOG_MAX).toBe(50)
  expect(emptyLog()).toEqual({ entries: [] })
})

test('logPush appends, keeps the newest 50, and hands back the same object for nothing', () => {
  const log = emptyLog()
  expect(logPush(log, [])).toBe(log)
  const one = logPush(log, [entry(1), entry(2)])
  expect(one.entries.map(e => e.at)).toEqual([1, 2])
  expect(log.entries).toEqual([]) // not changed in place
  let many = emptyLog()
  for (let i = 0; i < 60; i++) many = logPush(many, [entry(i)])
  expect(many.entries).toHaveLength(50)
  expect(many.entries[0]!.at).toBe(10)
  expect(many.entries[49]!.at).toBe(59)
  const big = logPush(emptyLog(), Array.from({ length: 70 }, (_, i) => entry(i)))
  expect(big.entries.map(e => e.at)).toEqual(Array.from({ length: 50 }, (_, i) => i + 20))
})

// ---- spawned ----

test('logDiff: a new worker is spawned, with its model; with no unit it has no audit line; the lead is never logged', () => {
  const before = boardOf([])
  const after = boardOf([mk(MAIN_ID, { label: 'Orchestrator' }), mk('w1', { status: 'starting' }), mk('w2', { model: null })])
  expect(logDiff(before, after, AT)).toEqual([
    { at: AT, kind: 'spawned', who: 'Do w1', text: 'spawned · Opus 5.5' },
    { at: AT, kind: 'audit', who: 'Do w1', text: NO_AUDIT },
    { at: AT, kind: 'spawned', who: 'Do w2', text: 'spawned · model n/a' },
    { at: AT, kind: 'audit', who: 'Do w2', text: NO_AUDIT },
  ])
})

test('logDiff: spawned carries the linked unit\'s kind when it has one, and nothing when it has none', () => {
  const after = boardOf(
    [
      mk('o', { unitId: 'u1' }),
      mk('s', { model: SONNET, unitId: 'u2' }),
      mk('h', { model: HAIKU, unitId: 'u3' }),
      mk('n', { unitId: 'own' }),
      mk('x', { unitId: 'gone' }),
    ],
    { units: [unit('u1'), sonnetUnit('u2', { kind: 'implement' }), haikuUnit('u3'), ownUnit('own')] },
  )
  expect(logDiff(boardOf([]), after, AT).filter(e => e.kind === 'spawned')).toEqual([
    { at: AT, kind: 'spawned', who: 'Do o', text: 'spawned · Opus 5.5 · design' },
    { at: AT, kind: 'spawned', who: 'Do s', text: 'spawned · Sonnet 5.5 · implement' },
    { at: AT, kind: 'spawned', who: 'Do h', text: 'spawned · Haiku 5.5 · locate' },
    { at: AT, kind: 'spawned', who: 'Do n', text: 'spawned · Opus 5.5' },
    { at: AT, kind: 'spawned', who: 'Do x', text: 'spawned · Opus 5.5' },
  ])
})

test('logDiff: a unit object missing the new fields reads as a unit with no tier', () => {
  const old = { id: 'u1', label: 'Old unit', wave: 1, dependsOn: [], declared: null } as unknown as Unit
  const after = boardOf([mk('w', { unitId: 'u1' })], { units: [old] })
  expect(logDiff(boardOf([]), after, AT)).toEqual([
    { at: AT, kind: 'spawned', who: 'Do w', text: 'spawned · Opus 5.5' },
    { at: AT, kind: 'audit', who: 'Do w', text: NO_AUDIT },
  ])
})

// ---- ended ----

test('logDiff: a worker that ends: done, failed with and without a reason, stopped', () => {
  const before = boardOf([mk('d'), mk('f'), mk('g', { status: 'waiting' }), mk('s', { status: 'starting' })])
  const after = boardOf([
    mk('d', { status: 'done', endedAt: T0 + 123_000 }),
    mk('f', { status: 'failed', endedAt: T0 + 5000, reason: 'error' }),
    mk('g', { status: 'failed', endedAt: T0 + 5000 }),
    mk('s', { status: 'stopped', endedAt: T0 + 45_000 }),
  ])
  expect(logDiff(before, after, AT)).toEqual([
    { at: AT, kind: 'done', who: 'Do d', text: 'done · 2m 03s' },
    { at: AT, kind: 'failed', who: 'Do f', text: 'failed: error' },
    { at: AT, kind: 'failed', who: 'Do g', text: 'failed · 5s' },
    { at: AT, kind: 'stopped', who: 'Do s', text: 'stopped · 45s' },
  ])
})

test('logDiff: a done Sonnet box reads "· draft"; Opus and Haiku boxes do not', () => {
  const units = [unit('u1'), sonnetUnit('u2'), haikuUnit('u3')]
  const before = boardOf(
    [mk('o', { unitId: 'u1' }), mk('s', { model: SONNET, unitId: 'u2' }), mk('h', { model: HAIKU, unitId: 'u3' }), mk('t', { model: null, unitId: 'u2' })],
    { units },
  )
  const after = boardOf(
    [
      mk('o', { unitId: 'u1', status: 'done', endedAt: T0 + 20_000 }),
      mk('s', { model: SONNET, unitId: 'u2', status: 'done', endedAt: T0 + 20_000 }),
      mk('h', { model: HAIKU, unitId: 'u3', status: 'done', endedAt: T0 + 20_000 }),
      mk('t', { model: null, unitId: 'u2', status: 'done', endedAt: null }),
    ],
    { units },
  )
  expect(logDiff(before, after, AT)).toEqual([
    { at: AT, kind: 'done', who: 'Do o', text: 'done · 20s' },
    { at: AT, kind: 'done', who: 'Do s', text: 'done · 20s · draft' },
    { at: AT, kind: 'done', who: 'Do h', text: 'done · 20s' },
    { at: AT, kind: 'done', who: 'Do t', text: 'done · draft' },
  ])
  // a Sonnet box that fails or stops is not a draft
  const failed = boardOf([mk('s', { model: SONNET, unitId: 'u2', status: 'failed', endedAt: T0 + 20_000 })], { units })
  expect(logDiff(before, failed, AT).map(e => e.text)).toEqual(['failed · 20s'])
})

test('logDiff: the elapsed part is left out when either time is unknown', () => {
  const before = boardOf([mk('a'), mk('b')])
  const after = boardOf([mk('a', { status: 'done', endedAt: null }), mk('b', { status: 'stopped', startedAt: null, endedAt: T0 })])
  expect(logDiff(before, after, AT).map(e => e.text)).toEqual(['done', 'stopped'])
})

test('logDiff: a box both new and already ended gives the spawn, then its audit, then the end', () => {
  const after = boardOf([mk('x', { status: 'done', endedAt: T0 + 1000, unitId: 'u1' })], { units: [unit('u1')] })
  expect(logDiff(boardOf([]), after, AT)).toEqual([
    { at: AT, kind: 'spawned', who: 'Do x', text: 'spawned · Opus 5.5 · design' },
    { at: AT, kind: 'audit', who: 'Do x', text: OPUS_AUDIT },
    { at: AT, kind: 'done', who: 'Do x', text: 'done · 1s' },
  ])
})

test('logDiff: an ended box that stays ended, or changes how it ended, is not logged again', () => {
  const before = boardOf([mk('a', { status: 'done', endedAt: T0 }), mk('b', { status: 'done', endedAt: T0 })])
  const after = boardOf([mk('a', { status: 'done', endedAt: T0 }), mk('b', { status: 'failed', endedAt: T0 })])
  expect(logDiff(before, after, AT)).toEqual([])
})

// ---- phase and the rest ----

test('logDiff: a phase change to a set phase; cleared or unchanged phases are not', () => {
  expect(logDiff(boardOf([]), boardOf([], { phase: 'testing' }), AT)).toEqual([{ at: AT, kind: 'phase', who: 'lead', text: 'phase → testing' }])
  expect(logDiff(boardOf([], { phase: 'design' }), boardOf([], { phase: null }), AT)).toEqual([])
  expect(logDiff(boardOf([], { phase: 'design' }), boardOf([], { phase: 'design', task: 'new task', wave: 2 }), AT)).toEqual([])
})

test('logDiff: nothing else makes an entry (tool calls, tokens, status moves short of an end)', () => {
  const before = boardOf([mk(MAIN_ID), mk('a', { status: 'starting' })])
  const after = boardOf([
    mk(MAIN_ID, { status: 'waiting', endedAt: T0 + 5 }),
    mk('a', { status: 'waiting', lastTool: 'Bash', tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, requests: 1 } }),
  ])
  expect(logDiff(before, after, AT)).toEqual([])
  expect(logDiff(before, before, AT)).toEqual([])
})

test('logDiff: workers come in order of first appearance; the phase entry last', () => {
  const after = boardOf([mk('z'), mk('a')], { phase: 'executing' })
  expect(noAudit(logDiff(boardOf([]), after, AT)).map(e => `${e.kind}:${e.who}`)).toEqual(['spawned:Do z', 'spawned:Do a', 'phase:lead'])
})

// ---- audit transitions ----

test('logDiff: none → audited: a box spawning with an audited unit of each tier logs its audit line after the spawn', () => {
  const after = boardOf(
    [mk('o', { unitId: 'u1' }), mk('s', { model: SONNET, unitId: 'u2' }), mk('h', { model: HAIKU, unitId: 'u3' })],
    { units: [unit('u1'), sonnetUnit('u2'), haikuUnit('u3')] },
  )
  expect(logDiff(boardOf([]), after, AT)).toEqual([
    { at: AT, kind: 'spawned', who: 'Do o', text: 'spawned · Opus 5.5 · design' },
    { at: AT, kind: 'audit', who: 'Do o', text: OPUS_AUDIT },
    { at: AT, kind: 'spawned', who: 'Do s', text: 'spawned · Sonnet 5.5 · tests' },
    { at: AT, kind: 'audit', who: 'Do s', text: SONNET_AUDIT },
    { at: AT, kind: 'spawned', who: 'Do h', text: 'spawned · Haiku 5.5 · locate' },
    { at: AT, kind: 'audit', who: 'Do h', text: HAIKU_AUDIT },
  ])
  expect(logDiff(after, after, AT)).toEqual([])
})

test('logDiff: none → no-audit: no unit, a unit with no tier, or a unit missing its audit line', () => {
  const after = boardOf(
    [mk('a'), mk('b', { unitId: 'own' }), mk('c', { model: SONNET, unitId: 'bare' })],
    { units: [ownUnit('own'), sonnetUnit('bare', { audit: null })] },
  )
  expect(logDiff(boardOf([]), after, AT).filter(e => e.kind === 'audit')).toEqual([
    { at: AT, kind: 'audit', who: 'Do a', text: NO_AUDIT },
    { at: AT, kind: 'audit', who: 'Do b', text: NO_AUDIT },
    { at: AT, kind: 'audit', who: 'Do c', text: NO_AUDIT },
  ])
  expect(logDiff(after, after, AT)).toEqual([])
})

test('logDiff: no-audit → audited: a box later linked to an audited unit logs the audit once', () => {
  const before = boardOf([mk('h', { model: HAIKU })])
  const after = boardOf([mk('h', { model: HAIKU, unitId: 'u1' })], { units: [haikuUnit('u1')] })
  expect(logDiff(before, after, AT)).toEqual([{ at: AT, kind: 'audit', who: 'Do h', text: HAIKU_AUDIT }])
  expect(logDiff(after, after, AT)).toEqual([])
  // still no audit line after an unrelated change: nothing repeated
  expect(logDiff(before, boardOf([mk('h', { model: HAIKU, lastTool: 'Bash' })]), AT)).toEqual([])
})

test('logDiff: audited → no-audit (the unit dropped) makes no entry', () => {
  const before = boardOf([mk('w', { unitId: 'u1' })], { units: [unit('u1')] })
  const after = boardOf([mk('w', { unitId: 'u1' })])
  expect(logDiff(before, after, AT)).toEqual([])
})

test('logDiff: audited → tier-mismatch: the model learned differs from the unit\'s tier', () => {
  const units = [sonnetUnit('u1')]
  const before = boardOf([mk('w', { model: null, unitId: 'u1' })], { units })
  const after = boardOf([mk('w', { model: HAIKU, unitId: 'u1' })], { units })
  expect(logDiff(before, after, AT)).toEqual([{ at: AT, kind: 'audit', who: 'Do w', text: 'ran on Haiku 5.5, unit says sonnet' }])
  expect(logDiff(after, after, AT)).toEqual([])
})

test('logDiff: anything → tier-mismatch is logged once: from none on spawn, and from no-audit', () => {
  const units = [haikuUnit('u1')]
  const spawned = boardOf([mk('w', { unitId: 'u1' })], { units })
  expect(logDiff(boardOf([]), spawned, AT)).toEqual([
    { at: AT, kind: 'spawned', who: 'Do w', text: 'spawned · Opus 5.5 · locate' },
    { at: AT, kind: 'audit', who: 'Do w', text: 'ran on Opus 5.5, unit says haiku' },
  ])
  const unlinked = boardOf([mk('w')], { units })
  expect(logDiff(unlinked, spawned, AT)).toEqual([{ at: AT, kind: 'audit', who: 'Do w', text: 'ran on Opus 5.5, unit says haiku' }])
  // still a mismatch after an unrelated change, or on an unchanged diff: nothing repeated
  expect(logDiff(spawned, boardOf([mk('w', { unitId: 'u1', lastTool: 'Edit' })], { units }), AT)).toEqual([])
  expect(logDiff(spawned, spawned, AT)).toEqual([])
})

test('logDiff: tier-mismatch → audited logs the audit line (the unit re-routed to the model\'s tier)', () => {
  const before = boardOf([mk('w', { unitId: 'u1' })], { units: [haikuUnit('u1')] })
  const after = boardOf([mk('w', { unitId: 'u1' })], { units: [unit('u1')] })
  expect(logDiff(before, after, AT)).toEqual([{ at: AT, kind: 'audit', who: 'Do w', text: OPUS_AUDIT }])
})

// ---- verdicts ----

test('logDiff: verdicts of units of each tier: accepted feeding units, accepted feeding nothing, rejected', () => {
  const units = (v: Unit['verdict']): Unit[] => [
    haikuUnit('a', { verdict: v }),
    sonnetUnit('b', { verdict: v === null ? null : 'accepted' }),
    unit('c', { verdict: v === null ? null : 'rejected' }),
    sonnetUnit('d', { verdict: v === null ? null : 'rejected' }),
    haikuUnit('e', { verdict: v === null ? null : 'rejected' }),
    unit('x', { label: 'Fix X', dependsOn: ['a'] }),
    sonnetUnit('y', { label: 'Fix Y', dependsOn: ['a', 'c'] }),
  ]
  expect(logDiff(boardOf([], { units: units(null) }), boardOf([], { units: units('accepted') }), AT)).toEqual([
    { at: AT, kind: 'verdict', who: 'Unit a', text: 'accepted → feeds Fix X, Fix Y' },
    { at: AT, kind: 'verdict', who: 'Unit b', text: 'accepted' },
    { at: AT, kind: 'verdict', who: 'Unit c', text: 'rejected → re-route upward (policy §8)' },
    { at: AT, kind: 'verdict', who: 'Unit d', text: 'rejected → re-route upward (policy §8)' },
    { at: AT, kind: 'verdict', who: 'Unit e', text: 'rejected → re-route upward (policy §8)' },
  ])
})

test('logDiff: an unchanged verdict makes no entry; a new unit already with a verdict makes one; a unit with no tier never does', () => {
  const b = boardOf([], { units: [unit('a', { verdict: 'accepted' })] })
  expect(logDiff(b, b, AT)).toEqual([])
  const after = boardOf([], { units: [unit('a', { verdict: 'accepted' }), sonnetUnit('n', { verdict: 'rejected' })] })
  expect(logDiff(b, after, AT)).toEqual([{ at: AT, kind: 'verdict', who: 'Unit n', text: 'rejected → re-route upward (policy §8)' }])
  const own = boardOf([], { units: [ownUnit('o', { verdict: 'accepted' })] })
  expect(logDiff(boardOf([]), own, AT)).toEqual([])
})

// ---- barred ----

test('logDiff: a kind becoming barred at haiku is logged once by the lead, with its count', () => {
  const before = boardOf([], { rejects: [{ unitId: 'r1', tier: 'haiku', kind: 'locate', taskId: null }] })
  const after = boardOf([], {
    rejects: [
      { unitId: 'r1', tier: 'haiku', kind: 'locate', taskId: null },
      { unitId: 'r2', tier: 'haiku', kind: 'locate', taskId: null },
      { unitId: 'r3', tier: 'haiku', kind: 'edit', taskId: null },
      { unitId: 'r4', tier: 'sonnet', kind: 'locate', taskId: null },
    ],
  })
  expect(logDiff(before, after, AT)).toEqual([{ at: AT, kind: 'verdict', who: 'lead', text: 'haiku barred for locate (2 rejected)' }])
  expect(logDiff(after, after, AT)).toEqual([])
  const more = boardOf([], { rejects: [...after.rejects, { unitId: 'r5', tier: 'haiku', kind: 'locate', taskId: null }] })
  expect(logDiff(after, more, AT)).toEqual([])
})

test('logDiff: a kind becoming barred at sonnet is logged once, with its count, apart from the same kind at haiku', () => {
  const haikuBarred = [
    { unitId: 'h1', tier: 'haiku' as const, kind: 'review' as const, taskId: null },
    { unitId: 'h2', tier: 'haiku' as const, kind: 'review' as const, taskId: null },
  ]
  const before = boardOf([], { rejects: [...haikuBarred, { unitId: 's1', tier: 'sonnet', kind: 'review', taskId: null }] })
  const after = boardOf([], {
    rejects: [...haikuBarred, { unitId: 's1', tier: 'sonnet', kind: 'review', taskId: null }, { unitId: 's2', tier: 'sonnet', kind: 'review', taskId: null }, { unitId: 's3', tier: 'sonnet', kind: 'review', taskId: null }],
  })
  expect(logDiff(before, after, AT)).toEqual([{ at: AT, kind: 'verdict', who: 'lead', text: 'sonnet barred for review (3 rejected)' }])
  expect(logDiff(after, after, AT)).toEqual([])
})

test('logDiff: writing kinds rejected at sonnet are never logged as barred (0.17.0)', () => {
  const before = boardOf([], { rejects: [{ unitId: 's1', tier: 'sonnet', kind: 'edit', taskId: null }] })
  const after = boardOf([], {
    rejects: [1, 2, 3].map(i => ({ unitId: `s${i}`, tier: 'sonnet' as const, kind: 'edit' as const, taskId: null })),
  })
  expect(logDiff(before, after, AT)).toEqual([])
})

test('logDiff: opus rejections never bar a kind; a board missing its rejects bars nothing', () => {
  const opus = boardOf([], {
    rejects: [
      { unitId: 'o1', tier: 'opus', kind: 'design', taskId: null },
      { unitId: 'o2', tier: 'opus', kind: 'design', taskId: null },
    ],
  })
  expect(logDiff(boardOf([]), opus, AT)).toEqual([])
  const old = { ...boardOf([]), rejects: undefined } as unknown as Board
  expect(logDiff(old, old, AT)).toEqual([])
})

test('logDiff: the overall order: per box (spawned, audit, ended), then verdicts, then barred kinds, then the phase', () => {
  const units = [haikuUnit('s1', { kind: 'extract' })]
  const before = boardOf([], { units, rejects: [{ unitId: 'r1', tier: 'haiku', kind: 'extract', taskId: null }] })
  const after = boardOf([mk('h', { model: HAIKU, unitId: 's1', status: 'done', endedAt: T0 + 1000 }), mk('w', { model: SONNET })], {
    units: [haikuUnit('s1', { verdict: 'rejected', kind: 'extract' })],
    rejects: [
      { unitId: 'r1', tier: 'haiku', kind: 'extract', taskId: null },
      { unitId: 's1', tier: 'haiku', kind: 'extract', taskId: null },
    ],
    phase: 'review',
  })
  expect(logDiff(before, after, AT).map(e => `${e.kind}:${e.who}`)).toEqual([
    'spawned:Do h',
    'audit:Do h',
    'done:Do h',
    'spawned:Do w',
    'audit:Do w',
    'verdict:Unit s1',
    'verdict:lead',
    'phase:lead',
  ])
})

// ---- a placeholder box (an event before the spawn hook) ----

test('logDiff: a placeholder appearing logs nothing, audit included', () => {
  const after = boardOf([mk('a8adb', { label: 'a8adb', model: null, tokensPartial: true })])
  expect(logDiff(boardOf([]), after, AT)).toEqual([])
  const haiku = boardOf([mk('h1', { label: 'h1', model: HAIKU })])
  expect(logDiff(boardOf([]), haiku, AT)).toEqual([])
  const mismatch = boardOf([mk('m1', { label: 'm1', unitId: 'u1' })], { units: [sonnetUnit('u1')] })
  expect(logDiff(boardOf([]), mismatch, AT)).toEqual([])
})

test('logDiff: the placeholder becoming labelled logs one spawned entry and its audit with the real label, once', () => {
  const before = boardOf([mk('a8adb', { label: 'a8adb', model: null })])
  const after = boardOf([mk('a8adb', { label: 'Fix the log', status: 'starting' })])
  expect(logDiff(before, after, AT)).toEqual([
    { at: AT, kind: 'spawned', who: 'Fix the log', text: 'spawned · Opus 5.5' },
    { at: AT, kind: 'audit', who: 'Fix the log', text: NO_AUDIT },
  ])
  expect(logDiff(after, after, AT)).toEqual([])
})

test('logDiff: a Haiku placeholder becoming labelled with an audited unit: spawned, then the audit, real label', () => {
  const units = [haikuUnit('s1')]
  const before = boardOf([mk('h1', { label: 'h1', model: HAIKU, unitId: 's1' })], { units })
  const after = boardOf([mk('h1', { label: 'Find the callers', model: HAIKU, unitId: 's1' })], { units })
  expect(logDiff(before, after, AT)).toEqual([
    { at: AT, kind: 'spawned', who: 'Find the callers', text: 'spawned · Haiku 5.5 · locate' },
    { at: AT, kind: 'audit', who: 'Find the callers', text: HAIKU_AUDIT },
  ])
  expect(logDiff(after, after, AT)).toEqual([])
})

test('logDiff: a placeholder becoming labelled on the wrong tier: spawned, then the mismatch, real label', () => {
  const units = [sonnetUnit('u1')]
  const before = boardOf([mk('p1', { label: 'p1', model: HAIKU, unitId: 'u1' })], { units })
  const after = boardOf([mk('p1', { label: 'Write the tests', model: HAIKU, unitId: 'u1' })], { units })
  expect(logDiff(before, after, AT)).toEqual([
    { at: AT, kind: 'spawned', who: 'Write the tests', text: 'spawned · Haiku 5.5 · tests' },
    { at: AT, kind: 'audit', who: 'Write the tests', text: 'ran on Haiku 5.5, unit says sonnet' },
  ])
})

test('logDiff: a box appearing already labelled logs as before, and not again on an unchanged diff', () => {
  const after = boardOf([mk('w', { unitId: 'u1' })], { units: [unit('u1')] })
  expect(logDiff(boardOf([]), after, AT)).toEqual([
    { at: AT, kind: 'spawned', who: 'Do w', text: 'spawned · Opus 5.5 · design' },
    { at: AT, kind: 'audit', who: 'Do w', text: OPUS_AUDIT },
  ])
  expect(logDiff(after, after, AT)).toEqual([])
})

// ---- tasks (0.7.0) ----

const slot = (taskId: string, over: Partial<TaskSlot> = {}): TaskSlot => ({
  taskId,
  task: `Task ${taskId}`,
  repo: '/repo',
  phase: null,
  wave: null,
  units: [],
  status: 'open',
  activeAt: T0,
  ...over,
})
const taskEntry = (text: string): LogEntry => ({ at: AT, kind: 'phase', who: 'lead', text })

test('logDiff: a task opened, with no task before', () => {
  const after = boardOf([], { taskId: 'wb-ui', repo: '/repo', activeAt: AT })
  expect(logDiff(boardOf([]), after, AT)).toEqual([taskEntry('task wb-ui opened')])
  expect(logDiff(after, after, AT)).toEqual([])
})

test('logDiff: a second task opened while one is active, and a switch to a parked task', () => {
  const one = boardOf([], { taskId: 'a-one' })
  const two = boardOf([], { taskId: 'b-two', parked: [slot('a-one')] })
  expect(logDiff(one, two, AT)).toEqual([taskEntry('task b-two opened')])
  const toParked = boardOf([], { taskId: 'a-one', parked: [slot('b-two')] })
  expect(logDiff(boardOf([], { taskId: 'b-two', parked: [slot('a-one')] }), toParked, AT)).toEqual([taskEntry('task → a-one')])
})

test('logDiff: a closed task made active again reads reopened', () => {
  const before = boardOf([], { taskId: 'b-two', closed: [slot('a-one', { status: 'closed' })] })
  const after = boardOf([], { taskId: 'a-one', parked: [slot('b-two')] })
  expect(logDiff(before, after, AT)).toEqual([taskEntry('task a-one reopened')])
})

test('logDiff: a task closed with nothing else open; closing the active task with a parked one makes both entries, in order', () => {
  const closedA = slot('a-one', { status: 'closed' })
  expect(logDiff(boardOf([], { taskId: 'a-one' }), boardOf([], { closed: [closedA] }), AT)).toEqual([taskEntry('task a-one closed')])
  const before = boardOf([], { taskId: 'a-one', parked: [slot('b-two')] })
  const after = boardOf([], { taskId: 'b-two', closed: [closedA] })
  expect(logDiff(before, after, AT)).toEqual([taskEntry('task a-one closed'), taskEntry('task → b-two')])
  // a task already closed is not closed again
  expect(logDiff(after, after, AT)).toEqual([])
})

test('logDiff: the task entries come before the box entries', () => {
  const after = boardOf([mk('w')], { taskId: 'wb-ui' })
  expect(logDiff(boardOf([]), after, AT).map(e => `${e.kind}:${e.who}`)).toEqual(['phase:lead', 'spawned:Do w', 'audit:Do w'])
})

test('logDiff: switching between tasks with different verdicts and phases makes no verdict, withdrawn or phase entry', () => {
  const before = boardOf([], {
    taskId: 'a-one',
    phase: 'executing',
    units: [unit('u1', { verdict: null })],
    rejects: [{ unitId: 'u9', tier: 'sonnet', kind: 'tests', taskId: 'a-one' }],
    parked: [slot('b-two')],
  })
  const after = boardOf([mk('w', { taskId: 'b-two' })], {
    taskId: 'b-two',
    phase: 'review',
    units: [unit('u1', { verdict: 'accepted' }), sonnetUnit('u2', { verdict: 'rejected' })],
    rejects: [],
    parked: [slot('a-one')],
  })
  const out = logDiff(before, after, AT)
  expect(out.map(e => `${e.kind}:${e.text}`)).toEqual(['phase:task → b-two', 'spawned:spawned · Opus 5.5', `audit:${NO_AUDIT}`])
})

test('logDiff: a switch still logs newly barred kinds', () => {
  const before = boardOf([], { taskId: 'a-one', parked: [slot('b-two')] })
  const after = boardOf([], {
    taskId: 'b-two',
    parked: [slot('a-one')],
    rejects: [
      { unitId: 'r1', tier: 'haiku', kind: 'locate', taskId: 'a-one' },
      { unitId: 'r2', tier: 'haiku', kind: 'locate', taskId: 'a-one' },
    ],
  })
  expect(logDiff(before, after, AT)).toEqual([taskEntry('task → b-two'), { at: AT, kind: 'verdict', who: 'lead', text: 'haiku barred for locate (2 rejected)' }])
})

test('logDiff: a withdrawn rejection whose unit is now accepted reads "rejection withdrawn → accepted"', () => {
  const rejects = [{ unitId: 'a', tier: 'haiku' as const, kind: 'locate' as const, taskId: 'wb-ui' }]
  const before = boardOf([], { taskId: 'wb-ui', units: [haikuUnit('a', { verdict: 'rejected' }), unit('x', { dependsOn: ['a'] })], rejects })
  const after = boardOf([], { taskId: 'wb-ui', units: [haikuUnit('a', { verdict: 'accepted' }), unit('x', { dependsOn: ['a'] })], rejects: [] })
  expect(logDiff(before, after, AT)).toEqual([{ at: AT, kind: 'verdict', who: 'Unit a', text: 'rejection withdrawn → accepted' }])
  // accepted with no withdrawn rejection (another task's reject of the same unit id does not count)
  const other = boardOf([], { taskId: 'wb-ui', units: [haikuUnit('a', { verdict: 'rejected' })], rejects: [{ ...rejects[0]!, taskId: 'other' }] })
  const done = boardOf([], { taskId: 'wb-ui', units: [haikuUnit('a', { verdict: 'accepted' })], rejects: [{ ...rejects[0]!, taskId: 'other' }] })
  expect(logDiff(other, done, AT)).toEqual([{ at: AT, kind: 'verdict', who: 'Unit a', text: 'accepted' }])
})

test('logDiff: the phase entry carries the task id only while more than one task is open', () => {
  const single = boardOf([], { taskId: 'wb-ui', phase: 'design' })
  expect(logDiff(single, boardOf([], { taskId: 'wb-ui', phase: 'testing' }), AT)).toEqual([taskEntry('phase → testing')])
  const multi = boardOf([], { taskId: 'wb-ui', phase: 'design', parked: [slot('b-two')] })
  expect(logDiff(multi, { ...multi, phase: 'testing' }, AT)).toEqual([taskEntry('phase → testing · wb-ui')])
})

test('logDiff: spawned shows the kind recorded at spawn (routed) before its unit\'s', () => {
  const routed = { tier: 'opus' as const, kind: 'debug' as const, audit: OPUS_AUDIT }
  const after = boardOf(
    [mk('r', { unitId: 'u1', routed }), mk('g', { unitId: 'gone', routed }), mk('u', { unitId: 'u1' })],
    { units: [unit('u1')] },
  )
  expect(logDiff(boardOf([]), after, AT).filter(e => e.kind === 'spawned').map(e => e.text)).toEqual([
    'spawned · Opus 5.5 · debug',
    'spawned · Opus 5.5 · debug',
    'spawned · Opus 5.5 · design',
  ])
})

// ---- a worker model switched off (0.10.0) ----

test('logDiff: a substituted run spawns as "opus→Sonnet 5.5 · design" and a done sonnet-model run of opus work is no draft', () => {
  const routed = { tier: 'opus' as const, kind: 'design' as const, audit: OPUS_AUDIT, ranOn: 'sonnet' as const }
  const run = mk('s', { model: SONNET, unitId: 'u1', routed })
  const spawned = boardOf([run], { units: [unit('u1')] })
  expect(logDiff(boardOf([]), spawned, AT).filter(e => e.kind === 'spawned').map(e => e.text)).toEqual(['spawned · opus→Sonnet 5.5 · design'])
  const done = boardOf([{ ...run, status: 'done', endedAt: AT, startedAt: AT - 5000 }], { units: [unit('u1')] })
  expect(logDiff(spawned, done, AT).find(e => e.kind === 'done')?.text).not.toContain('draft')
})

test('logDiff: opus work substituted to sonnet but run on Haiku logs "unit says opus on sonnet"', () => {
  const routed = { tier: 'opus' as const, kind: 'design' as const, audit: OPUS_AUDIT, ranOn: 'sonnet' as const }
  const after = boardOf([mk('h', { model: HAIKU, unitId: 'u1', routed })], { units: [unit('u1')] })
  expect(logDiff(boardOf([]), after, AT).filter(e => e.kind === 'audit').map(e => e.text)).toEqual(['ran on Haiku 5.5, unit says opus on sonnet'])
})

const marked = (id: string, mark: AgentBox['ungated'], over: Partial<AgentBox> = {}): AgentBox => mk(id, { ungated: mark, ...over })
const ungatedEntries = (entries: LogEntry[]): LogEntry[] => entries.filter(e => e.kind === 'audit')

test('logDiff: a new box marked workflow logs one ungated entry, never the no-audit one', () => {
  const x = marked('a1', { why: 'workflow', run: 'wf_1' })
  const out = logDiff(emptyBoard(T0), boardOf([x]), AT)
  expect(ungatedEntries(out)).toEqual([
    { at: AT, kind: 'audit', who: 'Do a1', text: 'ungated: workflow run wf_1: its agents start unchecked' },
  ])
  expect(out.some(e => e.text === NO_AUDIT)).toBe(false)
})

test('logDiff: a second box of the same workflow run logs none; a box of another run logs one', () => {
  const a = marked('a1', { why: 'workflow', run: 'wf_1' })
  const b = marked('a2', { why: 'workflow', run: 'wf_1' })
  const c = marked('a3', { why: 'workflow', run: 'wf_2' })
  const before = boardOf([a])
  expect(ungatedEntries(logDiff(before, boardOf([a, b]), AT))).toEqual([])
  expect(ungatedEntries(logDiff(before, boardOf([a, c]), AT)).map(e => e.text)).toEqual([
    'ungated: workflow run wf_2: its agents start unchecked',
  ])
  expect(logDiff(before, boardOf([a, b]), AT).some(e => e.kind === 'spawned' && e.who === 'Do a2')).toBe(true)
})

test('logDiff: an already marked box logs the ungated entry once', () => {
  const x = marked('a1', { why: 'workflow', run: 'wf_1' })
  const board = boardOf([x])
  expect(ungatedEntries(logDiff(board, board, AT))).toEqual([])
})

test('logDiff: resumed, exempt, unseen and nested marks read per the spec', () => {
  const text = (why: 'resumed' | 'exempt' | 'unseen' | 'nested', type = 'general-purpose'): string[] =>
    ungatedEntries(logDiff(emptyBoard(T0), boardOf([marked('a1', { why }, { type })]), AT)).map(e => e.text)
  expect(text('resumed')).toEqual(['ungated: resumed run of an agent no unit covered'])
  expect(text('exempt', 'statusline-setup')).toEqual(['ungated: exempt type statusline-setup'])
  expect(text('unseen')).toEqual(['ungated: not seen by the gate (a skill in its own agent, or started before the board loaded)'])
  expect(text('nested')).toEqual(['ungated: started by another agent'])
})

test('logDiff: a marked box with a covering audited unit still only logs the ungated entry', () => {
  const x = marked('a1', { why: 'resumed' }, { unitId: 'u1' })
  const out = logDiff(emptyBoard(T0), boardOf([x], { units: [unit('u1')] }), AT)
  expect(ungatedEntries(out).map(e => e.text)).toEqual(['ungated: resumed run of an agent no unit covered'])
})

test('logDiff: a box with ungated null behaves as an unmarked one', () => {
  const out = logDiff(emptyBoard(T0), boardOf([mk('a1', { ungated: null })]), AT)
  expect(ungatedEntries(out).map(e => e.text)).toEqual([NO_AUDIT])
})
