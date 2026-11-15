import { expect, mock, test } from 'claude-code/testing'

import type { AgentBox, Board, Detail, FlowProps, Live, Log, RowCard, Tier, Ui } from '../types'
import { BOARD_PROMPT_SECTION, BOARD_TOOL_FULL_NAME, POLICY_SECTION_ID } from './board'
import {
  REFUSED_BUILTINS,
  denyBarred,
  denyContext,
  denyFork,
  denyBuiltin,
  denyModelOverride,
  denyNoModel,
  denyRejected,
  denyRetry,
  denySpec,
  denyUndeclared,
  denyWrongWorker,
} from './state'
import { WORKER_NAMES, workerType } from './workers'
import { entryFromText } from './register'
import { buildEntry, entryName, isoOf, parseStateJson, phaseIndexLine, repoKey, shardLine, stateJson } from './journal'

// Every hook here sits beneath the plugin and stands for the engine: a call on
// `$` is answered `{ value }`, an event by its own result. The plugin under
// test (register.tsx) runs above them, as in a session.
//
// A test's `$` has no `state` noun, so what the plugin stores is read by a
// `state.set` hook beneath it that records each write ({ shape, value }) on
// its way to the kit's own store. The same hook can make every write fail.
// Two kit facts this file works with: hooks beneath are registered before the
// test's first `$` call, and a `turn.step` stream's return value is read from
// the generator's last `next()` (the stream's `result` settles undefined here).
//
// The spawn gate (Model Routing Policy) refuses every Agent call no declared
// unit covers, so a generic test's worker is spawned by `work`: it declares a
// sonnet unit (tier, kind, four-part audit) for it, then spawns the sonnet
// worker named after that unit. The engine answers a spawn with the model the
// call asks for (its `model`, else its tier worker type), Sonnet otherwise.
// The file system beneath (`fs.read`, `fs.write`, `fs.exists`) is a map of
// paths to texts; the session id and the environment are answered too.

const SURFACES = ['terminal', 'desktop'] as const
const T0 = 1_700_000_000_000
const HOME = '/home/tester'
const SESSION = 'sess-1'
const AUDIT_FILE = `${HOME}/.claude/flowestra/audit/${SESSION}.log`

type World = {
  panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[]
  placeOnOpen: boolean
  opens: number
  list: { id: string; description: string; type: string; status: string; name?: string; parentId?: string }[]
  usd: number | null
  listCalls: number
  board: Board | null
  live: Live | null
  detail: Detail | null
  ui: Ui | null
  log: Log | null
  liveWrites: number
  animWrites: number // writes under the retired `anim` key: must stay 0
  failWrites: boolean
  failLogWrites: boolean // only writes under `log` fail
  spawnCalls: number // spawns that reached the engine
  spawnModel: string | null // what a spawn runs on; null: what the call asks for
  corruptBoard: boolean // reads of `board` answer a board with no units or rejects lists
  reads: string[] // the keys read, in order
  boardGate: Promise<void> | null // the next board write waits for this, then the gate is gone
  units: Record<string, unknown>[] // every unit declared through `declare`, in order
  registered: string[] // the agent types registered, by name
  files: Record<string, string> // the file system beneath: path → text
  fsWrites: { path: string; text: string }[]
  failFsWrite: boolean // fs.write fails
  failExists: boolean // fs.exists fails
  env: Record<string, string>
  mtimes: Record<string, number> // path → the write's mtime (a counter, so every write is newer)
  root: string // what $.session.root() answers
  repo: string | null // $.session.repo()'s root; null: not in a repository
  failJournal: boolean // fs.write fails for every path under the journal
  spawned: any[] // every agent.spawn input that reached the engine
  ghosts: string[] // paths fs.exists says are there, though fs.read cannot read them
}

const SONNET = 'claude-sonnet-5-5'
const HAIKU = 'claude-haiku-4-5-20251001'
const OPUS = 'claude-opus-5-5'
const MODEL_OF: Record<Tier, string> = { haiku: HAIKU, sonnet: SONNET, opus: OPUS }

/** The model a spawn runs on: the tier its `model` names, else its tier worker type's, else Sonnet. */
function modelFor(e: any): string {
  const asked = typeof e.model === 'string' ? e.model.toLowerCase() : ''
  for (const t of ['haiku', 'sonnet', 'opus'] as const) if (asked.includes(t)) return MODEL_OF[t]
  for (const t of ['haiku', 'sonnet', 'opus'] as const) if (e.subagentType === workerType(t)) return MODEL_OF[t]
  return SONNET
}

/** The engine beneath the plugin: clock, panes, agent list, usage, registrations, files. */
let mtime = 0

function engine(on: any, w: World) {
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, w.env)
  on('state.set', async (_: any, e: any, next: any) => {
    if (w.failWrites) throw new Error('store is down')
    if (w.failLogWrites && e.key === 'log') throw new Error('log store is down')
    if (w.boardGate !== null && e.key === 'board') {
      const gate = w.boardGate
      w.boardGate = null
      await gate
    }
    const r = await next(e)
    if (r?.value?.isSet) {
      if (e.key === 'board') w.board = e.value.value
      if (e.key === 'live') {
        w.live = e.value.value
        w.liveWrites += 1
      }
      if (e.key === 'detail') w.detail = e.value.value
      if (e.key === 'ui') w.ui = e.value.value
      if (e.key === 'log') w.log = e.value.value
    }
    if (e.key === 'anim') w.animWrites += 1
    return r
  })
  on('state.get', async (_: any, e: any, next: any) => {
    w.reads.push(e.key)
    // a hook that throws is skipped by the kit, so a failing read cannot be staged:
    // a stored board of the right shape with no units list makes the plugin's check throw instead
    if (w.corruptBoard && e.key === 'board') {
      return { value: { value: { shape: 'board-5', value: { taskId: null, repo: null, task: null, phase: null, wave: null, units: null, agents: {}, order: [], loadedAt: T0, note: null, rejects: null, parked: null, closed: null, activeAt: T0 } }, version: 99 } }
    }
    return next(e)
  })
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__flowestra__${e.name}` } }))
  on('agent.register', (_: any, e: any) => {
    w.registered.push(e.name)
    return { value: { agent: `flowestra:${e.name}` } }
  })
  on('agent.offer', () => ({ isOffered: true }))
  on('agent.list', () => {
    w.listCalls += 1
    return { value: w.list }
  })
  on('session.usage', () => ({
    value: { startedAt: T0, context: { window: 200_000 }, rateLimits: [], ...(w.usd === null ? {} : { cost: { usd: w.usd } }) },
  }))
  on('session.id', () => ({ value: SESSION }))
  on('fs.read', (_: any, e: any) => {
    if (!(e.path in w.files)) throw new Error(`ENOENT: ${e.path}`)
    return { value: w.files[e.path] }
  })
  on('fs.write', (_: any, e: any) => {
    if (w.failFsWrite) throw new Error('disk is full')
    if (w.failJournal && e.path.includes('/flowestra/journal')) throw new Error('journal disk is full')
    w.files[e.path] = e.text
    w.mtimes[e.path] = ++mtime
    w.fsWrites.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('fs.list', (_: any, e: any) => {
    const dir = String(e.path).replace(/\/+$/, '')
    const out = new Map<string, any>()
    for (const path of Object.keys(w.files)) {
      if (!path.startsWith(`${dir}/`)) continue
      const rest = path.slice(dir.length + 1)
      const name = rest.split('/')[0]!
      const isDir = rest.includes('/')
      out.set(name, { name, kind: isDir ? 'dir' : 'file', size: isDir ? 0 : w.files[path]!.length, mtimeMs: isDir ? 0 : (w.mtimes[path] ?? 0), isLink: false })
    }
    if (out.size === 0) throw new Error(`ENOENT: ${dir}`)
    return { value: [...out.values()] }
  })
  on('session.root', () => ({ value: w.root }))
  on('session.repo', () => ({ value: w.repo === null ? null : { root: w.repo, remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: w.root }))
  on('fs.exists', (_: any, e: any) => {
    if (w.failExists) throw new Error('fs is down')
    return { value: e.path in w.files || w.ghosts.includes(e.path) }
  })
  on('ui.panes', () => ({ value: w.panes }))
  on('ui.open', (_: any, e: any) => {
    w.opens += 1
    if (!w.panes.some(p => p.id === e.id)) {
      w.panes.push({ id: e.id, title: e.title ?? e.id, isShown: w.placeOnOpen, isFocused: false, isPlaced: w.placeOnOpen })
    }
    return { value: w.placeOnOpen ? { isPlaced: true } : { isPlaced: false, reason: 'unasked pane below 144 columns (now 100)' } }
  })
  on('ui.close', (_: any, e: any) => {
    w.panes = w.panes.filter(p => p.id !== e.id)
    return { value: undefined }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', (_: any, e: any) => ({ sessionId: e.sessionId }))
  on('agent.spawn', (_: any, e: any) => {
    w.spawnCalls += 1
    w.spawned.push(e)
    const model = w.spawnModel ?? modelFor(e)
    return { model, agentId: e.name === 'NOID' ? undefined : `agent-${e.description.split(' ')[0].toLowerCase()}` }
  })
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ran' }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  return clock
}

function world(over: Partial<World> = {}): World {
  return {
    panes: [], placeOnOpen: true, opens: 0, list: [], usd: null, listCalls: 0, board: null, live: null, detail: null, ui: null, log: null,
    liveWrites: 0, animWrites: 0, failWrites: false, failLogWrites: false, spawnCalls: 0, spawnModel: null, corruptBoard: false, reads: [],
    boardGate: null, units: [], registered: [], files: {}, fsWrites: [], failFsWrite: false, failExists: false, env: { HOME },
    mtimes: {}, root: '/work/main', repo: null, failJournal: false, spawned: [], ghosts: [],
    ...over,
  }
}

/** The writes to an audit file, in order (the journal writes beside them are left out). */
function auditWrites(w: World): { path: string; text: string }[] {
  return w.fsWrites.filter(x => x.path.includes('/flowestra/audit/'))
}

async function start($: any): Promise<void> {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

function boardOf(w: World): Board {
  if (!w.board) throw new Error('the plugin has stored no board')
  return w.board
}

function liveOf(w: World): Live {
  if (!w.live) throw new Error('the plugin has stored no live value')
  return w.live
}

function logOf(w: World): Log {
  return w.log ?? { entries: [] }
}

function detailOf(w: World): Detail {
  if (!w.detail) throw new Error('the plugin has stored no detail value')
  return w.detail
}

function boxOf(b: Board, id: string): AgentBox {
  const found = b.agents[id]
  if (!found) throw new Error(`no box ${id} in ${Object.keys(b.agents).join(', ')}`)
  return found
}

const usage = (i: number, o: number, r: number, w: number, model = 'claude-haiku-4-5-20251001') => ({
  input_tokens: i,
  output_tokens: o,
  cache_read_input_tokens: r,
  cache_creation_input_tokens: w,
  model,
})

/** Raises one turn.step whose result carries `usage`, and reads the stream to its end. */
async function step($: any, on: any, agentId: string | undefined, u: ReturnType<typeof usage> | null, index = 0) {
  const s = $.turn.step({ turnId: `t-${agentId ?? 'main'}`, index, model: 'claude-haiku-4-5-20251001', messageCount: 1, ...(agentId ? { agentId } : {}) })
  const chunks: unknown[] = []
  let it = await s.next()
  while (!it.done) {
    chunks.push(it.value)
    it = await s.next()
  }
  return { chunks, result: it.value as any }
}

function stepBottom(on: any, holder: { usage: ReturnType<typeof usage> | null }) {
  on('turn.step', async function* (_: any, e: any) {
    yield { kind: 'text', ref: 0, index: 0, text: 'hi' }
    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: holder.usage }
  })
}

/** An Agent call as the engine raises it: the sonnet worker unless `extra` says otherwise. */
async function spawn($: any, description: string, extra: Record<string, unknown> = {}) {
  return $.agent.spawn({
    tool_use_id: `tu-${description}`,
    prompt: 'x'.repeat(420),
    description,
    subagentType: workerType('sonnet'),
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    provider: { plugin: 'engine', tier: 'core' },
    ...extra,
  })
}

/** A valid four-part audit line naming `tier`. */
const AUDIT: Record<Tier, string> = {
  haiku: 'find the call sites | haiku | §1 step 2: targets and output pinned | the lead reads every hit',
  sonnet: 'write the module | sonnet | §1 step 3: one repo, written criteria | the tests the brief names',
  opus: 'design the gate | opus | §1 step 1: a §2 trigger | the lead reviews the draft',
}
const DEFAULT_KIND: Record<Tier, string> = { haiku: 'locate', sonnet: 'implement', opus: 'design' }

/** A unit a worker carries out, as the AgentBoard tool takes it: tier, kind and audit line. */
function unit(id: string, tier: Tier = 'sonnet', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, label: `Do ${id}`, wave: 1, tier, kind: DEFAULT_KIND[tier], audit: AUDIT[tier], ...extra }
}

/** Declares `units` through the tool: each replaces the unit of its id in the world's list, or joins it; the whole list is sent. */
async function declare($: any, w: World, units: Record<string, unknown>[], extra: Record<string, unknown> = {}): Promise<any> {
  for (const u of units) {
    const at = w.units.findIndex(x => x.id === u.id)
    if (at >= 0) w.units[at] = u
    else w.units.push(u)
  }
  return $.tool.call({ tool: BOARD_TOOL_FULL_NAME, units: w.units, ...extra } as any)
}

/** The unit id `work` declares for a description: `u-` and its first word. */
function workId(description: string): string {
  return `u-${description.split(' ')[0]!.toLowerCase()}`
}

/** A generic worker: declares a sonnet unit labelled with the description (once), then spawns the sonnet worker named after it. */
async function work($: any, w: World, description: string, extra: Record<string, unknown> = {}) {
  const id = workId(description)
  if (!w.units.some(u => u.id === id)) await declare($, w, [unit(id, 'sonnet', { label: description.split(/\s+/).slice(0, 4).join(' ') })])
  return spawn($, description, { name: id, ...extra })
}

/** Workers that are not the orchestrator, by id. */
function workerIds(w: World): string[] {
  return Object.keys(boardOf(w).agents).filter(id => id !== 'main')
}

async function complete($: any, agentId: string | undefined, reason: 'answer' | 'error' | 'aborted', answer = 'done and dusted') {
  return $.turn.complete({ answer, durationMs: 10, isAborted: reason === 'aborted', turnId: `t-${agentId ?? 'main'}`, reason, ...(agentId ? { agentId } : {}) })
}

async function runCommand($: any) {
  return $.command.run({ command: 'board', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
}

const PANE_PROPS = (width: number) => ({
  title: 'Agent Board',
  isFocused: false,
  bodyColumns: width,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 80 },
  view: {},
})

const BAND_PROPS = { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 4, bodyColumns: 120, scroll: { offset: 0, bodyRows: 4 }, view: {} }

// ---------------------------------------------------------------- the AgentBoard tool

test('AgentBoard: accepts an update and answers one line', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  const r: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, task: 'Build the board', phase: 'design' } as any)
  // no task was open: task-1 is opened, so the answer carries its state block, then the tracked line
  const lines = r.result.split('\n')
  expect(lines[0]).toBe('board updated: task set, phase design')
  expect(lines[1]).toBe('task task-1 · open · Build the board')
  expect(lines[lines.length - 1]).toBe('tracked workers: none')
  // a later update that opens nothing answers one line, as before
  const again: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, phase: 'executing' } as any)
  expect(again.result).toBe('board updated: phase executing | tracked workers: none')
  const b = boardOf(w)
  expect(b.task).toBe('Build the board')
  expect(b.phase).toBe('executing')
  expect(b.taskId).toBe('task-1')
})

test('AgentBoard: refuses bad input with the reason and leaves the board unchanged', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, phase: 'design' } as any)
  const before = boardOf(w)
  const r: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, phase: 'lunch' } as any)
  expect(r.result).toBeUndefined()
  expect(r.deny).toMatch(/field "phase" must be one of analysis, design/)
  expect(boardOf(w)).toEqual(before)
})

test('AgentBoard: refuses any call from a subagent, board unchanged', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  const before = boardOf(w)
  const r: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, phase: 'design', agentId: 'agent-w1' } as any)
  expect(r.result).toBeUndefined()
  expect(r.deny).toBe('only the orchestrator updates the board')
  expect((boardOf(w)).phase).toBe(before.phase)
})

test('other tool calls pass through unchanged and set the last tool', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  const r: any = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'old1' } as any)
  expect(r.result).toBe('ran')
  const b = boardOf(w)
  expect(boxOf(b, 'old1').lastTool).toBe('Bash')
  expect(boxOf(b, 'old1').tokensPartial).toBe(true)
})

test('a main-loop SendMessage to a worker by its call name points that arrow out', async ($, on) => {
  const w = world()
  const clock = engine(on, w)
  await start($)
  await work($, w, 'Probe the code')
  await complete($, 'agent-probe', 'answer')
  await clock.advance(5000)
  const r: any = await $.tool.call({ tool: 'SendMessage', to: workId('Probe the code'), message: 'one more thing' } as any)
  expect(r.result).toBe('ran')
  const b = boardOf(w)
  expect(boxOf(b, 'agent-probe').flow).toEqual({ dir: 'out', at: T0 + 5000 })
  expect(boxOf(b, 'main').lastTool).toBe('SendMessage')
})

// ---------------------------------------------------------------- command and prompt section

test('/board toggles the pane: opened, closed, and waiting when not placed', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  let r: any = await runCommand($)
  expect(r.text).toBe('Agent Board opened.')
  expect(w.panes.map(p => p.id)).toEqual(['flowestra'])
  expect(liveOf(w).paneOpen).toBe(true)
  r = await runCommand($)
  expect(r.text).toBe('Agent Board closed.')
  expect(w.panes).toHaveLength(0)
  expect(liveOf(w).paneOpen).toBe(false)
  w.placeOnOpen = false
  r = await runCommand($)
  expect(r.text).toMatch(/once the terminal is wide enough/)
  expect(liveOf(w).paneOpen).toBe(true)
})

// Not raised here: a close the person makes (the engine's `ui.close` with
// origin `person`). A test's `$` carries no `ui.close` to raise it with; the
// plugin's ui.close hook that sets live.paneOpen false is exercised only in a
// session. /board's own close sets it (test above).

test('the prompt sections are added once each, last: the board\'s then the policy\'s', async ($, on) => {
  const w = world()
  engine(on, w)
  const input = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] }
  const r: any = await $.prompt.compose(input as any)
  expect(r.sections.map((s: any) => s.id)).toEqual(['intro', BOARD_PROMPT_SECTION.id, POLICY_SECTION_ID])
  const teammate: any = await $.prompt.compose({ ...input, traits: ['teammate'] } as any)
  expect(teammate.sections.map((s: any) => s.id)).toEqual(['intro'])
})

// ---------------------------------------------------------------- lifecycle

test('spawn → step → step → complete builds the expected box; the spawn is not altered', async ($, on) => {
  const w = world()
  const clock = engine(on, w)
  const holder = { usage: null as ReturnType<typeof usage> | null }
  stepBottom(on, holder)
  await start($)
  await declare($, w, [unit('U1', 'sonnet', { label: 'Write state' })])

  const spawned: any = await spawn($, 'Write the state module please', { name: 'U1' })
  expect(spawned).toEqual({ model: SONNET, agentId: 'agent-write' })
  let b = boardOf(w)
  let one = boxOf(b, 'agent-write')
  expect(one.status).toBe('starting')
  expect(one.label).toBe('Write the state module')
  expect(one.model).toBe(SONNET) // the resolved model, not the alias asked
  expect(one.unitId).toBe('U1')
  expect(one.name).toBe('U1')
  expect(one.briefChars).toBe(420)
  expect(one.flow).toEqual({ dir: 'out', at: T0 })

  await clock.advance(1000)
  await $.turn.start({ text: 'go', turnId: 't-agent-write', agentId: 'agent-write' })
  expect(boxOf(boardOf(w), 'agent-write').status).toBe('running')

  holder.usage = usage(4, 100, 30_000, 2_000)
  const first = await step($, on, 'agent-write', null, 0)
  expect(first.chunks).toEqual([{ kind: 'text', ref: 0, index: 0, text: 'hi' }]) // the stream passes untouched
  expect(first.result.usage).toEqual(holder.usage)
  holder.usage = usage(0, 131, 277, 927)
  await step($, on, 'agent-write', null, 1)

  await clock.advance(2000)
  const done: any = await complete($, 'agent-write', 'answer', 'report'.repeat(10))
  expect(done).toEqual({ text: '' })
  b = boardOf(w)
  one = boxOf(b, 'agent-write')
  expect(one.status).toBe('done')
  expect(one.tokens).toEqual({ input: 4, output: 231, cacheRead: 30_277, cacheWrite: 2_927, requests: 2 })
  // the three numbers the box shows: new = input + cache writes, cached = cache reads, out
  expect(one.tokens!.input + one.tokens!.cacheWrite).toBe(4 + 2_000 + 0 + 927)
  expect(one.tokens!.cacheRead).toBe(30_000 + 277)
  expect(one.tokens!.output).toBe(100 + 131)
  expect(one.flow).toEqual({ dir: 'in', at: T0 + 3000 })
  expect(one.resultChars).toBe(60)
  expect(one.endedAt).toBe(T0 + 3000)
  expect(w.listCalls).toBeGreaterThanOrEqual(3) // session start, spawn, complete
})

test('the pane opens itself on the spawn that starts a burst, not on later ones', async ($, on) => {
  const w = world({ placeOnOpen: false })
  engine(on, w)
  await start($)
  await work($, w, 'First worker')
  expect(w.opens).toBe(1)
  expect(liveOf(w).paneOpen).toBe(true)
  // closed during the burst (by /board here; a person's close mark cannot be raised in a test): stays closed
  await runCommand($)
  expect(liveOf(w).paneOpen).toBe(false)
  await work($, w, 'Second worker')
  expect(w.opens).toBe(1)
  // the burst ends; the next spawn starts a new one
  await complete($, 'agent-first', 'answer')
  await complete($, 'agent-second', 'answer')
  await work($, w, 'Third worker')
  expect(w.opens).toBe(2)
})

test('a step from an unknown agent creates a partial box; a null usage adds nothing', async ($, on) => {
  const w = world()
  engine(on, w)
  const holder = { usage: usage(1, 2, 3, 4) as ReturnType<typeof usage> | null }
  stepBottom(on, holder)
  await start($)
  await step($, on, 'old7', null)
  let one = boxOf(boardOf(w), 'old7')
  expect(one.tokensPartial).toBe(true)
  expect(one.status).toBe('running')
  expect(one.tokens).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, requests: 1 })
  holder.usage = null
  const r = await step($, on, 'old7', null, 1)
  expect(r.result.usage).toBeNull()
  one = boxOf(boardOf(w), 'old7')
  expect(one.tokens).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, requests: 1 })
  // the orchestrator's steps (no agentId) land in the main box
  holder.usage = usage(10, 20, 30, 40)
  await step($, on, undefined, null)
  expect(boxOf(boardOf(w), 'main').tokens?.requests).toBe(1)
})

test('a failing bookkeeping step still hands on what next gave', async ($, on) => {
  const w = world()
  engine(on, w)
  const holder = { usage: usage(1, 1, 1, 1) as ReturnType<typeof usage> | null }
  stepBottom(on, holder)
  await start($)
  // every state write fails from here on: the reducers' results cannot be stored
  w.failWrites = true
  const r: any = await $.tool.call({ tool: 'Read', file_path: '/x' } as any)
  expect(r.result).toBe('ran')
  const s: any = await work($, w, 'Broken bookkeeping run')
  expect(s).toEqual({ model: SONNET, agentId: 'agent-broken' })
  expect(await $.turn.start({ text: 'go', turnId: 't1', agentId: 'agent-broken' })).toEqual({ turnId: 't1' })
  const st = await step($, on, 'agent-broken', null)
  expect(st.chunks).toHaveLength(1)
  expect((st.result as any).usage).toEqual(holder.usage)
  expect(await complete($, 'agent-broken', 'answer')).toEqual({ text: '' })
})

test('a failed and a stopped worker; the list status wins on reconcile', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await work($, w, 'Fail this one')
  await work($, w, 'Stop this one')
  await work($, w, 'Kill this one')
  await complete($, 'agent-fail', 'error')
  await complete($, 'agent-stop', 'aborted')
  w.list = [{ id: 'agent-kill', description: 'Kill this one', type: 'general-purpose', status: 'killed' }]
  await complete($, undefined, 'answer') // any turn.complete reconciles
  const b = boardOf(w)
  expect(boxOf(b, 'agent-fail').status).toBe('failed')
  expect(boxOf(b, 'agent-fail').reason).toBe('error')
  expect(boxOf(b, 'agent-stop').status).toBe('stopped')
  expect(boxOf(b, 'agent-kill').status).toBe('stopped')
  expect(boxOf(b, 'main').status).toBe('waiting')
})

test('session start keeps a board already loaded and adds agents from the list', async ($, on) => {
  const w = world({ list: [{ id: 'early', description: 'Started before the board', type: 'Explore', status: 'running' }] })
  engine(on, w)
  await start($)
  const b = boardOf(w)
  expect(b.loadedAt).toBe(T0)
  expect(boxOf(b, 'early').label).toBe('Started before the board')
  expect(boxOf(b, 'early').tokensPartial).toBe(true)
})

test('/clear resets the board', async ($, on) => {
  const w = world()
  const clock = engine(on, w)
  await start($)
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, task: 'Old task', phase: 'executing' } as any)
  await work($, w, 'Some worker')
  await clock.advance(7000)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as any)
  const b = boardOf(w)
  expect(b.task).toBeNull()
  expect(b.phase).toBeNull()
  expect(b.order).toEqual([])
  expect(b.loadedAt).toBe(T0 + 7000)
})

// ---------------------------------------------------------------- the clock

test('the clock ticks once a second while something runs, reconciles every fifth tick, and stops itself', async ($, on) => {
  const w = world({ usd: 1.234 })
  const clock = engine(on, w)
  await start($)
  await work($, w, 'Tick worker')
  const callsAfterSpawn = w.listCalls
  await clock.advance(1000)
  expect(liveOf(w).now).toBe(T0 + 1000)
  await clock.advance(3000)
  expect(liveOf(w).now).toBe(T0 + 4000)
  expect(w.listCalls).toBe(callsAfterSpawn)
  expect(liveOf(w).sessionTotal).toBeNull()
  await clock.advance(1000)
  expect(w.listCalls).toBe(callsAfterSpawn + 1)
  expect(liveOf(w).sessionTotal).toBe('$1.23')
  // the list says it finished: the fifth-tick reconcile marks it done, its card
  // lingers two seconds, and the tick that sees it gone stops the clock
  w.list = [{ id: 'agent-tick', description: 'Tick worker', type: 'general-purpose', status: 'completed' }]
  await clock.advance(5000)
  expect(boxOf(boardOf(w), 'agent-tick').status).toBe('done')
  await clock.advance(2000)
  const stoppedAt = liveOf(w).now
  expect(stoppedAt).toBe(T0 + 12_000)
  await clock.advance(10_000)
  expect(liveOf(w).now).toBe(stoppedAt)
  // the next lifecycle event starts it again
  await work($, w, 'Again worker')
  await clock.advance(2000)
  expect(liveOf(w).now).toBe(stoppedAt + 12_000)
  expect(w.animWrites).toBe(0)
})

/** The flow Client's props in a mounted terminal pane. */
async function flowOf(ui: any): Promise<FlowProps> {
  const flow = await ui.find({ type: 'Client', key: 'agent-flow' })
  if (!flow) throw new Error('no agent-flow Client in the pane')
  return flow.props.props as FlowProps
}

/** The worker cards handed to the flow module. */
async function workerCards(ui: any): Promise<RowCard[]> {
  return (await flowOf(ui)).workers
}

test('after the last worker completes, the clock keeps going until its card has left the row, then stops', async ($, on) => {
  const w = world()
  const clock = engine(on, w)
  await start($)
  await work($, w, 'Last worker')
  const ui = await $.ui.mount({ plugin: 'flowestra', component: 'Pane', requestId: 'flowestra', surface: 'terminal', props: PANE_PROPS(96) })
  await clock.advance(3000)
  await complete($, 'agent-last', 'answer')
  // a finished Sonnet card is held until its verdict (B3.3): checked here, so it lingers and goes
  await declare($, w, [unit(workId('Last worker'), 'sonnet', { label: 'Last worker', verdict: 'accepted' })])
  let cards = await workerCards(ui)
  expect(cards.map(c => c.id)).toEqual(['agent-last'])
  expect(cards[0]!.status).toBe('done')
  await clock.advance(1000)
  expect(liveOf(w).now).toBe(T0 + 4000)
  expect((await workerCards(ui)).map(c => c.id)).toEqual(['agent-last'])
  await clock.advance(2000)
  expect(liveOf(w).now).toBe(T0 + 5000) // the last tick, two seconds after the end, is written too
  expect(await workerCards(ui)).toEqual([])
  const writes = w.liveWrites
  await clock.advance(5000)
  expect(w.liveWrites).toBe(writes) // the clock has stopped
  expect(w.animWrites).toBe(0)
  await ui.unmount()
})

test('a failed worker lingers in the row for eight seconds, then the clock stops', async ($, on) => {
  const w = world()
  const clock = engine(on, w)
  await start($)
  await work($, w, 'Fail worker')
  const ui = await $.ui.mount({ plugin: 'flowestra', component: 'Pane', requestId: 'flowestra', surface: 'terminal', props: PANE_PROPS(96) })
  await complete($, 'agent-fail', 'error')
  await clock.advance(7000)
  const cards = await workerCards(ui)
  expect(cards.map(c => c.id)).toEqual(['agent-fail'])
  expect(cards[0]!.status).toBe('failed')
  await clock.advance(2000)
  expect(await workerCards(ui)).toEqual([])
  const writes = w.liveWrites
  await clock.advance(5000)
  expect(w.liveWrites).toBe(writes)
  await ui.unmount()
})

// ---------------------------------------------------------------- drawing

test('the pane: the flow module with its props on the terminal, the still flow on desktop', async ($, on) => {
  const holder = { usage: usage(1_000, 3_100, 35_800, 400, SONNET) as ReturnType<typeof usage> | null }
  const w = world()
  engine(on, w)
  stepBottom(on, holder)
  await start($)
  await declare($, w, [unit('U1', 'sonnet', { label: 'Write state' })], { task: 'Build the board', phase: 'executing', wave: 1 })
  await spawn($, 'Write the state module', { name: 'U1' })
  await spawn($, 'Help the writer', { parentAgentId: 'agent-write' }) // nested: no unit needed
  await work($, w, 'Gone worker')
  await complete($, 'agent-gone', 'answer')
  await $.turn.start({ text: 'go', turnId: 't', agentId: 'agent-write' })
  await step($, on, 'agent-write', null)

  // terminal: the Client keyed agent-flow, its props the flow's texts
  let ui: any = await $.ui.mount({ plugin: 'flowestra', component: 'Pane', requestId: 'flowestra', surface: 'terminal', props: PANE_PROPS(96) })
  expect((await ui.find({ key: 'header' }))?.text).toBe('AGENT BOARD · task-1 · Build the board')
  const client = await ui.find({ type: 'Client', key: 'agent-flow' })
  expect(client).toBeDefined()
  expect(String(client.props.module)).toMatch(/flow\.client\.tsx$/)
  expect(client.props.width).toBe(96)
  expect(await ui.find({ type: 'Client', key: 'agent-row' })).toBeUndefined()
  const flow = await flowOf(ui)
  expect(flow.workers.map(c => c.id)).toEqual(['agent-write', 'agent-help', 'agent-gone']) // the done one still lingers
  expect(flow.workers[0]).toEqual(
    expect.objectContaining({ label: 'Write the state module', status: 'running', tokens: 'out 3.1k', selected: false, model: 'Sonnet 5.5 · implement', row: 'workers', tier: 'sonnet', warn: false }),
  )
  expect(flow.workers[2]!.status).toBe('done')
  expect(flow.plan).toEqual({ title: 'PLAN · executing · wave 1', done: 1, total: 2, counts: 'running 2  failed 0  queued 0' }) // U1 and Gone worker's unit
  expect(flow.delegate).toBe('delegate to workers · Sonnet 5.5')
  expect(flow.workers[1]).toEqual(expect.objectContaining({ tier: 'sonnet', warn: true, model: 'Sonnet 5.5 · no audit' })) // nested: no unit
  expect(flow.leads).toEqual([]) // no Haiku worker: no leads row
  expect(flow.leadsLabel).toBe('')
  expect(flow.feed).toBe('')
  expect(flow.back).toEqual({ title: 'back to lead', line: 'waiting on 2 · 1 in', active: false })
  expect(await ui.find({ key: 'still-flow' })).toBeUndefined() // the view drew no still flow
  // the session log: three spawns, one end and the phase, newest four shown
  const log = await ui.find({ key: 'log' })
  expect(log?.text).toMatch(/session log/)
  expect(log?.text).toMatch(/Gone worker\s+done/)
  await ui.unmount()

  // desktop: no Client; the view draws the still flow itself
  ui = await $.ui.mount({ plugin: 'flowestra', component: 'Pane', requestId: 'flowestra', surface: 'desktop', props: PANE_PROPS(96) })
  expect((await ui.find({ key: 'header' }))?.text).toBe('AGENT BOARD · task-1 · Build the board')
  expect(await ui.find({ type: 'Client' })).toBeUndefined()
  expect(await ui.find({ key: 'still-flow' })).toBeDefined()
  const card = await ui.find({ key: 'slot-agent-write' })
  expect(card?.text).toMatch(/Write the state module/)
  expect(card?.text).toMatch(/out 3\.1k/)
  expect((await ui.find({ key: 'slot-agent-help' }))?.text).toMatch(/Help the writer/)
  // pressing a still card selects it, as a post from the flow module does
  await ui.press({ key: 'card-agent-help' })
  expect(w.ui?.selected).toBe('agent-help')
  expect((await ui.find({ key: 'detail' }))?.text).toMatch(/↳ Write the state module/)
  await ui.press({ key: 'card-agent-help' })
  expect(w.ui?.selected).toBeNull()
  await ui.unmount()
})

test('the lead box: waiting with no events, running while the main loop works, waiting again when its turn ends', async ($, on) => {
  const holder = { usage: usage(1_000, 3_100, 35_800, 400) as ReturnType<typeof usage> | null }
  const w = world()
  engine(on, w)
  stepBottom(on, holder)
  await start($)
  const mount = () => $.ui.mount({ plugin: 'flowestra', component: 'Pane', requestId: 'flowestra', surface: 'terminal', props: PANE_PROPS(96) })
  let ui: any = await mount()
  expect((await flowOf(ui)).lead).toEqual({ title: 'Orchestrator · main session', running: false, line: 'no events yet', tokens: 'out n/a' })
  expect((await ui.find({ key: 'status' }))?.text).toMatch(/^lead \[waiting\] {3}workers \[0\/0\] {3}phase \[not set\]$/)
  await ui.unmount()

  // a step from the main loop with no turn start: running, its model shown
  await step($, on, undefined, null)
  ui = await mount()
  expect((await flowOf(ui)).lead).toEqual({ title: 'Haiku 4.5 · main session', running: true, line: 'thinking', tokens: 'out 3.1k' })
  expect((await flowOf(ui)).back.title).toBe('back to Haiku 4.5 · lead')
  expect((await ui.find({ key: 'legend' }))?.text).toBe('■ Haiku 4.5 · lead')
  expect((await ui.find({ key: 'status' }))?.text).toMatch(/^lead \[working\]/)
  await ui.unmount()

  // the turn completes: waiting again
  await complete($, undefined, 'answer')
  ui = await mount()
  expect((await flowOf(ui)).lead).toMatchObject({ running: false, line: 'waiting' })
  await ui.unmount()
})

test('the pane height: the plan box and the session log by exact row accounting', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, phase: 'design' } as any)
  const mount = (rows: number) =>
    $.ui.mount({ plugin: 'flowestra', component: 'Pane', requestId: 'flowestra', surface: 'terminal', props: { ...PANE_PROPS(96), scroll: { offset: 0, bodyRows: rows } } })
  // no card: 13 fixed rows (header, legend, lead box, stem, return box, status line); the plan box 6;
  // the log holds the one phase entry: the full log needs 4 rows, the compact one 1.
  // Under 19 the plan box is left out and its rows go to the log.
  for (const [rows, plan, log] of [
    [13, false, 'none'],
    [14, false, 'compact'],
    [16, false, 'compact'],
    [17, false, 'full'],
    [18, false, 'full'],
    [19, true, 'none'],
    [20, true, 'compact'],
    [22, true, 'compact'],
    [23, true, 'full'],
  ] as const) {
    const ui: any = await mount(rows)
    expect((await flowOf(ui)).plan !== null).toBe(plan)
    expect((await ui.find({ key: 'log' })) !== undefined).toBe(log === 'full')
    expect((await ui.find({ key: 'log-compact' })) !== undefined).toBe(log === 'compact')
    expect(await ui.find({ key: 'status' })).toBeDefined()
    await ui.unmount()
  }
})

test('the session cost is at the end of the status line', async ($, on) => {
  const w = world({ usd: 2.5 })
  const clock = engine(on, w)
  await start($)
  await work($, w, 'Cost worker')
  await clock.advance(5000) // the fifth tick refreshes the session total
  for (const surface of SURFACES) {
    const ui: any = await $.ui.mount({ plugin: 'flowestra', component: 'Pane', requestId: 'flowestra', surface, props: PANE_PROPS(96) })
    expect((await ui.find({ key: 'status' }))?.text).toMatch(/^lead \[waiting\] {3}workers \[1\/1\] {3}phase \[not set\] {3}\$2\.50$/)
    await ui.unmount()
  }
})

test('a board stored by the earlier shape (board-1) is declined: the pane draws an empty board', async ($, on) => {
  on('state.get', (_: any, e: any) =>
    e.key === 'board'
      ? { value: { value: { shape: 'board-1', value: { task: 'stale', phase: 'design', wave: null, units: [], agents: {}, order: [], loadedAt: 5, note: null } }, version: 1 } }
      : { value: { value: undefined, version: 0 } },
  )
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'flowestra', component: 'Pane', requestId: 'flowestra', surface, props: PANE_PROPS(80) })
    expect((await ui.find({ key: 'header' }))?.text).toBe('AGENT BOARD · no task declared')
    expect(await ui.find({ key: 'log' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the band shows only while the pane is not placed and the board has a phase or a worker', async ($, on) => {
  const w = world({ placeOnOpen: false })
  engine(on, w)
  on('ui.render', (_: any, e: any) => {
    const { Text } = _.ui.resolve(e)
    return <Text>engine</Text>
  })
  await start($)
  const band = async (surface: (typeof SURFACES)[number]) => {
    const ui = await $.ui.mount({ plugin: 'flowestra', component: 'AbovePrompt', requestId: 'band', surface, props: BAND_PROPS })
    const found = await ui.find({ key: 'band' })
    await ui.unmount()
    return found?.text ?? null
  }
  for (const surface of SURFACES) expect(await band(surface)).toBeNull() // empty board
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, phase: 'design' } as any)
  for (const surface of SURFACES) expect(await band(surface)).toMatch(/^Agent Board {2}task-1 {2}\[design\]/) // no pane at all; the band opens with the task id
  await work($, w, 'Band worker') // opens the pane, unplaced
  for (const surface of SURFACES) expect(await band(surface)).toMatch(/● 1\/1 running/)
  for (const p of w.panes) p.isPlaced = true
  for (const surface of SURFACES) expect(await band(surface)).toBeNull()
})

test('the band does not read detail, ui or the log, and its drawing does not change when only the selection changes', async ($, on) => {
  const w = world({ placeOnOpen: false })
  engine(on, w)
  const reads = w.reads // the engine's state.get records every key read
  await start($)
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, phase: 'design' } as any)
  await work($, w, 'Band worker') // opens the pane unplaced: the band draws
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'flowestra', component: 'AbovePrompt', requestId: 'band', surface, props: BAND_PROPS })
    const first = await ui.drawn()
    reads.length = 0
    await ui.redraw()
    expect(reads).toContain('board') // the band's own reads are seen here
    expect(reads.filter(k => k === 'detail' || k === 'ui' || k === 'log')).toEqual([])
    const pane = await $.ui.mount({ plugin: 'flowestra', component: 'Pane', requestId: 'flowestra', surface: 'terminal', props: PANE_PROPS(96) })
    reads.length = 0
    await pane.redraw()
    expect(reads).toContain('log') // the pane reads the log, so a new entry redraws it
    await pane.post({ select: 'agent-band' }, { in: 'agent-flow' })
    expect(w.ui?.selected).toBe('agent-band')
    await pane.post({ select: 'agent-band' }, { in: 'agent-flow' })
    await pane.unmount()
    expect(await ui.drawn()).toEqual(first)
    await ui.unmount()
  }
})

// ---------------------------------------------------------------- selection

test('a post of { select } from the flow selects that card and a second clears it; anything else changes nothing', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await work($, w, 'Pick worker', { prompt: 'Read the files and report back.' })
  await work($, w, 'Other worker')
  const ui: any = await $.ui.mount({ plugin: 'flowestra', component: 'Pane', requestId: 'flowestra', surface: 'terminal', props: PANE_PROPS(96) })
  expect(await ui.find({ key: 'detail' })).toBeUndefined()

  await ui.post({ select: 'agent-pick' }, { in: 'agent-flow' })
  expect(w.ui).toEqual({ selected: 'agent-pick' })
  const cards = await workerCards(ui)
  expect(cards.find(c => c.id === 'agent-pick')?.selected).toBe(true)
  expect(cards.find(c => c.id === 'agent-other')?.selected).toBe(false)
  const strip = await ui.find({ key: 'detail' })
  expect(strip?.text).toMatch(/Pick worker/)
  expect(strip?.text).toMatch(/Read the files and report back\./)

  await ui.post({ select: 'agent-pick' }, { in: 'agent-flow' })
  expect(w.ui).toEqual({ selected: null })
  expect(await ui.find({ key: 'detail' })).toBeUndefined()

  // another card selected; then posts that name no worker, or carry other data, leave it be
  await ui.post({ select: 'agent-other' }, { in: 'agent-flow' })
  expect(w.ui).toEqual({ selected: 'agent-other' })
  for (const data of [{ select: 'agent-nobody' }, { select: 'main' }, { select: '' }, { select: 3 }, { pick: 'agent-pick' }, 'agent-pick', ['agent-pick'], null]) {
    await ui.post(data as any, { in: 'agent-flow' })
    expect(w.ui).toEqual({ selected: 'agent-other' })
  }
  expect(w.animWrites).toBe(0)
  await ui.unmount()
})

test('a selected card loses its selection once it has left the row', async ($, on) => {
  const w = world()
  const clock = engine(on, w)
  await start($)
  await work($, w, 'Keep worker')
  await work($, w, 'Sel worker')
  const ui: any = await $.ui.mount({ plugin: 'flowestra', component: 'Pane', requestId: 'flowestra', surface: 'terminal', props: PANE_PROPS(96) })
  await ui.post({ select: 'agent-sel' }, { in: 'agent-flow' })
  expect(w.ui?.selected).toBe('agent-sel')
  await complete($, 'agent-sel', 'answer')
  await declare($, w, [unit(workId('Sel worker'), 'sonnet', { label: 'Sel worker', verdict: 'accepted' })]) // checked: not held
  await clock.advance(1000)
  expect(w.ui?.selected).toBe('agent-sel') // still lingering in the row
  await clock.advance(2000)
  expect(w.ui?.selected).toBeNull()
  expect((await workerCards(ui)).map(c => c.id)).toEqual(['agent-keep'])
  expect(await ui.find({ key: 'detail' })).toBeUndefined()
  await ui.unmount()
})

// ---------------------------------------------------------------- the session log

test('every board write is compared: a spawn, an end and a phase change are logged at their time', async ($, on) => {
  const w = world()
  const clock = engine(on, w)
  await start($)
  expect(logOf(w).entries).toEqual([]) // the first load is not logged
  await clock.advance(1000)
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, task: 'Log it', phase: 'executing', wave: 1 } as any)
  await clock.advance(1000)
  await work($, w, 'Write the log module')
  await clock.advance(2000)
  await $.tool.call({ tool: 'Read', file_path: '/x', agentId: 'agent-write' } as any) // not logged
  await clock.advance(121_000)
  await complete($, 'agent-write', 'answer')
  await clock.advance(1000)
  await work($, w, 'Break things')
  await complete($, 'agent-break', 'error')
  await work($, w, 'Stop things')
  await complete($, 'agent-stop', 'aborted')
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, phase: 'executing', wave: 2 } as any) // the same phase: not logged
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, phase: 'testing' } as any)
  expect(logOf(w).entries).toEqual([
    { at: T0 + 1000, kind: 'phase', who: 'lead', text: 'task task-1 opened' }, // opening a task logs that, not its phase
    { at: T0 + 2000, kind: 'spawned', who: 'Write the log module', text: 'spawned · Sonnet 5.5 · implement' },
    { at: T0 + 2000, kind: 'audit', who: 'Write the log module', text: AUDIT.sonnet },
    { at: T0 + 125_000, kind: 'done', who: 'Write the log module', text: 'done · 2m 03s · draft' },
    { at: T0 + 126_000, kind: 'spawned', who: 'Break things', text: 'spawned · Sonnet 5.5 · implement' },
    { at: T0 + 126_000, kind: 'audit', who: 'Break things', text: AUDIT.sonnet },
    { at: T0 + 126_000, kind: 'failed', who: 'Break things', text: 'failed: error' },
    { at: T0 + 126_000, kind: 'spawned', who: 'Stop things', text: 'spawned · Sonnet 5.5 · implement' },
    { at: T0 + 126_000, kind: 'audit', who: 'Stop things', text: AUDIT.sonnet },
    { at: T0 + 126_000, kind: 'stopped', who: 'Stop things', text: 'stopped · 0s' },
    { at: T0 + 126_000, kind: 'phase', who: 'lead', text: 'phase → testing' },
  ])
})

test('a worker the list reports ended is logged by the reconcile that sees it', async ($, on) => {
  const w = world()
  const clock = engine(on, w)
  await start($)
  await work($, w, 'Listed worker')
  w.list = [{ id: 'agent-listed', description: 'Listed worker', type: 'general-purpose', status: 'completed' }]
  await clock.advance(5000) // the fifth tick reconciles
  expect(logOf(w).entries.map(e => `${e.kind}:${e.who}`)).toEqual(['phase:lead', 'spawned:Listed worker', 'audit:Listed worker', 'done:Listed worker'])
  expect(logOf(w).entries[0]!.text).toBe('task task-1 opened') // work() declared its unit: task-1 opened
  expect(logOf(w).entries[3]!.at).toBe(T0 + 5000)
})

test('a log that cannot be written never loses the board update', async ($, on) => {
  const w = world({ failLogWrites: true })
  engine(on, w)
  await start($)
  const r: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, phase: 'design' } as any)
  expect(r.result).toMatch(/^board updated/)
  expect(boardOf(w).phase).toBe('design')
  const s: any = await work($, w, 'Unlogged worker')
  expect(s).toEqual({ model: SONNET, agentId: 'agent-unlogged' })
  expect(boxOf(boardOf(w), 'agent-unlogged').status).toBe('starting')
  await complete($, 'agent-unlogged', 'answer')
  expect(boxOf(boardOf(w), 'agent-unlogged').status).toBe('done')
  expect(w.log).toBeNull()
})

test('/clear empties the log and the reset itself is not logged', async ($, on) => {
  const w = world()
  const clock = engine(on, w)
  await start($)
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, phase: 'executing' } as any)
  await work($, w, 'Clear worker')
  expect(logOf(w).entries.map(e => e.kind)).toEqual(['phase', 'spawned', 'audit']) // the phase entry is "task task-1 opened"
  await clock.advance(1000)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as any)
  expect(w.log).toEqual({ entries: [] })
  const ui: any = await $.ui.mount({ plugin: 'flowestra', component: 'Pane', requestId: 'flowestra', surface: 'terminal', props: PANE_PROPS(96) })
  expect(await ui.find({ key: 'log' })).toBeUndefined()
  await ui.unmount()
})

test('two board writes for one new agent fired at once leave exactly one spawned entry', async ($, on) => {
  const w = world()
  const clock = engine(on, w)
  await start($)
  await declare($, w, [unit(workId('Race worker'))])
  // the subagent's turn.start races the spawn hook's bookkeeping: neither awaits the other,
  // and the turn.start's board write is held in flight while the spawn runs
  let release: () => void = () => undefined
  w.boardGate = new Promise<void>(r => (release = r))
  const turn: Promise<any> = $.turn.start({ text: 'go', turnId: 't-agent-race', agentId: 'agent-race' })
  await clock.settle()
  const spawned: Promise<any> = spawn($, 'Race worker', { name: workId('Race worker') })
  await clock.settle()
  release()
  expect(await turn).toEqual({ turnId: 't-agent-race' })
  expect(await spawned).toEqual({ model: SONNET, agentId: 'agent-race' })
  expect(logOf(w).entries.filter(e => e.kind === 'spawned')).toEqual([
    { at: T0, kind: 'spawned', who: 'Race worker', text: 'spawned · Sonnet 5.5 · implement' },
  ])
  expect(boxOf(boardOf(w), 'agent-race').label).toBe('Race worker')
})

test('a board write that fails does not stop a later event from updating the board', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  // a failing state.set hook is skipped by the kit, so a write cannot be made to fail;
  // a stored board with no units list makes the spawn's reducer throw inside its link instead
  w.corruptBoard = true
  const s: any = await spawn($, 'Lost worker', { name: 'L1' }) // the gate fails open on the corrupt board
  expect(s).toEqual({ model: SONNET, agentId: 'agent-lost' })
  expect(w.board?.agents['agent-lost']).toBeUndefined() // the link failed: nothing stored
  w.corruptBoard = false
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'agent-later' } as any)
  expect(boxOf(boardOf(w), 'agent-later').lastTool).toBe('Bash')
})

test('a resumed spawn keeps a box\'s partial counts; a fresh spawn over a placeholder does not', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  // an earlier event made partial boxes for both
  await $.tool.call({ tool: 'Read', file_path: '/a', agentId: 'agent-resumed' } as any)
  await $.tool.call({ tool: 'Read', file_path: '/b', agentId: 'agent-fresh' } as any)
  expect(boxOf(boardOf(w), 'agent-resumed').tokensPartial).toBe(true)
  await spawn($, 'Resumed worker', { resume: { agentId: 'agent-resumed' } }) // a resume passes the gate
  await work($, w, 'Fresh worker')
  expect(boxOf(boardOf(w), 'agent-resumed').tokensPartial).toBe(true)
  expect(boxOf(boardOf(w), 'agent-fresh').tokensPartial).toBe(false)
})

// ---------------------------------------------------------------- detail

test('a spawn stores the brief, cut to 600 characters', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await work($, w, 'Brief worker', { prompt: 'b'.repeat(900) })
  await work($, w, 'Short worker', { prompt: '  do it  ' })
  const d = detailOf(w)
  expect(d.agents['agent-brief']).toEqual({ brief: 'b'.repeat(600), briefCut: true, tools: [] })
  expect(d.agents['agent-short']).toEqual({ brief: 'do it', briefCut: false, tools: [] })
})

test('a worker tool call is a run while next is pending and gone afterwards; next passes through', async ($, on) => {
  const w = world()
  let release: () => void = () => undefined
  let fail = false
  // registered before the engine's catch-all tool.call, so it is the one that answers Bash
  on('tool.call', { tool: 'Bash' }, async () => {
    await new Promise<void>(r => (release = r))
    if (fail) throw new Error('bash broke')
    return { result: 'slow ran' }
  })
  const clock = engine(on, w)
  await start($)
  await work($, w, 'Tool worker')
  await clock.advance(2000)

  const pending: Promise<any> = $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'agent-tool' } as any)
  await clock.settle()
  let entry = detailOf(w).agents['agent-tool']!
  expect(entry.tools).toHaveLength(1)
  expect(entry.tools[0]!.tool).toBe('Bash')
  expect(entry.tools[0]!.startedAt).toBe(T0 + 2000)
  expect(entry.tools[0]!.id.length).toBeGreaterThan(0)
  await clock.advance(500)
  release()
  expect(await pending).toEqual({ result: 'slow ran' })
  entry = detailOf(w).agents['agent-tool']!
  expect(entry.tools).toEqual([])

  // next throws: the same error comes out, and the run is still removed. (The kit
  // skips a hook beneath that throws, so next(e) rejects with its own HooksError:
  // that rejection is what must reach the caller unchanged.)
  fail = true
  const thrown: Promise<any> = $.tool.call({ tool: 'Bash', command: 'false', agentId: 'agent-tool' } as any)
  await clock.settle()
  expect(detailOf(w).agents['agent-tool']!.tools).toHaveLength(1)
  release()
  let error: unknown = null
  try {
    await thrown
  } catch (err) {
    error = err
  }
  expect(error).toBeInstanceOf(Error)
  expect(String(error)).toMatch(/no implementation for tool\.call/)
  expect(detailOf(w).agents['agent-tool']!.tools).toEqual([])
})

test('a turn completing clears the worker runs', async ($, on) => {
  const w = world()
  on('tool.call', { tool: 'Bash' }, () => new Promise(() => undefined)) // never answers; before the engine's catch-all
  const clock = engine(on, w)
  await start($)
  await work($, w, 'Busy worker')
  void $.tool.call({ tool: 'Bash', command: 'sleep 100', agentId: 'agent-busy' } as any)
  await clock.settle()
  expect(detailOf(w).agents['agent-busy']!.tools).toHaveLength(1)
  await clock.advance(3000)
  await complete($, 'agent-busy', 'answer')
  expect(detailOf(w).agents['agent-busy']!.tools).toEqual([])
})

test('/clear empties detail and ui and stops the clock; nothing is ever written under anim', async ($, on) => {
  const w = world()
  const clock = engine(on, w)
  await start($)
  await work($, w, 'Clear worker')
  await $.tool.call({ tool: 'Read', file_path: '/a', agentId: 'agent-clear' } as any)
  const ui: any = await $.ui.mount({ plugin: 'flowestra', component: 'Pane', requestId: 'flowestra', surface: 'terminal', props: PANE_PROPS(96) })
  await ui.post({ select: 'agent-clear' }, { in: 'agent-flow' })
  await ui.unmount()
  await clock.advance(1000)
  expect(Object.keys(detailOf(w).agents)).toEqual(['agent-clear'])
  expect(w.ui).toEqual({ selected: 'agent-clear' })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as any)
  expect(w.detail).toEqual({ agents: {} })
  expect(w.ui).toEqual({ selected: null })
  const writes = w.liveWrites
  await clock.advance(3000)
  expect(w.liveWrites).toBe(writes) // the clock stopped with it
  expect(w.animWrites).toBe(0)
})


// ---------------------------------------------------------------- the Model Routing Policy: workers and offers

test('session start registers the three tier workers', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  expect(w.registered).toEqual([WORKER_NAMES.haiku, WORKER_NAMES.sonnet, WORKER_NAMES.opus])
})

/** What the model is offered of one agent type. */
async function offer($: any, agent: string): Promise<any> {
  return $.agent.offer({ agent, description: `the ${agent} agent`, source: 'built-in', provider: { plugin: 'engine', tier: 'core' } })
}

test('agent.offer hides Explore, Plan, general-purpose, claude, web-fetch and claude-code-guide, and no tier worker', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  expect(REFUSED_BUILTINS).toEqual(['Explore', 'Plan', 'general-purpose', 'claude', 'web-fetch', 'claude-code-guide'])
  for (const agent of REFUSED_BUILTINS) expect(await offer($, agent)).toEqual({ isOffered: false })
  expect(await offer($, 'web-fetch')).toEqual({ isOffered: false })
  expect(await offer($, 'claude-code-guide')).toEqual({ isOffered: false })
  for (const t of ['haiku', 'sonnet', 'opus'] as const) expect(await offer($, workerType(t))).toEqual({ isOffered: true })
  expect(await offer($, 'statusline-setup')).toEqual({ isOffered: true })
  expect(await offer($, 'my-plugin:helper')).toEqual({ isOffered: true })
})

// ---------------------------------------------------------------- the spawn gate

/** One refusal through the real hook: the exact text, next not called, nothing on the board, the log entry. */
async function expectRefused($: any, w: World, description: string, extra: Record<string, unknown>, reason: string, who: string) {
  const calls = w.spawnCalls
  const before = workerIds(w)
  const logged = logOf(w).entries.length
  const r: any = await spawn($, description, extra)
  expect(r).toEqual({ deny: reason })
  expect(w.spawnCalls).toBe(calls)
  expect(workerIds(w)).toEqual(before)
  expect(logOf(w).entries.slice(logged)).toEqual([{ at: T0, kind: 'audit', who: 'lead', text: `spawn refused: ${who}` }])
}

test('the gate refuses the built-in types the tier workers replace', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await declare($, w, [unit('s1')])
  for (const type of REFUSED_BUILTINS) {
    await expectRefused($, w, 'Look around here', { subagentType: type, name: 's1' }, denyBuiltin(type), 's1')
  }
})

test('the gate refuses a call no declared unit covers, named or not', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await expectRefused($, w, 'Find call sites', { name: 'x1' }, denyUndeclared('x1'), 'x1')
  await expectRefused($, w, 'Poke around', {}, denyUndeclared(null), 'Poke around')
  // a unit with no tier (one the orchestrator carries out itself) covers nothing
  await declare($, w, [{ id: 'd1', label: 'By hand', wave: 1, declared: 'pending' }])
  await expectRefused($, w, 'By hand', { name: 'd1' }, denyUndeclared('d1'), 'd1')
  await expectRefused($, w, 'By hand', {}, denyUndeclared(null), 'By hand')
})

test('the gate refuses the wrong tier worker, a model override, and another type without the unit\'s model', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await declare($, w, [unit('h1', 'haiku'), unit('s1', 'sonnet')])
  await expectRefused($, w, 'Find call sites', { name: 'h1' }, denyWrongWorker('h1', 'haiku', 'sonnet'), 'h1')
  await expectRefused($, w, 'Write the module', { name: 's1', model: 'opus' }, denyModelOverride('sonnet', 'opus'), 's1')
  await expectRefused($, w, 'Write the module', { name: 's1', subagentType: 'my-plugin:helper' }, denyNoModel('s1', 'sonnet'), 's1')
  await expectRefused($, w, 'Write the module', { name: 's1', subagentType: 'my-plugin:helper', model: 'haiku' }, denyNoModel('s1', 'sonnet'), 's1')
  // the same model as the worker's own, and another type naming the unit's tier, go through
  expect(await spawn($, 'Write the module', { name: 's1', model: 'sonnet' })).toEqual({ model: SONNET, agentId: 'agent-write' })
  expect(await spawn($, 'Help with module', { name: 's1', subagentType: 'my-plugin:helper', model: 'sonnet' })).toEqual({ model: SONNET, agentId: 'agent-help' })
  expect(w.spawnCalls).toBe(2)
})

test('the gate refuses a rejected unit, a barred kind and a third run at one tier', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  // h3 is declared before locate is barred at haiku; r1 and r2 are rejected
  await declare($, w, [unit('h3', 'haiku'), unit('r1', 'haiku', { verdict: 'rejected' })])
  await expectRefused($, w, 'Redo the search', { name: 'r1', subagentType: workerType('haiku') }, denyRejected('r1'), 'r1')
  await declare($, w, [unit('r2', 'haiku', { verdict: 'rejected' })])
  await expectRefused($, w, 'Search once more', { name: 'h3', subagentType: workerType('haiku') }, denyBarred('haiku', 'locate', 2), 'h3')
  // a sonnet unit runs twice at sonnet, then is refused
  await declare($, w, [unit('s1')])
  expect((await spawn($, 'One try', { name: 's1' })).agentId).toBe('agent-one')
  expect((await spawn($, 'Two tries', { name: 's1' })).agentId).toBe('agent-two')
  await expectRefused($, w, 'Three tries', { name: 's1' }, denyRetry('s1', 'sonnet'), 's1')
})

test('the gate refuses a unit whose spec file is missing, and lets it through once the file exists', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await declare($, w, [unit('s1', 'sonnet', { spec: '/work/docs/spec.md' })])
  await expectRefused($, w, 'Build from spec', { name: 's1' }, denySpec('s1', '/work/docs/spec.md'), 's1')
  w.files['/work/docs/spec.md'] = '# spec'
  expect(await spawn($, 'Build from spec', { name: 's1' })).toEqual({ model: SONNET, agentId: 'agent-build' })
})

test('a covered spawn of each tier goes through, its card in its row with its tier', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await declare($, w, [unit('h1', 'haiku'), unit('s1', 'sonnet'), unit('o1', 'opus', { label: 'Design the gate' })])
  expect(await spawn($, 'Find call sites', { name: 'h1', subagentType: workerType('haiku') })).toEqual({ model: HAIKU, agentId: 'agent-find' })
  expect(await spawn($, 'Write the module', { name: 's1' })).toEqual({ model: SONNET, agentId: 'agent-write' })
  // no name: linked by its description, the unit's label
  expect(await spawn($, 'design  the gate', { subagentType: workerType('opus') })).toEqual({ model: OPUS, agentId: 'agent-design' })
  expect(w.spawnCalls).toBe(3)
  expect(boxOf(boardOf(w), 'agent-design').unitId).toBe('o1')
  const ui: any = await $.ui.mount({ plugin: 'flowestra', component: 'Pane', requestId: 'flowestra', surface: 'terminal', props: PANE_PROPS(96) })
  const flow = await flowOf(ui)
  expect(flow.leads.map(c => [c.id, c.row, c.tier, c.warn])).toEqual([['agent-find', 'leads', 'haiku', false]])
  expect(flow.workers.map(c => [c.id, c.row, c.tier, c.warn])).toEqual([
    ['agent-write', 'workers', 'sonnet', false],
    ['agent-design', 'workers', 'opus', false],
  ])
  expect(flow.leads[0]!.model).toBe('Haiku 4.5 · locate')
  await ui.unmount()
  expect(logOf(w).entries.filter(e => e.text.startsWith('spawn refused'))).toEqual([])
})

test('workflow agents, resumes, nested spawns and statusline-setup pass the gate with no unit; a fork is refused', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  // a fork from the main loop is refused first (B2, P4), with nothing declared
  expect(await spawn($, 'Forked run', { subagentType: 'fork', fork: true })).toEqual({ deny: denyFork() })
  expect(w.spawnCalls).toBe(0)
  expect(logOf(w).entries.map(e => e.text)).toEqual(['spawn refused: Forked run'])
  const passed = [
    await spawn($, 'Nested fork', { subagentType: 'fork', fork: true, parentAgentId: 'agent-x' }), // nested forks keep passing (rule 1)
    await spawn($, 'Workflow run', { subagentType: 'general-purpose', workflow: { runId: 'wf_1', agentIndex: 1 } }),
    await spawn($, 'Resumed run', { subagentType: 'Explore', resume: { agentId: 'agent-resumed' } }),
    await spawn($, 'Nested run', { subagentType: 'general-purpose', parentAgentId: 'agent-forked' }),
    await spawn($, 'Statusline run', { subagentType: 'statusline-setup' }),
  ]
  for (const r of passed as any[]) expect(r.deny).toBeUndefined()
  expect(w.spawnCalls).toBe(5)
  expect(logOf(w).entries.filter(e => e.text.startsWith('spawn refused'))).toHaveLength(1)
})

test('the gate fails open: an error inside it lets the spawn through', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  // a stored board with no units list makes the check throw
  w.corruptBoard = true
  const r: any = await spawn($, 'Find call sites', { name: 'x1' })
  expect(r).toEqual({ model: SONNET, agentId: 'agent-find' })
  expect(w.spawnCalls).toBe(1)
  w.corruptBoard = false
  // a spec check that fails counts as the file being there
  await declare($, w, [unit('s1', 'sonnet', { spec: '/nowhere/spec.md' })])
  w.failExists = true
  expect(await spawn($, 'Build from spec', { name: 's1' })).toEqual({ model: SONNET, agentId: 'agent-build' })
  expect(w.spawnCalls).toBe(2)
})

test('AgentBoard: a new unit of a barred (tier, kind) is refused, the board unchanged; one tier up is accepted', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  const first: any = await declare($, w, [unit('h3', 'haiku'), unit('r1', 'haiku', { verdict: 'rejected' }), unit('r2', 'haiku', { verdict: 'rejected' })])
  expect(first.result).toMatch(/^board updated/)
  expect(first.result).toMatch(/ \| barred: haiku locate$/)
  const before = boardOf(w)
  const denied: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, units: [...w.units, unit('h9', 'haiku')] } as any)
  expect(denied.result).toBeUndefined()
  expect(denied.deny).toBe('unit "h9": locate is barred at haiku for the rest of this session (2 rejected, policy §8); route it one tier up')
  expect(boardOf(w)).toEqual(before)
  // the same kind one tier up, another kind at haiku, and h3 (already declared) are accepted
  const again: any = await declare($, w, [unit('s9', 'sonnet', { kind: 'locate' }), unit('e1', 'haiku', { kind: 'extract' })])
  expect(again.result).toMatch(/^board updated/)
  expect(boardOf(w).units.map(u => u.id)).toEqual(['h3', 'r1', 'r2', 's9', 'e1'])
})

test('a selected leads card keeps its selection across ticks while it is in the leads row', async ($, on) => {
  const w = world()
  const clock = engine(on, w)
  await start($)
  await declare($, w, [unit('h1', 'haiku')])
  await spawn($, 'Find call sites', { name: 'h1', subagentType: workerType('haiku') })
  const ui: any = await $.ui.mount({ plugin: 'flowestra', component: 'Pane', requestId: 'flowestra', surface: 'terminal', props: PANE_PROPS(96) })
  await ui.post({ select: 'agent-find' }, { in: 'agent-flow' })
  expect(w.ui?.selected).toBe('agent-find')
  await clock.advance(3000)
  expect(w.ui?.selected).toBe('agent-find')
  expect((await flowOf(ui)).leads.find(c => c.id === 'agent-find')?.selected).toBe(true)
  // it ends and lingers, then leaves its row: the selection goes with it
  await complete($, 'agent-find', 'answer')
  await declare($, w, [unit('h1', 'haiku', { verdict: 'accepted' })]) // checked: no longer held (B3.3)
  await clock.advance(1000)
  expect(w.ui?.selected).toBe('agent-find')
  await clock.advance(2000)
  expect(w.ui?.selected).toBeNull()
  await ui.unmount()
})

// ---------------------------------------------------------------- the audit file

test('a covered spawn appends one line to the session\'s audit file; two leave two lines in order', async ($, on) => {
  const w = world()
  const clock = engine(on, w)
  await start($)
  await declare($, w, [unit('s1'), unit('h1', 'haiku')])
  await spawn($, 'Write the module', { name: 's1' })
  const first = `${new Date(T0).toISOString()} | s1 | agent-write | ${AUDIT.sonnet}\n`
  expect(w.files[AUDIT_FILE]).toBe(first)
  await clock.advance(1500)
  await spawn($, 'Find call sites', { name: 'h1', subagentType: workerType('haiku') })
  expect(w.files[AUDIT_FILE]).toBe(`${first}${new Date(T0 + 1500).toISOString()} | h1 | agent-find | ${AUDIT.haiku}\n`)
  expect(auditWrites(w).map(x => x.path)).toEqual([AUDIT_FILE, AUDIT_FILE])
})

test('an uncovered spawn the gate lets through, and a refused one, append nothing', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await spawn($, 'Forked run', { subagentType: 'fork', fork: true })
  await spawn($, 'Statusline run', { subagentType: 'statusline-setup' })
  await spawn($, 'Nested run', { parentAgentId: 'agent-forked' })
  await spawn($, 'Refused run', { name: 'x1' })
  expect(w.fsWrites).toEqual([]) // nothing at all: no audit line, no journal entry (no tiered unit covers any)
})

test('the audit file falls back to USERPROFILE, then to the mod\'s own folder', async ($, on) => {
  const w = world({ env: {} })
  engine(on, w)
  await start($)
  await declare($, w, [unit('s1')])
  await spawn($, 'Write the module', { name: 's1' })
  expect(auditWrites(w)).toHaveLength(1)
  expect(auditWrites(w)[0]!.path).toMatch(/\/data\/flowestra\/audit\/sess-1\.log$/) // <plugin root>/data
  expect(auditWrites(w)[0]!.path).not.toContain('.claude/flowestra/audit')
})

test('the audit file under USERPROFILE when HOME is unset', async ($, on) => {
  const w = world({ env: { USERPROFILE: '/users/tester/' } })
  engine(on, w)
  await start($)
  await declare($, w, [unit('s1')])
  await spawn($, 'Write the module', { name: 's1' })
  expect(auditWrites(w).map(x => x.path)).toEqual([`/users/tester/.claude/flowestra/audit/${SESSION}.log`])
})

test('an audit file that cannot be written never breaks the spawn', async ($, on) => {
  const w = world({ failFsWrite: true })
  engine(on, w)
  await start($)
  await declare($, w, [unit('s1'), unit('s2')])
  expect(await spawn($, 'Write the module', { name: 's1' })).toEqual({ model: SONNET, agentId: 'agent-write' })
  expect(boxOf(boardOf(w), 'agent-write').status).toBe('starting')
  // the queue carries on after a failed append
  w.failFsWrite = false
  await spawn($, 'Test the module', { name: 's2' })
  expect(w.files[AUDIT_FILE]).toBe(`${new Date(T0).toISOString()} | s2 | agent-test | ${AUDIT.sonnet}\n`)
})

// ---------------------------------------------------------------- the tracked line

test('the tool\'s tracked line marks the tier, NO AUDIT, TIER MISMATCH and the barred kinds', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await declare($, w, [unit('h1', 'haiku'), unit('s1'), unit('s2')])
  await spawn($, 'Find call sites', { name: 'h1', subagentType: workerType('haiku') })
  await spawn($, 'Write the module', { name: 's1' })
  await spawn($, 'Nested helper', { parentAgentId: 'agent-write' })
  w.spawnModel = HAIKU // the engine puts s2's sonnet worker on Haiku
  await spawn($, 'Mismatched run', { name: 's2' })
  w.spawnModel = null
  const r: any = await declare($, w, [
    unit('r1', 'haiku', { verdict: 'rejected' }),
    unit('r2', 'haiku', { verdict: 'rejected' }),
    unit('t1', 'sonnet', { kind: 'tests', verdict: 'rejected' }),
    unit('t2', 'sonnet', { kind: 'tests', verdict: 'rejected' }),
  ])
  expect(r.result).toContain(' | tracked workers: ')
  expect(r.result).toContain('Find call sites [starting, haiku, unit h1, no tokens]')
  expect(r.result).toContain('Write the module [starting, sonnet, unit s1, no tokens]')
  expect(r.result).toContain('Nested helper [starting, sonnet, NO AUDIT, no tokens]')
  expect(r.result).toContain('Mismatched run [starting, haiku, TIER MISMATCH, unit s2, no tokens]')
  expect(r.result).toMatch(/ \| barred: haiku locate, sonnet tests$/)
})

// ---------------------------------------------------------------- 0.7.0: the config root

const JOURNAL = `${HOME}/.claude/flowestra/journal`
const MAIN_KEY = repoKey('/work/main')
const TASK1 = `${JOURNAL}/${MAIN_KEY}/task-1`

/** A unit as journal.ts and state.ts keep it (every field). */
function fullUnit(id: string, extra: Record<string, unknown> = {}): any {
  return { id, label: `Do ${id}`, wave: 1, dependsOn: [], declared: null, tier: 'sonnet', kind: 'implement', audit: AUDIT.sonnet, verdict: null, spec: null, context: [], ...extra }
}

test('the config root: CLAUDE_CONFIG_DIR holds the audit file and the journal; the answer names both paths', async ($, on) => {
  const w = world({ env: { HOME, CLAUDE_CONFIG_DIR: '/cfg' } })
  engine(on, w)
  await start($)
  const r: any = await declare($, w, [unit('s1')])
  expect(r.result.split('\n')).toContain(`journal: /cfg/flowestra/journal/${MAIN_KEY}/task-1`)
  expect(r.result.split('\n')).toContain(`audit file: /cfg/flowestra/audit/${SESSION}.log`)
  await spawn($, 'Write the module', { name: 's1' })
  expect(w.files[`/cfg/flowestra/audit/${SESSION}.log`]).toMatch(/ \| s1 \| agent-write \| /)
  expect(Object.keys(w.files).some(p => p.startsWith(`/cfg/flowestra/journal/${MAIN_KEY}/task-1/unset/`))).toBe(true)
  expect(Object.keys(w.files).filter(p => p.startsWith(HOME))).toEqual([])
})

// ---------------------------------------------------------------- 0.7.0: opening, switching, resuming tasks

test('AgentBoard: a taskId with a task line opens it, its repo the session\'s repository (else its root); the answer carries its state and paths', async ($, on) => {
  const w = world({ repo: '/work/repo-a' })
  engine(on, w)
  await start($)
  const r: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, taskId: 'wb-ui', task: 'Build the UI', phase: 'design' } as any)
  const key = repoKey('/work/repo-a')
  const lines: string[] = r.result.split('\n')
  expect(lines[0]).toBe('board updated: task wb-ui, task set, phase design')
  expect(lines.slice(1, 5)).toEqual(['task wb-ui · open · Build the UI', 'repo: /work/repo-a', 'design · wave -', `updated ${isoOf(T0)} by session ${SESSION}`])
  expect(lines.slice(-3)).toEqual([`journal: ${JOURNAL}/${key}/wb-ui`, `audit file: ${AUDIT_FILE}`, 'tracked workers: none'])
  expect(boardOf(w).taskId).toBe('wb-ui')
  expect(boardOf(w).repo).toBe('/work/repo-a')
  // its state files, its line in the repository index and the repository's line in the root index
  expect(parseStateJson(w.files[`${JOURNAL}/${key}/wb-ui/state.json`]!)).toMatchObject({ taskId: 'wb-ui', task: 'Build the UI', repo: '/work/repo-a', phase: 'design', status: 'open' })
  expect(w.files[`${JOURNAL}/${key}/wb-ui/state.md`]).toMatch(/^task wb-ui · open · Build the UI\nrepo: \/work\/repo-a\n/)
  expect(w.files[`${JOURNAL}/${key}/index.md`]).toContain(`\nwb-ui | open | design | 0 | ${isoOf(T0)} | Build the UI\n`)
  expect(w.files[`${JOURNAL}/index.md`]).toContain(`\n${key} | /work/repo-a | 1 | 1 | ${isoOf(T0)}\n`)
  // no repository: the session's root; the summary names the other open task
  w.repo = null
  const r2: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, taskId: 'cr-fix', task: 'Fix the crash' } as any)
  expect(r2.result.split('\n')[0]).toBe('board updated: task cr-fix (open: wb-ui), task set')
  expect(boardOf(w).repo).toBe('/work/main')
  expect(boardOf(w).parked.map(t => t.taskId)).toEqual(['wb-ui'])
  // a repo given is kept
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, taskId: 'ext', task: 'Elsewhere', repo: '/work/ext' } as any)
  expect(boardOf(w).repo).toBe('/work/ext')
})

test('AgentBoard: a taskId no task and no state file has, with no task line, is refused and the board is unchanged', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  const before = boardOf(w)
  const r: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, taskId: 'ghost', phase: 'design' } as any)
  expect(r.result).toBeUndefined()
  expect(r.deny).toBe('task "ghost" is not open: give its task line to open it (and its repo when it is not this session\'s folder)')
  expect(boardOf(w)).toEqual(before)
})

test('AgentBoard: switching names the other open tasks, answers the task\'s state; a later update answers one line', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, taskId: 'wb-ui', task: 'Build the UI', phase: 'design' } as any)
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, taskId: 'ab-journal', task: 'Write the journal' } as any)
  const r: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, taskId: 'wb-ui' } as any)
  const lines: string[] = r.result.split('\n')
  expect(lines[0]).toBe('board updated: task wb-ui (open: ab-journal)')
  expect(lines[1]).toBe('task wb-ui · open · Build the UI')
  expect(lines).toContain(`journal: ${JOURNAL}/${MAIN_KEY}/wb-ui`)
  const later: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, phase: 'executing' } as any)
  expect(later.result).toBe('board updated: task wb-ui (open: ab-journal), phase executing | tracked workers: none')
  // closing: the closed task is named, the open one listed, and the answer carries the task now active
  const closed: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, close: true } as any)
  expect(closed.result.split('\n')[0]).toBe('board updated: task wb-ui (open: ab-journal), closed')
  expect(closed.result.split('\n')[1]).toBe('task ab-journal · open · Write the journal')
  expect(parseStateJson(w.files[`${JOURNAL}/${MAIN_KEY}/wb-ui/state.json`]!)?.status).toBe('closed')
  expect(w.files[`${JOURNAL}/${MAIN_KEY}/index.md`]).toContain('\nwb-ui | closed | executing | 0 |')
})

test('AgentBoard: a taskId with no task line is resumed from the journal\'s state.json, units and verdicts included', async ($, on) => {
  const w = world()
  engine(on, w)
  const slot = {
    taskId: 'old-task', task: 'Old work', repo: '/work/main', phase: 'review', wave: 3, status: 'closed', activeAt: T0 - 9_000_000,
    units: [fullUnit('s1', { verdict: 'accepted' }), fullUnit('s2', { dependsOn: ['s1'] })],
  }
  w.files[`${JOURNAL}/${MAIN_KEY}/old-task/state.json`] = stateJson({
    slot: slot as any, sessionId: 'sess-older-1', updatedMs: T0 - 2 * 3_600_000, unitStates: {}, latestEntries: {}, recentEntries: [],
  })
  await start($)
  const r: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, taskId: 'old-task' } as any)
  const b = boardOf(w)
  expect(b.taskId).toBe('old-task')
  expect(b.task).toBe('Old work')
  expect(b.phase).toBe('review')
  expect(b.wave).toBe(3)
  expect(b.units.map(u => [u.id, u.verdict])).toEqual([['s1', 'accepted'], ['s2', null]])
  const lines: string[] = r.result.split('\n')
  expect(lines[0]).toBe('board updated: task old-task')
  expect(lines[1]).toBe('task old-task · open · Old work')
  expect(lines).toContain('s1 | Do s1 | sonnet | implement | ready | accepted | - | - | -')
  expect(lines.some(l => l.includes('also updated by session'))).toBe(false) // two hours ago: no warning
  // the state file is now this session's, and open
  expect(parseStateJson(w.files[`${JOURNAL}/${MAIN_KEY}/old-task/state.json`]!)?.status).toBe('open')
  expect(w.files[`${JOURNAL}/${MAIN_KEY}/old-task/state.json`]).toContain(`"session": "${SESSION}"`)
})

test('AgentBoard: an update with no task id skips an id whose state.json is in the journal, and leaves its files alone', async ($, on) => {
  const w = world()
  engine(on, w)
  const old = stateJson({
    slot: { taskId: 'task-1', task: 'Old work', repo: '/work/main', phase: 'review', wave: 1, status: 'closed', activeAt: T0 - 9_000_000, units: [] } as any,
    sessionId: 'sess-older-1', updatedMs: T0 - 2 * 3_600_000, unitStates: {}, latestEntries: {}, recentEntries: [],
  })
  w.files[`${JOURNAL}/${MAIN_KEY}/task-1/state.json`] = old
  w.files[`${JOURNAL}/${MAIN_KEY}/task-1/state.md`] = 'old state'
  await start($)
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, task: 'New work', phase: 'design' } as any)
  expect(boardOf(w).taskId).toBe('task-2')
  expect(w.files[`${JOURNAL}/${MAIN_KEY}/task-1/state.json`]).toBe(old)
  expect(w.files[`${JOURNAL}/${MAIN_KEY}/task-1/state.md`]).toBe('old state')
  expect(parseStateJson(w.files[`${JOURNAL}/${MAIN_KEY}/task-2/state.json`]!)).toMatchObject({ taskId: 'task-2', task: 'New work' })
})

test('AgentBoard: an update with no task id and nothing in the journal opens task-1', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, task: 'New work' } as any)
  expect(boardOf(w).taskId).toBe('task-1')
  expect(parseStateJson(w.files[`${JOURNAL}/${MAIN_KEY}/task-1/state.json`]!)).toMatchObject({ taskId: 'task-1', task: 'New work' })
})

test('AgentBoard: another session that updated the task within 30 minutes is named in the answer', async ($, on) => {
  const w = world()
  const clock = engine(on, w)
  w.files[`${JOURNAL}/${MAIN_KEY}/shared/state.json`] = stateJson({
    slot: { taskId: 'shared', task: 'Shared work', repo: '/work/main', phase: 'executing', wave: 1, status: 'open', activeAt: T0, units: [] } as any,
    sessionId: 'sess-other-9', updatedMs: T0 - 5 * 60_000, unitStates: {}, latestEntries: {}, recentEntries: [],
  })
  await start($)
  const r: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, taskId: 'shared' } as any)
  const lines: string[] = r.result.split('\n')
  expect(lines[lines.length - 2]).toBe('task shared was also updated by session sess-oth 5m ago')
  expect(lines[lines.length - 1]).toBe('tracked workers: none')
  // the other session writes again; this session's next update warns again, on its summary's own lines
  await clock.advance(60_000)
  w.files[`${JOURNAL}/${MAIN_KEY}/shared/state.json`] = stateJson({
    slot: { taskId: 'shared', task: 'Shared work', repo: '/work/main', phase: 'executing', wave: 1, status: 'open', activeAt: T0, units: [] } as any,
    sessionId: 'sess-other-9', updatedMs: T0, unitStates: {}, latestEntries: {}, recentEntries: [],
  })
  const again: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, wave: 2 } as any)
  expect(again.result).toBe('board updated: wave 2\ntask shared was also updated by session sess-oth 1m ago\ntracked workers: none')
  // its own write is no warning
  const own: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, wave: 3 } as any)
  expect(own.result).toBe('board updated: wave 3 | tracked workers: none')
})

test('AgentBoard: the state block is at most 40 lines, the rest one line naming how many were cut and the state file', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  const units = Array.from({ length: 45 }, (_, i) => unit(`u${i}`))
  const r: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, taskId: 'big', task: 'A big task', units } as any)
  const lines: string[] = r.result.split('\n')
  // state.md: 6 header lines, 45 unit lines, a blank, "newest entries:", "none" = 54
  expect(lines[1]).toBe('task big · open · A big task')
  expect(lines[40]).toBe(`[15 more lines cut; the whole state is in ${JOURNAL}/${MAIN_KEY}/big/state.md]`)
  expect(lines[41]).toBe(`journal: ${JOURNAL}/${MAIN_KEY}/big`)
  expect(w.files[`${JOURNAL}/${MAIN_KEY}/big/state.md`]!.split('\n')).toHaveLength(55) // the file is whole
})

test('the tracked line: the active task\'s workers, a live worker of another task with its task, then other tasks\' ended workers', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, taskId: 't-a', task: 'Task A', units: [unit('s1')] } as any)
  await spawn($, 'Write the module', { name: 's1' })
  const r: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, taskId: 't-b', task: 'Task B' } as any)
  expect(r.result.split('\n').pop()).toBe('tracked workers: Write the module [starting, sonnet, unit s1, no tokens, task t-a]')
  await complete($, 'agent-write', 'answer')
  const later: any = await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, phase: 'design' } as any)
  expect(later.result).toBe('board updated: task t-b (open: t-a), phase design | tracked workers: none | other tasks: 1 ended')
})

// ---------------------------------------------------------------- 0.7.0: the journal

test('the journal: a covered spawn writes its entry, the indexes up the chain, the shards and the state files; completion and verdict rewrite them', async ($, on) => {
  const w = world()
  const clock = engine(on, w)
  await start($)
  await declare($, w, [unit('s1', 'sonnet', { label: 'Write the module' })], { phase: 'executing', wave: 2 })
  await spawn($, 'Write the module', { name: 's1', prompt: 'Build it.\nAll of it.' })
  const name = entryName(T0, 's1', 'agent-write')
  const folder = `${TASK1}/executing`
  const path = `${folder}/${name}.md`
  const data: any = {
    taskId: 'task-1', unitId: 's1', label: 'Write the module', audit: AUDIT.sonnet, tier: 'sonnet', kind: 'implement', phase: 'executing', wave: 2,
    agentId: 'agent-write', subagentType: workerType('sonnet'), model: SONNET, sessionId: SESSION, cwd: '/work/main', context: [],
    spawnedMs: T0, endedMs: null, status: 'running', verdict: null, verdictMs: null, brief: 'Build it.\nAll of it.', result: null, resumes: [],
  }
  expect(w.files[path]).toBe(buildEntry(name, data).text)
  const line = (over: Record<string, unknown>) =>
    phaseIndexLine({ file: `${name}.md`, unitId: 's1', tier: 'sonnet', kind: 'implement', status: 'running', verdict: null, briefChars: 20, resultChars: null, audit: AUDIT.sonnet, ...over } as any)
  expect(w.files[`${folder}/index.md`]).toBe(`# phase executing · 1 · updated ${isoOf(T0)}\n${line({})}\n`)
  expect(w.files[`${folder}/.shards/${SESSION}.tsv`]).toBe(`${shardLine(T0, `${name}.md`, line({}))}\n`)
  expect(w.files[`${TASK1}/index.md`]).toBe(`# task task-1 · 1 · updated ${isoOf(T0)}\nexecuting | 1 | 0/0/1 | ${isoOf(T0)}\nstate.md\n`)
  expect(w.files[`${JOURNAL}/${MAIN_KEY}/index.md`]).toBe(`# repo ${MAIN_KEY} · 1 · updated ${isoOf(T0)}\ntask-1 | open | executing | 1 | ${isoOf(T0)} |\n`) // no title: the empty last field (shard lines are trimmed)
  expect(w.files[`${JOURNAL}/index.md`]).toBe(`# root journal · 1 · updated ${isoOf(T0)}\n${MAIN_KEY} | /work/main | 1 | 1 | ${isoOf(T0)}\n`)
  for (const index of [`${folder}/index.md`, `${TASK1}/index.md`, `${JOURNAL}/index.md`]) {
    for (const l of w.files[index]!.split('\n')) expect(l.length).toBeLessThanOrEqual(160)
  }
  const md = w.files[`${TASK1}/state.md`]!
  expect(md).toContain(`\ns1 | Write the module | sonnet | implement | running | unchecked | - | - | ${path}\n`)
  expect(md).toContain(`\nnewest entries:\n${path}\n`)
  expect(parseStateJson(w.files[`${TASK1}/state.json`]!)?.units.map(u => u.id)).toEqual(['s1'])

  // completion: result and status, the phase line, the state files
  await clock.advance(60_000)
  await complete($, 'agent-write', 'answer', 'All built.')
  const done = { ...data, endedMs: T0 + 60_000, status: 'done', result: 'All built.' }
  expect(w.files[path]).toBe(buildEntry(name, done).text)
  expect(w.files[`${folder}/index.md`]).toContain(line({ status: 'done', resultChars: 10 }))
  expect(w.files[`${TASK1}/state.md`]).toContain(`\ns1 | Write the module | sonnet | implement | done | unchecked | - | - | ${path}\n`)

  // the verdict: the entry's verdict line, the phase and task index lines, the state files
  await clock.advance(5_000)
  await declare($, w, [unit('s1', 'sonnet', { label: 'Write the module', verdict: 'accepted' })])
  expect(w.files[path]).toBe(buildEntry(name, { ...done, verdict: 'accepted', verdictMs: T0 + 65_000 }).text)
  expect(w.files[path]).toContain(`\nverdict: accepted · at ${isoOf(T0 + 65_000)}\n`)
  expect(w.files[`${folder}/index.md`]).toContain(line({ status: 'done', resultChars: 10, verdict: 'accepted' }))
  expect(w.files[`${TASK1}/index.md`]).toContain(`\nexecuting | 1 | 1/0/0 | ${isoOf(T0 + 65_000)}\n`)
  expect(w.files[`${TASK1}/state.md`]).toContain('\ns1 | Write the module | sonnet | implement | done | accepted |')
})

test('the journal: an uncovered spawn writes no entry', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await declare($, w, [unit('s1')])
  const before = Object.keys(w.files).length
  await spawn($, 'Nested helper', { parentAgentId: 'agent-x' })
  await spawn($, 'Statusline run', { subagentType: 'statusline-setup' })
  expect(Object.keys(w.files)).toHaveLength(before)
})

test('the journal: two sessions\' shards merge into one index (J1); this session writes only its own shard', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await declare($, w, [unit('s1')], { phase: 'executing' })
  const folder = `${TASK1}/executing`
  const theirs = '20231114-000000-s9-agent-ot.md'
  const theirLine = phaseIndexLine({ file: theirs, unitId: 's9', tier: 'opus', kind: 'design', status: 'done', verdict: 'rejected', briefChars: 5, resultChars: 7, audit: AUDIT.opus })
  const theirShard = `${shardLine(T0 - 1000, theirs, theirLine)}\n`
  w.files[`${folder}/.shards/sess-oth.tsv`] = theirShard
  await spawn($, 'Write the module', { name: 's1' })
  const name = `${entryName(T0, 's1', 'agent-write')}.md`
  const index = w.files[`${folder}/index.md`]!.split('\n')
  expect(index[0]).toBe(`# phase executing · 2 · updated ${isoOf(T0)}`)
  expect(index.slice(1, 3).map(l => l.split(' | ')[0])).toEqual([theirs, name]) // ordered by key
  expect(w.files[`${folder}/.shards/sess-oth.tsv`]).toBe(theirShard) // never written by this session
  expect(w.fsWrites.some(x => x.path.endsWith('/sess-oth.tsv'))).toBe(false)
  expect(w.files[`${TASK1}/index.md`]).toContain('\nexecuting | 2 | 0/1/1 |')
})

test('the journal: a verdict on an entry another session wrote touches only this session\'s shard', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await declare($, w, [unit('s9', 'opus', { kind: 'design' })], { phase: 'executing' })
  const folder = `${TASK1}/executing`
  const theirs = '20231114-000000-s9-agent-ot.md'
  const theirLine = phaseIndexLine({ file: theirs, unitId: 's9', tier: 'opus', kind: 'design', status: 'done', verdict: null, briefChars: 5, resultChars: 7, audit: AUDIT.opus })
  w.files[`${folder}/.shards/sess-oth.tsv`] = `${shardLine(T0 - 1000, theirs, theirLine)}\n`
  w.files[`${folder}/${theirs}`] = 'their entry'
  await declare($, w, [unit('s9', 'opus', { kind: 'design', verdict: 'accepted' })])
  expect(w.files[`${folder}/${theirs}`]).toBe('their entry')
  expect(w.files[`${folder}/.shards/${SESSION}.tsv`]).toContain(`\t${theirs}\t${theirs} | s9 | opus | design | done | accepted |`)
  expect(w.files[`${folder}/index.md`]).toContain(`\n${theirs} | s9 | opus | design | done | accepted |`)
  expect(w.files[`${TASK1}/index.md`]).toContain('\nexecuting | 1 | 1/0/0 |')
})

test('the journal: a write that fails never breaks the spawn, the completion or the tool; the queue carries on', async ($, on) => {
  const w = world({ failJournal: true })
  engine(on, w)
  await start($)
  const r: any = await declare($, w, [unit('s1'), unit('s2')])
  expect(r.result).toMatch(/^board updated/)
  expect(await spawn($, 'Write the module', { name: 's1' })).toEqual({ model: SONNET, agentId: 'agent-write' })
  expect(boxOf(boardOf(w), 'agent-write').status).toBe('starting')
  expect(w.files[AUDIT_FILE]).toMatch(/ \| s1 \| agent-write \| /) // the audit file has its own queue
  expect(await complete($, 'agent-write', 'answer')).toEqual({ text: '' })
  expect(Object.keys(w.files).filter(p => p.includes('/journal/'))).toEqual([])
  w.failJournal = false
  await spawn($, 'Test the module', { name: 's2' })
  expect(w.files[`${TASK1}/unset/${entryName(T0, 's2', 'agent-test')}.md`]).toMatch(/^# task-1 · s2 · Do s2\n/)
})

// ---------------------------------------------------------------- 0.7.0: context (W3)

test('context: a path#heading item is inlined into the prompt next receives; the entry keeps the brief as written', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  w.files['/docs/decisions.md'] = '# Decisions\n## Alpha\nalpha text\n## Beta\nbeta text\n'
  await declare($, w, [unit('s1', 'sonnet', { context: ['/docs/decisions.md#Alpha'] })])
  expect(await spawn($, 'Write the module', { name: 's1', prompt: 'Build it.' })).toEqual({ model: SONNET, agentId: 'agent-write' })
  expect(w.spawned[0].prompt).toBe('Build it.\n\nContext (inlined by the Agent Board from /docs/decisions.md):\n## Alpha\nalpha text')
  const entry = w.files[`${TASK1}/unset/${entryName(T0, 's1', 'agent-write')}.md`]!
  expect(entry).toContain('\ncwd: /work/main · context: /docs/decisions.md#Alpha (inlined 19 chars)\n')
  expect(entry).toContain('\n## Brief\nBuild it.\n## Result\n')
})

test('context: an item that names no file, or a heading the file lacks, is refused', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  w.files['/docs/decisions.md'] = '# Decisions\n## Alpha\nalpha text\n'
  await declare($, w, [
    unit('s1', 'sonnet', { context: ['/docs/decisions.md', '/docs/none.md'] }),
    unit('s2', 'sonnet', { context: ['/docs/decisions.md#Gamma'] }),
    unit('s3', 'sonnet', { context: ['task-1:nothing'] }),
  ])
  await expectRefused($, w, 'Write the module', { name: 's1' }, denyContext('s1', '/docs/none.md'), 's1')
  await expectRefused($, w, 'Write the module', { name: 's2' }, denyContext('s2', '/docs/decisions.md#Gamma'), 's2')
  await expectRefused($, w, 'Write the module', { name: 's3' }, denyContext('s3', 'task-1:nothing'), 's3')
})

test('context: <task>:<unit> resolves to that unit\'s newest entry, its header and result inlined', async ($, on) => {
  const w = world()
  const clock = engine(on, w)
  await start($)
  await declare($, w, [unit('s1')])
  await spawn($, 'One try', { name: 's1', prompt: 'first brief' })
  await complete($, 'agent-one', 'answer', 'first answer')
  await clock.advance(1000)
  await spawn($, 'Two tries', { name: 's1', prompt: 'second brief' })
  await complete($, 'agent-two', 'answer', 'second answer')
  await declare($, w, [unit('s3', 'sonnet', { context: ['task-1:s1'] })])
  await spawn($, 'Use the result', { name: 's3', prompt: 'Go on.' })
  const prompt: string = w.spawned[2].prompt
  const path = `${TASK1}/unset/${entryName(T0 + 1000, 's1', 'agent-two')}.md`
  expect(prompt).toMatch(new RegExp(`^Go on\\.\\n\\nContext \\(inlined by the Agent Board from ${path.replace(/[.]/g, '\\.')}\\):\\n# task-1 · s1 · Do s1\\n`))
  expect(prompt).toContain('\n## Result\nsecond answer')
  expect(prompt).not.toContain('first answer')
  expect(prompt).not.toContain('second brief') // the brief is left out
})

test('context: a resolution that throws fails open: the spawn goes through with its prompt as written', async ($, on) => {
  const w = world({ ghosts: ['/docs/unreadable.md'] })
  engine(on, w)
  await start($)
  await declare($, w, [unit('s1', 'sonnet', { context: ['/docs/unreadable.md'] })])
  expect(await spawn($, 'Write the module', { name: 's1', prompt: 'Build it.' })).toEqual({ model: SONNET, agentId: 'agent-write' })
  expect(w.spawned[0].prompt).toBe('Build it.')
})

// ---------------------------------------------------------------- 0.7.0: cwd (B2, P1 yes)

test('cwd: a covered spawn runs in the task\'s repository when it differs from the session root, and not otherwise', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, taskId: 'ext', task: 'Elsewhere', repo: '/work/other', units: [unit('s1'), unit('s2')] } as any)
  await spawn($, 'Write the module', { name: 's1' })
  expect(w.spawned[0].cwd).toBe('/work/other')
  expect(w.files[`${JOURNAL}/${repoKey('/work/other')}/ext/unset/${entryName(T0, 's1', 'agent-write')}.md`]).toContain('\ncwd: /work/other · context: none\n')
  // a cwd the call gives is kept
  await spawn($, 'Test the module', { name: 's2', cwd: '/work/given' })
  expect(w.spawned[1].cwd).toBe('/work/given')
  // a task in the session's root: no cwd; an uncovered (nested) spawn: none either
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, taskId: 'home', task: 'Here', units: [unit('s3')] } as any)
  await spawn($, 'Fix the module', { name: 's3' })
  expect(w.spawned[2].cwd).toBeUndefined()
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, taskId: 'ext' } as any)
  await spawn($, 'Nested helper', { parentAgentId: 'agent-write' })
  expect(w.spawned[3].cwd).toBeUndefined()
})

// ---------------------------------------------------------------- 0.7.1: the repository's CLAUDE.md (P2 no)

const EXT = (units: any[]) => ({ tool: BOARD_TOOL_FULL_NAME, taskId: 'ext', task: 'Elsewhere', repo: '/work/other', units }) as any
const CLAUDE_BLOCK = 'Context (inlined by the Agent Board from /work/other/CLAUDE.md):\nrepo rules'

test('claude.md: a Sonnet and an Opus unit of a task in another repo get <repo>/CLAUDE.md first, then their own items; the entry lists it', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  w.files['/work/other/CLAUDE.md'] = 'repo rules'
  w.files['/docs/decisions.md'] = '# Decisions\n## Alpha\nalpha text\n'
  await $.tool.call(EXT([unit('s1', 'sonnet', { context: ['/docs/decisions.md#Alpha'] }), unit('o1', 'opus', { kind: 'design', audit: AUDIT.opus })]))
  await spawn($, 'Write the module', { name: 's1', prompt: 'Build it.' })
  expect(w.spawned[0].prompt).toBe(`Build it.\n\n${CLAUDE_BLOCK}\n\nContext (inlined by the Agent Board from /docs/decisions.md):\n## Alpha\nalpha text`)
  const entry = w.files[`${JOURNAL}/${repoKey('/work/other')}/ext/unset/${entryName(T0, 's1', 'agent-write')}.md`]!
  expect(entry).toContain('\ncwd: /work/other · context: /work/other/CLAUDE.md (inlined 10 chars), /docs/decisions.md#Alpha (inlined 19 chars)\n')
  await spawn($, 'Design the module', { name: 'o1', subagentType: workerType('opus'), prompt: 'Plan it.' })
  expect(w.spawned[1].prompt).toBe(`Plan it.\n\n${CLAUDE_BLOCK}`)
})

test('claude.md: not added for a Haiku unit, a task in the session root, a missing file, or a unit whose context names it', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  w.files['/work/other/CLAUDE.md'] = 'repo rules'
  w.files['/work/main/CLAUDE.md'] = 'main rules'
  await $.tool.call(EXT([unit('h1', 'haiku', { kind: 'locate', audit: AUDIT.haiku }), unit('s1', 'sonnet', { context: ['/work/other/CLAUDE.md#Rules'] }), unit('s2', 'sonnet', { context: ['/work/other/CLAUDE.md'] })]))
  await spawn($, 'Find it', { name: 'h1', subagentType: workerType('haiku'), prompt: 'Look.' })
  expect(w.spawned[0].prompt).toBe('Look.')
  w.files['/work/other/CLAUDE.md'] = '# Rules\nrepo rules\n'
  await spawn($, 'Write the module', { name: 's1', prompt: 'Build it.' })
  expect(w.spawned[1].prompt).toBe('Build it.\n\nContext (inlined by the Agent Board from /work/other/CLAUDE.md):\n# Rules\nrepo rules')
  await spawn($, 'Test the module', { name: 's2', prompt: 'Test it.' })
  expect(w.spawned[2].prompt.match(/inlined by the Agent Board/g)).toHaveLength(1)
  // a task in the session's root
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, taskId: 'home', task: 'Here', units: [unit('s3')] } as any)
  await spawn($, 'Fix the module', { name: 's3', prompt: 'Fix it.' })
  expect(w.spawned[3].prompt).toBe('Fix it.')
  // the file does not exist
  delete w.files['/work/other/CLAUDE.md']
  await $.tool.call({ tool: BOARD_TOOL_FULL_NAME, taskId: 'ext' } as any)
  await $.tool.call(EXT([unit('s4')]))
  await spawn($, 'Write more', { name: 's4', prompt: 'More.' })
  expect(w.spawned[4].prompt).toBe('More.')
})

test('claude.md: an unreadable file is skipped silently, with no refusal', async ($, on) => {
  const w = world({ ghosts: ['/work/other/CLAUDE.md'] })
  engine(on, w)
  await start($)
  await $.tool.call(EXT([unit('s1')]))
  expect(await spawn($, 'Write the module', { name: 's1', prompt: 'Build it.' })).toEqual({ model: SONNET, agentId: 'agent-write' })
  expect(w.spawned[0].prompt).toBe('Build it.')
})

// ---------------------------------------------------------------- 0.7.0: forks (B2)

test('forks: the Agent tool call with subagent_type fork is refused with denyFork\'s text; other Agent calls pass untouched; fork is hidden', async ($, on) => {
  const w = world()
  engine(on, w)
  await start($)
  const r: any = await $.tool.call({ tool: 'Agent', subagent_type: 'fork', prompt: 'carry on', description: 'Fork it' } as any)
  expect(r).toEqual({ deny: denyFork() })
  expect(logOf(w).entries.map(e => e.text)).toEqual(['spawn refused: fork'])
  const ok: any = await $.tool.call({ tool: 'Agent', subagent_type: workerType('sonnet'), prompt: 'go', description: 'Write it' } as any)
  expect(ok).toEqual({ result: 'ran' })
  expect(boxOf(boardOf(w), 'main').lastTool).toBe('Agent') // the bookkeeping hook still saw it
  expect(await offer($, 'fork')).toEqual({ isOffered: false })
  // the gate refuses one that reaches agent.spawn
  expect(await spawn($, 'Forked run', { subagentType: 'fork', fork: true })).toEqual({ deny: denyFork() })
  expect(w.spawnCalls).toBe(0)
})

// ---------------------------------------------------------------- 0.7.0: rebuilding an entry after a hot reload

test('an entry file reads back to the data it was built from (the rebuild after a hot reload empties the module map)', () => {
  const data: any = {
    taskId: 'wb-ui', unitId: 'u-2', label: 'Write the view', audit: AUDIT.sonnet, tier: 'sonnet', kind: 'implement', phase: 'executing', wave: 2,
    agentId: 'agent-abcdef12', subagentType: workerType('sonnet'), model: SONNET, sessionId: SESSION, cwd: '/work/a',
    context: [{ item: '/docs/d.md#A', status: 'inlined 19 chars' }, { item: 'wb-ui:u-1', status: 'cut at 32000 of 40000' }],
    spawnedMs: T0, endedMs: T0 + 5000, status: 'done', verdict: 'accepted', verdictMs: T0 + 9000,
    brief: 'line one\nline two', result: 'the answer\n\nwith a gap', resumes: [{ message: 'one more', result: 'more answer' }],
  }
  const name = entryName(T0, 'u-2', 'agent-abcdef12')
  expect(entryFromText(buildEntry(name, data).text)).toEqual(data)
  const running = { ...data, endedMs: null, status: 'running', verdict: null, verdictMs: null, result: null, resumes: [], context: [], phase: null, wave: null }
  expect(entryFromText(buildEntry(name, running).text)).toEqual(running)
  expect(entryFromText('not an entry')).toBeNull()
})

test('an entry whose brief, messages and results hold section lines reads back whole', () => {
  const tricky = 'a\n## Result\n## Message 2  \n\\## Brief\n## Result 2\nz'
  const data: any = {
    taskId: 'wb-ui', unitId: 'u-2', label: 'Write the view', audit: AUDIT.sonnet, tier: 'sonnet', kind: 'implement', phase: 'executing', wave: 2,
    agentId: 'agent-abcdef12', subagentType: workerType('sonnet'), model: SONNET, sessionId: SESSION, cwd: '/work/a',
    context: [], spawnedMs: T0, endedMs: T0 + 5000, status: 'done', verdict: null, verdictMs: null,
    brief: `## Brief\n${tricky}`, result: tricky, resumes: [{ message: tricky, result: `${tricky}\n## Result 3` }],
  }
  const name = entryName(T0, 'u-2', 'agent-abcdef12')
  expect(entryFromText(buildEntry(name, data).text)).toEqual(data)
})
