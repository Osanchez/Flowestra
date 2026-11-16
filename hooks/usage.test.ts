import { describe, expect, test } from 'claude-code/testing'

import type { AgentBox, Board, Tier, Tokens, Unit } from '../types'
import { emptyBoard } from './state'
import { hasUsage, usageScope } from './usage'

const LOADED = new Date(2026, 10, 15, 14, 2, 11).getTime()

const tk = (input: number, cacheWrite: number, cacheRead: number, output: number, requests: number): Tokens => ({
  input,
  cacheWrite,
  cacheRead,
  output,
  requests,
})

function box(id: string, over: Partial<AgentBox>): AgentBox {
  return {
    id,
    label: id + ' label',
    type: 'flowestra:sonnet-worker',
    model: 'claude-sonnet-5-5',
    unitId: id,
    name: id,
    parentId: null,
    status: 'done',
    reason: null,
    tokens: null,
    tokensPartial: false,
    startedAt: 500,
    endedAt: null,
    lastEventAt: null,
    lastTool: null,
    briefChars: null,
    resultChars: null,
    peakIn: null,
    flow: { dir: null, at: null },
    taskId: 'wb-tokens',
    routed: null,
    ungated: null,
    ...over,
  }
}

function unit(id: string, verdict: Unit['verdict']): Unit {
  return {
    id,
    label: id,
    wave: 1,
    dependsOn: [],
    declared: null,
    tier: 'sonnet',
    kind: 'implement',
    audit: 'a | sonnet | b | c',
    verdict,
    spec: null,
    context: [],
  }
}

function withBoxes(taskId: string | null, boxes: AgentBox[]): Board {
  const b = emptyBoard(LOADED)
  b.taskId = taskId
  for (const x of boxes) {
    b.agents[x.id] = x
    b.order.push(x.id)
  }
  return b
}

/** The worked board of the design (5.2, 5.3): task wb-tokens, a lead, 8 workers, one worker of another task. */
function worked(): Board {
  const haiku = 'claude-haiku-5-5'
  const opus = 'claude-opus-5-5'
  const b = withBoxes('wb-tokens', [
    box('main', {
      type: 'orchestrator',
      model: 'claude-fable-5-2',
      unitId: null,
      name: null,
      taskId: null,
      tokens: tk(4100, 50100, 3_000_000, 50_000, 70),
      peakIn: 186_000,
    }),
    box('h1', { model: haiku, tokens: tk(50, 15_000, 75_000, 3000, 12), peakIn: 20_000, briefChars: 3000, resultChars: 2000 }),
    box('h2', { model: haiku, tokens: tk(50, 15_000, 75_000, 3000, 13), peakIn: 20_000, briefChars: 3000, resultChars: 2000 }),
    box('s1', { tokens: tk(100, 20_000, 284_900, 15_500, 40), peakIn: 40_000, briefChars: 6500, resultChars: 6000 }),
    box('s2', { unitId: null, name: 'u2', tokens: tk(100, 20_000, 284_900, 15_500, 40), peakIn: 40_000, briefChars: 6500, resultChars: 6000 }),
    box('s3', { unitId: 'u3', name: 'u3', startedAt: 2000, tokens: tk(100, 10_000, 129_900, 9800, 30), peakIn: 30_000, briefChars: 5000, resultChars: 4300 }),
    box('s4', { unitId: 'u3', name: 'u3', startedAt: 1000, tokens: tk(300, 70_400, 200_300, 54_200, 50), peakIn: 60_000, briefChars: 8000, resultChars: 9000 }),
    box('o1', { model: opus, tokens: tk(400, 89_600, 1_550_000, 30_600, 70), peakIn: 50_000, briefChars: 10_200, resultChars: 6000 }),
    box('o2', { model: opus, tokens: tk(500, 90_000, 1_550_000, 30_600, 70), peakIn: 52_000, briefChars: 10_200, resultChars: 6000 }),
    box('x1', { model: haiku, taskId: 'other', tokens: tk(10, 2000, 8000, 1000, 3), peakIn: 5000, briefChars: 999, resultChars: 999 }),
  ])
  b.leadByTask = { 'wb-tokens': tk(3100, 38_100, 2_310_000, 38_400, 52) }
  b.boardSent = { 'wb-tokens': { calls: 14, chars: 38_100 }, other: { calls: 1, chars: 100 } }
  b.rejects = [
    { unitId: 'u1', tier: 'sonnet', kind: 'implement', taskId: 'wb-tokens' },
    { unitId: 'u2', tier: 'sonnet', kind: 'implement', taskId: 'wb-tokens' },
  ]
  b.agents['s1'] = { ...(b.agents['s1'] as AgentBox), unitId: 'u1', name: 'u1' }
  return b
}

describe('usageScope on the worked board', () => {
  test('rows by model, sums and the share', () => {
    const s = usageScope(worked(), 'task')
    expect(s.lead).toEqual({ model: 'Fable 5.2', tokens: tk(3100, 38_100, 2_310_000, 38_400, 52), partial: false, peakIn: 186_000 })
    expect(s.rows.map(r => [r.model, r.tier, r.agents])).toEqual([
      ['Haiku 5.5', 'haiku', 2],
      ['Sonnet 5.5', 'sonnet', 4],
      ['Opus 5.5', 'opus', 2],
    ])
    expect(s.rows[0]?.tokens).toEqual(tk(100, 30_000, 150_000, 6000, 25))
    expect(s.rows[1]?.tokens).toEqual(tk(600, 120_400, 900_000, 95_000, 160))
    expect(s.rows[2]?.tokens).toEqual(tk(900, 179_600, 3_100_000, 61_200, 140))
    expect(s.all).toEqual({ tokens: tk(4700, 368_100, 6_460_000, 200_600, 377), partial: false })
    expect(s.share).toEqual({ all: 66, in: 66, out: 81 })
    expect(s.partialAgents).toBe(0)
    expect(s.unknownAgents).toBe(0)
  })

  test('kept out of the lead', () => {
    const s = usageScope(worked(), 'task')
    expect(s.kept).toEqual({ peaks: 312_000, back: 41_300, workersIn: 4_481_600, leadPeak: 186_000, partial: false })
  })

  test('overhead', () => {
    const s = usageScope(worked(), 'task')
    expect(s.overhead.rejected).toEqual({ agents: 2, in: 610_000, out: 31_000, partial: false })
    expect(s.overhead.later).toEqual({ agents: 1, in: 140_000, out: 9800, partial: false })
    expect(s.overhead.together).toEqual({ agents: 3, in: 750_000, out: 40_800, partial: false, share: 11 })
    expect(s.overhead.briefChars).toBe(52_400)
    expect(s.overhead.briefAgents).toBe(8)
    expect(s.overhead.board).toEqual({ calls: 14, chars: 38_100 })
  })

  test('other-task boxes are excluded from task and included in all', () => {
    const b = worked()
    const task = usageScope(b, 'task')
    const every = usageScope(b, 'all')
    expect(task.rows[0]?.agents).toBe(2)
    expect(every.rows[0]?.agents).toBe(3)
    expect(every.rows[0]?.tokens).toEqual(tk(110, 32_000, 158_000, 7000, 28))
    expect(every.lead.tokens).toEqual(tk(4100, 50_100, 3_000_000, 50_000, 70))
    expect(every.all.tokens.requests).toBe(398)
    expect(every.overhead.board).toEqual({ calls: 15, chars: 38_200 })
    expect(every.kept.peaks).toBe(317_000)
  })
})

describe('rows', () => {
  test('ordered haiku, sonnet, opus, other; first appearance within a tier', () => {
    const b = withBoxes('t', [
      box('a', { model: 'claude-fable-5-2', taskId: 't', tokens: tk(1, 0, 0, 1, 1) }),
      box('b', { model: 'claude-opus-5-5', taskId: 't', tokens: tk(1, 0, 0, 1, 1) }),
      box('c', { model: 'claude-sonnet-5-5', taskId: 't', tokens: tk(1, 0, 0, 1, 1) }),
      box('d', { model: 'claude-haiku-5-5', taskId: 't', tokens: tk(1, 0, 0, 1, 1) }),
      box('e', { model: 'claude-opus-5-4', taskId: 't', tokens: tk(1, 0, 0, 1, 1) }),
      box('f', { model: null, taskId: 't', tokens: tk(1, 0, 0, 1, 1) }),
    ])
    const rows = usageScope(b, 'task').rows
    expect(rows.map(r => r.model)).toEqual(['Haiku 5.5', 'Sonnet 5.5', 'Opus 5.5', 'Opus 5.4', 'Fable 5.2', 'model n/a'])
    expect(rows.map(r => r.tier)).toEqual(['haiku', 'sonnet', 'opus', 'opus', null, null])
  })

  test('a substituted box counts under the model that ran', () => {
    const b = withBoxes('t', [
      box('a', {
        model: 'claude-opus-5-5',
        taskId: 't',
        routed: { tier: 'sonnet', kind: 'implement', audit: 'x', ranOn: 'opus' },
        tokens: tk(1, 0, 0, 1, 1),
      }),
      box('b', { model: 'claude-opus-5-5', taskId: 't', tokens: tk(1, 0, 0, 1, 1) }),
    ])
    const rows = usageScope(b, 'task').rows
    expect(rows.length).toBe(1)
    expect(rows[0]?.model).toBe('Opus 5.5')
    expect(rows[0]?.agents).toBe(2)
    expect(rows[0]?.substituted).toEqual({ sonnet: 1 })
  })

  test('ungated boxes are counted in their row', () => {
    const b = withBoxes('t', [
      box('a', { taskId: 't', ungated: { why: 'workflow' }, tokens: tk(1, 0, 0, 1, 1) }),
      box('b', { taskId: 't', ungated: null, tokens: tk(1, 0, 0, 1, 1) }),
    ])
    expect(usageScope(b, 'task').rows[0]?.ungated).toBe(1)
  })
})

describe('partial and unknown boxes', () => {
  test('a partial worker marks its row and all, and hides the share', () => {
    const b = withBoxes('t', [
      box('main', { taskId: null, model: 'claude-fable-5-2', tokens: tk(1, 0, 0, 1, 1) }),
      box('a', { taskId: 't', tokens: tk(10, 0, 0, 10, 1), tokensPartial: true }),
      box('b', { taskId: 't', model: 'claude-opus-5-5', tokens: tk(10, 0, 0, 10, 1) }),
    ])
    b.leadByTask = { t: tk(5, 0, 0, 5, 1) }
    const s = usageScope(b, 'task')
    expect(s.rows.map(r => r.partial)).toEqual([true, false])
    expect(s.all.partial).toBe(true)
    expect(s.share).toBeNull()
    expect(s.partialAgents).toBe(1)
    expect(s.kept.partial).toBe(true)
  })

  test('an unknown box adds nothing and is counted', () => {
    const b = withBoxes('t', [
      box('a', { taskId: 't', tokens: tk(10, 0, 0, 10, 1) }),
      box('b', { taskId: 't', tokens: null }),
    ])
    b.leadByTask = { t: tk(5, 0, 0, 5, 1) }
    const s = usageScope(b, 'task')
    expect(s.unknownAgents).toBe(1)
    expect(s.rows.length).toBe(1)
    expect(s.rows[0]?.agents).toBe(1)
    expect(s.all.tokens).toEqual(tk(15, 0, 0, 15, 2))
    expect(s.all.partial).toBe(true)
    expect(s.share).toBeNull()
  })

  test('the lead box partial in the all scope', () => {
    const b = withBoxes(null, [box('main', { taskId: null, tokens: tk(1, 0, 0, 1, 1), tokensPartial: true })])
    const s = usageScope(b, 'all')
    expect(s.lead.partial).toBe(true)
    expect(s.all.partial).toBe(true)
  })
})

describe('the share', () => {
  test('none without a worker, and none when nothing was counted', () => {
    const b = withBoxes('t', [box('main', { taskId: null, tokens: tk(1, 0, 0, 1, 1) })])
    b.leadByTask = { t: tk(5, 0, 0, 5, 1) }
    expect(usageScope(b, 'task').share).toBeNull()
    expect(usageScope(emptyBoard(1), 'task').share).toBeNull()
  })

  test('no task open: the key is the empty string and workers of no task', () => {
    const b = withBoxes(null, [
      box('main', { taskId: null, tokens: tk(10, 0, 0, 10, 1) }),
      box('a', { taskId: null, tokens: tk(30, 0, 0, 30, 1) }),
      box('b', { taskId: 'old', tokens: tk(99, 0, 0, 99, 1) }),
    ])
    b.leadByTask = { '': tk(10, 0, 0, 10, 1) }
    const s = usageScope(b, 'task')
    expect(s.rows[0]?.agents).toBe(1)
    expect(s.share).toEqual({ all: 75, in: 75, out: 75 })
  })
})

describe('overhead matching', () => {
  const base = (): Board => {
    const b = withBoxes('t', [
      box('a', { taskId: 't', unitId: 'u1', name: 'u1', startedAt: 10, tokens: tk(100, 0, 0, 10, 1) }),
      box('b', { taskId: 't', unitId: 'u1', name: 'u1', startedAt: 20, tokens: tk(200, 0, 0, 20, 1) }),
      box('c', { taskId: 't', unitId: 'u2', name: 'u2', startedAt: 30, tokens: tk(400, 0, 0, 40, 1) }),
      box('d', { taskId: 't', unitId: null, name: null, startedAt: 40, tokens: tk(800, 0, 0, 80, 1) }),
    ])
    return b
  }

  test('by unitId in the rejects list', () => {
    const b = base()
    b.rejects = [{ unitId: 'u2', tier: 'sonnet', kind: 'implement', taskId: 't' }]
    const o = usageScope(b, 'task').overhead
    expect(o.rejected).toEqual({ agents: 1, in: 400, out: 40, partial: false })
    expect(o.later).toEqual({ agents: 1, in: 200, out: 20, partial: false })
    expect(o.together.agents).toBe(2)
  })

  test('by name after the unit left the list (unitId null)', () => {
    const b = base()
    b.agents['c'] = { ...(b.agents['c'] as AgentBox), unitId: null }
    b.rejects = [{ unitId: 'u2', tier: 'sonnet', kind: 'implement', taskId: 't' }]
    expect(usageScope(b, 'task').overhead.rejected.agents).toBe(1)
  })

  test('by the unit verdict', () => {
    const b = base()
    b.units = [unit('u2', 'rejected'), unit('u1', 'accepted')]
    const o = usageScope(b, 'task').overhead
    expect(o.rejected).toEqual({ agents: 1, in: 400, out: 40, partial: false })
  })

  test('a rejection of another task does not match', () => {
    const b = base()
    b.rejects = [{ unitId: 'u2', tier: 'sonnet', kind: 'implement', taskId: 'other' }]
    expect(usageScope(b, 'task').overhead.rejected.agents).toBe(0)
  })

  test('later runs by startedAt, not by board order', () => {
    const b = base()
    b.agents['a'] = { ...(b.agents['a'] as AgentBox), startedAt: 50 }
    const o = usageScope(b, 'task').overhead
    expect(o.later).toEqual({ agents: 1, in: 100, out: 10, partial: false })
  })

  test('a box both rejected and later counts once in together', () => {
    const b = base()
    b.rejects = [{ unitId: 'u1', tier: 'sonnet', kind: 'implement', taskId: 't' }]
    const o = usageScope(b, 'task').overhead
    expect(o.rejected.agents).toBe(2)
    expect(o.later.agents).toBe(1)
    expect(o.together).toEqual({ agents: 2, in: 300, out: 30, partial: false, share: 20 })
  })

  test('the together share is a percent of all tokens when nothing is uncertain', () => {
    const b = base()
    b.leadByTask = { t: tk(0, 0, 0, 0, 0) }
    b.rejects = [{ unitId: 'u1', tier: 'sonnet', kind: 'implement', taskId: 't' }]
    const total = 110 + 220 + 440 + 880
    expect(usageScope(b, 'task').overhead.together.share).toBe(Math.round((100 * 330) / total))
  })

  test('boxes with neither unit nor name are never later runs', () => {
    const b = withBoxes('t', [
      box('a', { taskId: 't', unitId: null, name: null, tokens: tk(1, 0, 0, 1, 1) }),
      box('b', { taskId: 't', unitId: null, name: null, tokens: tk(1, 0, 0, 1, 1) }),
    ])
    expect(usageScope(b, 'task').overhead.later.agents).toBe(0)
  })
})

describe('hasUsage', () => {
  test('false on an empty board and on boxes without counts; true with any counts', () => {
    expect(hasUsage(emptyBoard(1))).toBe(false)
    expect(hasUsage(withBoxes('t', [box('a', { tokens: null })]))).toBe(false)
    expect(hasUsage(withBoxes('t', [box('a', { tokens: tk(0, 0, 0, 0, 0) })]))).toBe(true)
    expect(hasUsage(withBoxes(null, [box('main', { tokens: tk(1, 0, 0, 1, 1) })]))).toBe(true)
  })
})

describe('tiers', () => {
  test('tier names used above are the three of the board', () => {
    const tiers: Tier[] = ['haiku', 'sonnet', 'opus']
    expect(tiers.length).toBe(3)
  })
})
