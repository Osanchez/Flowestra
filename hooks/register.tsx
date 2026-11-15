// Agent Board wiring (spec 2.2, 2.4, 2.7, 2.8, 7; visual layer 0.4.0; Model
// Routing Policy 0.6.0): every hook of the mod. Events feed the pure reducers in
// state.ts and detail.ts, the board, live, detail, ui and log values live in
// $.state, the pane and the band are drawn by view.tsx, and the orchestrator's
// tool, prompt sections (the board's and the Model Routing Policy's) and /board
// come from board.ts. The three tier workers (workers.ts) are registered at
// session start; the built-in types they replace are hidden from the model's
// listing. A worker's tier is measured from its model: Haiku workers are drawn
// in the leads row, everyone else in the workers row, each tied to the unit the
// orchestrator declared (tier, kind, audit line, verdict, spec).
//
// Where the files live (B3.5): one config root, CLAUDE_CONFIG_DIR when set and
// not empty, else `<HOME>/.claude`, else `<USERPROFILE>/.claude`, else
// `<plugin root>/data` (journal.ts's configRoot).
//
// The audit file: every spawn a declared unit covers appends one line,
// `<ISO time> | <unit id> | <agent id> | <audit line>`, to
// `<config root>/flowestra/audit/<session id>.log`. Appends are serialised
// through a queue of their own and never break the spawn.
//
// Tasks and the work journal (0.7.0): the AgentBoard tool opens, switches,
// resumes (from the journal's state.json) and closes tasks; its answer to an
// update that opens, resumes or switches a task carries that task's state.
// Every spawn a tiered unit covers gets a journal entry under
// `<config root>/flowestra/journal/<repo-key>/<task-id>/<phase>/` (brief at
// spawn, result at completion, verdict line when a verdict changes), with the
// indexes above it and the task's state.md / state.json. The journal is written
// through a queue of its own (journalQueue): a failure there never touches the
// spawn, the board or the tool's answer. Concurrent sessions (option J1): this
// session writes only its own entries and its own shard file
// (`.shards/<sid8>.tsv`) in each folder; every index.md is regenerated from the
// folder's shards, and once more if a shard changed while it was written.
//
// Every write to the board goes through changeBoard, which compares the board
// before and after and pushes what changed (a worker spawned or ended, the
// phase moved) onto the session log (log.ts). A reset (first load, /clear) is
// not logged; /clear empties the log.
//
// Board writes run one at a time: each changeBoard body (read before, update,
// read after, log push) is one link of a module-level promise chain
// (boardQueue), and so is the /clear reset. Events arrive concurrently (a
// subagent's turn.start races the agent.spawn hook's bookkeeping); without the
// queue two bodies could read the same `before` and both log one new worker.
// A link that throws rejects only its own caller; the chain carries on.
//
// The flow diagram (lead box, plan box, fan-out, worker cards, fan-in, return
// box) is a surface module (flow.client.tsx) drawn in the pane on the
// terminal: it animates on its own clock from the flow props handed here and
// posts `{ select: id }` (ui.message) when a worker card is pressed. Other
// surfaces get the view's own still stack. The 1-second clock keeps going
// while an ended worker's card lingers, so its card drops out of the props on
// time.
//
// Safety (2.8): the mod denies nothing but the AgentBoard tool's own answer,
// the spawns the Model Routing Policy does not allow (§1, §8, §9, a missing
// spec file, a context item that names no journal entry or file): the spawn
// gate (state.ts's spawnCheck), and forks: a fork from the main loop is refused
// by the gate, and an Agent tool call whose `subagent_type` is `fork` by a
// `tool.call` hook on the Agent tool. Every refusal path (the gate, the fork
// hook, the spec check, the context resolution) runs inside guard.ts's
// failOpen: an error in it refuses nothing. Hiding the built-in agent types and
// `fork` from the model's listing (agent.offer) is the same policy's §1.
//
// Rewrites: the mod changes a spawn it lets through in two ways only, both for
// a main-loop spawn a declared unit covers. When the unit names `context`, the
// text of each item is appended to the prompt (W3, under a heading saying it
// was inlined by the Agent Board); and when the call gives no `cwd` and the
// active task's repository differs from the session's root, `cwd` is set to
// that repository. Nothing else of a spawn is changed. Every other bit of
// bookkeeping is wrapped, so a failure inside it still hands on what `next(e)`
// gave.

import { atom, read, update } from 'claude-code'
import type { AgentSpawnInput, EngineInterface, Register, Timer, TurnUsage } from 'claude-code'

import type { Board, LogEntry, TaskSlot, Unit, Verdict } from '../types'
import { failOpen } from './guard'
import {
  auditPath,
  buildEntry,
  configRoot,
  entryName,
  entryPath,
  extractContext,
  fitLine,
  indexText,
  isoOf,
  journalRoot,
  mergeShards,
  parseContextItem,
  parseShard,
  parseStateJson,
  parseStateWriter,
  phaseDir,
  phaseIndexLine,
  repoDir,
  repoIndexLine,
  repoKey,
  rootIndexLine,
  shardLine,
  shardPath,
  sid8,
  stateJson,
  stateJsonPath,
  stateMd,
  stateMdPath,
  taskDir,
  taskIndexLine,
  unescapeSections,
  withContext,
} from './journal'
import type { ContextStatus, EntryData, EntryStatus, IndexLevel, ResolvedContext, StateInput } from './journal'
import {
  answerBoardCall,
  boardCommandText,
  registerBoardCommand,
  registerBoardTool,
  wantsBoardSection,
  withBoardSection,
} from './board'
import type { BoardToggleResult, BoardUpdate } from './board'
import {
  BOARD_SHAPE,
  LIVE_SHAPE,
  MAIN_ID,
  anythingLingering,
  anythingRunning,
  applyBoardUpdate,
  applyComplete,
  applySpawn,
  applyStep,
  applyToolCall,
  applyTurnStart,
  auditIssue,
  barred,
  barredUnit,
  coveringUnit,
  denyFork,
  emptyBoard,
  emptyLive,
  isQuiet,
  openTask,
  otherEnded,
  otherTaskOf,
  reconcile,
  resetBoard,
  rowAgents,
  shownBoxes,
  slotOf,
  spawnCheck,
  taskSlots,
  tierOf,
  unitState,
} from './state'
import type { CompleteInfo, ListEntry } from './state'
import {
  DETAIL_SHAPE,
  UI_SHAPE,
  detailComplete,
  detailSpawn,
  detailToolEnd,
  detailToolStart,
  dropSelection,
  emptyDetail,
  emptyUi,
  selectCard,
} from './detail'
import { LOG_SHAPE, emptyLog, logDiff, logPush } from './log'
import { drawBand, drawPane, flowProps } from './view'
import type { ViewModel } from './view'
import { registerWorkers, tierOfWorkerType } from './workers'

// The same values as state.ts's boardAtom and liveAtom (same refs, initial
// values and shape tags), made here because validate reads only an atom made
// in the file that passes it to read/update. The log's atom lives only here.
const boardAtom = atom({ plugin: 'flowestra', key: 'board' } as const, emptyBoard(0), { shape: BOARD_SHAPE })
const liveAtom = atom({ plugin: 'flowestra', key: 'live' } as const, emptyLive(), { shape: LIVE_SHAPE })
const detailAtom = atom({ plugin: 'flowestra', key: 'detail' } as const, emptyDetail(), { shape: DETAIL_SHAPE })
const uiAtom = atom({ plugin: 'flowestra', key: 'ui' } as const, emptyUi(), { shape: UI_SHAPE })
const logAtom = atom({ plugin: 'flowestra', key: 'log' } as const, emptyLog(), { shape: LOG_SHAPE })

const PANE_ID = 'flowestra'
const PANE_TITLE = 'Agent Board'
const TICK_MS = 1000
const RECONCILE_EVERY_TICKS = 5

// The running clock. A module variable is right here: a hot reload drops the
// old environment's timers together with this variable (reference: "timers
// run until cancelled or until the module reloads"), and the reloaded
// module's session.start starts a fresh one, so ticks never double.
let ticker: Timer | null = null
let ticks = 0

// The board-write queue: every changeBoard body and the /clear reset run as one
// link of this chain, in order, never interleaved. A module variable for the
// same reason as the clock's: a hot reload drops it with the old module.
let boardQueue: Promise<void> = Promise.resolve()

// The audit file's own append queue: each append (read, then write the whole
// file) is one link, so two spawns never lose a line to each other.
let auditQueue: Promise<void> = Promise.resolve()

// The journal's own write queue: every journal job (a spawn's entry, a
// completion, a verdict, a task's slot change) is one link, so two jobs never
// interleave their read-modify-writes of this session's shard files. Neither
// queue blocks the other.
let journalQueue: Promise<void> = Promise.resolve()

/** What this session needs to rewrite one of its own journal entries. */
type JournalEntry = {
  root: string // the journal root
  key: string // the repo key
  repo: string // the repository, absolute
  taskId: string
  phase: string // the phase folder ('unset' before any)
  name: string // the entry name (no .md)
  data: EntryData
}

// This session's own entries, by agent id: a module map, so a hot reload
// empties it; an entry missing from it is rebuilt on demand from its file
// (rebuildEntry), found through the board's box and the task's phase shards.
const journalEntries = new Map<string, JournalEntry>()

// This session's shard files, by path: child key → shard line. A module map
// rebuilt on demand by reading the file (only this session writes it).
const shardCache = new Map<string, Map<string, string>>()

/** Runs `body` as the next link of the journal queue; settles when it has run, never rejects. */
async function journaled(body: () => Promise<void>): Promise<void> {
  const link = journalQueue.then(body)
  journalQueue = link.catch(() => undefined)
  await link.catch(() => undefined)
}

/** Runs `body` as the next link of the board-write queue; settles (or rejects) with that link alone. */
function queued(body: () => Promise<void>): Promise<void> {
  const link = boardQueue.then(body)
  boardQueue = link.catch(() => undefined) // a failed link never breaks the chain
  return link
}

// ---------------------------------------------------------------- helpers ($ only in top-level declarations)

async function now($: EngineInterface): Promise<number> {
  return $.clock.now()
}

/**
 * Every write to the board but a reset: read it, apply `fn`, read it again,
 * and push what changed onto the session log, stamped `at`. The log's part is
 * wrapped: a failure there never loses the board update. The whole body is one
 * link of the board-write queue, so two calls never interleave.
 */
async function changeBoard($: EngineInterface, fn: (b: Board) => Board, at: number): Promise<void> {
  await queued(() => changeBoardNow($, fn, at))
}

/** changeBoard's body; run only as a link of the board-write queue. */
async function changeBoardNow($: EngineInterface, fn: (b: Board) => Board, at: number): Promise<void> {
  let before: Board | null = null
  try {
    before = await read($, boardAtom)
  } catch {
    before = null
  }
  await update($, boardAtom, fn)
  if (before === null) return
  try {
    const after = await read($, boardAtom)
    const entries = logDiff(before, after, at)
    if (entries.length > 0) await update($, logAtom, log => logPush(log, entries))
  } catch {
    // the log misses this change; the board has it
  }
}

/** The /clear reset of the board, through the queue so it never lands inside a link. */
async function resetBoardQueued($: EngineInterface, at: number): Promise<void> {
  await queued(async () => {
    await update($, boardAtom, () => resetBoard(at))
  })
}

/** Moves `live.now` to an event's time, so arrows and elapsed times match the board. */
async function touchNow($: EngineInterface, at: number): Promise<void> {
  await update($, liveAtom, live => ({ ...live, now: at }))
}

async function reconcileNow($: EngineInterface): Promise<void> {
  const list = (await $.agent.list()) as readonly ListEntry[]
  const at = await now($)
  await changeBoard($, b => reconcile(b, list, at), at)
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`
}

async function refreshSessionTotal($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  const total = usage.cost && Number.isFinite(usage.cost.usd) ? formatCost(usage.cost.usd) : null
  await update($, liveAtom, live => ({ ...live, sessionTotal: total }))
}

/** Whether the clock has work: something runs, or an ended worker's card still lingers in the row. */
function clockWanted(board: Board, at: number): boolean {
  return anythingRunning(board) || anythingLingering(board, at)
}

/**
 * One clock tick: `live.now` moves on every tick, the last included, so a
 * lingering card leaves the flow props on time; a selection whose card left
 * its row (the leads' or the workers') is dropped; every fifth tick reconciles; the clock stops itself
 * once nothing runs or lingers.
 */
async function tick($: EngineInterface): Promise<void> {
  const at = await now($)
  ticks += 1
  await update($, liveAtom, live => ({ ...live, now: at }))
  if (ticks % RECONCILE_EVERY_TICKS === 0) {
    try {
      await reconcileNow($)
    } catch {
      // the list could not be read this time; the next fifth tick tries again
    }
    try {
      await refreshSessionTotal($)
    } catch {
      // keep the previous total
    }
  }
  const board = await read($, boardAtom)
  try {
    const present = rowAgents(board, at).map(b => b.id)
    await update($, uiAtom, u => dropSelection(u, present))
  } catch {
    // the selection is checked again on the next tick
  }
  if (!clockWanted(board, at)) stopClock()
}

function stopClock(): void {
  if (ticker) ticker.cancel()
  ticker = null
}

/** Starts the 1-second tick when something runs or lingers and none is going. */
async function ensureClock($: EngineInterface): Promise<void> {
  if (ticker) return
  const board = await read($, boardAtom)
  const at = await now($)
  if (!clockWanted(board, at)) return
  if (ticker) return // another call started it while this one awaited
  ticks = 0
  ticker = $.clock.every(TICK_MS, () => {
    tick($).catch(() => undefined)
  })
}

/** A press on a worker's card (posted by the flow module): select it, or clear the selection when it is the one selected. */
async function pressCard($: EngineInterface, id: string): Promise<void> {
  if (id === MAIN_ID) return
  const board = await read($, boardAtom)
  if (!board.agents[id]) return
  await update($, uiAtom, u => selectCard(u, id))
}

async function paneIsOpen($: EngineInterface): Promise<{ open: boolean; placed: boolean }> {
  const panes = await $.ui.panes()
  const pane = panes.find(p => p.id === PANE_ID)
  return { open: pane !== undefined, placed: pane?.isPlaced === true }
}

async function setPaneOpen($: EngineInterface, open: boolean): Promise<void> {
  await update($, liveAtom, live => (live.paneOpen === open ? live : { ...live, paneOpen: open }))
}

async function openPane($: EngineInterface): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
  await setPaneOpen($, true)
  return opened.isPlaced
}

// ---------------------------------------------------------------- bookkeeping per event

async function onSessionStart($: EngineInterface): Promise<void> {
  await registerWorkers($) // never throws
  const at = await now($)
  const board = await read($, boardAtom)
  if (board.loadedAt === 0) await update($, boardAtom, () => resetBoard(at))
  await update($, liveAtom, live => ({ ...live, now: at }))
  try {
    await reconcileNow($)
  } catch {
    // no list yet; the next lifecycle event reconciles
  }
  try {
    await setPaneOpen($, (await paneIsOpen($)).open)
  } catch {
    // keep what live says
  }
  await ensureClock($)
}

async function toggleBoard($: EngineInterface): Promise<BoardToggleResult> {
  const { open } = await paneIsOpen($)
  if (open) {
    await $.ui.close({ id: PANE_ID })
    await setPaneOpen($, false)
    return 'closed'
  }
  return (await openPane($)) ? 'opened' : 'waiting'
}

type SpawnSeen = {
  agentId: string
  description: string
  subagentType: string
  model: string
  name?: string
  parentAgentId?: string
  promptChars: number
  prompt: string
  resumed: boolean
}

/** Whether a spec path names no file on disk; false when the check itself fails (the gate fails open). */
async function specIsMissing($: EngineInterface, spec: string | null | undefined): Promise<boolean> {
  if (typeof spec !== 'string' || spec === '') return false
  return (await failOpen(async () => !(await $.fs.exists(spec)))) ?? false
}

type SpawnFields = Pick<
  AgentSpawnInput,
  'subagentType' | 'model' | 'name' | 'description' | 'fork' | 'workflow' | 'resume' | 'parentAgentId'
>

/**
 * The Model Routing Policy's refusal (§1, §8, §9, a missing spec file, a
 * context item that did not resolve) for an Agent call, or null when it may
 * start (state.ts's spawnCheck). Runs inside failOpen: any error here means no
 * refusal.
 */
async function spawnRefusal($: EngineInterface, e: SpawnFields, contextMissing: string | null): Promise<string | null> {
  return failOpen(async () => {
    const board = await read($, boardAtom)
    const unit = coveringUnit(board, { name: e.name, description: e.description })
    return spawnCheck(board, {
      subagentType: e.subagentType,
      workerTier: tierOfWorkerType(e.subagentType),
      model: e.model,
      name: e.name,
      description: e.description,
      fork: e.fork,
      workflow: e.workflow !== undefined,
      resume: e.resume !== undefined,
      nested: e.parentAgentId !== undefined,
      specMissing: unit !== null ? await specIsMissing($, unit.spec) : false,
      contextMissing,
    })
  })
}

/** The context the covering unit names, resolved: the texts to inline, or the first item that did not resolve. */
type SpawnContext = { resolved: ResolvedContext[]; missing: string | null }

/**
 * The covering unit's `context` items, resolved (W3), for a main-loop spawn the
 * gate judges; null when there is none to resolve. Runs inside failOpen: an
 * error while resolving gives null (no refusal, no context inlined).
 */
async function spawnContext($: EngineInterface, e: SpawnFields): Promise<SpawnContext | null> {
  return failOpen(async () => {
    if (e.fork || e.workflow !== undefined || e.resume !== undefined || e.parentAgentId !== undefined) return null
    const board = await read($, boardAtom)
    const unit = coveringUnit(board, { name: e.name, description: e.description })
    if (unit === null) return null
    const own = Array.isArray(unit.context) ? unit.context : []
    const implicit = unit.tier === 'sonnet' || unit.tier === 'opus' ? await repoClaudeMd($, board, own) : null
    if (own.length === 0 && implicit === null) return null
    const rest = own.length === 0 ? { resolved: [], missing: null } : await resolveContext($, board, own)
    return implicit === null ? rest : { resolved: [implicit, ...rest.resolved], missing: rest.missing }
  })
}

/**
 * The implicit first context item of a Sonnet or Opus spawn (0.7.1, P2 no): the
 * active task's `<repo>/CLAUDE.md`, when the repo differs from the session's
 * root (a worker started there loads no CLAUDE.md of it), the file can be read,
 * and `own` (the unit's items) does not already name it. Null otherwise; never
 * a reason to refuse. It is outside the unit's limit of 8 items.
 */
async function repoClaudeMd($: EngineInterface, board: Board, own: readonly string[]): Promise<ResolvedContext | null> {
  try {
    const repo = board.repo
    if (typeof repo !== 'string' || repo === '') return null
    const trim = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p)
    if (trim(repo) === trim(await $.session.root())) return null
    const path = `${trim(repo)}/CLAUDE.md`
    for (const item of own) {
      const parsed = parseContextItem(item)
      if (parsed !== null && parsed.kind === 'path' && parsed.path === path) return null
    }
    if (!(await $.fs.exists(path))) return null
    return { item: path, path, text: String(await $.fs.read(path)) }
  } catch {
    return null
  }
}

/**
 * Each context item to its text: a path (`$.fs.exists`, then `$.fs.read`, then
 * its `#heading` section when it names one); `<task-id>:<unit-id>` that unit's
 * newest journal entry (header and Result, a split result joined whole). The
 * first item that does not resolve stops it, as `missing`.
 */
async function resolveContext($: EngineInterface, board: Board, items: readonly string[]): Promise<SpawnContext> {
  const resolved: ResolvedContext[] = []
  for (const item of items) {
    const parsed = parseContextItem(item)
    if (parsed === null) return { resolved, missing: item }
    if (parsed.kind === 'path') {
      if (!(await $.fs.exists(parsed.path))) return { resolved, missing: item }
      const text = extractContext(parsed, String(await $.fs.read(parsed.path)))
      if (text === null) return { resolved, missing: item }
      resolved.push({ item, path: parsed.path, text })
    } else {
      const found = await newestEntryOf($, board, parsed.taskId, parsed.unitId)
      if (found === null) return { resolved, missing: item }
      const whole = await readWholeEntry($, found)
      resolved.push({ item, path: found, text: extractContext(parsed, whole) ?? whole })
    }
  }
  return { resolved, missing: null }
}

/**
 * The folder a covered spawn should run in (B2, P1's yes branch): the active
 * task's repository when it is set and differs from the session's root; null
 * otherwise, or when either cannot be read.
 */
async function taskCwd($: EngineInterface): Promise<string | null> {
  return failOpen(async () => {
    const board = await read($, boardAtom)
    const repo = board.repo
    if (typeof repo !== 'string' || repo === '') return null
    const root = await $.session.root()
    const trim = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p)
    return trim(repo) === trim(root) ? null : repo
  })
}

/** The Agent tool's fork refusal (B2): `denyFork()` for a call whose `subagent_type` is `fork`, else null. Fails open. */
async function forkRefusal(input: unknown): Promise<string | null> {
  return failOpen(() => {
    const type = input !== null && typeof input === 'object' ? (input as { subagent_type?: unknown }).subagent_type : undefined
    return type === 'fork' ? denyFork() : null
  })
}

/** One audit entry on the session log for a refused spawn. */
async function logRefusal($: EngineInterface, who: string): Promise<void> {
  const at = await now($)
  const entry: LogEntry = { at, kind: 'audit', who: 'lead', text: `spawn refused: ${who}` }
  await update($, logAtom, log => logPush(log, [entry]))
}

/**
 * A units list that newly declares a unit of a (tier, kind) barred this
 * session (policy §8): the tool's refusal text, or null.
 */
async function barredRefusal($: EngineInterface, units: BoardUpdate['units']): Promise<string | null> {
  if (units === undefined) return null
  const board = await read($, boardAtom)
  const u = barredUnit(board, units)
  if (u === null) return null
  const bar = barred(board).find(x => x.tier === u.tier && x.kind === u.kind)
  if (bar === undefined) return null
  return `unit "${u.id}": ${bar.kind} is barred at ${bar.tier} for the rest of this session (${bar.n} rejected, policy §8); route it one tier up`
}

/** The unit an Agent call carries out, when it has a tier and an audit line: the one whose line the audit file gets. */
async function auditedUnit($: EngineInterface, e: Pick<AgentSpawnInput, 'name' | 'description'>): Promise<Unit | null> {
  try {
    const board = await read($, boardAtom)
    const u = coveringUnit(board, { name: e.name, description: e.description })
    if (u === null || (u.tier !== 'opus' && u.tier !== 'sonnet' && u.tier !== 'haiku')) return null
    return typeof u.audit === 'string' && u.audit !== '' ? u : null
  } catch {
    return null
  }
}

/** The config root (B3.5): CLAUDE_CONFIG_DIR, else <HOME>/.claude, else <USERPROFILE>/.claude, else <plugin root>/data. */
async function configRootOf($: EngineInterface): Promise<string> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await $.env.get('HOME')
  const userProfile = await $.env.get('USERPROFILE')
  return configRoot({ configDir, home, userProfile, pluginRoot: $.plugin.root })
}

/** This session's audit file: `<config root>/flowestra/audit/<session id>.log`. */
async function auditFilePath($: EngineInterface): Promise<string> {
  return auditPath(await configRootOf($), await $.session.id())
}

/** The journal's root: `<config root>/flowestra/journal`. */
async function journalRootOf($: EngineInterface): Promise<string> {
  return journalRoot(await configRootOf($))
}

/** Appends one line to the audit file as the next link of the audit queue: read (empty when missing), then write the whole file. */
async function appendAudit($: EngineInterface, line: string): Promise<void> {
  const link = auditQueue.then(async () => {
    const path = await auditFilePath($)
    let text = ''
    try {
      text = String(await $.fs.read(path))
    } catch {
      text = '' // no file yet
    }
    await $.fs.write(path, `${text}${line}\n`)
  })
  auditQueue = link.catch(() => undefined) // a failed append never breaks the chain
  await link
}

/** The audit file's line for a started spawn of `unit`. */
async function auditSpawn($: EngineInterface, unit: Unit, agentId: string): Promise<void> {
  const at = await now($)
  await appendAudit($, `${new Date(at).toISOString()} | ${unit.id} | ${agentId} | ${unit.audit}`)
}

// ---------------------------------------------------------------- the journal (decisions.md 0.7.0, section 2)

/** The default repository of a task: the session's repository root, else the session's root; null when neither can be read. */
async function defaultRepo($: EngineInterface): Promise<string | null> {
  const repo = await failOpen(async () => (await $.session.repo())?.root ?? null)
  if (typeof repo === 'string' && repo !== '') return repo
  const root = await failOpen(() => $.session.root())
  return typeof root === 'string' && root !== '' ? root : null
}

/** Where a task's files are: the journal root, its repository and that repository's key. Throws when no repository is known. */
type TaskPlace = { root: string; repo: string; key: string }

async function placeOf($: EngineInterface, slot: Pick<TaskSlot, 'repo'>): Promise<TaskPlace> {
  const repo = slot.repo ?? (await defaultRepo($))
  if (repo === null) throw new Error('no repository for the task')
  return { root: await journalRootOf($), repo, key: repoKey(repo) }
}

/** The fields of an index line, split on ` | `. */
function fieldsOf(line: string): string[] {
  return line.split(' | ')
}

/** Lists a folder; [] when it is missing or cannot be listed. */
async function listOrNone($: EngineInterface, folder: string): Promise<{ name: string; kind: string; mtimeMs: number }[]> {
  try {
    return (await $.fs.list(folder)).map(x => ({ name: x.name, kind: x.kind, mtimeMs: x.mtimeMs }))
  } catch {
    return []
  }
}

/** A file's text, or null when it cannot be read. */
async function readOrNull($: EngineInterface, path: string): Promise<string | null> {
  try {
    return String(await $.fs.read(path))
  } catch {
    return null
  }
}

/** Sets this session's shard line for `key` in `folder` and writes the shard file whole. */
async function writeShard($: EngineInterface, folder: string, key: string, line: string, at: number): Promise<void> {
  const path = shardPath(folder, await $.session.id())
  let lines = shardCache.get(path)
  if (lines === undefined) {
    lines = new Map()
    for (const s of parseShard((await readOrNull($, path)) ?? '')) lines.set(s.key, shardLine(Date.parse(s.at) || at, s.key, s.line))
    shardCache.set(path, lines)
  }
  lines.set(key, shardLine(at, key, line))
  await $.fs.write(path, `${[...lines.values()].join('\n')}\n`)
}

/** Every session's shard of a folder, merged (newest line per child key), with the mtimes seen. */
async function readShards($: EngineInterface, folder: string): Promise<{ lines: string[]; seen: Map<string, number> }> {
  const dir = `${folder}/.shards`
  const files = (await listOrNone($, dir)).filter(f => f.kind === 'file' && f.name.endsWith('.tsv'))
  const seen = new Map<string, number>()
  const texts: string[] = []
  for (const f of files) {
    const text = await readOrNull($, `${dir}/${f.name}`)
    if (text === null) continue
    seen.set(f.name, f.mtimeMs)
    texts.push(text)
  }
  return { lines: mergeShards(texts.map(parseShard)), seen }
}

/**
 * Regenerates a folder's index.md from its shards (J1): merge, write; then list
 * the shards again and regenerate once more when one is newer than when it was
 * read (or new). Returns the merged lines.
 */
async function regenIndex($: EngineInterface, folder: string, level: IndexLevel, name: string, at: number): Promise<string[]> {
  let got = await readShards($, folder)
  await $.fs.write(`${folder}/index.md`, indexText(level, name, got.lines, at))
  const again = (await listOrNone($, `${folder}/.shards`)).filter(f => f.kind === 'file' && f.name.endsWith('.tsv'))
  const changed = again.some(f => {
    const was = got.seen.get(f.name)
    return was === undefined || f.mtimeMs > was
  })
  if (changed) {
    got = await readShards($, folder)
    await $.fs.write(`${folder}/index.md`, indexText(level, name, got.lines, at))
  }
  return got.lines
}

/** One entry of a task, read off its phase index lines. */
type EntryRef = { phase: string; file: string; unitId: string; line: string; path: string }

/** Every entry of a task across its phase folders (all sessions' shards), newest first. */
async function taskEntries($: EngineInterface, place: TaskPlace, taskId: string): Promise<EntryRef[]> {
  const dir = taskDir(place.root, place.key, taskId)
  const out: EntryRef[] = []
  for (const d of await listOrNone($, dir)) {
    if (d.kind !== 'dir' || d.name.startsWith('.')) continue
    const folder = phaseDir(place.root, place.key, taskId, d.name)
    for (const line of (await readShards($, folder)).lines) {
      const f = fieldsOf(line)
      const file = f[0] ?? ''
      if (file === '') continue
      out.push({ phase: d.name, file, unitId: f[1] ?? '', line, path: `${folder}/${file}` })
    }
  }
  return out.sort((a, b) => (a.file < b.file ? 1 : a.file > b.file ? -1 : 0))
}

/** The state file input of a task's slot: unit states from the board, entries from the journal. */
async function stateInputOf($: EngineInterface, board: Board, slot: TaskSlot, place: TaskPlace, at: number): Promise<StateInput> {
  const unitStates: Record<string, string> = {}
  for (const u of slot.units) unitStates[u.id] = unitState(board, u, slot.taskId)
  const entries = await taskEntries($, place, slot.taskId)
  const latestEntries: Record<string, string> = {}
  for (const e of entries) if (latestEntries[e.unitId] === undefined) latestEntries[e.unitId] = e.path
  return {
    slot,
    sessionId: await $.session.id(),
    updatedMs: at,
    unitStates,
    latestEntries,
    recentEntries: entries.slice(0, 5).map(e => e.path),
  }
}

/** Rewrites a task's state.md and state.json (last writer wins). */
async function writeState($: EngineInterface, board: Board, slot: TaskSlot, place: TaskPlace, at: number): Promise<void> {
  const input = await stateInputOf($, board, slot, place, at)
  await $.fs.write(stateMdPath(place.root, place.key, slot.taskId), stateMd(input))
  await $.fs.write(stateJsonPath(place.root, place.key, slot.taskId), stateJson(input))
}

/** A phase index line's verdict counts and entries, as the task index line for that phase. */
function taskLineOf(phase: string, phaseLines: readonly string[], at: number): string {
  let accepted = 0
  let rejected = 0
  for (const l of phaseLines) {
    const v = fieldsOf(l)[5]
    if (v === 'accepted') accepted += 1
    else if (v === 'rejected') rejected += 1
  }
  return taskIndexLine({ phase, entries: phaseLines.length, accepted, rejected, unchecked: phaseLines.length - accepted - rejected, updatedMs: at })
}

/** Writes this session's line for `phase` in the task's shard, regenerates the task index. */
async function updateTaskIndex($: EngineInterface, place: TaskPlace, taskId: string, phase: string, phaseLines: readonly string[], at: number): Promise<void> {
  const dir = taskDir(place.root, place.key, taskId)
  await writeShard($, dir, phase, taskLineOf(phase, phaseLines, at), at)
  await regenIndex($, dir, 'task', taskId, at)
}

/** The task's line in the repository index and the repository's line in the root index (each through this session's shard). */
async function updateRepoIndex($: EngineInterface, place: TaskPlace, slot: TaskSlot, at: number): Promise<void> {
  const taskLines = await regenIndex($, taskDir(place.root, place.key, slot.taskId), 'task', slot.taskId, at)
  let entries = 0
  for (const l of taskLines) entries += Number(fieldsOf(l)[1]) || 0
  const rdir = repoDir(place.root, place.key)
  await writeShard($, rdir, slot.taskId, repoIndexLine({ taskId: slot.taskId, status: slot.status, phase: slot.phase, entries, updatedMs: at, title: slot.task }), at)
  const repoLines = await regenIndex($, rdir, 'repo', place.key, at)
  const open = repoLines.filter(l => fieldsOf(l)[1] === 'open').length
  await writeShard($, place.root, place.key, rootIndexLine({ repoKey: place.key, root: place.repo, openTasks: open, tasks: repoLines.length, updatedMs: at }), at)
  await regenIndex($, place.root, 'root', 'journal', at)
}

/** The phase index line of one of this session's entries. */
function phaseLineOf(je: JournalEntry): string {
  const d = je.data
  const results = [d.result, ...d.resumes.map(r => r.result)].filter((r): r is string => r !== null)
  return phaseIndexLine({
    file: `${je.name}.md`,
    unitId: d.unitId,
    tier: d.tier,
    kind: d.kind,
    status: d.status,
    verdict: d.verdict,
    briefChars: d.brief.length,
    resultChars: results.length === 0 ? null : results.reduce((n, r) => n + r.length, 0),
    audit: d.audit,
  })
}

/** Writes one of this session's entries (and its result parts), then its phase index line; returns the phase's merged lines. */
async function writeEntry($: EngineInterface, je: JournalEntry, at: number): Promise<string[]> {
  const files = buildEntry(je.name, je.data)
  const folder = phaseDir(je.root, je.key, je.taskId, je.phase)
  await $.fs.write(entryPath(je.root, je.key, je.taskId, je.phase, je.name), files.text)
  for (const p of files.parts) await $.fs.write(`${folder}/${p.name}`, p.text)
  await writeShard($, folder, `${je.name}.md`, phaseLineOf(je), at)
  return regenIndex($, folder, 'phase', je.phase, at)
}

/** Rewrites a task's state files from the current board, when the task is on it. */
async function stateOfTask($: EngineInterface, taskId: string, place: TaskPlace, at: number): Promise<void> {
  const board = await read($, boardAtom)
  const slot = slotOf(board, taskId)
  if (slot !== null) await writeState($, board, slot, place, at)
}

/** A started spawn a tiered unit covers: its entry (running), the indexes up the chain, the task's state files. */
async function journalSpawn($: EngineInterface, je: JournalEntry, at: number): Promise<void> {
  journalEntries.set(je.data.agentId, je)
  await journaled(async () => {
    const place: TaskPlace = { root: je.root, repo: je.repo, key: je.key }
    const phaseLines = await writeEntry($, je, at)
    await updateTaskIndex($, place, je.taskId, je.phase, phaseLines, at)
    const board = await read($, boardAtom)
    const slot = slotOf(board, je.taskId)
    if (slot !== null) {
      await updateRepoIndex($, place, slot, at)
      await writeState($, board, slot, place, at)
    }
  })
}

/** Builds the journal entry for a started spawn a tiered unit covers. */
async function newEntry(
  $: EngineInterface,
  unit: Unit,
  seen: { agentId: string; subagentType: string; model: string; prompt: string; cwd: string | null; context: ContextStatus[] },
  at: number,
): Promise<JournalEntry | null> {
  const board = await read($, boardAtom)
  if (board.taskId === null) return null
  const place = await placeOf($, board)
  const phase = board.phase ?? 'unset'
  const name = entryName(at, unit.id, seen.agentId)
  return {
    ...place,
    taskId: board.taskId,
    phase,
    name,
    data: {
      taskId: board.taskId,
      unitId: unit.id,
      label: unit.label,
      audit: unit.audit,
      tier: unit.tier,
      kind: unit.kind,
      phase: board.phase,
      wave: board.wave,
      agentId: seen.agentId,
      subagentType: seen.subagentType,
      model: seen.model,
      sessionId: await $.session.id(),
      cwd: seen.cwd,
      context: seen.context,
      spawnedMs: at,
      endedMs: null,
      status: 'running',
      verdict: unit.verdict,
      verdictMs: null,
      brief: seen.prompt,
      result: null,
      resumes: [],
    },
  }
}

const HEADING_RESULT = /^## Result( \d+)?$/

/** An entry's text with each split result (`(stored in a, b)`) replaced by the joined text of its part files. */
async function readWholeEntry($: EngineInterface, path: string): Promise<string> {
  const text = String(await $.fs.read(path))
  if (!/^results: stored beside this file/m.test(text)) return text
  const folder = path.replace(/[\\/][^\\/]*$/, '')
  const lines = text.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const m = /^\(stored in (.+)\)$/.exec(lines[i] ?? '')
    if (m === null || !HEADING_RESULT.test(lines[i - 1] ?? '')) continue
    let joined = ''
    for (const name of (m[1] ?? '').split(', ')) joined += String(await $.fs.read(`${folder}/${name}`))
    lines[i] = joined
  }
  return lines.join('\n')
}

/** The newest entry of unit `unitId` of task `taskId`: its path, from the task's phase shards; null when none. */
async function newestEntryOf($: EngineInterface, board: Board, taskId: string, unitId: string): Promise<string | null> {
  const root = await journalRootOf($)
  const keys: string[] = []
  const slot = slotOf(board, taskId)
  if (slot !== null && slot.repo !== null) keys.push(repoKey(slot.repo))
  for (const d of await listOrNone($, root)) if (d.kind === 'dir' && !d.name.startsWith('.') && !keys.includes(d.name)) keys.push(d.name)
  for (const key of keys) {
    const place: TaskPlace = { root, repo: '', key }
    const hit = (await taskEntries($, place, taskId)).find(e => e.unitId === unitId)
    if (hit !== undefined) return hit.path
  }
  return null
}

const CONTEXT_STATUS = /(.+?) \((inlined \d+ chars|cut at \d+ of \d+|path only)\)(?:, |$)/g

/** An entry file's text (results already joined) back to its data; null when it is not one. Exported for its test. */
export function entryFromText(text: string): EntryData | null {
  const lines = text.replace(/\n$/, '').split('\n')
  const head = (re: RegExp) => {
    for (const l of lines.slice(0, 9)) {
      const m = re.exec(l)
      if (m !== null) return m
    }
    return null
  }
  const dash = (v: string | undefined) => (v === undefined || v === '-' ? null : v)
  const title = /^# (.+?) · (.+?) · (.*)$/.exec(lines[0] ?? '')
  const audit = head(/^audit: (.*)$/)
  const tier = head(/^tier: (.+?) · kind: (.+?) · phase: (.+?) · wave: (.+)$/)
  const agent = head(/^agent: (.+?) · type: (.+?) · model: (.+?) · session: (.+)$/)
  const cwd = head(/^cwd: (.*?) · context: (.*)$/)
  const times = head(/^spawned: (\S+) · ended: (\S+) · status: (\w+)$/)
  const verdict = head(/^verdict: (\w+)(?: · at (\S+))?$/)
  if (!title || !audit || !tier || !agent || !cwd || !times || !verdict) return null
  const context: ContextStatus[] = []
  if (cwd[2] !== 'none') for (const m of (cwd[2] ?? '').matchAll(CONTEXT_STATUS)) context.push({ item: m[1] ?? '', status: m[2] ?? '' })
  const brief = lines.indexOf('## Brief')
  if (brief < 0) return null
  const sections: { head: string; body: string[] }[] = []
  for (let i = brief; i < lines.length; i++) {
    const l = lines[i] ?? ''
    if (/^## (Brief|Result|Message \d+|Result \d+)$/.test(l)) sections.push({ head: l, body: [] })
    else sections[sections.length - 1]?.body.push(l)
  }
  const bodyOf = (h: string) => {
    const body = sections.find(s => s.head === h)?.body.join('\n')
    return body === undefined ? null : unescapeSections(body)
  }
  const resumes: EntryData['resumes'] = []
  for (let n = 2; bodyOf(`## Message ${n}`) !== null; n++) resumes.push({ message: bodyOf(`## Message ${n}`) ?? '', result: bodyOf(`## Result ${n}`) || null })
  const statuses: EntryStatus[] = ['running', 'done', 'failed', 'stopped']
  const status = statuses.find(s => s === times[3]) ?? 'running'
  const v = verdict[1] === 'accepted' || verdict[1] === 'rejected' ? (verdict[1] as Verdict) : null
  const phase = dash(tier[3])
  const wave = Number(tier[4])
  return {
    taskId: title[1] ?? '',
    unitId: title[2] ?? '',
    label: title[3] ?? '',
    audit: dash(audit[1]),
    tier: (dash(tier[1]) as EntryData['tier']) ?? null,
    kind: (dash(tier[2]) as EntryData['kind']) ?? null,
    phase: phase === null || phase === 'unset' ? null : (phase as EntryData['phase']),
    wave: Number.isFinite(wave) ? wave : null,
    agentId: agent[1] ?? '',
    subagentType: dash(agent[2]),
    model: dash(agent[3]),
    sessionId: agent[4] ?? '',
    cwd: dash(cwd[1]),
    context,
    spawnedMs: Date.parse(times[1] ?? '') || 0,
    endedMs: times[2] === 'running' ? null : Date.parse(times[2] ?? '') || null,
    status,
    verdict: v,
    verdictMs: verdict[2] ? Date.parse(verdict[2]) || null : null,
    brief: bodyOf('## Brief') ?? '',
    result: bodyOf('## Result') || null,
    resumes,
  }
}

/**
 * One of this session's entries by agent id: from the module map, else rebuilt
 * from its file (after a hot reload), found through the agent's box (its task
 * and unit) and the task's phase shards. Null when the agent has no entry.
 */
async function entryOf($: EngineInterface, agentId: string): Promise<JournalEntry | null> {
  const known = journalEntries.get(agentId)
  if (known !== undefined) return known
  const board = await read($, boardAtom)
  const box = board.agents[agentId]
  if (box === undefined || box.taskId === null || box.unitId === null || box.routed === null) return null
  const slot = slotOf(board, box.taskId)
  if (slot === null) return null
  const place = await placeOf($, slot)
  const suffix = `-${box.unitId}-${agentId.slice(0, 8)}.md`
  const ref = (await taskEntries($, place, box.taskId)).find(e => e.file.endsWith(suffix))
  if (ref === undefined) return null
  const data = entryFromText(await readWholeEntry($, ref.path))
  if (data === null || data.agentId !== agentId) return null
  const je: JournalEntry = { ...place, taskId: box.taskId, phase: ref.phase, name: ref.file.replace(/\.md$/, ''), data }
  journalEntries.set(agentId, je)
  return je
}

/** A resumed run of an agent with an entry: `## Message N` (the resuming prompt), running again. */
async function journalResume($: EngineInterface, agentId: string, prompt: string, at: number): Promise<void> {
  await journaled(async () => {
    const je = await entryOf($, agentId)
    if (je === null) return
    je.data = { ...je.data, endedMs: null, status: 'running', resumes: [...je.data.resumes, { message: prompt, result: null }] }
    await writeEntry($, je, at)
    await stateOfTask($, je.taskId, je, at)
  })
}

/** A turn.complete of an agent with an entry: the entry rewritten with the result and status, its phase line, the state files. */
async function journalComplete($: EngineInterface, agentId: string, reason: string, answer: string, at: number): Promise<void> {
  await journaled(async () => {
    const je = await entryOf($, agentId)
    if (je === null) return
    const status: EntryStatus = reason === 'answer' ? 'done' : reason === 'aborted' ? 'stopped' : 'failed'
    const d = je.data
    const resumes = d.resumes.length > 0 ? d.resumes.map((r, i) => (i === d.resumes.length - 1 ? { ...r, result: answer } : r)) : d.resumes
    je.data = { ...d, endedMs: at, status, result: d.resumes.length > 0 ? d.result : answer, resumes }
    await writeEntry($, je, at)
    await stateOfTask($, je.taskId, je, at)
  })
}

/** A slot compared without its activeAt (a switch away alone does not rewrite a task's files). */
function slotKey(slot: TaskSlot): string {
  return JSON.stringify({ ...slot, activeAt: 0 })
}

type VerdictChange = { taskId: string; unitId: string; verdict: Verdict | null }

/** The units of every task whose verdict changed between two boards (units with a tier only). */
function verdictChanges(before: Board, after: Board): VerdictChange[] {
  const out: VerdictChange[] = []
  for (const slot of taskSlots(after)) {
    const prev = slotOf(before, slot.taskId)
    for (const u of slot.units) {
      if (u.tier === null) continue
      const was = prev?.units.find(x => x.id === u.id)?.verdict ?? null
      if (prev !== null && was !== u.verdict) out.push({ taskId: slot.taskId, unitId: u.id, verdict: u.verdict })
    }
  }
  return out
}

/**
 * A verdict change: the unit's newest entry gets it. This session's own entry
 * is rewritten (its verdict line); another session's is not touched (J1): only
 * its phase index line, with the new verdict, goes into this session's shard.
 * Then the task index line for that phase.
 */
async function journalVerdict($: EngineInterface, board: Board, change: VerdictChange, at: number): Promise<void> {
  const slot = slotOf(board, change.taskId)
  if (slot === null) return
  const place = await placeOf($, slot)
  const newest = (await taskEntries($, place, change.taskId)).find(e => e.unitId === change.unitId)
  if (newest === undefined) return
  const agent8 = newest.file.replace(/\.md$/, '').slice(-8)
  const own = Object.values(board.agents).find(b => b.id.slice(0, 8) === agent8 && b.unitId === change.unitId && b.taskId === change.taskId)
  const je = own !== undefined ? await entryOf($, own.id) : null
  let phaseLines: string[]
  if (je !== null && `${je.name}.md` === newest.file) {
    je.data = { ...je.data, verdict: change.verdict, verdictMs: at }
    phaseLines = await writeEntry($, je, at)
  } else {
    const f = fieldsOf(newest.line)
    f[5] = change.verdict ?? 'unchecked'
    const folder = phaseDir(place.root, place.key, change.taskId, newest.phase)
    await writeShard($, folder, newest.file, fitLine(f, [8, 1]), at)
    phaseLines = await regenIndex($, folder, 'phase', newest.phase, at)
  }
  await updateTaskIndex($, place, change.taskId, newest.phase, phaseLines, at)
}

/** Regenerates a task's indexes from the shards (J1's healing on open and switch): each phase index, then the task index. */
async function healTask($: EngineInterface, place: TaskPlace, taskId: string, at: number): Promise<void> {
  const dir = taskDir(place.root, place.key, taskId)
  for (const d of await listOrNone($, dir)) {
    if (d.kind === 'dir' && !d.name.startsWith('.')) await regenIndex($, phaseDir(place.root, place.key, taskId, d.name), 'phase', d.name, at)
  }
  await regenIndex($, dir, 'task', taskId, at)
}

/**
 * The journal's part of an AgentBoard update: verdict changes; for every task
 * whose slot changed, its state files and its repository and root index lines;
 * on open, resume or switch, the active task's indexes regenerated first.
 */
async function journalBoardChange($: EngineInterface, before: Board, after: Board, at: number, entered: boolean): Promise<void> {
  await journaled(async () => {
    for (const change of verdictChanges(before, after)) {
      try {
        await journalVerdict($, after, change, at)
      } catch {
        // this verdict misses the journal; the board has it
      }
    }
    if (entered && after.taskId !== null) {
      const slot = slotOf(after, after.taskId)
      if (slot !== null) await healTask($, await placeOf($, slot), slot.taskId, at)
    }
    const changed = verdictChanges(before, after).map(c => c.taskId)
    for (const slot of taskSlots(after)) {
      const prev = slotOf(before, slot.taskId)
      if (prev !== null && slotKey(prev) === slotKey(slot) && !changed.includes(slot.taskId)) continue
      try {
        const place = await placeOf($, slot)
        await updateRepoIndex($, place, slot, at)
        await writeState($, after, slot, place, at)
      } catch {
        // this task's files miss this change; the next one rewrites them
      }
    }
  })
}

// ---------------------------------------------------------------- the AgentBoard tool's update and answer

/** The slot a task's state.json holds, from the journal of `repo`; null when there is none or it does not parse. */
async function storedSlot($: EngineInterface, repo: string, taskId: string): Promise<TaskSlot | null> {
  return failOpen(async () => {
    const text = await readOrNull($, stateJsonPath(await journalRootOf($), repoKey(repo), taskId))
    if (text === null) return null
    const slot = parseStateJson(text)
    return slot !== null && slot.taskId === taskId ? slot : null
  })
}

/**
 * The first `task-N` (N from 1 to 999) that is no open or closed task of the board and has no state.json in
 * the journal under `repo`; null when every id is taken or the journal cannot be read.
 */
async function freeTaskId($: EngineInterface, board: Board, repo: string): Promise<string | null> {
  return failOpen(async () => {
    const used = new Set(taskSlots(board).map(s => s.taskId))
    const root = await journalRootOf($)
    const key = repoKey(repo)
    for (let n = 1; n <= 999; n++) {
      const id = `task-${n}`
      if (!used.has(id) && (await readOrNull($, stateJsonPath(root, key, id))) === null) return id
    }
    return null
  })
}

/** The summary line, naming the other open tasks: `board updated: task wb-ui (open: ab-journal, cr-fix), phase executing, …`. */
function summaryLine(line: string, change: BoardUpdate, before: Board, after: Board): string {
  const named = change.taskId ?? before.taskId ?? after.taskId
  if (named === null) return line
  const open = taskSlots(after).filter(s => s.status === 'open' && s.taskId !== named).map(s => s.taskId)
  if (open.length === 0) return line
  const tag = `task ${named} (open: ${open.join(', ')})`
  if (change.taskId !== undefined) return line.replace(`board updated: task ${change.taskId}`, `board updated: ${tag}`)
  return line.replace(/^board updated: /, `board updated: ${tag}, `)
}

const STATE_LINES_MAX = 40
const OTHER_SESSION_MS = 30 * 60_000

/**
 * The active task's state, for the answer to an update that opened, resumed or
 * switched it: state.md's text (at most 40 lines: past that, 39 and a line
 * saying how many were cut and where the whole is), then `journal: <folder>`
 * and `audit file: <path>`. [] when it cannot be made.
 */
async function stateBlock($: EngineInterface, board: Board, at: number): Promise<string[]> {
  return (
    (await failOpen(async () => {
      if (board.taskId === null) return null
      const slot = slotOf(board, board.taskId)
      if (slot === null) return null
      const place = await placeOf($, slot)
      const md = stateMd(await stateInputOf($, board, slot, place, at)).replace(/\n+$/, '').split('\n')
      const path = stateMdPath(place.root, place.key, slot.taskId)
      const shown =
        md.length > STATE_LINES_MAX
          ? [...md.slice(0, STATE_LINES_MAX - 1), `[${md.length - (STATE_LINES_MAX - 1)} more lines cut; the whole state is in ${path}]`]
          : md
      return [...shown, `journal: ${taskDir(place.root, place.key, slot.taskId)}`, `audit file: ${await auditFilePath($)}`]
    })) ?? []
  )
}

/** `task <id> was also updated by session <sid8> <n>m ago`, when the active task's state.json names another session within 30 minutes; else null. */
async function otherSessionLine($: EngineInterface, board: Board, at: number): Promise<string | null> {
  return failOpen(async () => {
    if (board.taskId === null) return null
    const slot = slotOf(board, board.taskId)
    if (slot === null) return null
    const place = await placeOf($, slot)
    const text = await readOrNull($, stateJsonPath(place.root, place.key, slot.taskId))
    const writer = text === null ? null : parseStateWriter(text)
    if (writer === null || writer.session === (await $.session.id())) return null
    const age = at - writer.updatedMs
    if (age < 0 || age > OTHER_SESSION_MS) return null
    return `task ${slot.taskId} was also updated by session ${sid8(writer.session)} ${Math.floor(age / 60_000)}m ago`
  })
}

/**
 * Applies an AgentBoard update and answers it. A `taskId` naming no task of the
 * board is resumed from its state.json in the journal (the repository: `repo`,
 * else the session's repository, else its root), or opened when the update has
 * a `task` line, else refused. A newly opened task with no `repo` gets that
 * default. The journal is then written through its queue.
 */
async function boardToolUpdate($: EngineInterface, change: BoardUpdate, line: string): Promise<{ deny: string } | { text: string }> {
  const at = await now($)
  const before = await read($, boardAtom)
  const id = change.taskId
  const unknown = id !== undefined && slotOf(before, id) === null
  const implicit = id === undefined && before.taskId === null
  let stored: TaskSlot | null = null
  let applied: BoardUpdate = change
  if (unknown || implicit) {
    const repo = change.repo ?? (await defaultRepo($))
    if (unknown && id !== undefined && repo !== null) stored = await storedSlot($, repo, id)
    if (unknown && stored === null && change.task === undefined) {
      return { deny: `task "${id}" is not open: give its task line to open it (and its repo when it is not this session's folder)` }
    }
    if (stored === null && change.repo === undefined && repo !== null) applied = { ...change, repo }
    if (implicit && repo !== null) {
      const free = await freeTaskId($, before, repo)
      if (free !== null) applied = { ...applied, taskId: free }
    }
  }
  const resumed = stored
  await changeBoard(
    $,
    b => applyBoardUpdate(resumed !== null && slotOf(b, resumed.taskId) === null ? openTask(b, resumed, at) : b, applied, at),
    at,
  )
  const after = await read($, boardAtom)
  const entered = after.taskId !== null && after.taskId !== before.taskId
  const lines = [summaryLine(line, change, before, after)]
  if (entered) lines.push(...(await stateBlock($, after, at)))
  const warning = await otherSessionLine($, after, at)
  if (warning !== null) lines.push(warning)
  const tracked = await trackedLine($)
  await journalBoardChange($, before, after, at, entered)
  if (lines.length === 1) return { text: tracked === '' ? lines[0]! : `${lines[0]} | ${tracked}` }
  return { text: [...lines, ...(tracked === '' ? [] : [tracked])].join('\n') }
}

async function onSpawn($: EngineInterface, seen: SpawnSeen): Promise<void> {
  const at = await now($)
  const before = await read($, boardAtom)
  const burstStarts = !Object.values(before.agents).some(
    b => b.id !== MAIN_ID && (b.status === 'starting' || b.status === 'running'),
  )
  await changeBoard(
    $,
    b =>
    applySpawn(
      b,
      {
        agentId: seen.agentId,
        description: seen.description,
        subagentType: seen.subagentType,
        model: seen.model,
        name: seen.name ?? null,
        parentAgentId: seen.parentAgentId ?? null,
        promptChars: seen.promptChars,
        resumed: seen.resumed,
      },
      at,
    ),
    at,
  )
  try {
    await update($, detailAtom, d => detailSpawn(d, seen.agentId, seen.prompt, at))
  } catch {
    // the detail strip shows no brief for this one
  }
  await touchNow($, at)
  if (burstStarts) {
    try {
      await openPane($)
    } catch {
      // the pane could not be opened; /board can
    }
  }
  try {
    await reconcileNow($)
  } catch {
    // keep the board as the spawn left it
  }
  await ensureClock($)
}

async function onTurnStart($: EngineInterface, agentId: string | undefined): Promise<void> {
  const at = await now($)
  await changeBoard($, b => applyTurnStart(b, agentId, at), at)
  await touchNow($, at)
  await ensureClock($)
}

async function onStep($: EngineInterface, agentId: string | undefined, usage: TurnUsage | null): Promise<void> {
  const at = await now($)
  await changeBoard($, b => applyStep(b, agentId, usage, at), at)
  await touchNow($, at)
  await ensureClock($)
}

async function onComplete($: EngineInterface, agentId: string | undefined, info: CompleteInfo): Promise<void> {
  const at = await now($)
  await changeBoard($, b => applyComplete(b, agentId, info, at), at)
  await touchNow($, at)
  try {
    await update($, detailAtom, d => detailComplete(d, agentId, at))
  } catch {
    // the detail strip keeps its runs until the next event
  }
  try {
    await reconcileNow($)
  } catch {
    // keep the board as the turn left it
  }
  // the last worker's end leaves its card lingering: the clock carries on until it has gone
  await ensureClock($)
}

/** A main-loop SendMessage's `to`, as a box id: an id as is, else a box whose call name it is. */
function targetOf(board: Board, to: unknown): string | null {
  if (typeof to !== 'string' || to.length === 0) return null
  if (board.agents[to]) return to
  const named = Object.values(board.agents).find(b => b.name === to)
  return named ? named.id : null
}

async function onToolCall($: EngineInterface, agentId: string | undefined, tool: string, to: unknown): Promise<void> {
  const at = await now($)
  const board = await read($, boardAtom)
  const target = agentId === undefined && tool === 'SendMessage' ? targetOf(board, to) : null
  await changeBoard($, b => applyToolCall(b, agentId, tool, at, target), at)
  await touchNow($, at)
  await ensureClock($)
}

/** A tool call with an id started: a run in flight in the agent's detail. */
async function onToolStartDetail($: EngineInterface, agentId: string | undefined, callId: string, tool: string, to: unknown): Promise<void> {
  const at = await now($)
  const board = await read($, boardAtom)
  const target = agentId === undefined && tool === 'SendMessage' ? targetOf(board, to) : null
  await update($, detailAtom, d => detailToolStart(d, agentId, callId, tool, at, target))
}

/** That call ended (answered or thrown): the run goes. */
async function onToolEndDetail($: EngineInterface, agentId: string | undefined, callId: string): Promise<void> {
  const at = await now($)
  await update($, detailAtom, d => detailToolEnd(d, agentId, callId, at))
}

async function onClear($: EngineInterface): Promise<void> {
  const at = await now($)
  await resetBoardQueued($, at)
  await touchNow($, at)
  stopClock()
  await update($, detailAtom, () => emptyDetail())
  await update($, uiAtom, () => emptyUi())
  await update($, logAtom, () => emptyLog())
}

async function onPaneClosed($: EngineInterface): Promise<void> {
  await setPaneOpen($, false)
}

/**
 * What the board measures right now, so the orchestrator can check it without
 * seeing the pane: the active task's workers and any live worker of another
 * task (with `, task <id>` in its bracket), then ` | other tasks: N ended`
 * when N > 0, then the barred kinds. '' when it cannot be read.
 */
async function trackedLine($: EngineInterface): Promise<string> {
  try {
    const board = await read($, boardAtom)
    const workers = shownBoxes(board)
    const bars = barred(board)
    const ended = otherEnded(board)
    const tail = `${ended > 0 ? ` | other tasks: ${ended} ended` : ''}${bars.length > 0 ? ` | barred: ${bars.map(x => `${x.tier} ${x.kind}`).join(', ')}` : ''}`
    if (workers.length === 0) return `tracked workers: none${tail}`
    const parts = workers.map(w => {
      const tier = tierOf(board, w)
      const other = otherTaskOf(board, w)
      const issue = auditIssue(board, w)
      const mark = issue === 'no-audit' ? ', NO AUDIT' : issue === 'tier-mismatch' ? ', TIER MISMATCH' : ''
      return `${w.label} [${w.status}${tier !== null ? `, ${tier}` : ''}${mark}${w.unitId ? `, unit ${w.unitId}` : ''}${w.tokens ? '' : ', no tokens'}${other !== null ? `, task ${other}` : ''}]`
    })
    return `tracked workers: ${parts.join('; ')}${tail}`
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- drawing inputs

type BaseModel = Omit<ViewModel, 'detail' | 'ui' | 'log' | 'onSelect'>

async function baseModel($: EngineInterface, width: number, height: number | null): Promise<BaseModel> {
  const board = await read($, boardAtom)
  const live = await read($, liveAtom)
  const at = live.now > 0 ? live.now : board.loadedAt
  const unitStates: ViewModel['unitStates'] = {}
  for (const u of board.units) unitStates[u.id] = unitState(board, u)
  const quiet: ViewModel['quiet'] = {}
  for (const box of Object.values(board.agents)) if (isQuiet(box, at)) quiet[box.id] = true
  return { board, now: at, width, height, unitStates, quiet, sessionTotal: live.sessionTotal }
}

/** The pane's model: reads (and so redraws on) detail, ui and the log as well. */
async function paneModel($: EngineInterface, width: number, height: number | null): Promise<ViewModel> {
  const base = await baseModel($, width, height)
  const detail = await read($, detailAtom)
  const ui = await read($, uiAtom)
  const log = await read($, logAtom)
  return {
    ...base,
    detail,
    ui,
    log,
    onSelect: id => {
      pressCard($, id).catch(() => undefined)
    },
  }
}

/** The band's model: never reads detail, ui or the log, so a selection or a log entry does not redraw it. */
async function bandModel($: EngineInterface, width: number): Promise<ViewModel> {
  const base = await baseModel($, width, null)
  return { ...base, detail: emptyDetail(), ui: emptyUi(), log: emptyLog(), onSelect: () => undefined }
}

/** Whether the band should draw: the pane is not placed and the board has a phase or a worker. */
async function wantsBand($: EngineInterface): Promise<boolean> {
  const board = await read($, boardAtom)
  const live = await read($, liveAtom) // subscribes the band to pane open/close and the tick
  const hasWorker = board.order.some(id => id !== MAIN_ID)
  if (board.phase === null && !hasWorker) return false
  try {
    return !(await paneIsOpen($)).placed
  } catch {
    return !live.paneOpen
  }
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await registerBoardTool($)
    await registerBoardCommand($)
    try {
      await onSessionStart($)
    } catch {
      // the board stays as it was
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    try {
      if (e.reason === 'clear') await onClear($)
      else stopClock()
    } catch {
      // nothing to undo
    }
    return ended
  })

  // The AgentBoard tool: the one hook that answers for itself.
  on('tool.call', { tool: 'mcp__flowestra__AgentBoard' }, async ($, e) => {
    if (e.agentId !== undefined) return { deny: 'only the orchestrator updates the board' }
    const answer = answerBoardCall(e)
    if ('deny' in answer) return { deny: answer.deny }
    const barred = await barredRefusal($, answer.update.units)
    if (barred !== null) return { deny: barred }
    const done = await boardToolUpdate($, answer.update, answer.line)
    return 'deny' in done ? { deny: done.deny } : { result: done.text }
  }).catch(() => ({ deny: 'AgentBoard could not update the board; it keeps its previous value' }))

  // Forks (B2): an Agent tool call whose subagent_type is `fork` is refused with
  // denyFork's text (the gate refuses a main-loop fork too, should it reach
  // agent.spawn); every other Agent call goes on untouched. Fails open: an
  // error in the check, or in this hook, lets the call through.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const refusal = await forkRefusal(e)
    if (refusal !== null) {
      try {
        await logRefusal($, 'fork')
      } catch {
        // the log misses this refusal; the refusal stands
      }
      return { deny: refusal }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Every other tool call: last tool, a main-loop SendMessage's arrow, and
  // the run in flight in the agent's detail (only for a call with an id).
  on('tool.call', async ($, e, next) => {
    const to = (e as { to?: unknown }).to
    try {
      await onToolCall($, e.agentId, String(e.tool), to)
    } catch {
      // bookkeeping only
    }
    const callId = typeof e.tool_use_id === 'string' ? e.tool_use_id : ''
    if (callId.length === 0) return next(e)
    try {
      await onToolStartDetail($, e.agentId, callId, String(e.tool), to)
    } catch {
      // bookkeeping only
    }
    try {
      return await next(e)
    } finally {
      try {
        await onToolEndDetail($, e.agentId, callId)
      } catch {
        // bookkeeping only: next's answer or error passes on untouched
      }
    }
  })

  // The tier workers replace these built-in types (policy §1): kept out of the
  // model's listing and refused at dispatch. A hook that fails passes the type
  // through; the spawn gate refuses it all the same. The list is state.ts's
  // REFUSED_BUILTINS, then `fork` (B2: refused at the gate and at the Agent
  // tool), spelled out so validate reads the matcher off the source.
  on('agent.offer', { agent: ['Explore', 'Plan', 'general-purpose', 'claude', 'web-fetch', 'claude-code-guide', 'fork'] }, async () => ({ isOffered: false })).catch(
    ($, e, next) => (next.called ? next(e) : { isOffered: false }),
  )

  on('agent.spawn', async ($, e, next) => {
    // the covering unit's context, resolved (W3); fails open: null
    const context = await spawnContext($, e)
    // the Model Routing Policy's spawn gate (§1, §8, §9, spec on disk, context); fails open
    const refusal = await spawnRefusal($, e, context?.missing ?? null)
    if (refusal !== null) {
      try {
        await logRefusal($, e.name ?? e.description)
      } catch {
        // the log misses this refusal; the refusal stands
      }
      return { deny: refusal }
    }
    const unit = await auditedUnit($, e)
    // the two rewrites, for a main-loop spawn a unit covers: context appended to
    // the prompt, and cwd set to the task's repository (B2, P1 yes)
    const inlined = context !== null && context.missing === null && context.resolved.length > 0 ? withContext(e.prompt, context.resolved) : null
    const cwd = unit !== null && e.cwd === undefined && e.parentAgentId === undefined && e.resume === undefined ? await taskCwd($) : null
    const sent = inlined === null && cwd === null ? e : { ...e, ...(inlined !== null ? { prompt: inlined.prompt } : {}), ...(cwd !== null ? { cwd } : {}) }
    const result = await next(sent)
    const started = 'deny' in result && result.deny !== undefined ? null : result
    const agentId = started !== null && typeof started.agentId === 'string' ? started.agentId : ''
    try {
      if (started !== null && agentId !== '') {
        await onSpawn($, {
          agentId,
          description: e.description,
          subagentType: e.subagentType,
          model: started.model,
          name: e.name,
          parentAgentId: e.parentAgentId,
          promptChars: e.prompt.length,
          prompt: e.prompt,
          resumed: e.resume !== undefined,
        })
      }
    } catch {
      // bookkeeping only: the spawn stands as it was answered
    }
    try {
      if (agentId !== '' && unit !== null) await auditSpawn($, unit, agentId)
    } catch {
      // the audit file misses this line; the spawn stands
    }
    try {
      if (agentId !== '' && started !== null) {
        const at = await now($)
        if (e.resume !== undefined) await journalResume($, agentId, e.prompt, at)
        else if (unit !== null) {
          const ranIn = cwd ?? e.cwd ?? (await failOpen(() => $.session.cwd()))
          const je = await newEntry(
            $,
            unit,
            { agentId, subagentType: e.subagentType, model: started.model, prompt: e.prompt, cwd: ranIn, context: inlined?.status ?? [] },
            at,
          )
          if (je !== null) await journalSpawn($, je, at)
        }
      }
    } catch {
      // the journal misses this spawn; the spawn stands
    }
    return result
  })

  on('turn.start', async ($, e, next) => {
    try {
      await onTurnStart($, e.agentId)
    } catch {
      // bookkeeping only
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    try {
      await onStep($, e.agentId, r.usage)
    } catch {
      // bookkeeping only
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    try {
      await onComplete($, e.agentId, { reason: e.reason, answerChars: e.answer.length })
    } catch {
      // bookkeeping only
    }
    try {
      if (e.agentId !== undefined) await journalComplete($, e.agentId, e.reason, e.answer, await now($))
    } catch {
      // the journal misses this result; the turn stands
    }
    return done
  })

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    try {
      if (e.id === PANE_ID) await onPaneClosed($)
    } catch {
      // live.paneOpen is corrected at the next /board or session start
    }
    return closed
  })

  on('command.run', { command: 'board' }, async $ => ({ text: boardCommandText(await toggleBoard($)) })).catch(
    () => ({ text: 'Agent Board: the pane could not be opened or closed.' }),
  )

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!wantsBoardSection(e.traits)) return composed
    return { sections: withBoardSection(composed.sections) }
  })

  // The pane. On the terminal the flow diagram is the surface module, keyed
  // 'agent-flow' (what `e.element` carries at ui.message); the module path
  // must stay a string literal: the engine reads it off this source.
  on('ui.render', { component: 'Pane', requestId: 'flowestra' }, async ($, e) => {
    const vm = await paneModel($, e.props.bodyColumns, e.props.scroll.bodyRows)
    if (e.surface === 'terminal') {
      const { Client } = $.ui.resolve(e)
      const flow = <Client key="agent-flow" module="./flow.client.tsx" props={flowProps(vm)} width={vm.width} />
      return drawPane($.ui.resolve(e), vm, flow)
    }
    return drawPane($.ui.resolve(e), vm, null)
  })

  // A worker card pressed in the flow module: `{ select: id }`. The data came from
  // code, so it is checked; the answer beneath is handed on untouched.
  on('ui.message', { element: 'agent-flow' }, async ($, e, next) => {
    const answer = await next(e)
    try {
      const data = e.data
      if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
        const select = (data as { select?: unknown }).select
        if (typeof select === 'string' && select.length > 0) await pressCard($, select)
      }
    } catch {
      // bookkeeping only
    }
    return answer
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!(await wantsBand($))) return next(e)
    const vm = await bandModel($, e.props.bodyColumns)
    return drawBand($.ui.resolve(e), vm)
  })
}
