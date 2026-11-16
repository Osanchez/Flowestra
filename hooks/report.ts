// The text of `/board tokens` (pure): the lines of the token report, built from the
// board's measured counts by usage.ts. Nothing is estimated; characters are
// labelled chars and never turned into tokens. No I/O.

import type { Board, Tier, Tokens } from '../types'
import { BOARD_PROMPT_SECTION_TEXT, BOARD_TOOL_DESCRIPTION, BOARD_TOOL_SCHEMA } from './board'
import { routingPolicySection } from './policy'
import { hasUsage, usageScope } from './usage'
import type { UsageRow, UsageScope } from './usage'
import { clockText, formatCount } from './view'
import { workflowText } from './workflow'
import type { WorkflowMode } from './workflow'

export type Injected = { name: string; chars: number }

/** The length, in characters, of each text the mod puts in the lead's prompt this session; no workflow part when the mode is off. */
export function injectedParts(mode: WorkflowMode, note: string): Injected[] {
  const parts: Injected[] = []
  const workflow = workflowText(mode)
  if (workflow !== '') parts.push({ name: 'workflow', chars: workflow.length })
  parts.push({ name: 'board', chars: BOARD_PROMPT_SECTION_TEXT.length })
  parts.push({ name: 'routing policy', chars: routingPolicySection(note).text.length })
  parts.push({ name: 'AgentBoard tool', chars: BOARD_TOOL_DESCRIPTION.length + JSON.stringify(BOARD_TOOL_SCHEMA).length })
  return parts
}

const LABEL_WIDTH = 28

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
const agents = (n: number): string => plural(n, 'agent', 'agents')
const mark = (partial: boolean): string => (partial ? '≥' : '')
const count = (n: number, partial: boolean): string => mark(partial) + formatCount(n)

function cut(label: string): string {
  return label.length > LABEL_WIDTH - 1 ? label.slice(0, LABEL_WIDTH - 2) + '…' : label
}

function line(label: string, cells: readonly [string, string, string, string]): string {
  return (
    '  ' + cut(label).padEnd(LABEL_WIDTH) + cells[0].padStart(8) + cells[1].padStart(9) + cells[2].padStart(8) + cells[3].padStart(10)
  )
}

function tokenCells(t: Tokens, partial: boolean): [string, string, string, string] {
  return [count(t.input + t.cacheWrite, partial), count(t.cacheRead, partial), count(t.output, partial), count(t.requests, partial)]
}

const TIER_ORDER: Tier[] = ['haiku', 'sonnet', 'opus']

function rowLabel(row: UsageRow): string {
  const subs = TIER_ORDER.filter(t => (row.substituted[t] ?? 0) > 0).map(t => `${row.substituted[t]} ${t}-tier`)
  return `${row.model} · ${agents(row.agents)}` + (subs.length > 0 ? ` · incl. ${subs.join(', ')}` : '')
}

/** The table of one scope: its title row, the lead, the workers' rows and `all`. */
function table(title: string, s: UsageScope): string[] {
  const lines = [line(title, ['new', 'cached', 'out', 'requests'])]
  const zero: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }
  lines.push(line(`lead · ${s.lead.model}`, tokenCells(s.lead.tokens ?? zero, s.lead.partial)))
  for (const row of s.rows) lines.push(line(rowLabel(row), tokenCells(row.tokens, row.partial)))
  lines.push(line('all', tokenCells(s.all.tokens, s.all.partial)))
  return lines
}

function counted(c: { agents: number; in: number; out: number; partial: boolean }): string {
  return `${agents(c.agents)} · in ${count(c.in, c.partial)} out ${count(c.out, c.partial)}`
}

/** The lines of the token report (5.3 of the design), each without a newline. */
export function usageReport(board: Board, injected: readonly Injected[]): string[] {
  const since = clockText(board.loadedAt)
  const heading = `Agent Board · tokens · ${board.taskId === null ? 'no task' : `task ${board.taskId}`} · counted since ${since}, when the board started`
  if (!hasUsage(board)) return [heading, 'No token counts yet.']

  const task = usageScope(board, 'task')
  const every = usageScope(board, 'all')
  const out: string[] = [
    heading,
    'Measured from the usage the API reported for each model request the board saw. Nothing is estimated, and nothing is compared with a run without Flowestra.',
    '',
  ]

  // this task
  out.push(...table(board.taskId === null ? 'No task' : 'This task', task))
  const ungated = task.rows.reduce((n, r) => n + r.ungated, 0)
  if (ungated > 0) {
    out.push(`  Includes ${plural(ungated, 'ungated agent', 'ungated agents')} (workflow, resumed, nested, exempt or unseen): not held to a unit.`)
  }
  const workerBoxes = task.rows.reduce((n, r) => n + r.agents, 0) + task.unknownAgents
  if (workerBoxes === 0) out.push('  Nothing delegated in this task yet.')
  else if (task.share === null) out.push('  Delegated: not shown while some counts are partial (≥).')
  else out.push(`  Delegated: ${task.share.all}% of all tokens (${task.share.in}% of in, ${task.share.out}% of out).`)
  out.push('')

  // since the board started
  out.push(...table(`Since ${since}, every task`, every))
  out.push('')

  // context kept out of the lead
  out.push('  Context kept out of the lead (this task)')
  if (workerBoxes === 0) {
    out.push('  No worker has run in this task yet.')
  } else {
    const k = task.kept
    out.push(`  Workers' largest contexts, summed: ${count(k.peaks, k.partial)} tokens. Their answers back: ${formatCount(k.back)} chars.`)
    out.push(`  The lead's largest context: ${k.leadPeak === null ? 'n/a' : `${formatCount(k.leadPeak)} tokens`}.`)
    out.push(`  Workers' input over all their requests: ${count(k.workersIn, k.partial)} tokens (each request counts its whole context again).`)
  }
  out.push('')

  // overhead
  const o = task.overhead
  out.push('  Overhead (this task)')
  out.push(`  Runs whose unit was rejected: ${o.rejected.agents === 0 ? 'none' : counted(o.rejected)}`)
  out.push(`  Later runs of a unit already run: ${o.later.agents === 0 ? 'none' : counted(o.later)}`)
  out.push(
    `  Together, each agent once: ${
      o.together.agents === 0 ? 'none' : counted(o.together) + (o.together.share === null ? '' : ` · ${o.together.share}% of all tokens`)
    }`,
  )
  out.push(
    `  Briefs and follow-up messages: ${
      o.briefAgents === 0 ? 'none' : `${formatCount(o.briefChars)} chars to ${agents(o.briefAgents)} (part of the lead's out)`
    }`,
  )
  out.push(
    `  Board updates: ${
      o.board.calls === 0 ? 'none' : `${plural(o.board.calls, 'call', 'calls')} · ${formatCount(o.board.chars)} chars (part of the lead's out)`
    }`,
  )
  if (injected.length > 0) {
    const total = injected.reduce((n, p) => n + p.chars, 0)
    const parts = injected.map(p => `${p.name} ${formatCount(p.chars)}`).join(', ')
    const requests = task.lead.tokens?.requests ?? 0
    out.push(
      `  Flowestra's text in the lead's prompt: ${formatCount(total)} chars (${parts}), sent with each of the lead's ${plural(requests, 'request', 'requests')} in this task`,
    )
  }
  out.push('')

  // partial counts
  const halves: string[] = []
  if (every.partialAgents > 0) halves.push(`${every.partialAgents} agents started before the board saw them (≥)`)
  if (every.unknownAgents > 0) halves.push(`${every.unknownAgents} agents have no counts (n/a)`)
  if (halves.length > 0) out.push(`Partial counts: ${halves.join('; ')}.`)

  out.push('What this cannot tell you: how many tokens the same work would have used without Flowestra. README, "Token figures".')
  return out
}
