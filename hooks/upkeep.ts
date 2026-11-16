// Flowestra: the `/journal` command (0.11.0, decisions.md "Journal hardening: cleanup,
// masking, and multi-session fixes", sections 3.1-3.3 and 4.3 F5, with the owner's
// amendments A1 and A2). status, prune (dry run, confirm, by name) and check.
//
// THIS IS THE ONLY CODE IN THE MOD THAT DELETES ANYTHING, and it deletes in one place:
// `removeTree`, the single `$.process.run` call site. The rules it keeps:
// - A1, manual only: the one path to `removeTree` is `/journal prune ... confirm <code>`
//   whose origin is the person's own keystroke (`composer` or `bridge`) and whose code
//   matches a plan rebuilt at that moment. Nothing prunes on its own; prune.log lines
//   always say `manual`.
// - A2, own files only: task folders directly under a repository folder of
//   `<config>/flowestra/journal`, a repository folder this prune left with no task
//   folder, and audit files directly under `<config>/flowestra/audit`, each checked by
//   name, by a listing of its parent in this run, and by `$.fs.stat(..., { resolve: true })`
//   right before `rm`; one absolute path per `rm`; never a link, a glob, a root, or
//   anything in a project. A check that fails or throws skips that item.
// - On Windows nothing is deleted and the dry run already lists the folders to remove by
//   hand. Elsewhere the mod never probes for host commands: a `$.process.run` that rejects,
//   or is not there (the call throws), is found at `removeTree`'s one call site, and the
//   prune stops there; when nothing was deleted yet, nothing is deleted, overwritten or
//   truncated and the answer lists the folders for the person to remove.
// `check` never deletes: it writes derived files and this session's own shards only.

import type { EngineInterface } from 'claude-code'

import type { TaskSlot } from '../types'
import {
  entryFromText,
  journalRoot,
  lineKey,
  parseContextItem,
  parseStateJson,
  parseStateWriter,
  phaseLineOfData,
  repoKey,
  rootIndexLine,
  stateJsonPath,
  taskLineOf,
} from './journal'
import {
  configRootOf,
  journaled,
  listEntryFiles,
  readShards,
  readStateText,
  readWholeEntry,
  regenIndex,
  shardCache,
  writeShard,
} from './journal-fs'
import {
  COMMAND_ARGUMENT_HINT,
  COMMAND_DESCRIPTION,
  byNameRefusedText,
  byNameText,
  checkText,
  doneText,
  dryRunText,
  failureText,
  isAuditName,
  isRepoKey,
  isTaskId,
  namedAsContext,
  parseJournalArgs,
  planPrune,
  pruneCode,
  pruneLogAuditLine,
  pruneLogPath,
  pruneLogTaskLine,
  pruneTarget,
  refusedText,
  statusText,
  tombstoneLine,
  usageText,
} from './prune'
import type { AuditInfo, ByNameRefusal, Kept, PrunePlan, TaskInfo } from './prune'
import type { JournalPolicy } from './redact'

export const JOURNAL_COMMAND = 'journal'

/** What the command needs from its `command.run` event. `origin` may be missing: then it is not the person's keystroke. */
export type JournalCommandEvent = { args?: string; origin?: { kind?: string } | null }

/** This session's board (every slot: active, parked, closed) and the journal settings. */
export type JournalCommandContext = { slots: readonly TaskSlot[]; policy: JournalPolicy }

type PruneArgs =
  | { kind: 'prune'; days: number; confirm: string | null }
  | { kind: 'prune-task'; key: string; taskId: string; confirm: string | null }

// ---------------------------------------------------------------- registration and entry

/** Declares `/journal`. Never throws: a failure is one transcript line (as `/board`, hooks/board.ts). */
export async function registerJournalCommand($: EngineInterface): Promise<void> {
  try {
    await $.command.register({ name: JOURNAL_COMMAND, description: COMMAND_DESCRIPTION, argumentHint: COMMAND_ARGUMENT_HINT })
  } catch (error) {
    note($, `flowestra: /journal not registered: ${String(error)}`)
  }
}

/** Serves `/journal <args>`. Never throws: any failure answers `failureText()`. */
export async function runJournalCommand($: EngineInterface, e: JournalCommandEvent, ctx: JournalCommandContext): Promise<string> {
  try {
    const args = parseJournalArgs(typeof e?.args === 'string' ? e.args : '')
    const c: JournalCommandContext = {
      slots: Array.isArray(ctx?.slots) ? ctx.slots : [],
      policy: { masking: ctx?.policy?.masking !== false, content: ctx?.policy?.content ?? 'full' },
    }
    if (args.kind === 'usage') return usageText()
    if (args.kind === 'status') return await statusOf($, c)
    if (args.kind === 'check') return await checkJournal($)
    if (args.confirm === null) return await dryRun($, c, args)
    return await confirmPrune($, c, args, e)
  } catch {
    return failureText()
  }
}

// ---------------------------------------------------------------- small helpers

function note($: EngineInterface, text: string): void {
  try {
    $.ui.log(text)
  } catch {
    // a failed transcript line changes nothing
  }
}

type Listed = { name: string; kind: string; size: number; mtimeMs: number; isLink: boolean }

/** A folder's entries, or null when it cannot be listed. `isLink` is true unless the listing says exactly false. */
async function listOrNull($: EngineInterface, folder: string): Promise<Listed[] | null> {
  try {
    const got = await $.fs.list(folder)
    if (!Array.isArray(got)) return null
    return got.map(x => ({
      name: String(x.name),
      kind: String(x.kind),
      size: Number.isFinite(x.size) ? x.size : 0,
      mtimeMs: Number.isFinite(x.mtimeMs) ? x.mtimeMs : 0,
      isLink: x.isLink !== false,
    }))
  } catch {
    return null
  }
}

const isPlainDir = (x: Listed): boolean => x.kind === 'dir' && x.isLink === false
const isPlainFile = (x: Listed): boolean => x.kind === 'file' && x.isLink === false
/** Entries the journal keeps beside its folders: `index.md` and the dot folders (`.shards`). */
const isHousekeeping = (x: Listed): boolean => x.name.startsWith('.') || (x.name === 'index.md' && isPlainFile(x))

/** An absolute POSIX path with no empty, `.` or `..` segment and no trailing slash (or `/` itself). */
function isCleanAbs(p: unknown): p is string {
  if (typeof p !== 'string' || !p.startsWith('/')) return false
  if (p === '/') return true
  return p.slice(1).split('/').every(s => s !== '' && s !== '.' && s !== '..')
}

/** `yyyymmdd-hhmmss` at the start of an entry file name, as epoch ms; null when it is not one. */
function stampMs(name: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name)
  if (m === null) return null
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

type Places = { config: string; journal: string; audit: string; sessionId: string; ownAuditName: string }

/** The configured folders: `<config>/flowestra/journal` and `<config>/flowestra/audit`, and this session's audit file name. */
async function placesOf($: EngineInterface): Promise<Places> {
  const config = await configRootOf($)
  const journal = journalRoot(config)
  const audit = `${journal.slice(0, -'journal'.length)}audit`
  const sessionId = String(await $.session.id())
  return { config, journal, audit, sessionId, ownAuditName: `${sessionId}.log` }
}

// ---------------------------------------------------------------- walking the journal

type TaskRecord = { info: TaskInfo; slot: TaskSlot | null }
type Walk = { records: TaskRecord[]; odd: Kept[] }

/** Bytes of the files in `folder` and in its plain sub-folders down to `depth` more levels; null when `folder` cannot be listed. */
async function folderBytes($: EngineInterface, folder: string, depth: number): Promise<{ bytes: number; newest: number } | null> {
  const items = await listOrNull($, folder)
  if (items === null) return null
  let bytes = 0
  let newest = 0
  for (const x of items) {
    if (isPlainFile(x)) {
      bytes += x.size
      newest = Math.max(newest, x.mtimeMs)
    } else if (isPlainDir(x) && depth > 0) {
      const sub = await folderBytes($, `${folder}/${x.name}`, depth - 1)
      if (sub !== null) {
        bytes += sub.bytes
        newest = Math.max(newest, sub.newest)
      }
    }
  }
  return { bytes, newest }
}

/** One task folder as `TaskInfo`: its state (open, closed, or unreadable when it cannot be classified), sizes and entry dates. */
async function taskRecord($: EngineInterface, root: string, key: string, taskId: string): Promise<TaskRecord> {
  const path = `${root}/${key}/${taskId}`
  const state = await readStateText($, root, key, taskId).catch(() => null)
  const slot = state !== null && state.source !== 'unreadable' ? parseStateJson(state.text) : null
  const writer = state !== null && slot !== null ? parseStateWriter(state.text) : null
  const items = await listOrNull($, path)
  let bytes = 0
  let newest = 0
  let entries = 0
  let firstMs: number | null = null
  let lastMs: number | null = null
  for (const x of items ?? []) {
    if (isPlainFile(x)) {
      bytes += x.size
      newest = Math.max(newest, x.mtimeMs)
      continue
    }
    if (!isPlainDir(x)) continue
    const sub = await folderBytes($, `${path}/${x.name}`, 1)
    if (sub !== null) {
      bytes += sub.bytes
      newest = Math.max(newest, sub.newest)
    }
    if (x.name.startsWith('.')) continue
    for (const f of await listEntryFiles($, `${path}/${x.name}`)) {
      entries += 1
      const ms = stampMs(f.name) ?? (f.mtimeMs > 0 ? f.mtimeMs : null)
      if (ms !== null) {
        firstMs = firstMs === null ? ms : Math.min(firstMs, ms)
        lastMs = lastMs === null ? ms : Math.max(lastMs, ms)
      }
    }
  }
  // A folder that cannot be listed cannot be sized: unreadable, so it is kept.
  const status = items === null || slot === null ? 'unreadable' : slot.status
  return {
    info: { key, taskId, status, updatedMs: writer?.updatedMs ?? newest, entries, bytes, firstMs, lastMs, path },
    slot,
  }
}

/**
 * Every task folder `<root>/<repo-key>/<task-id>` that is a plain folder (from listings,
 * not followed through links) with names that pass the rules. Anything else in those two
 * levels (a link, a file, a bad name, a folder that cannot be listed) is not walked and is
 * returned as a kept item; `index.md` and dot folders are the journal's own and skipped.
 */
async function walkJournal($: EngineInterface, root: string | null): Promise<Walk> {
  const records: TaskRecord[] = []
  const odd: Kept[] = []
  const top = root === null ? null : await listOrNull($, root)
  for (const r of top ?? []) {
    if (isHousekeeping(r)) continue
    if (!isRepoKey(r.name)) {
      odd.push({ item: `${r.name}/`, kind: 'task', reason: 'name' })
      continue
    }
    const inner = isPlainDir(r) ? await listOrNull($, `${root}/${r.name}`) : null
    if (inner === null) {
      odd.push({ item: `${r.name}/`, kind: 'task', reason: 'unreadable' })
      continue
    }
    for (const t of inner) {
      if (isHousekeeping(t)) continue
      const item = `${r.name}/${t.name}`
      if (!isTaskId(t.name)) odd.push({ item, kind: 'task', reason: 'name' })
      else if (!isPlainDir(t)) odd.push({ item, kind: 'task', reason: 'unreadable' })
      else records.push(await taskRecord($, root as string, r.name, t.name))
    }
  }
  return { records, odd }
}

/** The audit files of `folder`; an entry that is not a plain file gets an empty path, so the plan keeps it. */
async function auditInfos($: EngineInterface, folder: string | null): Promise<AuditInfo[]> {
  const items = folder === null ? null : await listOrNull($, folder)
  return (items ?? []).map(x => ({ name: x.name, path: isPlainFile(x) ? `${folder}/${x.name}` : '', bytes: x.size, mtimeMs: x.mtimeMs }))
}

// ---------------------------------------------------------------- protection 3: context

type ContextSource = { name: string; slot: TaskSlot }

/**
 * The open tasks whose units protect other tasks (3.1, protection 3): open on disk, or
 * open on this session's board. `except` (a prune by name) leaves out the named task
 * itself: a task's own units do not protect that task.
 */
function contextSources(records: readonly TaskRecord[], slots: readonly TaskSlot[], except: { key: string; taskId: string } | null): ContextSource[] {
  const out: ContextSource[] = []
  for (const r of records) {
    if (r.slot === null || r.slot.status !== 'open') continue
    if (except !== null && r.info.key === except.key && r.info.taskId === except.taskId) continue
    out.push({ name: `${r.info.key}/${r.info.taskId}`, slot: r.slot })
  }
  for (const s of slots) {
    if (s?.status !== 'open') continue
    if (except !== null && s.taskId === except.taskId) continue
    out.push({ name: typeof s.repo === 'string' && s.repo !== '' ? `${repoKey(s.repo)}/${s.taskId}` : s.taskId, slot: s })
  }
  return out
}

/** The task ids (`<task>:<unit>` items) and paths (path items and specs) the units of `sources` name. */
function contextOf(sources: readonly ContextSource[]): { ids: string[]; paths: string[] } {
  const ids: string[] = []
  const paths: string[] = []
  for (const s of sources) {
    for (const u of Array.isArray(s.slot.units) ? s.slot.units : []) {
      for (const item of Array.isArray(u.context) ? u.context : []) {
        const c = typeof item === 'string' ? parseContextItem(item) : null
        if (c?.kind === 'entry') ids.push(c.taskId)
        else if (c?.kind === 'path') paths.push(c.path)
      }
      if (typeof u.spec === 'string' && u.spec.trim() !== '') paths.push(u.spec)
    }
  }
  return { ids, paths }
}

// ---------------------------------------------------------------- the roots (A2)

type Roots =
  | { ok: true; journal: string | null; audit: string | null; expectedJournal: string; expectedAudit: string }
  | { ok: false; text: string }

function rootRefusal(path: string, expected: string): Roots {
  return { ok: false, text: `Journal prune: ${path} could not be confirmed to be ${expected} with links followed; nothing is deleted.` }
}

/**
 * The resolved journal and audit folders. Each must be exactly `<resolved config root>/
 * flowestra/journal` (and `/audit`), a folder; one that does not exist is null (nothing
 * to prune there). One that exists but resolves elsewhere refuses the whole prune.
 */
async function resolveRoots($: EngineInterface, p: Places): Promise<Roots> {
  const none: Roots = { ok: true, journal: null, audit: null, expectedJournal: p.journal, expectedAudit: p.audit }
  if (!(await $.fs.exists(p.config))) return none
  const cs = await $.fs.stat(p.config, { resolve: true }).catch(() => null)
  const realConfig = cs?.realPath
  if (cs === null || cs.kind !== 'dir' || !isCleanAbs(realConfig)) return rootRefusal(p.config, 'a folder')
  const base = realConfig === '/' ? '' : realConfig
  const expectedJournal = `${base}/flowestra/journal`
  const expectedAudit = `${base}/flowestra/audit`
  const at = async (path: string, expected: string): Promise<string | null | false> => {
    if (!(await $.fs.exists(path))) return null
    const s = await $.fs.stat(path, { resolve: true }).catch(() => null)
    return s !== null && s.kind === 'dir' && s.realPath === expected ? expected : false
  }
  const journal = await at(p.journal, expectedJournal)
  if (journal === false) return rootRefusal(p.journal, expectedJournal)
  const audit = await at(p.audit, expectedAudit)
  if (audit === false) return rootRefusal(p.audit, expectedAudit)
  return { ok: true, journal, audit, expectedJournal, expectedAudit }
}

/**
 * False on Windows (`OS` is `Windows_NT`) or when that cannot be read (fails closed); true
 * otherwise. It never probes for host commands: whether `$.process.run` is there is learned
 * only at `removeTree`'s one call site, where a rejection (or a missing command) stops the
 * prune with nothing more deleted.
 */
async function canDeleteHere($: EngineInterface): Promise<boolean> {
  try {
    return (await $.env.get('OS')) !== 'Windows_NT'
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- the plan

type Built = { plan: PrunePlan; records: TaskRecord[]; sources: ContextSource[]; days: number; code: string }

/** Walks the resolved journal and audit folders and plans with every protection of 3.1. */
async function buildPlan($: EngineInterface, ctx: JournalCommandContext, p: Places, roots: Extract<Roots, { ok: true }>, nowMs: number, args: PruneArgs): Promise<Built> {
  const walk = await walkJournal($, roots.journal)
  const audits = await auditInfos($, roots.audit)
  const except = args.kind === 'prune-task' ? { key: args.key, taskId: args.taskId } : null
  const sources = contextSources(walk.records, ctx.slots, except)
  const context = contextOf(sources)
  const days = args.kind === 'prune' ? args.days : 0
  const planned = planPrune({
    nowMs,
    days,
    tasks: walk.records.map(r => r.info),
    audits,
    boardTaskIds: ctx.slots.map(s => s?.taskId).filter((t): t is string => typeof t === 'string'),
    contextTaskIds: context.ids,
    contextPaths: context.paths,
    ownAuditName: p.ownAuditName,
    byName: except === null ? null : `${except.key}/${except.taskId}`,
    journalRoot: roots.journal ?? roots.expectedJournal,
    auditRoot: roots.audit ?? roots.expectedAudit,
  })
  const plan: PrunePlan = except === null ? { ...planned, kept: [...planned.kept, ...walk.odd] } : planned
  return { plan, records: walk.records, sources, days, code: pruneCode(plan, days) }
}

/** The refusal text of a by-name plan that names no task. */
function refusalOf(built: Built, args: { key: string; taskId: string }): string {
  const item = `${args.key}/${args.taskId}`
  const k = built.plan.kept.find(x => x.kind === 'task')
  const known: readonly string[] = ['board', 'context', 'unreadable', 'missing', 'name']
  const reason: ByNameRefusal = k !== undefined && known.includes(k.reason) ? (k.reason as ByNameRefusal) : 'missing'
  let by: string | null = null
  if (reason === 'context') {
    const target = built.records.find(r => r.info.key === args.key && r.info.taskId === args.taskId)?.info
    if (target !== undefined) {
      for (const s of built.sources) {
        const c = contextOf([s])
        if (namedAsContext(target, c.ids, c.paths)) {
          by = s.name
          break
        }
      }
    }
  }
  return byNameRefusedText(item, reason, by)
}

// ---------------------------------------------------------------- status and dry run

async function statusOf($: EngineInterface, ctx: JournalCommandContext): Promise<string> {
  const p = await placesOf($)
  const walk = await walkJournal($, (await $.fs.exists(p.journal)) ? p.journal : null)
  const audits = (await auditInfos($, (await $.fs.exists(p.audit)) ? p.audit : null)).filter(a => a.path !== '')
  return statusText({
    journalRoot: p.journal,
    nowMs: await $.clock.now(),
    tasks: walk.records.map(r => r.info),
    audits,
    masking: ctx.policy.masking,
    content: ctx.policy.content,
  })
}

/** `/journal prune <days>` and `/journal prune task <name>`: reads only, never calls `$.process.run`. */
async function dryRun($: EngineInterface, ctx: JournalCommandContext, args: PruneArgs): Promise<string> {
  const p = await placesOf($)
  const roots = await resolveRoots($, p)
  if (!roots.ok) return roots.text
  const built = await buildPlan($, ctx, p, roots, await $.clock.now(), args)
  const canDelete = await canDeleteHere($)
  if (args.kind === 'prune') return dryRunText({ plan: built.plan, days: built.days, code: built.code, canDelete })
  const task = built.plan.tasks[0]
  if (task === undefined) return refusalOf(built, args)
  return byNameText({ task, code: built.code, canDelete })
}

// ---------------------------------------------------------------- deleting

type Guard = {
  /** The resolved journal root, `<resolved config>/flowestra/journal`, or null when there is none. */
  journal: string | null
  /** The resolved audit folder, `<resolved config>/flowestra/audit`, or null. */
  audit: string | null
  /** Task ids on this session's board, lower case. */
  board: Set<string>
  /** Repository keys of this session's board tasks. */
  boardKeys: Set<string>
  /** This session's audit file name, lower case. */
  ownAudit: string
}

type Target =
  | { kind: 'task'; key: string; taskId: string }
  | { kind: 'repo'; key: string }
  | { kind: 'audit'; name: string }

type Removal = { removed: true; path: string } | { removed: false; reason: string; unavailable?: true }

/** True when a repository folder holds nothing but `index.md` and a `.shards` folder of plain `.tsv` files. */
async function holdsOnlyIndexes($: EngineInterface, folder: string): Promise<boolean> {
  const items = await listOrNull($, folder)
  if (items === null) return false
  for (const x of items) {
    if (x.name === 'index.md' && isPlainFile(x)) continue
    if (x.name === '.shards' && isPlainDir(x)) {
      const shards = await listOrNull($, `${folder}/.shards`)
      if (shards === null || !shards.every(s => isPlainFile(s) && s.name.endsWith('.tsv'))) return false
      continue
    }
    return false
  }
  return true
}

/**
 * Removes ONE task folder, emptied repository folder or audit file, after every check of
 * 3.2 and A2; the only `$.process.run` in the mod. Never throws. Counted removed only when
 * `$.fs.exists` then says the path is gone.
 */
async function removeTree($: EngineInterface, target: Target, guard: Guard): Promise<Removal> {
  const skip = (reason: string): Removal => ({ removed: false, reason })
  try {
    // 1. The root: resolved, clean, and the mod's own folder.
    const inJournal = target.kind === 'task' || target.kind === 'repo'
    const root = inJournal ? guard.journal : guard.audit
    if (root === null || !isCleanAbs(root) || root === '/') return skip('outside the journal')
    if (inJournal ? !root.endsWith('/flowestra/journal') : !root.endsWith('/flowestra/audit')) return skip('outside the journal')

    // 2. The names, the board and this session's audit file.
    let parent: string
    let name: string
    let want: 'dir' | 'file'
    if (target.kind === 'task') {
      if (!isRepoKey(target.key) || !isTaskId(target.taskId)) return skip('a name the journal does not use')
      if (guard.board.has(target.taskId.toLowerCase())) return skip("on this session's board")
      parent = `${root}/${target.key}`
      name = target.taskId
      want = 'dir'
    } else if (target.kind === 'repo') {
      if (!isRepoKey(target.key)) return skip('a name the journal does not use')
      if (guard.boardKeys.has(target.key)) return skip("on this session's board")
      parent = root
      name = target.key
      want = 'dir'
    } else {
      if (!isAuditName(target.name)) return skip('a name the journal does not use')
      if (guard.ownAudit === '' || target.name.toLowerCase() === guard.ownAudit) return skip("this session's own audit file")
      parent = root
      name = target.name
      want = 'file'
    }
    const path = `${parent}/${name}`

    // 3. Listed by its parent in this run, as itself: the kind wanted, not a link.
    const listed = await listOrNull($, parent)
    const entry = listed?.find(x => x.name === name)
    if (entry === undefined) return skip('not listed in its folder')
    if (entry.isLink !== false) return skip('a link')
    if (entry.kind !== want) return skip(want === 'dir' ? 'not a folder' : 'not a file')

    // 4. Resolved: still not a link, the kind wanted, and landing exactly where it should.
    const stat = await $.fs.stat(path, { resolve: true })
    if (stat.isLink !== false) return skip('a link')
    if (stat.kind !== want) return skip(want === 'dir' ? 'not a folder' : 'not a file')
    if (stat.realPath !== path) return skip('resolves outside the journal')

    // 5. A repository folder only when nothing but its indexes is left in it.
    if (target.kind === 'repo' && !(await holdsOnlyIndexes($, path))) return skip('still holds files')

    // 6. The last word: one clean absolute path directly at the depth checked above.
    if (!isCleanAbs(path) || !path.startsWith(`${root}/`) || path === root) return skip('outside the journal')
    const depth = path.slice(root.length + 1).split('/').length
    if (depth !== (target.kind === 'task' ? 2 : 1)) return skip('outside the journal')

    // A rejection, or no host commands at all (the call then throws), is "unavailable".
    try {
      await $.process.run(want === 'dir' ? ['rm', '-rf', '--', path] : ['rm', '-f', '--', path])
    } catch {
      return { removed: false, reason: 'host commands are not available here', unavailable: true }
    }
    const still = await $.fs.exists(path).catch(() => true)
    return still ? skip('still there after rm') : { removed: true, path }
  } catch {
    return skip('could not be checked')
  }
}

/** Forgets this session's cached shard lines under a deleted folder, so no later write brings them back. */
function forgetShards(folders: readonly string[]): void {
  for (const k of [...shardCache.keys()]) {
    if (folders.some(f => k.startsWith(`${f}/`))) shardCache.delete(k)
  }
}

/** Appends one line to prune.log (read, then write whole). Never overwrites a log it could not read. Never throws. */
async function appendPruneLog($: EngineInterface, path: string, line: string): Promise<boolean> {
  try {
    let old = ''
    if (await $.fs.exists(path)) old = String(await $.fs.read(path))
    await $.fs.write(path, `${old}${old === '' || old.endsWith('\n') ? '' : '\n'}${line}\n`)
    return true
  } catch {
    return false
  }
}

type Progress = {
  deletedTasks: TaskInfo[]
  deletedAudits: AuditInfo[]
  notDeleted: { item: string; reason: string }[]
  unavailable: boolean
}

/** `/journal prune ... confirm <code>`. The origin first; then, as one journal job, the plan rebuilt, the code compared, and the deletions. */
async function confirmPrune($: EngineInterface, ctx: JournalCommandContext, args: PruneArgs, e: JournalCommandEvent): Promise<string> {
  const code = args.confirm ?? ''
  const origin = e?.origin?.kind
  if (origin !== 'composer' && origin !== 'bridge') return refusedText('origin', pruneTarget(args), code)
  let answer: string | null = null
  await journaled(async () => {
    answer = await confirmJob($, ctx, args, code)
  })
  return answer ?? failureText()
}

async function confirmJob($: EngineInterface, ctx: JournalCommandContext, args: PruneArgs, code: string): Promise<string> {
  let built: Built
  let p: Places
  let roots: Extract<Roots, { ok: true }>
  let nowMs: number
  try {
    p = await placesOf($)
    const r = await resolveRoots($, p)
    if (!r.ok) return r.text
    roots = r
    nowMs = await $.clock.now()
    built = await buildPlan($, ctx, p, roots, nowMs, args)
  } catch {
    return failureText()
  }
  const { plan } = built
  if (args.kind === 'prune-task' && plan.tasks.length === 0) return refusalOf(built, args)
  if (built.code !== code) return refusedText('changed', pruneTarget(args), code)
  const manual = (): string => {
    const first = plan.tasks[0]
    return args.kind === 'prune' || first === undefined
      ? dryRunText({ plan, days: built.days, code: built.code, canDelete: false })
      : byNameText({ task: first, code: built.code, canDelete: false })
  }
  if (!(await canDeleteHere($))) return manual()
  if (plan.tasks.length === 0 && plan.audits.length === 0) return dryRunText({ plan, days: built.days, code: built.code, canDelete: true })

  const guard: Guard = {
    journal: roots.journal,
    audit: roots.audit,
    board: new Set(ctx.slots.map(s => s?.taskId).filter((t): t is string => typeof t === 'string').map(t => t.toLowerCase())),
    boardKeys: new Set(ctx.slots.map(s => s?.repo).filter((r): r is string => typeof r === 'string' && r !== '').map(r => repoKey(r))),
    ownAudit: p.ownAuditName.toLowerCase(),
  }
  const logPath = pruneLogPath(p.config)
  const progress: Progress = { deletedTasks: [], deletedAudits: [], notDeleted: [], unavailable: false }
  try {
    for (const t of plan.tasks) {
      if (progress.unavailable) break
      const r = await removeTree($, { kind: 'task', key: t.key, taskId: t.taskId }, guard)
      if (!r.removed) {
        progress.notDeleted.push({ item: `${t.key}/${t.taskId}`, reason: r.reason })
        if (r.unavailable === true) progress.unavailable = true
        continue
      }
      progress.deletedTasks.push(t)
      forgetShards([`${p.journal}/${t.key}/${t.taskId}`, `${t.path}`])
      try {
        await writeShard($, `${p.journal}/${t.key}`, t.taskId, tombstoneLine(t.taskId, nowMs), nowMs)
      } catch (error) {
        note($, `flowestra: /journal prune deleted ${t.key}/${t.taskId} but could not write its tombstone: ${String(error)}`)
      }
      const line = pruneLogTaskLine(nowMs, p.sessionId, t)
      if (!(await appendPruneLog($, logPath, line))) note($, `flowestra: /journal prune could not add to ${logPath}: ${line}`)
    }
    for (const a of plan.audits) {
      if (progress.unavailable) break
      const r = await removeTree($, { kind: 'audit', name: a.name }, guard)
      if (!r.removed) {
        progress.notDeleted.push({ item: a.name, reason: r.reason })
        if (r.unavailable === true) progress.unavailable = true
        continue
      }
      progress.deletedAudits.push(a)
      const line = pruneLogAuditLine(nowMs, p.sessionId, a)
      if (!(await appendPruneLog($, logPath, line))) note($, `flowestra: /journal prune could not add to ${logPath}: ${line}`)
    }
    if (progress.deletedTasks.length > 0) await afterTasks($, p, plan, progress, guard, nowMs)
  } catch (error) {
    note($, `flowestra: /journal prune stopped: ${String(error)}`)
  }

  // Every planned item neither deleted nor already reported is reported as not attempted.
  const reported = new Set(progress.notDeleted.map(n => n.item))
  const deleted = new Set([...progress.deletedTasks.map(t => `${t.key}/${t.taskId}`), ...progress.deletedAudits.map(a => a.name)])
  for (const item of [...plan.tasks.map(t => `${t.key}/${t.taskId}`), ...plan.audits.map(a => a.name)]) {
    if (!deleted.has(item) && !reported.has(item)) progress.notDeleted.push({ item, reason: progress.unavailable ? 'host commands are not available here' : 'not attempted' })
  }
  if (progress.unavailable && progress.deletedTasks.length === 0 && progress.deletedAudits.length === 0) return manual()
  return doneText({
    deletedTasks: progress.deletedTasks,
    deletedAudits: progress.deletedAudits,
    plannedTasks: plan.tasks.length,
    plannedAudits: plan.audits.length,
    notDeleted: progress.notDeleted,
    pruneLog: logPath,
  })
}

/**
 * After task folders are gone (3.3, index consistency): a repository the plan emptied is
 * removed when its listing shows nothing but its indexes, and its root key tombstoned;
 * every other touched repository gets its index regenerated and this session's root line
 * recomputed; then the root index. A failure here is logged, never thrown.
 */
async function afterTasks($: EngineInterface, p: Places, plan: PrunePlan, progress: Progress, guard: Guard, nowMs: number): Promise<void> {
  const deleted = new Set(progress.deletedTasks)
  const keys = [...new Set(progress.deletedTasks.map(t => t.key))].sort()
  let rootLines: string[] = []
  try {
    rootLines = (await readShards($, p.journal)).lines
  } catch {
    rootLines = []
  }
  for (const key of keys) {
    try {
      const allGone = plan.tasks.filter(t => t.key === key).every(t => deleted.has(t))
      if (allGone && plan.repos.includes(key)) {
        const r = await removeTree($, { kind: 'repo', key }, guard)
        if (r.removed) {
          forgetShards([`${p.journal}/${key}`, r.path])
          await writeShard($, p.journal, key, tombstoneLine(key, nowMs), nowMs)
          continue
        }
      }
      const lines = await regenIndex($, `${p.journal}/${key}`, 'repo', key, nowMs)
      const absRoot = rootLines.find(l => lineKey(l) === key)?.split(' | ')[1]
      if (absRoot !== undefined && absRoot !== '') {
        const open = lines.filter(l => l.split(' | ')[1] === 'open').length
        await writeShard($, p.journal, key, rootIndexLine({ repoKey: key, root: absRoot, openTasks: open, tasks: lines.length, updatedMs: nowMs }), nowMs)
      }
    } catch (error) {
      note($, `flowestra: /journal prune could not update the index of ${key}: ${String(error)}`)
    }
  }
  try {
    await regenIndex($, p.journal, 'root', 'journal', nowMs)
  } catch (error) {
    note($, `flowestra: /journal prune could not update the journal index: ${String(error)}`)
  }
}

// ---------------------------------------------------------------- check (F5)

/**
 * `/journal check`, one journal job: entry files with no phase line get one in this
 * session's shard (time: the file's mtime); a `state.json` that does not parse while its
 * backup does is restored from it; every index is regenerated. Never deletes.
 */
async function checkJournal($: EngineInterface): Promise<string> {
  let answer: string | null = null
  await journaled(async () => {
    answer = await checkJob($)
  })
  return answer ?? failureText()
}

async function checkJob($: EngineInterface): Promise<string> {
  const p = await placesOf($)
  const root = p.journal
  const nowMs = await $.clock.now()
  let tasks = 0
  let entries = 0
  let indexes = 0
  const added: string[] = []
  const restored: string[] = []
  const unreadableStates: string[] = []
  const unreadableEntries: string[] = []
  const top = await listOrNull($, root)
  if (top === null) return checkText({ tasks, entries, indexes, added, restored, unreadableStates, unreadableEntries })
  for (const r of top) {
    if (isHousekeeping(r) || !isRepoKey(r.name) || !isPlainDir(r)) continue
    const key = r.name
    const repoFolder = `${root}/${key}`
    for (const t of (await listOrNull($, repoFolder)) ?? []) {
      if (isHousekeeping(t) || !isTaskId(t.name) || !isPlainDir(t)) continue
      const taskId = t.name
      const taskFolder = `${repoFolder}/${taskId}`
      tasks += 1
      const state = await readStateText($, root, key, taskId)
      if (state?.source === 'backup') {
        await $.fs.write(stateJsonPath(root, key, taskId), state.text)
        restored.push(`${key}/${taskId}`)
      } else if (state?.source === 'unreadable') {
        unreadableStates.push(`${key}/${taskId}`)
      }
      for (const ph of (await listOrNull($, taskFolder)) ?? []) {
        if (!isPlainDir(ph) || ph.name.startsWith('.')) continue
        const phase = ph.name
        const phaseFolder = `${taskFolder}/${phase}`
        const files = await listEntryFiles($, phaseFolder)
        entries += files.length
        const have = new Set((await readShards($, phaseFolder)).lines.map(lineKey))
        let addedHere = 0
        for (const f of files) {
          if (have.has(f.name)) continue
          const where = `${key}/${taskId}/${phase}/${f.name}`
          let data = null
          try {
            data = entryFromText(await readWholeEntry($, `${phaseFolder}/${f.name}`))
          } catch {
            data = null
          }
          if (data === null) {
            unreadableEntries.push(where)
            continue
          }
          await writeShard($, phaseFolder, f.name, phaseLineOfData(f.name, data), f.mtimeMs > 0 ? f.mtimeMs : nowMs)
          added.push(where)
          addedHere += 1
        }
        const phaseLines = await regenIndex($, phaseFolder, 'phase', phase, nowMs)
        indexes += 1
        if (addedHere > 0) await writeShard($, taskFolder, phase, taskLineOf(phase, phaseLines, nowMs), nowMs)
      }
      await regenIndex($, taskFolder, 'task', taskId, nowMs)
      indexes += 1
    }
    await regenIndex($, repoFolder, 'repo', key, nowMs)
    indexes += 1
  }
  await regenIndex($, root, 'root', 'journal', nowMs)
  indexes += 1
  return checkText({ tasks, entries, indexes, added, restored, unreadableStates, unreadableEntries })
}
