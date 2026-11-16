import { describe, expect, test } from 'claude-code/testing'

import type { AgentBox, Board, Tokens } from '../types'
import { BOARD_PROMPT_SECTION_TEXT, BOARD_TOOL_DESCRIPTION, BOARD_TOOL_SCHEMA } from './board'
import { routingPolicySection } from './policy'
import { injectedParts, usageReport } from './report'
import { emptyBoard } from './state'
import { WORKFLOW_ROLE_TEXT, workflowText } from './workflow'

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
    model: id === 'main' ? 'claude-fable-5-2' : 'claude-sonnet-5-5',
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

function withBoxes(taskId: string | null, boxes: AgentBox[]): Board {
  const b = emptyBoard(LOADED)
  b.taskId = taskId
  for (const x of boxes) {
    b.agents[x.id] = x
    b.order.push(x.id)
  }
  return b
}

const INJECTED = [
  { name: 'workflow', chars: 5100 },
  { name: 'board', chars: 770 },
  { name: 'routing policy', chars: 7600 },
  { name: 'AgentBoard tool', chars: 1700 },
]

/** The worked board of the design (5.2, 5.3). */
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
    box('s1', { unitId: 'u1', name: 'u1', tokens: tk(100, 20_000, 284_900, 15_500, 40), peakIn: 40_000, briefChars: 6500, resultChars: 6000 }),
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
  return b
}

const HEADING = 'Agent Board · tokens · task wb-tokens · counted since 14:02:11, when the board started'
const MEASURED =
  'Measured from the usage the API reported for each model request the board saw. Nothing is estimated, and nothing is compared with a run without Flowestra.'
const LAST = 'What this cannot tell you: how many tokens the same work would have used without Flowestra. README, "Token figures".'

describe('the worked report', () => {
  test('the lines of 5.3, in order', () => {
    expect(usageReport(worked(), INJECTED)).toEqual([
      HEADING,
      MEASURED,
      '',
      '  This task                        new   cached     out  requests',
      '  lead · Fable 5.2               41.2k     2.3M   38.4k        52',
      '  Haiku 5.5 · 2 agents           30.1k     150k      6k        25',
      '  Sonnet 5.5 · 4 agents           121k     900k     95k       160',
      '  Opus 5.5 · 2 agents             181k     3.1M   61.2k       140',
      '  all                             373k     6.5M    201k       377',
      '  Delegated: 66% of all tokens (66% of in, 81% of out).',
      '',
      '  Since 14:02:11, every task       new   cached     out  requests',
      '  lead · Fable 5.2               54.2k       3M     50k        70',
      '  Haiku 5.5 · 3 agents           32.1k     158k      7k        28',
      '  Sonnet 5.5 · 4 agents           121k     900k     95k       160',
      '  Opus 5.5 · 2 agents             181k     3.1M   61.2k       140',
      '  all                             388k     7.2M    213k       398',
      '',
      '  Context kept out of the lead (this task)',
      "  Workers' largest contexts, summed: 312k tokens. Their answers back: 41.3k chars.",
      "  The lead's largest context: 186k tokens.",
      "  Workers' input over all their requests: 4.5M tokens (each request counts its whole context again).",
      '',
      '  Overhead (this task)',
      '  Runs whose unit was rejected: 2 agents · in 610k out 31k',
      '  Later runs of a unit already run: 1 agent · in 140k out 9.8k',
      '  Together, each agent once: 3 agents · in 750k out 40.8k · 11% of all tokens',
      "  Briefs and follow-up messages: 52.4k chars to 8 agents (part of the lead's out)",
      "  Board updates: 14 calls · 38.1k chars (part of the lead's out)",
      "  Flowestra's text in the lead's prompt: 15.2k chars (workflow 5.1k, board 770, routing policy 7.6k, AgentBoard tool 1.7k), sent with each of the lead's 52 requests in this task",
      '',
      LAST,
    ])
  })

  test('every line is under 2000 characters and none has a newline', () => {
    for (const l of usageReport(worked(), INJECTED)) {
      expect(l.length).toBeLessThan(2000)
      expect(l.includes('\n')).toBe(false)
    }
  })
})

describe('the variants', () => {
  test('substituted work: the label names it and is cut to keep the columns', () => {
    const b = withBoxes('t', [
      box('main', { taskId: null, model: 'claude-fable-5-2', tokens: tk(100, 0, 0, 10, 5) }),
      box('a', { taskId: 't', model: 'claude-opus-5-5', routed: { tier: 'sonnet', kind: 'implement', audit: 'x', ranOn: 'opus' }, tokens: tk(1, 0, 0, 1, 1) }),
      box('b', { taskId: 't', model: 'claude-opus-5-5', tokens: tk(1, 0, 0, 1, 1) }),
    ])
    b.leadByTask = { t: tk(100, 0, 0, 10, 5) }
    const lines = usageReport(b, [])
    expect(lines).toContain('  Opus 5.5 · 2 agents · incl…        2        0       2         2')
    const short = withBoxes('t', [
      box('main', { taskId: null, model: 'claude-fable-5-2', tokens: tk(100, 0, 0, 10, 5) }),
      box('a', { taskId: 't', model: 'claude-opus-5-5', routed: { tier: 'sonnet', kind: 'implement', audit: 'x', ranOn: 'opus' }, tokens: tk(1, 0, 0, 1, 1) }),
    ])
    short.leadByTask = { t: tk(100, 0, 0, 10, 5) }
    expect(usageReport(short, [])).toContain('  Opus 5.5 · 1 agent · incl.…        1        0       1         1')
  })

  test('ungated agents: one line after the all row, singular and plural', () => {
    const b = withBoxes('t', [
      box('main', { taskId: null, tokens: tk(100, 0, 0, 10, 5) }),
      box('a', { taskId: 't', ungated: { why: 'workflow' }, tokens: tk(1, 0, 0, 1, 1) }),
    ])
    b.leadByTask = { t: tk(100, 0, 0, 10, 5) }
    const one = usageReport(b, [])
    const at = one.indexOf('  Includes 1 ungated agent (workflow, resumed, nested, exempt or unseen): not held to a unit.')
    expect(at).toBeGreaterThan(0)
    expect((one[at - 1] as string).startsWith('  all ')).toBe(true)
    b.agents['a2'] = box('a2', { taskId: 't', ungated: { why: 'nested' }, tokens: tk(1, 0, 0, 1, 1) })
    b.order.push('a2')
    expect(usageReport(b, [])).toContain('  Includes 2 ungated agents (workflow, resumed, nested, exempt or unseen): not held to a unit.')
  })

  test('no worker in scope', () => {
    const b = withBoxes('t', [box('main', { taskId: null, tokens: tk(100, 0, 0, 10, 5) })])
    b.leadByTask = { t: tk(100, 0, 0, 10, 5) }
    expect(usageReport(b, [{ name: 'board', chars: 770 }])).toEqual([
      'Agent Board · tokens · task t · counted since 14:02:11, when the board started',
      MEASURED,
      '',
      '  This task                        new   cached     out  requests',
      '  lead · Fable 5.2                 100        0      10         5',
      '  all                              100        0      10         5',
      '  Nothing delegated in this task yet.',
      '',
      '  Since 14:02:11, every task       new   cached     out  requests',
      '  lead · Fable 5.2                 100        0      10         5',
      '  all                              100        0      10         5',
      '',
      '  Context kept out of the lead (this task)',
      '  No worker has run in this task yet.',
      '',
      '  Overhead (this task)',
      '  Runs whose unit was rejected: none',
      '  Later runs of a unit already run: none',
      '  Together, each agent once: none',
      '  Briefs and follow-up messages: none',
      '  Board updates: none',
      "  Flowestra's text in the lead's prompt: 770 chars (board 770), sent with each of the lead's 5 requests in this task",
      '',
      LAST,
    ])
  })

  test('share not shown while a count is partial, and the partial line', () => {
    const b = withBoxes('t', [
      box('main', { taskId: null, tokens: tk(100, 0, 0, 10, 5) }),
      box('a', { taskId: 't', tokens: tk(10, 0, 0, 10, 1), tokensPartial: true }),
      box('b', { taskId: 't', tokens: null }),
      box('c', { taskId: 't', model: 'claude-opus-5-5', tokens: tk(20, 0, 0, 20, 2) }),
    ])
    b.leadByTask = { t: tk(100, 0, 0, 10, 5) }
    const lines = usageReport(b, [])
    expect(lines).toContain('  Delegated: not shown while some counts are partial (≥).')
    expect(lines).toContain('  Sonnet 5.5 · 1 agent             ≥10       ≥0     ≥10        ≥1')
    expect(lines).toContain('  all                             ≥130       ≥0     ≥40        ≥8')
    expect(lines).toContain("  Workers' largest contexts, summed: ≥0 tokens. Their answers back: 0 chars.")
    expect(lines[lines.length - 3]).toBe('')
    expect(lines[lines.length - 2]).toBe('Partial counts: 1 agents started before the board saw them (≥); 1 agents have no counts (n/a).')
    expect(lines[lines.length - 1]).toBe(LAST)
  })

  test('only the non-zero half of the partial line', () => {
    const b = withBoxes('t', [
      box('main', { taskId: null, tokens: tk(100, 0, 0, 10, 5) }),
      box('a', { taskId: 't', tokens: tk(10, 0, 0, 10, 1), tokensPartial: true }),
    ])
    b.leadByTask = { t: tk(100, 0, 0, 10, 5) }
    expect(usageReport(b, [])).toContain('Partial counts: 1 agents started before the board saw them (≥).')
    const c = withBoxes('t', [box('main', { taskId: null, tokens: tk(100, 0, 0, 10, 5) }), box('a', { taskId: 't', tokens: null })])
    c.leadByTask = { t: tk(100, 0, 0, 10, 5) }
    expect(usageReport(c, [])).toContain('Partial counts: 1 agents have no counts (n/a).')
  })

  test('no counts at all: the heading and one line', () => {
    expect(usageReport(emptyBoard(LOADED), INJECTED)).toEqual([
      'Agent Board · tokens · no task · counted since 14:02:11, when the board started',
      'No token counts yet.',
    ])
    const b = withBoxes('t', [box('a', { taskId: 't', tokens: null })])
    expect(usageReport(b, INJECTED)).toEqual([
      'Agent Board · tokens · task t · counted since 14:02:11, when the board started',
      'No token counts yet.',
    ])
  })

  test('no task open', () => {
    const b = withBoxes(null, [
      box('main', { taskId: null, tokens: tk(100, 0, 0, 10, 5) }),
      box('a', { taskId: null, tokens: tk(10, 0, 0, 10, 1) }),
    ])
    b.leadByTask = { '': tk(100, 0, 0, 10, 5) }
    const lines = usageReport(b, [])
    expect(lines[0]).toBe('Agent Board · tokens · no task · counted since 14:02:11, when the board started')
    expect(lines[3]).toBe('  No task                          new   cached     out  requests')
    expect(lines).toContain('  Delegated: 15% of all tokens (9% of in, 50% of out).')
  })

  test('workflow off: the injected list has no workflow', () => {
    const parts = injectedParts('off', '')
    expect(parts.map(p => p.name)).toEqual(['board', 'routing policy', 'AgentBoard tool'])
    const b = withBoxes('t', [box('main', { taskId: null, tokens: tk(100, 0, 0, 10, 1) })])
    b.leadByTask = { t: tk(100, 0, 0, 10, 1) }
    const text = usageReport(b, [{ name: 'board', chars: 100 }, { name: 'AgentBoard tool', chars: 50 }]).join('\n')
    expect(text).toContain("150 chars (board 100, AgentBoard tool 50), sent with each of the lead's 1 request in this task")
    expect(text.includes('workflow')).toBe(false)
  })
})

describe('injectedParts', () => {
  test('full: the lengths of the four source texts', () => {
    expect(injectedParts('full', '')).toEqual([
      { name: 'workflow', chars: workflowText('full').length },
      { name: 'board', chars: BOARD_PROMPT_SECTION_TEXT.length },
      { name: 'routing policy', chars: routingPolicySection('').text.length },
      { name: 'AgentBoard tool', chars: BOARD_TOOL_DESCRIPTION.length + JSON.stringify(BOARD_TOOL_SCHEMA).length },
    ])
  })

  test('light uses the role text; the note is part of the policy section', () => {
    expect(injectedParts('light', '')[0]).toEqual({ name: 'workflow', chars: WORKFLOW_ROLE_TEXT.length })
    const plain = injectedParts('full', '')[2] as { chars: number }
    const noted = injectedParts('full', 'Haiku work runs on Sonnet.')[2] as { chars: number }
    expect(noted.chars).toBe(plain.chars + 2 + 'Haiku work runs on Sonnet.'.length)
  })
})
