// The token figures of the Agent Board (pure): the board's measured counts turned
// into rows by model, sums, the share delegated, the context kept out of the lead
// and the overhead of repeated work. Nothing here is estimated: every figure is a
// count the API reported or a sum or ratio of such counts; characters stay
// characters. No I/O. Imports state.ts and ../types only.

import type { AgentBox, Board, BoxStatus, Tier, Tokens } from '../types'
import { MAIN_ID, inActiveTask, modelTier, prettyModel, runTier, unitOf } from './state'

export type UsageRow = {
  model: string                           // prettyModel of the model that ran
  tier: Tier | null                       // the tier of that model; null: another model or unknown
  agents: number                          // boxes with counts in the row
  substituted: Partial<Record<Tier, number>> // work of a tier that ran on this model, by the tier of the work
  ungated: number                         // boxes the gate did not hold to a unit
  tokens: Tokens
  partial: boolean                        // some box in the row started before the board saw it
}
export type Counted = { agents: number; in: number; out: number; partial: boolean }
export type UsageScope = {
  lead: { model: string; tokens: Tokens | null; partial: boolean; peakIn: number | null }
  rows: UsageRow[]                        // workers only, ordered haiku, sonnet, opus, other
  all: { tokens: Tokens; partial: boolean }
  share: { all: number; in: number; out: number } | null
  kept: { peaks: number; back: number; workersIn: number; leadPeak: number | null; partial: boolean }
  overhead: {
    rejected: Counted
    later: Counted
    together: Counted & { share: number | null }
    briefChars: number
    briefAgents: number
    board: { calls: number; chars: number }
  }
  partialAgents: number                   // workers with counts that started before the board saw them
  unknownAgents: number                   // workers with no counts
}

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 })

function addTo(sum: Tokens, t: Tokens): void {
  sum.input += t.input
  sum.output += t.output
  sum.cacheRead += t.cacheRead
  sum.cacheWrite += t.cacheWrite
  sum.requests += t.requests
}

/** Every input token a request was answered over: new input, cache writes and cache reads. */
const inOf = (t: Tokens): number => t.input + t.cacheWrite + t.cacheRead
const allOf = (t: Tokens): number => inOf(t) + t.output

const TIER_RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2 }
const rankOf = (tier: Tier | null): number => (tier === null ? 3 : TIER_RANK[tier])

const percent = (part: number, whole: number): number => (whole > 0 ? Math.round((100 * part) / whole) : 0)

/** The unit key of a worker run: its task and its unit id, or its name when the link is gone; null: neither. */
function runKey(box: AgentBox): string | null {
  const unit = box.unitId ?? box.name
  if (unit === null || unit === undefined || unit === '') return null
  return `${box.taskId ?? ''}\u0000${unit}`
}

/** The 0.12.0 rejected-run rule: the boxes whose (task, unit) is in `board.rejects` or whose unit has verdict rejected. */
function rejectedBoxes(board: Board, boxes: AgentBox[]): Set<AgentBox> {
  const out = new Set<AgentBox>()
  const rejectKeys = new Set((board.rejects ?? []).map(r => `${r.taskId ?? ''}\u0000${r.unitId}`))
  for (const box of boxes) {
    const key = runKey(box)
    if ((key !== null && rejectKeys.has(key)) || unitOf(board, box)?.verdict === 'rejected') out.add(box)
  }
  return out
}

/** The 0.12.0 later-run rule: the run number of each box with a unit key (1 first, 2 next, ...), by startedAt then board order; boxes with no key are absent. */
function runNumbers(boxes: AgentBox[]): Map<AgentBox, number> {
  const seen = new Map<string, number>()
  const out = new Map<AgentBox, number>()
  const ordered = boxes
    .map((box, index) => ({ box, index }))
    .sort((a, b) => (a.box.startedAt ?? Infinity) - (b.box.startedAt ?? Infinity) || a.index - b.index)
  for (const { box } of ordered) {
    const key = runKey(box)
    if (key === null) continue
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    out.set(box, n)
  }
  return out
}

/** The workers of a scope, in board order (ordered ids first, then any left over); the lead is never one. */
function scopeWorkers(board: Board, scope: 'task' | 'all'): AgentBox[] {
  const ids = [...board.order.filter(id => board.agents[id] !== undefined), ...Object.keys(board.agents).filter(id => !board.order.includes(id))]
  const workers: AgentBox[] = []
  for (const id of ids) {
    const box = board.agents[id] as AgentBox
    if (box.id === MAIN_ID || id === MAIN_ID) continue
    if (scope === 'all' || inActiveTask(board, box)) workers.push(box)
  }
  return workers
}

/** True when the lead or any box has counts. */
export function hasUsage(board: Board): boolean {
  return Object.values(board.agents).some(b => b.tokens !== null && b.tokens !== undefined)
}

/** The figures of one scope: `'task'` (the active task's workers and the lead's tokens in it) or `'all'` (since the board started). */
export function usageScope(board: Board, scope: 'task' | 'all'): UsageScope {
  const taskKey = board.taskId ?? ''
  const leadBox = board.agents[MAIN_ID] ?? null
  const workers = scopeWorkers(board, scope)

  // the lead
  const leadTokens: Tokens | null =
    scope === 'task' ? (board.leadByTask ?? {})[taskKey] ?? null : leadBox?.tokens ?? null
  const lead = {
    model: prettyModel(leadBox?.model ?? null),
    tokens: leadTokens,
    partial: scope === 'all' ? leadBox?.tokensPartial === true : false,
    peakIn: leadBox?.peakIn ?? null,
  }

  // the workers' rows, by the model that ran
  const rowsByModel = new Map<string, UsageRow>()
  let partialAgents = 0
  let unknownAgents = 0
  const workerSum = zero()
  for (const box of workers) {
    if (box.tokens === null || box.tokens === undefined) {
      unknownAgents += 1
      continue
    }
    if (box.tokensPartial) partialAgents += 1
    addTo(workerSum, box.tokens)
    const model = prettyModel(box.model)
    let row = rowsByModel.get(model)
    if (row === undefined) {
      row = { model, tier: modelTier(box.model), agents: 0, substituted: {}, ungated: 0, tokens: zero(), partial: false }
      rowsByModel.set(model, row)
    }
    row.agents += 1
    addTo(row.tokens, box.tokens)
    if (box.tokensPartial) row.partial = true
    if (box.ungated !== null && box.ungated !== undefined) row.ungated += 1
    const ran = runTier(board, box)
    if (ran !== null && row.tier !== null && ran !== row.tier) row.substituted[ran] = (row.substituted[ran] ?? 0) + 1
  }
  const rows = [...rowsByModel.values()]
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rankOf(a.row.tier) - rankOf(b.row.tier) || a.index - b.index)
    .map(x => x.row)

  // everything counted
  const allTokens = zero()
  if (leadTokens !== null) addTo(allTokens, leadTokens)
  addTo(allTokens, workerSum)
  const anyKnown = leadTokens !== null || rows.length > 0
  const all = {
    tokens: allTokens,
    partial: lead.partial || rows.some(r => r.partial) || (unknownAgents > 0 && anyKnown),
  }

  // share delegated (2.3)
  const noneUncertain = partialAgents === 0 && unknownAgents === 0 && !lead.partial
  const leadSum = leadTokens ?? zero()
  const total = allOf(leadSum) + allOf(workerSum)
  const share =
    total > 0 && workers.length > 0 && noneUncertain
      ? {
          all: percent(allOf(workerSum), total),
          in: percent(inOf(workerSum), inOf(leadSum) + inOf(workerSum)),
          out: percent(workerSum.output, leadSum.output + workerSum.output),
        }
      : null

  // context kept out of the lead (2.4)
  const kept = {
    peaks: workers.reduce((n, b) => n + (b.peakIn ?? 0), 0),
    back: workers.reduce((n, b) => n + (b.resultChars ?? 0), 0),
    workersIn: inOf(workerSum),
    leadPeak: lead.peakIn,
    partial: partialAgents + unknownAgents > 0,
  }

  // overhead (2.5): rejected runs, later runs, and the union, each box once
  const rejectedIds = rejectedBoxes(board, workers)
  const laterIds = new Set<AgentBox>([...runNumbers(workers)].filter(([, n]) => n > 1).map(([box]) => box))
  const counted = (boxes: Iterable<AgentBox>): Counted => {
    const c: Counted = { agents: 0, in: 0, out: 0, partial: false }
    for (const box of boxes) {
      c.agents += 1
      if (box.tokens === null || box.tokens === undefined) {
        c.partial = true
        continue
      }
      c.in += inOf(box.tokens)
      c.out += box.tokens.output
      if (box.tokensPartial) c.partial = true
    }
    return c
  }
  const union = new Set<AgentBox>([...rejectedIds, ...laterIds])
  const together = counted(union)
  const togetherShare = together.agents > 0 && total > 0 && noneUncertain ? percent(together.in + together.out, total) : null

  const sent = board.boardSent ?? {}
  const boardSent =
    scope === 'task'
      ? sent[taskKey] ?? { calls: 0, chars: 0 }
      : Object.values(sent).reduce((n, s) => ({ calls: n.calls + s.calls, chars: n.chars + s.chars }), { calls: 0, chars: 0 })
  const briefed = workers.filter(b => b.briefChars !== null && b.briefChars !== undefined)

  return {
    lead,
    rows,
    all,
    share,
    kept,
    overhead: {
      rejected: counted(rejectedIds),
      later: counted(laterIds),
      together: { ...together, share: togetherShare },
      briefChars: briefed.reduce((n, b) => n + (b.briefChars ?? 0), 0),
      briefAgents: briefed.length,
      board: { calls: boardSent.calls, chars: boardSent.chars },
    },
    partialAgents,
    unknownAgents,
  }
}

export type WorkerUsage = {
  id: string
  label: string              // `${unitId} ${label}` when the box has a unit, else its label
  model: string              // prettyModel of the model that ran
  tier: Tier | null          // modelTier of that model
  status: BoxStatus
  tokens: Tokens | null      // null: no counts (n/a)
  partial: boolean           // tokensPartial
  rejected: boolean          // the 0.12.0 rejected-run rule
  run: number                // 1 for the first run of its (task, unit), 2 for the next ...; 1 when it has no unit key
  ungated: boolean
  substitutedFrom: Tier | null // the tier of the work when it ran on another tier's model (runTier differs from tier)
  otherTask: boolean         // scope 'all' only: the box is not in the active task
}

/** One entry per worker of the scope (never the lead), by all tokens descending, boxes with no counts last, ties by start then board order. */
export function workerUsage(board: Board, scope: 'task' | 'all'): WorkerUsage[] {
  const workers = scopeWorkers(board, scope)
  const rejected = rejectedBoxes(board, workers)
  const runs = runNumbers(workers)
  return workers
    .map((box, index) => ({ box, index }))
    .sort((a, b) => {
      const ta = a.box.tokens ?? null
      const tb = b.box.tokens ?? null
      if (ta === null || tb === null) return ta === tb ? a.index - b.index : ta === null ? 1 : -1
      return allOf(tb) - allOf(ta) || (a.box.startedAt ?? Infinity) - (b.box.startedAt ?? Infinity) || a.index - b.index
    })
    .map(({ box }) => {
      const tier = modelTier(box.model)
      const ran = runTier(board, box)
      const hasUnit = box.unitId !== null && box.unitId !== undefined && box.unitId !== ''
      return {
        id: box.id,
        label: hasUnit ? `${box.unitId} ${box.label}` : box.label,
        model: prettyModel(box.model),
        tier,
        status: box.status,
        tokens: box.tokens ?? null,
        partial: box.tokensPartial === true,
        rejected: rejected.has(box),
        run: runs.get(box) ?? 1,
        ungated: box.ungated !== null && box.ungated !== undefined,
        substitutedFrom: ran !== null && tier !== null && ran !== tier ? ran : null,
        otherTask: scope === 'all' && !inActiveTask(board, box),
      }
    })
}
