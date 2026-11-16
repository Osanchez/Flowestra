import { expect, test } from 'claude-code/testing'

import type { AgentBox, Board, Routed, TaskKind, TaskSlot, Tier, TierReject, Unit, WorkerModels } from '../types'
import {
  BARRED_TIERS,
  BOARD_SHAPE,
  BAR_AFTER,
  EXEMPT_TYPES,
  LINGER_DONE_MS,
  LINGER_FAILED_MS,
  MAIN_ID,
  QUIET_SECONDS,
  REFUSED_BUILTINS,
  anythingLingering,
  anythingRunning,
  applyBoardSent,
  applyBoardUpdate,
  applyComplete,
  applySpawn,
  applyStep,
  applyToolCall,
  applyTurnStart,
  auditIssue,
  barred,
  barredUnit,
  boardFreeCheck,
  boardAtom,
  coveringUnit,
  cutLabel,
  denyBarred,
  denyBuiltin,
  denyBuiltinNested,
  denyContext,
  denyFork,
  denyKind,
  denyModelOverride,
  denyNested,
  denyNoModel,
  denyOpusWriter,
  denyRejected,
  denyResumeRejected,
  denyResumeSwitched,
  denyResumeUnavailable,
  denyRetry,
  denySpec,
  denyUnavailable,
  denyUnavailableWorker,
  denyUndeclared,
  denyWrongWorker,
  emptyBoard,
  fedUnits,
  feederUnits,
  inActiveTask,
  formatDuration,
  isBarred,
  isHeld,
  isLingering,
  isPlaceholder,
  isQuiet,
  labelKey,
  lingerFor,
  modelTier,
  openTask,
  otherEnded,
  otherOpen,
  otherTaskOf,
  parkedMatch,
  prettyModel,
  reconcile,
  resumeCheck,
  emptyLive,
  liveAtom,
  resetBoard,
  rowAgents,
  rowLeads,
  rowOf,
  rowWorkers,
  runTier,
  shortModel,
  shownBoxes,
  slotOf,
  spawnCheck,
  tally,
  taskSlots,
  tierOf,
  totals,
  unitByLabel,
  unitOf,
  ungatedOf,
  unitState,
  withdrawn,
} from './state'
import type { BoardUpdate, SpawnRequest } from './state'
import { ALL_ON } from './models'
import { WRITE_KINDS } from './policy'

const T0 = 1_000_000
const box = (b: Board, id: string): AgentBox => {
  const found = b.agents[id]
  if (!found) throw new Error(`no box ${id}`)
  return found
}
const usage = (i: number, o: number, r: number, w: number) => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: r,
  cache_creation_input_tokens: w,
  model: 'claude-x',
})
const unit = (id: string, dependsOn: string[] = [], declared: Unit['declared'] = null): Unit => ({
  id,
  label: id,
  wave: 1,
  dependsOn,
  declared,
  tier: null,
  kind: null,
  audit: null,
  verdict: null,
  spec: null,
  context: [],
})
const spawned = (b: Board, agentId: string, name?: string) =>
  applySpawn(b, { agentId, description: 'Build the state module now please', subagentType: 'general-purpose', model: 'haiku', name, promptChars: 500 }, T0)

test('spawn makes a starting box with a 4-word label, unit link and an out arrow', () => {
  const b0 = applyBoardUpdate(emptyBoard(T0), { units: [unit('U1')] }, T0)
  const b = spawned(b0, 'a1', 'U1')
  const one = box(b, 'a1')
  expect(one.status).toBe('starting')
  expect(one.label).toBe('Build the state module')
  expect(one.type).toBe('general-purpose')
  expect(one.unitId).toBe('U1')
  expect(one.flow).toEqual({ dir: 'out', at: T0 })
  expect(one.briefChars).toBe(500)
  expect(one.tokens).toBeNull()
  expect(one.tokensPartial).toBe(false)
  expect(b.order).toEqual(['a1'])
  // pure: the input board is untouched
  expect(b0.agents).toEqual({})
  // a name that is not a unit id leaves the box unlinked
  expect(box(spawned(b0, 'a2', 'nope'), 'a2').unitId).toBeNull()
})

test('the label is cut to 4 words and falls back to the type', () => {
  expect(cutLabel('  one two   three four five six ', 'x')).toBe('one two three four')
  expect(cutLabel('two words', 'x')).toBe('two words')
  expect(cutLabel('', 'Explore')).toBe('Explore')
  expect(cutLabel(undefined, 'Explore')).toBe('Explore')
  const b = applySpawn(emptyBoard(T0), { agentId: 'a', subagentType: 'Explore' }, T0)
  expect(box(b, 'a').label).toBe('Explore')
})

test('turn.start sets running; the orchestrator box is made on first use', () => {
  let b = applyTurnStart(spawned(emptyBoard(T0), 'a1'), 'a1', T0 + 1)
  expect(box(b, 'a1').status).toBe('running')
  b = applyTurnStart(b, undefined, T0 + 2)
  expect(box(b, 'main').label).toBe('Orchestrator')
  expect(box(b, 'main').status).toBe('running')
  expect(b.order).toEqual(['a1', 'main'])
})

test('steps sum per agent over several requests', () => {
  let b = applyTurnStart(spawned(emptyBoard(T0), 'a1'), 'a1', T0)
  b = applyStep(b, 'a1', usage(4, 100, 30_000, 2_000), T0 + 1)
  b = applyStep(b, 'a1', usage(0, 131, 277, 927), T0 + 2)
  b = applyStep(b, undefined, usage(10, 20, 30, 40), T0 + 3)
  expect(box(b, 'a1').tokens).toEqual({ input: 4, output: 231, cacheRead: 30_277, cacheWrite: 2_927, requests: 2 })
  expect(box(b, 'a1').model).toBe('claude-x')
  expect(box(b, 'a1').lastEventAt).toBe(T0 + 2)
  expect(box(b, 'main').tokens).toEqual({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, requests: 1 })
  const t = totals(b)
  expect(t.input).toBe(14)
  expect(t.output).toBe(251)
  expect(t.requests).toBe(3)
  expect(t.unknown).toBe(0)
})

test('a null usage adds nothing: null stays null, counts stay as they were', () => {
  let b = applyTurnStart(spawned(emptyBoard(T0), 'a1'), 'a1', T0)
  b = applyStep(b, 'a1', null, T0 + 5)
  expect(box(b, 'a1').tokens).toBeNull()
  expect(box(b, 'a1').lastEventAt).toBe(T0 + 5)
  b = applyStep(b, 'a1', usage(1, 2, 3, 4), T0 + 6)
  b = applyStep(b, 'a1', null, T0 + 7)
  expect(box(b, 'a1').tokens).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, requests: 1 })
  expect(totals(applyStep(emptyBoard(T0), 'z', null, T0)).unknown).toBe(1)
})

test('a step from an unknown agent creates a partial running box, labelled by id', () => {
  const b = applyStep(emptyBoard(T0), 'old1', usage(1, 2, 3, 4), T0)
  const one = box(b, 'old1')
  expect(one.status).toBe('running')
  expect(one.tokensPartial).toBe(true)
  expect(one.label).toBe('old1')
  expect(one.tokens?.requests).toBe(1)
  expect(totals(b).partial).toBe(1)
})

test('tool calls set the last tool; a main-loop SendMessage points an arrow out', () => {
  let b = applyComplete(applyTurnStart(spawned(emptyBoard(T0), 'a1'), 'a1', T0), 'a1', { reason: 'answer', answerChars: 9 }, T0 + 1)
  b = applyToolCall(b, 'a1', 'Read', T0 + 2)
  expect(box(b, 'a1').lastTool).toBe('Read')
  b = applyToolCall(b, undefined, 'SendMessage', T0 + 3, 'a1')
  expect(box(b, 'main').lastTool).toBe('SendMessage')
  expect(box(b, 'a1').flow).toEqual({ dir: 'out', at: T0 + 3 })
  // a worker's own SendMessage does not
  b = applyToolCall(b, 'a1', 'SendMessage', T0 + 4, 'a1')
  expect(box(b, 'a1').flow.at).toBe(T0 + 3)
})

test('complete with each of the four reasons', () => {
  const run = applyTurnStart(spawned(emptyBoard(T0), 'a1'), 'a1', T0)
  const answer = box(applyComplete(run, 'a1', { reason: 'answer', answerChars: 1234 }, T0 + 9), 'a1')
  expect(answer.status).toBe('done')
  expect(answer.flow).toEqual({ dir: 'in', at: T0 + 9 })
  expect(answer.resultChars).toBe(1234)
  expect(answer.endedAt).toBe(T0 + 9)
  const error = box(applyComplete(run, 'a1', { reason: 'error' }, T0 + 9), 'a1')
  expect(error.status).toBe('failed')
  expect(error.reason).toBe('error')
  expect(error.endedAt).toBe(T0 + 9)
  const refusal = box(applyComplete(run, 'a1', { reason: 'refusal' }, T0 + 9), 'a1')
  expect(refusal.status).toBe('failed')
  expect(refusal.reason).toBe('refusal')
  const aborted = box(applyComplete(run, 'a1', { reason: 'aborted' }, T0 + 9), 'a1')
  expect(aborted.status).toBe('stopped')
  expect(aborted.endedAt).toBe(T0 + 9)
})

test('the orchestrator turn ending leaves it waiting, never done', () => {
  let b = applyTurnStart(emptyBoard(T0), undefined, T0)
  b = applyComplete(b, undefined, { reason: 'answer', answerChars: 50 }, T0 + 1)
  expect(box(b, 'main').status).toBe('waiting')
  b = applyComplete(applyTurnStart(b, undefined, T0 + 2), undefined, { reason: 'error' }, T0 + 3)
  expect(box(b, 'main').status).toBe('waiting')
})

test('activity means running: a step revives the orchestrator from waiting with no turn start', () => {
  const waiting = applyComplete(applyTurnStart(emptyBoard(T0), undefined, T0), undefined, { reason: 'answer' }, T0 + 1)
  expect(box(waiting, 'main').status).toBe('waiting')
  const b = applyStep(waiting, undefined, usage(1, 1, 1, 1), T0 + 2)
  expect(box(b, 'main').status).toBe('running')
  expect(box(applyStep(waiting, undefined, null, T0 + 2), 'main').status).toBe('running')
  // whatever it was: even a status the orchestrator never normally has
  for (const status of ['starting', 'done', 'failed', 'stopped'] as const) {
    const odd: Board = { ...waiting, agents: { main: { ...box(waiting, 'main'), status } } }
    expect(box(applyStep(odd, undefined, null, T0 + 3), 'main').status).toBe('running')
  }
  // made on first use by a step: running
  expect(box(applyStep(emptyBoard(T0), undefined, null, T0), 'main').status).toBe('running')
})

test('activity means running: a step moves a starting or waiting worker to running; an ended one is never revived', () => {
  const started = spawned(emptyBoard(T0), 'a1')
  expect(box(applyStep(started, 'a1', null, T0 + 1), 'a1').status).toBe('running')
  const waiting: Board = { ...started, agents: { a1: { ...box(started, 'a1'), status: 'waiting' } } }
  expect(box(applyStep(waiting, 'a1', null, T0 + 1), 'a1').status).toBe('running')
  const run = applyTurnStart(started, 'a1', T0)
  for (const reason of ['answer', 'error', 'aborted'] as const) {
    const ended = applyComplete(run, 'a1', { reason }, T0 + 1)
    const before = box(ended, 'a1').status
    expect(box(applyStep(ended, 'a1', usage(1, 1, 1, 1), T0 + 2), 'a1').status).toBe(before)
  }
})

test('activity means running: a tool call revives the orchestrator and clears its end', () => {
  const waiting = applyComplete(applyTurnStart(emptyBoard(T0), undefined, T0), undefined, { reason: 'answer' }, T0 + 1)
  expect(box(waiting, 'main').endedAt).toBe(T0 + 1)
  const b = applyToolCall(waiting, undefined, 'Bash', T0 + 2)
  expect(box(b, 'main').status).toBe('running')
  expect(box(b, 'main').endedAt).toBeNull()
  expect(box(b, 'main').lastTool).toBe('Bash')
  // already running: stays running, its start kept
  const running = applyTurnStart(emptyBoard(T0), undefined, T0)
  const again = applyToolCall(running, undefined, 'Read', T0 + 5)
  expect(box(again, 'main').status).toBe('running')
  expect(box(again, 'main').startedAt).toBe(T0)
  // made on first use by a tool call: running
  expect(box(applyToolCall(emptyBoard(T0), undefined, 'Read', T0), 'main').status).toBe('running')
})

test('activity means running: a tool call moves a starting or waiting worker to running; an ended one is never revived', () => {
  const started = spawned(emptyBoard(T0), 'a1')
  expect(box(applyToolCall(started, 'a1', 'Read', T0 + 1), 'a1').status).toBe('running')
  const waiting: Board = { ...started, agents: { a1: { ...box(started, 'a1'), status: 'waiting' } } }
  expect(box(applyToolCall(waiting, 'a1', 'Read', T0 + 1), 'a1').status).toBe('running')
  const run = applyTurnStart(started, 'a1', T0)
  for (const reason of ['answer', 'error', 'aborted'] as const) {
    const ended = applyComplete(run, 'a1', { reason }, T0 + 1)
    const after = box(applyToolCall(ended, 'a1', 'Read', T0 + 2), 'a1')
    expect(after.status).toBe(box(ended, 'a1').status)
    expect(after.endedAt).toBe(T0 + 1)
  }
})

test('reconcile adds unknown agents as partial and fills id-only boxes', () => {
  let b = applyStep(emptyBoard(T0), 'x1', usage(1, 1, 1, 1), T0)
  b = reconcile(
    b,
    [
      { id: 'x1', description: 'Probe the old worker thing', type: 'Explore', status: 'running' },
      { id: 'x2', description: 'Lingering one', type: 'general-purpose', status: 'waiting', name: null, parentId: null },
    ],
    T0 + 1,
  )
  expect(box(b, 'x1').label).toBe('Probe the old worker')
  expect(box(b, 'x1').type).toBe('Explore')
  expect(box(b, 'x1').tokens?.requests).toBe(1)
  expect(box(b, 'x2').tokensPartial).toBe(true)
  expect(box(b, 'x2').tokens).toBeNull()
  expect(box(b, 'x2').status).toBe('waiting')
  expect(b.order).toEqual(['x1', 'x2'])
})

test('reconcile: the list status wins when it disagrees', () => {
  const run = applyTurnStart(spawned(emptyBoard(T0), 'a'), 'a', T0)
  const st = (s: Parameters<typeof reconcile>[1][number]['status'], from = run) =>
    box(reconcile(from, [{ id: 'a', description: 'd', type: 't', status: s }], T0 + 1), 'a')
  expect(st('waiting').status).toBe('waiting')
  expect(st('idle').status).toBe('waiting')
  expect(st('killed').status).toBe('stopped')
  expect(st('failed').status).toBe('failed')
  expect(st('failed').reason).toBe('failed')
  expect(st('completed').status).toBe('done')
  expect(st('running', spawned(emptyBoard(T0), 'a')).status).toBe('running')
  expect(st('pending', run).status).toBe('starting')
  // the main box is never touched by the list
  const m = applyTurnStart(emptyBoard(T0), undefined, T0)
  expect(box(reconcile(m, [{ id: 'main', status: 'killed' }], T0), 'main').status).toBe('running')
})

test('reconcile: an ended box is not moved back to waiting by a lingering entry', () => {
  const run = applyTurnStart(spawned(emptyBoard(T0), 'a'), 'a', T0)
  for (const reason of ['answer', 'error', 'aborted'] as const) {
    const ended = applyComplete(run, 'a', { reason }, T0 + 1)
    const before = box(ended, 'a').status
    for (const status of ['waiting', 'idle'] as const) {
      const after = box(reconcile(ended, [{ id: 'a', description: 'd', type: 't', status }], T0 + 2), 'a')
      expect(after.status).toBe(before)
    }
  }
})

test('reconcile links a unit from the list name', () => {
  const b0 = applyBoardUpdate(spawned(emptyBoard(T0), 'a'), { units: [unit('U1')] }, T0)
  const b = reconcile(b0, [{ id: 'a', description: 'd', type: 't', status: 'running', name: 'U1' }], T0)
  expect(box(b, 'a').unitId).toBe('U1')
})

test('unit derivation: running, blocked, ready, done, failed', () => {
  const units = [unit('A'), unit('B', ['A']), unit('C'), unit('D', [], 'done'), unit('E', [], 'failed'), unit('F', ['D'])]
  let b = applyBoardUpdate(emptyBoard(T0), { units }, T0)
  b = spawned(b, 'a', 'A')
  const byId = (id: string) => b.units.find(u => u.id === id) as Unit
  expect(unitState(b, byId('A'))).toBe('running') // starting counts as running
  expect(unitState(b, byId('B'))).toBe('blocked')
  expect(unitState(b, byId('C'))).toBe('ready')
  expect(unitState(b, byId('D'))).toBe('done') // no agent: declared
  expect(unitState(b, byId('E'))).toBe('failed') // no agent: declared
  expect(unitState(b, byId('F'))).toBe('ready') // its dependency is declared done
  b = applyTurnStart(b, 'a', T0)
  expect(unitState(b, byId('A'))).toBe('running')
  const done = applyComplete(b, 'a', { reason: 'answer' }, T0 + 1)
  expect(unitState(done, byId('A'))).toBe('done')
  expect(unitState(done, byId('B'))).toBe('ready')
  const failed = applyComplete(b, 'a', { reason: 'error' }, T0 + 1)
  expect(unitState(failed, byId('A'))).toBe('failed')
  expect(unitState(failed, byId('B'))).toBe('blocked')
  // the agent's end wins over declared
  const decl = applyBoardUpdate(failed, { units: [unit('A', [], 'done')] }, T0)
  expect(unitState(decl, (decl.units[0] as Unit))).toBe('failed')
  // a dependency on an undeclared unit, and a cycle, stay blocked
  const odd = applyBoardUpdate(emptyBoard(T0), { units: [unit('X', ['nope']), unit('Y', ['Z']), unit('Z', ['Y'])] }, T0)
  expect(unitState(odd, (odd.units[0] as Unit))).toBe('blocked')
  expect(unitState(odd, (odd.units[1] as Unit))).toBe('blocked')
})

test('quiet at 121 s, not at 119 s', () => {
  expect(QUIET_SECONDS).toBe(120)
  const b = applyStep(applyTurnStart(spawned(emptyBoard(T0), 'a'), 'a', T0), 'a', null, T0)
  expect(isQuiet(box(b, 'a'), T0 + 119_000)).toBe(false)
  expect(isQuiet(box(b, 'a'), T0 + 121_000)).toBe(true)
  const done = applyComplete(b, 'a', { reason: 'answer' }, T0)
  expect(isQuiet(box(done, 'a'), T0 + 999_000)).toBe(false)
})

test('anythingRunning follows starting and running boxes', () => {
  expect(anythingRunning(emptyBoard(T0))).toBe(false)
  const b = spawned(emptyBoard(T0), 'a')
  expect(anythingRunning(b)).toBe(true)
  expect(anythingRunning(applyComplete(b, 'a', { reason: 'answer' }, T0))).toBe(false)
})

test('board update is partial: fields left out keep their value', () => {
  let b = applyBoardUpdate(emptyBoard(T0), { task: 'Build the board', phase: 'design', wave: 1, units: [unit('U1')] }, T0)
  b = applyBoardUpdate(b, { phase: 'executing' }, T0)
  expect(b.task).toBe('Build the board')
  expect(b.phase).toBe('executing')
  expect(b.wave).toBe(1)
  expect(b.units).toHaveLength(1)
  b = applyBoardUpdate(b, { wave: 2, units: [unit('U2'), unit('U3')] }, T0)
  expect(b.task).toBe('Build the board')
  expect(b.wave).toBe(2)
  expect(b.units.map(u => u.id)).toEqual(['U2', 'U3'])
})

test('resetBoard empties everything', () => {
  expect(emptyBoard(T0).rejects).toEqual([])
  const b = resetBoard(T0 + 5)
  expect(b).toEqual(emptyBoard(T0 + 5))
  expect(b.order).toEqual([])
  expect(b.loadedAt).toBe(T0 + 5)
})

test('a reload keeps the tallies: the board is plain data under a shape tag', () => {
  // $.state keeps the value whole across a hot reload; the atom's tag decides whether new code takes it.
  expect(boardAtom.shape).toBe('board-7')
  expect(boardAtom.initial).toEqual(emptyBoard(0))
  const before = applyStep(applyStep(spawned(emptyBoard(T0), 'a'), 'a', usage(1, 2, 3, 4), T0), undefined, usage(5, 6, 7, 8), T0)
  const reloaded = JSON.parse(JSON.stringify(before)) as Board
  expect(reloaded).toEqual(before)
  const after = applyStep(reloaded, 'a', usage(1, 1, 1, 1), T0 + 1)
  expect(box(after, 'a').tokens).toEqual({ input: 2, output: 3, cacheRead: 4, cacheWrite: 5, requests: 2 })
  expect(box(after, 'main').tokens?.requests).toBe(1)
})

test('spawn keeps the call name and the parent agent; reconcile fills them for list-only agents', () => {
  const b = applySpawn(emptyBoard(T0), { agentId: 'c1', description: 'Child', name: 'child', parentAgentId: 'p1' }, T0)
  expect(box(b, 'c1').name).toBe('child')
  expect(box(b, 'c1').parentId).toBe('p1')
  expect(box(spawned(emptyBoard(T0), 'a1'), 'a1').name).toBeNull()
  expect(box(spawned(emptyBoard(T0), 'a1'), 'a1').parentId).toBeNull()
  const r = reconcile(emptyBoard(T0), [{ id: 'x', description: 'd', type: 't', status: 'running', name: 'U9', parentId: 'p2' }], T0)
  expect(box(r, 'x').name).toBe('U9')
  expect(box(r, 'x').parentId).toBe('p2')
  // an id-only box gets them from the list too
  const known = reconcile(applyStep(emptyBoard(T0), 'y', null, T0), [{ id: 'y', description: 'd', type: 't', status: 'running', name: 'n', parentId: 'p' }], T0)
  expect(box(known, 'y').name).toBe('n')
  expect(box(known, 'y').parentId).toBe('p')
})

test('a units update re-links boxes by name and clears links to units that are gone', () => {
  // spawned before the unit was declared: unlinked, name kept
  let b = spawned(emptyBoard(T0), 'a', 'U1')
  b = spawned(b, 'z', 'other')
  expect(box(b, 'a').unitId).toBeNull()
  b = applyBoardUpdate(b, { units: [unit('U1')] }, T0)
  expect(box(b, 'a').unitId).toBe('U1')
  expect(box(b, 'z').unitId).toBeNull()
  // a task-only update changes no link and keeps the same agents object
  const same = applyBoardUpdate(b, { task: 't' }, T0)
  expect(same.agents).toBe(b.agents)
  // the unit removed: the link is cleared
  b = applyBoardUpdate(b, { units: [unit('U2')] }, T0)
  expect(box(b, 'a').unitId).toBeNull()
  // declared again: linked again
  b = applyBoardUpdate(b, { units: [unit('U1'), unit('U2')] }, T0)
  expect(box(b, 'a').unitId).toBe('U1')
  // a link made from the list name (no call name) stays while its unit exists
  const viaList = reconcile(applyBoardUpdate(spawned(emptyBoard(T0), 'q'), { units: [unit('U3')] }, T0), [{ id: 'q', description: 'd', type: 't', status: 'running', name: 'U3' }], T0)
  expect(box(viaList, 'q').unitId).toBe('U3')
  expect(box(applyBoardUpdate(viaList, { units: [unit('U3'), unit('U4')] }, T0), 'q').unitId).toBe('U3')
})

test('the live value starts empty under its own shape tag', () => {
  expect(liveAtom.shape).toBe('live-2')
  expect(liveAtom.initial).toEqual({ now: 0, paneOpen: false })
  expect(emptyLive()).toEqual({ now: 0, paneOpen: false })
})

// ---- the row of live workers ----

const mk = (id: string, status: AgentBox['status'], endedAt: number | null = null, unitId: string | null = null): AgentBox => ({
  id,
  label: id,
  type: 'general-purpose',
  model: null,
  unitId,
  name: null,
  parentId: null,
  status,
  reason: null,
  tokens: null,
  tokensPartial: false,
  startedAt: T0,
  endedAt,
  lastEventAt: null,
  lastTool: null,
  briefChars: null,
  resultChars: null,
  peakIn: null,
  flow: { dir: null, at: null },
  taskId: null,
  routed: null,
})
const withBoxes = (...boxes: AgentBox[]): Board => {
  const b = emptyBoard(T0)
  for (const x of boxes) {
    b.agents[x.id] = x
    b.order.push(x.id)
  }
  return b
}

test('linger times by status', () => {
  expect(LINGER_DONE_MS).toBe(2000)
  expect(LINGER_FAILED_MS).toBe(8000)
  expect(lingerFor(mk('a', 'failed'))).toBe(8000)
  expect(lingerFor(mk('a', 'done'))).toBe(2000)
  expect(lingerFor(mk('a', 'stopped'))).toBe(2000)
  for (const s of ['starting', 'running', 'waiting'] as const) expect(lingerFor(mk('a', s))).toBe(0)
})

test('isLingering: inside the limit, not at it, never for main, live boxes or an unknown end', () => {
  const done = mk('a', 'done', T0)
  expect(isLingering(done, T0)).toBe(true)
  expect(isLingering(done, T0 + LINGER_DONE_MS - 1)).toBe(true)
  expect(isLingering(done, T0 + LINGER_DONE_MS)).toBe(false)
  const failed = mk('a', 'failed', T0)
  expect(isLingering(failed, T0 + LINGER_FAILED_MS - 1)).toBe(true)
  expect(isLingering(failed, T0 + LINGER_FAILED_MS)).toBe(false)
  expect(isLingering(mk('a', 'stopped', T0), T0 + 1999)).toBe(true)
  expect(isLingering(mk('a', 'stopped', T0), T0 + 2000)).toBe(false)
  expect(isLingering(mk('a', 'done', null), T0)).toBe(false)
  expect(isLingering(mk(MAIN_ID, 'done', T0), T0 + 1)).toBe(false)
  expect(isLingering(mk('a', 'running', T0), T0 + 1)).toBe(false)
  expect(isLingering(mk('a', 'waiting', T0), T0 + 1)).toBe(false)
})

test('rowWorkers: live and lingering workers in order of first appearance; main and expired left out', () => {
  const now = T0 + 5000
  const b = withBoxes(
    mk(MAIN_ID, 'running'),
    mk('late-fail', 'failed', T0), // 5 s after a failure: past 2 s, under 8 s
    mk('run', 'running'),
    mk('old-done', 'done', T0), // 5 s after done: expired
    mk('wait', 'waiting'),
    mk('fresh-done', 'done', now - 1000),
    mk('start', 'starting'),
    mk('old-stop', 'stopped', T0),
    mk('gone-fail', 'failed', now - LINGER_FAILED_MS),
    mk('no-end', 'done', null),
  )
  expect(rowWorkers(b, now).map(x => x.id)).toEqual(['late-fail', 'run', 'wait', 'fresh-done', 'start'])
})

test('rowWorkers: an agent missing from order comes after the ordered ones', () => {
  const b = withBoxes(mk('b', 'running'), mk('a', 'running'))
  b.agents['stray'] = mk('stray', 'running')
  expect(rowWorkers(b, T0).map(x => x.id)).toEqual(['b', 'a', 'stray'])
  expect(rowWorkers(emptyBoard(T0), T0)).toEqual([])
})

test('anythingLingering', () => {
  expect(anythingLingering(emptyBoard(T0), T0)).toBe(false)
  const b = withBoxes(mk('r', 'running'), mk('d', 'done', T0), mk(MAIN_ID, 'done', T0))
  expect(anythingLingering(b, T0 + 100)).toBe(true)
  expect(anythingLingering(b, T0 + LINGER_DONE_MS)).toBe(false)
})

test('tally: done, failed with stopped, queued units not carried by a worker; main never counted', () => {
  const b0 = withBoxes(
    mk(MAIN_ID, 'done', T0),
    mk('d1', 'done', T0, 'A'),
    mk('d2', 'done', T0),
    mk('f1', 'failed', T0),
    mk('s1', 'stopped', T0),
    mk('r1', 'running', null, 'R'),
    mk('w1', 'waiting', null, 'W'),
  )
  const b = { ...b0, units: [unit('A'), unit('R'), unit('W'), unit('B', ['A']), unit('C', ['X']), unit('D', [], 'done'), unit('Q')] }
  // A done (by d1); R running; W ready by derivation but carried by w1; B ready; C blocked; D declared done; Q ready
  expect(tally(b)).toEqual({ done: 2, failed: 2, queued: 3 })
  expect(tally(emptyBoard(T0))).toEqual({ done: 0, failed: 0, queued: 0 })
})

// ---- text helpers ----

test('formatDuration: seconds, minutes and seconds, hours and minutes', () => {
  expect(formatDuration(45_000)).toBe('45s')
  expect(formatDuration(192_000)).toBe('3m 12s')
  expect(formatDuration(3_725_000)).toBe('1h 02m')
  expect(formatDuration(-5)).toBe('0s')
})

test('shortModel: drops a leading claude- and a trailing date stamp; model n/a when unknown', () => {
  expect(shortModel('claude-opus-5-5')).toBe('opus-5-5')
  expect(shortModel('claude-haiku-5-5-20261001')).toBe('haiku-5-5')
  expect(shortModel('opus')).toBe('opus')
  expect(shortModel(null)).toBe('model n/a')
  expect(shortModel('')).toBe('model n/a')
  expect(shortModel('claude-x-1234567')).toBe('x-1234567')
})

test('prettyModel: capitalised name and dotted version; other shapes as shortModel gives them', () => {
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('claude-fable-5-2')).toBe('Fable 5.2')
  expect(prettyModel('claude-haiku-5-5-20261001')).toBe('Haiku 5.5')
  expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(prettyModel('claude-sonnet-4')).toBe('Sonnet 4')
  expect(prettyModel('opus')).toBe('Opus')
  expect(prettyModel(null)).toBe('model n/a')
  expect(prettyModel('')).toBe('model n/a')
  // a number before the name, a word after a number, an empty part: as shortModel
  expect(prettyModel('claude-3-5-sonnet-20241022')).toBe('3-5-sonnet')
  expect(prettyModel('claude-opus-5-5-preview')).toBe('opus-5-5-preview')
  expect(prettyModel('claude-opus--5')).toBe('opus--5')
})

const labelled = (u: Unit, label: string): Unit => ({ ...u, label })

test('labelKey: first 4 words, lower-cased, single spaces', () => {
  expect(labelKey('  Find  Call sites now please ')).toBe('find call sites now')
  expect(labelKey('Locate')).toBe('locate')
  expect(labelKey('')).toBe('')
  expect(labelKey('   ')).toBe('')
  expect(labelKey(null)).toBe('')
  expect(labelKey(undefined)).toBe('')
})

test('unitByLabel: exactly one unit whose label matches the description', () => {
  const b: Board = {
    ...emptyBoard(T0),
    units: [labelled(unit('A'), 'Find call sites'), labelled(unit('B'), 'Write the state reducers'), labelled(unit('C'), 'Dup label'), labelled(unit('D'), 'dup  LABEL')],
  }
  expect(unitByLabel(b, 'Find call sites')?.id).toBe('A')
  // case and spacing
  expect(unitByLabel(b, '  find   CALL sites ')?.id).toBe('A')
  // a description longer than 4 words is cut first
  expect(unitByLabel(b, 'Write the state reducers now please')?.id).toBe('B')
  // no match
  expect(unitByLabel(b, 'Find call')).toBeNull()
  expect(unitByLabel(b, 'Something else')).toBeNull()
  // two units with the same label
  expect(unitByLabel(b, 'Dup label')).toBeNull()
  // empty
  expect(unitByLabel(b, '')).toBeNull()
  expect(unitByLabel(b, null)).toBeNull()
  expect(unitByLabel(b, undefined)).toBeNull()
  // a unit with an empty label never matches an empty description
  expect(unitByLabel({ ...emptyBoard(T0), units: [labelled(unit('E'), '')] }, '')).toBeNull()
})

test('applySpawn: with no name, the description links the box to the unit with that label', () => {
  const b0 = applyBoardUpdate(emptyBoard(T0), { units: [labelled(unit('U1'), 'Build the state module'), labelled(unit('U2'), 'Write the tests')] }, T0)
  // no name: the description (cut to 4 words) matches U1
  expect(box(spawned(b0, 'a1'), 'a1').unitId).toBe('U1')
  expect(box(spawned(b0, 'a1', ''), 'a1').unitId).toBe('U1')
  // a name equal to a unit id takes priority
  expect(box(spawned(b0, 'a2', 'U2'), 'a2').unitId).toBe('U2')
  // a name that matches no unit does not fall back to the description
  expect(box(spawned(b0, 'a3', 'nope'), 'a3').unitId).toBeNull()
  // no name and no matching label: unlinked
  const b1 = applyBoardUpdate(emptyBoard(T0), { units: [unit('U1')] }, T0)
  expect(box(spawned(b1, 'a4'), 'a4').unitId).toBeNull()
})

test('applyBoardUpdate: an unnamed, unlinked box is linked by its label; named boxes are left alone', () => {
  let b = spawned(emptyBoard(T0), 'a1') // label "Build the state module", no name
  b = spawned(b, 'a2', 'other') // same label, named
  b = applyTurnStart(b, undefined, T0)
  expect(box(b, 'a1').unitId).toBeNull()
  const units = [labelled(unit('U1'), 'build the  state module')]
  b = applyBoardUpdate(b, { units }, T0)
  expect(box(b, 'a1').unitId).toBe('U1')
  expect(box(b, 'a2').unitId).toBeNull()
  expect(box(b, MAIN_ID).unitId).toBeNull()
  // the unit dropped: the link is cleared; two units with that label: no link
  b = applyBoardUpdate(b, { units: [labelled(unit('X'), 'Build the state module'), labelled(unit('Y'), 'Build the state module')] }, T0)
  expect(box(b, 'a1').unitId).toBeNull()
  // a box linked by name keeps that link even when its label matches another unit
  let c = applyBoardUpdate(emptyBoard(T0), { units: [unit('U1')] }, T0)
  c = spawned(c, 'n1', 'U1')
  c = applyBoardUpdate(c, { units: [unit('U1'), labelled(unit('U2'), 'Build the state module')] }, T0)
  expect(box(c, 'n1').unitId).toBe('U1')
  // the orchestrator is never linked, even when a unit is labelled like it
  const o = applyBoardUpdate(applyTurnStart(emptyBoard(T0), undefined, T0), { units: [labelled(unit('O'), 'Orchestrator')] }, T0)
  expect(box(o, MAIN_ID).unitId).toBeNull()
})

// ---- routing (0.6.0): the Model Routing Policy on the board ----

const auditFor = (tier: Tier) => `find the callers | ${tier} | §1 step 2: read-only lookup | orchestrator re-reads each hit`
const tiered = (id: string, tier: Tier = 'haiku', over: Partial<Unit> = {}): Unit => ({
  ...unit(id),
  tier,
  kind: 'locate',
  audit: auditFor(tier),
  ...over,
})
const withModel = (b: AgentBox, model: string | null): AgentBox => ({ ...b, model })
const onBoard = (units: Unit[], ...boxes: AgentBox[]): Board => ({ ...withBoxes(...boxes), units })
const HAIKU = 'claude-haiku-5-5-20261001'
const SONNET = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-5-5'
// a unit as an older build stored it: none of the routing fields
const oldUnit = (id: string): Unit => ({ id, label: id, wave: 1, dependsOn: [], declared: null }) as unknown as Unit

test('modelTier: haiku, sonnet or opus in the text, any case; null otherwise', () => {
  expect(modelTier('haiku')).toBe('haiku')
  expect(modelTier(HAIKU)).toBe('haiku')
  expect(modelTier('Claude-HAIKU-4')).toBe('haiku')
  expect(modelTier('sonnet')).toBe('sonnet')
  expect(modelTier(SONNET)).toBe('sonnet')
  expect(modelTier('opus')).toBe('opus')
  expect(modelTier(OPUS)).toBe('opus')
  expect(modelTier('claude-fable-5-2')).toBeNull()
  expect(modelTier('claude-x')).toBeNull()
  expect(modelTier(null)).toBeNull()
  expect(modelTier(undefined)).toBeNull()
  expect(modelTier('')).toBeNull()
})

test('unitOf and tierOf: by model, by unit when the model is unknown; a model outside the tiers and the orchestrator are null', () => {
  const b = onBoard(
    [tiered('H'), tiered('S', 'sonnet'), tiered('O', 'opus'), unit('N', [], 'pending'), oldUnit('L')],
    withModel(mk('h', 'running'), HAIKU),
    withModel(mk('s', 'running'), SONNET),
    withModel(mk('o', 'running', null, 'H'), OPUS),
    withModel(mk('x', 'running', null, 'S'), 'claude-fable-5-2'),
    mk('uh', 'running', null, 'H'),
    mk('us', 'running', null, 'S'),
    mk('uo', 'running', null, 'O'),
    mk('un', 'running', null, 'N'),
    mk('ul', 'running', null, 'L'),
    mk('none', 'running'),
    withModel(mk('blank', 'running', null, 'H'), ''),
    withModel(mk(MAIN_ID, 'running'), 'haiku'),
  )
  expect(unitOf(b, box(b, 'uh'))?.id).toBe('H')
  expect(unitOf(b, box(b, 'none'))).toBeNull()
  expect(unitOf(b, mk('gone', 'running', null, 'X'))).toBeNull()
  // by model
  expect(tierOf(b, box(b, 'h'))).toBe('haiku')
  expect(tierOf(b, box(b, 's'))).toBe('sonnet')
  expect(tierOf(b, box(b, 'o'))).toBe('opus') // the model wins over the unit
  // a model outside the tiers: null, whatever the unit says
  expect(tierOf(b, box(b, 'x'))).toBeNull()
  // model unknown: the unit's tier
  expect(tierOf(b, box(b, 'uh'))).toBe('haiku')
  expect(tierOf(b, box(b, 'us'))).toBe('sonnet')
  expect(tierOf(b, box(b, 'uo'))).toBe('opus')
  expect(tierOf(b, box(b, 'blank'))).toBe('haiku')
  // no tier on the unit, a unit missing the fields, no unit: null
  expect(tierOf(b, box(b, 'un'))).toBeNull()
  expect(tierOf(b, box(b, 'ul'))).toBeNull()
  expect(tierOf(b, box(b, 'none'))).toBeNull()
  // the orchestrator, even on a Haiku model
  expect(tierOf(b, box(b, MAIN_ID))).toBeNull()
})

test('rowOf: Haiku in the leads row, everyone else in the workers row', () => {
  const b = onBoard([tiered('H'), tiered('S', 'sonnet')])
  expect(rowOf(b, withModel(mk('h', 'running'), HAIKU))).toBe('leads')
  expect(rowOf(b, mk('uh', 'running', null, 'H'))).toBe('leads')
  expect(rowOf(b, withModel(mk('s', 'running'), SONNET))).toBe('workers')
  expect(rowOf(b, withModel(mk('o', 'running', null, 'H'), OPUS))).toBe('workers')
  expect(rowOf(b, withModel(mk('x', 'running'), 'claude-x'))).toBe('workers')
  expect(rowOf(b, mk('none', 'running'))).toBe('workers')
  expect(rowOf(b, withModel(mk(MAIN_ID, 'running'), HAIKU))).toBe('workers')
})

test('auditIssue: none, no-audit, tier-mismatch', () => {
  const b = onBoard([
    tiered('H'),
    tiered('S', 'sonnet'),
    tiered('O', 'opus'),
    tiered('NA', 'haiku', { audit: null }),
    unit('N', [], 'pending'),
    oldUnit('L'),
  ])
  const on = (model: string | null, unitId: string | null) => withModel(mk('a', 'running', null, unitId), model)
  // the orchestrator
  expect(auditIssue(b, withModel(mk(MAIN_ID, 'running'), 'claude-fable-5-2'))).toBe('none')
  // no unit, a unit with no tier, missing the fields, or with no audit
  expect(auditIssue(b, on(HAIKU, null))).toBe('no-audit')
  expect(auditIssue(b, on(OPUS, 'N'))).toBe('no-audit')
  expect(auditIssue(b, on(OPUS, 'L'))).toBe('no-audit')
  expect(auditIssue(b, on(HAIKU, 'NA'))).toBe('no-audit')
  expect(auditIssue(b, on(HAIKU, 'gone'))).toBe('no-audit')
  // the model's tier is the unit's
  expect(auditIssue(b, on(HAIKU, 'H'))).toBe('none')
  expect(auditIssue(b, on(SONNET, 'S'))).toBe('none')
  expect(auditIssue(b, on(OPUS, 'O'))).toBe('none')
  // model unknown: nothing to compare
  expect(auditIssue(b, on(null, 'S'))).toBe('none')
  expect(auditIssue(b, on('', 'S'))).toBe('none')
  // another tier, or a model outside the tiers
  expect(auditIssue(b, on(OPUS, 'S'))).toBe('tier-mismatch')
  expect(auditIssue(b, on(SONNET, 'H'))).toBe('tier-mismatch')
  expect(auditIssue(b, on('claude-x', 'O'))).toBe('tier-mismatch')
})

test('fedUnits and feederUnits: feeders are the declared dependencies with a tier', () => {
  const b = onBoard([
    tiered('H1'),
    tiered('S1', 'sonnet', { dependsOn: ['H1'] }),
    tiered('O1', 'opus'),
    unit('N0', [], 'done'),
    oldUnit('L0'),
    unit('W2', ['O1', 'N0', 'L0', 'H1', 'S1', 'nope']),
  ])
  expect(fedUnits(b, 'H1').map(u => u.id)).toEqual(['S1', 'W2'])
  expect(fedUnits(b, 'W2')).toEqual([])
  expect(feederUnits(b, b.units[5] as Unit).map(u => u.id)).toEqual(['H1', 'S1', 'O1'])
  expect(feederUnits(b, b.units[1] as Unit).map(u => u.id)).toEqual(['H1'])
  expect(feederUnits(b, b.units[0] as Unit)).toEqual([])
})

test('a rejected unit of each tier is failed before any agent status; its dependent is blocked', () => {
  const models: Record<Tier, string> = { haiku: HAIKU, sonnet: SONNET, opus: OPUS }
  for (const tier of ['haiku', 'sonnet', 'opus'] as const) {
    const b = onBoard(
      [tiered('U', tier, { verdict: 'rejected' }), unit('W', ['U'])],
      withModel(mk('a', 'done', T0, 'U'), models[tier]),
    )
    expect(unitState(b, b.units[0] as Unit)).toBe('failed')
    expect(unitState(b, b.units[1] as Unit)).toBe('blocked')
    const running = onBoard([tiered('U', tier, { verdict: 'rejected' })], withModel(mk('a', 'running', null, 'U'), models[tier]))
    expect(unitState(running, running.units[0] as Unit)).toBe('failed')
    // accepted: from its agent as before
    const ok = onBoard([tiered('U', tier, { verdict: 'accepted' }), unit('W', ['U'])], withModel(mk('a', 'done', T0, 'U'), models[tier]))
    expect(unitState(ok, ok.units[0] as Unit)).toBe('done')
    expect(unitState(ok, ok.units[1] as Unit)).toBe('ready')
  }
  // a unit with no tier and a rejected verdict field is not failed by it
  const w = onBoard([{ ...unit('X'), verdict: 'rejected' }])
  expect(unitState(w, w.units[0] as Unit)).toBe('ready')
})

test('isHeld (B3.3): a finished card of the active task stays until it is checked; each condition flips it', () => {
  const lead = withModel(mk('h', 'done', T0, 'H'), HAIKU)
  const base = (over: Partial<Board> = {}, units = [tiered('H'), unit('W', ['H'])]): Board => ({
    ...onBoard(units, lead),
    phase: 'executing',
    ...over,
  })
  const b = base()
  // (a) a haiku unit with no verdict
  expect(isHeld(b, lead)).toBe(true)
  // the orchestrator
  expect(isHeld(b, { ...lead, id: MAIN_ID })).toBe(false)
  // not done
  expect(isHeld(b, { ...lead, status: 'running' })).toBe(false)
  expect(isHeld(b, { ...lead, status: 'failed' })).toBe(false)
  expect(isHeld(b, { ...lead, status: 'stopped' })).toBe(false)
  // the measured model plays no part: the unit's tier decides
  expect(isHeld(b, withModel(lead, OPUS))).toBe(true)
  expect(isHeld(b, withModel(lead, null))).toBe(true)
  // no unit, or a unit no longer declared
  expect(isHeld(b, { ...lead, unitId: null })).toBe(false)
  expect(isHeld(b, { ...lead, unitId: 'gone' })).toBe(false)
  // phase done; phase null still holds
  expect(isHeld(base({ phase: 'done' }), lead)).toBe(false)
  expect(isHeld(base({ phase: null }), lead)).toBe(true)
  // (a) a sonnet unit with no verdict: held, nothing fed needed
  expect(isHeld(base({}, [tiered('H', 'sonnet')]), lead)).toBe(true)
  // a sonnet unit with a verdict: not held
  expect(isHeld(base({}, [tiered('H', 'sonnet', { verdict: 'accepted' }), unit('W', ['H'])]), lead)).toBe(false)
  expect(isHeld(base({}, [tiered('H', 'sonnet', { verdict: 'rejected' }), unit('W', ['H'])]), lead)).toBe(false)
  // an opus unit, or a unit with no tier (or missing the fields): never held
  expect(isHeld(base({}, [tiered('H', 'opus'), unit('W', ['H'])]), lead)).toBe(false)
  expect(isHeld(base({}, [unit('H'), unit('W', ['H'])]), lead)).toBe(false)
  expect(isHeld(base({}, [oldUnit('H'), unit('W', ['H'])]), lead)).toBe(false)
  // (a) haiku with no verdict and nothing fed: held
  expect(isHeld(base({}, [tiered('H')]), lead)).toBe(true)
  // (b) haiku accepted: held while a fed unit is unfinished
  const acc = tiered('H', 'haiku', { verdict: 'accepted' })
  expect(isHeld(base({}, [acc, unit('W', ['H'])]), lead)).toBe(true)
  expect(isHeld(base({}, [acc, unit('W')]), lead)).toBe(false)
  expect(isHeld(base({}, [acc, unit('W', ['H'], 'done')]), lead)).toBe(false)
  expect(isHeld(base({}, [acc, unit('W', ['H'], 'failed')]), lead)).toBe(false)
  expect(isHeld(base({}, [acc, unit('W', ['H'], 'done'), unit('V', ['H'])]), lead)).toBe(true)
  // (b) needs a verdict other than rejected
  expect(isHeld(base({}, [tiered('H', 'haiku', { verdict: 'rejected' }), unit('W', ['H'])]), lead)).toBe(false)
  // (b) is for haiku only: a sonnet unit accepted feeding an open unit is not held
  expect(isHeld(base({}, [tiered('H', 'sonnet', { verdict: 'accepted' }), unit('W', ['H'])]), lead)).toBe(false)
  // the active task only: a box of another task is not held; a box of the active one is
  const t1 = base({ taskId: 't1' })
  expect(isHeld(t1, { ...lead, taskId: 't1' })).toBe(true)
  expect(isHeld(t1, { ...lead, taskId: 't2' })).toBe(false)
  expect(isHeld(t1, { ...lead, taskId: null })).toBe(false)
})

test('isHeld: of two done Haiku workers linked to one unit, only the later one is held', () => {
  const now = T0 + 60_000
  const units = [tiered('H'), unit('W', ['H'])]
  const early = withModel(mk('h-early', 'done', T0, 'H'), HAIKU)
  const late = withModel(mk('h-late', 'done', T0 + 1000, 'H'), HAIKU)
  const b: Board = { ...onBoard(units, early, late), phase: 'executing' }
  expect(isHeld(b, early)).toBe(false)
  expect(isHeld(b, late)).toBe(true)
  // both past their linger time: the row shows the later one only
  expect(rowLeads(b, now).map(x => x.id)).toEqual(['h-late'])
  // a single box is held as before
  const one: Board = { ...onBoard(units, early), phase: 'executing' }
  expect(isHeld(one, early)).toBe(true)
  expect(rowLeads(one, now).map(x => x.id)).toEqual(['h-early'])
})

test('rowWorkers keeps every non-Haiku agent; rowLeads keeps live, lingering and held Haiku workers; rowAgents puts leads first', () => {
  const now = T0 + 60_000
  const units = [tiered('H'), unit('W', ['H'])]
  const b: Board = {
    ...onBoard(
      units,
      mk(MAIN_ID, 'running'),
      withModel(mk('o1', 'running'), OPUS),
      withModel(mk('h-run', 'running'), HAIKU),
      withModel(mk('s1', 'running'), SONNET),
      withModel(mk('h-held', 'done', T0, 'H'), HAIKU), // long past its linger time
      withModel(mk('h-old', 'done', T0), HAIKU), // expired, holds nothing
      withModel(mk('h-fresh', 'failed', now - 1000), HAIKU),
      withModel(mk('x1', 'running'), 'claude-x'),
      mk('w2', 'waiting'),
      withModel(mk('s-old', 'done', T0), SONNET), // expired
    ),
    phase: 'executing',
  }
  expect(rowWorkers(b, now).map(x => x.id)).toEqual(['o1', 's1', 'x1', 'w2'])
  expect(rowLeads(b, now).map(x => x.id)).toEqual(['h-run', 'h-held', 'h-fresh'])
  expect(rowAgents(b, now).map(x => x.id)).toEqual(['h-run', 'h-held', 'h-fresh', 'o1', 's1', 'x1', 'w2'])
  // accepted and the fed unit done: the held lead drops out
  const fedDone: Board = { ...b, units: [tiered('H', 'haiku', { verdict: 'accepted' }), unit('W', ['H'], 'done')] }
  expect(rowLeads(fedDone, now).map(x => x.id)).toEqual(['h-run', 'h-fresh'])
  // a held Sonnet card (B3.3) stays in the workers row until its verdict
  const sb: Board = { ...onBoard([tiered('S', 'sonnet')], withModel(mk('s-held', 'done', T0, 'S'), SONNET)), phase: 'executing' }
  expect(rowWorkers(sb, now).map(x => x.id)).toEqual(['s-held'])
  const checked: Board = { ...sb, units: [tiered('S', 'sonnet', { verdict: 'accepted' })] }
  expect(rowWorkers(checked, now)).toEqual([])
  expect(rowLeads(emptyBoard(T0), T0)).toEqual([])
  expect(rowAgents(emptyBoard(T0), T0)).toEqual([])
})

test('applyBoardUpdate: rejected units with a tier and a kind are added to rejects once and kept when dropped', () => {
  let b = applyBoardUpdate(emptyBoard(T0), { units: [tiered('H1'), unit('W')] }, T0)
  expect(b.rejects).toEqual([])
  b = applyBoardUpdate(b, {
    units: [
      tiered('H1', 'haiku', { verdict: 'rejected' }),
      tiered('S1', 'sonnet', { kind: 'tests', verdict: 'rejected' }),
      tiered('O1', 'opus', { kind: 'design', verdict: 'rejected' }),
      tiered('A1', 'sonnet', { verdict: 'accepted' }),
      { ...unit('X'), verdict: 'rejected' },
      { ...oldUnit('L'), verdict: 'rejected' } as Unit,
    ],
  }, T0)
  const three = [
    { unitId: 'H1', tier: 'haiku', kind: 'locate', taskId: 'task-1' },
    { unitId: 'S1', tier: 'sonnet', kind: 'tests', taskId: 'task-1' },
    { unitId: 'O1', tier: 'opus', kind: 'design', taskId: 'task-1' },
  ]
  expect(b.rejects).toEqual(three)
  // sent again: not added twice
  b = applyBoardUpdate(b, { units: [tiered('H1', 'haiku', { verdict: 'rejected' })] }, T0)
  expect(b.rejects).toEqual(three)
  // dropped from the list: kept
  b = applyBoardUpdate(b, { units: [unit('W')] }, T0)
  expect(b.rejects).toHaveLength(3)
  // a rejected unit with no kind adds nothing
  const nk = applyBoardUpdate(b, { units: [tiered('H3', 'haiku', { kind: null, verdict: 'rejected' })] }, T0)
  expect(nk.rejects).toHaveLength(3)
  // no units: the same array
  expect(applyBoardUpdate(b, { phase: 'testing' }, T0).rejects).toBe(b.rejects)
})

const rej = (unitId: string, tier: Tier, kind: TaskKind, taskId: string | null = null): TierReject => ({ unitId, tier, kind, taskId })

test('barred and isBarred: haiku and sonnet at BAR_AFTER rejects, opus never; haiku first, then by first rejection', () => {
  expect(BAR_AFTER).toBe(2)
  expect(BARRED_TIERS).toEqual(['haiku', 'sonnet'])
  const one: Board = { ...emptyBoard(T0), rejects: [rej('a', 'haiku', 'edit'), rej('b', 'sonnet', 'edit')] }
  expect(barred(one)).toEqual([])
  expect(isBarred(one, 'haiku', 'edit')).toBe(false)
  const b: Board = {
    ...emptyBoard(T0),
    rejects: [
      rej('a', 'sonnet', 'review'),
      rej('b', 'haiku', 'edit'),
      rej('c', 'opus', 'design'),
      rej('d', 'haiku', 'locate'),
      rej('e', 'sonnet', 'review'),
      rej('f', 'haiku', 'locate'),
      rej('g', 'opus', 'design'),
      rej('h', 'haiku', 'edit'),
      rej('i', 'opus', 'design'),
      rej('j', 'sonnet', 'locate'), // one sonnet locate: the haiku rejects of that kind do not count
      rej('k', 'haiku', 'locate'),
    ],
  }
  expect(barred(b)).toEqual([
    { tier: 'haiku', kind: 'edit', n: 2 },
    { tier: 'haiku', kind: 'locate', n: 3 },
    { tier: 'sonnet', kind: 'review', n: 2 },
  ])
  expect(isBarred(b, 'haiku', 'locate')).toBe(true)
  expect(isBarred(b, 'sonnet', 'review')).toBe(true)
  expect(isBarred(b, 'sonnet', 'locate')).toBe(false)
  expect(isBarred(b, 'haiku', 'review')).toBe(false)
  expect(isBarred(b, 'opus', 'design')).toBe(false)
  // a board missing rejects (an older stored value) does not throw
  const old = { ...emptyBoard(T0), rejects: undefined } as unknown as Board
  expect(barred(old)).toEqual([])
  expect(isBarred(old, 'haiku', 'locate')).toBe(false)
})

const barredBoard = (units: Unit[] = []): Board => ({
  ...emptyBoard(T0),
  units,
  rejects: [
    rej('r1', 'haiku', 'locate'),
    rej('r2', 'haiku', 'locate'),
    rej('r3', 'sonnet', 'review'),
    rej('r4', 'sonnet', 'review'),
    rej('r5', 'opus', 'design'),
    rej('r6', 'opus', 'design'),
  ],
})

test('0.17.0: writing kinds at sonnet are never barred, however many rejects', () => {
  for (const kind of WRITE_KINDS) {
    for (const n of [2, 3]) {
      const rejects = Array.from({ length: n }, (_, i) => rej(`w${i}`, 'sonnet', kind))
      const b: Board = { ...emptyBoard(T0), rejects }
      expect(barred(b)).toEqual([])
      expect(isBarred(b, 'sonnet', kind)).toBe(false)
      expect(barredUnit(b, [tiered('N', 'sonnet', { kind })])).toBeNull()
    }
  }
  const both: Board = { ...emptyBoard(T0), rejects: [rej('a', 'haiku', 'locate'), rej('b', 'haiku', 'locate'), rej('c', 'sonnet', 'review'), rej('d', 'sonnet', 'review'), rej('e', 'sonnet', 'implement'), rej('f', 'sonnet', 'implement')] }
  expect(barred(both)).toEqual([{ tier: 'haiku', kind: 'locate', n: 2 }, { tier: 'sonnet', kind: 'review', n: 2 }])
})

test('barredUnit: a new unit of a barred tier and kind; not one already declared at that tier, of another kind or tier, or with a verdict', () => {
  const b = barredBoard([tiered('OLD')])
  expect(barredUnit(b, [unit('W', [], 'pending'), tiered('NEW')])?.id).toBe('NEW')
  expect(barredUnit(b, [tiered('NS', 'sonnet', { kind: 'review' })])?.id).toBe('NS')
  // opus is never barred
  expect(barredUnit(b, [tiered('NO', 'opus', { kind: 'design' })])).toBeNull()
  // already declared at the same tier
  expect(barredUnit(b, [tiered('OLD')])).toBeNull()
  // another kind, or the kind barred only at another tier
  expect(barredUnit(b, [tiered('X', 'haiku', { kind: 'extract' })])).toBeNull()
  expect(barredUnit(b, [tiered('X', 'sonnet', { kind: 'locate' })])).toBeNull()
  expect(barredUnit(b, [tiered('X', 'haiku', { kind: 'edit' })])).toBeNull()
  // with a verdict
  expect(barredUnit(b, [tiered('V', 'haiku', { verdict: 'accepted' })])).toBeNull()
  expect(barredUnit(b, [tiered('V', 'haiku', { verdict: 'rejected' })])).toBeNull()
  // a declared unit of the same id at another tier is not "already declared"
  expect(barredUnit(barredBoard([unit('NEW', [], 'pending')]), [tiered('NEW')])?.id).toBe('NEW')
  expect(barredUnit(barredBoard([tiered('NEW', 'opus')]), [tiered('NEW')])?.id).toBe('NEW')
  // nothing barred
  expect(barredUnit(emptyBoard(T0), [tiered('NEW')])).toBeNull()
})

test('tally: a done worker whose unit has a tier and is rejected counts as failed; accepted as done; a unit with no tier unaffected', () => {
  const sonnetBox = withModel(mk('s', 'done', T0, 'S'), SONNET)
  const rejected = { ...withBoxes(sonnetBox), units: [tiered('S', 'sonnet', { kind: 'implement', verdict: 'rejected' })] }
  expect(tally(rejected)).toEqual({ done: 0, failed: 1, queued: 0 })
  const accepted = { ...withBoxes(sonnetBox), units: [tiered('S', 'sonnet', { kind: 'implement', verdict: 'accepted' })] }
  expect(tally(accepted)).toEqual({ done: 1, failed: 0, queued: 0 })
  const haikuBox = withModel(mk('h', 'done', T0, 'H'), HAIKU)
  expect(tally({ ...withBoxes(haikuBox), units: [tiered('H', 'haiku', { verdict: 'rejected' })] })).toEqual({ done: 0, failed: 1, queued: 0 })
  const op = withModel(mk('w', 'done', T0, 'W'), OPUS)
  const none = { ...withBoxes(op), units: [{ ...unit('W'), verdict: 'rejected' as const }] }
  expect(tally(none)).toEqual({ done: 1, failed: 0, queued: 0 })
})

// ---- the spawn gate ----

const gateBoard = (): Board => ({
  ...emptyBoard(T0),
  units: [
    labelled(tiered('H'), 'Find call sites'),
    labelled(tiered('S', 'sonnet', { kind: 'implement' }), 'Write state reducers'),
    tiered('O', 'opus', { kind: 'design' }),
    tiered('NA', 'haiku', { audit: null }),
    tiered('NK', 'haiku', { kind: null }),
    labelled(unit('NT', [], 'pending'), 'Review it myself'),
    oldUnit('L'),
    labelled(tiered('R', 'sonnet', { kind: 'implement', verdict: 'rejected' }), 'Redo the thing'),
    tiered('SP', 'sonnet', { kind: 'implement', spec: 'docs/spec.md' }),
  ],
})
const req = (over: Partial<SpawnRequest> = {}): SpawnRequest => ({
  subagentType: 'flowestra:haiku-worker',
  workerTier: 'haiku',
  ...over,
})
const sonnetReq = (over: Partial<SpawnRequest> = {}) => req({ subagentType: 'flowestra:sonnet-worker', workerTier: 'sonnet', ...over })

const withAgents = (b: Board, ...boxes: AgentBox[]): Pick<Board, 'agents' | 'order'> => {
  const agents = { ...b.agents }
  const order = [...b.order]
  for (const x of boxes) {
    agents[x.id] = x
    order.push(x.id)
  }
  return { agents, order }
}

test('coveringUnit: by name, by description when there is no name; the name wins', () => {
  const b = gateBoard()
  expect(coveringUnit(b, { name: 'S' })?.id).toBe('S')
  expect(coveringUnit(b, { name: 'nope' })).toBeNull()
  expect(coveringUnit(b, { description: '  find  CALL sites ' })?.id).toBe('H')
  expect(coveringUnit(b, { name: '', description: 'Find call sites' })?.id).toBe('H')
  expect(coveringUnit(b, { name: null, description: 'Write state reducers' })?.id).toBe('S')
  expect(coveringUnit(b, { description: 'Nothing matches this' })).toBeNull()
  expect(coveringUnit(b, {})).toBeNull()
  // with a name, the description is not consulted
  expect(coveringUnit(b, { name: 'S', description: 'Find call sites' })?.id).toBe('S')
  expect(coveringUnit(b, { name: 'nope', description: 'Find call sites' })).toBeNull()
})

test('spawnCheck rule 1: workflows and resumes of an unknown agent pass untouched', () => {
  const b = gateBoard()
  const flags: Array<Partial<SpawnRequest>> = [{ workflow: true }, { resume: true }]
  for (const flag of flags) {
    // even a refused built-in with no unit, or a rejected unit
    expect(spawnCheck(b, { subagentType: 'Explore', workerTier: null, ...flag })).toBeNull()
    expect(spawnCheck(b, req({ name: 'R', ...flag }))).toBeNull()
  }
})

test('spawnCheck rule 2: statusline-setup passes untouched', () => {
  expect(EXEMPT_TYPES).toEqual(['statusline-setup'])
  expect(spawnCheck(gateBoard(), { subagentType: 'statusline-setup', workerTier: null })).toBeNull()
  expect(spawnCheck(gateBoard(), { subagentType: 'statusline-setup', workerTier: null, name: 'nope', model: 'opus' })).toBeNull()
})

test('spawnCheck rule 3: the built-in types are refused, even when a unit covers the call', () => {
  expect(REFUSED_BUILTINS).toEqual(['Explore', 'Plan', 'general-purpose', 'claude', 'web-fetch', 'claude-code-guide'])
  const text =
    'Spawn refused (policy §1): the built-in type "Explore" is not used under the Model Routing Policy. Route the task with §1, declare its unit with AgentBoard, and spawn flowestra:haiku-worker, flowestra:sonnet-worker or flowestra:opus-worker.'
  expect(denyBuiltin('Explore')).toBe(text)
  const b = gateBoard()
  expect(spawnCheck(b, { subagentType: 'Explore', workerTier: null })).toBe(text)
  for (const type of REFUSED_BUILTINS) {
    expect(spawnCheck(b, { subagentType: type, workerTier: null, name: 'O', model: 'opus' })).toBe(denyBuiltin(type))
  }
  for (const type of ['web-fetch', 'claude-code-guide']) {
    expect(REFUSED_BUILTINS).toContain(type)
    expect(denyBuiltin(type)).toBe(text.replace('"Explore"', `"${type}"`))
    expect(spawnCheck(b, { subagentType: type, workerTier: null, name: 'O', model: 'opus' })).toBe(denyBuiltin(type))
  }
})

test('spawnCheck rule 4: no covering unit with a tier, a kind and an audit line', () => {
  const named =
    'Spawn refused (policy §9): no unit "X" with a tier, a kind and an audit line is declared. Declare it with AgentBoard first (tier, kind, audit "<task> | <tier> | <§1 step and conditions that selected it> | <what catches an error>") and give this Agent call that unit id as its name, or, where the Agent tool takes no name, that unit\'s label as its description.'
  const noName =
    'Spawn refused (policy §9): this Agent call has no name and its description matches no unit\'s label, so no unit with a tier, a kind and an audit line covers it. Declare one with AgentBoard first (tier, kind, audit "<task> | <tier> | <§1 step and conditions that selected it> | <what catches an error>") and give this Agent call that unit id as its name, or, where the Agent tool takes no name, that unit\'s label as its description.'
  expect(denyUndeclared('X')).toBe(named)
  expect(denyUndeclared(null)).toBe(noName)
  const b = gateBoard()
  expect(spawnCheck(b, req({ name: 'X' }))).toBe(named)
  for (const name of ['NA', 'NK', 'NT', 'L']) expect(spawnCheck(b, req({ name }))).toBe(denyUndeclared(name))
  // another agent type is gated the same way
  expect(spawnCheck(b, { subagentType: 'my-plugin:helper', workerTier: null, name: 'X', model: 'opus' })).toBe(named)
  // no name: by description
  expect(spawnCheck(b, req())).toBe(noName)
  expect(spawnCheck(b, req({ name: null, description: 'Nothing matches this' }))).toBe(noName)
  expect(spawnCheck(b, req({ name: '', description: 'Nothing matches this' }))).toBe(noName)
  expect(spawnCheck(b, req({ description: 'Review it myself' }))).toBe(noName)
  // with a name, the description is not consulted
  expect(spawnCheck(b, req({ name: 'NT', description: 'Find call sites' }))).toBe(denyUndeclared('NT'))
})

test('spawnCheck: a covered call on the tier worker passes, by name or by description', () => {
  const b = gateBoard()
  expect(spawnCheck(b, req({ name: 'H' }))).toBeNull()
  expect(spawnCheck(b, req({ description: '  find  CALL sites ' }))).toBeNull()
  expect(spawnCheck(b, sonnetReq({ name: 'S' }))).toBeNull()
  expect(spawnCheck(b, sonnetReq({ name: '', description: 'Write state reducers' }))).toBeNull()
  expect(spawnCheck(b, req({ subagentType: 'flowestra:opus-worker', workerTier: 'opus', name: 'O' }))).toBeNull()
  // a model of the worker's own tier, or none, is fine
  expect(spawnCheck(b, req({ name: 'H', model: 'haiku' }))).toBeNull()
  expect(spawnCheck(b, req({ name: 'H', model: HAIKU }))).toBeNull()
  expect(spawnCheck(b, req({ name: 'H', model: null }))).toBeNull()
  expect(spawnCheck(b, req({ name: 'H', model: '' }))).toBeNull()
})

test('spawnCheck rule 5: the tier of the call against the unit', () => {
  const b = gateBoard()
  // the wrong tier worker
  const wrong = 'Spawn refused (policy §1): unit "S" is routed to sonnet, but this call uses the haiku worker. Spawn flowestra:sonnet-worker, or re-route the unit.'
  expect(denyWrongWorker('S', 'sonnet', 'haiku')).toBe(wrong)
  expect(spawnCheck(b, req({ name: 'S' }))).toBe(wrong)
  expect(spawnCheck(b, sonnetReq({ name: 'H' }))).toBe(denyWrongWorker('H', 'haiku', 'sonnet'))
  // the right worker with another tier's model
  const override = 'Spawn refused (policy §1): the haiku worker runs on haiku; do not pass model "opus".'
  expect(denyModelOverride('haiku', 'haiku', 'opus')).toBe(override)
  expect(spawnCheck(b, req({ name: 'H', model: 'opus' }))).toBe(override)
  expect(spawnCheck(b, req({ name: 'H', model: 'claude-x' }))).toBe(denyModelOverride('haiku', 'haiku', 'claude-x'))
  // the wrong worker is checked before the model
  expect(spawnCheck(b, req({ name: 'S', model: 'opus' }))).toBe(wrong)
  // another agent type must name the unit's tier as its model
  const noModel = 'Spawn refused (policy §1): unit "S" is routed to sonnet; an agent type other than the tier workers must name model "sonnet" in the call.'
  expect(denyNoModel('S', 'sonnet', 'sonnet')).toBe(noModel)
  const other = (over: Partial<SpawnRequest>) => spawnCheck(b, { subagentType: 'my-plugin:helper', workerTier: null, name: 'S', ...over })
  expect(other({})).toBe(noModel)
  expect(other({ model: null })).toBe(noModel)
  expect(other({ model: 'opus' })).toBe(noModel)
  expect(other({ model: 'claude-x' })).toBe(noModel)
  expect(other({ model: 'sonnet' })).toBeNull()
  expect(other({ model: SONNET })).toBeNull()
  expect(other({ name: undefined, description: 'Write state reducers', model: 'sonnet' })).toBeNull()
})

test('spawnCheck rule 6: a rejected unit; after the tier check, before barred', () => {
  const text = 'Spawn refused (policy §8): unit "R" was rejected. Tighten the spec and retry it once at sonnet under a new unit; if that one fails too, ask the user.'
  const old = 'Spawn refused (policy §8): unit "R" was rejected. Re-route the task upward under a new unit.'
  expect(denyRejected('R', 'implement')).toBe(text)
  expect(denyRejected('R')).toBe(old)
  expect(denyRejected('R', 'locate')).toBe(old)
  expect(denyRejected('R', 'review')).toBe(old)
  const b = gateBoard()
  expect(spawnCheck(b, sonnetReq({ name: 'R' }))).toBe(text)
  expect(spawnCheck(b, sonnetReq({ description: 'Redo the thing' }))).toBe(text)
  // the tier check comes first
  expect(spawnCheck(b, req({ name: 'R' }))).toBe(denyWrongWorker('R', 'sonnet', 'haiku'))
  // rejected before barred
  const bar: Board = { ...b, rejects: [rej('x', 'sonnet', 'implement'), rej('y', 'sonnet', 'implement')] }
  expect(spawnCheck(bar, sonnetReq({ name: 'R' }))).toBe(text)
})

test('spawnCheck rule 7: a barred tier and kind; before the retry rule', () => {
  const text = 'Spawn refused (policy §8): locate is barred at haiku for the rest of this session (3 rejected). Route the unit one tier up.'
  expect(denyBarred('haiku', 'locate', 3)).toBe(text)
  const b: Board = {
    ...gateBoard(),
    units: [...gateBoard().units, labelled(tiered('SV', 'sonnet', { kind: 'review' }), 'Look it over')],
    rejects: [rej('x', 'haiku', 'locate'), rej('y', 'haiku', 'locate'), rej('z', 'haiku', 'locate'), rej('p', 'sonnet', 'review'), rej('q', 'sonnet', 'review'), rej('p2', 'sonnet', 'implement'), rej('q2', 'sonnet', 'implement'), rej('r', 'opus', 'design'), rej('s', 'opus', 'design')],
  }
  expect(spawnCheck(b, req({ name: 'H' }))).toBe(text)
  expect(spawnCheck(b, req({ description: 'Find call sites' }))).toBe(text)
  expect(spawnCheck(b, sonnetReq({ name: 'SV' }))).toBe(denyBarred('sonnet', 'review', 2))
  // writing at sonnet is never barred (0.17.0)
  expect(spawnCheck(b, sonnetReq({ name: 'S' }))).toBeNull()
  // opus is never barred
  expect(spawnCheck(b, req({ subagentType: 'flowestra:opus-worker', workerTier: 'opus', name: 'O' }))).toBeNull()
  // barred before retry
  const ran: Board = { ...b, ...withAgents(b, withModel(mk('a1', 'done', T0, 'H'), HAIKU), withModel(mk('a2', 'done', T0, 'H'), HAIKU)) }
  expect(spawnCheck(ran, req({ name: 'H' }))).toBe(text)
})

test('0.17.0: denyRetry words itself by kind', () => {
  expect(denyRetry('S', 'sonnet', 'implement')).toBe('Spawn refused (policy §8): unit "S" has already run twice at sonnet. Tighten the spec and declare a new unit, or ask the user.')
  expect(denyRetry('S', 'sonnet', 'review')).toBe(denyRetry('S', 'sonnet'))
  expect(denyRetry('H', 'haiku', 'locate')).toBe('Spawn refused (policy §8): unit "H" has already run twice at haiku. Never retry the same tier more than once: re-route it upward under a new unit.')
})

test('0.17.0: an opus unit of a writing kind is refused at spawn; the sonnet tier is where writing goes', () => {
  expect(denyOpusWriter('O', 'implement', ALL_ON)).toBe(
    'Spawn refused (policy §1): unit "O" is an opus unit of kind implement, and writing goes to the sonnet tier even under a §2 trigger (it runs on Sonnet). Declare it at sonnet and spawn flowestra:sonnet-worker; Opus designs and reviews it.',
  )
  expect(denyOpusWriter('O', 'docs', { opus: 'opus', sonnet: 'opus', haiku: 'haiku' })).toContain('(it runs on Opus)')
  for (const kind of WRITE_KINDS) {
    const b: Board = { ...gateBoard(), units: [tiered('O', 'opus', { kind })] }
    expect(spawnCheck(b, opusReq())).toBe(denyOpusWriter('O', kind, ALL_ON))
    expect(spawnCheck(b, opusReq({ models: { opus: 'opus', sonnet: 'opus', haiku: 'haiku' } }))).toBe(denyOpusWriter('O', kind, { opus: 'opus', sonnet: 'opus', haiku: 'haiku' }))
  }
  for (const kind of ['design', 'debug', 'review'] as const) {
    const b: Board = { ...gateBoard(), units: [tiered('O', 'opus', { kind })] }
    expect(spawnCheck(b, opusReq())).toBeNull()
  }
  // every model off: the unit is unavailable, not an opus writer
  const w: Board = { ...gateBoard(), units: [tiered('O', 'opus', { kind: 'implement' })] }
  expect(spawnCheck(w, opusReq({ models: NONE_ON }))).toBe(denyUnavailable('O', 'opus', NONE_ON))
  // a sonnet writer is fine
  expect(spawnCheck(gateBoard(), sonnetReq({ name: 'S' }))).toBeNull()
})

test('spawnCheck rule 8: two runs at the unit tier already; before the spec rule', () => {
  const text = 'Spawn refused (policy §8): unit "H" has already run twice at haiku. Never retry the same tier more than once: re-route it upward under a new unit.'
  expect(denyRetry('H', 'haiku')).toBe(text)
  const b = gateBoard()
  const once: Board = { ...b, ...withAgents(b, withModel(mk('a1', 'failed', T0, 'H'), HAIKU)) }
  expect(spawnCheck(once, req({ name: 'H' }))).toBeNull()
  const twice: Board = { ...b, ...withAgents(once, withModel(mk('a2', 'done', T0, 'H'), null)) }
  expect(spawnCheck(twice, req({ name: 'H' }))).toBe(text)
  // a run on another tier does not count
  const mixed: Board = { ...b, ...withAgents(once, withModel(mk('a2', 'done', T0, 'H'), OPUS)) }
  expect(spawnCheck(mixed, req({ name: 'H' }))).toBeNull()
  // retry before spec
  const sp: Board = { ...b, ...withAgents(b, withModel(mk('s1', 'done', T0, 'SP'), SONNET), withModel(mk('s2', 'done', T0, 'SP'), SONNET)) }
  expect(spawnCheck(sp, sonnetReq({ name: 'SP', specMissing: true }))).toBe(denyRetry('SP', 'sonnet', 'implement'))
})

test('spawnCheck rule 9: a missing spec file', () => {
  const text = 'Spawn refused: unit "SP" builds from spec "docs/spec.md", which does not exist. No implementation starts before its approved spec is on disk.'
  expect(denySpec('SP', 'docs/spec.md')).toBe(text)
  const b = gateBoard()
  expect(spawnCheck(b, sonnetReq({ name: 'SP', specMissing: true }))).toBe(text)
  expect(spawnCheck(b, sonnetReq({ name: 'SP', specMissing: false }))).toBeNull()
  expect(spawnCheck(b, sonnetReq({ name: 'SP' }))).toBeNull()
})

// ---- review fixes: placeholder boxes, resumed spawns ----

test('applySpawn over a placeholder box (turn.start first) clears tokensPartial and sets the label', () => {
  const ph = applyTurnStart(emptyBoard(T0), 'a1', T0)
  expect(box(ph, 'a1').tokensPartial).toBe(true)
  expect(isPlaceholder(box(ph, 'a1'))).toBe(true)
  const b = spawned(ph, 'a1')
  expect(box(b, 'a1').tokensPartial).toBe(false)
  expect(box(b, 'a1').label).toBe('Build the state module')
  expect(isPlaceholder(box(b, 'a1'))).toBe(false)
  expect(totals(b).partial).toBe(0)
})

test('applySpawn with resumed keeps the previous tokensPartial (false for a new box)', () => {
  const ph = applyTurnStart(emptyBoard(T0), 'a1', T0)
  const info = { agentId: 'a1', description: 'Resume the work', resumed: true }
  expect(box(applySpawn(ph, info, T0 + 1), 'a1').tokensPartial).toBe(true)
  const clean = spawned(emptyBoard(T0), 'a1')
  expect(box(applySpawn(clean, info, T0 + 1), 'a1').tokensPartial).toBe(false)
  expect(box(applySpawn(emptyBoard(T0), { ...info, agentId: 'n' }, T0), 'n').tokensPartial).toBe(false)
})

test('isPlaceholder: a worker labelled by its id; never the orchestrator', () => {
  expect(isPlaceholder(mk('x1', 'running'))).toBe(true)
  expect(isPlaceholder({ ...mk('x1', 'running'), label: 'Do the thing' })).toBe(false)
  expect(isPlaceholder(mk(MAIN_ID, 'running'))).toBe(false)
})

// ---- tasks (workstreams, 0.7.0) ----

const up = (b: Board, u: BoardUpdate, at = T0): Board => applyBoardUpdate(b, u, at)
const inTask = (b: AgentBox, taskId: string | null): AgentBox => ({ ...b, taskId })
const slot = (taskId: string, over: Partial<TaskSlot> = {}): TaskSlot => ({
  taskId,
  task: null,
  repo: null,
  phase: null,
  wave: null,
  units: [],
  status: 'open',
  activeAt: T0,
  ...over,
})
const sonnetSpawn = (b: Board, agentId: string, name: string | undefined, at = T0, over: Partial<Parameters<typeof applySpawn>[1]> = {}) =>
  applySpawn(b, { agentId, description: 'Do the work', subagentType: 'flowestra:sonnet-worker', model: SONNET, name, ...over }, at)
const finish = (b: Board, agentId: string, at = T0 + 1) => applyComplete(b, agentId, { reason: 'answer' }, at)
const ids = (boxes: AgentBox[]) => boxes.map(x => x.id)
const put1 = (b: Board, x: AgentBox): Board => ({ ...b, agents: { ...b.agents, [x.id]: x }, order: [...b.order, x.id] })

test('board-5: the empty board has no task open; a new box has no task and no routing', () => {
  const e = emptyBoard(T0)
  expect(e.taskId).toBeNull()
  expect(e.repo).toBeNull()
  expect(e.parked).toEqual([])
  expect(e.closed).toEqual([])
  expect(e.activeAt).toBe(T0)
  expect(taskSlots(e)).toEqual([])
  const b = spawned(e, 'a1')
  expect(box(b, 'a1').taskId).toBeNull()
  expect(box(b, 'a1').routed).toBeNull()
  expect(box(applyStep(e, 'z', null, T0), 'z').taskId).toBeNull()
  expect(box(applyStep(e, 'z', null, T0), 'z').routed).toBeNull()
})

test('an update with no taskId while no task is open opens task-1; later ones apply to it', () => {
  const b = up(emptyBoard(T0), { task: 'Build it', phase: 'design' }, T0 + 1)
  expect(b.taskId).toBe('task-1')
  expect(b.task).toBe('Build it')
  expect(b.phase).toBe('design')
  expect(b.activeAt).toBe(T0 + 1)
  expect(b.parked).toEqual([])
  const b2 = up(b, { phase: 'executing', repo: '/r/one' }, T0 + 2)
  expect(b2.taskId).toBe('task-1')
  expect(b2.repo).toBe('/r/one')
  expect(b2.activeAt).toBe(T0 + 1)
  // an empty update opens it too; an empty taskId counts as none
  expect(up(emptyBoard(T0), {}).taskId).toBe('task-1')
  expect(up(emptyBoard(T0), { taskId: '' }).taskId).toBe('task-1')
})

test('task-N: the first id no open or closed task uses', () => {
  let b = up(emptyBoard(T0), { taskId: 'task-1', task: 'one' })
  b = up(b, { taskId: 'task-2', task: 'two' }, T0 + 1)
  b = up(b, { close: true }, T0 + 2) // task-2 closed; task-1 back
  expect(b.taskId).toBe('task-1')
  b = up(b, { close: true }, T0 + 3) // task-1 closed; none open
  expect(b.taskId).toBeNull()
  b = up(b, { task: 'three' }, T0 + 4)
  expect(b.taskId).toBe('task-3')
  // a gap is filled
  let g = up(emptyBoard(T0), { taskId: 'task-2' })
  g = up(g, { close: true })
  expect(up(g, {}).taskId).toBe('task-1')
})

test('taskId naming an unknown id opens an empty task; the previous slot is parked with its activeAt', () => {
  const b = up(emptyBoard(T0), { taskId: 'wb-ui', task: 'UI', repo: '/r/ui', phase: 'design', wave: 1, units: [unit('U1')] }, T0 + 1)
  expect(b.taskId).toBe('wb-ui')
  expect(b.repo).toBe('/r/ui')
  expect(b.activeAt).toBe(T0 + 1)
  const b2 = up(b, { taskId: 'ab-journal', task: 'Journal' }, T0 + 5)
  expect(b2.taskId).toBe('ab-journal')
  expect(b2.task).toBe('Journal')
  expect(b2.repo).toBeNull()
  expect(b2.phase).toBeNull()
  expect(b2.wave).toBeNull()
  expect(b2.units).toEqual([])
  expect(b2.activeAt).toBe(T0 + 5)
  expect(b2.parked).toEqual([slot('wb-ui', { task: 'UI', repo: '/r/ui', phase: 'design', wave: 1, units: b.units, activeAt: T0 + 1 })])
  // naming the active task: nothing to switch, the fields apply
  const same = up(b2, { taskId: 'ab-journal', phase: 'testing' }, T0 + 9)
  expect(same.activeAt).toBe(T0 + 5)
  expect(same.phase).toBe('testing')
  expect(same.parked).toBe(b2.parked)
  // pure: the input is untouched
  expect(b.taskId).toBe('wb-ui')
  expect(b.parked).toEqual([])
})

test('taskId naming a parked task switches: the slots swap; the other fields apply to the task switched to', () => {
  const b = up(emptyBoard(T0), { taskId: 'wb-ui', task: 'UI', units: [unit('U1')] }, T0 + 1)
  const b2 = up(b, { taskId: 'ab-journal', task: 'Journal' }, T0 + 5)
  const b3 = up(b2, { taskId: 'wb-ui', phase: 'executing' }, T0 + 10)
  expect(b3.taskId).toBe('wb-ui')
  expect(b3.task).toBe('UI')
  expect(b3.phase).toBe('executing')
  expect(b3.units.map(u => u.id)).toEqual(['U1'])
  expect(b3.activeAt).toBe(T0 + 10)
  expect(b3.parked).toEqual([slot('ab-journal', { task: 'Journal', activeAt: T0 + 5 })])
  expect(b3.closed).toEqual([])
})

test('close: the active task moves to closed; the most recently active parked task becomes active; none parked: an empty slot', () => {
  let b = up(emptyBoard(T0), { taskId: 'a', units: [unit('A1')] }, T0 + 1)
  b = up(b, { taskId: 'b' }, T0 + 2)
  b = up(b, { taskId: 'c' }, T0 + 3)
  b = up(b, { taskId: 'a' }, T0 + 4) // parked: b (T0+2), c (T0+3)
  expect(b.parked.map(s => s.taskId)).toEqual(['b', 'c'])
  b = up(b, { close: true }, T0 + 5)
  expect(b.closed).toEqual([slot('a', { units: [unit('A1')], status: 'closed', activeAt: T0 + 4 })])
  expect(b.taskId).toBe('c')
  expect(b.activeAt).toBe(T0 + 5)
  expect(b.parked.map(s => s.taskId)).toEqual(['b'])
  // close is applied last: the other fields land on the closed task first
  b = up(b, { taskId: 'b', phase: 'done', close: true }, T0 + 6)
  expect(b.closed.map(s => [s.taskId, s.phase, s.status])).toEqual([['a', null, 'closed'], ['b', 'done', 'closed']])
  expect(b.taskId).toBe('c')
  expect(b.parked).toEqual([])
  // none parked: the active slot is emptied
  b = up(b, { task: 'title', repo: '/r', wave: 2, units: [unit('C1')], close: true }, T0 + 7)
  expect(b.taskId).toBeNull()
  expect(b.task).toBeNull()
  expect(b.repo).toBeNull()
  expect(b.phase).toBeNull()
  expect(b.wave).toBeNull()
  expect(b.units).toEqual([])
  expect(b.closed.map(s => s.taskId)).toEqual(['a', 'b', 'c'])
  // equal activeAt: the first parked one wins
  let t = up(emptyBoard(T0), { taskId: 'x' }, T0)
  t = up(t, { taskId: 'y' }, T0)
  t = up(t, { taskId: 'z' }, T0)
  expect(up(t, { close: true }, T0 + 1).taskId).toBe('x')
})

test('reopening a closed task moves it back from closed, units and phase included', () => {
  let b = up(emptyBoard(T0), { taskId: 'a', phase: 'review', units: [tiered('A1', 'sonnet', { verdict: 'accepted' })] }, T0 + 1)
  b = up(b, { taskId: 'b' }, T0 + 2)
  b = up(b, { taskId: 'a' }, T0 + 3)
  b = up(b, { close: true }, T0 + 4) // a closed, b active
  expect(slotOf(b, 'a')?.status).toBe('closed')
  const r = up(b, { taskId: 'a' }, T0 + 5)
  expect(r.taskId).toBe('a')
  expect(r.phase).toBe('review')
  expect(r.units.map(u => [u.id, u.verdict])).toEqual([['A1', 'accepted']])
  expect(r.activeAt).toBe(T0 + 5)
  expect(r.closed).toEqual([])
  expect(r.parked.map(s => s.taskId)).toEqual(['b'])
  expect(slotOf(r, 'a')?.status).toBe('open')
})

test('openTask: a slot from the journal becomes the active task; the previous one is parked; no reject is added', () => {
  const b = up(emptyBoard(T0), { taskId: 'x', task: 'X' }, T0 + 1)
  const units = [tiered('U1', 'sonnet', { kind: 'implement', verdict: 'rejected', context: ['/a/b.md'] })]
  const loaded = slot('old', { task: 'Old', repo: '/r/old', phase: 'executing', wave: 3, units, status: 'closed', activeAt: 5 })
  const o = openTask(b, loaded, T0 + 7)
  expect(o.taskId).toBe('old')
  expect(o.task).toBe('Old')
  expect(o.repo).toBe('/r/old')
  expect(o.phase).toBe('executing')
  expect(o.wave).toBe(3)
  expect(o.units).toEqual(units)
  expect(o.units[0]).not.toBe(units[0]) // copied
  expect(o.activeAt).toBe(T0 + 7)
  expect(o.parked).toEqual([slot('x', { task: 'X', activeAt: T0 + 1 })])
  expect(o.rejects).toEqual([])
  expect(taskSlots(o)[0]?.status).toBe('open')
  // a parked or closed slot of the same id is replaced; no task open: nothing parked
  const withOld = { ...emptyBoard(T0), parked: [slot('old')], closed: [slot('old', { status: 'closed' })] }
  const o2 = openTask(withOld, loaded, T0 + 8)
  expect(o2.parked).toEqual([])
  expect(o2.closed).toEqual([])
  expect(o2.taskId).toBe('old')
  // the update after it finds the task active: nothing to switch
  expect(up(o, { taskId: 'old', phase: 'testing' }, T0 + 9).activeAt).toBe(T0 + 7)
})

test('taskSlots: active first, then parked, then closed; slotOf finds any of them', () => {
  let b = up(emptyBoard(T0), { taskId: 'a' }, T0 + 1)
  b = up(b, { taskId: 'b' }, T0 + 2)
  b = up(b, { close: true }, T0 + 3) // b closed, a active
  b = up(b, { taskId: 'c' }, T0 + 4) // a parked
  expect(taskSlots(b).map(s => [s.taskId, s.status])).toEqual([['c', 'open'], ['a', 'open'], ['b', 'closed']])
  expect(slotOf(b, 'c')?.activeAt).toBe(T0 + 4)
  expect(slotOf(b, 'a')?.activeAt).toBe(T0 + 3) // active again from the close until c opened
  expect(slotOf(b, 'b')?.status).toBe('closed')
  expect(slotOf(b, 'nope')).toBeNull()
})

test('units carry their context; the list is copied', () => {
  const u = { ...unit('U1'), context: ['/x/decisions.md#B1', 'wb-ui:u2'] }
  const b = up(emptyBoard(T0), { units: [u] })
  expect(b.units[0]?.context).toEqual(['/x/decisions.md#B1', 'wb-ui:u2'])
  expect(b.units[0]?.context).not.toBe(u.context)
  // a unit stored without the field gets []
  expect(up(emptyBoard(T0), { units: [oldUnit('L')] }).units[0]?.context).toEqual([])
})

// two tasks that reuse one unit id: t1's U1 ran (a1, a2); t2 declares its own U1
const twoTasks = (): Board => {
  let b = up(emptyBoard(T0), { taskId: 't1', phase: 'executing', units: [labelled(tiered('U1', 'sonnet', { kind: 'implement' }), 'Task one unit')] })
  b = finish(sonnetSpawn(b, 'a1', 'U1'), 'a1')
  b = finish(sonnetSpawn(b, 'a2', 'U1'), 'a2')
  return up(b, { taskId: 't2', phase: 'executing', units: [labelled(tiered('U1', 'sonnet', { kind: 'implement' }), 'Task two unit')] }, T0 + 2)
}

test('scoping by (taskId, unitId): unitOf reads the box own task, active, parked or closed', () => {
  const b = twoTasks()
  expect(box(b, 'a1').taskId).toBe('t1')
  expect(box(b, 'a1').unitId).toBe('U1')
  expect(unitOf(b, box(b, 'a1'))?.label).toBe('Task one unit') // t1 parked
  const c = up(up(b, { taskId: 't1' }, T0 + 3), { close: true }, T0 + 4) // t1 closed, t2 active
  expect(c.taskId).toBe('t2')
  expect(unitOf(c, box(c, 'a1'))?.label).toBe('Task one unit') // t1 closed
  // a box of t2 reads t2's unit
  const d = sonnetSpawn(b, 'b1', 'U1', T0 + 3)
  expect(box(d, 'b1').taskId).toBe('t2')
  expect(unitOf(d, box(d, 'b1'))?.label).toBe('Task two unit')
  // a box with no task reads the active task's units
  expect(unitOf(b, inTask(mk('n', 'running', null, 'U1'), null))?.label).toBe('Task two unit')
  // a box of an unknown task: none
  expect(unitOf(b, inTask(mk('q', 'running', null, 'U1'), 'zz'))).toBeNull()
})

test('scoping by (taskId, unitId): relinking on a units update touches only boxes of the active task or of none', () => {
  let b = twoTasks()
  // t2's list without U1: t1's boxes keep their link
  b = up(b, { units: [unit('U9')] }, T0 + 3)
  expect(box(b, 'a1').unitId).toBe('U1')
  // an unnamed box of t1 whose label matches a t2 unit is not linked to it
  let c = up(emptyBoard(T0), { taskId: 't1', units: [] })
  c = applySpawn(c, { agentId: 'x', description: 'Shared label here', subagentType: 'flowestra:sonnet-worker' }, T0)
  c = up(c, { taskId: 't2', units: [labelled(unit('L2'), 'Shared label here')] }, T0 + 1)
  expect(box(c, 'x').unitId).toBeNull()
  // a box with no task is linked by its name against the active task
  let n = applyStep(emptyBoard(T0), 'p', null, T0)
  n = reconcile(n, [{ id: 'p', description: 'd', type: 't', status: 'running', name: 'P1' }], T0)
  n = up(n, { taskId: 't3', units: [unit('P1')] }, T0 + 1)
  expect(box(n, 'p').unitId).toBe('P1')
  // reconcile links by list name only a box of the active task or of none
  let r = up(emptyBoard(T0), { taskId: 't1', units: [unit('R1')] })
  r = put1(r, inTask({ ...mk('o', 'running'), name: null }, 't2'))
  r = reconcile(r, [{ id: 'o', description: 'd', type: 't', status: 'running', name: 'R1' }], T0)
  expect(box(r, 'o').unitId).toBeNull()
})

test('scoping by (taskId, unitId): unitState and tally see only boxes of the unit task', () => {
  const b = twoTasks()
  const u2 = b.units[0] as Unit
  expect(unitState(b, u2)).toBe('ready') // t1's done runs of U1 do not finish t2's U1
  const u1 = slotOf(b, 't1')?.units[0] as Unit
  expect(unitState(b, u1, 't1')).toBe('done')
  expect(tally(b)).toEqual({ done: 0, failed: 0, queued: 1 })
  // back on t1: its two done runs count, nothing queued
  const t1 = up(b, { taskId: 't1' }, T0 + 3)
  expect(tally(t1)).toEqual({ done: 2, failed: 0, queued: 0 })
  // dependencies are looked up in the unit's own task
  const dep = up(t1, { units: [tiered('U1', 'sonnet', { kind: 'implement' }), unit('W', ['U1'])] }, T0 + 4)
  const t2 = up(dep, { taskId: 't2', units: [tiered('U1', 'sonnet', { kind: 'implement' }), unit('W', ['U1'])] }, T0 + 5)
  expect(unitState(t2, t2.units[1] as Unit)).toBe('blocked')
  expect(unitState(t2, slotOf(t2, 't1')?.units[1] as Unit, 't1')).toBe('ready')
})

test('scoping by (taskId, unitId): verdicts are per task; a done box of t2 is failed only by t2 verdict', () => {
  let b = up(twoTasks(), { taskId: 't1', units: [tiered('U1', 'sonnet', { kind: 'implement', verdict: 'rejected' })] }, T0 + 3)
  b = up(b, { taskId: 't2' }, T0 + 4)
  b = finish(sonnetSpawn(b, 'b1', 'U1', T0 + 5), 'b1', T0 + 6)
  expect(tally(b)).toEqual({ done: 1, failed: 0, queued: 0 })
  expect(unitState(b, b.units[0] as Unit)).toBe('done')
  // t1 sees its rejection
  const t1 = up(b, { taskId: 't1' }, T0 + 7)
  expect(tally(t1)).toEqual({ done: 0, failed: 2, queued: 0 })
})

test('scoping by (taskId, unitId): isHeld counts the last carrier within the box task only', () => {
  const b = twoTasks()
  // a2 (t1) is not held while t2 is active
  expect(isHeld(b, box(b, 'a2'))).toBe(false)
  const t1 = up(b, { taskId: 't1' }, T0 + 3)
  expect(isHeld(t1, box(t1, 'a2'))).toBe(true)
  expect(isHeld(t1, box(t1, 'a1'))).toBe(false) // not the last of its unit
  // a later box of t2 carrying its own U1 does not take a2's place in t1
  const later = up(finish(sonnetSpawn(b, 'b1', 'U1', T0 + 4), 'b1', T0 + 5), { taskId: 't1' }, T0 + 6)
  expect(isHeld(later, box(later, 'a2'))).toBe(true)
  // and b1 is held in t2
  const back = up(later, { taskId: 't2' }, T0 + 7)
  expect(isHeld(back, box(back, 'b1'))).toBe(true)
})

test('scoping by (taskId, unitId): rejects are de-duplicated per task', () => {
  let b = up(emptyBoard(T0), { taskId: 't1', units: [tiered('U1', 'haiku', { verdict: 'rejected' })] })
  b = up(b, { units: [tiered('U1', 'haiku', { verdict: 'rejected' })] })
  expect(b.rejects).toEqual([rej('U1', 'haiku', 'locate', 't1')])
  b = up(b, { taskId: 't2', units: [tiered('U1', 'haiku', { verdict: 'rejected' })] }, T0 + 1)
  expect(b.rejects).toEqual([rej('U1', 'haiku', 'locate', 't1'), rej('U1', 'haiku', 'locate', 't2')])
  // two rejects of one kind from two tasks bar it for the session
  expect(isBarred(b, 'haiku', 'locate')).toBe(true)
})

test('scoping by (taskId, unitId): the two-runs rule counts runs of the active task only', () => {
  const b = twoTasks()
  // t2's U1 has not run: passes
  expect(spawnCheck(b, sonnetReq({ name: 'U1' }))).toBeNull()
  // t1's U1 ran twice
  const t1 = up(b, { taskId: 't1' }, T0 + 3)
  expect(spawnCheck(t1, sonnetReq({ name: 'U1' }))).toBe(denyRetry('U1', 'sonnet', 'implement'))
  // one run in t2 still passes
  const once = sonnetSpawn(b, 'b1', 'U1', T0 + 4)
  expect(spawnCheck(once, sonnetReq({ name: 'U1' }))).toBeNull()
})

test('routed: recorded at spawn from the covering unit when it has a tier, a kind and an audit line', () => {
  const units = [
    labelled(tiered('S', 'sonnet', { kind: 'implement' }), 'Do the work'),
    tiered('NA', 'sonnet', { audit: null }),
    tiered('NK', 'sonnet', { kind: null }),
    unit('NT'),
  ]
  const b = up(emptyBoard(T0), { taskId: 't1', units })
  expect(box(sonnetSpawn(b, 'a', 'S'), 'a').routed).toEqual({ tier: 'sonnet', kind: 'implement', audit: auditFor('sonnet'), ranOn: 'sonnet' })
  // linked by label: recorded too
  expect(box(sonnetSpawn(b, 'a', undefined), 'a').routed).toEqual({ tier: 'sonnet', kind: 'implement', audit: auditFor('sonnet'), ranOn: 'sonnet' })
  expect(box(sonnetSpawn(b, 'a', 'NA'), 'a').routed).toBeNull()
  expect(box(sonnetSpawn(b, 'a', 'NK'), 'a').routed).toBeNull()
  expect(box(sonnetSpawn(b, 'a', 'NT'), 'a').routed).toBeNull()
  expect(box(sonnetSpawn(b, 'a', 'nope'), 'a').routed).toBeNull()
  // stamped with the active task
  expect(box(sonnetSpawn(b, 'a', 'S'), 'a').taskId).toBe('t1')
})

test('routed: auditIssue and tierOf hold after the unit leaves the list, after a switch and after a close', () => {
  let b = up(emptyBoard(T0), { taskId: 't1', units: [tiered('H', 'haiku')] })
  b = applySpawn(b, { agentId: 'h', description: 'Find', subagentType: 'flowestra:haiku-worker', name: 'H' }, T0) // model not reported yet
  expect(auditIssue(b, box(b, 'h'))).toBe('none')
  // the unit leaves the list
  const gone = up(b, { units: [] }, T0 + 1)
  expect(unitOf(gone, box(gone, 'h'))).toBeNull()
  expect(auditIssue(gone, box(gone, 'h'))).toBe('none')
  expect(tierOf(gone, box(gone, 'h'))).toBe('haiku')
  // switched away
  const sw = up(b, { taskId: 't2' }, T0 + 1)
  expect(auditIssue(sw, box(sw, 'h'))).toBe('none')
  expect(tierOf(sw, box(sw, 'h'))).toBe('haiku')
  // closed
  const cl = up(b, { close: true }, T0 + 1)
  expect(cl.taskId).toBeNull()
  expect(auditIssue(cl, box(cl, 'h'))).toBe('none')
  expect(tierOf(cl, box(cl, 'h'))).toBe('haiku')
  // a model of another tier than routed: mismatch, even with the unit gone
  const om = { ...box(gone, 'h'), model: OPUS }
  expect(auditIssue(gone, om)).toBe('tier-mismatch')
  expect(auditIssue(gone, { ...om, model: HAIKU })).toBe('none')
})

test('routed: read first; the unit only when routed is null', () => {
  const b = onBoard([tiered('S', 'sonnet'), tiered('H', 'haiku')])
  const routedHaiku = { tier: 'haiku' as const, kind: 'locate' as const, audit: auditFor('haiku') }
  // routed wins over a unit that says another tier
  const x = { ...withModel(mk('x', 'running', null, 'S'), HAIKU), routed: routedHaiku }
  expect(auditIssue(b, x)).toBe('none')
  expect(tierOf(b, { ...x, model: null })).toBe('haiku') // routed before the unit's sonnet
  // routed with an empty audit line: no audit
  expect(auditIssue(b, { ...x, routed: { ...routedHaiku, audit: '' } })).toBe('no-audit')
  // routed null: the unit is read (a box seen before the board knew its unit)
  let late = applySpawn(emptyBoard(T0), { agentId: 'l', description: 'Find', subagentType: 'flowestra:haiku-worker', model: HAIKU, name: 'H' }, T0)
  expect(box(late, 'l').routed).toBeNull()
  expect(auditIssue(late, box(late, 'l'))).toBe('no-audit')
  late = up(late, { units: [tiered('H', 'haiku')] })
  expect(box(late, 'l').unitId).toBe('H')
  expect(auditIssue(late, box(late, 'l'))).toBe('none')
  expect(auditIssue(up(late, { units: [] }, T0 + 1), box(late, 'l'))).toBe('no-audit')
})

test('applySpawn: a resumed spawn keeps the box task and routing; a new spawn over a placeholder takes the active task', () => {
  let b = up(emptyBoard(T0), { taskId: 't1', units: [tiered('U1', 'sonnet', { kind: 'implement' })] })
  b = finish(sonnetSpawn(b, 'a1', 'U1'), 'a1')
  const routed = box(b, 'a1').routed
  b = up(b, { taskId: 't2', units: [tiered('U1', 'opus', { kind: 'design' })] }, T0 + 2)
  const r = sonnetSpawn(b, 'a1', 'U1', T0 + 3, { resumed: true })
  expect(box(r, 'a1').taskId).toBe('t1')
  expect(box(r, 'a1').routed).toEqual(routed)
  expect(box(r, 'a1').unitId).toBe('U1')
  expect(unitOf(r, box(r, 'a1'))?.tier).toBe('sonnet') // still t1's unit
  // a placeholder made by an event before the spawn: the spawn stamps the active task
  const ph = applyTurnStart(b, 'p1', T0 + 4)
  expect(box(ph, 'p1').taskId).toBeNull()
  const s = sonnetSpawn(ph, 'p1', 'U1', T0 + 5)
  expect(box(s, 'p1').taskId).toBe('t2')
  expect(box(s, 'p1').routed?.tier).toBe('opus')
})

test('per-task counts and rows: tally, inActiveTask, otherTaskOf, shownBoxes, otherEnded, otherOpen', () => {
  const now = T0 + 60_000
  const b: Board = {
    ...withBoxes(
      mk(MAIN_ID, 'running'),
      inTask(withModel(mk('a-run', 'running'), OPUS), 't1'),
      inTask(withModel(mk('a-done', 'done', T0, 'A'), OPUS), 't1'), // long ended
      inTask(withModel(mk('a-fresh', 'failed', now - 1000), OPUS), 't1'),
      inTask(withModel(mk('p-run', 'running'), OPUS), 'tp'),
      inTask(withModel(mk('p-wait', 'waiting'), OPUS), 'tp'),
      inTask(withModel(mk('p-fresh', 'done', now - 500, 'P'), OPUS), 'tp'),
      inTask(withModel(mk('p-old', 'stopped', T0), OPUS), 'tp'),
      inTask(withModel(mk('c-done', 'done', T0), OPUS), 'tc'),
      inTask(withModel(mk('c-run', 'running'), OPUS), 'tc'),
      inTask(withModel(mk('n-run', 'running'), OPUS), null),
      inTask(withModel(mk('n-done', 'done', T0), OPUS), null),
      inTask(withModel(mk('h-run', 'running'), HAIKU), 'tp'),
    ),
    taskId: 't1',
    units: [unit('A'), unit('Q')],
    phase: 'executing',
    parked: [slot('tp', { units: [tiered('P', 'sonnet')] })],
    closed: [slot('tc', { status: 'closed' })],
  }
  const a = (id: string) => box(b, id)
  expect(inActiveTask(b, a('a-run'))).toBe(true)
  expect(inActiveTask(b, a('p-run'))).toBe(false)
  expect(inActiveTask(b, a('n-run'))).toBe(false)
  expect(otherTaskOf(b, a('a-run'))).toBeNull()
  expect(otherTaskOf(b, a('p-run'))).toBe('tp')
  expect(otherTaskOf(b, a('c-done'))).toBe('tc')
  expect(otherTaskOf(b, a('n-run'))).toBeNull()
  // counts: the active task's boxes only
  expect(tally(b)).toEqual({ done: 1, failed: 1, queued: 1 })
  expect(ids(shownBoxes(b))).toEqual(['a-run', 'a-done', 'a-fresh', 'p-run', 'p-wait', 'c-run', 'n-run', 'h-run'])
  expect(otherEnded(b)).toBe(3) // p-fresh, p-old, c-done
  expect(otherOpen(b)).toEqual({ tasks: 1, running: 3 }) // p-run, p-wait, h-run; c-run is a closed task's
  // rows: the active task's live and lingering; other tasks' live only (p-fresh lingers but is t2's;
  // p-fresh would be held by B3.3 in its own task)
  expect(ids(rowWorkers(b, now))).toEqual(['a-run', 'a-fresh', 'p-run', 'p-wait', 'c-run', 'n-run'])
  expect(ids(rowLeads(b, now))).toEqual(['h-run'])
  // tokens stay whole-session
  expect(totals(b).unknown).toBe(13)
  // no task open: only a box of no task is the active task's; a closed task's agents are counted nowhere
  const none: Board = { ...b, taskId: null, parked: [], units: [] }
  expect(inActiveTask(none, a('c-done'))).toBe(false)
  expect(otherTaskOf(none, a('c-done'))).toBe(a('c-done').taskId)
  expect(inActiveTask(none, { ...a('c-done'), taskId: null })).toBe(true)
  expect(otherOpen(none)).toEqual({ tasks: 0, running: 0 })
  expect(otherOpen(emptyBoard(T0))).toEqual({ tasks: 0, running: 0 })
  expect(shownBoxes(emptyBoard(T0))).toEqual([])
})

test('per-task rows: a held card of the active task stays; once switched away it shows only while live', () => {
  const now = T0 + 60_000
  let b = up(emptyBoard(T0), { taskId: 't1', phase: 'executing', units: [tiered('S', 'sonnet', { kind: 'implement' })] })
  b = finish(sonnetSpawn(b, 's1', 'S'), 's1')
  expect(ids(rowWorkers(b, now))).toEqual(['s1'])
  const sw = up(b, { taskId: 't2' }, T0 + 2)
  expect(rowWorkers(sw, now)).toEqual([])
  expect(otherEnded(sw)).toBe(1)
  expect(otherOpen(sw)).toEqual({ tasks: 1, running: 0 })
  // a live box of t1 after the switch keeps its card and counts as running in t1
  const live = up(sonnetSpawn(b, 's2', 'S', T0 + 3), { taskId: 't2' }, T0 + 4)
  expect(ids(rowWorkers(live, now))).toEqual(['s2'])
  expect(otherOpen(live)).toEqual({ tasks: 1, running: 1 })
  expect(tally(live)).toEqual({ done: 0, failed: 0, queued: 0 })
})

test('0.17.0 D-B: a spawn raises the wave, and a writing unit moves an early phase to executing', () => {
  const units = [
    tiered('W1', 'sonnet', { kind: 'implement', wave: 1 }),
    tiered('W2', 'sonnet', { kind: 'tests', wave: 2 }),
    tiered('R1', 'sonnet', { kind: 'review', wave: 3 }),
    tiered('L1', 'haiku', { kind: 'locate', wave: 2 }),
  ]
  const base = (phase: BoardUpdate['phase'], wave: number | null = null) => up(emptyBoard(T0), { taskId: 't1', phase, wave, units })
  for (const phase of [null, 'analysis', 'design', 'approval'] as const) {
    const b = sonnetSpawn(base(phase ?? undefined), 'a', 'W1')
    expect(b.phase).toBe('executing')
    expect(b.wave).toBe(1)
  }
  // the wave rises and never falls
  expect(sonnetSpawn(base('executing', 2), 'a', 'W1').wave).toBe(2)
  expect(sonnetSpawn(base('executing', 1), 'a', 'W2').wave).toBe(2)
  // testing and review are not touched; done neither
  for (const phase of ['testing', 'review', 'done'] as const) expect(sonnetSpawn(base(phase), 'a', 'W1').phase).toBe(phase)
  // a non-writing unit leaves the phase, but still raises the wave
  const r = sonnetSpawn(base('design'), 'a', 'R1')
  expect(r.phase).toBe('design')
  expect(r.wave).toBe(3)
  const l = applySpawn(base('analysis'), { agentId: 'h', description: 'Find', subagentType: 'flowestra:haiku-worker', model: HAIKU, name: 'L1' }, T0)
  expect(l.phase).toBe('analysis')
  // resumed, ungated and unlinked spawns change nothing
  const b0 = base('design')
  const started = sonnetSpawn(b0, 'a', 'W1')
  const resumed = sonnetSpawn(started, 'a', 'W1', T0 + 1, { resumed: true })
  expect(resumed.wave).toBe(started.wave)
  const rewound = { ...started, phase: 'design' as const, wave: 0 }
  const again = sonnetSpawn(rewound, 'a', 'W1', T0 + 1, { resumed: true })
  expect([again.phase, again.wave]).toEqual(['design', 0])
  const ungated = sonnetSpawn(b0, 'u', 'W1', T0, { ungated: { kind: 'workflow' } as never })
  expect([ungated.phase, ungated.wave]).toEqual([b0.phase, b0.wave])
  const unlinked = sonnetSpawn(b0, 'x', 'nope')
  expect([unlinked.phase, unlinked.wave]).toEqual([b0.phase, b0.wave])
  // a unit of a parked task is not the active task's
  const parked = up(b0, { taskId: 't2', units: [tiered('P1', 'sonnet', { kind: 'implement' })] }, T0 + 1)
  const toParked = up(parked, { taskId: 't1' }, T0 + 2)
  expect(sonnetSpawn(toParked, 'p', 'P1').phase).toBe(toParked.phase)
})

test('B3.2: an accepted verdict withdraws the rejection of the same (taskId, unitId); a kind is no longer barred', () => {
  const twoRejected = [tiered('H1', 'haiku', { verdict: 'rejected' }), tiered('H2', 'haiku', { verdict: 'rejected' })]
  const b = up(emptyBoard(T0), { taskId: 't1', units: twoRejected })
  expect(isBarred(b, 'haiku', 'locate')).toBe(true)
  expect(spawnCheck(up(b, { units: [...twoRejected, labelled(tiered('H3'), 'Find more')] }), req({ name: 'H3' }))).toBe(denyBarred('haiku', 'locate', 2))
  const b2 = up(b, { units: [tiered('H1', 'haiku', { verdict: 'accepted' }), twoRejected[1] as Unit, tiered('H3')] }, T0 + 1)
  expect(b2.rejects).toEqual([rej('H2', 'haiku', 'locate', 't1')])
  expect(isBarred(b2, 'haiku', 'locate')).toBe(false)
  expect(spawnCheck(b2, req({ name: 'H3' }))).toBeNull()
  expect(withdrawn(b, b2)).toEqual([{ taskId: 't1', unitId: 'H1' }])
  expect(withdrawn(b2, b2)).toEqual([])
  expect(withdrawn(b2, b)).toEqual([])
  // accepted with nothing to withdraw: rejects unchanged
  expect(up(b2, { units: [tiered('H3', 'haiku', { verdict: 'accepted' })] }, T0 + 2).rejects).toEqual(b2.rejects)
  // a unit of the same id accepted in another task does not withdraw t1's
  const other = up(b, { taskId: 't2', units: [tiered('H1', 'haiku', { verdict: 'accepted' })] }, T0 + 3)
  expect(other.rejects).toEqual(b.rejects)
  expect(withdrawn(b, other)).toEqual([])
  // a reject recorded with no task (an older entry) is withdrawn only by a board with no task: never by t1
  const legacy: Board = { ...b, rejects: [rej('H1', 'haiku', 'locate', null)] }
  expect(up(legacy, { units: [tiered('H1', 'haiku', { verdict: 'accepted' })] }).rejects).toEqual(legacy.rejects)
})

test('spawnCheck: a fork is refused first, even when a unit covers it and from a nested loop', () => {
  const text =
    "Spawn refused (policy §1, §9): a fork copies this whole conversation and runs on your own model, with no tier and no audit line. Route the task with §1, declare its unit with AgentBoard and spawn the tier's worker; for the context earlier work built, name the journal entries and the decisions.md entry it must read in the unit's context."
  expect(denyFork()).toBe(text)
  const b = gateBoard()
  expect(spawnCheck(b, req({ name: 'H', fork: true }))).toBe(text)
  expect(spawnCheck(b, { subagentType: 'statusline-setup', workerTier: null, fork: true })).toBe(text)
  expect(spawnCheck(b, { subagentType: 'Explore', workerTier: null, fork: true })).toBe(text)
  expect(spawnCheck(b, req({ name: 'H', fork: true, workflow: true }))).toBe(text)
  expect(spawnCheck(b, req({ name: 'H', fork: true, resume: true }))).toBe(text)
  expect(spawnCheck(b, req({ name: 'H', fork: true, nested: true }))).toBe(text)
  expect(spawnCheck(b, req({ name: 'H', fork: false }))).toBeNull()
})

test('spawnCheck: a context item that did not resolve is refused, right after the spec rule', () => {
  const text = 'Spawn refused: unit "S" names context "wb-ui:u9", which is no journal entry or file. Name an existing entry or file.'
  expect(denyContext('S', 'wb-ui:u9')).toBe(text)
  const b = gateBoard()
  expect(spawnCheck(b, sonnetReq({ name: 'S', contextMissing: 'wb-ui:u9' }))).toBe(text)
  expect(spawnCheck(b, sonnetReq({ name: 'S', contextMissing: null }))).toBeNull()
  expect(spawnCheck(b, sonnetReq({ name: 'S', contextMissing: '' }))).toBeNull()
  // the spec rule first
  expect(spawnCheck(b, sonnetReq({ name: 'SP', specMissing: true, contextMissing: '/x' }))).toBe(denySpec('SP', 'docs/spec.md'))
  expect(spawnCheck(b, sonnetReq({ name: 'SP', contextMissing: '/x' }))).toBe(denyContext('SP', '/x'))
  // the retry rule before it
  const sp: Board = { ...b, ...withAgents(b, withModel(mk('s1', 'done', T0, 'SP'), SONNET), withModel(mk('s2', 'done', T0, 'SP'), SONNET)) }
  expect(spawnCheck(sp, sonnetReq({ name: 'SP', contextMissing: '/x' }))).toBe(denyRetry('SP', 'sonnet', 'implement'))
  // an uncovered call is refused for that, not for its context
  expect(spawnCheck(b, req({ name: 'X', contextMissing: '/x' }))).toBe(denyUndeclared('X'))
})

test('spawnCheck rule 4: with no name, a description matching one unit of a parked task adds a hint to switch', () => {
  const b: Board = {
    ...gateBoard(),
    taskId: 't1',
    parked: [
      slot('wb-ui', { units: [labelled(tiered('J1', 'sonnet'), 'Write the journal'), labelled(unit('T1'), 'Twice here')] }),
      slot('cr-fix', { units: [labelled(unit('T2'), 'Twice here'), labelled(unit('V1'), 'Review it myself')] }),
    ],
  }
  const hint = ' (it matches unit "J1" of task "wb-ui": switch to it first)'
  expect(parkedMatch(b, '  write THE journal ')).toEqual({ unitId: 'J1', taskId: 'wb-ui' })
  expect(spawnCheck(b, sonnetReq({ description: 'Write the journal' }))).toBe(denyUndeclared(null) + hint)
  expect(denyUndeclared(null, { unitId: 'J1', taskId: 'wb-ui' })).toBe(denyUndeclared(null) + hint)
  // two parked matches: no hint
  expect(parkedMatch(b, 'Twice here')).toBeNull()
  expect(spawnCheck(b, sonnetReq({ description: 'Twice here' }))).toBe(denyUndeclared(null))
  // no match anywhere, or an empty description: no hint
  expect(spawnCheck(b, sonnetReq({ description: 'Nothing matches this' }))).toBe(denyUndeclared(null))
  expect(parkedMatch(b, '')).toBeNull()
  // the active task has a unit of that label (with no tier): refused with no hint
  expect(spawnCheck(b, sonnetReq({ description: 'Review it myself' }))).toBe(denyUndeclared(null))
  // with a name: no hint, and the parked unit id does not cover it
  expect(spawnCheck(b, sonnetReq({ name: 'J1', description: 'Write the journal' }))).toBe(denyUndeclared('J1'))
  expect(coveringUnit(b, { name: 'J1' })).toBeNull()
  expect(coveringUnit(b, { description: 'Write the journal' })).toBeNull()
})

// ---- worker models (0.10.0) ----

const OPUS_OFF: WorkerModels = { opus: 'sonnet', sonnet: 'sonnet', haiku: 'haiku' }
const OPUS_SONNET_OFF: WorkerModels = { opus: 'haiku', sonnet: 'haiku', haiku: 'haiku' }
const NONE_ON: WorkerModels = { opus: null, sonnet: null, haiku: null }
const opusReq = (over: Partial<SpawnRequest> = {}) => req({ subagentType: 'flowestra:opus-worker', workerTier: 'opus', name: 'O', ...over })
const routedBox = (id: string, unitId: string, model: string | null, routed: Routed | null): AgentBox => ({
  ...mk(id, 'done', T0 + 1, unitId),
  model,
  routed,
})
const AUDIT = 'find the callers | opus | §1 | re-read'

test('the board shape tag is board-7', () => {
  expect(BOARD_SHAPE).toBe('board-7')
})

test('board-7: an empty board has leadByTask and boardSent; a new box has peakIn null', () => {
  const b = emptyBoard(5)
  expect(b.leadByTask).toEqual({})
  expect(b.boardSent).toEqual({})
  expect(box(spawned(b, 'a'), 'a').peakIn).toBeNull()
})

test('applyStep: peakIn is the largest request; the lead is split by the task active at each request', () => {
  let b: Board = { ...emptyBoard(T0), taskId: 'a' }
  b = applyStep(b, undefined, usage(100, 10, 300, 200), T0)
  b = applyStep(b, undefined, usage(1000, 5, 0, 0), T0)
  expect(box(b, 'main').tokens).toEqual({ input: 1100, output: 15, cacheRead: 300, cacheWrite: 200, requests: 2 })
  expect(box(b, 'main').peakIn).toBe(1000)
  expect(b.leadByTask['a']).toEqual(box(b, 'main').tokens!)
  b = applyStep({ ...b, taskId: 'b' }, undefined, usage(7, 1, 2, 3), T0)
  expect(b.leadByTask['b']).toEqual({ input: 7, output: 1, cacheRead: 2, cacheWrite: 3, requests: 1 })
  expect(b.leadByTask['a']!.requests).toBe(2)
  const none = applyStep(emptyBoard(T0), undefined, usage(1, 1, 1, 1), T0)
  expect(Object.keys(none.leadByTask)).toEqual([''])
  // a null usage changes neither field
  const nul = applyStep(b, undefined, null, T0 + 1)
  expect(nul.leadByTask).toEqual(b.leadByTask)
  expect(box(nul, 'main').peakIn).toBe(1000)
  expect(box(applyStep(emptyBoard(T0), undefined, null, T0), 'main').peakIn).toBeNull()
})

test('applyStep: a worker step sets its own peakIn and never touches leadByTask', () => {
  const b = applyStep(spawned({ ...emptyBoard(T0), taskId: 'a' }, 'w'), 'w', usage(10, 2, 20, 30), T0)
  expect(box(b, 'w').peakIn).toBe(60)
  expect(b.leadByTask).toEqual({})
})

test('applySpawn: a resume adds its message length to briefChars; a new id keeps its own', () => {
  const first = applySpawn(emptyBoard(T0), { agentId: 'r', description: 'Work', promptChars: 100 }, T0)
  const resumed = applySpawn(first, { agentId: 'r', description: 'Work', promptChars: 30, resumed: true }, T0 + 1)
  expect(box(resumed, 'r').briefChars).toBe(130)
  const other = applySpawn(resumed, { agentId: 's', description: 'Work', promptChars: 40 }, T0 + 2)
  expect(box(other, 's').briefChars).toBe(40)
})

test('applyComplete: each run answer is added to resultChars once; no length stays null', () => {
  let b = applySpawn(emptyBoard(T0), { agentId: 'r', description: 'Work', promptChars: 1 }, T0)
  b = applyComplete(b, 'r', { reason: 'answer', answerChars: 50 }, T0 + 1)
  expect(box(b, 'r').resultChars).toBe(50)
  b = applyComplete(b, 'r', { reason: 'answer', answerChars: 99 }, T0 + 2) // the same ended run
  expect(box(b, 'r').resultChars).toBe(50)
  b = applySpawn(b, { agentId: 'r', description: 'Work', promptChars: 1, resumed: true }, T0 + 3)
  b = applyComplete(b, 'r', { reason: 'answer', answerChars: 20 }, T0 + 4)
  expect(box(b, 'r').resultChars).toBe(70)
  const n = applyComplete(applySpawn(emptyBoard(T0), { agentId: 'q', description: 'Work' }, T0), 'q', { reason: 'answer', answerChars: null }, T0 + 1)
  expect(box(n, 'q').resultChars).toBeNull()
})

test('applyBoardSent: counts calls and characters by task; negative characters add 0', () => {
  let b = applyBoardSent(emptyBoard(T0), 'a', 120)
  b = applyBoardSent(b, 'a', 120)
  expect(b.boardSent['a']).toEqual({ calls: 2, chars: 240 })
  b = applyBoardSent(b, 'a', -5)
  expect(b.boardSent['a']).toEqual({ calls: 3, chars: 240 })
  expect(applyBoardSent(emptyBoard(T0), '', 7).boardSent['']).toEqual({ calls: 1, chars: 7 })
})

test('spawnCheck with Opus off: the opus worker runs on sonnet; a model parameter must be sonnet', () => {
  const b = gateBoard()
  expect(spawnCheck(b, opusReq({ models: OPUS_OFF }))).toBeNull()
  expect(spawnCheck(b, opusReq({ models: OPUS_OFF, model: 'sonnet' }))).toBeNull()
  const text = spawnCheck(b, opusReq({ models: OPUS_OFF, model: 'opus' }))
  expect(text).toBe(
    'Spawn refused (policy §1): the opus worker runs on sonnet (Opus is switched off in the Flowestra settings); do not pass model "opus".',
  )
  expect(text).toBe(denyModelOverride('opus', 'sonnet', 'opus'))
  // all on: byte-identical to 0.9
  expect(denyModelOverride('opus', 'opus', 'sonnet')).toBe('Spawn refused (policy §1): the opus worker runs on opus; do not pass model "sonnet".')
  expect(spawnCheck(b, opusReq({ model: 'sonnet' }))).toBe(denyModelOverride('opus', 'opus', 'sonnet'))
  expect(spawnCheck(b, opusReq({ models: ALL_ON }))).toBeNull()
})

test('spawnCheck with Opus off: another agent type must name the model the tier runs on', () => {
  const b = gateBoard()
  const other = (over: Partial<SpawnRequest>) => ({ subagentType: 'my-agent', workerTier: null, name: 'O', ...over }) as SpawnRequest
  expect(spawnCheck(b, other({ models: OPUS_OFF, model: 'sonnet' }))).toBeNull()
  expect(spawnCheck(b, other({ models: OPUS_OFF, model: 'opus' }))).toBe(denyNoModel('O', 'opus', 'sonnet'))
  expect(denyNoModel('O', 'opus', 'sonnet')).toBe(
    'Spawn refused (policy §1): unit "O" is routed to opus; an agent type other than the tier workers must name model "sonnet" in the call.',
  )
  expect(spawnCheck(b, other({ model: 'opus' }))).toBeNull()
  expect(spawnCheck(b, other({}))).toBe(denyNoModel('O', 'opus', 'opus'))
})

test('spawnCheck: no worker model on for the tier is refused with denyUnavailable', () => {
  const b = gateBoard()
  const opusText =
    'Spawn refused: unit "O" is routed to opus, and no worker model is on for opus-tier work (the Flowestra settings switch off Opus and Sonnet). Do that work yourself, or ask the user to turn a worker model back on in /config.'
  const models: WorkerModels = { opus: null, sonnet: null, haiku: 'haiku' }
  expect(spawnCheck(b, opusReq({ models }))).toBe(opusText)
  expect(denyUnavailable('O', 'opus', models)).toBe(opusText)
  const sonnetText =
    'Spawn refused: unit "S" is routed to sonnet, and no worker model is on for sonnet-tier work (the Flowestra settings switch off Opus and Sonnet). Do that work yourself, or ask the user to turn a worker model back on in /config.'
  expect(spawnCheck(b, sonnetReq({ name: 'S', models }))).toBe(sonnetText)
  expect(denyUnavailable('H', 'haiku', NONE_ON)).toContain('(the Flowestra settings switch off Opus, Sonnet and Haiku)')
  // before the worker-tier check: the wrong worker for an unavailable tier gets the unavailable text
  expect(spawnCheck(b, sonnetReq({ name: 'O', models }))).toBe(opusText)
  // a unit of a tier that is available is unaffected
  expect(spawnCheck(b, req({ name: 'H', models }))).toBeNull()
})

test('spawnCheck: the retry count is by runTier, so a substituted run counts at the tier of the work', () => {
  const b0 = gateBoard()
  const a = routedBox('a', 'O', 'claude-opus-5-5', { tier: 'opus', kind: 'design', audit: AUDIT })
  const c = routedBox('c', 'O', 'claude-sonnet-5-5', { tier: 'opus', kind: 'design', audit: AUDIT, ranOn: 'sonnet' })
  const b = { ...b0, ...withAgents(b0, a, c) }
  expect(spawnCheck(b, opusReq({ models: OPUS_OFF }))).toBe(denyRetry('O', 'opus'))
  const one = { ...b0, ...withAgents(b0, c) }
  expect(spawnCheck(one, opusReq({ models: OPUS_OFF }))).toBeNull()
})

test('spawnCheck: a haiku unit of a kind haiku no longer takes is refused with denyKind', () => {
  const b0 = { ...gateBoard(), units: [tiered('HE', 'haiku', { kind: 'edit' })] }
  const text = spawnCheck(b0, req({ name: 'HE' }))
  expect(text).toBe(
    'Spawn refused (policy §3): unit "HE" is a haiku unit of kind edit, which haiku no longer takes (haiku takes locate, extract, inventory). Re-route it to a higher tier under a new unit.',
  )
  expect(text).toBe(denyKind('HE', 'haiku', 'edit'))
  // after the retry check, before the spec check
  const spec = { ...b0, units: [tiered('HE', 'haiku', { kind: 'edit', spec: 'x.md' })] }
  expect(spawnCheck(spec, req({ name: 'HE', specMissing: true }))).toBe(denyKind('HE', 'haiku', 'edit'))
  expect(spawnCheck(gateBoard(), req({ name: 'H' }))).toBeNull()
})

test('runTier: a substituted run is the tier of its work; a wrong model keeps the measured tier', () => {
  const b = emptyBoard(T0)
  const sub = routedBox('a', 'O', 'claude-sonnet-5-5', { tier: 'opus', kind: 'design', audit: AUDIT, ranOn: 'sonnet' })
  expect(runTier(b, sub)).toBe('opus')
  const wrong = routedBox('b', 'S', HAIKU, { tier: 'sonnet', kind: 'implement', audit: AUDIT })
  expect(runTier(b, wrong)).toBe('haiku')
  const wrong2 = routedBox('c', 'O', HAIKU, { tier: 'opus', kind: 'design', audit: AUDIT, ranOn: 'sonnet' })
  expect(runTier(b, wrong2)).toBe('haiku')
  expect(runTier(b, routedBox('d', 'O', null, { tier: 'opus', kind: 'design', audit: AUDIT, ranOn: 'sonnet' }))).toBe('opus')
  expect(runTier(b, { ...mk(MAIN_ID, 'running'), model: SONNET })).toBeNull()
})

test('auditIssue: a substituted run is not a mismatch; a wrong model is', () => {
  const b = emptyBoard(T0)
  const sub = routedBox('a', 'O', SONNET, { tier: 'opus', kind: 'design', audit: AUDIT, ranOn: 'sonnet' })
  expect(auditIssue(b, sub)).toBe('none')
  const wrong = routedBox('b', 'O', HAIKU, { tier: 'opus', kind: 'design', audit: AUDIT, ranOn: 'sonnet' })
  expect(auditIssue(b, wrong)).toBe('tier-mismatch')
  const plain = routedBox('c', 'O', SONNET, { tier: 'opus', kind: 'design', audit: AUDIT })
  expect(auditIssue(b, plain)).toBe('tier-mismatch')
})

test('rowOf: a haiku-tier box that ran on Sonnet is in the leads row', () => {
  const b = emptyBoard(T0)
  const x = routedBox('a', 'H', SONNET, { tier: 'haiku', kind: 'locate', audit: AUDIT, ranOn: 'sonnet' })
  expect(rowOf(b, x)).toBe('leads')
  expect(rowOf(b, routedBox('b', 'S', SONNET, { tier: 'sonnet', kind: 'implement', audit: AUDIT }))).toBe('workers')
})

test('applySpawn records ranOn from the models; a resumed spawn keeps the old routed', () => {
  const b0 = { ...gateBoard(), taskId: null }
  const spawnWith = (board: Board, agentId: string, name: string, models?: WorkerModels, resumed?: boolean) =>
    applySpawn(board, { agentId, description: 'x', subagentType: 'flowestra:opus-worker', model: SONNET, name, models, resumed }, T0)
  const o = spawnWith(b0, 'a1', 'O', OPUS_OFF)
  expect(box(o, 'a1').routed?.ranOn).toBe('sonnet')
  const h = spawnWith(b0, 'a2', 'H', { opus: 'opus', sonnet: 'opus', haiku: 'sonnet' })
  expect(box(h, 'a2').routed?.ranOn).toBe('sonnet')
  const hh = spawnWith(b0, 'a3', 'H', { opus: 'sonnet', sonnet: 'sonnet', haiku: 'sonnet' })
  expect(box(hh, 'a3').routed?.ranOn).toBe('sonnet')
  expect(box(spawnWith(b0, 'a4', 'H'), 'a4').routed?.ranOn).toBe('haiku')
  // Opus-off and Sonnet-off: a haiku unit stays haiku
  expect(box(spawnWith(b0, 'a5', 'H', OPUS_SONNET_OFF), 'a5').routed?.ranOn).toBe('haiku')
  // resumed: keeps the old routed and its ranOn, whatever the models now are
  const again = spawnWith(o, 'a1', 'O', ALL_ON, true)
  expect(box(again, 'a1').routed).toEqual(box(o, 'a1').routed)
  expect(box(again, 'a1').routed?.ranOn).toBe('sonnet')
})

// ---- 0.11.0: nested spawns gated, resumes re-checked, workflow agents marked, boardFreeCheck ----

const NESTED_TEXT_TAIL =
  'Only the orchestrator declares units: finish your own task, and say in your answer what further work needs a worker.'

test('spawnCheck: a nested spawn is held to a covering unit with its own refusal texts', () => {
  const b = gateBoard()
  expect(denyNested('n')).toBe(
    `Spawn refused (policy §9): an agent started by another agent must carry out a unit the orchestrator declared, and no unit "n" with a tier, a kind and an audit line is declared. ${NESTED_TEXT_TAIL}`,
  )
  expect(denyNested(null)).toBe(
    `Spawn refused (policy §9): an agent started by another agent must carry out a unit the orchestrator declared, and this call has no name and its description matches no unit's label. ${NESTED_TEXT_TAIL}`,
  )
  expect(denyBuiltinNested('Explore')).toBe(
    'Spawn refused (policy §1): the built-in type "Explore" is not used under the Model Routing Policy, and only the orchestrator delegates. Finish your own task, and say in your answer what further work needs a worker.',
  )
  expect(spawnCheck(b, req({ name: 'n', nested: true }))).toBe(denyNested('n'))
  expect(spawnCheck(b, req({ nested: true, description: 'Nothing matches this' }))).toBe(denyNested(null))
  expect(spawnCheck(b, req({ name: '', nested: true }))).toBe(denyNested(null))
  // no parked hint for a nested spawn; a unit with no audit line is not covering
  expect(spawnCheck(b, req({ name: 'NA', nested: true }))).toBe(denyNested('NA'))
  expect(spawnCheck(b, { subagentType: 'Explore', workerTier: null, nested: true })).toBe(denyBuiltinNested('Explore'))
  expect(spawnCheck(b, { subagentType: 'general-purpose', workerTier: null, name: 'H', nested: true })).toBe(denyBuiltinNested('general-purpose'))
  // a nested tier worker named for a covering unit with the right model passes, and the later checks run
  expect(spawnCheck(b, req({ name: 'H', nested: true }))).toBeNull()
  expect(spawnCheck(b, req({ name: 'H', nested: true, model: 'opus' }))).toBe(denyModelOverride('haiku', 'haiku', 'opus'))
  expect(spawnCheck(b, req({ name: 'R', nested: true, subagentType: 'flowestra:sonnet-worker', workerTier: 'sonnet' }))).toBe(denyRejected('R', 'implement'))
  // the main-loop text is unchanged
  expect(spawnCheck(b, req({ name: 'n' }))).toBe(denyUndeclared('n'))
  expect(spawnCheck(b, { subagentType: 'Explore', workerTier: null })).toBe(denyBuiltin('Explore'))
})

test('spawnCheck: a workflow agent passes even with a refused built-in type, a nested fork is refused', () => {
  const b = gateBoard()
  expect(spawnCheck(b, { subagentType: 'Explore', workerTier: null, workflow: true })).toBeNull()
  expect(spawnCheck(b, { subagentType: 'Explore', workerTier: null, workflow: true, nested: true })).toBeNull()
  expect(spawnCheck(b, { subagentType: 'Explore', workerTier: null, fork: true, nested: true })).toBe(denyFork())
})

const resumeBoard = (extra: Partial<AgentBox> = {}, units: Unit[] = [tiered('O1', 'opus', { kind: 'design' })], tier: Tier = 'opus'): Board => {
  const b = onBoard(units)
  const x: AgentBox = {
    ...mk('w1', 'done', T0, 'O1'),
    model: tier === 'opus' ? OPUS : tier === 'sonnet' ? SONNET : HAIKU,
    routed: { tier, kind: units[0]!.kind ?? 'locate', audit: auditFor(tier) },
    ...extra,
  }
  return { ...b, ...withAgents(b, x) }
}

test('resumeCheck and spawnCheck: a resume of an unknown or unrouted agent passes', () => {
  const b = resumeBoard()
  expect(spawnCheck(b, req({ resume: true, resumeOf: 'nobody' }))).toBeNull()
  expect(spawnCheck(b, req({ resume: true }))).toBeNull()
  expect(spawnCheck(b, req({ resume: true, resumeOf: null }))).toBeNull()
  const unrouted = resumeBoard({ routed: null, unitId: 'O1' }, [tiered('O1', 'opus', { kind: 'design', verdict: 'rejected' })])
  expect(spawnCheck(unrouted, req({ resume: true, resumeOf: 'w1' }))).toBeNull()
  expect(resumeCheck(unrouted, { resumeOf: 'w1' })).toBeNull()
})

test('resumeCheck: a rejected unit, a barred kind, a switched model and an unavailable tier', () => {
  expect(denyResumeRejected('s1')).toBe('Spawn refused (policy §8): unit "s1" was rejected, so its worker is not resumed. Re-route the task upward under a new unit.')
  const rejected = resumeBoard({}, [tiered('O1', 'opus', { kind: 'design', verdict: 'rejected' })])
  expect(spawnCheck(rejected, req({ resume: true, resumeOf: 'w1' }))).toBe(denyResumeRejected('O1'))
  // the unit missing from the list: the box's label stands in for the id when it has no unit link
  const noUnit = resumeBoard({ unitId: null, label: 'Fix it' })
  expect(resumeCheck(noUnit, { resumeOf: 'w1', models: { opus: 'sonnet', sonnet: 'sonnet', haiku: 'haiku' } })).toBe(
    denyResumeSwitched('Fix it', 'opus', 'opus', 'sonnet'),
  )
  // a bar on (tier, kind) since it started
  const sonnetUnits = [tiered('S1', 'sonnet', { kind: 'review' })]
  const barredB: Board = {
    ...resumeBoard({ unitId: 'S1' }, sonnetUnits, 'sonnet'),
    rejects: [
      { unitId: 'x1', tier: 'sonnet', kind: 'review', taskId: null },
      { unitId: 'x2', tier: 'sonnet', kind: 'review', taskId: null },
    ] as unknown as Board['rejects'],
  }
  expect(barred(barredB)).toEqual([{ tier: 'sonnet', kind: 'review', n: 2 }])
  expect(spawnCheck(barredB, req({ resume: true, resumeOf: 'w1' }))).toBe(denyBarred('sonnet', 'review', 2))
  // writing at sonnet is never barred: a resume after two implement rejects passes
  const writerB: Board = {
    ...resumeBoard({ unitId: 'S1' }, [tiered('S1', 'sonnet', { kind: 'implement' })], 'sonnet'),
    rejects: [rej('x1', 'sonnet', 'implement'), rej('x2', 'sonnet', 'implement')],
  }
  expect(spawnCheck(writerB, req({ resume: true, resumeOf: 'w1' }))).toBeNull()
  // an opus writer started before 0.17.0 is not resumed
  const opusWriter = resumeBoard({ unitId: 'O1' }, [tiered('O1', 'opus', { kind: 'implement' })], 'opus')
  expect(spawnCheck(opusWriter, req({ resume: true, resumeOf: 'w1' }))).toBe(denyOpusWriter('O1', 'implement', ALL_ON))
  expect(resumeCheck(opusWriter, { resumeOf: 'w1' })).toBe(denyOpusWriter('O1', 'implement', ALL_ON))
  // a rejected writing unit's resume carries the writing wording
  expect(denyResumeRejected('s1', 'implement')).toBe('Spawn refused (policy §8): unit "s1" was rejected, so its worker is not resumed. Tighten the spec and retry it once at sonnet under a new unit; if that one fails too, ask the user.')
  expect(denyResumeRejected('s1', 'review')).toBe(denyResumeRejected('s1'))
  // Opus switched off: the box on an Opus model, routed opus
  const o = resumeBoard()
  const opusOff: WorkerModels = { opus: 'sonnet', sonnet: 'sonnet', haiku: 'haiku' }
  expect(denyResumeSwitched('O1', 'opus', 'opus', 'sonnet')).toBe(
    'Spawn refused: the worker of unit "O1" runs on Opus, but opus-tier work now runs on Sonnet (the Flowestra settings changed since it started). Spawn flowestra:opus-worker again for the unit, or re-route it.',
  )
  expect(spawnCheck(o, req({ resume: true, resumeOf: 'w1', models: opusOff }))).toBe(denyResumeSwitched('O1', 'opus', 'opus', 'sonnet'))
  // Opus and Sonnet off: no model for the tier
  const noOpus: WorkerModels = { opus: null, sonnet: null, haiku: 'haiku' }
  expect(denyResumeUnavailable('O1', 'opus', noOpus)).toBe(
    'Spawn refused: the worker of unit "O1" is not resumed: no worker model is on for opus-tier work now (the Flowestra settings switch off Opus and Sonnet). Do that work yourself, or ask the user to turn a worker model back on in /config.',
  )
  expect(spawnCheck(o, req({ resume: true, resumeOf: 'w1', models: noOpus }))).toBe(denyResumeUnavailable('O1', 'opus', noOpus))
  // on its tier's model (all on, absent models, a model outside the tiers): passes, and no box is added
  const before = JSON.stringify(o)
  expect(spawnCheck(o, req({ resume: true, resumeOf: 'w1' }))).toBeNull()
  expect(spawnCheck(o, req({ resume: true, resumeOf: 'w1', models: ALL_ON }))).toBeNull()
  expect(resumeCheck({ ...o, agents: { w1: { ...o.agents['w1']!, model: 'claude-x' } } }, { resumeOf: 'w1', models: opusOff })).toBeNull()
  expect(JSON.stringify(o)).toBe(before)
  expect(Object.keys(o.agents)).toEqual(['w1'])
  // not counted as a run: a unit that already ran twice at its tier still resumes
  const twice = resumeBoard({}, [tiered('O1', 'opus', { kind: 'design' })])
  const more = { ...twice, ...withAgents(twice, { ...mk('w2', 'done', T0, 'O1'), model: OPUS }, { ...mk('w3', 'done', T0, 'O1'), model: OPUS }) }
  expect(spawnCheck(more, req({ resume: true, resumeOf: 'w1' }))).toBeNull()
})

test('boardFreeCheck: the refusals that need no board, and each is also refused by spawnCheck whatever the board holds', () => {
  expect(denyUnavailableWorker('opus', { opus: null, sonnet: null, haiku: 'haiku' })).toBe(
    'Spawn refused: no worker model is on for opus-tier work (the Flowestra settings switch off Opus and Sonnet). Do that work yourself, or ask the user to turn a worker model back on in /config.',
  )
  const opusOff: WorkerModels = { opus: 'sonnet', sonnet: 'sonnet', haiku: 'haiku' }
  const noOpus: WorkerModels = { opus: null, sonnet: null, haiku: 'haiku' }
  const opusReq = (over: Partial<SpawnRequest> = {}) => req({ subagentType: 'flowestra:opus-worker', workerTier: 'opus', ...over })
  const cases: Array<[SpawnRequest, string | null]> = [
    [req({ fork: true }), denyFork()],
    [req({ fork: true, nested: true }), denyFork()],
    [{ subagentType: 'statusline-setup', workerTier: null }, null],
    [{ subagentType: 'Explore', workerTier: null }, denyBuiltin('Explore')],
    [{ subagentType: 'Plan', workerTier: null, nested: true }, denyBuiltinNested('Plan')],
    [opusReq({ model: 'opus', models: opusOff }), denyModelOverride('opus', 'sonnet', 'opus')],
    [opusReq({ model: 'haiku' }), denyModelOverride('opus', 'opus', 'haiku')],
    [opusReq({ models: noOpus }), denyUnavailableWorker('opus', noOpus)],
    [opusReq({ model: 'opus', models: noOpus }), denyUnavailableWorker('opus', noOpus)],
    // nothing to refuse without the board
    [opusReq({ model: 'opus' }), null],
    [opusReq({ model: 'sonnet', models: opusOff }), null],
    [opusReq({ name: 'nope' }), null],
    [{ subagentType: 'my:agent', workerTier: null, model: 'opus' }, null],
    [req({ name: 'R' }), null],
    // a workflow agent and a resume are not this check's
    [{ subagentType: 'Explore', workerTier: null, workflow: true }, null],
    [{ subagentType: 'Explore', workerTier: null, resume: true }, null],
  ]
  const withUnit: Board = { ...emptyBoard(T0), units: [tiered('O', 'opus', { kind: 'design' }), tiered('H')] }
  const boards = [emptyBoard(T0), gateBoard(), withUnit]
  for (const [r, want] of cases) {
    expect(boardFreeCheck(r)).toBe(want)
    if (want === null) continue
    // containment: the full gate refuses it too, on an empty board and on a board with a covering unit
    for (const b of boards) expect(spawnCheck(b, r)).not.toBeNull()
    expect(spawnCheck(withUnit, { ...r, name: r.workerTier === 'opus' ? 'O' : 'H' })).not.toBeNull()
  }
})

test('applySpawn with an ungated mark: no link to a unit even for a name equal to a unit id, and the mark is kept', () => {
  const b0 = up(emptyBoard(T0), { taskId: 't1', units: [tiered('H1', 'haiku', { kind: 'locate' }), labelled(tiered('L1'), 'Find call sites')] })
  const info = { agentId: 'w1', description: 'Find call sites', subagentType: 'workflow-subagent', model: HAIKU }
  const linkedByName = applySpawn(b0, { ...info, name: 'H1', ungated: { why: 'workflow', run: 'wf_1' } }, T0)
  expect(box(linkedByName, 'w1').unitId).toBeNull()
  expect(box(linkedByName, 'w1').routed).toBeNull()
  expect(box(linkedByName, 'w1').ungated).toEqual({ why: 'workflow', run: 'wf_1' })
  // by label with no name
  const byLabel = applySpawn(b0, { ...info, ungated: { why: 'workflow', run: 'wf_1' } }, T0)
  expect(box(byLabel, 'w1').unitId).toBeNull()
  expect(box(byLabel, 'w1').routed).toBeNull()
  expect(auditIssue(byLabel, box(byLabel, 'w1'))).toBe('ungated')
  // the same spawn without the mark links, routes and carries no mark
  const gated = applySpawn(b0, { ...info, name: 'H1' }, T0)
  expect(box(gated, 'w1').unitId).toBe('H1')
  expect(box(gated, 'w1').routed?.tier).toBe('haiku')
  expect(box(gated, 'w1').ungated).toBeNull()
  expect(auditIssue(gated, box(gated, 'w1'))).toBe('none')
})

test('applySpawn without a mark sets ungated null over an unseen placeholder', () => {
  let b = applyTurnStart(emptyBoard(T0), 'w1', T0)
  expect(box(b, 'w1').ungated).toEqual({ why: 'unseen' })
  b = applySpawn(b, { agentId: 'w1', description: 'Do the work', subagentType: 'flowestra:sonnet-worker', model: SONNET }, T0 + 1)
  expect(box(b, 'w1').ungated).toBeNull()
  expect(ungatedOf(box(b, 'w1'))).toBeNull()
})

test('a box made only by a step, a turn start, a tool call or reconcile is marked unseen; the main box is not', () => {
  const unseen = { why: 'unseen' }
  expect(box(applyStep(emptyBoard(T0), 'old1', usage(1, 2, 3, 4), T0), 'old1').ungated).toEqual(unseen)
  expect(box(applyTurnStart(emptyBoard(T0), 'old2', T0), 'old2').ungated).toEqual(unseen)
  expect(box(applyToolCall(emptyBoard(T0), 'old3', 'Read', T0), 'old3').ungated).toEqual(unseen)
  expect(box(applyComplete(emptyBoard(T0), 'old4', { reason: 'answer' }, T0), 'old4').ungated).toEqual(unseen)
  const listed = reconcile(emptyBoard(T0), [{ id: 'l1', description: 'A forked skill', type: 'general-purpose', status: 'running' }], T0)
  expect(box(listed, 'l1').ungated).toEqual(unseen)
  expect(auditIssue(listed, box(listed, 'l1'))).toBe('ungated')
  // an existing box is not re-marked by reconcile or a later event
  const known = applySpawn(emptyBoard(T0), { agentId: 'k', description: 'Do it', subagentType: 'flowestra:haiku-worker', model: HAIKU }, T0)
  expect(box(reconcile(known, [{ id: 'k', description: 'Do it', type: 'flowestra:haiku-worker', status: 'running' }], T0 + 1), 'k').ungated).toBeNull()
  expect(box(applyStep(known, 'k', usage(1, 1, 1, 1), T0 + 1), 'k').ungated).toBeNull()
  // the main box carries no mark
  for (const b of [applyTurnStart(emptyBoard(T0), undefined, T0), applyStep(emptyBoard(T0), undefined, null, T0), applyToolCall(emptyBoard(T0), undefined, 'Read', T0)]) {
    expect(box(b, MAIN_ID).ungated).toBeUndefined()
    expect(auditIssue(b, box(b, MAIN_ID))).toBe('none')
  }
})

test('auditIssue: a marked box is ungated, read before routed; an unmarked or absent mark reads as before', () => {
  const b = onBoard([tiered('H')])
  const routedHaiku = { tier: 'haiku' as const, kind: 'locate' as const, audit: auditFor('haiku') }
  const x = { ...withModel(mk('x', 'running', null, 'H'), HAIKU), routed: routedHaiku }
  expect(auditIssue(b, x)).toBe('none')
  expect(auditIssue(b, { ...x, ungated: null })).toBe('none')
  expect(auditIssue(b, { ...x, ungated: { why: 'exempt' } })).toBe('ungated')
  expect(auditIssue(b, { ...mk('y', 'running'), ungated: { why: 'resumed' } })).toBe('ungated')
  expect(auditIssue(b, mk('y', 'running'))).toBe('no-audit')
  expect(ungatedOf({ ...x, ungated: { why: 'workflow', run: 'wf_1' } })).toEqual({ why: 'workflow', run: 'wf_1' })
  expect(ungatedOf(x)).toBeNull()
})

const marked = (b: AgentBox, why: 'workflow' | 'resumed' | 'nested' | 'exempt' | 'unseen'): AgentBox => ({
  ...b,
  ungated: why === 'workflow' ? { why, run: 'wf_1' } : { why },
})

test('a box the gate let through without a unit is never linked by applyUnits; an unseen one is', () => {
  const units = [labelled(unit('s1'), 'Do s1')]
  for (const why of ['workflow', 'resumed', 'nested', 'exempt'] as const) {
    const byLabel = marked({ ...mk('a', 'running'), label: 'Do s1' }, why)
    const after = up(withBoxes(byLabel), { units })
    expect(box(after, 'a').unitId).toBeNull()
    const byName = marked({ ...mk('b', 'running'), name: 's1' }, why)
    expect(box(up(withBoxes(byName), { units }), 'b').unitId).toBeNull()
  }
  const unseen = marked({ ...mk('c', 'running'), label: 'Do s1' }, 'unseen')
  expect(box(up(withBoxes(unseen), { units }), 'c').unitId).toBe('s1')
  const unseenByName = marked({ ...mk('d', 'running'), name: 's1' }, 'unseen')
  expect(box(up(withBoxes(unseenByName), { units }), 'd').unitId).toBe('s1')
})

test('reconcile does not link an existing workflow-marked box to a unit; it links an unseen one', () => {
  const b0: Board = { ...withBoxes(marked({ ...mk('w', 'running'), label: 'Do s1' }, 'workflow'), marked({ ...mk('u', 'running'), label: 'Do s1' }, 'unseen')), units: [labelled(unit('s1'), 'Do s1')] }
  const after = reconcile(
    b0,
    [
      { id: 'w', description: 'Do s1', type: 'general-purpose', status: 'running', name: 's1' },
      { id: 'u', description: 'Do s1', type: 'general-purpose', status: 'running', name: 's1' },
    ],
    T0 + 1,
  )
  expect(box(after, 'w').unitId).toBeNull()
  expect(box(after, 'u').unitId).toBe('s1')
  for (const why of ['resumed', 'nested', 'exempt'] as const) {
    const b1: Board = { ...withBoxes(marked(mk('x', 'running'), why)), units: [unit('s1')] }
    const r = reconcile(b1, [{ id: 'x', description: 'd', type: 't', status: 'running', name: 's1' }], T0 + 1)
    expect(box(r, 'x').unitId).toBeNull()
  }
})

test('a workflow box of a unit\'s label does not count as a run of that unit for the retry rule', () => {
  const b = gateBoard()
  const real = withModel(mk('a1', 'done', T0, 'H'), HAIKU)
  const wf = marked({ ...withModel(mk('wf', 'done', T0), HAIKU), label: 'Find call sites' }, 'workflow')
  const board: Board = { ...b, ...withAgents(b, real, wf) }
  const after = up(board, { units: board.units })
  expect(box(after, 'wf').unitId).toBeNull()
  const second: Board = { ...after, ...withAgents(after, withModel(mk('a2', 'done', T0, 'H'), HAIKU)) }
  // two real runs would refuse; one real run plus the workflow box does not
  expect(spawnCheck(after, req({ name: 'H' }))).toBeNull()
  expect(spawnCheck(second, req({ name: 'H' }))).toBe(denyRetry('H', 'haiku'))
})
