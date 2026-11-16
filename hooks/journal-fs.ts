// The work journal's file layer (spec "Journal hardening", 2.1, 2.2): the one
// journal queue, the one cache of this session's shard files, and every read
// and write the journal does through `$.fs`. register.tsx and upkeep.ts share
// this module, so a session has one cache and one queue per runtime. Nothing
// here runs at import time; this module only reads, writes and lists.

import type { EngineInterface } from 'claude-code'

import {
  auditPath,
  configRoot,
  indexText,
  journalRoot,
  mergeShards,
  parseEntryFileName,
  parseShard,
  parseStateJson,
  shardLine,
  shardPath,
  stateBakPath,
  stateJsonPath,
  stateMdPath,
} from './journal'
import type { IndexLevel } from './journal'
import { dropPruned } from './prune'

// This session's shard files, by path: child key → shard line. A module map
// rebuilt on demand by reading the file (only this session writes it).
export const shardCache = new Map<string, Map<string, string>>()

let journalQueue: Promise<void> = Promise.resolve()

/** Runs `body` as the next link of the journal queue; settles when it has run, never rejects. */
export async function journaled(body: () => Promise<void>): Promise<void> {
  const link = journalQueue.then(body)
  journalQueue = link.catch(() => undefined)
  await link.catch(() => undefined)
}

/** The config root (B3.5): CLAUDE_CONFIG_DIR, else <HOME>/.claude, else <USERPROFILE>/.claude, else <plugin root>/data. */
export async function configRootOf($: EngineInterface): Promise<string> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = await $.env.get('HOME')
  const userProfile = await $.env.get('USERPROFILE')
  return configRoot({ configDir, home, userProfile, pluginRoot: $.plugin.root })
}

/** This session's audit file: `<config root>/flowestra/audit/<session id>.log`. */
export async function auditFilePath($: EngineInterface): Promise<string> {
  return auditPath(await configRootOf($), await $.session.id())
}

/** The journal's root: `<config root>/flowestra/journal`. */
export async function journalRootOf($: EngineInterface): Promise<string> {
  return journalRoot(await configRootOf($))
}

/** Lists a folder; [] when it is missing or cannot be listed. */
export async function listOrNone($: EngineInterface, folder: string): Promise<{ name: string; kind: string; mtimeMs: number }[]> {
  try {
    return (await $.fs.list(folder)).map(x => ({ name: x.name, kind: x.kind, mtimeMs: x.mtimeMs }))
  } catch {
    return []
  }
}

/** The entry files of a phase folder (`<yyyymmdd>-<hhmmss>-<unit>-<agent8>.md` only: no index, state, result part or shard); [] when it cannot be listed. */
export async function listEntryFiles($: EngineInterface, folder: string): Promise<{ name: string; mtimeMs: number; size: number }[]> {
  try {
    return (await $.fs.list(folder))
      .filter(x => x.kind === 'file' && parseEntryFileName(x.name) !== null)
      .map(x => ({ name: x.name, mtimeMs: x.mtimeMs, size: x.size }))
  } catch {
    return []
  }
}

/** True when `text` of the file at `path` looks torn: a shard with a line without exactly two tabs, or JSON that does not parse. */
function looksTorn(path: string, text: string): boolean {
  if (path.endsWith('.tsv')) {
    return text
      .split('\n')
      .map(l => l.replace(/\r$/, ''))
      .some(l => l !== '' && l.split('\t').length !== 3)
  }
  if (path.endsWith('.json')) {
    try {
      JSON.parse(text)
      return false
    } catch {
      return true
    }
  }
  return false
}

/** A file's text, or null when it cannot be read. A torn shard or JSON is read once more and the second text returned (F3): two reads at most. */
export async function readOrNull($: EngineInterface, path: string): Promise<string | null> {
  try {
    const first = String(await $.fs.read(path))
    if (!looksTorn(path, first)) return first
    return String(await $.fs.read(path))
  } catch {
    return null
  }
}

/** Sets this session's shard line for `key` in `folder` and writes the shard file whole. */
export async function writeShard($: EngineInterface, folder: string, key: string, line: string, at: number): Promise<void> {
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
export async function readShards($: EngineInterface, folder: string): Promise<{ lines: string[]; seen: Map<string, number> }> {
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
 * read (or new). Returns the merged lines. At the repo and root levels the
 * tombstone lines of pruned tasks are dropped first (never at the phase level,
 * where a line's second field is a unit id).
 */
export async function regenIndex($: EngineInterface, folder: string, level: IndexLevel, name: string, at: number): Promise<string[]> {
  const merged = async () => {
    const got = await readShards($, folder)
    const lines = level === 'repo' || level === 'root' ? dropPruned(got.lines) : got.lines
    return { lines, seen: got.seen }
  }
  let got = await merged()
  await $.fs.write(`${folder}/index.md`, indexText(level, name, got.lines, at))
  const again = (await listOrNone($, `${folder}/.shards`)).filter(f => f.kind === 'file' && f.name.endsWith('.tsv'))
  const changed = again.some(f => {
    const was = got.seen.get(f.name)
    return was === undefined || f.mtimeMs > was
  })
  if (changed) {
    got = await merged()
    await $.fs.write(`${folder}/index.md`, indexText(level, name, got.lines, at))
  }
  return got.lines
}

const HEADING_RESULT = /^## Result( \d+)?$/

/** An entry's text with each split result (`(stored in a, b)`) replaced by the joined text of its part files; a part that cannot be read becomes `(part <name> could not be read)` (F4). */
export async function readWholeEntry($: EngineInterface, path: string): Promise<string> {
  const text = String(await $.fs.read(path))
  if (!/^results: stored beside this file/m.test(text)) return text
  const folder = path.replace(/[\\/][^\\/]*$/, '')
  const lines = text.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const m = /^\(stored in (.+)\)$/.exec(lines[i] ?? '')
    if (m === null || !HEADING_RESULT.test(lines[i - 1] ?? '')) continue
    let joined = ''
    for (const name of (m[1] ?? '').split(', ')) {
      try {
        joined += String(await $.fs.read(`${folder}/${name}`))
      } catch {
        joined += `(part ${name} could not be read)`
      }
    }
    lines[i] = joined
  }
  return lines.join('\n')
}

/** Writes a task's state: state.md, then the backup `state.bak.json`, then `state.json` (F1). The backup and the main file hold the same text. */
export async function writeStateFiles($: EngineInterface, root: string, key: string, taskId: string, md: string, json: string): Promise<void> {
  await $.fs.write(stateMdPath(root, key, taskId), md)
  await $.fs.write(stateBakPath(root, key, taskId), json)
  await $.fs.write(stateJsonPath(root, key, taskId), json)
}

/**
 * A task's state text: `state.json` when it parses, else the backup when that
 * parses, else `unreadable` (the text of the main file, or of the backup when
 * the main file is missing); null when neither file exists.
 */
export async function readStateText(
  $: EngineInterface,
  root: string,
  key: string,
  taskId: string,
): Promise<{ text: string; source: 'main' | 'backup' | 'unreadable' } | null> {
  const main = await readOrNull($, stateJsonPath(root, key, taskId))
  if (main !== null && parseStateJson(main) !== null) return { text: main, source: 'main' }
  const bak = await readOrNull($, stateBakPath(root, key, taskId))
  if (bak !== null && parseStateJson(bak) !== null) return { text: bak, source: 'backup' }
  const text = main ?? bak
  return text === null ? null : { text, source: 'unreadable' }
}
