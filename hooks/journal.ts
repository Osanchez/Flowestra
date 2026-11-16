// Agent Board: the work journal's core (0.7.0, decisions.md "Workstreams and the
// work journal", section 2). Pure: no `$`, no clock, no file access. Every time,
// id and file text comes in as an argument, and every result is a string or plain
// data. register.tsx does the reading and writing; this file decides what is said.

import type { Phase, TaskKind, TaskSlot, Tier, Unit, Verdict } from '../types'

// ---------------------------------------------------------------- constants

/** One index line is at most this many characters. */
export const INDEX_LINE_MAX = 160
/** An entry whose text would pass this many bytes writes its results to part files. */
export const ENTRY_SPLIT_BYTES = 3.5 * 1024 * 1024
/** Each result part file stays under this many bytes (the file API rejects 4 MiB). */
export const PART_MAX_BYTES = 3.5 * 1024 * 1024
/** W3 caps: characters inlined per context item, and in all. */
export const CONTEXT_ITEM_CAP = 32_000
export const CONTEXT_TOTAL_CAP = 96_000
/** Spec's `audit's task part (≤60)` in a phase index line. */
export const AUDIT_TASK_MAX = 60

// ---------------------------------------------------------------- small helpers

/** Epoch ms to an ISO-8601 UTC string. */
export function isoOf(ms: number): string {
  return new Date(ms).toISOString()
}

/** The first 8 characters of a session id. */
export function sid8(sessionId: string): string {
  return sessionId.slice(0, 8)
}

/** UTF-8 length of a string in bytes (there is no TextEncoder to lean on). */
export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4
        i++
      } else n += 3
    } else n += 3
  }
  return n
}

/** Collapses line breaks, so a value stays on one line. */
function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

function joinPath(base: string, ...rest: string[]): string {
  let out = base.length > 1 ? base.replace(/[\\/]+$/, '') : base
  for (const r of rest) out = out === '/' ? `/${r}` : `${out}/${r}`
  return out
}

// ---------------------------------------------------------------- 9. config root

export type ConfigEnv = {
  configDir?: string | null    // CLAUDE_CONFIG_DIR
  home?: string | null         // HOME
  userProfile?: string | null  // USERPROFILE
  pluginRoot: string           // $.plugin.root
}

/**
 * Build decision B3.5: `configDir` when set and not empty; else `<home>/.claude`;
 * else `<userProfile>/.claude`; else `<pluginRoot>/data`. The values are already read.
 */
export function configRoot(env: ConfigEnv): string {
  if (env.configDir) return env.configDir
  if (env.home) return joinPath(env.home, '.claude')
  if (env.userProfile) return joinPath(env.userProfile, '.claude')
  return joinPath(env.pluginRoot, 'data')
}

/** `<config root>/flowestra/audit/<session id>.log` */
export function auditPath(root: string, sessionId: string): string {
  return joinPath(root, 'flowestra', 'audit', `${sessionId}.log`)
}

/** `<config root>/flowestra/journal` */
export function journalRoot(root: string): string {
  return joinPath(root, 'flowestra', 'journal')
}

// ---------------------------------------------------------------- 1. repo key

/** A small deterministic string hash (FNV-1a, 32 bits) as 8 hex characters. */
export function hashHex(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * The repository's folder name in the journal: the basename of the absolute root,
 * lower-cased, every run of characters outside `[a-z0-9]` made one `-`, then `-`
 * and the first 6 hex characters of a hash of the whole root.
 */
export function repoKey(absRoot: string): string {
  const parts = absRoot.split(/[\\/]+/).filter(p => p !== '')
  const base = (parts[parts.length - 1] ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${base === '' ? 'repo' : base}-${hashHex(absRoot).slice(0, 6)}`
}

// ---------------------------------------------------------------- 2. names and paths

/** `<yyyymmdd-hhmmss>-<unit-id>-<agent-id first 8>`, the time in UTC. */
export function entryName(spawnedMs: number, unitId: string, agentId: string): string {
  const iso = isoOf(spawnedMs) // 2026-11-15T10:20:30.000Z
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`
  return `${stamp}-${unitId}-${agentId.slice(0, 8)}`
}

/**
 * An entry file's name back to its parts: `<yyyymmdd>-<hhmmss>-<unit id>-<agent8>.md`, that is
 * 15 fixed characters, `-`, the unit id (which may itself hold `-`), `-`, the last 8 characters
 * before `.md`. Null for part files (`*.result.md`, `*.result.<n>.md`), `index.md`, `state.md`
 * and anything too short or shaped otherwise.
 */
export function parseEntryFileName(name: string): { unitId: string; agent8: string } | null {
  if (!name.endsWith('.md') || /\.result(?:\.\d+)?\.md$/.test(name)) return null
  const base = name.slice(0, -3)
  if (base.length < 15 + 1 + 1 + 1 + 8) return null
  if (!/^\d{8}-\d{6}-/.test(base)) return null
  if (base[base.length - 9] !== '-') return null
  const unitId = base.slice(16, base.length - 9)
  if (unitId === '') return null
  return { unitId, agent8: base.slice(base.length - 8) }
}

/** `<root>/index.md` */
export function rootIndexPath(root: string): string {
  return joinPath(root, 'index.md')
}
/** `<root>/<repo-key>` */
export function repoDir(root: string, key: string): string {
  return joinPath(root, key)
}
export function repoIndexPath(root: string, key: string): string {
  return joinPath(root, key, 'index.md')
}
/** `<root>/<repo-key>/<task-id>` */
export function taskDir(root: string, key: string, taskId: string): string {
  return joinPath(root, key, taskId)
}
export function taskIndexPath(root: string, key: string, taskId: string): string {
  return joinPath(root, key, taskId, 'index.md')
}
export function stateMdPath(root: string, key: string, taskId: string): string {
  return joinPath(root, key, taskId, 'state.md')
}
export function stateJsonPath(root: string, key: string, taskId: string): string {
  return joinPath(root, key, taskId, 'state.json')
}
/** The backup copy of a task's state.json, same text: `<task>/state.bak.json`. */
export function stateBakPath(root: string, key: string, taskId: string): string {
  return joinPath(root, key, taskId, 'state.bak.json')
}
/** Where an unreadable state text is kept: `<task>/state.unreadable-<yyyymmdd-hhmmss>.json`, the time in UTC. */
export function stateUnreadablePath(root: string, key: string, taskId: string, atMs: number): string {
  const iso = isoOf(atMs)
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`
  return joinPath(root, key, taskId, `state.unreadable-${stamp}.json`)
}
/** `<root>/<repo-key>/<task-id>/<phase>` */
export function phaseDir(root: string, key: string, taskId: string, phase: string): string {
  return joinPath(root, key, taskId, phase)
}
export function phaseIndexPath(root: string, key: string, taskId: string, phase: string): string {
  return joinPath(root, key, taskId, phase, 'index.md')
}
/** `<phase folder>/<entry>.md` */
export function entryPath(root: string, key: string, taskId: string, phase: string, entry: string): string {
  return joinPath(root, key, taskId, phase, `${entry}.md`)
}
/** The nth part file of an entry's results: `<entry>.result.md` for n = 1, else `<entry>.result.<n>.md`. */
export function resultPartName(entry: string, n: number): string {
  return n <= 1 ? `${entry}.result.md` : `${entry}.result.${n}.md`
}
export function resultPartPath(root: string, key: string, taskId: string, phase: string, entry: string, n: number): string {
  return joinPath(root, key, taskId, phase, resultPartName(entry, n))
}
/** A folder's shard file of one session: `<folder>/.shards/<sid8>.tsv` (`session` may be the whole id). */
export function shardPath(folder: string, session: string): string {
  return joinPath(folder, '.shards', `${sid8(session)}.tsv`)
}

// ---------------------------------------------------------------- 3. entry text

export type ContextStatus = { item: string; status: string }
export type EntryStatus = 'running' | 'done' | 'failed' | 'stopped'
export type EntryResume = { message: string; result: string | null }

export type EntryData = {
  taskId: string
  unitId: string
  label: string
  audit: string | null
  tier: Tier | null
  kind: TaskKind | null
  phase: Phase | null
  wave: number | null
  agentId: string
  subagentType: string | null
  model: string | null
  sessionId: string
  cwd: string | null
  context: ContextStatus[]     // [] writes `none`
  spawnedMs: number
  endedMs: number | null       // null: running
  status: EntryStatus
  verdict: Verdict | null      // null: unchecked
  verdictMs: number | null
  brief: string                // the orchestrator's prompt as written (not the mod's added blocks)
  result: string | null
  resumes: EntryResume[]       // `## Message 2` / `## Result 2` and on
}

export type EntryFiles = {
  text: string                                   // the entry file's text
  parts: { name: string; text: string }[]        // result part files beside it ([] when not split)
}

/** The header's `context:` value: `<item> (<status>), ...` or `none`. */
export function contextLine(items: readonly ContextStatus[]): string {
  return items.length === 0 ? 'none' : items.map(i => `${oneLine(i.item)} (${i.status})`).join(', ')
}

function chunkByBytes(s: string, maxBytes: number): string[] {
  if (utf8Length(s) <= maxBytes) return [s]
  const out: string[] = []
  let start = 0
  let bytes = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    let w = c < 0x80 ? 1 : c < 0x800 ? 2 : 3
    let units = 1
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        w = 4
        units = 2
      }
    }
    if (bytes + w > maxBytes) {
      out.push(s.slice(start, i))
      start = i
      bytes = 0
    }
    bytes += w
    i += units - 1
  }
  out.push(s.slice(start))
  return out
}

// A SECTION LINE is `## Brief`, `## Result`, `## Result <n>` or `## Message <n>` (trailing
// whitespace ignored), optionally preceded by backslashes. A body line of that shape is
// written with one more backslash, so it is never mistaken for a heading.
const SECTION_LINE = /^(\\*)## (?:Brief|Result(?: \d+)?|Message \d+)\s*$/

/** One backslash in front of every section line of `text`. */
export function escapeSections(text: string): string {
  return text.split('\n').map(l => (SECTION_LINE.test(l) ? `\\${l}` : l)).join('\n')
}

/** Removes one leading backslash from every section line that has at least one. */
export function unescapeSections(text: string): string {
  return text.split('\n').map(l => ((SECTION_LINE.exec(l)?.[1] ?? '') !== '' ? l.slice(1) : l)).join('\n')
}

/**
 * The entry file text for one delegation, and its result part files. The header
 * is the spec's Entry format; then `## Brief`, `## Result`, and for a resumed run
 * `## Message 2` / `## Result 2`. When the whole text would pass 3.5 MiB, every
 * result moves to `<entry>.result.md`, `<entry>.result.2.md`, ... (each part under
 * 4 MiB; a result longer than a part takes consecutive parts), the entry keeps the
 * brief and messages, and the header says so on a `results:` line.
 */
export function buildEntry(entry: string, d: EntryData): EntryFiles {
  const dash = (v: string | number | null): string => (v === null || v === '' ? '-' : oneLine(String(v)))
  const esc = (v: string | null): string | null => (v === null ? null : escapeSections(v))
  const results: (string | null)[] = [d.result, ...d.resumes.map(r => r.result)].map(esc)
  const head = [
    `# ${oneLine(d.taskId)} · ${oneLine(d.unitId)} · ${oneLine(d.label)}`,
    `audit: ${dash(d.audit)}`,
    `tier: ${dash(d.tier)} · kind: ${dash(d.kind)} · phase: ${dash(d.phase ?? 'unset')} · wave: ${dash(d.wave)}`,
    `agent: ${oneLine(d.agentId)} · type: ${dash(d.subagentType)} · model: ${dash(d.model)} · session: ${oneLine(d.sessionId)}`,
    `cwd: ${dash(d.cwd)} · context: ${contextLine(d.context)}`,
    `spawned: ${isoOf(d.spawnedMs)} · ended: ${d.endedMs === null ? 'running' : isoOf(d.endedMs)} · status: ${d.status}`,
    d.verdict === null && d.verdictMs === null
      ? 'verdict: unchecked'
      : `verdict: ${d.verdict ?? 'unchecked'}${d.verdictMs === null ? '' : ` · at ${isoOf(d.verdictMs)}`}`,
  ]
  const messageSections = (inlineResults: boolean, pointers: string[][]): string => {
    let body = `## Brief\n${escapeSections(d.brief)}\n## Result\n${inlineResults ? (results[0] ?? '') : pointerText(pointers[0])}\n`
    d.resumes.forEach((r, i) => {
      const n = i + 2
      body += `## Message ${n}\n${escapeSections(r.message)}\n## Result ${n}\n${inlineResults ? (results[i + 1] ?? '') : pointerText(pointers[i + 1])}\n`
    })
    return body
  }
  const whole = `${head.join('\n')}\n${messageSections(true, [])}`
  if (utf8Length(whole) <= ENTRY_SPLIT_BYTES) return { text: whole, parts: [] }

  const parts: { name: string; text: string }[] = []
  const pointers: string[][] = []
  results.forEach((res, run) => {
    const names: string[] = []
    for (const chunk of chunkByBytes(res ?? '', PART_MAX_BYTES)) {
      const name = resultPartName(entry, parts.length + 1)
      names.push(name)
      parts.push({ name, text: chunk })
    }
    pointers[run] = names
  })
  const all = parts.map(p => p.name).join(', ')
  const header = [...head, `results: stored beside this file, over 3.5 MiB: ${all}`]
  return { text: `${header.join('\n')}\n${messageSections(false, pointers)}`, parts }
}

function pointerText(names: string[] | undefined): string {
  return `(stored in ${names && names.length > 0 ? names.join(', ') : 'no part'})`
}

// ---------------------------------------------------------------- 4. index lines

export type IndexLevel = 'root' | 'repo' | 'task' | 'phase'

/**
 * Joins fields with ` | ` into a line of at most `max` characters. Free-text
 * fields (indexes in `free`) are cut first, the longest first; a cut ends in `…`.
 * Only if that is not enough are the other fields cut, and last of all the line.
 * Field 0 (the child's key) is the last to be touched.
 */
export function fitLine(fields: readonly string[], free: readonly number[], max: number = INDEX_LINE_MAX): string {
  const f = fields.map(x => oneLine(x).replace(/\t/g, ' ').replace(/ \| /g, ' / '))
  const total = (): number => f.join(' | ').length
  const cutLongest = (pool: number[]): boolean => {
    let best = -1
    for (const i of pool) if ((f[i] ?? '').length > 1 && (best < 0 || (f[i] ?? '').length > (f[best] ?? '').length)) best = i
    if (best < 0) return false
    const cur = f[best] ?? ''
    const over = total() - max
    const len = Math.max(1, cur.length - over)
    f[best] = len >= cur.length ? cur : `${cur.slice(0, len - 1)}…`
    return len < cur.length
  }
  const freePool = free.filter(i => i > 0 && i < f.length)
  const restPool = f.map((_, i) => i).filter(i => i > 0 && !freePool.includes(i))
  while (total() > max && cutLongest(freePool)) { /* cut */ }
  while (total() > max && cutLongest(restPool)) { /* cut */ }
  while (total() > max && cutLongest([0])) { /* cut */ }
  return total() > max ? f.join(' | ').slice(0, max) : f.join(' | ')
}

export type RootLine = { repoKey: string; root: string; openTasks: number; tasks: number; updatedMs: number }
export type RepoLine = { taskId: string; status: 'open' | 'closed'; phase: string | null; entries: number; updatedMs: number; title: string | null }
export type TaskLine = { phase: string; entries: number; accepted: number; rejected: number; unchecked: number; updatedMs: number }
export type PhaseLine = {
  file: string; unitId: string; tier: string | null; kind: string | null; status: string
  verdict: Verdict | null; briefChars: number | null; resultChars: number | null; audit: string | null
}

/** Root index line: `repo-key | absolute root | open tasks | tasks | updated`. */
export function rootIndexLine(l: RootLine): string {
  return fitLine([l.repoKey, l.root, String(l.openTasks), String(l.tasks), isoOf(l.updatedMs)], [1])
}
/** Repo index line: `task-id | open/closed | phase | entries | updated | title`. */
export function repoIndexLine(l: RepoLine): string {
  return fitLine([l.taskId, l.status, l.phase ?? 'unset', String(l.entries), isoOf(l.updatedMs), l.title ?? ''], [5])
}
/** Task index line: `phase | entries | accepted/rejected/unchecked | updated`. */
export function taskIndexLine(l: TaskLine): string {
  return fitLine([l.phase, String(l.entries), `${l.accepted}/${l.rejected}/${l.unchecked}`, isoOf(l.updatedMs)], [])
}
/** The part of an audit line before its first ` | `, cut to 60 characters. */
export function auditTaskPart(audit: string | null): string {
  const first = oneLine(audit ?? '').split(' | ')[0] ?? ''
  return first.length > AUDIT_TASK_MAX ? `${first.slice(0, AUDIT_TASK_MAX - 1)}…` : first
}
/** Phase index line: `entry file | unit id | tier | kind | status | verdict | brief chars | result chars | audit's task part`. */
export function phaseIndexLine(l: PhaseLine): string {
  return fitLine(
    [
      l.file, l.unitId, l.tier ?? '-', l.kind ?? '-', l.status, l.verdict ?? 'unchecked',
      l.briefChars === null ? '-' : String(l.briefChars), l.resultChars === null ? '-' : String(l.resultChars),
      auditTaskPart(l.audit),
    ],
    [8, 1],
  )
}

/** The phase index line of an entry's data, for the entry file `file`. */
export function phaseLineOfData(file: string, d: EntryData): string {
  const results = [d.result, ...d.resumes.map(r => r.result)].filter((r): r is string => r !== null)
  return phaseIndexLine({
    file,
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

/** A phase index line's verdict counts and entries, as the task index line for that phase. */
export function taskLineOf(phase: string, phaseLines: readonly string[], atMs: number): string {
  let accepted = 0
  let rejected = 0
  for (const l of phaseLines) {
    const v = l.split(' | ')[5]
    if (v === 'accepted') accepted += 1
    else if (v === 'rejected') rejected += 1
  }
  return taskIndexLine({ phase, entries: phaseLines.length, accepted, rejected, unchecked: phaseLines.length - accepted - rejected, updatedMs: atMs })
}

/**
 * An index file's text: `# <level> <name> · <n> · updated <ISO>`, then the lines.
 * A task index also ends in its fixed line `state.md` (not counted in n).
 */
export function indexText(level: IndexLevel, name: string, lines: readonly string[], updatedMs: number): string {
  const body = level === 'task' ? [...lines, 'state.md'] : [...lines]
  return `# ${level} ${oneLine(name)} · ${lines.length} · updated ${isoOf(updatedMs)}\n${body.map(l => `${l}\n`).join('')}`
}

/** The child key of an index line: its first field. */
export function lineKey(line: string): string {
  const i = line.indexOf(' | ')
  return i < 0 ? line : line.slice(0, i)
}

// ---------------------------------------------------------------- 5. shards

export type ShardLine = { at: string; key: string; line: string }

/** One shard line: `<ISO>\t<child key>\t<index line>`. */
export function shardLine(atMs: number, key: string, line: string): string {
  return `${isoOf(atMs)}\t${oneLine(key).replace(/\t/g, ' ')}\t${oneLine(line).replace(/\t/g, ' ')}`
}

/** A shard file's text as lines; a line without three tab-separated fields is skipped. */
export function parseShard(text: string): ShardLine[] {
  const out: ShardLine[] = []
  for (const raw of text.split('\n')) {
    const row = raw.replace(/\r$/, '')
    const a = row.indexOf('\t')
    const b = a < 0 ? -1 : row.indexOf('\t', a + 1)
    if (a <= 0 || b < 0) continue
    const key = row.slice(a + 1, b)
    const line = row.slice(b + 1)
    if (key === '' || line === '') continue
    out.push({ at: row.slice(0, a), key, line })
  }
  return out
}

/**
 * Merges the parsed lines of several shards into one index's lines: the newest
 * line per child key wins (an equal time: the later one given), the order is by key.
 */
export function mergeShards(shards: readonly (readonly ShardLine[])[]): string[] {
  const best = new Map<string, ShardLine>()
  for (const shard of shards) {
    for (const s of shard) {
      const cur = best.get(s.key)
      if (cur === undefined || s.at >= cur.at) best.set(s.key, s)
    }
  }
  return [...best.keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)).map(k => best.get(k)?.line ?? '')
}

/** `parseShard` over each text, then `mergeShards`. */
export function mergeShardTexts(texts: readonly string[]): string[] {
  return mergeShards(texts.map(parseShard))
}

// ---------------------------------------------------------------- 6. state.md and state.json

export type StateInput = {
  slot: TaskSlot
  sessionId: string
  updatedMs: number
  unitStates: Record<string, string>     // unit id -> its state (pending, running, done, ...)
  latestEntries: Record<string, string>  // unit id -> path of its newest entry
  recentEntries: string[]                // newest first; the five newest are written
}

const STATE_SHAPE = 'state-1'

/** `state.md`, for the orchestrator: header, one line per unit, the five newest entries. */
export function stateMd(s: StateInput): string {
  const t = s.slot
  const dash = (v: string | number | null | undefined): string => (v === null || v === undefined || v === '' ? '-' : oneLine(String(v)))
  const lines = [
    `task ${t.taskId} · ${t.status} · ${dash(t.task)}`,
    `repo: ${dash(t.repo)}`,
    `${t.phase ?? 'unset'} · wave ${dash(t.wave)}`,
    `updated ${isoOf(s.updatedMs)} by session ${sid8(s.sessionId)}`,
    '',
    'id | label | tier | kind | state | verdict | dependsOn | spec | latest entry',
  ]
  for (const u of t.units) {
    lines.push(
      [
        u.id, u.label, dash(u.tier), dash(u.kind), dash(s.unitStates[u.id]), u.verdict ?? 'unchecked',
        u.dependsOn.length === 0 ? '-' : u.dependsOn.join(','), dash(u.spec), dash(s.latestEntries[u.id]),
      ].map(x => oneLine(x).replace(/ \| /g, ' / ')).join(' | '),
    )
  }
  lines.push('', 'newest entries:')
  const recent = s.recentEntries.slice(0, 5)
  if (recent.length === 0) lines.push('none')
  for (const p of recent) lines.push(p)
  return `${lines.join('\n')}\n`
}

/** `state.json`, for resuming: the slot whole, plus who wrote it and what was passed in. */
export function stateJson(s: StateInput): string {
  return JSON.stringify(
    {
      shape: STATE_SHAPE,
      session: s.sessionId,
      updatedMs: s.updatedMs,
      slot: s.slot,
      unitStates: s.unitStates,
      latestEntries: s.latestEntries,
      recentEntries: s.recentEntries.slice(0, 5),
    },
    null,
    2,
  )
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'
const numOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v))
const oneOf = <T extends string>(v: unknown, set: readonly T[]): v is T => typeof v === 'string' && (set as readonly string[]).includes(v)

const PHASES: readonly Phase[] = ['analysis', 'design', 'approval', 'executing', 'testing', 'review', 'done']
const TIERS: readonly Tier[] = ['opus', 'sonnet', 'haiku']
const KINDS: readonly TaskKind[] = [
  'locate', 'extract', 'execute', 'inventory', 'edit', 'implement', 'tests', 'fix', 'explore', 'summarize', 'review', 'docs', 'design', 'debug',
]
const VERDICTS: readonly Verdict[] = ['accepted', 'rejected']
const DECLARED: readonly ('pending' | 'done' | 'failed')[] = ['pending', 'done', 'failed']

function readUnit(v: unknown): Unit | null {
  if (!isObj(v)) return null
  const { id, label, wave, dependsOn, declared, tier, kind, audit, verdict, spec, context } = v
  if (!isStr(id) || !isStr(label) || typeof wave !== 'number' || !Number.isFinite(wave)) return null
  if (!Array.isArray(dependsOn) || !dependsOn.every(isStr)) return null
  if (!Array.isArray(context) || !context.every(isStr)) return null
  if (declared !== null && !oneOf(declared, DECLARED)) return null
  if (tier !== null && !oneOf(tier, TIERS)) return null
  if (kind !== null && !oneOf(kind, KINDS)) return null
  if (!strOrNull(audit) || !strOrNull(spec)) return null
  if (verdict !== null && !oneOf(verdict, VERDICTS)) return null
  return {
    id, label, wave, dependsOn: [...dependsOn], declared: declared as Unit['declared'],
    tier: tier as Tier | null, kind: kind as TaskKind | null, audit, verdict: verdict as Verdict | null, spec, context: [...context],
  }
}

function readSlot(v: unknown): TaskSlot | null {
  if (!isObj(v)) return null
  const { taskId, task, repo, phase, wave, units, status, activeAt } = v
  if (!isStr(taskId) || !strOrNull(task) || !strOrNull(repo) || !numOrNull(wave)) return null
  if (phase !== null && !oneOf(phase, PHASES)) return null
  if (!oneOf(status, ['open', 'closed'] as const)) return null
  if (typeof activeAt !== 'number' || !Number.isFinite(activeAt) || !Array.isArray(units)) return null
  const out: Unit[] = []
  for (const u of units) {
    const r = readUnit(u)
    if (r === null) return null
    out.push(r)
  }
  return { taskId, task, repo, phase: phase as Phase | null, wave, units: out, status, activeAt }
}

function readState(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text)
    return isObj(v) && v['shape'] === STATE_SHAPE ? v : null
  } catch {
    return null
  }
}

/** The task slot saved in a `state.json` text; null when the text is malformed or of the wrong shape. Never throws. */
export function parseStateJson(text: string): TaskSlot | null {
  try {
    const v = readState(text)
    return v === null ? null : readSlot(v['slot'])
  } catch {
    return null
  }
}

/** Who wrote a `state.json` and when (session id, epoch ms), or null; for the "also updated by session" warning. */
export function parseStateWriter(text: string): { session: string; updatedMs: number } | null {
  try {
    const v = readState(text)
    if (v === null) return null
    const session = v['session']
    const updatedMs = v['updatedMs']
    return isStr(session) && typeof updatedMs === 'number' && Number.isFinite(updatedMs) ? { session, updatedMs } : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 8. context items

export type ContextItem =
  | { kind: 'path'; path: string; heading: string | null }
  | { kind: 'entry'; taskId: string; unitId: string }

/**
 * A unit's context item: `<task-id>:<unit-id>` is an entry; an absolute path,
 * optionally followed by `#<heading>`, is a path. Anything else is null.
 */
export function parseContextItem(item: string): ContextItem | null {
  const s = item.trim()
  const e = /^([a-z0-9][a-z0-9-]{1,31}):([^\s:/\\#]+)$/.exec(s)
  if (e) return { kind: 'entry', taskId: e[1] ?? '', unitId: e[2] ?? '' }
  const hash = s.indexOf('#')
  const path = (hash < 0 ? s : s.slice(0, hash)).trim()
  const heading = hash < 0 ? '' : s.slice(hash + 1).trim()
  if (!(path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path))) return null
  return { kind: 'path', path, heading: heading === '' ? null : heading }
}

// ---------------------------------------------------------------- 7. the W3 context block

const headingOf = (line: string): { level: number; text: string } | null => {
  const m = /^(#{1,6})[ \t]+(.*?)[ \t#]*$/.exec(line)
  return m ? { level: (m[1] ?? '').length, text: m[2] ?? '' } : null
}

/**
 * `path#heading`: the first heading whose text equals `heading` (leading `#`s and
 * case ignored), up to the next heading of the same or a higher level (fenced code
 * is skipped). A heading whose text starts with a date (`YYYY-MM-DD`, a decisions.md
 * entry) runs to the next dated heading of the same level, or any higher-level heading, so
 * an entry's own inner headings do not cut it short (0.14.0). Null when there is no
 * such heading.
 */
const DATED_HEADING = /^\d{4}-\d{2}-\d{2}\b/

export function headingSection(text: string, heading: string): string | null {
  const want = heading.replace(/^#+\s*/, '').trim().toLowerCase()
  const lines = text.split('\n')
  let fence = false
  let start = -1
  let level = 0
  let dated = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
      continue
    }
    if (fence) continue
    const h = headingOf(line.replace(/\r$/, ''))
    if (h === null) continue
    if (start < 0) {
      if (h.text.trim().toLowerCase() === want) {
        start = i
        level = h.level
        dated = DATED_HEADING.test(h.text)
      }
    } else if (h.level < level || (h.level === level && (!dated || DATED_HEADING.test(h.text)))) {
      return lines.slice(start, i).join('\n').replace(/\s+$/, '')
    }
  }
  return start < 0 ? null : lines.slice(start).join('\n').replace(/\s+$/, '')
}

/**
 * From a journal entry's text: its header (everything before `## Brief`) and its
 * `## Result` section (and `## Result 2`, ... of a resumed run). The brief and the
 * messages are left out. The sections are found by their heading lines in order.
 */
export function entryContext(text: string): string {
  const lines = text.split('\n')
  const brief = lines.findIndex(l => l.replace(/\r$/, '') === '## Brief')
  if (brief < 0) return text
  const out = lines.slice(0, brief)
  let keep = false
  for (let i = brief + 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').replace(/\r$/, '')
    if (/^## (Brief|Message \d+)$/.test(line)) keep = false
    else if (/^## Result( \d+)?$/.test(line)) keep = true
    if (keep) out.push(lines[i] ?? '')
  }
  return unescapeSections(out.join('\n')).replace(/\s+$/, '')
}

/**
 * What a context item contributes from its file text: an entry item gives header and Result; `path#heading` the
 * heading's section (null when it is missing); otherwise the whole text.
 */
export function extractContext(item: ContextItem, text: string): string | null {
  if (item.kind === 'entry') return entryContext(text)
  if (item.heading !== null) return headingSection(text, item.heading)
  return text
}

export type ResolvedContext = { item: string; path: string; text: string }

/**
 * W3: the prompt with the context block appended. Per item, a heading line
 * `Context (inlined by the Agent Board from <path>):`, then its text up to 32,000
 * characters and 96,000 in all (items in the order given); a cut ends
 * `[cut at N of M characters; the rest is at <path>]`. Also each item's status
 * for the entry's `context:` line: `inlined N chars`, `cut at N of M`, `path only`.
 * With no items the prompt comes back unchanged.
 */
export function withContext(prompt: string, items: readonly ResolvedContext[]): { prompt: string; status: ContextStatus[] } {
  if (items.length === 0) return { prompt, status: [] }
  let used = 0
  const blocks: string[] = []
  const status: ContextStatus[] = []
  for (const it of items) {
    const m = it.text.length
    const room = Math.max(0, Math.min(CONTEXT_ITEM_CAP, CONTEXT_TOTAL_CAP - used))
    const n = Math.min(m, room)
    used += n
    let block = `Context (inlined by the Agent Board from ${it.path}):\n${it.text.slice(0, n)}`
    if (n < m) {
      block += `${n > 0 && !block.endsWith('\n') ? '\n' : ''}[cut at ${n} of ${m} characters; the rest is at ${it.path}]`
      status.push({ item: it.item, status: n === 0 ? 'path only' : `cut at ${n} of ${m}` })
    } else {
      status.push({ item: it.item, status: `inlined ${n} chars` })
    }
    blocks.push(block)
  }
  return { prompt: `${prompt}\n\n${blocks.join('\n\n')}`, status }
}

// ---------------------------------------------------------------- 7. entry text back to data

export const CONTEXT_STATUS = /(.+?) \((inlined \d+ chars|cut at \d+ of \d+|path only)\)(?:, |$)/g

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
