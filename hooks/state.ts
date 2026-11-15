import { atom } from 'claude-code'
import type { ModelUsage } from 'claude-code'

import type { AgentBox, Board, BoxStatus, Live, Phase, Routed, Row, TaskKind, TaskSlot, Tier, Tokens, Unit } from '../types'

// A running worker with no event at all for this long gets the quiet mark (owner's decision 2).
export const QUIET_SECONDS = 120

export const MAIN_ID = 'main'
const MAIN_LABEL = 'Orchestrator'
const DEFAULT_TYPE = 'general-purpose'

// Change the tag when Board's fields change: a value an older version stored
// outlives a reload, and the tag is how new code declines it.
// board-2: AgentBox gained `name` and `parentId`. A value stored under
// board-1 (or untagged) is read as the initial board, per the shape rule.
// board-3: Unit gained tier, kind, audit, verdict; Board gained rejects.
// board-4: three tiers (opus, sonnet, haiku); Unit gained spec; a reject records its tier.
// board-5: workstreams. Board gained taskId, repo, parked, closed, activeAt;
// AgentBox gained taskId and routed; a reject records its taskId; Unit gained context.
// register.tsx declares its own atoms over the same refs with these tags
// (`claude plugin validate` reads only an atom made in the file that uses it).
export const BOARD_SHAPE = 'board-5'
export const LIVE_SHAPE = 'live-1'

export const boardAtom = atom({ plugin: 'flowestra', key: 'board' } as const, emptyBoard(0), {
  shape: BOARD_SHAPE,
})

export function emptyLive(): Live {
  return { now: 0, sessionTotal: null, paneOpen: false }
}

// The clock tick the view draws from, the session total text and whether the pane is open.
export const liveAtom = atom({ plugin: 'flowestra', key: 'live' } as const, emptyLive(), {
  shape: LIVE_SHAPE,
})

/** A board with no task open and no agent seen; `now` is when it loaded (and its empty slot became active). */
export function emptyBoard(now: number): Board {
  return {
    taskId: null,
    repo: null,
    task: null,
    phase: null,
    wave: null,
    units: [],
    agents: {},
    order: [],
    loadedAt: now,
    note: null,
    rejects: [],
    parked: [],
    closed: [],
    activeAt: now,
  }
}

export function resetBoard(now: number): Board {
  return emptyBoard(now)
}

// ---- text helpers shared by the view and the session log (pure) ----

/** `45s`, `3m 12s`, `1h 02m`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

/**
 * The model's short name: `model n/a` when unknown; otherwise the id less a
 * leading `claude-` and a trailing date stamp (`-` and 8 digits).
 */
export function shortModel(model: string | null): string {
  if (model === null || model === '') return 'model n/a'
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

/**
 * The model's display name: `claude-opus-5-5` → `Opus 5.5`,
 * `claude-haiku-5-5-20261001` → `Haiku 5.5`, `opus` → `Opus`. The leading
 * non-numeric words capitalised, the numeric parts joined with `.`; an id of
 * any other shape comes back as `shortModel` gives it; `model n/a` when unknown.
 */
export function prettyModel(model: string | null): string {
  const short = shortModel(model)
  if (model === null || model === '') return short
  const parts = short.split('-')
  const words: string[] = []
  let i = 0
  while (i < parts.length && parts[i] !== '' && !/^\d+$/.test(parts[i] as string)) {
    words.push(parts[i] as string)
    i += 1
  }
  const nums = parts.slice(i)
  if (words.length === 0 || !nums.every(p => /^\d+$/.test(p))) return short
  const name = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  return nums.length > 0 ? `${name} ${nums.join('.')}` : name
}

/** The Agent description cut to its first 4 words; the type when it has none. */
export function cutLabel(description: string | null | undefined, fallback: string): string {
  const words = (description ?? '').trim().split(/\s+/).filter(w => w.length > 0)
  return words.length > 0 ? words.slice(0, 4).join(' ') : fallback
}

/** A label's match key: its first 4 words, lower-cased, joined by single spaces. */
export function labelKey(text: string | null | undefined): string {
  return cutLabel(text, '').toLowerCase()
}

/**
 * The unit whose label matches `description` (both cut to their first 4 words,
 * case and spacing ignored), when the key is non-empty and exactly one unit matches.
 */
export function unitByLabel(board: Board, description: string | null | undefined): Unit | null {
  const key = labelKey(description)
  if (key === '') return null
  const hits = board.units.filter(u => labelKey(u.label) === key)
  return hits.length === 1 ? hits[0]! : null
}

function newBox(id: string, now: number, over: Partial<AgentBox>): AgentBox {
  return {
    id,
    label: id,
    type: '',
    model: null,
    unitId: null,
    name: null,
    parentId: null,
    status: 'running',
    reason: null,
    tokens: null,
    tokensPartial: false,
    startedAt: null,
    endedAt: null,
    lastEventAt: null,
    lastTool: null,
    briefChars: null,
    resultChars: null,
    flow: { dir: null, at: null },
    taskId: null,
    routed: null,
    ...over,
  }
}

function put(board: Board, box: AgentBox): Board {
  const known = board.agents[box.id] !== undefined
  return {
    ...board,
    agents: { ...board.agents, [box.id]: box },
    order: known ? board.order : [...board.order, box.id],
  }
}

/**
 * The box events for `agentId` land in, made when missing: `undefined` is the
 * orchestrator; an unknown worker id was alive before the board loaded (spec 5),
 * so its counts are partial and its label is its id until reconcile fills it.
 */
function boxFor(board: Board, agentId: string | undefined, now: number): AgentBox {
  const id = agentId ?? MAIN_ID
  const known = board.agents[id]
  if (known) return known
  if (id === MAIN_ID) {
    return newBox(MAIN_ID, now, { label: MAIN_LABEL, type: 'orchestrator', status: 'running', startedAt: now })
  }
  return newBox(id, now, { status: 'running', tokensPartial: true })
}

/** A worker box known only by its id so far (its label is its id); never the orchestrator. */
export function isPlaceholder(box: AgentBox): boolean {
  return box.id !== MAIN_ID && box.label === box.id
}

function unitIds(board: Board): Set<string> {
  return new Set(board.units.map(u => u.id))
}

// ---- tasks (workstreams, 0.7.0): the active slot, parked and closed tasks (pure) ----

function parkedOf(board: Board): TaskSlot[] {
  return board.parked ?? []
}

function closedOf(board: Board): TaskSlot[] {
  return board.closed ?? []
}

function copyUnit(u: Unit): Unit {
  return { ...u, dependsOn: [...u.dependsOn], context: [...(u.context ?? [])] }
}

/** The active task as a slot (status open), or null when no task is open. */
function activeSlot(board: Board): TaskSlot | null {
  if (board.taskId === null) return null
  return {
    taskId: board.taskId,
    task: board.task,
    repo: board.repo,
    phase: board.phase,
    wave: board.wave,
    units: board.units,
    status: 'open',
    activeAt: board.activeAt,
  }
}

/** `board` with `slot` (or an empty slot when null) loaded as the active task, active since `now`. */
function loadActive(board: Board, slot: TaskSlot | null, now: number): Board {
  return {
    ...board,
    taskId: slot?.taskId ?? null,
    repo: slot?.repo ?? null,
    task: slot?.task ?? null,
    phase: slot?.phase ?? null,
    wave: slot?.wave ?? null,
    units: slot ? slot.units : [],
    activeAt: now,
  }
}

function freshSlot(taskId: string, now: number): TaskSlot {
  return { taskId, task: null, repo: null, phase: null, wave: null, units: [], status: 'open', activeAt: now }
}

/** The first `task-N` (N from 1) that names no open or closed task. */
function nextTaskId(board: Board): string {
  const used = new Set(taskSlots(board).map(s => s.taskId))
  let n = 1
  while (used.has(`task-${n}`)) n += 1
  return `task-${n}`
}

/**
 * Makes `taskId` the active task: the active one already, nothing changes; a
 * parked one is swapped with the active slot (which is parked with its
 * `activeAt`); a closed one is reopened (moved out of `closed`); an unknown one
 * is opened empty. The previous active slot, when there is one, is parked.
 */
function switchTo(board: Board, taskId: string, now: number): Board {
  if (taskId === board.taskId) return board
  const parked = parkedOf(board)
  const closed = closedOf(board)
  const target = parked.find(s => s.taskId === taskId) ?? closed.find(s => s.taskId === taskId) ?? freshSlot(taskId, now)
  const current = activeSlot(board)
  return {
    ...loadActive(board, target, now),
    parked: [...parked.filter(s => s.taskId !== taskId), ...(current ? [current] : [])],
    closed: closed.filter(s => s.taskId !== taskId),
  }
}

/**
 * Closes the active task: its slot moves to `closed` with status closed; the
 * parked task with the greatest `activeAt` (the first of equals) becomes active;
 * with none parked, the active slot is empty. No task open: unchanged.
 */
function closeActive(board: Board, now: number): Board {
  const current = activeSlot(board)
  if (current === null) return board
  const parked = parkedOf(board)
  let next: TaskSlot | null = null
  for (const s of parked) if (next === null || s.activeAt > next.activeAt) next = s
  return {
    ...loadActive(board, next, now),
    parked: parked.filter(s => s !== next),
    closed: [...closedOf(board).filter(s => s.taskId !== current.taskId), { ...current, status: 'closed' }],
  }
}

/**
 * Makes a task loaded from the journal's state file the active one, active
 * since `now` (the wiring calls it when an update names an id the board does
 * not know but the journal has a state file for). The previous active task is
 * parked; a parked or closed slot of the same id is replaced. Whatever status
 * the file gave, the task is open once loaded. No reject is added: bars are per
 * session (policy §8).
 */
export function openTask(board: Board, slot: TaskSlot, now: number): Board {
  const others = (s: TaskSlot) => s.taskId !== slot.taskId
  const current = activeSlot(board)
  const loaded: TaskSlot = { ...slot, units: slot.units.map(copyUnit), status: 'open' }
  return {
    ...loadActive(board, loaded, now),
    parked: [...parkedOf(board).filter(others), ...(current && others(current) ? [current] : [])],
    closed: closedOf(board).filter(others),
  }
}

/** Every task of the session: the active one first (when open), then the parked ones, then the closed ones. */
export function taskSlots(board: Board): TaskSlot[] {
  const current = activeSlot(board)
  return [...(current ? [current] : []), ...parkedOf(board), ...closedOf(board)]
}

/** The task with this id (active, parked or closed), or null. */
export function slotOf(board: Board, taskId: string): TaskSlot | null {
  return taskSlots(board).find(s => s.taskId === taskId) ?? null
}

/** The units of task `taskId` (the active list when it is the active id, or null with no task open); [] for an unknown task. */
function unitsOfTask(board: Board, taskId: string | null): Unit[] {
  if (taskId === board.taskId) return board.units
  if (taskId === null) return []
  return [...parkedOf(board), ...closedOf(board)].find(s => s.taskId === taskId)?.units ?? []
}

/** The task whose units a box's unit id refers to: its own; with none recorded, the active task's. */
function boxTask(board: Board, box: AgentBox): string | null {
  return box.taskId ?? board.taskId
}

/** The box carries out unit `unitId` of task `taskId`. */
function carries(board: Board, box: AgentBox, taskId: string | null, unitId: string): boolean {
  return box.unitId === unitId && boxTask(board, box) === taskId
}

/**
 * The box belongs to the active task: its `taskId` equals the board's. With no
 * task open, only a box of no task does: the agents of closed tasks are counted
 * nowhere (spec section 1).
 */
export function inActiveTask(board: Board, box: AgentBox): boolean {
  return board.taskId === null ? box.taskId === null : box.taskId === board.taskId
}

/** The id of the other task a box belongs to; null when it belongs to the active task or to none. */
export function otherTaskOf(board: Board, box: AgentBox): string | null {
  return inActiveTask(board, box) ? null : (box.taskId ?? null)
}

/** The routing a unit gives a box at spawn: its tier, kind and audit line when it has all three; else null. */
function routedOf(unit: Unit | null | undefined): Routed | null {
  const tier = unitTier(unit)
  if (!unit || tier === null || unit.kind === null || unit.kind === undefined || !given(unit.audit)) return null
  return { tier, kind: unit.kind, audit: unit.audit }
}

export type SpawnInfo = {
  agentId: string
  description?: string | null
  subagentType?: string | null
  model?: string | null
  name?: string | null
  parentAgentId?: string | null
  promptChars?: number | null
  resumed?: boolean // true when the spawn resumes an existing agent
}

/**
 * `agent.spawn` answered with an agentId. `name` is kept, and links the box to
 * a unit when it equals a declared unit id (or later, when such a unit is
 * declared). `parentAgentId` is kept as `parentId`. A spawn the board saw is
 * observed for its whole life, so its counts are complete (`tokensPartial`
 * false), even over a placeholder box an earlier event made; only a spawn that
 * resumes an existing agent (`resumed`) keeps the previous box's value.
 *
 * Tasks (0.7.0): the box is stamped with the active `taskId`, and the unit is
 * looked up in the active task only. It records `routed` (tier, kind, audit)
 * from its covering unit when that unit has all three, else null. A spawn that
 * resumes an existing agent keeps that box's `taskId` and `routed`; when the
 * box belongs to another task than the active one, its unit link is kept too.
 */
export function applySpawn(board: Board, info: SpawnInfo, now: number): Board {
  const type = info.subagentType || DEFAULT_TYPE
  const prev = board.agents[info.agentId]
  const kept = info.resumed === true ? prev : undefined
  const taskId = kept ? (kept.taskId ?? null) : board.taskId
  const linkable = taskId === null || taskId === board.taskId
  const linked = !linkable
    ? null
    : info.name && unitIds(board).has(info.name)
      ? info.name
      : !info.name
        ? (unitByLabel(board, info.description)?.id ?? null)
        : null
  const unitId = linked ?? prev?.unitId ?? null
  const routed = kept
    ? (kept.routed ?? null)
    : routedOf(unitId !== null ? board.units.find(u => u.id === unitId) : null)
  const fields: Partial<AgentBox> = {
    label: cutLabel(info.description, type),
    type,
    model: info.model ?? prev?.model ?? null,
    unitId,
    taskId,
    routed,
    name: info.name ?? prev?.name ?? null,
    parentId: info.parentAgentId ?? prev?.parentId ?? null,
    status: 'starting',
    reason: null,
    startedAt: now,
    endedAt: null,
    lastEventAt: now,
    briefChars: info.promptChars ?? null,
    flow: { dir: 'out', at: now },
    tokensPartial: info.resumed ? (prev?.tokensPartial ?? false) : false,
  }
  return put(board, prev ? { ...prev, ...fields } : newBox(info.agentId, now, fields))
}

export function applyTurnStart(board: Board, agentId: string | undefined, now: number): Board {
  const box = boxFor(board, agentId, now)
  return put(board, {
    ...box,
    status: 'running',
    reason: null,
    startedAt: box.startedAt ?? now,
    endedAt: null,
    lastEventAt: now,
  })
}

export type StepUsage = Pick<
  ModelUsage,
  'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'
> & { model?: string | null }

/** One model request finished. A null usage adds nothing; tokens stay as they were. */
export function applyStep(board: Board, agentId: string | undefined, usage: StepUsage | null, now: number): Board {
  const box = boxFor(board, agentId, now)
  let tokens = box.tokens
  if (usage) {
    const t: Tokens = tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }
    tokens = {
      input: t.input + (usage.input_tokens ?? 0),
      cacheWrite: t.cacheWrite + (usage.cache_creation_input_tokens ?? 0),
      cacheRead: t.cacheRead + (usage.cache_read_input_tokens ?? 0),
      output: t.output + (usage.output_tokens ?? 0),
      requests: t.requests + 1,
    }
  }
  return put(board, {
    ...box,
    tokens,
    model: usage?.model ?? box.model,
    status: activeStatus(box, agentId),
    lastEventAt: now,
  })
}

/**
 * Activity means running: the orchestrator is running whatever it was (a
 * missed turn start leaves it nowhere else); a worker starting or waiting is
 * running; a worker that ended (done, failed, stopped) is never revived.
 */
function activeStatus(box: AgentBox, agentId: string | undefined): BoxStatus {
  if (agentId === undefined) return 'running'
  return box.status === 'starting' || box.status === 'waiting' ? 'running' : box.status
}

/**
 * A tool call. When the orchestrator calls `SendMessage`, pass the receiving
 * agent's id as `target`: that box's arrow points out.
 */
export function applyToolCall(
  board: Board,
  agentId: string | undefined,
  tool: string,
  now: number,
  target?: string | null,
): Board {
  const box = boxFor(board, agentId, now)
  const status = activeStatus(box, agentId)
  const revived = agentId === undefined && box.status !== 'running' ? { endedAt: null } : {}
  let next = put(board, { ...box, ...revived, status, lastTool: tool, lastEventAt: now })
  if (agentId === undefined && tool === 'SendMessage' && target && target !== MAIN_ID) {
    const to = next.agents[target]
    if (to) next = put(next, { ...to, flow: { dir: 'out', at: now } })
  }
  return next
}

export type CompleteInfo = { reason: 'answer' | 'aborted' | 'refusal' | 'error'; answerChars?: number | null }

/** A turn ended. Workers: answer → done, error/refusal → failed, aborted → stopped. Orchestrator → waiting. */
export function applyComplete(board: Board, agentId: string | undefined, info: CompleteInfo, now: number): Board {
  const box = boxFor(board, agentId, now)
  if (agentId === undefined) {
    return put(board, { ...box, status: 'waiting', reason: null, endedAt: now, lastEventAt: now })
  }
  const base = { ...box, endedAt: now, lastEventAt: now }
  switch (info.reason) {
    case 'answer':
      return put(board, {
        ...base,
        status: 'done',
        reason: null,
        resultChars: info.answerChars ?? null,
        flow: { dir: 'in', at: now },
      })
    case 'error':
    case 'refusal':
      return put(board, { ...base, status: 'failed', reason: info.reason })
    case 'aborted':
      return put(board, { ...base, status: 'stopped', reason: 'aborted' })
    default:
      return board
  }
}

export type ListEntry = {
  id: string
  description?: string | null
  type?: string | null
  status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
  parentId?: string | null
  name?: string | null
}

const LIST_STATUS: Record<ListEntry['status'], BoxStatus> = {
  pending: 'starting',
  running: 'running',
  waiting: 'waiting',
  idle: 'waiting',
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
}

const ENDED: ReadonlySet<BoxStatus> = new Set<BoxStatus>(['done', 'failed', 'stopped'])

/**
 * `$.agent.list()`: adds agents not yet known (partial counts), fills label and
 * type for boxes known only by id, links a unit from the list's `name`, and lets
 * the list's status win, except that a box ended by its own turn.complete is
 * not moved back to waiting by a lingering entry. The name links to a unit of
 * the active task, so only a box of the active task (or of none) is linked.
 */
export function reconcile(board: Board, list: readonly ListEntry[], now: number): Board {
  let next = board
  const units = unitIds(board)
  for (const entry of list) {
    if (!entry || !entry.id || entry.id === MAIN_ID) continue
    const mapped = LIST_STATUS[entry.status]
    const type = entry.type || DEFAULT_TYPE
    const linked = entry.name && units.has(entry.name) ? entry.name : null
    const prev = next.agents[entry.id]
    if (!prev) {
      next = put(
        next,
        newBox(entry.id, now, {
          label: cutLabel(entry.description, type),
          type,
          unitId: linked,
          name: entry.name ?? null,
          parentId: entry.parentId ?? null,
          status: mapped ?? 'running',
          reason: mapped === 'failed' ? 'failed' : mapped === 'stopped' ? 'killed' : null,
          tokensPartial: true,
          endedAt: mapped && ENDED.has(mapped) ? now : null,
        }),
      )
      continue
    }
    let box = prev
    if (box.label === box.id) box = { ...box, label: cutLabel(entry.description, type), type }
    else if (!box.type) box = { ...box, type }
    if (box.unitId === null && linked && (box.taskId === null || box.taskId === board.taskId)) box = { ...box, unitId: linked }
    if (box.name === null && entry.name) box = { ...box, name: entry.name }
    if (box.parentId === null && entry.parentId) box = { ...box, parentId: entry.parentId }
    if (mapped && mapped !== box.status && !(ENDED.has(box.status) && mapped === 'waiting')) {
      if (ENDED.has(mapped)) {
        box = {
          ...box,
          status: mapped,
          endedAt: box.endedAt ?? now,
          reason: box.reason ?? (mapped === 'failed' ? 'failed' : mapped === 'stopped' ? 'killed' : null),
        }
      } else {
        box = { ...box, status: mapped, endedAt: mapped === 'waiting' ? box.endedAt : null }
      }
    }
    if (box !== prev) next = put(next, box)
  }
  return next
}

export type BoardUpdate = {
  taskId?: string // the task the update is for: switched to, reopened or opened first
  repo?: string // the active task's repository (absolute)
  close?: true // close the active task, after the other fields applied
  task?: string | null
  phase?: Phase | null
  wave?: number | null
  units?: Unit[]
}

/**
 * The AgentBoard tool's partial update, in this order:
 *
 * 1. The task. `taskId` naming the active task: nothing to switch; a parked
 *    task: switched to (the active slot is parked with its `activeAt`); a closed
 *    task: reopened and made active; an unknown id: a new empty task is opened
 *    and made active (the previous active slot, when there is one, is parked).
 *    No `taskId` while no task is open: the first `task-N` no open or closed
 *    task uses is opened. A task made active here is active since `now`.
 * 2. The other fields apply to the active task: a field left out keeps its
 *    value; `units` replaces the whole list. When `units` is given, every box of
 *    the active task (or of no task) whose `name` equals a unit id is linked to
 *    it, an unnamed one is linked by its label, and a link to a unit no longer
 *    in the list is cleared; boxes of other tasks are not touched. Each unit with
 *    a tier, a kind and the verdict 'rejected' is added to `rejects` once per
 *    (taskId, unitId) (a unit dropped from the list keeps its entry); each unit
 *    with the verdict 'accepted' withdraws the entry of the same (taskId,
 *    unitId), if any (B3.2: a verdict can be corrected).
 * 3. `close: true`: the active task is closed (see `closeActive`): the parked
 *    task with the greatest `activeAt` becomes active, or none.
 */
export function applyBoardUpdate(board: Board, update: BoardUpdate, now: number): Board {
  let next = board
  if (given(update.taskId)) next = switchTo(next, update.taskId, now)
  else if (next.taskId === null) next = switchTo(next, nextTaskId(next), now)
  next = {
    ...next,
    task: update.task !== undefined ? update.task : next.task,
    repo: update.repo !== undefined ? update.repo : next.repo,
    phase: update.phase !== undefined ? update.phase : next.phase,
    wave: update.wave !== undefined ? update.wave : next.wave,
    units: update.units !== undefined ? update.units.map(copyUnit) : next.units,
  }
  if (update.units !== undefined) next = applyUnits(next, update.units)
  if (update.close === true) next = closeActive(next, now)
  return next
}

/** Rejects and links after the active task's units list was replaced by `units` (already on `board`). */
function applyUnits(board: Board, units: readonly Unit[]): Board {
  const taskId = board.taskId
  const same = (r: { unitId: string; taskId?: string | null }, unitId: string) => r.unitId === unitId && (r.taskId ?? null) === taskId
  let rejects = board.rejects ?? []
  for (const u of units) {
    const tier = unitTier(u)
    if (tier === null || u.kind === null || u.kind === undefined || u.verdict !== 'rejected') continue
    if (rejects.some(r => same(r, u.id))) continue
    rejects = [...rejects, { unitId: u.id, tier, kind: u.kind, taskId }]
  }
  for (const u of units) {
    if (u.verdict === 'accepted' && rejects.some(r => same(r, u.id))) rejects = rejects.filter(r => !same(r, u.id))
  }
  const ids = unitIds(board)
  let agents = board.agents
  for (const [id, box] of Object.entries(board.agents)) {
    if (box.taskId !== null && box.taskId !== undefined && box.taskId !== taskId) continue
    let unitId = box.name !== null && ids.has(box.name) ? box.name : box.unitId !== null && ids.has(box.unitId) ? box.unitId : null
    if (unitId === null && box.name === null && id !== MAIN_ID) unitId = unitByLabel(board, box.label)?.id ?? null
    if (unitId !== box.unitId) {
      if (agents === board.agents) agents = { ...board.agents }
      agents[id] = { ...box, unitId }
    }
  }
  return { ...board, rejects, agents }
}

/**
 * The rejects present in `before` and gone from `after`, as (taskId, unitId):
 * the rejections an update withdrew (B3.2), for the session log.
 */
export function withdrawn(before: Board, after: Board): Array<{ taskId: string | null; unitId: string }> {
  const key = (r: { unitId: string; taskId?: string | null }) => `${r.taskId ?? ''}\u0000${r.unitId}`
  const kept = new Set((after.rejects ?? []).map(key))
  return (before.rejects ?? []).filter(r => !kept.has(key(r))).map(r => ({ taskId: r.taskId ?? null, unitId: r.unitId }))
}

// ---- selectors (pure) ----

export type UnitState = 'running' | 'blocked' | 'ready' | 'done' | 'failed'

/**
 * Spec 2.3 "Derived": failed first when it is a unit with a tier the
 * orchestrator rejected (policy §8, whatever its agents did); running if an agent with its unitId is starting or running;
 * done / failed from that agent's end (the latest ended one; stopped counts as
 * failed), or from `declared` when no agent ended it; blocked while any
 * dependsOn unit is not done; otherwise ready.
 *
 * Tasks (0.7.0): `unit` is a unit of task `taskId` (the active task when left
 * out); only boxes of that task count (a box with no task counts for the
 * active one), and its dependencies are looked up in that task's units.
 */
export function unitState(board: Board, unit: Unit, taskId: string | null = board.taskId): UnitState {
  return unitStateIn(board, unit, taskId, new Set())
}

function unitStateIn(board: Board, unit: Unit, taskId: string | null, visiting: Set<string>): UnitState {
  if (unitTier(unit) !== null && unit.verdict === 'rejected') return 'failed'
  const boxes = board.order
    .map(id => board.agents[id])
    .filter((b): b is AgentBox => !!b && carries(board, b, taskId, unit.id))
  if (boxes.some(b => b.status === 'starting' || b.status === 'running')) return 'running'
  const ended = boxes.filter(b => ENDED.has(b.status))
  const last = ended[ended.length - 1]
  if (last) return last.status === 'done' ? 'done' : 'failed'
  if (unit.declared === 'done' || unit.declared === 'failed') return unit.declared
  visiting.add(unit.id)
  const units = unitsOfTask(board, taskId)
  for (const dep of unit.dependsOn) {
    const du = units.find(u => u.id === dep)
    if (!du || visiting.has(dep) || unitStateIn(board, du, taskId, visiting) !== 'done') {
      visiting.delete(unit.id)
      return 'blocked'
    }
  }
  visiting.delete(unit.id)
  return 'ready'
}

/** Seconds a running worker has gone without any event; null when it is not running or never timed. */
export function quietFor(box: AgentBox, now: number): number | null {
  if (box.id === MAIN_ID || box.status !== 'running') return null
  const since = box.lastEventAt ?? box.startedAt
  if (since === null) return null
  return Math.max(0, Math.floor((now - since) / 1000))
}

export function isQuiet(box: AgentBox, now: number): boolean {
  const s = quietFor(box, now)
  return s !== null && s >= QUIET_SECONDS
}

export function anythingRunning(board: Board): boolean {
  return Object.values(board.agents).some(b => b.status === 'starting' || b.status === 'running')
}

export type Totals = Tokens & { unknown: number; partial: number }

/** Sums of the known counts, with how many boxes have none (`unknown`) or only part (`partial`). */
export function totals(board: Board): Totals {
  const t: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, unknown: 0, partial: 0 }
  for (const b of Object.values(board.agents)) {
    if (b.tokensPartial) t.partial += 1
    if (b.tokens === null) {
      t.unknown += 1
      continue
    }
    t.input += b.tokens.input
    t.output += b.tokens.output
    t.cacheRead += b.tokens.cacheRead
    t.cacheWrite += b.tokens.cacheWrite
    t.requests += b.tokens.requests
  }
  return t
}

// ---- the row of live workers (0.3.0) ----

// How long an ended worker stays in the row after it ends.
export const LINGER_DONE_MS = 2000
export const LINGER_FAILED_MS = 8000

/** How long a box lingers in the row once ended: longer for a failure; 0 while it has not ended. */
export function lingerFor(box: AgentBox): number {
  if (box.status === 'failed') return LINGER_FAILED_MS
  if (box.status === 'done' || box.status === 'stopped') return LINGER_DONE_MS
  return 0
}

/** An ended worker still inside its linger time at `now`. The orchestrator never lingers. */
export function isLingering(box: AgentBox, now: number): boolean {
  if (box.id === MAIN_ID || !ENDED.has(box.status) || box.endedAt === null) return false
  return now - box.endedAt < lingerFor(box)
}

/** Box ids in order of first appearance, then any box missing from `order`; each once. */
function orderedIds(board: Board): string[] {
  const ids = [...board.order, ...Object.keys(board.agents).filter(id => !board.order.includes(id))]
  return [...new Set(ids)]
}

function isLive(b: AgentBox): boolean {
  return b.status === 'starting' || b.status === 'running' || b.status === 'waiting'
}

/** A worker shown in a row at `now`: of the active task, live, lingering or held; of another task (or none), live only. */
function inRow(board: Board, b: AgentBox, now: number): boolean {
  if (isLive(b)) return true
  return inActiveTask(board, b) && (isLingering(b, now) || isHeld(board, b))
}

/**
 * The agents that belong in the workers row at `now`, in order of first
 * appearance, of row 'workers' only (Haiku workers have the leads row): the
 * active task's live, lingering and held ones, and live ones of other tasks.
 */
export function rowWorkers(board: Board, now: number): AgentBox[] {
  const out: AgentBox[] = []
  for (const id of orderedIds(board)) {
    const b = board.agents[id]
    if (!b || b.id === MAIN_ID || rowOf(board, b) !== 'workers') continue
    if (inRow(board, b, now)) out.push(b)
  }
  return out
}

/**
 * The agents that belong in the leads row at `now`, in order of first
 * appearance: the active task's live, lingering and held ones, and live ones of
 * other tasks.
 */
export function rowLeads(board: Board, now: number): AgentBox[] {
  const out: AgentBox[] = []
  for (const id of orderedIds(board)) {
    const b = board.agents[id]
    if (!b || b.id === MAIN_ID || rowOf(board, b) !== 'leads') continue
    if (inRow(board, b, now)) out.push(b)
  }
  return out
}

/**
 * The workers the legend and the tracked line cover, in order of first
 * appearance: every box of the active task, plus the live (starting, running or
 * waiting) boxes of any other task (or of none). Never the orchestrator.
 */
export function shownBoxes(board: Board): AgentBox[] {
  const out: AgentBox[] = []
  for (const id of orderedIds(board)) {
    const b = board.agents[id]
    if (!b || b.id === MAIN_ID) continue
    if (inActiveTask(board, b) || isLive(b)) out.push(b)
  }
  return out
}

/** How many boxes of other tasks have ended (done, failed or stopped): the tracked line's "other tasks: N ended". */
export function otherEnded(board: Board): number {
  let n = 0
  for (const b of Object.values(board.agents)) {
    if (b.id !== MAIN_ID && ENDED.has(b.status) && otherTaskOf(board, b) !== null) n += 1
  }
  return n
}

/** The parked tasks, and how many live (starting, running or waiting) boxes belong to them: the header's `+N (n running)`. */
export function otherOpen(board: Board): { tasks: number; running: number } {
  const ids = new Set(parkedOf(board).map(s => s.taskId))
  let running = 0
  for (const b of Object.values(board.agents)) {
    if (b.id !== MAIN_ID && isLive(b) && b.taskId !== null && ids.has(b.taskId)) running += 1
  }
  return { tasks: ids.size, running }
}

/** Every agent shown in a row at `now`: the leads row first, then the workers row. */
export function rowAgents(board: Board, now: number): AgentBox[] {
  return [...rowLeads(board, now), ...rowWorkers(board, now)]
}

export function anythingLingering(board: Board, now: number): boolean {
  return Object.values(board.agents).some(b => isLingering(b, now))
}

export type Tally = { done: number; failed: number; queued: number }

/**
 * Workers done, workers failed or stopped, and declared units not started by
 * any worker yet. A done worker whose linked unit has a tier and was rejected
 * by the orchestrator (policy §8) counts as failed, not done. Only boxes of
 * the active task are counted (`inActiveTask`), against the active task's units.
 */
export function tally(board: Board): Tally {
  const t: Tally = { done: 0, failed: 0, queued: 0 }
  const carried = new Set<string>()
  for (const b of Object.values(board.agents)) {
    if (b.id === MAIN_ID || !inActiveTask(board, b)) continue
    if (b.unitId !== null) carried.add(b.unitId)
    if (b.status === 'done') {
      const u = unitOf(board, b)
      if (u !== null && unitTier(u) !== null && u.verdict === 'rejected') t.failed += 1
      else t.done += 1
    }
    else if (b.status === 'failed' || b.status === 'stopped') t.failed += 1
  }
  for (const u of board.units) {
    if (carried.has(u.id)) continue
    const s = unitState(board, u)
    if (s === 'blocked' || s === 'ready') t.queued += 1
  }
  return t
}

// ---- routing (0.6.0): the Model Routing Policy on the board (pure) ----
// The policy's text lives in hooks/policy.ts; this section cites it by section.

/**
 * The tier of a model id or alias: lower-cased text containing `haiku`,
 * `sonnet` or `opus` (checked in that order); null for any other model or when unknown.
 */
export function modelTier(model: string | null | undefined): Tier | null {
  if (typeof model !== 'string') return null
  const m = model.toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('opus')) return 'opus'
  return null
}

/** A unit's declared tier (or a recorded routing's), compared against the literals: null when missing or anything else. */
function unitTier(unit: { tier?: Tier | null } | null | undefined): Tier | null {
  const t = unit?.tier
  return t === 'opus' || t === 'sonnet' || t === 'haiku' ? t : null
}

/**
 * The unit the box carries out, or null when it is linked to none (or to one no
 * longer declared). It is looked up in the box's own task (active, parked or
 * closed); a box with no task reads the active task's units.
 */
export function unitOf(board: Board, box: AgentBox): Unit | null {
  if (box.unitId === null) return null
  return unitsOfTask(board, boxTask(board, box)).find(u => u.id === box.unitId) ?? null
}

/**
 * The box's tier, measured from its model. With the model unknown, the tier
 * recorded at spawn (`routed`) stands in, then its linked unit's declared tier;
 * null when none gives one (a model outside the three tiers stays null). The
 * orchestrator is always null.
 */
export function tierOf(board: Board, box: AgentBox): Tier | null {
  if (box.id === MAIN_ID) return null
  if (box.model !== null && box.model !== undefined && box.model !== '') return modelTier(box.model)
  return box.routed?.tier ?? unitTier(unitOf(board, box))
}

/** The row a box is drawn in: Haiku workers lead, everyone else works. */
export function rowOf(board: Board, box: AgentBox): Row {
  return tierOf(board, box) === 'haiku' ? 'leads' : 'workers'
}

export type AuditIssue = 'none' | 'no-audit' | 'tier-mismatch'

/**
 * What is wrong with a box's routing (policy §9): 'no-audit' when it carries
 * out no unit with a tier and an audit line; 'tier-mismatch' when its model is
 * known and runs on another tier than its unit declares; otherwise (and for the
 * orchestrator) 'none'. The routing recorded at spawn (`routed`) is read first;
 * the unit only when `routed` is null (a box seen before the board knew its
 * unit). So a box does not turn 'no-audit' when its unit leaves the list or its
 * task is switched away from or closed.
 */
export function auditIssue(board: Board, box: AgentBox): AuditIssue {
  if (box.id === MAIN_ID) return 'none'
  const routed = box.routed ?? null
  let tier: Tier | null
  if (routed !== null) {
    tier = unitTier(routed)
    if (tier === null || !given(routed.audit)) return 'no-audit'
  } else {
    const u = unitOf(board, box)
    tier = unitTier(u)
    if (u === null || tier === null || u.audit === null || u.audit === undefined) return 'no-audit'
  }
  if (box.model !== null && box.model !== undefined && box.model !== '' && modelTier(box.model) !== tier) {
    return 'tier-mismatch'
  }
  return 'none'
}

/** The units that depend on `unitId`, in list order. */
export function fedUnits(board: Board, unitId: string): Unit[] {
  return board.units.filter(u => u.dependsOn.includes(unitId))
}

/** The units with a tier that `unit` depends on and that are declared, in the board's list order. */
export function feederUnits(board: Board, unit: Unit): Unit[] {
  return board.units.filter(u => unitTier(u) !== null && unit.dependsOn.includes(u.id))
}

/**
 * A finished card kept in its row until it is checked (B3.3). True when all
 * hold: not the orchestrator; done; of the active task (`inActiveTask`); the
 * last box, in order of first appearance, carrying its unit in its task (an
 * earlier box of the same unit is never held); its unit exists (`unitOf`); the
 * phase is not done; and EITHER (a) the unit's tier is haiku or sonnet and it
 * has no verdict yet, OR (b) the 0.6 rule: the unit's tier is haiku, its verdict
 * is not rejected, and a unit it feeds is neither done nor failed.
 */
export function isHeld(board: Board, box: AgentBox): boolean {
  if (box.id === MAIN_ID || box.status !== 'done' || !inActiveTask(board, box) || board.phase === 'done') return false
  const u = unitOf(board, box)
  if (!u) return false
  const task = boxTask(board, box)
  const carriers = orderedIds(board).filter(id => {
    const b = board.agents[id]
    return b !== undefined && carries(board, b, task, u.id)
  })
  if (carriers[carriers.length - 1] !== box.id) return false
  const tier = unitTier(u)
  const verdict = u.verdict ?? null
  if ((tier === 'haiku' || tier === 'sonnet') && verdict === null) return true
  if (tier !== 'haiku' || verdict === 'rejected') return false
  return fedUnits(board, u.id).some(f => {
    const s = unitState(board, f)
    return s !== 'done' && s !== 'failed'
  })
}

// Rejected units of one task type at one tier that bar the type at that tier
// for the session (policy §8). Enforced for haiku and sonnet; opus rejections
// are only recorded.
export const BAR_AFTER = 2
export const BARRED_TIERS: readonly Tier[] = ['haiku', 'sonnet']

export type Barred = { tier: Tier; kind: TaskKind; n: number }

/**
 * The (tier, kind) pairs with at least BAR_AFTER rejects, for the tiers in
 * BARRED_TIERS: haiku before sonnet, then in order of first rejection.
 */
export function barred(board: Board): Barred[] {
  const groups: Barred[] = []
  for (const r of board.rejects ?? []) {
    if (!r || !BARRED_TIERS.includes(r.tier) || r.kind === null || r.kind === undefined) continue
    const g = groups.find(x => x.tier === r.tier && x.kind === r.kind)
    if (g) g.n += 1
    else groups.push({ tier: r.tier, kind: r.kind, n: 1 })
  }
  return BARRED_TIERS.flatMap(t => groups.filter(g => g.tier === t && g.n >= BAR_AFTER))
}

export function isBarred(board: Board, tier: Tier, kind: TaskKind): boolean {
  return barred(board).some(x => x.tier === tier && x.kind === kind)
}

/**
 * The first newly declared unit in `units` (no verdict yet) at a tier in
 * BARRED_TIERS whose kind is barred at that tier, or null. A unit already on
 * the board with the same id and the same tier is not counted as new.
 */
export function barredUnit(board: Board, units: readonly Unit[]): Unit | null {
  for (const u of units) {
    const tier = unitTier(u)
    if (tier === null || !BARRED_TIERS.includes(tier)) continue
    if ((u.verdict !== null && u.verdict !== undefined) || u.kind === null || u.kind === undefined) continue
    if (!isBarred(board, tier, u.kind)) continue
    if (board.units.some(k => k.id === u.id && unitTier(k) === tier)) continue
    return u
  }
  return null
}

// ---- the spawn gate (policy §1, §8, §9): every delegation ----

export type SpawnRequest = {
  subagentType: string
  workerTier: Tier | null // the tier of an flowestra worker type; null for any other type
  model?: string | null // the Agent call's `model` parameter as given
  name?: string | null
  description?: string | null
  fork?: boolean; workflow?: boolean; resume?: boolean
  nested?: boolean // spawned from a subagent's loop, not the main loop
  specMissing?: boolean // the covering unit names a spec file that does not exist
  contextMissing?: string | null // the first of the covering unit's context items that did not resolve
}

// Replaced by the tier workers: refused, and hidden from the model's listing.
export const REFUSED_BUILTINS: readonly string[] = ['Explore', 'Plan', 'general-purpose', 'claude', 'web-fetch', 'claude-code-guide']
// A settings utility the person triggers: never gated.
export const EXEMPT_TYPES: readonly string[] = ['statusline-setup']

const AUDIT_FORM = '"<task> | <tier> | <§1 step and conditions that selected it> | <what catches an error>"'
const DECLARE_TAIL =
  `(tier, kind, audit ${AUDIT_FORM}) and give this Agent call that unit id as its name, or, where the Agent tool takes no name, that unit's label as its description.`

function given(text: string | null | undefined): text is string {
  return text !== undefined && text !== null && text !== ''
}

/**
 * The unit an Agent call carries out, in the active task only: with a name,
 * the unit whose id equals it (the description is not consulted); with no
 * name, the unit whose label matches the description.
 */
export function coveringUnit(board: Board, req: Pick<SpawnRequest, 'name' | 'description'>): Unit | null {
  if (given(req.name)) return board.units.find(u => u.id === req.name) ?? null
  return unitByLabel(board, req.description)
}

/** A built-in type the tier workers replace (policy §1). */
export function denyBuiltin(type: string): string {
  return `Spawn refused (policy §1): the built-in type "${type}" is not used under the Model Routing Policy. Route the task with §1, declare its unit with AgentBoard, and spawn flowestra:haiku-worker, flowestra:sonnet-worker or flowestra:opus-worker.`
}

/** A unit of a parked task, found by an Agent call's description. */
export type ParkedMatch = { unitId: string; taskId: string }

/**
 * The one unit, across the parked tasks, whose label matches `description`
 * (as `unitByLabel` matches); null when none or more than one does.
 */
export function parkedMatch(board: Board, description: string | null | undefined): ParkedMatch | null {
  const key = labelKey(description)
  if (key === '') return null
  const hits: ParkedMatch[] = []
  for (const s of parkedOf(board)) {
    for (const u of s.units) if (labelKey(u.label) === key) hits.push({ unitId: u.id, taskId: s.taskId })
  }
  return hits.length === 1 ? hits[0]! : null
}

/**
 * No unit with a tier, a kind and an audit line covers the call (policy §9);
 * `name` null when it has none. With no name, `parked` (a unit of a parked task
 * the description matches) appends a hint to switch to that task.
 */
export function denyUndeclared(name: string | null, parked: ParkedMatch | null = null): string {
  if (!given(name)) {
    const hint = parked ? ` (it matches unit "${parked.unitId}" of task "${parked.taskId}": switch to it first)` : ''
    return `Spawn refused (policy §9): this Agent call has no name and its description matches no unit's label, so no unit with a tier, a kind and an audit line covers it. Declare one with AgentBoard first ${DECLARE_TAIL}${hint}`
  }
  return `Spawn refused (policy §9): no unit "${name}" with a tier, a kind and an audit line is declared. Declare it with AgentBoard first ${DECLARE_TAIL}`
}

/** A tier worker of another tier than the unit's (policy §1). */
export function denyWrongWorker(id: string, unitTier: Tier, workerTier: Tier): string {
  return `Spawn refused (policy §1): unit "${id}" is routed to ${unitTier}, but this call uses the ${workerTier} worker. Spawn flowestra:${unitTier}-worker, or re-route the unit.`
}

/** A tier worker given a model of another tier (policy §1). */
export function denyModelOverride(workerTier: Tier, model: string): string {
  return `Spawn refused (policy §1): the ${workerTier} worker runs on ${workerTier}; do not pass model "${model}".`
}

/** Another agent type that does not name the unit's tier as its model (policy §1). */
export function denyNoModel(id: string, tier: Tier): string {
  return `Spawn refused (policy §1): unit "${id}" is routed to ${tier}; an agent type other than the tier workers must name model "${tier}" in the call.`
}

/** A unit the orchestrator rejected (policy §8). */
export function denyRejected(id: string): string {
  return `Spawn refused (policy §8): unit "${id}" was rejected. Re-route the task upward under a new unit.`
}

/** A task type barred at a tier (policy §8). */
export function denyBarred(tier: Tier, kind: TaskKind, n: number): string {
  return `Spawn refused (policy §8): ${kind} is barred at ${tier} for the rest of this session (${n} rejected). Route the unit one tier up.`
}

/** A unit that already ran twice at its tier (policy §8). */
export function denyRetry(id: string, tier: Tier): string {
  return `Spawn refused (policy §8): unit "${id}" has already run twice at ${tier}. Never retry the same tier more than once: re-route it upward under a new unit.`
}

/** A unit whose spec file is not on disk. */
export function denySpec(id: string, spec: string): string {
  return `Spawn refused: unit "${id}" builds from spec "${spec}", which does not exist. No implementation starts before its approved spec is on disk.`
}

/** A unit whose context item resolves to no journal entry or file. */
export function denyContext(id: string, item: string): string {
  return `Spawn refused: unit "${id}" names context "${item}", which is no journal entry or file. Name an existing entry or file.`
}

/** A fork from the main loop (policy §1, §9): it runs on the orchestrator's model with no tier and no audit line. */
export function denyFork(): string {
  return 'Spawn refused (policy §1, §9): a fork copies this whole conversation and runs on your own model, with no tier and no audit line. Route the task with §1, declare its unit with AgentBoard and spawn the tier\'s worker; for the context earlier work built, name the journal entries and the decisions.md entry it must read in the unit\'s context.'
}

/**
 * The reason an Agent call is refused under the Model Routing Policy, or null
 * when it may start. The rules in order, the first match wins: a fork from the
 * main loop is refused; forks, workflows, resumes and nested spawns pass;
 * exempt types pass; refused built-ins; no covering unit (in the active task)
 * with a tier, a kind and an audit line (with no name, the refusal names a
 * unit of a parked task the description matches); the call's tier (worker
 * type or model) against the unit's; a rejected unit; a barred (tier, kind); a
 * third run at one tier (runs of the same unit id in the active task only); a
 * missing spec file; a context item that did not resolve.
 */
export function spawnCheck(board: Board, req: SpawnRequest): string | null {
  if (req.fork && !req.nested) return denyFork()
  if (req.fork || req.workflow || req.resume || req.nested) return null
  if (EXEMPT_TYPES.includes(req.subagentType)) return null
  if (REFUSED_BUILTINS.includes(req.subagentType)) return denyBuiltin(req.subagentType)
  const u = coveringUnit(board, req)
  const tier = unitTier(u)
  if (u === null || tier === null || u.kind === null || u.kind === undefined || !u.audit) {
    if (given(req.name)) return denyUndeclared(req.name)
    return denyUndeclared(null, u === null ? parkedMatch(board, req.description) : null)
  }
  if (req.workerTier !== null && req.workerTier !== undefined) {
    if (req.workerTier !== tier) return denyWrongWorker(u.id, tier, req.workerTier)
    if (given(req.model) && modelTier(req.model) !== req.workerTier) return denyModelOverride(req.workerTier, req.model)
  } else if (modelTier(req.model) !== tier) {
    return denyNoModel(u.id, tier)
  }
  if (u.verdict === 'rejected') return denyRejected(u.id)
  const bar = barred(board).find(x => x.tier === tier && x.kind === u.kind)
  if (bar) return denyBarred(tier, bar.kind, bar.n)
  const runs = Object.values(board.agents).filter(
    b => b.id !== MAIN_ID && carries(board, b, board.taskId, u.id) && tierOf(board, b) === tier,
  )
  if (runs.length >= 2) return denyRetry(u.id, tier)
  if (req.specMissing) return denySpec(u.id, u.spec ?? '')
  if (given(req.contextMissing)) return denyContext(u.id, req.contextMissing)
  return null
}
