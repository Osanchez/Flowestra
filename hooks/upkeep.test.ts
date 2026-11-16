import { describe, expect, test } from 'claude-code/testing'

import type { TaskSlot, Unit } from '../types'
import {
  buildEntry,
  entryName,
  phaseLineOfData,
  repoIndexLine,
  repoKey,
  rootIndexLine,
  shardLine,
  stateJson,
  taskLineOf,
} from './journal'
import type { EntryData } from './journal'
import { shardCache } from './journal-fs'
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
  planPrune,
  pruneCode,
  pruneLogAuditLine,
  pruneLogTaskLine,
  refusedText,
  statusText,
  usageText,
} from './prune'
import type { AuditInfo, PrunePlan, TaskInfo, TaskStatus } from './prune'
import { registerJournalCommand, runJournalCommand } from './upkeep'

// ---------------------------------------------------------------- the stand-in `$`
//
// An in-memory file tree beneath the module under test: files by path, folders implied
// by the files under them, and `overrides` for entries a plain file map cannot say (a
// link, a folder whose resolved path is elsewhere). `process.run` records every argv and,
// for `rm`, removes that path from the tree. Nothing here touches a real disk.

const SESSION = 'sess0001-aaaa-bbbb-cccc'
const SID8 = 'sess0001'
const OTHER = 'othr0002-xxxx-yyyy'
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0)
const D = 86_400_000
const CFG = '/cfg'
const JR = `${CFG}/flowestra/journal`
const AR = `${CFG}/flowestra/audit`
const LOG = `${CFG}/flowestra/prune.log`
const KEY = 'alpha-a1b2c3'
const KEY2 = 'beta-0f0f0f'
const OWN_AUDIT = `${SESSION}.log`

type FileRec = { text: string; mtimeMs: number }
type Override = { kind: 'file' | 'dir' | 'other'; isLink: boolean; realPath?: string; size?: number; mtimeMs?: number }
type TaskMeta = { key: string; taskId: string; status: TaskStatus; updatedMs: number; spawns: number[] }

type W = {
  $: any
  files: Map<string, FileRec>
  overrides: Map<string, Override>
  statThrow: Set<string>
  listThrow: Set<string>
  writeThrow: (path: string) => boolean
  runs: string[][]
  runMode: 'ok' | 'reject' | 'absent'
  stays: Set<string>
  env: Record<string, string>
  /** stored prefix → resolved prefix (a config folder reached through a link) */
  real: [string, string][]
  logs: string[]
  registered: any[]
  registerThrows: boolean
  tasks: TaskMeta[]
  rootRows: Map<string, { open: number; tasks: number; updatedMs: number }>
}

/** Every `rm` argv of every test, with the resolved roots of its world, for the last test. */
const ALL_RUNS: { argv: string[]; jr: string; ar: string }[] = []

function world(opts: { runMode?: W['runMode']; real?: [string, string][] } = {}): W {
  shardCache.clear() // the module-level cache of this session's shards: each world starts clean
  const w: W = {
    $: null,
    files: new Map(),
    overrides: new Map(),
    statThrow: new Set(),
    listThrow: new Set(),
    writeThrow: () => false,
    runs: [],
    runMode: opts.runMode ?? 'ok',
    stays: new Set(),
    env: { CLAUDE_CONFIG_DIR: CFG },
    real: opts.real ?? [],
    logs: [],
    registered: [],
    registerThrows: false,
    tasks: [],
    rootRows: new Map(),
  }
  const realOf = (p: string): string => {
    for (const [from, to] of w.real) if (p === from || p.startsWith(`${from}/`)) return `${to}${p.slice(from.length)}`
    return p
  }
  const canon = (p: string): string => {
    for (const [from, to] of w.real) if (p === to || p.startsWith(`${to}/`)) return `${from}${p.slice(to.length)}`
    return p
  }
  const under = (p: string): boolean =>
    [...w.files.keys()].some(f => f.startsWith(`${p}/`)) || [...w.overrides.keys()].some(o => o.startsWith(`${p}/`))
  const exists = (p: string): boolean => w.files.has(p) || w.overrides.has(p) || under(p)
  const remove = (p: string): void => {
    for (const k of [...w.files.keys()]) if (k === p || k.startsWith(`${p}/`)) w.files.delete(k)
    for (const k of [...w.overrides.keys()]) if (k === p || k.startsWith(`${p}/`)) w.overrides.delete(k)
  }
  w.$ = {
    fs: {
      read: async (path: string) => {
        const f = w.files.get(canon(path))
        if (f === undefined) throw new Error(`ENOENT: ${path}`)
        return f.text
      },
      write: async (path: string, text: string) => {
        if (w.writeThrow(canon(path))) throw new Error(`EACCES: ${path}`)
        w.files.set(canon(path), { text, mtimeMs: NOW })
      },
      exists: async (path: string) => exists(canon(path)),
      list: async (path: string) => {
        const folder = canon(path)
        if (w.listThrow.has(folder)) throw new Error(`EIO: ${path}`)
        const out = new Map<string, any>()
        for (const [p, f] of w.files) {
          if (!p.startsWith(`${folder}/`)) continue
          const rest = p.slice(folder.length + 1)
          const name = rest.split('/')[0]!
          const isDir = rest.includes('/')
          out.set(name, { name, kind: isDir ? 'dir' : 'file', size: isDir ? 0 : f.text.length, mtimeMs: isDir ? 0 : f.mtimeMs, isLink: false })
        }
        for (const [p, o] of w.overrides) {
          if (!p.startsWith(`${folder}/`)) continue
          const rest = p.slice(folder.length + 1)
          if (rest.includes('/')) {
            const name = rest.split('/')[0]!
            if (!out.has(name)) out.set(name, { name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
            continue
          }
          out.set(rest, { name: rest, kind: o.isLink ? 'other' : o.kind, size: o.size ?? 0, mtimeMs: o.mtimeMs ?? 0, isLink: o.isLink })
        }
        if (out.size === 0 && !exists(folder)) throw new Error(`ENOENT: ${path}`)
        return [...out.values()]
      },
      stat: async (path: string, options?: { resolve?: boolean }) => {
        const p = canon(path)
        if (w.statThrow.has(p)) throw new Error(`EIO: ${path}`)
        const resolve = options?.resolve === true
        const o = w.overrides.get(p)
        if (o !== undefined) {
          return { kind: o.kind, isLink: o.isLink, size: o.size ?? 0, mtimeMs: o.mtimeMs ?? 0, ...(resolve ? { realPath: o.realPath ?? realOf(p) } : {}) }
        }
        const f = w.files.get(p)
        if (f !== undefined) return { kind: 'file', isLink: false, size: f.text.length, mtimeMs: f.mtimeMs, ...(resolve ? { realPath: realOf(p) } : {}) }
        if (under(p)) return { kind: 'dir', isLink: false, size: 0, mtimeMs: 0, ...(resolve ? { realPath: realOf(p) } : {}) }
        throw new Error(`ENOENT: ${path}`)
      },
    },
    process:
      w.runMode === 'absent'
        ? {}
        : {
          run: async (argv: readonly string[]) => {
            w.runs.push([...argv])
            ALL_RUNS.push({ argv: [...argv], jr: realOf(JR), ar: realOf(AR) })
            if (w.runMode === 'reject') throw new Error('process.run denied')
            if (argv[0] === 'rm') {
              const target = canon(argv[argv.length - 1]!)
              if (!w.stays.has(target)) remove(target)
            }
            return { exitCode: 0, stdout: '', stderr: '' }
          },
        },
    env: { get: async (k: string) => w.env[k] },
    session: { id: async () => SESSION },
    clock: { now: async () => NOW },
    plugin: { root: '/plugin' },
    ui: { log: (text: string) => void w.logs.push(text) },
    command: {
      register: async (spec: any) => {
        if (w.registerThrows) throw new Error('register refused')
        w.registered.push(spec)
        return { command: spec.name }
      },
    },
  }
  return w
}

// ---------------------------------------------------------------- fixtures

function put(w: W, path: string, text: string, mtimeMs: number = NOW - 40 * D): void {
  w.files.set(path, { text, mtimeMs })
}
function append(w: W, path: string, line: string, mtimeMs: number): void {
  const old = w.files.get(path)?.text ?? ''
  put(w, path, `${old}${line}\n`, mtimeMs)
}

function unit(id: string, context: string[] = [], spec: string | null = null): Unit {
  return { id, label: id, wave: 1, dependsOn: [], declared: null, tier: 'sonnet', kind: 'implement', audit: 'a | sonnet | b | c', verdict: null, spec, context }
}

function slot(taskId: string, status: 'open' | 'closed', units: Unit[] = [], repo: string | null = '/repos/alpha'): TaskSlot {
  return { taskId, task: `Task ${taskId}`, repo, phase: 'executing', wave: 1, units, status, activeAt: 1 }
}

function entryData(taskId: string, unitId: string, spawn: number, agentId: string): EntryData {
  return {
    taskId, unitId, label: 'L', audit: null, tier: 'sonnet', kind: 'implement', phase: 'executing', wave: 1, agentId,
    subagentType: null, model: null, sessionId: OTHER, cwd: null, context: [], spawnedMs: spawn, endedMs: spawn + 1000,
    status: 'done', verdict: null, verdictMs: null, brief: 'brief text', result: 'result text', resumes: [],
  }
}

/** A task folder as the journal writes it: state files, entries in `executing`, every shard line (another session's). */
function addTask(
  w: W,
  key: string,
  taskId: string,
  o: { status?: 'open' | 'closed'; updatedMs?: number; entries?: number; units?: Unit[]; state?: 'good' | 'torn' | 'main-torn' | 'none' } = {},
): void {
  const status = o.status ?? 'closed'
  const updatedMs = o.updatedMs ?? NOW - 40 * D
  const entries = o.entries ?? 1
  const tdir = `${JR}/${key}/${taskId}`
  const json = stateJson({ slot: slot(taskId, status, o.units ?? []), sessionId: OTHER, updatedMs, unitStates: {}, latestEntries: {}, recentEntries: [] })
  const state = o.state ?? 'good'
  if (state !== 'none') {
    put(w, `${tdir}/state.md`, `task ${taskId}\n`, updatedMs)
    put(w, `${tdir}/state.bak.json`, state === 'torn' ? '{' : json, updatedMs)
    put(w, `${tdir}/state.json`, state === 'good' ? json : '{"shape":"state-1","sl', updatedMs)
  }
  const spawns: number[] = []
  const phaseLines: string[] = []
  for (let i = 0; i < entries; i++) {
    const spawn = updatedMs - (entries - i) * 60_000
    spawns.push(spawn)
    const name = entryName(spawn, 'u1', `agent${i}aa-0000`)
    const file = `${name}.md`
    const data = entryData(taskId, 'u1', spawn, `agent${i}aa-0000`)
    put(w, `${tdir}/executing/${file}`, buildEntry(name, data).text, spawn)
    const line = phaseLineOfData(file, data)
    phaseLines.push(line)
    append(w, `${tdir}/executing/.shards/othr0002.tsv`, shardLine(spawn, file, line), spawn)
  }
  if (entries > 0) put(w, `${tdir}/.shards/othr0002.tsv`, `${shardLine(updatedMs, 'executing', taskLineOf('executing', phaseLines, updatedMs))}\n`, updatedMs)
  append(w, `${JR}/${key}/.shards/othr0002.tsv`, shardLine(updatedMs, taskId, repoIndexLine({ taskId, status, phase: 'executing', entries, updatedMs, title: taskId })), updatedMs)
  const row = w.rootRows.get(key) ?? { open: 0, tasks: 0, updatedMs: 0 }
  row.tasks += 1
  if (status === 'open') row.open += 1
  row.updatedMs = Math.max(row.updatedMs, updatedMs)
  w.rootRows.set(key, row)
  const rootText = [...w.rootRows.entries()]
    .map(([k, r]) => shardLine(r.updatedMs, k, rootIndexLine({ repoKey: k, root: `/repos/${k}`, openTasks: r.open, tasks: r.tasks, updatedMs: r.updatedMs })))
    .join('\n')
  put(w, `${JR}/.shards/othr0002.tsv`, `${rootText}\n`, updatedMs)
  w.tasks.push({ key, taskId, status: state === 'torn' || state === 'none' ? 'unreadable' : status, updatedMs, spawns })
}

function addAudit(w: W, name: string, ageMs: number, text = 'line\n'): void {
  put(w, `${AR}/${name}`, text, NOW - ageMs)
}

/** The standard journal: two repositories, old/open/young tasks, three audit files. */
function standard(opts: Parameters<typeof world>[0] = {}): W {
  const w = world(opts)
  addTask(w, KEY, 'old-a', { status: 'closed', updatedMs: NOW - 40 * D, entries: 2 })
  addTask(w, KEY, 'open-b', { status: 'open', updatedMs: NOW - 40 * D, entries: 1 })
  addTask(w, KEY, 'young-c', { status: 'closed', updatedMs: NOW - 5 * D, entries: 1 })
  addTask(w, KEY2, 'old-d', { status: 'closed', updatedMs: NOW - 50 * D, entries: 1 })
  addAudit(w, 'old-session-1.log', 40 * D)
  addAudit(w, OWN_AUDIT, 40 * D)
  addAudit(w, 'new-session-2.log', 1 * D)
  return w
}

/** The TaskInfo the command should build for a task, from what is in the tree now (call before deleting). */
function infoOf(w: W, key: string, taskId: string, root: string = JR): TaskInfo {
  const m = w.tasks.find(t => t.key === key && t.taskId === taskId)!
  const stored = `${JR}/${key}/${taskId}`
  let bytes = 0
  for (const [p, f] of w.files) if (p.startsWith(`${stored}/`)) bytes += f.text.length
  const secs = m.spawns.map(s => Math.floor(s / 1000) * 1000)
  return {
    key,
    taskId,
    status: m.status,
    updatedMs: m.updatedMs,
    entries: m.spawns.length,
    bytes,
    firstMs: secs.length === 0 ? null : Math.min(...secs),
    lastMs: secs.length === 0 ? null : Math.max(...secs),
    path: `${root}/${key}/${taskId}`,
  }
}

function auditOf(w: W, name: string, root: string = AR): AuditInfo {
  const f = w.files.get(`${AR}/${name}`)!
  return { name, path: `${root}/${name}`, bytes: f.text.length, mtimeMs: f.mtimeMs }
}

const POLICY = { masking: true, content: 'full' as const }

async function run(w: W, args: string, origin: any = { kind: 'composer' }, slots: TaskSlot[] = []): Promise<string> {
  return runJournalCommand(w.$, { args, origin }, { slots, policy: POLICY })
}

const codeOf = (text: string): string => /confirm ([0-9a-f]{6})$/.exec(text)?.[1] ?? 'none'
const has = (w: W, path: string): boolean => [...w.files.keys()].some(p => p === path || p.startsWith(`${path}/`))
const snapshot = (w: W): string => JSON.stringify([...w.files.entries()].sort())

/** Every `rm` this world ran has the one allowed shape, one absolute path, at the allowed depth under the resolved roots. */
function assertRmShape(w: W, jr: string = JR, ar: string = AR): void {
  for (const argv of w.runs) checkArgv(argv, jr, ar)
}

function checkArgv(argv: readonly string[], jr: string, ar: string): void {
  expect(argv.length).toBe(4)
  expect(argv[0]).toBe('rm')
  expect(argv[2]).toBe('--')
  const p = argv[3]!
  expect(p.startsWith('/')).toBe(true)
  expect(/[*?[\]]/.test(p)).toBe(false)
  expect(p.split('/').slice(1).every(s => s !== '' && s !== '.' && s !== '..')).toBe(true)
  if (argv[1] === '-rf') {
    expect(p.startsWith(`${jr}/`)).toBe(true)
    const rest = p.slice(jr.length + 1).split('/')
    expect(rest.length === 1 || rest.length === 2).toBe(true)
    expect(isRepoKey(rest[0])).toBe(true)
    if (rest.length === 2) expect(isTaskId(rest[1])).toBe(true)
  } else {
    expect(argv[1]).toBe('-f')
    expect(p.startsWith(`${ar}/`)).toBe(true)
    const name = p.slice(ar.length + 1)
    expect(name.includes('/')).toBe(false)
    expect(isAuditName(name)).toBe(true)
    expect(name).not.toBe(OWN_AUDIT)
  }
}

function plan(over: Partial<Parameters<typeof planPrune>[0]>): PrunePlan {
  return planPrune({
    nowMs: NOW,
    days: 30,
    tasks: [],
    audits: [],
    boardTaskIds: [],
    contextTaskIds: [],
    contextPaths: [],
    ownAuditName: OWN_AUDIT,
    byName: null,
    journalRoot: JR,
    auditRoot: AR,
    ...over,
  })
}

const sorted = (runs: string[][]): string[] => runs.map(r => r.join(' ')).sort()

// ---------------------------------------------------------------- registration and usage

describe('registration', () => {
  test('registers /journal with the texts of prune.ts', async () => {
    const w = world()
    await registerJournalCommand(w.$)
    expect(w.registered).toEqual([{ name: 'journal', description: COMMAND_DESCRIPTION, argumentHint: COMMAND_ARGUMENT_HINT }])
  })

  test('a failing register is swallowed and logged', async () => {
    const w = world()
    w.registerThrows = true
    await registerJournalCommand(w.$)
    expect(w.logs.length).toBe(1)
    expect(w.logs[0]).toContain('flowestra: /journal not registered')
  })

  test('a failing ui.log after a failing register still does not throw', async () => {
    const w = world()
    w.registerThrows = true
    w.$.ui.log = () => {
      throw new Error('no ui')
    }
    await registerJournalCommand(w.$)
  })

  test('anything else is the usage text; a malformed code is usage too, with no process.run', async () => {
    const w = standard()
    for (const a of ['bogus', 'prune', 'prune 0', 'prune 30 confirm ABCDEF', 'prune 30 confirm 12345', 'prune task x/y', 'check now']) {
      expect(await run(w, a)).toBe(usageText())
    }
    expect(w.runs).toEqual([])
  })

  test('runJournalCommand never throws: a failing file system gives the failure text', async () => {
    const w = standard()
    w.$.fs.exists = async () => {
      throw new Error('boom')
    }
    w.$.fs.list = async () => {
      throw new Error('boom')
    }
    expect(await run(w, 'prune 30')).toBe(failureText())
    expect(await run(w, 'status')).toBe(failureText())
    expect(await run(w, 'prune 30 confirm abcdef')).toBe(failureText())
    expect(w.runs).toEqual([])
  })
})

// ---------------------------------------------------------------- status

describe('status', () => {
  test('an empty journal', async () => {
    const w = world()
    const text = await run(w, '')
    expect(text).toBe(statusText({ journalRoot: JR, nowMs: NOW, tasks: [], audits: [], masking: true, content: 'full' }))
    expect(text).toContain('  Empty: nothing has been written yet.')
    expect(await run(w, 'status')).toBe(text)
  })

  test('a populated journal', async () => {
    const w = standard()
    const tasks = [infoOf(w, KEY, 'old-a'), infoOf(w, KEY, 'open-b'), infoOf(w, KEY, 'young-c'), infoOf(w, KEY2, 'old-d')]
    const audits = ['old-session-1.log', OWN_AUDIT, 'new-session-2.log'].map(n => auditOf(w, n))
    const text = await runJournalCommand(w.$, { args: 'status', origin: { kind: 'composer' } }, { slots: [], policy: { masking: false, content: 'capped' } })
    expect(text).toBe(statusText({ journalRoot: JR, nowMs: NOW, tasks, audits, masking: false, content: 'capped' }))
    expect(text).toContain('  2 repositories · 4 tasks (1 open, 3 closed) · 5 entries')
    expect(text).toContain('  Masking: off. Content: capped.')
    expect(text).toContain('  Retention: nothing is deleted unless you run /journal prune <days>.')
    expect(w.runs).toEqual([])
  })
})

// ---------------------------------------------------------------- prune by days

describe('prune by days', () => {
  test('dry run deletes nothing, makes no process.run call, and prints the code', async () => {
    const w = standard()
    const before = snapshot(w)
    const tasks = [infoOf(w, KEY, 'old-a'), infoOf(w, KEY, 'open-b'), infoOf(w, KEY, 'young-c'), infoOf(w, KEY2, 'old-d')]
    const audits = ['old-session-1.log', OWN_AUDIT, 'new-session-2.log'].map(n => auditOf(w, n))
    const p = plan({ tasks, audits })
    const code = pruneCode(p, 30)
    const text = await run(w, 'prune 30')
    expect(text).toBe(dryRunText({ plan: p, days: 30, code, canDelete: true }))
    expect(text).toContain('Would delete 2 tasks')
    expect(text.endsWith(`To delete exactly this, type: /journal prune 30 confirm ${code}`)).toBe(true)
    expect(p.repos).toEqual([KEY2])
    expect(w.runs).toEqual([])
    expect(snapshot(w)).toBe(before)
  })

  test('confirm from the keystroke deletes exactly the planned folders, writes tombstones and prune.log, updates the indexes', async () => {
    const w = standard()
    const oldA = infoOf(w, KEY, 'old-a')
    const oldD = infoOf(w, KEY2, 'old-d')
    const oldAudit = auditOf(w, 'old-session-1.log')
    const code = codeOf(await run(w, 'prune 30'))
    const text = await run(w, `prune 30 confirm ${code}`, { kind: 'composer' })
    expect(sorted(w.runs)).toEqual(
      sorted([
        ['rm', '-rf', '--', `${JR}/${KEY}/old-a`],
        ['rm', '-rf', '--', `${JR}/${KEY2}/old-d`],
        ['rm', '-rf', '--', `${JR}/${KEY2}`],
        ['rm', '-f', '--', `${AR}/old-session-1.log`],
      ]),
    )
    assertRmShape(w)
    expect(text).toBe(doneText({ deletedTasks: [oldA, oldD], deletedAudits: [oldAudit], plannedTasks: 2, plannedAudits: 1, notDeleted: [], pruneLog: LOG }))
    expect(text).toContain('Journal prune: deleted 2 tasks (3 entries, ')
    // gone, and only those
    expect(has(w, `${JR}/${KEY}/old-a`)).toBe(false)
    expect(has(w, `${JR}/${KEY2}`)).toBe(false)
    expect(has(w, `${AR}/old-session-1.log`)).toBe(false)
    expect(has(w, `${JR}/${KEY}/open-b`)).toBe(true)
    expect(has(w, `${JR}/${KEY}/young-c`)).toBe(true)
    expect(has(w, `${AR}/${OWN_AUDIT}`)).toBe(true)
    expect(has(w, `${AR}/new-session-2.log`)).toBe(true)
    // tombstones in this session's shards
    expect(w.files.get(`${JR}/${KEY}/.shards/${SID8}.tsv`)!.text).toContain('old-a | pruned | ')
    expect(w.files.get(`${JR}/.shards/${SID8}.tsv`)!.text).toContain(`${KEY2} | pruned | `)
    // indexes regenerated without the pruned task and repository
    const repoIndex = w.files.get(`${JR}/${KEY}/index.md`)!.text
    expect(repoIndex).not.toContain('old-a')
    expect(repoIndex).toContain('open-b | open')
    expect(repoIndex).toContain('young-c | closed')
    const rootIndex = w.files.get(`${JR}/index.md`)!.text
    expect(rootIndex).not.toContain(KEY2)
    expect(rootIndex).toContain(`${KEY} | /repos/${KEY} | 1 | 2 | `)
    // prune.log, manual only, names and sizes
    expect(w.files.get(LOG)!.text).toBe(
      `${[pruneLogTaskLine(NOW, SESSION, oldA), pruneLogTaskLine(NOW, SESSION, oldD), pruneLogAuditLine(NOW, SESSION, oldAudit)].join('\n')}\n`,
    )
    expect(w.files.get(LOG)!.text).not.toContain('automatic')
  })

  test('confirm through the bridge deletes too; prune.log is appended to, not replaced', async () => {
    const w = standard()
    put(w, LOG, 'earlier line\n')
    const code = codeOf(await run(w, 'prune 30'))
    await run(w, `prune 30 confirm ${code}`, { kind: 'bridge' })
    expect(w.runs.length).toBe(4)
    assertRmShape(w)
    expect(w.files.get(LOG)!.text.startsWith('earlier line\n')).toBe(true)
    expect(w.files.get(LOG)!.text.split('\n').filter(l => l !== '').length).toBe(4)
  })

  test('a prune.log that cannot be read is never overwritten; the line goes to the transcript', async () => {
    const w = standard()
    put(w, LOG, 'precious\n')
    const read = w.$.fs.read
    w.$.fs.read = async (p: string) => {
      if (p === LOG) throw new Error('too big')
      return read(p)
    }
    const code = codeOf(await run(w, 'prune 30'))
    await run(w, `prune 30 confirm ${code}`)
    expect(w.files.get(LOG)!.text).toBe('precious\n')
    expect(w.logs.some(l => l.includes('could not add to') && l.includes('old-a'))).toBe(true)
  })

  test('any origin other than composer or bridge: no process.run, the keystroke text', async () => {
    const w = standard()
    const code = codeOf(await run(w, 'prune 30'))
    const before = snapshot(w)
    for (const origin of [{ kind: 'model' }, { kind: 'plugin', name: 'x' }, { kind: 'sdk' }, { kind: '' }, { kind: 'scheduled-trigger' }, {}, null]) {
      expect(await run(w, `prune 30 confirm ${code}`, origin)).toBe(refusedText('origin', '30', code))
    }
    expect(await runJournalCommand(w.$, { args: `prune 30 confirm ${code}` }, { slots: [], policy: POLICY })).toBe(refusedText('origin', '30', code))
    expect(await run(w, `prune 30 confirm ${code}`, { kind: 'sdk' })).toContain('deleting needs your own keystroke, so nothing was deleted')
    expect(w.runs).toEqual([])
    expect(snapshot(w)).toBe(before)
  })

  test('a wrong code, or a code from a plan that has since changed: no process.run', async () => {
    const w = standard()
    const code = codeOf(await run(w, 'prune 30'))
    const wrong = code === 'abcdef' ? 'fedcba' : 'abcdef'
    expect(await run(w, `prune 30 confirm ${wrong}`)).toBe(refusedText('changed', '30', wrong))
    // the same code with other days is another plan
    expect(await run(w, `prune 31 confirm ${code}`)).toBe(refusedText('changed', '31', code))
    // a task grew since the summary
    put(w, `${JR}/${KEY}/old-a/executing/notes-grew.md`, 'more')
    expect(await run(w, `prune 30 confirm ${code}`)).toBe(refusedText('changed', '30', code))
    expect(w.runs).toEqual([])
    expect(has(w, `${JR}/${KEY}/old-a`)).toBe(true)
  })

  test('nothing to delete: the nothing text, and no process.run', async () => {
    const w = world()
    addTask(w, KEY, 'young-c', { status: 'closed', updatedMs: NOW - 5 * D })
    addTask(w, KEY, 'open-b', { status: 'open', updatedMs: NOW - 90 * D })
    const text = await run(w, 'prune 30')
    expect(text).toBe('Journal prune: no closed task is 30 days old or older, and no audit file is. Kept: 1 open, 1 not old enough.')
    expect(w.runs).toEqual([])
  })
})

// ---------------------------------------------------------------- prune by name and the protections

describe('protections', () => {
  test('an open task is kept by days but deleted by name after confirm', async () => {
    const w = standard()
    expect(await run(w, 'prune 30')).toContain('Kept: 1 open, 1 not old enough.')
    const info = infoOf(w, KEY, 'open-b')
    const dry = await run(w, `prune task ${KEY}/open-b`)
    const code = pruneCode(plan({ tasks: [infoOf(w, KEY, 'old-a'), info, infoOf(w, KEY, 'young-c'), infoOf(w, KEY2, 'old-d')], byName: `${KEY}/open-b` }), 0)
    expect(dry).toBe(byNameText({ task: info, code, canDelete: true }))
    expect(w.runs).toEqual([])
    const text = await run(w, `prune task ${KEY}/open-b confirm ${code}`)
    expect(w.runs).toEqual([['rm', '-rf', '--', `${JR}/${KEY}/open-b`]])
    assertRmShape(w)
    expect(text).toBe(doneText({ deletedTasks: [info], deletedAudits: [], plannedTasks: 1, plannedAudits: 0, notDeleted: [], pruneLog: LOG }))
    expect(has(w, `${JR}/${KEY}/open-b`)).toBe(false)
    expect(has(w, `${JR}/${KEY}/old-a`)).toBe(true)
  })

  test('a by-name confirm with another origin deletes nothing', async () => {
    const w = standard()
    const code = codeOf(await run(w, `prune task ${KEY}/open-b`))
    expect(await run(w, `prune task ${KEY}/open-b confirm ${code}`, { kind: 'model' })).toBe(refusedText('origin', `task ${KEY}/open-b`, code))
    expect(w.runs).toEqual([])
  })

  test('a task on this session\'s board is refused by name, even with a code', async () => {
    const w = standard()
    const board = [slot('old-a', 'closed')]
    expect(await run(w, `prune task ${KEY}/old-a`, { kind: 'composer' }, board)).toBe(byNameRefusedText(`${KEY}/old-a`, 'board'))
    expect(await run(w, `prune task ${KEY}/old-a confirm abcdef`, { kind: 'composer' }, board)).toBe(byNameRefusedText(`${KEY}/old-a`, 'board'))
    expect(await run(w, 'prune 30', { kind: 'composer' }, board)).toContain("1 on this session's board")
    expect(w.runs).toEqual([])
  })

  test('a task named as context by another open task is refused; by days it is kept', async () => {
    const w = world()
    addTask(w, KEY, 'old-a', { status: 'closed', updatedMs: NOW - 40 * D })
    addTask(w, KEY, 'open-b', { status: 'open', units: [unit('u1', ['old-a:u1'])] })
    expect(await run(w, `prune task ${KEY}/old-a`)).toBe(byNameRefusedText(`${KEY}/old-a`, 'context', `${KEY}/open-b`))
    expect(await run(w, `prune task ${KEY}/old-a`)).toContain(`named as context by the open task ${KEY}/open-b`)
    expect(await run(w, 'prune 30')).toContain(`1 named as context by an open task (${KEY}/old-a)`)
    expect(w.runs).toEqual([])
  })

  test('a task named by path or spec of an open task on this board is protected too', async () => {
    const w = world()
    addTask(w, KEY, 'old-a', { status: 'closed', updatedMs: NOW - 40 * D })
    const board = [slot('live', 'open', [unit('u1', [], `${JR}/${KEY}/old-a/executing/x.md`)])]
    expect(await run(w, `prune task ${KEY}/old-a`, { kind: 'composer' }, board)).toBe(byNameRefusedText(`${KEY}/old-a`, 'context', `${repoKey('/repos/alpha')}/live`))
    expect(await run(w, 'prune 30', { kind: 'composer' }, board)).toContain(`1 named as context by an open task (${KEY}/old-a)`)
    // a closed task on the board protects nothing by its context
    const closed = [slot('done-z', 'closed', [unit('u1', ['old-a:u1'])])]
    expect(await run(w, 'prune 30', { kind: 'composer' }, closed)).toContain('Would delete 1 tasks')
    expect(w.runs).toEqual([])
  })

  test('a task\'s own units do not protect it: deleted by name', async () => {
    const w = world()
    addTask(w, KEY, 'open-b', { status: 'open', units: [unit('u1', ['open-b:u1']), unit('u2', [], `${JR}/${KEY}/open-b/executing`)] })
    const dry = await run(w, `prune task ${KEY}/open-b`)
    expect(dry.startsWith('Journal prune (dry run): ')).toBe(true)
    const code = codeOf(dry)
    await run(w, `prune task ${KEY}/open-b confirm ${code}`)
    expect(w.runs).toEqual([
      ['rm', '-rf', '--', `${JR}/${KEY}/open-b`],
      ['rm', '-rf', '--', `${JR}/${KEY}`],
    ])
    assertRmShape(w)
    expect(has(w, `${JR}/${KEY}`)).toBe(false)
  })

  test('a state that cannot be read is kept by days and refused by name', async () => {
    const w = world()
    addTask(w, KEY, 'torn-e', { status: 'closed', updatedMs: NOW - 90 * D, state: 'torn' })
    addTask(w, KEY, 'gone-f', { status: 'closed', updatedMs: NOW - 90 * D, state: 'none' })
    expect(await run(w, 'prune 30')).toContain(`2 unreadable (${KEY}/torn-e, ${KEY}/gone-f)`)
    expect(await run(w, `prune task ${KEY}/torn-e`)).toBe(byNameRefusedText(`${KEY}/torn-e`, 'unreadable'))
    expect(await run(w, `prune task ${KEY}/nope-x`)).toBe(byNameRefusedText(`${KEY}/nope-x`, 'missing'))
    expect(w.runs).toEqual([])
  })

  test('a torn main state with a good backup is classified from the backup', async () => {
    const w = world()
    addTask(w, KEY, 'old-a', { status: 'closed', updatedMs: NOW - 40 * D, state: 'main-torn' })
    expect(await run(w, 'prune 30')).toContain('Would delete 1 tasks')
  })
})

// ---------------------------------------------------------------- adversarial trees

describe('adversarial trees', () => {
  async function pruneAll(w: W, slots: TaskSlot[] = []): Promise<{ dry: string; text: string }> {
    const dry = await run(w, 'prune 30', { kind: 'composer' }, slots)
    const text = await run(w, `prune 30 confirm ${codeOf(dry)}`, { kind: 'composer' }, slots)
    return { dry, text }
  }

  test('a task folder that is a link is never passed to rm', async () => {
    const w = standard()
    w.overrides.set(`${JR}/${KEY}/link-t`, { kind: 'dir', isLink: true, realPath: '/home/someone/project' })
    const { dry } = await pruneAll(w)
    expect(dry).toContain(`1 unreadable (${KEY}/link-t)`)
    expect(w.runs.some(r => r[3]!.includes('link-t'))).toBe(false)
    expect(has(w, `${JR}/${KEY}/old-a`)).toBe(false)
    assertRmShape(w)
  })

  test('a task folder whose resolved path is outside the journal is skipped and reported', async () => {
    const w = standard()
    addTask(w, KEY, 'old-x', { status: 'closed', updatedMs: NOW - 40 * D })
    w.overrides.set(`${JR}/${KEY}/old-x`, { kind: 'dir', isLink: false, realPath: '/Users/someone/project/.flowestra' })
    const { text } = await pruneAll(w)
    expect(text).toContain(`Not deleted: ${KEY}/old-x (resolves outside the journal)`)
    expect(text).toContain('Journal prune: deleted 2 of 3 tasks and 1 of 1 audit files.')
    expect(w.runs.some(r => r[3]!.includes('old-x'))).toBe(false)
    expect(has(w, `${JR}/${KEY}/old-x`)).toBe(true)
    expect(has(w, `${JR}/${KEY}/old-a`)).toBe(false)
    assertRmShape(w)
  })

  test('a journal root that resolves elsewhere refuses the whole prune', async () => {
    const w = standard()
    w.overrides.set(JR, { kind: 'dir', isLink: true, realPath: '/elsewhere/journal' })
    const expected = 'Journal prune: /cfg/flowestra/journal could not be confirmed to be /cfg/flowestra/journal with links followed; nothing is deleted.'
    expect(await run(w, 'prune 30')).toBe(expected)
    expect(await run(w, 'prune 30 confirm abcdef')).toBe(expected)
    expect(await run(w, `prune task ${KEY}/old-a`)).toBe(expected)
    expect(w.runs).toEqual([])
  })

  test('an audit folder that resolves elsewhere refuses the whole prune', async () => {
    const w = standard()
    w.overrides.set(AR, { kind: 'dir', isLink: false, realPath: '/tmp/audit' })
    expect(await run(w, 'prune 30')).toContain('could not be confirmed to be /cfg/flowestra/audit')
    expect(w.runs).toEqual([])
  })

  test('a config folder reached through a link: deletion works on resolved paths only', async () => {
    const w = standard({ real: [[CFG, '/real/cfg']] })
    const { text } = await pruneAll(w)
    expect(text.startsWith('Journal prune: deleted 2 tasks')).toBe(true)
    expect(sorted(w.runs)).toEqual(
      sorted([
        ['rm', '-rf', '--', `/real/cfg/flowestra/journal/${KEY}/old-a`],
        ['rm', '-rf', '--', `/real/cfg/flowestra/journal/${KEY2}/old-d`],
        ['rm', '-rf', '--', `/real/cfg/flowestra/journal/${KEY2}`],
        ['rm', '-f', '--', '/real/cfg/flowestra/audit/old-session-1.log'],
      ]),
    )
    assertRmShape(w, '/real/cfg/flowestra/journal', '/real/cfg/flowestra/audit')
  })

  test('repository folders with bad names are never entered or removed', async () => {
    const w = standard()
    for (const bad of ['Alpha-a1b2c3', 'alpha', 'alpha-a1b2c', 'al..pha-a1b2c3', 'alpha_x-a1b2c3']) addTask(w, bad, 'old-z', { status: 'closed', updatedMs: NOW - 90 * D })
    const { dry } = await pruneAll(w)
    expect(dry).toContain('5 with a name the journal does not use')
    for (const bad of ['Alpha-a1b2c3', 'alpha', 'alpha-a1b2c', 'al..pha-a1b2c3', 'alpha_x-a1b2c3']) {
      expect(w.runs.some(r => r[3] === `${JR}/${bad}` || r[3]!.startsWith(`${JR}/${bad}/`))).toBe(false)
      expect(has(w, `${JR}/${bad}/old-z`)).toBe(true)
    }
    expect(has(w, `${JR}/${KEY}/old-a`)).toBe(false)
    assertRmShape(w)
  })

  test('task folders with bad names (a dot, 33 characters, upper case) are never removed', async () => {
    const w = standard()
    for (const bad of ['old.x', 'a'.repeat(33), 'Old-x']) addTask(w, KEY, bad, { status: 'closed', updatedMs: NOW - 90 * D })
    const { dry } = await pruneAll(w)
    expect(dry).toContain('3 with a name the journal does not use')
    for (const bad of ['old.x', 'a'.repeat(33), 'Old-x']) {
      expect(w.runs.some(r => r[3] === `${JR}/${KEY}/${bad}`)).toBe(false)
      expect(has(w, `${JR}/${KEY}/${bad}`)).toBe(true)
    }
    assertRmShape(w)
  })

  test('a file where a task folder is expected is not removed', async () => {
    const w = standard()
    put(w, `${JR}/${KEY}/old-file`, 'not a folder')
    const { dry } = await pruneAll(w)
    expect(dry).toContain(`${KEY}/old-file`)
    expect(w.runs.some(r => r[3]!.includes('old-file'))).toBe(false)
    expect(has(w, `${JR}/${KEY}/old-file`)).toBe(true)
    assertRmShape(w)
  })

  test('audit entries that are a folder, a link, or this session\'s file are not removed', async () => {
    const w = standard()
    put(w, `${AR}/dirlike-0001.log/inner`, 'x', NOW - 90 * D)
    w.overrides.set(`${AR}/linked-0001.log`, { kind: 'file', isLink: true, realPath: '/etc/passwd', mtimeMs: NOW - 90 * D })
    await pruneAll(w)
    const removed = w.runs.map(r => r[3])
    expect(removed).toContain(`${AR}/old-session-1.log`)
    for (const n of ['dirlike-0001.log', 'linked-0001.log', OWN_AUDIT, 'new-session-2.log']) expect(removed).not.toContain(`${AR}/${n}`)
    expect(has(w, `${AR}/dirlike-0001.log`)).toBe(true)
    expect(w.overrides.has(`${AR}/linked-0001.log`)).toBe(true)
    expect(has(w, `${AR}/${OWN_AUDIT}`)).toBe(true)
    assertRmShape(w)
  })

  test('$.fs.stat throwing for one folder skips it; the others proceed', async () => {
    const w = standard()
    const dry = await run(w, 'prune 30')
    w.statThrow.add(`${JR}/${KEY}/old-a`)
    const text = await run(w, `prune 30 confirm ${codeOf(dry)}`)
    expect(text).toContain(`Not deleted: ${KEY}/old-a (could not be checked)`)
    expect(w.runs.some(r => r[3] === `${JR}/${KEY}/old-a`)).toBe(false)
    expect(has(w, `${JR}/${KEY}/old-a`)).toBe(true)
    expect(has(w, `${JR}/${KEY2}`)).toBe(false)
    expect(w.files.get(`${JR}/${KEY}/.shards/${SID8}.tsv`)?.text ?? '').not.toContain('old-a | pruned')
    assertRmShape(w)
  })

  test('$.fs.list throwing for a repository folder: its tasks are not walked; the others proceed', async () => {
    const w = standard()
    w.listThrow.add(`${JR}/${KEY}`)
    const { dry } = await pruneAll(w)
    expect(dry).toContain(`1 unreadable (${KEY}/)`)
    expect(w.runs.some(r => r[3]!.startsWith(`${JR}/${KEY}/`) || r[3] === `${JR}/${KEY}`)).toBe(false)
    expect(has(w, `${JR}/${KEY}/old-a`)).toBe(true)
    expect(has(w, `${JR}/${KEY2}`)).toBe(false)
    assertRmShape(w)
  })

  test('a task folder replaced by a link between the summary and the confirm is not removed', async () => {
    const w = standard()
    const dry = await run(w, 'prune 30')
    // the listing still says a plain folder (the plan and code match), but stat now says it is a link
    w.overrides.set(`${JR}/${KEY}/old-a`, { kind: 'dir', isLink: false, realPath: `${JR}/${KEY}/old-a` })
    const stat = w.$.fs.stat
    w.$.fs.stat = async (p: string, o: any) => (p === `${JR}/${KEY}/old-a` ? { kind: 'dir', isLink: true, size: 0, mtimeMs: 0, realPath: '/x' } : stat(p, o))
    const text = await run(w, `prune 30 confirm ${codeOf(dry)}`)
    expect(text).toContain(`Not deleted: ${KEY}/old-a (a link)`)
    expect(w.runs.some(r => r[3] === `${JR}/${KEY}/old-a`)).toBe(false)
    assertRmShape(w)
  })
})

// ---------------------------------------------------------------- when deletion is not available

describe('no deletion available', () => {
  test('process.run rejecting: nothing deleted, the manual-removal text with the folder list', async () => {
    const w = standard({ runMode: 'reject' })
    const tasks = [infoOf(w, KEY, 'old-a'), infoOf(w, KEY, 'open-b'), infoOf(w, KEY, 'young-c'), infoOf(w, KEY2, 'old-d')]
    const audits = ['old-session-1.log', OWN_AUDIT, 'new-session-2.log'].map(n => auditOf(w, n))
    const p = plan({ tasks, audits })
    const code = codeOf(await run(w, 'prune 30'))
    const before = snapshot(w)
    const text = await run(w, `prune 30 confirm ${code}`)
    expect(text).toBe(dryRunText({ plan: p, days: 30, code, canDelete: false }))
    expect(text).toContain('This session cannot delete files (host commands are not available here).')
    expect(text).toContain(`  ${JR}/${KEY}/old-a`)
    expect(text).toContain(`  ${AR}/old-session-1.log`)
    expect(w.runs.length).toBe(1) // the first attempt, rejected; nothing after it
    expect(snapshot(w)).toBe(before)
    assertRmShape(w)
  })

  test('Windows: the dry run lists the folders; a confirm deletes nothing and makes no process.run call', async () => {
    const w = standard()
    const code = codeOf(await run(w, 'prune 30'))
    w.env['OS'] = 'Windows_NT'
    const dry = await run(w, 'prune 30')
    expect(dry).toContain('This session cannot delete files')
    expect(dry).not.toContain('confirm')
    const before = snapshot(w)
    const text = await run(w, `prune 30 confirm ${code}`)
    expect(text).toBe(dry)
    expect(w.runs).toEqual([])
    expect(snapshot(w)).toBe(before)
  })

  test('no process.run at all: the manual text by name too', async () => {
    // No probe for host commands: the dry run cannot know they are missing; the confirm finds
    // out at the one call site and answers the manual-removal text, deleting nothing.
    const w = standard({ runMode: 'absent' })
    const info = infoOf(w, KEY, 'open-b')
    const code = codeOf(await run(w, `prune task ${KEY}/open-b`))
    const before = snapshot(w)
    const text = await run(w, `prune task ${KEY}/open-b confirm ${code}`)
    expect(text).toBe(byNameText({ task: info, code: 'unused', canDelete: false }))
    expect(text).toContain(`  ${JR}/${KEY}/open-b`)
    expect(snapshot(w)).toBe(before)
  })

  test('no process.run at all: by days, the confirm deletes nothing and answers the manual-removal text', async () => {
    const w = standard({ runMode: 'absent' })
    const tasks = [infoOf(w, KEY, 'old-a'), infoOf(w, KEY, 'open-b'), infoOf(w, KEY, 'young-c'), infoOf(w, KEY2, 'old-d')]
    const audits = ['old-session-1.log', OWN_AUDIT, 'new-session-2.log'].map(n => auditOf(w, n))
    const p = plan({ tasks, audits })
    const code = codeOf(await run(w, 'prune 30'))
    const before = snapshot(w)
    const text = await run(w, `prune 30 confirm ${code}`)
    expect(text).toBe(dryRunText({ plan: p, days: 30, code, canDelete: false }))
    expect(text).toContain(`  ${JR}/${KEY}/old-a`)
    expect(snapshot(w)).toBe(before)
  })
})

// ---------------------------------------------------------------- what counts as deleted

describe('after rm', () => {
  test('rm "succeeding" while the folder is still there: not counted, no tombstone, no log line', async () => {
    const w = standard()
    w.stays.add(`${JR}/${KEY}/old-a`)
    const oldD = infoOf(w, KEY2, 'old-d')
    const oldAudit = auditOf(w, 'old-session-1.log')
    const code = codeOf(await run(w, 'prune 30'))
    const text = await run(w, `prune 30 confirm ${code}`)
    expect(text).toBe(
      doneText({
        deletedTasks: [oldD],
        deletedAudits: [oldAudit],
        plannedTasks: 2,
        plannedAudits: 1,
        notDeleted: [{ item: `${KEY}/old-a`, reason: 'still there after rm' }],
        pruneLog: LOG,
      }),
    )
    expect(w.files.get(`${JR}/${KEY}/.shards/${SID8}.tsv`)?.text ?? '').not.toContain('old-a')
    expect(w.files.get(LOG)!.text).not.toContain('old-a')
    assertRmShape(w)
  })

  test('a tombstone that cannot be written does not undo the deletion; it is logged', async () => {
    const w = standard()
    w.writeThrow = p => p === `${JR}/${KEY}/.shards/${SID8}.tsv`
    const code = codeOf(await run(w, 'prune 30'))
    const text = await run(w, `prune 30 confirm ${code}`)
    expect(text.startsWith('Journal prune: deleted 2 tasks')).toBe(true)
    expect(has(w, `${JR}/${KEY}/old-a`)).toBe(false)
    expect(w.logs.some(l => l.includes('could not write its tombstone'))).toBe(true)
    assertRmShape(w)
  })

  test('a repository folder is removed only when nothing but its indexes is left', async () => {
    const w = standard()
    put(w, `${JR}/${KEY2}/notes.txt`, 'someone left this here')
    const { text } = await (async () => {
      const dry = await run(w, 'prune 30')
      return { text: await run(w, `prune 30 confirm ${codeOf(dry)}`) }
    })()
    expect(text.startsWith('Journal prune: deleted 2 tasks')).toBe(true)
    expect(w.runs.some(r => r[3] === `${JR}/${KEY2}`)).toBe(false)
    expect(has(w, `${JR}/${KEY2}/notes.txt`)).toBe(true)
    expect(has(w, `${JR}/${KEY2}/old-d`)).toBe(false)
    expect(w.files.get(`${JR}/index.md`)!.text).toContain(`${KEY2} | /repos/${KEY2} | 0 | 0 | `)
    assertRmShape(w)
  })

  test('a repository that keeps a task is never removed', async () => {
    const w = standard()
    const code = codeOf(await run(w, 'prune 30'))
    await run(w, `prune 30 confirm ${code}`)
    expect(w.runs.some(r => r[3] === `${JR}/${KEY}`)).toBe(false)
    expect(has(w, `${JR}/${KEY}/young-c`)).toBe(true)
  })
})

// ---------------------------------------------------------------- check

describe('check', () => {
  test('adds missing phase lines, restores state.json from its backup, regenerates indexes, reports; never deletes', async () => {
    const w = world()
    addTask(w, KEY, 'open-b', { status: 'open', updatedMs: NOW - 2 * D, entries: 1 })
    addTask(w, KEY, 'old-a', { status: 'closed', updatedMs: NOW - 40 * D, entries: 2, state: 'main-torn' })
    addTask(w, KEY, 'torn-e', { status: 'closed', updatedMs: NOW - 40 * D, entries: 1, state: 'torn' })
    const phase = `${JR}/${KEY}/open-b/executing`
    const spawn = NOW - D
    const name = entryName(spawn, 'u2', 'zzzzzzzz-1')
    put(w, `${phase}/${name}.md`, buildEntry(name, entryData('open-b', 'u2', spawn, 'zzzzzzzz-1')).text, spawn)
    put(w, `${phase}/20261115-100100-u3-yyyyyyyy.md`, 'garbage, not an entry', spawn)
    const text = await run(w, 'check')
    expect(text).toBe(
      checkText({
        tasks: 3,
        entries: 6,
        indexes: 8,
        added: [`${KEY}/open-b/executing/${name}.md`],
        restored: [`${KEY}/old-a`],
        unreadableStates: [`${KEY}/torn-e`],
        unreadableEntries: [`${KEY}/open-b/executing/20261115-100100-u3-yyyyyyyy.md`],
      }),
    )
    expect(text).toContain('  Added to the indexes: 1 entries that were missing')
    // the line is in this session's shard, timed by the file's mtime, and in the index
    const shard = w.files.get(`${phase}/.shards/${SID8}.tsv`)!.text
    expect(shard.startsWith(`${new Date(spawn).toISOString()}\t${name}.md\t${name}.md | u2 | `)).toBe(true)
    expect(w.files.get(`${phase}/index.md`)!.text).toContain(`${name}.md | u2`)
    // state.json restored from the backup
    expect(w.files.get(`${JR}/${KEY}/old-a/state.json`)!.text).toBe(w.files.get(`${JR}/${KEY}/old-a/state.bak.json`)!.text)
    // the unreadable one is left as it was
    expect(w.files.get(`${JR}/${KEY}/torn-e/state.json`)!.text).toBe('{"shape":"state-1","sl')
    expect(w.files.has(`${JR}/index.md`)).toBe(true)
    expect(w.files.has(`${JR}/${KEY}/index.md`)).toBe(true)
    expect(w.runs).toEqual([])
  })

  test('a healthy journal: no problems found; an empty one too', async () => {
    const w = world()
    addTask(w, KEY, 'open-b', { status: 'open', entries: 1 })
    expect(await run(w, 'check')).toBe(checkText({ tasks: 1, entries: 1, indexes: 4, added: [], restored: [], unreadableStates: [], unreadableEntries: [] }))
    expect(await run(w, 'check')).toContain('  No problems found.')
    expect(await run(world(), 'check')).toBe(checkText({ tasks: 0, entries: 0, indexes: 0, added: [], restored: [], unreadableStates: [], unreadableEntries: [] }))
    expect(w.runs).toEqual([])
  })
})

// ---------------------------------------------------------------- every rm, every test

describe('every rm of this file', () => {
  test('has exactly the allowed shape, one absolute path under the resolved journal or audit folder', () => {
    expect(ALL_RUNS.length).toBeGreaterThan(0)
    for (const r of ALL_RUNS) checkArgv(r.argv, r.jr, r.ar)
  })
})
