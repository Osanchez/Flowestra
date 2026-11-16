// Agent Board: the session log (visual layer 0.4.0; three tiers 0.6.0). Pure:
// no `$`, no clock (the time of an entry comes in as an argument). What
// happened, oldest first: a worker spawned (with its unit's task type), its
// audit line, its missing one (policy §9) or a tier its unit did not declare,
// a worker ended (a Sonnet worker's result marked as a draft), a unit's
// verdict (a corrected rejection reads "rejection withdrawn → accepted"), a
// task type barred at a tier (policy §8), the phase changed, and, for tasks
// (0.7.0), a task opened, switched to, reopened or closed. The board's units
// and phase are the ACTIVE task's, so when the active task changes in an update
// no verdict or phase entry is made (the lists are different tasks'; B3.2).
// register.tsx compares the board before and after each write and pushes what changed.

import type { AgentBox, Board, BoxStatus, Log, LogEntry, Tier } from '../types'
import { MAIN_ID, auditIssue, barred, fedUnits, formatDuration, isPlaceholder, prettyModel, runTier, unitOf, withdrawn } from './state'

// Change the tag when Log's fields change (see BOARD_SHAPE in state.ts).
// 0.5.0 only widened LogKind ('audit', 'verdict'): the fields are the same, so the tag stays.
export const LOG_SHAPE = 'log-1'
export const LOG_MAX = 50

const ENDED: ReadonlySet<BoxStatus> = new Set<BoxStatus>(['done', 'failed', 'stopped'])

export function emptyLog(): Log {
  return { entries: [] }
}

/** Appends `entries`, keeping the newest LOG_MAX; the same object when there are none. */
export function logPush(log: Log, entries: readonly LogEntry[]): Log {
  if (entries.length === 0) return log
  const all = [...log.entries, ...entries]
  return { entries: all.length > LOG_MAX ? all.slice(all.length - LOG_MAX) : all }
}

/** Boxes in order of first appearance, then any missing from `order`. */
function boxesOf(board: Board): AgentBox[] {
  const seen = new Set<string>()
  const out: AgentBox[] = []
  for (const id of [...board.order, ...Object.keys(board.agents)]) {
    if (seen.has(id)) continue
    seen.add(id)
    const box = board.agents[id]
    if (box) out.push(box)
  }
  return out
}

/** A unit's declared tier, compared against the literals: null when missing or anything else. */
function tierOfUnit(tier: unknown): Tier | null {
  return tier === 'opus' || tier === 'sonnet' || tier === 'haiku' ? tier : null
}

function elapsedPart(box: AgentBox): string {
  if (box.startedAt === null || box.endedAt === null) return ''
  return ` · ${formatDuration(box.endedAt - box.startedAt)}`
}

/** The model part of a spawn line: `opus→Sonnet 5.5` when the settings substituted another model, else the model. */
function ranOnPart(box: AgentBox): string {
  const r = box.routed
  const name = prettyModel(box.model)
  return r && r.ranOn !== undefined && r.ranOn !== r.tier ? `${r.tier}→${name}` : name
}

function endedEntry(board: Board, box: AgentBox, at: number): LogEntry | null {
  switch (box.status) {
    case 'done': {
      const draft = runTier(board, box) === 'sonnet' ? ' · draft' : ''
      return { at, kind: 'done', who: box.label, text: `done${elapsedPart(box)}${draft}` }
    }
    case 'failed':
      return { at, kind: 'failed', who: box.label, text: box.reason ? `failed: ${box.reason}` : `failed${elapsedPart(box)}` }
    case 'stopped':
      return { at, kind: 'stopped', who: box.label, text: `stopped${elapsedPart(box)}` }
    default:
      return null
  }
}

type AuditState = 'none' | 'no-audit' | 'tier-mismatch' | 'audited'

/**
 * 'none' when the box is absent or still a placeholder (known only by its id);
 * otherwise what is wrong with its routing on `board` ('no-audit',
 * 'tier-mismatch'), or 'audited' when nothing is.
 */
function auditState(board: Board, box: AgentBox | undefined): AuditState {
  if (box === undefined || isPlaceholder(box)) return 'none'
  const issue = auditIssue(board, box)
  return issue === 'none' ? 'audited' : issue
}

function auditEntry(before: Board, after: Board, prev: AgentBox | undefined, box: AgentBox, at: number): LogEntry | null {
  const was = auditState(before, prev)
  const is = auditState(after, box)
  if (is === was) return null
  if (is === 'audited') {
    return { at, kind: 'audit', who: box.label, text: unitOf(after, box)?.audit ?? '' }
  }
  if (is === 'no-audit' && was === 'none') {
    return { at, kind: 'audit', who: box.label, text: 'no audit line (policy §9)' }
  }
  if (is === 'tier-mismatch') {
    const said0 = unitOf(after, box)?.tier ?? ''
    const ranOn = box.routed?.ranOn
    const said = ranOn !== undefined && ranOn !== box.routed?.tier ? `${said0} on ${ranOn}` : said0
    return { at, kind: 'audit', who: box.label, text: `ran on ${prettyModel(box.model)}, unit says ${said}` }
  }
  return null
}

/**
 * What changed between two boards, as log entries at `at`, in this order:
 * per worker box (order of first appearance, the lead never): its spawn
 * ("spawned · Opus 5.5 · design", the task type only when its unit has one),
 * made when the box first shows with its real label (new on `after`, or a
 * placeholder known only by its id on `before`; a placeholder appearing makes
 * none); its audit entry, a placeholder counting as no audit state so the
 * entry carries the real label: becoming audited (the unit's audit line),
 * first showing with no audit line ("no audit line (policy §9)"), becoming a
 * tier mismatch ("ran on Haiku 5.5, unit says sonnet"); its end (done, with
 * " · draft" for a Sonnet worker; failed; stopped). Then each unit with a tier
 * whose verdict changed to a set one ("accepted → feeds A, B", "accepted",
 * "rejected → re-route upward (policy §8)"); then each task type newly barred
 * at a tier ("haiku barred for locate (2 rejected)", by the lead); last, a
 * phase change to a phase that is set. Nothing else makes an entry.
 *
 * Tasks (0.7.0): the task entries (kind 'phase', by the lead) come FIRST: each
 * task id newly in `closed` ("task wb-ui closed"), then, when the active task
 * changed to a task id: "task → wb-ui" (it was parked), "task wb-ui reopened"
 * (it was closed), else "task wb-ui opened". The spawn shows the kind recorded
 * at spawn (`routed`) before its unit's. When the active task changed, no
 * verdict, "rejection withdrawn" or phase entry is made (box, audit, ended and
 * barred entries are as always). When it did not: a unit whose rejection was
 * withdrawn and is now accepted reads "rejection withdrawn → accepted"; the
 * phase entry carries " · <task id>" while more than one task is open.
 */
export function logDiff(before: Board, after: Board, at: number): LogEntry[] {
  const out: LogEntry[] = []
  const switched = before.taskId !== after.taskId
  const wasClosed = new Set((before.closed ?? []).map(t => t.taskId))
  for (const t of after.closed ?? []) {
    if (!wasClosed.has(t.taskId)) out.push({ at, kind: 'phase', who: 'lead', text: `task ${t.taskId} closed` })
  }
  if (after.taskId !== null && switched) {
    const id = after.taskId
    let text: string
    if ((before.parked ?? []).some(t => t.taskId === id)) text = `task → ${id}`
    else if (wasClosed.has(id)) text = `task ${id} reopened`
    else text = `task ${id} opened`
    out.push({ at, kind: 'phase', who: 'lead', text })
  }
  for (const box of boxesOf(after)) {
    if (box.id === MAIN_ID) continue
    const prev = before.agents[box.id]
    if (!isPlaceholder(box) && (prev === undefined || isPlaceholder(prev))) {
      const kind: unknown = box.routed?.kind ?? unitOf(after, box)?.kind
      const kindPart = typeof kind === 'string' && kind !== '' ? ` · ${kind}` : ''
      out.push({ at, kind: 'spawned', who: box.label, text: `spawned · ${ranOnPart(box)}${kindPart}` })
    }
    const audit = auditEntry(before, after, prev, box, at)
    if (audit !== null) out.push(audit)
    if (ENDED.has(box.status) && !(prev !== undefined && ENDED.has(prev.status))) {
      const entry = endedEntry(after, box, at)
      if (entry !== null) out.push(entry)
    }
  }
  const undone = switched ? [] : withdrawn(before, after)
  for (const unit of switched ? [] : after.units) {
    if (tierOfUnit(unit.tier) === null || unit.verdict === null || unit.verdict === undefined) continue
    const was = before.units.find(u => u.id === unit.id)?.verdict ?? null
    if (was === unit.verdict) continue
    let text: string
    if (unit.verdict === 'accepted' && undone.some(w => w.taskId === after.taskId && w.unitId === unit.id)) {
      text = 'rejection withdrawn → accepted'
    } else if (unit.verdict === 'accepted') {
      const fed = fedUnits(after, unit.id).map(u => u.label)
      text = fed.length > 0 ? `accepted → feeds ${fed.join(', ')}` : 'accepted'
    } else {
      text = 'rejected → re-route upward (policy §8)'
    }
    out.push({ at, kind: 'verdict', who: unit.label, text })
  }
  const wasBarred = barred(before)
  for (const b of barred(after)) {
    if (wasBarred.some(x => x.tier === b.tier && x.kind === b.kind)) continue
    out.push({ at, kind: 'verdict', who: 'lead', text: `${b.tier} barred for ${b.kind} (${b.n} rejected)` })
  }
  if (!switched && after.phase !== before.phase && after.phase !== null) {
    const task = (after.parked ?? []).length > 0 ? ` · ${after.taskId}` : ''
    out.push({ at, kind: 'phase', who: 'lead', text: `phase → ${after.phase}${task}` })
  }
  return out
}
