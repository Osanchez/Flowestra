// Flowestra: the `/journal` command's pure core (0.11.0, decisions.md "Journal hardening:
// cleanup, masking, and multi-session fixes", sections 3.1-3.3, with the owner's
// amendments A1 and A2). Pure: no `$`, no clock, no file access, deletes nothing.
// It decides which task folders, emptied repository folders and audit files a manual
// prune may name, and builds every text the command prints. upkeep.ts does the I/O.
//
// A1: there is no automatic pruning and no retention setting; the only deletion is a
// `/journal prune ... confirm <code>` the person types. A2: a plan only ever names task
// folders directly under a repository folder of the journal root, a repository folder
// that the plan empties, and audit files directly under the audit folder. Anything this
// module cannot classify is kept with a reason, never planned.

import { hashHex, isoOf, sid8 } from './journal'

// ---------------------------------------------------------------- constants and names

/** The tool's task id rule (2 to 32 characters). */
export const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/
/** The shape `repoKey` produces: lower-case words joined by `-`, then `-` and 6 hex characters. */
export const REPO_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{6}$/
/** An audit file name: `<session id>.log`. */
export const AUDIT_NAME_RE = /^[A-Za-z0-9-]{8,64}\.log$/
/** A confirmation code: 6 lower-case hex characters. */
export const CODE_RE = /^[0-9a-f]{6}$/

export const DAY_MS = 86_400_000
export const MAX_DAYS = 36_500
/** The age the status text reports on (A1: fixed, there is no retention setting). */
export const STATUS_DAYS = 30
/** Lists show at most this many lines (or items), then `… and N more`. */
export const LIST_MAX = 20
/** The second field of a tombstone index line. */
export const TOMBSTONE = 'pruned'

export const COMMAND_DESCRIPTION = 'Show, prune or check the work journal'
export const COMMAND_ARGUMENT_HINT = '[prune <days> | check]'

/** Largest epoch ms a Date accepts. */
const MAX_DATE_MS = 8.64e15

export function isTaskId(s: unknown): boolean {
  return typeof s === 'string' && TASK_ID_RE.test(s)
}
export function isRepoKey(s: unknown): boolean {
  return typeof s === 'string' && REPO_KEY_RE.test(s)
}
export function isAuditName(s: unknown): boolean {
  return typeof s === 'string' && AUDIT_NAME_RE.test(s)
}
export function isCode(s: unknown): boolean {
  return typeof s === 'string' && CODE_RE.test(s)
}

/** `<repo-key>/<task-id>` split and checked; null unless both parts pass their rule. */
export function parseTaskName(s: string): { key: string; taskId: string } | null {
  if (typeof s !== 'string') return null
  const parts = s.split('/')
  if (parts.length !== 2) return null
  const [key = '', taskId = ''] = parts
  return isRepoKey(key) && isTaskId(taskId) ? { key, taskId } : null
}

// ---------------------------------------------------------------- arguments

export type JournalArgs =
  | { kind: 'status' }
  | { kind: 'check' }
  | { kind: 'prune'; days: number; confirm: string | null }
  | { kind: 'prune-task'; key: string; taskId: string; confirm: string | null }
  | { kind: 'usage' }

/** A whole number of days from 1 to 36500 written plainly (no sign, no leading zero), else null. */
export function parseDays(s: string): number | null {
  if (typeof s !== 'string' || !/^[1-9][0-9]{0,4}$/.test(s)) return null
  const n = Number(s)
  return n >= 1 && n <= MAX_DAYS ? n : null
}

/**
 * The command's arguments (whitespace-separated, case-sensitive): empty or `status`;
 * `prune <days>`; `prune <days> confirm <code>`; `prune task <repo-key>/<task-id>`;
 * `prune task <repo-key>/<task-id> confirm <code>`; `check`. Anything else, including an
 * extra token, a bad number, a bad name or a malformed code, is `usage`.
 */
export function parseJournalArgs(args: string): JournalArgs {
  const usage: JournalArgs = { kind: 'usage' }
  const t = typeof args === 'string' ? args.trim() : ''
  const w = t === '' ? [] : t.split(/\s+/)
  if (w.length === 0) return { kind: 'status' }
  if (w.length === 1 && w[0] === 'status') return { kind: 'status' }
  if (w.length === 1 && w[0] === 'check') return { kind: 'check' }
  if (w[0] !== 'prune') return usage
  if (w[1] === 'task') {
    const name = parseTaskName(w[2] ?? '')
    if (name === null) return usage
    if (w.length === 3) return { kind: 'prune-task', key: name.key, taskId: name.taskId, confirm: null }
    if (w.length === 5 && w[3] === 'confirm' && isCode(w[4])) {
      return { kind: 'prune-task', key: name.key, taskId: name.taskId, confirm: w[4] ?? null }
    }
    return usage
  }
  const days = parseDays(w[1] ?? '')
  if (days === null) return usage
  if (w.length === 2) return { kind: 'prune', days, confirm: null }
  if (w.length === 4 && w[2] === 'confirm' && isCode(w[3])) return { kind: 'prune', days, confirm: w[3] ?? null }
  return usage
}

/** What follows `/journal prune ` in the texts: `<days>` or `task <repo-key>/<task-id>`. */
export function pruneTarget(args: { kind: 'prune'; days: number } | { kind: 'prune-task'; key: string; taskId: string }): string {
  return args.kind === 'prune' ? String(args.days) : `task ${args.key}/${args.taskId}`
}

// ---------------------------------------------------------------- the plan

export type TaskStatus = 'open' | 'closed' | 'unreadable'

export type TaskInfo = {
  key: string
  taskId: string
  status: TaskStatus
  updatedMs: number
  entries: number
  bytes: number
  firstMs: number | null
  lastMs: number | null
  path: string
}

export type AuditInfo = { name: string; path: string; bytes: number; mtimeMs: number }

/**
 * Why an item is kept. Tasks: `name` (a name or path the journal does not use),
 * `unreadable` (state cannot be classified), `board`, `context`, `open`, `young`
 * (not old enough), `missing` (asked for by name, not in the journal). Audit files:
 * `name`, `own` (this session's file, or this session's file cannot be told apart),
 * `unreadable`, `young`.
 */
export type KeepReason = 'name' | 'unreadable' | 'board' | 'context' | 'open' | 'young' | 'missing' | 'own'

export type Kept = { item: string; kind: 'task' | 'audit'; reason: KeepReason }

export type PrunePlan = {
  /** Task folders to delete (each at `<journal root>/<key>/<task-id>`). */
  tasks: TaskInfo[]
  /** Audit files to delete (each at `<audit root>/<name>`); never in a by-name plan. */
  audits: AuditInfo[]
  /**
   * Repository keys whose every task given is in `tasks`: candidates only. upkeep
   * deletes such a folder only when its own listing after the task deletions shows no
   * task folder left (3.3), with the path checks of 3.2.
   */
  repos: string[]
  kept: Kept[]
}

export type PruneInput = {
  nowMs: number
  /** Ignored when `byName` is given. */
  days: number
  tasks: readonly TaskInfo[]
  audits: readonly AuditInfo[]
  boardTaskIds: readonly string[]
  contextTaskIds: readonly string[]
  contextPaths: readonly string[]
  /** This session's audit file name (`<session id>.log`); empty keeps every audit file. */
  ownAuditName: string
  /** `<repo-key>/<task-id>` for a prune by name, else null. */
  byName: string | null
  /** The journal root, as the task paths are written; a task path must be exactly `<journalRoot>/<key>/<task-id>`. */
  journalRoot: string
  /** The audit folder; an audit path must be exactly `<auditRoot>/<name>`. */
  auditRoot: string
}

/** An absolute folder without trailing slashes and with no empty, `.` or `..` segment; else null. */
function cleanRoot(root: string): string | null {
  if (typeof root !== 'string' || !root.startsWith('/')) return null
  const r = root.replace(/\/+$/, '')
  if (r === '') return null
  const segs = r.slice(1).split('/')
  return segs.every(s => s !== '' && s !== '.' && s !== '..') ? r : null
}

/** A path for comparison: `\` as `/`, `.` and empty segments dropped, `..` applied, lower case (deletes less on a case-insensitive disk). */
function comparable(p: string): string {
  const segs: string[] = []
  for (const s of p.replace(/\\/g, '/').split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') segs.pop()
    else segs.push(s)
  }
  return `/${segs.join('/')}`.toLowerCase()
}

const validMs = (ms: unknown): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms > 0 && ms <= MAX_DATE_MS
const validCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

/**
 * Protection 3 of 3.1: true when a context task id equals the task's id (in any
 * repository), or a context path is the task folder, lies inside it, is a folder
 * above it, or holds `/<key>/<task-id>` as consecutive segments (the same folder
 * reached through another root, such as a link). Ids and paths compare in lower case.
 */
export function namedAsContext(
  task: { key: string; taskId: string; path: string },
  contextTaskIds: readonly string[],
  contextPaths: readonly string[],
): boolean {
  const id = String(task.taskId).trim().toLowerCase()
  if (contextTaskIds.some(c => typeof c === 'string' && c.trim().toLowerCase() === id)) return true
  const folder = comparable(String(task.path))
  const tail = `/${String(task.key).toLowerCase()}/${id}`
  for (const raw of contextPaths) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const p = comparable(raw.trim())
    if (p === folder || p.startsWith(`${folder}/`)) return true
    if (folder.startsWith(p === '/' ? '/' : `${p}/`)) return true
    if (p.endsWith(tail) || p.includes(`${tail}/`)) return true
  }
  return false
}

const nameOf = (t: { key: string; taskId: string }): string => `${t.key}/${t.taskId}`

/**
 * Which tasks and audit files a manual prune may delete, and why the others are kept.
 *
 * By days (`byName` null): a task is planned only when its name and path pass the
 * rules, its status is `closed`, it is not on this session's board, no open task names
 * it as context, and `nowMs - updatedMs >= days * DAY_MS`; an audit file only when its
 * name and path pass, it is not this session's, and its `mtimeMs` is that old. Days
 * outside 1..36500 plan nothing. Open tasks are never planned by days.
 *
 * By name: only that task, open or closed, regardless of age; refused (kept) when its
 * name fails, its state is unreadable, it is on the board or named as context, or it is
 * not given (`missing`). No audit file is planned by name, and other tasks are not
 * listed as kept.
 *
 * Order of reasons: name, unreadable, board, context, open, young.
 */
export function planPrune(input: PruneInput): PrunePlan {
  const root = cleanRoot(input.journalRoot)
  const auditRoot = cleanRoot(input.auditRoot)
  const board = new Set(input.boardTaskIds.filter(b => typeof b === 'string').map(b => b.trim().toLowerCase()))
  const daysOk = Number.isInteger(input.days) && input.days >= 1 && input.days <= MAX_DAYS && validMs(input.nowMs)
  const limit = daysOk ? input.nowMs - input.days * DAY_MS : -Infinity
  const byName = input.byName

  const tasks: TaskInfo[] = []
  const audits: AuditInfo[] = []
  const kept: Kept[] = []

  const taskReason = (t: TaskInfo, named: boolean): KeepReason | null => {
    if (root === null || !isRepoKey(t.key) || !isTaskId(t.taskId) || t.path !== `${root}/${t.key}/${t.taskId}`) return 'name'
    if ((t.status !== 'open' && t.status !== 'closed') || !validMs(t.updatedMs) || !validCount(t.entries) || !validCount(t.bytes)) {
      return 'unreadable'
    }
    if (board.has(t.taskId.toLowerCase())) return 'board'
    if (namedAsContext(t, input.contextTaskIds, input.contextPaths)) return 'context'
    if (named) return null
    if (t.status === 'open') return 'open'
    if (!daysOk || t.updatedMs > limit) return 'young'
    return null
  }

  if (byName !== null) {
    const asked = parseTaskName(byName)
    if (asked === null) {
      kept.push({ item: String(byName), kind: 'task', reason: 'name' })
    } else {
      const matches = input.tasks.filter(t => t.key === asked.key && t.taskId === asked.taskId)
      if (matches.length === 0) kept.push({ item: byName, kind: 'task', reason: 'missing' })
      for (const t of matches) {
        const r = taskReason(t, true)
        if (r === null) tasks.push(t)
        else kept.push({ item: nameOf(t), kind: 'task', reason: r })
      }
    }
  } else {
    for (const t of input.tasks) {
      const r = taskReason(t, false)
      if (r === null) tasks.push(t)
      else kept.push({ item: nameOf(t), kind: 'task', reason: r })
    }
    const own = typeof input.ownAuditName === 'string' ? input.ownAuditName.trim().toLowerCase() : ''
    for (const a of input.audits) {
      const name = typeof a.name === 'string' ? a.name : String(a.name)
      let r: KeepReason | null = null
      const lower = name.toLowerCase()
      if (own === '' || lower === own || lower === `${own}.log`) r = 'own'
      else if (auditRoot === null || !isAuditName(name) || a.path !== `${auditRoot}/${name}`) r = 'name'
      else if (!validMs(a.mtimeMs) || !validCount(a.bytes)) r = 'unreadable'
      else if (!daysOk || a.mtimeMs > limit) r = 'young'
      if (r === null) audits.push(a)
      else kept.push({ item: name, kind: 'audit', reason: r })
    }
  }

  const planned = new Set(tasks)
  const repos = [...new Set(tasks.map(t => t.key))]
    .filter(k => input.tasks.every(t => t.key !== k || planned.has(t)))
    .sort()
  return { tasks, audits, repos, kept }
}

/**
 * The confirmation code: the first 6 hex characters of `hashHex` over the plan's items
 * (each task's path, entries, bytes and updatedMs; each audit file's path, bytes and
 * mtimeMs; each repository key), sorted, and the days. Any change to what would be
 * deleted changes it; the order of the items does not. A plan by name passes 0 days.
 */
export function pruneCode(plan: PrunePlan, days: number): string {
  const items = [
    ...plan.tasks.map(t => `task\t${t.path}\t${t.entries}\t${t.bytes}\t${t.updatedMs}`),
    ...plan.audits.map(a => `audit\t${a.path}\t${a.bytes}\t${a.mtimeMs}`),
    ...plan.repos.map(r => `repo\t${r}`),
  ].sort()
  return hashHex(`${items.join('\n')}\ndays\t${days}`).slice(0, 6)
}

// ---------------------------------------------------------------- tombstones and the log

/** The tombstone index line for a pruned task (or repository) key: `<key> | pruned | <ISO>`. */
export function tombstoneLine(key: string, atMs: number): string {
  return `${oneLine(key)} | ${TOMBSTONE} | ${isoOf(atMs)}`
}

/** Index lines without tombstones: a line whose second ` | ` field is exactly `pruned` is dropped. */
export function dropPruned(lines: readonly string[]): string[] {
  return lines.filter(l => l.split(' | ')[1] !== TOMBSTONE)
}

/** `<config root>/flowestra/prune.log` */
export function pruneLogPath(configRoot: string): string {
  const base = configRoot.length > 1 ? configRoot.replace(/[\\/]+$/, '') : configRoot
  return `${base === '/' ? '' : base}/flowestra/prune.log`
}

/** A `prune.log` line for a deleted task (A1: always `manual`). Names and sizes only. */
export function pruneLogTaskLine(atMs: number, sessionId: string, t: TaskInfo): string {
  return `${isoOf(atMs)} | session ${sid8(sessionId)} | manual | task ${clean(nameOf(t))} | ${t.entries} entries | ${t.bytes} bytes | last updated ${isoOrUnknown(t.updatedMs)}`
}

/** A `prune.log` line for a deleted audit file (A1: always `manual`). */
export function pruneLogAuditLine(atMs: number, sessionId: string, a: AuditInfo): string {
  return `${isoOf(atMs)} | session ${sid8(sessionId)} | manual | audit ${clean(a.name)} | ${a.bytes} bytes`
}

// ---------------------------------------------------------------- text helpers

/** Under 1024 `N B`; under 1 MiB `N.N KB`; else `N.N MB` (1024-based, one decimal). */
export function formatBytes(n: number): string {
  const b = typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

/** Control characters shown as `?`, so a name cannot add a line to a text. */
function clean(s: string): string {
  return String(s).replace(/[\u0000-\u001f\u007f]/g, '?')
}

function oneLine(s: string): string {
  return String(s).replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

function dateOf(ms: number | null): string {
  return validMs(ms) ? isoOf(ms).slice(0, 10) : 'unknown'
}

function isoOrUnknown(ms: number): string {
  return validMs(ms) ? isoOf(ms) : 'unknown'
}

/** At most 20 items, comma-separated, then `… and N more`. */
function inlineList(items: readonly string[]): string {
  const shown = items.slice(0, LIST_MAX).map(clean)
  if (items.length > LIST_MAX) shown.push(`… and ${items.length - LIST_MAX} more`)
  return shown.join(', ')
}

/** At most 20 lines, then `  … and N more`. */
function blockList(lines: readonly string[]): string[] {
  const out = lines.slice(0, LIST_MAX)
  if (lines.length > LIST_MAX) out.push(`  … and ${lines.length - LIST_MAX} more`)
  return out
}

const sum = (ns: readonly number[]): number => ns.reduce((a, n) => a + (Number.isFinite(n) ? n : 0), 0)

/** `first to last` over the tasks' entry dates, or null when no task has one. */
function dateSpan(tasks: readonly TaskInfo[]): string | null {
  const firsts = tasks.map(t => t.firstMs).filter(validMs)
  const lasts = tasks.map(t => t.lastMs).filter(validMs)
  if (firsts.length === 0 || lasts.length === 0) return null
  return `${dateOf(Math.min(...firsts))} to ${dateOf(Math.max(...lasts))}`
}

export type JournalContent = 'full' | 'capped' | 'index'

const RETENTION_LINE = '  Retention: nothing is deleted unless you run /journal prune <days>.'
const COMMANDS_LINE = 'Commands: /journal prune <days> · /journal prune task <repo>/<task> · /journal check'
const CANNOT_DELETE_LINE =
  'This session cannot delete files (host commands are not available here). To delete them yourself, remove these folders, then run /journal check:'

function settingsLines(masking: boolean, content: JournalContent): string[] {
  return [RETENTION_LINE, `  Masking: ${masking ? 'on (best effort)' : 'off'}. Content: ${content}.`]
}

// ---------------------------------------------------------------- the texts of 3.3

export type StatusInput = {
  journalRoot: string
  nowMs: number
  tasks: readonly TaskInfo[]
  audits: readonly AuditInfo[]
  masking: boolean
  content: JournalContent
}

/** `/journal` and `/journal status`. Repositories are counted from the tasks' keys. */
export function statusText(s: StatusInput): string {
  const head = `Journal: ${clean(s.journalRoot)}`
  const settings = settingsLines(s.masking, s.content)
  if (s.tasks.length === 0) return [head, '  Empty: nothing has been written yet.', ...settings, COMMANDS_LINE].join('\n')
  const repos = new Set(s.tasks.map(t => t.key)).size
  const open = s.tasks.filter(t => t.status === 'open')
  const closed = s.tasks.filter(t => t.status === 'closed')
  const unreadable = s.tasks.length - open.length - closed.length
  const old = (t: TaskInfo): boolean => validMs(t.updatedMs) && validMs(s.nowMs) && s.nowMs - t.updatedMs >= STATUS_DAYS * DAY_MS
  const oldClosed = closed.filter(old)
  const span = dateSpan(s.tasks)
  const counts = `${open.length} open, ${closed.length} closed${unreadable > 0 ? `, ${unreadable} unreadable` : ''}`
  return [
    head,
    `  ${repos} repositories · ${s.tasks.length} tasks (${counts}) · ${sum(s.tasks.map(t => t.entries))} entries · ${formatBytes(sum(s.tasks.map(t => t.bytes)))}${span === null ? '' : ` · ${span}`}`,
    `  Open tasks not updated for ${STATUS_DAYS} days or more: ${open.filter(old).length}`,
    `  Closed tasks not updated for ${STATUS_DAYS} days or more: ${oldClosed.length} (${formatBytes(sum(oldClosed.map(t => t.bytes)))})`,
    `  Audit files: ${s.audits.length} · ${formatBytes(sum(s.audits.map(a => a.bytes)))}`,
    ...settings,
    COMMANDS_LINE,
  ].join('\n')
}

/** The kept reasons of a plan's tasks, in the order of 3.3, each only when non-zero. */
export function keptReasons(kept: readonly Kept[]): string[] {
  const t = kept.filter(k => k.kind === 'task')
  const of = (r: KeepReason): string[] => t.filter(k => k.reason === r).map(k => k.item)
  const out: string[] = []
  const open = of('open')
  const board = of('board')
  const context = of('context')
  const unreadable = of('unreadable')
  const young = of('young')
  const name = of('name')
  const missing = of('missing')
  if (open.length > 0) out.push(`${open.length} open`)
  if (board.length > 0) out.push(`${board.length} on this session's board`)
  if (context.length > 0) out.push(`${context.length} named as context by an open task (${inlineList(context)})`)
  if (unreadable.length > 0) out.push(`${unreadable.length} unreadable (${inlineList(unreadable)})`)
  if (young.length > 0) out.push(`${young.length} not old enough`)
  if (name.length > 0) out.push(`${name.length} with a name the journal does not use (${inlineList(name)})`)
  if (missing.length > 0) out.push(`${missing.length} not in the journal (${inlineList(missing)})`)
  return out
}

function cannotDeleteLines(paths: readonly string[]): string[] {
  return [CANNOT_DELETE_LINE, ...blockList(paths.map(p => `  ${clean(p)}`))]
}

export type DryRunInput = { plan: PrunePlan; days: number; code: string; canDelete: boolean }

/** `/journal prune <days>`: the dry run, or the nothing-to-delete line. */
export function dryRunText(d: DryRunInput): string {
  const { plan, days } = d
  const reasons = keptReasons(plan.kept)
  if (plan.tasks.length === 0 && plan.audits.length === 0) {
    const tail = reasons.length > 0 ? `Kept: ${reasons.join(', ')}.` : 'Nothing is deleted.'
    return `Journal prune: no closed task is ${days} days old or older, and no audit file is. ${tail}`
  }
  const lines = [`Journal prune (dry run): closed tasks not updated for ${days} days or more, and audit files older than ${days} days.`]
  if (plan.tasks.length > 0) {
    const span = dateSpan(plan.tasks)
    lines.push(
      `Would delete ${plan.tasks.length} tasks · ${sum(plan.tasks.map(t => t.entries))} entries · ${formatBytes(sum(plan.tasks.map(t => t.bytes)))}${span === null ? '' : ` · entries from ${span}`}:`,
      ...blockList(plan.tasks.map(t => `  ${clean(nameOf(t))}  ${t.status} · ${t.entries} entries · ${formatBytes(t.bytes)} · last updated ${dateOf(t.updatedMs)}`)),
    )
  } else {
    lines.push('Would delete 0 tasks.')
  }
  lines.push(`Would delete ${plan.audits.length} audit files · ${formatBytes(sum(plan.audits.map(a => a.bytes)))}.`)
  if (reasons.length > 0) lines.push(`Kept: ${reasons.join(', ')}.`)
  if (d.canDelete) lines.push(`Deleted files cannot be recovered. To delete exactly this, type: /journal prune ${days} confirm ${clean(d.code)}`)
  else lines.push(...cannotDeleteLines([...plan.tasks.map(t => t.path), ...plan.audits.map(a => a.path)]))
  return lines.join('\n')
}

export type ByNameInput = { task: TaskInfo; code: string; canDelete: boolean }

/** `/journal prune task <repo-key>/<task-id>`: the dry run for that task. */
export function byNameText(d: ByNameInput): string {
  const t = d.task
  const name = clean(nameOf(t))
  const first = `Journal prune (dry run): ${name} · ${t.status} · ${t.entries} entries · ${formatBytes(t.bytes)} · last updated ${dateOf(t.updatedMs)}.`
  if (!d.canDelete) return [first, ...cannotDeleteLines([t.path])].join('\n')
  return `${first}\nDeleted files cannot be recovered. To delete it, type: /journal prune task ${name} confirm ${clean(d.code)}`
}

export type ByNameRefusal = 'board' | 'context' | 'unreadable' | 'missing' | 'name'

/**
 * A prune by name that is refused. `by` names the open task that names it as context
 * (upkeep finds it with `namedAsContext`); `name` is shown as `not in the journal`.
 */
export function byNameRefusedText(item: string, reason: ByNameRefusal, by: string | null = null): string {
  const what =
    reason === 'board' ? "on this session's board"
      : reason === 'context' ? (by === null ? 'named as context by an open task' : `named as context by the open task ${clean(by)}`)
        : reason === 'unreadable' ? 'a task whose state file cannot be read'
          : 'not in the journal'
  return `Journal prune: ${clean(item)} is ${what}; nothing is deleted.`
}

export type DoneInput = {
  deletedTasks: readonly TaskInfo[]
  deletedAudits: readonly AuditInfo[]
  plannedTasks: number
  plannedAudits: number
  notDeleted: readonly { item: string; reason: string }[]
  /** The prune.log path (`pruneLogPath`). */
  pruneLog: string
}

/** The confirm run's result: everything deleted, or part of it. */
export function doneText(d: DoneInput): string {
  const k = d.deletedTasks.length
  const a = d.deletedAudits.length
  const tail = `The indexes were updated. What was deleted is listed in ${clean(d.pruneLog)}.`
  if (d.notDeleted.length === 0 && k === d.plannedTasks && a === d.plannedAudits) {
    return `Journal prune: deleted ${k} tasks (${sum(d.deletedTasks.map(t => t.entries))} entries, ${formatBytes(sum(d.deletedTasks.map(t => t.bytes)))}) and ${a} audit files (${formatBytes(sum(d.deletedAudits.map(x => x.bytes)))}). ${tail}`
  }
  const not = d.notDeleted.length > 0 ? ` Not deleted: ${inlineList(d.notDeleted.map(n => `${n.item} (${n.reason})`))}.` : ''
  return `Journal prune: deleted ${k} of ${d.plannedTasks} tasks and ${a} of ${d.plannedAudits} audit files.${not} ${tail}`
}

/**
 * A confirm that deletes nothing: `changed` (the code no longer matches the plan) or
 * `origin` (not the person's own keystroke). `target` is `pruneTarget(args)`.
 */
export function refusedText(kind: 'changed' | 'origin', target: string, code: string): string {
  if (kind === 'changed') {
    return `Journal prune: the journal changed since that summary, so nothing was deleted. Run /journal prune ${clean(target)} again for a new summary.`
  }
  return `Journal prune: deleting needs your own keystroke, so nothing was deleted. Type /journal prune ${clean(target)} confirm ${clean(code)} at the prompt.`
}

/** The command hook's `.catch` answer. */
export function failureText(): string {
  return 'Journal: the command could not finish; nothing more was changed. Run /journal check.'
}

export type CheckInput = {
  tasks: number
  entries: number
  indexes: number
  added: readonly string[]
  restored: readonly string[]
  unreadableStates: readonly string[]
  unreadableEntries: readonly string[]
}

/** `/journal check`'s report. */
export function checkText(c: CheckInput): string {
  const lines = [`Journal check: ${c.tasks} tasks, ${c.entries} entries, ${c.indexes} indexes regenerated.`]
  if (c.added.length > 0) lines.push(`  Added to the indexes: ${c.added.length} entries that were missing (${inlineList(c.added)})`)
  if (c.restored.length > 0) lines.push(`  Restored from backup: ${c.restored.length} state files (${inlineList(c.restored)})`)
  if (c.unreadableStates.length > 0) {
    lines.push(`  Unreadable: ${c.unreadableStates.length} state files with no readable backup (${inlineList(c.unreadableStates)}); opening such a task asks for its task line again.`)
  }
  if (c.unreadableEntries.length > 0) lines.push(`  Unreadable: ${c.unreadableEntries.length} entry files (${inlineList(c.unreadableEntries)})`)
  if (lines.length === 1) lines.push('  No problems found.')
  return lines.join('\n')
}

/** Anything `parseJournalArgs` calls `usage`. */
export function usageText(): string {
  return 'Usage: /journal · /journal prune <days> · /journal prune <days> confirm <code> · /journal prune task <repo>/<task> · /journal check'
}
