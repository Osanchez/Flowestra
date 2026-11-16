import { describe, expect, test } from 'claude-code/testing'

import {
  AUDIT_NAME_RE,
  COMMAND_ARGUMENT_HINT,
  COMMAND_DESCRIPTION,
  REPO_KEY_RE,
  TASK_ID_RE,
  TOMBSTONE,
  byNameRefusedText,
  byNameText,
  checkText,
  doneText,
  dropPruned,
  dryRunText,
  failureText,
  formatBytes,
  isAuditName,
  isCode,
  isRepoKey,
  isTaskId,
  keptReasons,
  namedAsContext,
  parseDays,
  parseJournalArgs,
  parseTaskName,
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
import type { AuditInfo, PruneInput, PrunePlan, TaskInfo } from './prune'

const ROOT = '/cfg/flowestra/journal'
const AROOT = '/cfg/flowestra/audit'
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0) // 2026-11-15T12:00:00.000Z
const D = 86_400_000
const KEY = 'alpha-a1b2c3'
const KEY2 = 'beta-0f0f0f'
const OWN = 'own-session-0001.log'

function task(over: Partial<TaskInfo> = {}): TaskInfo {
  const key = over.key ?? KEY
  const taskId = over.taskId ?? 'old-task'
  return {
    key,
    taskId,
    status: 'closed',
    updatedMs: NOW - 40 * D,
    entries: 3,
    bytes: 2048,
    firstMs: NOW - 45 * D,
    lastMs: NOW - 40 * D,
    path: `${ROOT}/${key}/${taskId}`,
    ...over,
  }
}

function audit(name: string, ageMs: number, bytes = 100, over: Partial<AuditInfo> = {}): AuditInfo {
  return { name, path: `${AROOT}/${name}`, bytes, mtimeMs: NOW - ageMs, ...over }
}

function input(over: Partial<PruneInput> = {}): PruneInput {
  return {
    nowMs: NOW,
    days: 30,
    tasks: [],
    audits: [],
    boardTaskIds: [],
    contextTaskIds: [],
    contextPaths: [],
    ownAuditName: OWN,
    byName: null,
    journalRoot: ROOT,
    auditRoot: AROOT,
    ...over,
  }
}

const names = (p: PrunePlan): string[] => p.tasks.map(t => `${t.key}/${t.taskId}`)
const reasonsOf = (p: PrunePlan): string[] => p.kept.map(k => `${k.kind} ${k.item}: ${k.reason}`)

// ---------------------------------------------------------------- names

describe('name rules', () => {
  test('regexes are the spec\'s', () => {
    expect(TASK_ID_RE.source).toBe('^[a-z0-9][a-z0-9-]{1,31}$')
    expect(REPO_KEY_RE.source).toBe('^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{6}$')
    expect(AUDIT_NAME_RE.source).toBe('^[A-Za-z0-9-]{8,64}\\.log$')
  })

  test('task ids', () => {
    for (const ok of ['ab', 'a-', '0a', 'old-task', 'a'.repeat(32)]) expect(isTaskId(ok)).toBe(true)
    for (const bad of ['', 'a', 'a'.repeat(33), '..', '.ab', '-ab', 'Ab', 'aB', 'a/b', 'a\\b', 'a.b', 'a b', 'ab\n', '\nab', 'a_b', 'ä-b']) {
      expect(isTaskId(bad)).toBe(false)
    }
    expect(isTaskId(undefined)).toBe(false)
    expect(isTaskId(12)).toBe(false)
  })

  test('repository keys', () => {
    for (const ok of [KEY, KEY2, 'repo-000000', 'my-repo-2-abcdef', 'x-123456']) expect(isRepoKey(ok)).toBe(true)
    for (const bad of [
      '', 'alpha', 'alpha-a1b2c', 'alpha-a1b2c3d', 'alpha-g1b2c3', 'Alpha-a1b2c3', 'alpha-A1B2C3', '-a1b2c3', 'a1b2c3',
      'alpha--a1b2c3', '.alpha-a1b2c3', '../alpha-a1b2c3', 'alpha-a1b2c3/', 'al/pha-a1b2c3', 'alpha_x-a1b2c3', 'alpha-a1b2c3\n', '..',
    ]) {
      expect(isRepoKey(bad)).toBe(false)
    }
  })

  test('audit names', () => {
    for (const ok of ['abcdefgh.log', OWN, 'ABCD-1234.log', `${'a'.repeat(64)}.log`]) expect(isAuditName(ok)).toBe(true)
    for (const bad of [
      '', 'abc.log', 'abcdefg.log', `${'a'.repeat(65)}.log`, 'abcdefgh.LOG', 'abcdefgh.log.bak', 'abcdefgh', '.abcdefgh.log',
      '../abcdefgh.log', 'abc/defgh.log', 'abcd_efgh.log', 'abcdefgh.log\n', 'prune.log',
    ]) {
      expect(isAuditName(bad)).toBe(false)
    }
  })

  test('codes', () => {
    expect(isCode('0a1b2c')).toBe(true)
    for (const bad of ['', '0a1b2', '0a1b2c3', '0A1B2C', 'zzzzzz', ' 0a1b2c']) expect(isCode(bad)).toBe(false)
  })

  test('parseTaskName', () => {
    expect(parseTaskName(`${KEY}/old-task`)).toEqual({ key: KEY, taskId: 'old-task' })
    for (const bad of [
      '', 'old-task', `${KEY}/`, '/old-task', `${KEY}/old-task/`, `${KEY}/old-task/design`, `${KEY}/..`, `../${KEY}/old-task`,
      `${KEY}/Old-task`, `alpha/old-task`, `${KEY}/${'a'.repeat(33)}`, `${KEY}/.old`, `${KEY}\\old-task`,
    ]) {
      expect(parseTaskName(bad)).toBeNull()
    }
  })
})

// ---------------------------------------------------------------- arguments

describe('parseJournalArgs', () => {
  test('status', () => {
    expect(parseJournalArgs('')).toEqual({ kind: 'status' })
    expect(parseJournalArgs('   \t ')).toEqual({ kind: 'status' })
    expect(parseJournalArgs('status')).toEqual({ kind: 'status' })
    expect(parseJournalArgs('  status  ')).toEqual({ kind: 'status' })
    expect(parseJournalArgs(undefined as never)).toEqual({ kind: 'status' })
  })

  test('check', () => {
    expect(parseJournalArgs('check')).toEqual({ kind: 'check' })
  })

  test('prune by days', () => {
    expect(parseJournalArgs('prune 30')).toEqual({ kind: 'prune', days: 30, confirm: null })
    expect(parseJournalArgs('  prune \t 30  ')).toEqual({ kind: 'prune', days: 30, confirm: null })
    expect(parseJournalArgs('prune 1')).toEqual({ kind: 'prune', days: 1, confirm: null })
    expect(parseJournalArgs('prune 36500')).toEqual({ kind: 'prune', days: 36500, confirm: null })
    expect(parseJournalArgs('prune 30 confirm 0a1b2c')).toEqual({ kind: 'prune', days: 30, confirm: '0a1b2c' })
  })

  test('prune by name', () => {
    expect(parseJournalArgs(`prune task ${KEY}/old-task`)).toEqual({ kind: 'prune-task', key: KEY, taskId: 'old-task', confirm: null })
    expect(parseJournalArgs(`prune task ${KEY}/old-task confirm ffffff`)).toEqual({
      kind: 'prune-task', key: KEY, taskId: 'old-task', confirm: 'ffffff',
    })
  })

  test('everything else is usage', () => {
    for (const bad of [
      'prune', 'prune 0', 'prune -1', 'prune +1', 'prune 1.5', 'prune 36501', 'prune 99999', 'prune 030', 'prune 1e3', 'prune 0x10',
      'prune ３０', 'prune thirty', 'prune 30 confirm', 'prune 30 confirm ABC123', 'prune 30 confirm abc12', 'prune 30 confirm abc1234',
      'prune 30 confirm zzzzzz', 'prune 30 confirm abc123 extra', 'prune 30 extra', 'prune 30 CONFIRM abc123', 'prune 30 abc123',
      'Prune 30', 'PRUNE 30', 'Status', 'CHECK', 'status extra', 'check now', 'help', 'prune task', 'prune task old-task',
      'prune task alpha/old-task', `prune task ${KEY}/../x`, `prune task ../old-task`, `prune task ${KEY}/Old-task`,
      `prune task ${KEY}/old-task extra`, `prune task ${KEY}/old-task confirm`, `prune task ${KEY}/old-task confirm zzzzzz`,
      `prune task ${KEY}/old-task confirm 0a1b2c extra`, `prune Task ${KEY}/old-task`, `prune task ${KEY}/old-task/design`,
      `prune task ${KEY} old-task`, `prune task ${KEY}/${'a'.repeat(33)}`, 'prune 30 task', `prune 30 task ${KEY}/old-task`,
    ]) {
      expect(parseJournalArgs(bad)).toEqual({ kind: 'usage' })
    }
  })

  test('parseDays', () => {
    expect(parseDays('1')).toBe(1)
    expect(parseDays('36500')).toBe(36500)
    for (const bad of ['', '0', '-1', '1.5', '36501', '01', ' 1', '1 ']) expect(parseDays(bad)).toBeNull()
  })

  test('pruneTarget', () => {
    expect(pruneTarget({ kind: 'prune', days: 30 })).toBe('30')
    expect(pruneTarget({ kind: 'prune-task', key: KEY, taskId: 'old-task' })).toBe(`task ${KEY}/old-task`)
  })
})

// ---------------------------------------------------------------- the plan

describe('planPrune by days', () => {
  test('an old closed task, an old audit file and its emptied repository are planned', () => {
    const t = task()
    const a = audit('aaaaaaaa-0001.log', 31 * D)
    const p = planPrune(input({ tasks: [t], audits: [a] }))
    expect(p.tasks).toEqual([t])
    expect(p.audits).toEqual([a])
    expect(p.repos).toEqual([KEY])
    expect(p.kept).toEqual([])
  })

  test('open tasks are never planned by days, however old', () => {
    const p = planPrune(input({ tasks: [task({ status: 'open', updatedMs: NOW - 9000 * D })] }))
    expect(p.tasks).toEqual([])
    expect(reasonsOf(p)).toEqual([`task ${KEY}/old-task: open`])
  })

  test('days boundary: exactly N days old is planned, one millisecond younger is kept', () => {
    const exact = task({ taskId: 'exact', updatedMs: NOW - 30 * D })
    const younger = task({ taskId: 'younger', updatedMs: NOW - 30 * D + 1 })
    const aExact = audit('aaaaaaaa-exact.log', 30 * D)
    const aYounger = audit('aaaaaaaa-young.log', 30 * D - 1)
    const p = planPrune(input({ tasks: [exact, younger], audits: [aExact, aYounger] }))
    expect(names(p)).toEqual([`${KEY}/exact`])
    expect(p.audits.map(a => a.name)).toEqual(['aaaaaaaa-exact.log'])
    expect(reasonsOf(p)).toEqual([`task ${KEY}/younger: young`, 'audit aaaaaaaa-young.log: young'])
    expect(p.repos).toEqual([]) // `younger` stays in the repository
  })

  test('a future update time is not old enough', () => {
    const p = planPrune(input({ tasks: [task({ updatedMs: NOW + D })] }))
    expect(reasonsOf(p)).toEqual([`task ${KEY}/old-task: young`])
  })

  test('a task that cannot be classified is kept as unreadable', () => {
    const p = planPrune(
      input({
        tasks: [
          task({ taskId: 'unreadable', status: 'unreadable', updatedMs: NOW - 9000 * D }),
          task({ taskId: 'parked', status: 'parked' as never }),
          task({ taskId: 'nan-time', updatedMs: Number.NaN }),
          task({ taskId: 'zero-time', updatedMs: 0 }),
          task({ taskId: 'negative-time', updatedMs: -1e20 }),
          task({ taskId: 'huge-time', updatedMs: 1e300 }),
          task({ taskId: 'nan-entries', entries: Number.NaN }),
          task({ taskId: 'neg-bytes', bytes: -1 }),
        ],
      }),
    )
    expect(p.tasks).toEqual([])
    expect(p.kept.map(k => k.reason)).toEqual(Array(8).fill('unreadable'))
  })

  test('a task on this session\'s board is kept, in any repository and any case', () => {
    const p = planPrune(
      input({
        tasks: [task(), task({ key: KEY2 }), task({ taskId: 'other' })],
        boardTaskIds: ['OLD-TASK '],
      }),
    )
    expect(names(p)).toEqual([`${KEY}/other`])
    expect(reasonsOf(p)).toEqual([`task ${KEY}/old-task: board`, `task ${KEY2}/old-task: board`])
  })

  test('a closed task an open task names by task id is kept in every repository', () => {
    const p = planPrune(input({ tasks: [task(), task({ key: KEY2 }), task({ taskId: 'other' })], contextTaskIds: ['old-task'] }))
    expect(names(p)).toEqual([`${KEY}/other`])
    expect(reasonsOf(p)).toEqual([`task ${KEY}/old-task: context`, `task ${KEY2}/old-task: context`])
  })

  test('a closed task named by path is kept: the folder, a file inside, a folder above, another root, any case', () => {
    const folder = `${ROOT}/${KEY}/old-task`
    for (const p of [
      folder,
      `${folder}/`,
      `${folder}/design/20261115-101010-u1-abcdef12.md`,
      `${ROOT}/${KEY}/./old-task/state.md`,
      `${ROOT}/${KEY}/other/../old-task/state.json`,
      `${ROOT}//${KEY}//old-task`,
      `${ROOT}/${KEY}`,
      ROOT,
      `/private${folder}/design/x.md`,
      `/elsewhere/link/${KEY}/old-task`,
      folder.toUpperCase(),
    ]) {
      const plan = planPrune(input({ tasks: [task()], contextPaths: [p] }))
      expect(reasonsOf(plan)).toEqual([`task ${KEY}/old-task: context`])
    }
  })

  test('paths that do not name the task leave it planned', () => {
    for (const p of [
      '', '   ', `${ROOT}/${KEY}/old-task-2/x.md`, `${ROOT}/${KEY}/old-taskx`, `${ROOT}/${KEY2}/old-task/x.md`, '/cfg/CLAUDE.md',
      `${ROOT}/${KEY}/old`,
    ]) {
      const plan = planPrune(input({ tasks: [task()], contextPaths: [p] }))
      expect(names(plan)).toEqual([`${KEY}/old-task`])
    }
  })

  test('names and paths the journal does not use are kept, never planned', () => {
    const bad: TaskInfo[] = [
      task({ key: 'alpha', taskId: 'no-suffix' }),
      task({ key: KEY, taskId: '..' }),
      task({ key: KEY, taskId: '.hidden' }),
      task({ key: KEY, taskId: 'Upper' }),
      task({ key: KEY, taskId: '' }),
      task({ key: KEY, taskId: 'a'.repeat(33) }),
      task({ key: KEY, taskId: 'a/b' }),
      task({ key: '..', taskId: 'old-task' }),
      task({ key: KEY, taskId: 'wrong-path', path: '/etc' }),
      task({ key: KEY, taskId: 'dotdot-path', path: `${ROOT}/${KEY}/../${KEY}/dotdot-path` }),
      task({ key: KEY, taskId: 'deeper', path: `${ROOT}/x/${KEY}/deeper` }),
      task({ key: KEY, taskId: 'relative', path: `cfg/flowestra/journal/${KEY}/relative` }),
      task({ key: KEY, taskId: 'trailing', path: `${ROOT}/${KEY}/trailing/` }),
    ]
    const p = planPrune(input({ tasks: bad }))
    expect(p.tasks).toEqual([])
    expect(p.repos).toEqual([])
    expect(p.kept.map(k => k.reason)).toEqual(Array(bad.length).fill('name'))
  })

  test('a journal root that is not a clean absolute folder plans no task', () => {
    for (const root of ['', '/', '//', 'cfg/flowestra/journal', '/cfg/../flowestra/journal', '/cfg/./journal']) {
      const t = task({ path: `${root}/${KEY}/old-task` })
      const p = planPrune(input({ journalRoot: root, tasks: [t] }))
      expect(p.tasks).toEqual([])
      expect(p.kept.map(k => k.reason)).toEqual(['name'])
    }
    // a trailing slash on the root is fine
    expect(names(planPrune(input({ journalRoot: `${ROOT}/`, tasks: [task()] })))).toEqual([`${KEY}/old-task`])
  })

  test('this session\'s audit file is never planned', () => {
    const own = audit(OWN, 900 * D)
    expect(reasonsOf(planPrune(input({ audits: [own] })))).toEqual([`audit ${OWN}: own`])
    // named by session id, in another case
    const p = planPrune(input({ audits: [own], ownAuditName: 'OWN-SESSION-0001' }))
    expect(p.audits).toEqual([])
    // an unknown own name keeps every audit file
    const q = planPrune(input({ audits: [own, audit('aaaaaaaa-0001.log', 900 * D)], ownAuditName: '' }))
    expect(q.audits).toEqual([])
    expect(q.kept.map(k => k.reason)).toEqual(['own', 'own'])
  })

  test('audit files with bad names, paths or times are kept', () => {
    const p = planPrune(
      input({
        audits: [
          audit('abc.log', 900 * D),
          audit('../aaaaaaaa.log', 900 * D),
          audit('aaaaaaaa.LOG', 900 * D),
          audit('.aaaaaaaa.log', 900 * D),
          audit('prune.log', 900 * D),
          audit('aaaaaaaa-0002.log', 900 * D, 100, { path: '/cfg/flowestra/journal/aaaaaaaa-0002.log' }),
          audit('aaaaaaaa-0003.log', 900 * D, 100, { path: `${AROOT}/sub/aaaaaaaa-0003.log` }),
          audit('aaaaaaaa-0004.log', 900 * D, 100, { mtimeMs: Number.NaN }),
          audit('aaaaaaaa-0005.log', 900 * D, Number.NaN),
        ],
      }),
    )
    expect(p.audits).toEqual([])
    expect(p.kept.map(k => k.reason)).toEqual(['name', 'name', 'name', 'name', 'name', 'name', 'name', 'unreadable', 'unreadable'])
    const q = planPrune(input({ auditRoot: 'audit', audits: [audit('aaaaaaaa-0001.log', 900 * D, 100, { path: 'audit/aaaaaaaa-0001.log' })] }))
    expect(q.kept.map(k => k.reason)).toEqual(['name'])
  })

  test('days outside 1..36500, or no clock, plan nothing', () => {
    for (const over of [{ days: 0 }, { days: -1 }, { days: 1.5 }, { days: 36501 }, { days: Number.NaN }, { nowMs: Number.NaN }]) {
      const p = planPrune(input({ ...over, tasks: [task({ updatedMs: NOW - 9000 * D })], audits: [audit('aaaaaaaa-0001.log', 9000 * D)] }))
      expect(p.tasks).toEqual([])
      expect(p.audits).toEqual([])
      expect(p.kept.map(k => k.reason)).toEqual(['young', 'young'])
    }
  })

  test('a repository is a candidate only when every task given in it is planned', () => {
    const p = planPrune(
      input({
        tasks: [
          task({ key: KEY, taskId: 'a-old' }),
          task({ key: KEY, taskId: 'b-open', status: 'open' }),
          task({ key: KEY2, taskId: 'c-old' }),
          task({ key: KEY2, taskId: 'd-old' }),
          task({ key: 'gamma-abcdef', taskId: 'e-old' }),
          task({ key: 'gamma-abcdef', taskId: 'Bad' }),
        ],
      }),
    )
    expect(names(p)).toEqual([`${KEY}/a-old`, `${KEY2}/c-old`, `${KEY2}/d-old`, 'gamma-abcdef/e-old'])
    expect(p.repos).toEqual([KEY2])
  })

  test('adversarial mix: everything planned is a closed, old, valid task folder directly under a repository folder', () => {
    const tasks: TaskInfo[] = []
    const keys = [KEY, 'alpha', 'ALPHA-A1B2C3', '..', '', '.x-abcdef', `${KEY}/x`]
    const ids = ['ok-1', '..', '.x', 'UP', '', 'a'.repeat(33), 'a/b', 'a\nb', 'ok-2']
    const statuses = ['open', 'closed', 'unreadable'] as const
    for (const key of keys) for (const taskId of ids) for (const status of statuses) tasks.push(task({ key, taskId, status }))
    const p = planPrune(input({ tasks }))
    for (const t of p.tasks) {
      expect(t.status).toBe('closed')
      expect(isRepoKey(t.key) && isTaskId(t.taskId)).toBe(true)
      expect(t.path).toBe(`${ROOT}/${t.key}/${t.taskId}`)
      expect(NOW - t.updatedMs >= 30 * D).toBe(true)
    }
    expect(names(p)).toEqual([`${KEY}/ok-1`, `${KEY}/ok-2`])
    expect(p.kept.length).toBe(tasks.length - 2)
  })
})

describe('planPrune by name', () => {
  test('a closed task is planned whatever its age; no audit file, no other task is listed', () => {
    const t = task({ updatedMs: NOW - 1 })
    const p = planPrune(
      input({ byName: `${KEY}/old-task`, tasks: [t, task({ taskId: 'other', status: 'open' })], audits: [audit('aaaaaaaa-0001.log', 900 * D)] }),
    )
    expect(p.tasks).toEqual([t])
    expect(p.audits).toEqual([])
    expect(p.kept).toEqual([])
    expect(p.repos).toEqual([]) // `other` is still there
  })

  test('an open task can be deleted by name', () => {
    const t = task({ status: 'open', updatedMs: NOW - D })
    const p = planPrune(input({ byName: `${KEY}/old-task`, tasks: [t] }))
    expect(p.tasks).toEqual([t])
    expect(p.repos).toEqual([KEY])
  })

  test('refused when on the board, named as context by id or by path, or unreadable', () => {
    const name = `${KEY}/old-task`
    const cases: [Partial<PruneInput>, string][] = [
      [{ boardTaskIds: ['old-task'] }, 'board'],
      [{ contextTaskIds: ['old-task'] }, 'context'],
      [{ contextPaths: [`${ROOT}/${KEY}/old-task/design/x.md`] }, 'context'],
      [{ tasks: [task({ status: 'unreadable' })] }, 'unreadable'],
      [{ tasks: [task({ status: 'open' })], boardTaskIds: ['old-task'] }, 'board'],
    ]
    for (const [over, reason] of cases) {
      const p = planPrune(input({ byName: name, tasks: [task()], ...over }))
      expect(p.tasks).toEqual([])
      expect(reasonsOf(p)).toEqual([`task ${name}: ${reason}`])
    }
  })

  test('a task that is not in the journal is missing', () => {
    const p = planPrune(input({ byName: `${KEY}/gone`, tasks: [task()] }))
    expect(p.tasks).toEqual([])
    expect(reasonsOf(p)).toEqual([`task ${KEY}/gone: missing`])
    // the same id in another repository does not count
    expect(reasonsOf(planPrune(input({ byName: `${KEY2}/old-task`, tasks: [task()] })))).toEqual([`task ${KEY2}/old-task: missing`])
  })

  test('a bad name plans nothing', () => {
    for (const bad of ['', 'old-task', `../${KEY}/old-task`, `${KEY}/..`, `${KEY}/old-task/`, `alpha/old-task`, `${KEY}/OLD-TASK`]) {
      const p = planPrune(input({ byName: bad, tasks: [task()] }))
      expect(p.tasks).toEqual([])
      expect(p.kept.map(k => k.reason)).toEqual(['name'])
    }
  })

  test('a matching task whose path is elsewhere is kept', () => {
    const p = planPrune(input({ byName: `${KEY}/old-task`, tasks: [task({ path: '/Users/someone/project/.flowestra' })] }))
    expect(p.tasks).toEqual([])
    expect(p.kept.map(k => k.reason)).toEqual(['name'])
  })
})

describe('namedAsContext', () => {
  const t = { key: KEY, taskId: 'old-task', path: `${ROOT}/${KEY}/old-task` }
  test('by id and by path', () => {
    expect(namedAsContext(t, [], [])).toBe(false)
    expect(namedAsContext(t, ['old-task'], [])).toBe(true)
    expect(namedAsContext(t, ['old-task-2', 'old'], [])).toBe(false)
    expect(namedAsContext(t, [], [`${ROOT}/${KEY}/old-task/x.md`])).toBe(true)
    expect(namedAsContext(t, [], [`${ROOT}/${KEY}/old-task-2/x.md`])).toBe(false)
    expect(namedAsContext(t, [], ['C:\\cfg\\flowestra\\journal\\alpha-a1b2c3\\old-task\\x.md'])).toBe(true)
  })
})

// ---------------------------------------------------------------- the code

describe('pruneCode', () => {
  const tasks = [task({ taskId: 'a-old' }), task({ taskId: 'b-old' }), task({ key: KEY2, taskId: 'c-old' })]
  const audits = [audit('aaaaaaaa-0001.log', 40 * D), audit('aaaaaaaa-0002.log', 50 * D)]
  const base = planPrune(input({ tasks, audits }))
  const code = pruneCode(base, 30)

  test('six hex characters', () => {
    expect(code).toMatch(/^[0-9a-f]{6}$/)
  })

  test('stable under reordering of the input', () => {
    const p = planPrune(input({ tasks: [...tasks].reverse(), audits: [...audits].reverse() }))
    expect(pruneCode(p, 30)).toBe(code)
    expect(pruneCode(planPrune(input({ tasks, audits })), 30)).toBe(code)
  })

  test('changes when the days change', () => {
    expect(pruneCode(base, 31)).not.toBe(code)
    expect(pruneCode(base, 0)).not.toBe(code)
  })

  test('changes when any item changes, is added or is removed', () => {
    const variants: PrunePlan[] = [
      planPrune(input({ tasks: tasks.slice(1), audits })),
      planPrune(input({ tasks, audits: audits.slice(1) })),
      planPrune(input({ tasks: [...tasks, task({ taskId: 'd-old' })], audits })),
      planPrune(input({ tasks, audits: [...audits, audit('aaaaaaaa-0003.log', 40 * D)] })),
      planPrune(input({ tasks: [task({ taskId: 'a-old', entries: 4 }), ...tasks.slice(1)], audits })),
      planPrune(input({ tasks: [task({ taskId: 'a-old', bytes: 2049 }), ...tasks.slice(1)], audits })),
      planPrune(input({ tasks: [task({ taskId: 'a-old', updatedMs: NOW - 41 * D }), ...tasks.slice(1)], audits })),
      planPrune(input({ tasks: [task({ taskId: 'a-new' }), ...tasks.slice(1)], audits })),
      planPrune(input({ tasks, audits: [audit('aaaaaaaa-0001.log', 41 * D), audits[1] as AuditInfo] })),
      planPrune(input({ tasks, audits: [audit('aaaaaaaa-0001.log', 40 * D, 101), audits[1] as AuditInfo] })),
      // a task appears in KEY2, so that repository is no longer emptied
      planPrune(input({ tasks: [...tasks, task({ key: KEY2, taskId: 'e-new', updatedMs: NOW })], audits })),
    ]
    for (const v of variants) expect(pruneCode(v, 30)).not.toBe(code)
  })

  test('an empty plan has a code too', () => {
    expect(pruneCode({ tasks: [], audits: [], repos: [], kept: [] }, 30)).toMatch(/^[0-9a-f]{6}$/)
  })
})

// ---------------------------------------------------------------- tombstones, log, sizes

describe('tombstones', () => {
  test('tombstoneLine', () => {
    expect(TOMBSTONE).toBe('pruned')
    expect(tombstoneLine('old-task', NOW)).toBe('old-task | pruned | 2026-11-15T12:00:00.000Z')
    expect(tombstoneLine(KEY, NOW)).toBe('alpha-a1b2c3 | pruned | 2026-11-15T12:00:00.000Z')
  })

  test('dropPruned drops only lines whose second field is exactly pruned', () => {
    const lines = [
      'old-task | pruned | 2026-11-15T12:00:00.000Z',
      'a | pruned',
      'live | open | design | 3 | 2026-11-15T12:00:00.000Z | Title',
      'done | closed | review | 1 | 2026-11-15T12:00:00.000Z | pruned',
      'b | Pruned | x',
      'c | pruned  | x',
      'd |pruned| x',
      'e | pruned-x | y',
      'pruned | open | x',
      'pruned',
      '',
      'f\tpruned\tg',
    ]
    expect(dropPruned(lines)).toEqual([
      'live | open | design | 3 | 2026-11-15T12:00:00.000Z | Title',
      'done | closed | review | 1 | 2026-11-15T12:00:00.000Z | pruned',
      'b | Pruned | x',
      'c | pruned  | x',
      'd |pruned| x',
      'e | pruned-x | y',
      'pruned | open | x',
      'pruned',
      '',
      'f\tpruned\tg',
    ])
  })
})

describe('prune.log', () => {
  test('path', () => {
    expect(pruneLogPath('/cfg')).toBe('/cfg/flowestra/prune.log')
    expect(pruneLogPath('/cfg/')).toBe('/cfg/flowestra/prune.log')
  })

  test('lines always say manual', () => {
    expect(pruneLogTaskLine(NOW, 'abcdef0123456789', task())).toBe(
      '2026-11-15T12:00:00.000Z | session abcdef01 | manual | task alpha-a1b2c3/old-task | 3 entries | 2048 bytes | last updated 2026-10-06T12:00:00.000Z',
    )
    expect(pruneLogAuditLine(NOW, 'abcdef0123456789', audit('aaaaaaaa-0001.log', D, 512))).toBe(
      '2026-11-15T12:00:00.000Z | session abcdef01 | manual | audit aaaaaaaa-0001.log | 512 bytes',
    )
  })
})

describe('formatBytes', () => {
  test('edges', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1048575)).toBe('1024.0 KB')
    expect(formatBytes(1048576)).toBe('1.0 MB')
    expect(formatBytes(5.5 * 1048576)).toBe('5.5 MB')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})

// ---------------------------------------------------------------- texts

const STATUS_TASKS: TaskInfo[] = [
  task(), // closed, 40 days, 3 entries, 2048 bytes, 2026-10-01 .. 2026-10-06
  task({ taskId: 'live', status: 'open', updatedMs: NOW - D, entries: 2, bytes: 1000, firstMs: NOW - 2 * D, lastMs: NOW - D }),
  task({ key: KEY2, taskId: 'stale', status: 'open', updatedMs: NOW - 31 * D, entries: 1, bytes: 24, firstMs: NOW - 31 * D, lastMs: NOW - 31 * D }),
]

describe('statusText', () => {
  test('a journal', () => {
    expect(
      statusText({
        journalRoot: ROOT,
        nowMs: NOW,
        tasks: STATUS_TASKS,
        audits: [audit('aaaaaaaa-0001.log', D, 100), audit('aaaaaaaa-0002.log', D, 412)],
        masking: true,
        content: 'full',
      }),
    ).toBe(
      [
        'Journal: /cfg/flowestra/journal',
        '  2 repositories · 3 tasks (2 open, 1 closed) · 6 entries · 3.0 KB · 2026-10-01 to 2026-11-14',
        '  Open tasks not updated for 30 days or more: 1',
        '  Closed tasks not updated for 30 days or more: 1 (2.0 KB)',
        '  Audit files: 2 · 512 B',
        '  Retention: nothing is deleted unless you run /journal prune <days>.',
        '  Masking: on (best effort). Content: full.',
        'Commands: /journal prune <days> · /journal prune task <repo>/<task> · /journal check',
      ].join('\n'),
    )
  })

  test('masking off, capped content, an unreadable task, no entry dates', () => {
    expect(
      statusText({
        journalRoot: ROOT,
        nowMs: NOW,
        tasks: [task({ firstMs: null, lastMs: null, entries: 0, bytes: 10, updatedMs: NOW - 30 * D }), task({ taskId: 'bad', status: 'unreadable', entries: 0, bytes: 5, firstMs: null, lastMs: null })],
        audits: [],
        masking: false,
        content: 'capped',
      }),
    ).toBe(
      [
        'Journal: /cfg/flowestra/journal',
        '  1 repositories · 2 tasks (0 open, 1 closed, 1 unreadable) · 0 entries · 15 B',
        '  Open tasks not updated for 30 days or more: 0',
        '  Closed tasks not updated for 30 days or more: 1 (10 B)',
        '  Audit files: 0 · 0 B',
        '  Retention: nothing is deleted unless you run /journal prune <days>.',
        '  Masking: off. Content: capped.',
        'Commands: /journal prune <days> · /journal prune task <repo>/<task> · /journal check',
      ].join('\n'),
    )
  })

  test('an empty journal', () => {
    expect(statusText({ journalRoot: ROOT, nowMs: NOW, tasks: [], audits: [audit('aaaaaaaa-0001.log', D)], masking: true, content: 'index' })).toBe(
      [
        'Journal: /cfg/flowestra/journal',
        '  Empty: nothing has been written yet.',
        '  Retention: nothing is deleted unless you run /journal prune <days>.',
        '  Masking: on (best effort). Content: index.',
        'Commands: /journal prune <days> · /journal prune task <repo>/<task> · /journal check',
      ].join('\n'),
    )
  })

  test('A1: no retention setting or automatic deletion is mentioned', () => {
    const s = statusText({ journalRoot: ROOT, nowMs: NOW, tasks: STATUS_TASKS, audits: [], masking: true, content: 'full' })
    expect(s.includes('session start')).toBe(false)
    expect(s.includes('Retention: off')).toBe(false)
    expect(s.includes('at most once a day')).toBe(false)
  })
})

describe('dryRunText', () => {
  const tasks: TaskInfo[] = [
    task(),
    task({ taskId: 'live', status: 'open', updatedMs: NOW - D }),
    task({ key: KEY2, taskId: 'stale', status: 'open', updatedMs: NOW - 99 * D }),
    task({ taskId: 'on-board' }),
    task({ taskId: 'ctx-task' }),
    task({ key: KEY2, taskId: 'broken', status: 'unreadable' }),
    task({ taskId: 'fresh', updatedMs: NOW - 2 * D }),
  ]
  const audits = [audit('aaaaaaaa-0001.log', 31 * D, 100), audit(OWN, 99 * D)]
  const plan = planPrune(input({ tasks, audits, boardTaskIds: ['on-board'], contextTaskIds: ['ctx-task'] }))

  test('the plan behind it', () => {
    expect(names(plan)).toEqual([`${KEY}/old-task`])
    expect(plan.audits.map(a => a.name)).toEqual(['aaaaaaaa-0001.log'])
  })

  test('a dry run', () => {
    expect(dryRunText({ plan, days: 30, code: '0a1b2c', canDelete: true })).toBe(
      [
        'Journal prune (dry run): closed tasks not updated for 30 days or more, and audit files older than 30 days.',
        'Would delete 1 tasks · 3 entries · 2.0 KB · entries from 2026-10-01 to 2026-10-06:',
        '  alpha-a1b2c3/old-task  closed · 3 entries · 2.0 KB · last updated 2026-10-06',
        'Would delete 1 audit files · 100 B.',
        "Kept: 2 open, 1 on this session's board, 1 named as context by an open task (alpha-a1b2c3/ctx-task), 1 unreadable (beta-0f0f0f/broken), 1 not old enough.",
        'Deleted files cannot be recovered. To delete exactly this, type: /journal prune 30 confirm 0a1b2c',
      ].join('\n'),
    )
  })

  test('when this session cannot delete', () => {
    expect(dryRunText({ plan, days: 30, code: '0a1b2c', canDelete: false })).toBe(
      [
        'Journal prune (dry run): closed tasks not updated for 30 days or more, and audit files older than 30 days.',
        'Would delete 1 tasks · 3 entries · 2.0 KB · entries from 2026-10-01 to 2026-10-06:',
        '  alpha-a1b2c3/old-task  closed · 3 entries · 2.0 KB · last updated 2026-10-06',
        'Would delete 1 audit files · 100 B.',
        "Kept: 2 open, 1 on this session's board, 1 named as context by an open task (alpha-a1b2c3/ctx-task), 1 unreadable (beta-0f0f0f/broken), 1 not old enough.",
        'This session cannot delete files (host commands are not available here). To delete them yourself, remove these folders, then run /journal check:',
        '  /cfg/flowestra/journal/alpha-a1b2c3/old-task',
        '  /cfg/flowestra/audit/aaaaaaaa-0001.log',
      ].join('\n'),
    )
  })

  test('audit files only, nothing kept', () => {
    const p = planPrune(input({ audits: [audit('aaaaaaaa-0001.log', 31 * D, 2048)] }))
    expect(dryRunText({ plan: p, days: 30, code: 'ffffff', canDelete: true })).toBe(
      [
        'Journal prune (dry run): closed tasks not updated for 30 days or more, and audit files older than 30 days.',
        'Would delete 0 tasks.',
        'Would delete 1 audit files · 2.0 KB.',
        'Deleted files cannot be recovered. To delete exactly this, type: /journal prune 30 confirm ffffff',
      ].join('\n'),
    )
  })

  test('nothing to delete', () => {
    const p = planPrune(input({ days: 7, tasks: [task({ status: 'open' }), task({ taskId: 'x2', updatedMs: NOW })] }))
    expect(dryRunText({ plan: p, days: 7, code: '000000', canDelete: true })).toBe(
      'Journal prune: no closed task is 7 days old or older, and no audit file is. Kept: 1 open, 1 not old enough.',
    )
    const empty = planPrune(input({ days: 7 }))
    expect(dryRunText({ plan: empty, days: 7, code: '000000', canDelete: false })).toBe(
      'Journal prune: no closed task is 7 days old or older, and no audit file is. Nothing is deleted.',
    )
  })

  test('at most 20 task lines, then … and N more', () => {
    const many = Array.from({ length: 23 }, (_, i) => task({ taskId: `t-${String(i + 1).padStart(2, '0')}`, entries: 1, bytes: 10 }))
    const p = planPrune(input({ tasks: many }))
    const lines = dryRunText({ plan: p, days: 30, code: 'abcdef', canDelete: true }).split('\n')
    expect(lines[1]).toBe('Would delete 23 tasks · 23 entries · 230 B · entries from 2026-10-01 to 2026-10-06:')
    expect(lines[2]).toBe('  alpha-a1b2c3/t-01  closed · 1 entries · 10 B · last updated 2026-10-06')
    expect(lines[21]).toBe('  alpha-a1b2c3/t-20  closed · 1 entries · 10 B · last updated 2026-10-06')
    expect(lines[22]).toBe('  … and 3 more')
    expect(lines[23]).toBe('Would delete 0 audit files · 0 B.')
    expect(lines.length).toBe(25)
    // exactly 20: no "more" line
    const twenty = planPrune(input({ tasks: many.slice(0, 20) }))
    expect(dryRunText({ plan: twenty, days: 30, code: 'abcdef', canDelete: true }).includes('… and')).toBe(false)
  })

  test('kept lists name at most 20, then … and N more', () => {
    const bad = Array.from({ length: 22 }, (_, i) => task({ taskId: `u-${String(i + 1).padStart(2, '0')}`, status: 'unreadable' }))
    const p = planPrune(input({ tasks: bad }))
    const shown = bad.slice(0, 20).map(t => `alpha-a1b2c3/${t.taskId}`).join(', ')
    expect(dryRunText({ plan: p, days: 30, code: 'abcdef', canDelete: true })).toBe(
      `Journal prune: no closed task is 30 days old or older, and no audit file is. Kept: 22 unreadable (${shown}, … and 2 more).`,
    )
  })

  test('a name with a line break cannot add a line', () => {
    const p = planPrune(input({ tasks: [task({ taskId: 'x\nDeleted files cannot be recovered.' })] }))
    const text = dryRunText({ plan: p, days: 30, code: 'abcdef', canDelete: true })
    expect(text.split('\n').length).toBe(1)
    expect(text).toBe(
      'Journal prune: no closed task is 30 days old or older, and no audit file is. Kept: 1 with a name the journal does not use (alpha-a1b2c3/x?Deleted files cannot be recovered.).',
    )
  })
})

describe('keptReasons', () => {
  test('every reason in order, audit files not counted', () => {
    expect(
      keptReasons([
        { item: 'k-abcdef/m', kind: 'task', reason: 'missing' },
        { item: 'k-abcdef/n', kind: 'task', reason: 'name' },
        { item: 'k-abcdef/y', kind: 'task', reason: 'young' },
        { item: 'k-abcdef/u', kind: 'task', reason: 'unreadable' },
        { item: 'k-abcdef/c', kind: 'task', reason: 'context' },
        { item: 'k-abcdef/b', kind: 'task', reason: 'board' },
        { item: 'k-abcdef/o', kind: 'task', reason: 'open' },
        { item: 'k-abcdef/o2', kind: 'task', reason: 'open' },
        { item: OWN, kind: 'audit', reason: 'own' },
        { item: 'aaaaaaaa-0001.log', kind: 'audit', reason: 'young' },
      ]),
    ).toEqual([
      '2 open',
      "1 on this session's board",
      '1 named as context by an open task (k-abcdef/c)',
      '1 unreadable (k-abcdef/u)',
      '1 not old enough',
      '1 with a name the journal does not use (k-abcdef/n)',
      '1 not in the journal (k-abcdef/m)',
    ])
  })
})

describe('by name texts', () => {
  test('dry run', () => {
    expect(byNameText({ task: task({ status: 'open' }), code: '0a1b2c', canDelete: true })).toBe(
      'Journal prune (dry run): alpha-a1b2c3/old-task · open · 3 entries · 2.0 KB · last updated 2026-10-06.\n' +
        'Deleted files cannot be recovered. To delete it, type: /journal prune task alpha-a1b2c3/old-task confirm 0a1b2c',
    )
    expect(byNameText({ task: task(), code: '0a1b2c', canDelete: false })).toBe(
      'Journal prune (dry run): alpha-a1b2c3/old-task · closed · 3 entries · 2.0 KB · last updated 2026-10-06.\n' +
        'This session cannot delete files (host commands are not available here). To delete them yourself, remove these folders, then run /journal check:\n' +
        '  /cfg/flowestra/journal/alpha-a1b2c3/old-task',
    )
  })

  test('refused', () => {
    const n = `${KEY}/old-task`
    expect(byNameRefusedText(n, 'board')).toBe("Journal prune: alpha-a1b2c3/old-task is on this session's board; nothing is deleted.")
    expect(byNameRefusedText(n, 'context', `${KEY2}/live`)).toBe(
      'Journal prune: alpha-a1b2c3/old-task is named as context by the open task beta-0f0f0f/live; nothing is deleted.',
    )
    expect(byNameRefusedText(n, 'context')).toBe('Journal prune: alpha-a1b2c3/old-task is named as context by an open task; nothing is deleted.')
    expect(byNameRefusedText(n, 'missing')).toBe('Journal prune: alpha-a1b2c3/old-task is not in the journal; nothing is deleted.')
    expect(byNameRefusedText('x/../y', 'name')).toBe('Journal prune: x/../y is not in the journal; nothing is deleted.')
    expect(byNameRefusedText(n, 'unreadable')).toBe(
      'Journal prune: alpha-a1b2c3/old-task is a task whose state file cannot be read; nothing is deleted.',
    )
  })
})

describe('confirm texts', () => {
  test('done', () => {
    expect(
      doneText({
        deletedTasks: [task(), task({ taskId: 'b', entries: 2, bytes: 1024 })],
        deletedAudits: [audit('aaaaaaaa-0001.log', D, 100)],
        plannedTasks: 2,
        plannedAudits: 1,
        notDeleted: [],
        pruneLog: '/cfg/flowestra/prune.log',
      }),
    ).toBe(
      'Journal prune: deleted 2 tasks (5 entries, 3.0 KB) and 1 audit files (100 B). The indexes were updated. What was deleted is listed in /cfg/flowestra/prune.log.',
    )
  })

  test('partly', () => {
    expect(
      doneText({
        deletedTasks: [task()],
        deletedAudits: [],
        plannedTasks: 2,
        plannedAudits: 1,
        notDeleted: [
          { item: `${KEY}/b`, reason: 'the folder is a link' },
          { item: 'aaaaaaaa-0001.log', reason: 'rm failed' },
        ],
        pruneLog: '/cfg/flowestra/prune.log',
      }),
    ).toBe(
      'Journal prune: deleted 1 of 2 tasks and 0 of 1 audit files. Not deleted: alpha-a1b2c3/b (the folder is a link), aaaaaaaa-0001.log (rm failed). The indexes were updated. What was deleted is listed in /cfg/flowestra/prune.log.',
    )
  })

  test('code changed and origin', () => {
    expect(refusedText('changed', '30', 'abcdef')).toBe(
      'Journal prune: the journal changed since that summary, so nothing was deleted. Run /journal prune 30 again for a new summary.',
    )
    expect(refusedText('origin', '30', 'abcdef')).toBe(
      'Journal prune: deleting needs your own keystroke, so nothing was deleted. Type /journal prune 30 confirm abcdef at the prompt.',
    )
    expect(refusedText('changed', pruneTarget({ kind: 'prune-task', key: KEY, taskId: 'old-task' }), 'abcdef')).toBe(
      'Journal prune: the journal changed since that summary, so nothing was deleted. Run /journal prune task alpha-a1b2c3/old-task again for a new summary.',
    )
    expect(refusedText('origin', `task ${KEY}/old-task`, '123456')).toBe(
      'Journal prune: deleting needs your own keystroke, so nothing was deleted. Type /journal prune task alpha-a1b2c3/old-task confirm 123456 at the prompt.',
    )
  })

  test('failure', () => {
    expect(failureText()).toBe('Journal: the command could not finish; nothing more was changed. Run /journal check.')
  })
})

describe('checkText', () => {
  test('no problems', () => {
    expect(checkText({ tasks: 4, entries: 12, indexes: 9, added: [], restored: [], unreadableStates: [], unreadableEntries: [] })).toBe(
      'Journal check: 4 tasks, 12 entries, 9 indexes regenerated.\n  No problems found.',
    )
  })

  test('every line', () => {
    expect(
      checkText({
        tasks: 4,
        entries: 12,
        indexes: 9,
        added: [`${KEY}/old-task/design/20261115-101010-u1-abcdef12.md`],
        restored: [`${KEY}/old-task`, `${KEY2}/live`],
        unreadableStates: [`${KEY2}/broken`],
        unreadableEntries: [`${ROOT}/${KEY}/old-task/design/x.md`],
      }),
    ).toBe(
      [
        'Journal check: 4 tasks, 12 entries, 9 indexes regenerated.',
        '  Added to the indexes: 1 entries that were missing (alpha-a1b2c3/old-task/design/20261115-101010-u1-abcdef12.md)',
        '  Restored from backup: 2 state files (alpha-a1b2c3/old-task, beta-0f0f0f/live)',
        '  Unreadable: 1 state files with no readable backup (beta-0f0f0f/broken); opening such a task asks for its task line again.',
        '  Unreadable: 1 entry files (/cfg/flowestra/journal/alpha-a1b2c3/old-task/design/x.md)',
      ].join('\n'),
    )
  })

  test('only some lines, and a capped list', () => {
    const added = Array.from({ length: 21 }, (_, i) => `e${i + 1}`)
    expect(checkText({ tasks: 1, entries: 21, indexes: 3, added, restored: [], unreadableStates: [], unreadableEntries: [] })).toBe(
      `Journal check: 1 tasks, 21 entries, 3 indexes regenerated.\n  Added to the indexes: 21 entries that were missing (${added.slice(0, 20).join(', ')}, … and 1 more)`,
    )
  })
})

describe('usage and command', () => {
  test('texts', () => {
    expect(usageText()).toBe(
      'Usage: /journal · /journal prune <days> · /journal prune <days> confirm <code> · /journal prune task <repo>/<task> · /journal check',
    )
    expect(COMMAND_DESCRIPTION).toBe('Show, prune or check the work journal')
    expect(COMMAND_ARGUMENT_HINT).toBe('[prune <days> | check]')
  })
})
