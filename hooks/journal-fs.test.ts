import { describe, expect, test } from 'claude-code/testing'

import type { TaskSlot } from '../types'
import {
  auditFilePath,
  journaled,
  journalRootOf,
  listEntryFiles,
  readOrNull,
  readShards,
  readStateText,
  readWholeEntry,
  regenIndex,
  writeShard,
  writeStateFiles,
} from './journal-fs'
import { shardLine, stateBakPath, stateJson, stateJsonPath, stateMdPath } from './journal'
import { tombstoneLine } from './prune'

const SESSION = 'abcdef12-3456-7890'
const ROOT = '/cfg/flowestra/journal'

type Fake = {
  files: Record<string, string>
  mtimes: Record<string, number>
  writes: string[]
  reads: string[]
  /** texts handed out one by one for a path before the file's own text */
  queued: Record<string, string[]>
}

// A minimal `$`: just the calls the file layer makes, over an in-memory file map.
function fake(files: Record<string, string> = {}): { $: any; w: Fake } {
  const w: Fake = { files: { ...files }, mtimes: {}, writes: [], reads: [], queued: {} }
  let clock = 0
  const $ = {
    fs: {
      read: async (path: string) => {
        w.reads.push(path)
        const q = w.queued[path]
        if (q !== undefined && q.length > 0) return q.shift()!
        if (!(path in w.files)) throw new Error(`ENOENT: ${path}`)
        return w.files[path]
      },
      write: async (path: string, text: string) => {
        w.files[path] = text
        w.mtimes[path] = ++clock
        w.writes.push(path)
      },
      list: async (folder: string) => {
        const dir = folder.replace(/\/+$/, '')
        const out = new Map<string, any>()
        for (const path of Object.keys(w.files)) {
          if (!path.startsWith(`${dir}/`)) continue
          const rest = path.slice(dir.length + 1)
          const name = rest.split('/')[0]!
          const isDir = rest.includes('/')
          out.set(name, { name, kind: isDir ? 'dir' : 'file', size: isDir ? 0 : w.files[path]!.length, mtimeMs: isDir ? 0 : (w.mtimes[path] ?? 0), isLink: false })
        }
        if (out.size === 0) throw new Error(`ENOENT: ${dir}`)
        return [...out.values()]
      },
    },
    session: { id: async () => SESSION },
    env: { get: async (k: string) => (k === 'CLAUDE_CONFIG_DIR' ? '/cfg' : undefined) },
    plugin: { root: '/plugin' },
  }
  return { $, w }
}

const slot = (): TaskSlot => ({ taskId: 't1', task: 'A task', repo: '/repo', phase: 'executing', wave: 1, units: [], status: 'open', activeAt: 1 })
const goodJson = () =>
  stateJson({ slot: slot(), sessionId: SESSION, updatedMs: 1, unitStates: {}, latestEntries: {}, recentEntries: [] })

describe('paths and queue', () => {
  test('journal root and audit file follow the config root', async () => {
    const { $ } = fake()
    expect(await journalRootOf($)).toBe(ROOT)
    expect(await auditFilePath($)).toBe(`/cfg/flowestra/audit/${SESSION}.log`)
  })

  test('journaled runs jobs in order and never rejects', async () => {
    const order: number[] = []
    await Promise.all([
      journaled(async () => {
        await Promise.resolve()
        order.push(1)
      }),
      journaled(async () => {
        throw new Error('boom')
      }),
      journaled(async () => {
        order.push(3)
      }),
    ])
    expect(order).toEqual([1, 3])
  })
})

describe('state files', () => {
  test('writeStateFiles writes md, then backup, then main, backup and main equal', async () => {
    const { $, w } = fake()
    const json = goodJson()
    await writeStateFiles($, ROOT, 'k', 't1', '# md', json)
    expect(w.writes).toEqual([stateMdPath(ROOT, 'k', 't1'), stateBakPath(ROOT, 'k', 't1'), stateJsonPath(ROOT, 'k', 't1')])
    expect(w.files[stateMdPath(ROOT, 'k', 't1')]).toBe('# md')
    expect(w.files[stateBakPath(ROOT, 'k', 't1')]).toBe(json)
    expect(w.files[stateJsonPath(ROOT, 'k', 't1')]).toBe(json)
  })

  test('readStateText: main when it parses', async () => {
    const { $ } = fake()
    await writeStateFiles($, ROOT, 'k', 't1', 'md', goodJson())
    expect(await readStateText($, ROOT, 'k', 't1')).toEqual({ text: goodJson(), source: 'main' })
  })

  test('readStateText: backup when main is torn or missing', async () => {
    const a = fake()
    await writeStateFiles(a.$, ROOT, 'k', 't1', 'md', goodJson())
    a.w.files[stateJsonPath(ROOT, 'k', 't1')] = '{"shape":"state-1","sl'
    expect(await readStateText(a.$, ROOT, 'k', 't1')).toEqual({ text: goodJson(), source: 'backup' })
    const b = fake({ [stateBakPath(ROOT, 'k', 't1')]: goodJson() })
    expect(await readStateText(b.$, ROOT, 'k', 't1')).toEqual({ text: goodJson(), source: 'backup' })
  })

  test('readStateText: unreadable when both are bad, null when neither exists', async () => {
    const a = fake({ [stateJsonPath(ROOT, 'k', 't1')]: 'torn', [stateBakPath(ROOT, 'k', 't1')]: '{' })
    expect(await readStateText(a.$, ROOT, 'k', 't1')).toEqual({ text: 'torn', source: 'unreadable' })
    const b = fake({ [stateBakPath(ROOT, 'k', 't1')]: '{' })
    expect(await readStateText(b.$, ROOT, 'k', 't1')).toEqual({ text: '{', source: 'unreadable' })
    const c = fake()
    expect(await readStateText(c.$, ROOT, 'k', 't1')).toBeNull()
  })
})

describe('readOrNull', () => {
  test('a missing file is null with one read', async () => {
    const { $, w } = fake()
    expect(await readOrNull($, '/x/a.md')).toBeNull()
    expect(w.reads).toEqual(['/x/a.md'])
  })

  test('a whole shard or JSON is read once', async () => {
    const shard = `${shardLine(1, 'k', 'k | a')}\n`
    const { $, w } = fake({ '/x/.shards/s.tsv': shard, '/x/s.json': '{"a":1}' })
    expect(await readOrNull($, '/x/.shards/s.tsv')).toBe(shard)
    expect(await readOrNull($, '/x/s.json')).toBe('{"a":1}')
    expect(w.reads.length).toBe(2)
  })

  test('a torn shard is read again and the second text returned, two reads', async () => {
    const whole = `${shardLine(1, 'k', 'k | a')}\n`
    const { $, w } = fake({ '/x/.shards/s.tsv': whole })
    w.queued['/x/.shards/s.tsv'] = [whole.slice(0, 20)] // cut inside the first tab-separated field
    expect(await readOrNull($, '/x/.shards/s.tsv')).toBe(whole)
    expect(w.reads.length).toBe(2)
  })

  test('invalid JSON is read again; still torn gives the second text, never a third read', async () => {
    const { $, w } = fake({ '/x/s.json': '{"a":1}' })
    w.queued['/x/s.json'] = ['{"a"']
    expect(await readOrNull($, '/x/s.json')).toBe('{"a":1}')
    expect(w.reads.length).toBe(2)
    const b = fake({ '/x/s.json': '{still' })
    b.w.queued['/x/s.json'] = ['{"a"']
    expect(await readOrNull(b.$, '/x/s.json')).toBe('{still')
    expect(b.w.reads.length).toBe(2)
  })
})

describe('readWholeEntry', () => {
  const entry = ['# t · u · l', 'results: stored beside this file', '## Brief', 'b', '## Result', '(stored in e.result.md, e.result.2.md)', ''].join('\n')

  test('joins the parts', async () => {
    const { $ } = fake({ '/p/e.md': entry, '/p/e.result.md': 'AA', '/p/e.result.2.md': 'BB' })
    expect(await readWholeEntry($, '/p/e.md')).toContain('## Result\nAABB')
  })

  test('a missing part gives the placeholder and does not throw', async () => {
    const { $ } = fake({ '/p/e.md': entry, '/p/e.result.md': 'AA' })
    const text = await readWholeEntry($, '/p/e.md')
    expect(text).toContain('AA(part e.result.2.md could not be read)')
  })

  test('an entry without parts is returned as is; a missing entry still throws', async () => {
    const { $ } = fake({ '/p/e.md': 'plain' })
    expect(await readWholeEntry($, '/p/e.md')).toBe('plain')
    await expect(readWholeEntry($, '/p/none.md')).rejects.toThrow()
  })
})

describe('shards and indexes', () => {
  test('writeShard then readShards round-trips; a second write for a key replaces it in the same line format', async () => {
    const { $, w } = fake()
    await writeShard($, '/f', 'a', 'a | one', 100)
    await writeShard($, '/f', 'b', 'b | two', 200)
    await writeShard($, '/f', 'a', 'a | three', 300)
    const path = `/f/.shards/${SESSION.slice(0, 8)}.tsv`
    expect(w.files[path]).toBe(`${[shardLine(300, 'a', 'a | three'), shardLine(200, 'b', 'b | two')].join('\n')}\n`)
    expect((await readShards($, '/f')).lines).toEqual(['a | three', 'b | two'])
  })

  const repoShard = (lines: string[]) => `${lines.join('\n')}\n`

  test('regenIndex drops tombstones at repo and root level, not at phase level', async () => {
    const tomb = tombstoneLine('t9', 500)
    const shard = repoShard([shardLine(500, 't9', tomb), shardLine(400, 't1', 't1 | open | x')])
    for (const level of ['repo', 'root'] as const) {
      const { $, w } = fake({ '/f/.shards/s.tsv': shard, '/f/t1/state.md': 'x', '/f/t9/state.md': 'x' })
      const lines = await regenIndex($, '/f', level, 'n', 1000)
      expect(lines).toEqual(['t1 | open | x'])
      expect(w.files['/f/index.md']).not.toContain('pruned')
    }
    const { $, w } = fake({ '/f/.shards/s.tsv': shard })
    const lines = await regenIndex($, '/f', 'phase', 'n', 1000)
    expect(lines).toEqual(['t1 | open | x', tomb].sort())
    expect(w.files['/f/index.md']).toContain('pruned')
  })

  test('regenIndex at root and repo level keeps only lines whose child folder exists', async () => {
    const shard = repoShard([shardLine(1, 'a', 'a | one'), shardLine(2, 'gone', 'gone | two'), shardLine(3, 'b', 'b | three')])
    for (const level of ['root', 'repo'] as const) {
      const { $, w } = fake({ '/f/.shards/s.tsv': shard, '/f/a/x.md': 'x', '/f/b/x.md': 'x' })
      const lines = await regenIndex($, '/f', level, 'n', 1000)
      expect(lines).toEqual(['a | one', 'b | three'])
      expect(w.files['/f/index.md']).toContain('a | one')
      expect(w.files['/f/index.md']).not.toContain('gone')
      expect(w.files['/f/.shards/s.tsv']).toBe(shard)
    }
  })

  test('regenIndex at phase level keeps lines whose keys are not folders', async () => {
    const shard = repoShard([shardLine(1, 'u1', 'u1 | one'), shardLine(2, 'u2', 'u2 | two')])
    const { $ } = fake({ '/f/.shards/s.tsv': shard })
    expect(await regenIndex($, '/f', 'phase', 'n', 1000)).toEqual(['u1 | one', 'u2 | two'])
  })

  test('regenIndex regenerates once more when a shard changed meanwhile', async () => {
    const { $, w } = fake({ '/f/.shards/s.tsv': `${shardLine(1, 'a', 'a | x')}\n` })
    w.mtimes['/f/.shards/s.tsv'] = 1
    const list = $.fs.list
    let shardListings = 0
    $.fs.list = async (folder: string) => {
      if (folder === '/f/.shards' && ++shardListings === 2) w.mtimes['/f/.shards/s.tsv'] = 2 // another session wrote it after the first read
      return list(folder)
    }
    await regenIndex($, '/f', 'phase', 'n', 5)
    expect(w.writes.filter(p => p === '/f/index.md').length).toBe(2)
  })
})

describe('listEntryFiles', () => {
  test('lists entry files only', async () => {
    const e = '20261115-101500-u1-abcd1234.md'
    const { $ } = fake({
      [`/ph/${e}`]: 'entry',
      [`/ph/20261115-101500-u1-abcd1234.result.md`]: 'part',
      [`/ph/20261115-101500-u1-abcd1234.result.2.md`]: 'part',
      '/ph/index.md': 'index',
      '/ph/.shards/s.tsv': 'x',
      '/ph/notes.txt': 'n',
    })
    expect(await listEntryFiles($, '/ph')).toEqual([{ name: e, mtimeMs: 0, size: 5 }])
    expect(await listEntryFiles($, '/missing')).toEqual([])
  })
})
