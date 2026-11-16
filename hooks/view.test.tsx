import { describe, expect, test } from 'claude-code/testing'

import type { AgentBox, AgentDetail, Board, Log, LogEntry, TaskKind, TaskSlot, Tier, Unit } from '../types'
import {
  DETAIL_FRAME_ROWS,
  LOG_COMPACT_SHOWN,
  LOG_FRAME_ROWS,
  LOG_SHOWN,
  PLAN_INNER,
  ROWS,
  TIER_COLOR,
  bandText,
  clockText,
  detailLines,
  drawBand,
  drawPane,
  flowProps,
  formatAge,
  formatCount,
  formatDuration,
  legendEntries,
  logLines,
  paneFit,
  shortModel,
  statusParts,
  tokenLines,
} from './view'
import type { ViewModel } from './view'

// Route: each test registers its own `ui.render` hooks (which sit beneath the
// plugin and stand for the engine) that call the pure drawing functions, then
// mounts the Pane or the band through the plugin with `$.ui.mount` on each
// surface. The plugin's own Pane hook answers only requestId 'flowestra', so
// the pane is mounted here under another requestId and reaches the test's hook;
// the plugin's band hook passes to `next` while its own board is empty, as it
// is in these tests.

const SURFACES = ['terminal', 'desktop'] as const
const NOW = 1_000_000

function agent(id: string, over: Partial<AgentBox> = {}): AgentBox {
  return {
    id,
    label: id === 'main' ? 'Orchestrator' : `Do ${id}`,
    type: id === 'main' ? 'main' : 'general-purpose',
    model: 'claude-opus-5-5',
    unitId: null,
    name: null,
    parentId: null,
    status: 'running',
    reason: null,
    tokens: { input: 1000, output: 3100, cacheRead: 35800, cacheWrite: 400, requests: 3 },
    tokensPartial: false,
    startedAt: NOW - 192_000,
    endedAt: null,
    lastEventAt: NOW - 1000,
    lastTool: null,
    briefChars: null,
    resultChars: null,
    flow: { dir: null, at: null },
    taskId: null,
    routed: null,
    ...over,
  }
}

function unit(id: string, wave: number, dependsOn: string[] = [], label = `Build ${id}`, over: Partial<Unit> = {}): Unit {
  return { id, label, wave, dependsOn, declared: null, tier: null, kind: null, audit: null, verdict: null, spec: null, context: [], ...over }
}

const HAIKU = 'claude-haiku-5-5-20261001'
const SONNET = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-5-5'

/** A valid four-part audit line naming `tier`. */
function auditFor(tier: Tier): string {
  return `find the call sites of foo | ${tier} | step 2, targets pinned | the lead greps each one`
}

const DEFAULT_KIND: Record<Tier, TaskKind> = { haiku: 'locate', sonnet: 'implement', opus: 'design' }

/** A unit of `tier` with its default kind and a valid audit line; wave 1, no dependencies unless `over` says. */
function tierUnit(id: string, tier: Tier, over: Partial<Unit> = {}, label = `Find ${id}`): Unit {
  return unit(id, 1, [], label, { tier, kind: DEFAULT_KIND[tier], audit: auditFor(tier), ...over })
}

const haikuUnit = (id: string, over: Partial<Unit> = {}, label = `Find ${id}`): Unit => tierUnit(id, 'haiku', over, label)

function board(over: Partial<Board> = {}, agents: AgentBox[] = []): Board {
  const record: Record<string, AgentBox> = {}
  for (const a of agents) record[a.id] = a
  return {
    taskId: null,
    repo: null,
    task: 'Build the agent board mod',
    phase: 'executing',
    wave: 1,
    units: [],
    agents: record,
    order: agents.map(a => a.id),
    loadedAt: NOW - 600_000,
    note: null,
    rejects: [],
    parked: [],
    closed: [],
    activeAt: 0,
    ...over,
  }
}

function vmOf(b: Board, over: Partial<ViewModel> = {}): ViewModel {
  return {
    board: b,
    now: NOW,
    width: 72,
    height: null,
    unitStates: {},
    quiet: {},
    detail: { agents: {} },
    ui: { selected: null },
    log: { entries: [] },
    onSelect: () => {},
    ...over,
  }
}

function detailOf(over: Partial<AgentDetail> = {}): AgentDetail {
  return { brief: null, briefCut: false, tools: [], ...over }
}

function entry(at: number, kind: LogEntry['kind'], who: string, text: string): LogEntry {
  return { at, kind, who, text }
}

function logOf(...entries: LogEntry[]): Log {
  return { entries }
}

// ---- a rough text painter for the drawn tree (for reading, and width checks)
const BORDERS: Record<string, [string, string, string, string, string, string]> = {
  round: ['╭', '╮', '╰', '╯', '─', '│'],
  bold: ['┏', '┓', '┗', '┛', '━', '┃'],
  double: ['╔', '╗', '╚', '╝', '═', '║'],
  dashed: ['┌', '┐', '└', '┘', '╌', '╎'],
  single: ['┌', '┐', '└', '┘', '─', '│'],
}

function textOf(n: unknown): string {
  if (typeof n === 'string') return n
  if (n && typeof n === 'object') return ((n as { children?: unknown[] }).children ?? []).map(textOf).join('')
  return ''
}

function pad(s: string, w: number): string {
  const chars = [...s]
  return chars.length >= w ? chars.slice(0, w).join('') : s + ' '.repeat(w - chars.length)
}

function paint(n: unknown, width: number): string[] {
  if (typeof n === 'string') return [pad(n, width)]
  if (!n || typeof n !== 'object') return []
  const node = n as { type: string; props?: Record<string, unknown>; children?: unknown[] }
  const p = node.props ?? {}
  const kids = (node.children ?? []).filter(k => k !== null && k !== false && k !== undefined)
  if (node.type === 'Text') return [pad(textOf(node), width)]
  if (node.type === 'Button') return [pad(textOf(node), width)]
  const w = typeof p.width === 'number' ? Math.min(p.width, width) : width
  const border = typeof p.borderStyle === 'string' ? BORDERS[p.borderStyle] ?? BORDERS.single : null
  const px = typeof p.paddingX === 'number' ? p.paddingX : 0
  const inner = Math.max(1, w - (border ? 2 : 0) - px * 2)
  const dir = p.flexDirection ?? 'row'
  let lines: string[] = []
  if (dir === 'row') {
    let used = 0
    const cols = kids.map(k => {
      const kn = k as { type?: string; props?: { width?: unknown } }
      // a Text, or a Box with no width of its own, takes the width of its text
      const kw = typeof kn.props?.width === 'number' && kn.type !== 'Text' ? (kn.props.width as number) : [...textOf(k)].length
      const cw = Math.max(0, Math.min(kw, inner - used))
      used += cw
      return { cw, lines: cw > 0 ? paint(k, cw) : [] }
    })
    const h = Math.max(0, ...cols.map(c => c.lines.length))
    for (let i = 0; i < h; i++) lines.push(pad(cols.map(c => c.lines[i] ?? ' '.repeat(c.cw)).join(''), inner))
  } else {
    const gap = typeof p.gap === 'number' ? p.gap : 0
    kids.forEach((k, i) => {
      if (i > 0) for (let g = 0; g < gap; g++) lines.push(' '.repeat(inner))
      lines.push(...paint(k, inner))
    })
  }
  lines = lines.map(l => ' '.repeat(px) + l + ' '.repeat(px))
  if (border) {
    const [tl, tr, bl, br, hz, vt] = border
    lines = [tl + hz.repeat(w - 2) + tr, ...lines.map(l => vt + l + vt), bl + hz.repeat(w - 2) + br]
  }
  return lines
}

// The test environment has a console; the hooks typings declare none.
function show(text: string): void {
  ;(globalThis as unknown as { console?: { log: (s: string) => void } }).console?.log(text)
}

function picture(tree: unknown, width: number): string {
  return paint(tree, width).map(l => l.trimEnd()).join('\n')
}

function walk(n: any, visit: (n: any) => void): void {
  if (!n || typeof n !== 'object') return
  visit(n)
  for (const k of n.children ?? []) walk(k, visit)
}

function keyOf(n: any): string {
  return String(n?.key ?? n?.props?.key ?? '')
}

function kids(found: any): any[] {
  return ((found?.children as any[]) ?? []).filter(c => c !== null && c !== false && c !== undefined)
}

// ---- mounting through the plugin
const PANE_PROPS = (width: number, rows: number) => ({
  title: 'Agent Board',
  isFocused: false,
  bodyColumns: width,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: rows },
  view: {},
})

// `animated`: hand drawPane a stand-in for the flow module's element instead of null.
type Ctx = { vm: ViewModel; animated?: boolean }

function hookUp(on: any, ctx: Ctx): void {
  on('ui.render', { component: 'Pane' }, ($: any, e: any) => {
    const el = $.ui.resolve(e)
    const { Box, Text } = el
    return drawPane(el, ctx.vm, ctx.animated ? <Box key="anim-flow"><Text>animated flow</Text></Box> : null)
  })
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => drawBand($.ui.resolve(e), ctx.vm))
}

async function mountPane($: any, surface: (typeof SURFACES)[number], vm: ViewModel) {
  return $.ui.mount({
    plugin: 'flowestra',
    component: 'Pane',
    requestId: 'view-test',
    surface,
    props: PANE_PROPS(vm.width, vm.height ?? 60),
  })
}

function threeAndBlocked(): ViewModel {
  const b = board(
    {
      task: 'Agent Board mod: view, state, tool',
      units: [
        tierUnit('U1', 'opus', {}, 'Write state'),
        tierUnit('U2', 'opus', {}, 'Write view'),
        tierUnit('U3', 'opus', {}, 'Write tool'),
        tierUnit('U4', 'opus', { wave: 2, dependsOn: ['U1', 'U2', 'U3'] }, 'Wire it up'),
      ],
    },
    [
      agent('main', { model: 'claude-fable-5-2', lastTool: 'Agent', tokens: { input: 2_100, output: 8_000, cacheRead: 410_000, cacheWrite: 30_000, requests: 20 } }),
      agent('w1', { unitId: 'U1', label: 'Write state', status: 'done', endedAt: NOW - 1000, briefChars: 4200, resultChars: 1800 }),
      agent('w2', { unitId: 'U2', label: 'Write view', lastTool: 'Write', briefChars: 5100 }),
      agent('w3', { unitId: 'U3', label: 'Write tool', tokens: null, lastTool: 'Read' }),
    ],
  )
  return vmOf(b, { unitStates: { U1: 'done', U2: 'running', U3: 'running', U4: 'blocked' } })
}

// ---------------------------------------------------------------- pure helpers

describe('pure helpers', () => {
  test('formatCount', () => {
    expect(formatCount(null)).toBe('n/a')
    expect(formatCount(0)).toBe('0')
    expect(formatCount(950)).toBe('950')
    expect(formatCount(1000)).toBe('1k')
    expect(formatCount(12_400)).toBe('12.4k')
    expect(formatCount(35_849)).toBe('35.8k')
    expect(formatCount(123_456)).toBe('123k')
    expect(formatCount(999_960)).toBe('1M')
    expect(formatCount(1_200_000)).toBe('1.2M')
  })

  test('formatDuration (re-exported from state) and formatAge', () => {
    expect(formatDuration(192_000)).toBe('3m 12s')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(3_725_000)).toBe('1h 02m')
    expect(formatAge(150_000)).toBe('2m')
    expect(formatAge(7_200_000)).toBe('2h')
  })

  test('tokenLines keeps three separate numbers, wrapping to two or three lines', () => {
    const t = { input: 1000, output: 3100, cacheRead: 35_800, cacheWrite: 400, requests: 3 }
    expect(tokenLines(t, false, 60)).toEqual(['new 1.4k  cached 35.8k  out 3.1k'])
    expect(tokenLines(t, false, 20)).toEqual(['new 1.4k', 'cached 35.8k', 'out 3.1k'])
    expect(tokenLines(t, false, 22)).toEqual(['new 1.4k  cached 35.8k', 'out 3.1k'])
    expect(tokenLines(null, false, 60)).toEqual(['new n/a  cached n/a  out n/a'])
    expect(tokenLines(t, true, 60)).toEqual(['new ≥1.4k  cached ≥35.8k  out ≥3.1k'])
  })

  test('shortModel is re-exported from state', () => {
    expect(shortModel('claude-opus-5-5')).toBe('opus-5-5')
    expect(shortModel(null)).toBe('model n/a')
  })

  test('clockText: HH:MM:SS (local time)', () => {
    expect(clockText(NOW)).toMatch(/^\d\d:\d\d:\d\d$/)
    expect(clockText(1_700_000_000_000)).toMatch(/^\d\d:\d\d:\d\d$/)
    // a second later is a different clock reading
    expect(clockText(NOW + 1000)).not.toBe(clockText(NOW))
  })

  test('logLines: the newest entries, oldest of those first; who cut or padded to 14', () => {
    const log = logOf(
      entry(NOW - 6000, 'phase', 'lead', 'phase → executing'),
      entry(NOW - 5000, 'spawned', 'Write state', 'spawned · Opus 5.5'),
      entry(NOW - 4000, 'spawned', 'A very long worker label here', 'spawned · Opus 5.5'),
      entry(NOW - 3000, 'done', 'Write state', 'done · 2m 03s'),
      entry(NOW - 2000, 'failed', 'Write view', 'failed: error'),
      entry(NOW - 1000, 'stopped', 'Write tool', 'stopped · 5s'),
    )
    const lines = logLines(log, 4)
    expect(lines.map(l => l.text)).toEqual(['spawned · Opus 5.5', 'done · 2m 03s', 'failed: error', 'stopped · 5s'])
    expect(lines.map(l => l.kind)).toEqual(['spawned', 'done', 'failed', 'stopped'])
    expect(lines.map(l => l.who)).toEqual(['A very long w…', 'Write state   ', 'Write view    ', 'Write tool    '])
    expect(lines.every(l => [...l.who].length === 14)).toBe(true)
    expect(lines[0]!.time).toBe(clockText(NOW - 4000))
    expect(lines.every(l => /^\d\d:\d\d:\d\d$/.test(l.time))).toBe(true)
    expect(logLines(log, 10)).toHaveLength(6)
    expect(logLines(log, 0)).toEqual([])
    expect(logLines(logOf(), 4)).toEqual([])
  })
})

// ---------------------------------------------------------------- flowProps

describe('flowProps: the worker cards', () => {
  const one = (box: AgentBox, over: Partial<ViewModel> = {}) => {
    const workers = flowProps(vmOf(board({}, [agent('main'), box]), over)).workers
    expect(workers).toHaveLength(1)
    return workers[0]!
  }

  test('starting: status running, "starting · elapsed", or just "starting" with no start time', () => {
    // a worker with no unit: tier measured from its model, line 2 warns
    expect(one(agent('w1', { status: 'starting' }))).toEqual({
      id: 'w1',
      row: 'workers',
      tier: 'opus',
      warn: true,
      label: 'Do w1',
      status: 'running',
      model: 'Opus 5.5 · no audit',
      line: 'starting · 3m 12s',
      tokens: 'in 37.2k out 3.1k',
      selected: false,
    })
    expect(one(agent('w1', { status: 'starting', startedAt: null })).line).toBe('starting')
  })

  test('running: the most recently started tool in flight, else the last tool, else "working"', () => {
    const tools = [
      { id: 'a', tool: 'Read', startedAt: NOW - 5000 },
      { id: 'b', tool: 'Bash', startedAt: NOW - 1000 },
      { id: 'c', tool: 'Grep', startedAt: NOW - 3000 },
    ]
    const w1 = agent('w1', { lastTool: 'Edit' })
    expect(one(w1, { detail: { agents: { w1: detailOf({ tools }) } } }).line).toBe('Bash · 3m 12s')
    expect(one(w1).line).toBe('Edit · 3m 12s')
    expect(one(w1, { detail: { agents: { w1: detailOf() } } }).line).toBe('Edit · 3m 12s')
    expect(one(agent('w1')).line).toBe('working · 3m 12s')
    expect(one(agent('w1', { startedAt: null })).line).toBe('working')
    expect(one(w1).status).toBe('running')
  })

  test('quiet: counts up from the last event, else the start; just "quiet" with neither', () => {
    const quiet = { quiet: { w1: true } }
    const q = one(agent('w1', { lastEventAt: NOW - 150_000, lastTool: 'Edit' }), quiet)
    expect(q.status).toBe('quiet')
    expect(q.line).toBe('quiet 2m')
    expect(one(agent('w1', { lastEventAt: null }), quiet).line).toBe('quiet 3m')
    expect(one(agent('w1', { lastEventAt: null, startedAt: null }), quiet).line).toBe('quiet')
    expect(one(agent('w1', { status: 'starting', lastEventAt: NOW - 45_000 }), quiet)).toMatchObject({ status: 'quiet', line: 'quiet 45s' })
  })

  test('waiting, done, stopped, failed', () => {
    expect(one(agent('w1', { status: 'waiting' }))).toMatchObject({ status: 'waiting', line: 'waiting · 3m 12s' })
    expect(one(agent('w1', { status: 'done', endedAt: NOW - 1000 }))).toMatchObject({ status: 'done', line: 'done · 3m 11s' })
    expect(one(agent('w1', { status: 'stopped', endedAt: NOW - 1000 }))).toMatchObject({ status: 'stopped', line: 'stopped · 3m 11s' })
    expect(one(agent('w1', { status: 'failed', endedAt: NOW - 1000, reason: 'API error 529' }))).toMatchObject({
      status: 'failed',
      line: 'failed: API error 529',
    })
    expect(one(agent('w1', { status: 'failed', endedAt: NOW - 1000 })).line).toBe('failed · 3m 11s')
    expect(one(agent('w1', { status: 'done', endedAt: NOW - 1000, startedAt: null })).line).toBe('done')
  })

  test('token text: in and out, ≥ when partial, n/a when unknown; in adds input, cache write and cache read', () => {
    expect(one(agent('w1')).tokens).toBe('in 37.2k out 3.1k')
    expect(one(agent('w1', { tokensPartial: true })).tokens).toBe('in ≥37.2k out ≥3.1k')
    expect(one(agent('w1', { tokens: null })).tokens).toBe('tokens n/a')
    const t = { input: 5_000, output: 8_100, cacheRead: 36_000, cacheWrite: 4_000, requests: 4 }
    expect(one(agent('w1', { tokens: t })).tokens).toBe('in 45k out 8.1k')
    expect(one(agent('w1', { tokens: t, tokensPartial: true })).tokens).toBe('in ≥45k out ≥8.1k')
  })

  test('a card carries its model\'s display name, or model n/a; no pinned field', () => {
    expect(one(agent('w1')).model).toBe('Opus 5.5 · no audit')
    expect(one(agent('w1', { model: 'claude-sonnet-5' })).model).toBe('Sonnet 5 · no audit')
    expect(one(agent('w1', { model: null })).model).toBe('model n/a · no audit')
    expect('pinned' in one(agent('w1'))).toBe(false)
  })

  test('selection marks only the selected card', () => {
    const b = board({}, [agent('main'), agent('w1'), agent('w2')])
    expect(flowProps(vmOf(b, { ui: { selected: 'w2' } })).workers.map(c => [c.id, c.selected])).toEqual([
      ['w1', false],
      ['w2', true],
    ])
    expect(flowProps(vmOf(b)).workers.every(c => !c.selected)).toBe(true)
  })

  test('workers in order of first appearance; the lead is never a card', () => {
    const b = board({}, [agent('w3'), agent('main'), agent('w1'), agent('w2')])
    expect(flowProps(vmOf(b)).workers.map(c => c.id)).toEqual(['w3', 'w1', 'w2'])
    expect(flowProps(vmOf(board({}, [agent('main')]))).workers).toEqual([])
  })

  test('ended workers linger a while, then leave the row', () => {
    const b = board({}, [
      agent('main'),
      agent('d1', { status: 'done', endedAt: NOW - 1000 }),
      agent('d2', { status: 'done', endedAt: NOW - 3000 }),
      agent('f1', { status: 'failed', endedAt: NOW - 7000 }),
      agent('f2', { status: 'failed', endedAt: NOW - 9000 }),
      agent('s1', { status: 'stopped', endedAt: NOW - 500 }),
      agent('r1'),
    ])
    expect(flowProps(vmOf(b)).workers.map(c => c.id)).toEqual(['d1', 'f1', 's1', 'r1'])
  })
})

describe('flowProps: the lead box', () => {
  const lead = (over: Partial<AgentBox> | null, vmOver: Partial<ViewModel> = {}) =>
    flowProps(vmOf(board({}, over === null ? [] : [agent('main', over)]), vmOver)).lead

  test('title: the lead model\'s display name, or Orchestrator when unknown', () => {
    expect(lead({ model: 'claude-fable-5-2' }).title).toBe('Fable 5.2 · main session')
    expect(lead({ model: null }).title).toBe('Orchestrator · main session')
    expect(lead({ model: '' }).title).toBe('Orchestrator · main session')
    expect(lead(null).title).toBe('Orchestrator · main session')
  })

  test('no main box: waiting, no events yet, tokens n/a', () => {
    expect(lead(null)).toEqual({ title: 'Orchestrator · main session', running: false, line: 'no events yet', tokens: 'tokens n/a' })
  })

  test('running (or starting): its latest tool in flight, else thinking; never quiet', () => {
    const tools = [
      { id: 'a', tool: 'Read', startedAt: NOW - 5000 },
      { id: 'b', tool: 'Bash', startedAt: NOW - 1000 },
      { id: 'c', tool: 'Grep', startedAt: NOW - 3000 },
    ]
    expect(lead({}, { detail: { agents: { main: detailOf({ tools }) } } })).toEqual({
      title: 'Opus 5.5 · main session',
      running: true,
      line: 'Bash',
      tokens: 'in 37.2k out 3.1k',
    })
    expect(lead({ lastTool: 'Edit' }).line).toBe('thinking')
    expect(lead({ status: 'starting' })).toMatchObject({ running: true, line: 'thinking' })
    expect(lead({}, { quiet: { main: true } }).running).toBe(true)
  })

  test('any other status is waiting; tokens as a worker\'s', () => {
    for (const status of ['waiting', 'done', 'failed', 'stopped'] as const) {
      expect(lead({ status, endedAt: NOW - 1000 })).toMatchObject({ running: false, line: 'waiting' })
    }
    expect(lead({ tokensPartial: true }).tokens).toBe('in ≥37.2k out ≥3.1k')
    expect(lead({ tokens: null }).tokens).toBe('tokens n/a')
    expect(lead({ tokens: { input: 5_000, output: 8_100, cacheRead: 36_000, cacheWrite: 4_000, requests: 4 } }).tokens).toBe('in 45k out 8.1k')
  })
})

describe('flowProps: the plan box', () => {
  test('null on a pane one row short of the fixed rows plus the plan box; there when they fit and when the height is unknown', () => {
    const b = board({}, [agent('main')])
    // no card: header, legend, lead box, the stem, return box, status line
    const fixed = ROWS.header + ROWS.legend + ROWS.lead + ROWS.noWorkers + ROWS.back + ROWS.status
    expect(flowProps(vmOf(b, { height: fixed + ROWS.plan - 1 })).plan).toBeNull()
    expect(flowProps(vmOf(b, { height: fixed + ROWS.plan })).plan).not.toBeNull()
    expect(flowProps(vmOf(b, { height: null })).plan).not.toBeNull()
  })

  test('title: the phase, with the wave only while executing; phase not set', () => {
    const title = (over: Partial<Board>) => flowProps(vmOf(board(over, []))).plan?.title
    expect(title({ phase: 'executing', wave: 2 })).toBe('PLAN · executing · wave 2')
    expect(title({ phase: 'executing', wave: null })).toBe('PLAN · executing')
    expect(title({ phase: 'testing', wave: 2 })).toBe('PLAN · testing')
    expect(title({ phase: null, wave: 2 })).toBe('PLAN · phase not set')
  })

  test('done of total units, and the running, failed and queued counts', () => {
    const vm = threeAndBlocked()
    expect(flowProps(vm).plan).toEqual({ title: 'PLAN · executing · wave 1', done: 1, total: 4, counts: 'running 2  failed 0  queued 1' })
    const b = board({ units: [unit('U1', 1), unit('U2', 1), unit('U3', 1), unit('U4', 2, ['U1', 'U2']), unit('U5', 2)] }, [
      agent('main'),
      agent('w1', { unitId: 'U1', status: 'done', endedAt: NOW - 60_000 }),
      agent('w2', { unitId: 'U2', status: 'failed', endedAt: NOW - 60_000 }),
      agent('w3', { status: 'stopped', endedAt: NOW - 60_000 }),
      agent('w4', { unitId: 'U3', status: 'starting' }),
      agent('w5', { status: 'waiting' }),
    ])
    const plan = flowProps(vmOf(b, { unitStates: { U1: 'done', U2: 'failed', U3: 'running', U4: 'blocked', U5: 'ready' } })).plan
    expect(plan).toMatchObject({ done: 1, total: 5, counts: 'running 1  failed 2  queued 2' })
    expect(flowProps(vmOf(board({}, [])))).toMatchObject({ plan: { done: 0, total: 0, counts: 'running 0  failed 0  queued 0' } })
  })

  test('counts: two spaces when they fit in the plan box (30 columns), every number kept; else one space', () => {
    expect(PLAN_INNER).toBe(30)
    const counts = flowProps(threeAndBlocked()).plan?.counts ?? ''
    expect(counts).toBe('running 2  failed 0  queued 1')
    expect([...counts].length).toBeLessThanOrEqual(PLAN_INNER)
    // ten running, ten failed, ten queued: two spaces would be 32 columns
    const many = (n: number, over: Partial<AgentBox>) => Array.from({ length: n }, (_, i) => agent(`${over.status}${i}`, over))
    const units = Array.from({ length: 10 }, (_, i) => unit(`U${i}`, 1)) // carried by no agent: queued
    const b = board({ units }, [agent('main'), ...many(10, { status: 'running' }), ...many(10, { status: 'failed', endedAt: NOW - 60_000 })])
    const wide = flowProps(vmOf(b)).plan?.counts ?? ''
    expect(wide).toMatch(/^running 10 failed \d+ queued \d+$/)
    expect(wide).toBe('running 10 failed 10 queued 10')
    expect([...wide].length).toBeLessThanOrEqual(PLAN_INNER)
  })
})

describe('flowProps: the delegate label', () => {
  test('the distinct models of the row\'s workers; plain with no workers', () => {
    expect(flowProps(vmOf(board({}, [agent('main')]))).delegate).toBe('delegate to workers')
    const b = board({}, [
      agent('main', { model: 'claude-fable-5-2' }),
      agent('w1'),
      agent('w2', { model: 'claude-sonnet-5' }),
      agent('w3'),
      agent('h1', { model: HAIKU }), // a Haiku worker: in the leads row, not the workers row
      agent('old', { model: 'claude-mythos-5', status: 'done', endedAt: NOW - 60_000 }), // left the row
    ])
    expect(flowProps(vmOf(b)).delegate).toBe('delegate to workers · Opus 5.5, Sonnet 5')
  })
})

describe('flowProps: the return box', () => {
  const back = (over: Partial<Board>, agents: AgentBox[]) => flowProps(vmOf(board(over, agents))).back

  test('title: back to the lead model, or back to lead when unknown', () => {
    expect(back({}, [agent('main', { model: 'claude-fable-5-2' })]).title).toBe('back to Fable 5.2 · lead')
    expect(back({}, [agent('main', { model: null })]).title).toBe('back to lead')
    expect(back({}, []).title).toBe('back to lead')
  })

  test('waiting on the running workers; idle when none ran', () => {
    expect(back({ phase: 'executing' }, [agent('main'), agent('w1'), agent('w2', { status: 'starting' }), agent('w3', { status: 'waiting' })])).toMatchObject({
      line: 'waiting on 2',
      active: false,
    })
    expect(back({ phase: 'executing' }, [agent('main')])).toMatchObject({ line: 'idle', active: false })
    expect(back({ phase: null }, [])).toMatchObject({ line: 'idle', active: false })
  })

  test('results in and failures counted after the base', () => {
    const ended = [agent('d1', { status: 'done', endedAt: NOW - 60_000 }), agent('d2', { status: 'done', endedAt: NOW - 60_000 }), agent('f1', { status: 'stopped', endedAt: NOW - 60_000 })]
    expect(back({ phase: 'executing' }, [agent('main'), agent('w1'), ...ended])).toMatchObject({ line: 'waiting on 1 · 2 in · 1 failed', active: false })
    // nothing running and something ended: active
    expect(back({ phase: 'executing' }, [agent('main'), ...ended])).toMatchObject({ line: 'idle · 2 in · 1 failed', active: true })
    expect(back({ phase: 'executing' }, [agent('main'), ended[2]!])).toMatchObject({ line: 'idle · 1 failed', active: true })
  })

  test('testing and review: review + verify, active; done: active', () => {
    const done = agent('d1', { status: 'done', endedAt: NOW - 60_000 })
    expect(back({ phase: 'testing' }, [agent('main'), agent('w1'), done])).toEqual({ title: 'back to Opus 5.5 · lead', line: 'review + verify · 1 in', active: true })
    expect(back({ phase: 'review' }, [agent('main')])).toMatchObject({ line: 'review + verify', active: true })
    expect(back({ phase: 'done' }, [agent('main')])).toMatchObject({ line: 'idle', active: true })
    expect(back({ phase: 'done' }, [agent('main'), agent('w1')])).toMatchObject({ line: 'waiting on 1', active: true })
  })
})

// ---------------------------------------------------------------- the leads row and the three tiers

/** A lead, an audited Haiku worker h1 (unit H1, locate) feeding W1 (opus), carried by worker w1. */
function leadsBoard(h1: Partial<AgentBox> = {}, h1Unit: Partial<Unit> = {}, more: AgentBox[] = [], over: Partial<Board> = {}): Board {
  return board({ units: [haikuUnit('H1', h1Unit), tierUnit('W1', 'opus', { wave: 2, dependsOn: ['H1'] }, 'Use the finds')], ...over }, [
    agent('main', { model: 'claude-fable-5-2' }),
    agent('h1', { model: HAIKU, unitId: 'H1', name: 'H1', label: 'Find call sites', ...h1 }),
    agent('w1', { unitId: 'W1', name: 'W1', label: 'Use the finds' }),
    ...more,
  ])
}

/** One running box of each tier, each carrying an audited unit of its tier; the Sonnet unit depends on the Haiku one. */
function threeTiers(units: Partial<Record<'H1' | 'S1' | 'O1', Partial<Unit>>> = {}): Board {
  return board(
    {
      units: [
        haikuUnit('H1', units.H1),
        tierUnit('S1', 'sonnet', { dependsOn: ['H1'], ...units.S1 }, 'Write tests'),
        tierUnit('O1', 'opus', units.O1 ?? {}, 'Design it'),
      ],
    },
    [
      agent('main', { model: 'claude-fable-5-2' }),
      agent('h1', { model: HAIKU, unitId: 'H1', label: 'Find call sites' }),
      agent('s1', { model: SONNET, unitId: 'S1', label: 'Write tests' }),
      agent('o1', { model: OPUS, unitId: 'O1', label: 'Design it' }),
    ],
  )
}

describe('flowProps: cards of each tier', () => {
  test('each tier: its row, its measured tier, line 2 with the unit\'s kind, no warning', () => {
    const p = flowProps(vmOf(threeTiers()))
    expect(p.leads.map(c => [c.id, c.row, c.tier, c.warn, c.model])).toEqual([['h1', 'leads', 'haiku', false, 'Haiku 5.5 · locate']])
    expect(p.workers.map(c => [c.id, c.row, c.tier, c.warn, c.model])).toEqual([
      ['s1', 'workers', 'sonnet', false, 'Sonnet 5.5 · implement'],
      ['o1', 'workers', 'opus', false, 'Opus 5.5 · design'],
    ])
  })

  test('an audited Haiku worker: the whole card, in the leads row; never a workers card', () => {
    const p = flowProps(vmOf(leadsBoard({ lastTool: 'Grep' })))
    expect(p.leads).toEqual([
      {
        id: 'h1',
        row: 'leads',
        tier: 'haiku',
        warn: false,
        label: 'Find call sites',
        status: 'running',
        model: 'Haiku 5.5 · locate',
        line: 'Grep · 3m 12s',
        tokens: 'in 37.2k out 3.1k',
        selected: false,
      },
    ])
    expect(p.workers.map(c => c.id)).toEqual(['w1'])
    expect(p.workers.every(c => c.row === 'workers' && c.tier === 'opus' && c.warn === false)).toBe(true)
  })

  test('no audit: no unit, a unit with no tier, or one with no audit line: "· no audit", warn', () => {
    const b = board({ units: [haikuUnit('H3', { audit: null }), unit('D1', 1, [], 'By hand', { declared: 'pending' })] }, [
      agent('main'),
      agent('h2', { model: HAIKU }),
      agent('h3', { model: 'haiku', unitId: 'H3' }),
      agent('w1', { model: SONNET, unitId: 'D1' }),
    ])
    const p = flowProps(vmOf(b))
    expect(p.leads.map(c => [c.id, c.model, c.warn])).toEqual([
      ['h2', 'Haiku 5.5 · no audit', true],
      ['h3', 'Haiku · no audit', true],
    ])
    expect(p.workers.map(c => [c.id, c.tier, c.model, c.warn])).toEqual([['w1', 'sonnet', 'Sonnet 5.5 · no audit', true]])
  })

  test('tier mismatch: "· not <unit tier>", warn; the row and tier come from the model', () => {
    const b = board({ units: [tierUnit('S1', 'sonnet'), haikuUnit('H1')] }, [
      agent('main'),
      agent('w1', { model: OPUS, unitId: 'S1' }),
      agent('w2', { model: SONNET, unitId: 'H1' }),
      agent('h1', { model: HAIKU, unitId: 'S1' }),
    ])
    const p = flowProps(vmOf(b))
    expect(p.workers.map(c => [c.id, c.row, c.tier, c.model, c.warn])).toEqual([
      ['w1', 'workers', 'opus', 'Opus 5.5 · not sonnet', true],
      ['w2', 'workers', 'sonnet', 'Sonnet 5.5 · not haiku', true],
    ])
    expect(p.leads.map(c => [c.id, c.row, c.tier, c.model, c.warn])).toEqual([['h1', 'leads', 'haiku', 'Haiku 5.5 · not sonnet', true]])
  })

  test('model unknown: the unit\'s tier stands in and decides the row; a model outside the tiers: tier null', () => {
    const b = board({ units: [haikuUnit('H1'), tierUnit('S1', 'sonnet')] }, [
      agent('main'),
      agent('h1', { model: null, unitId: 'H1' }),
      agent('s1', { model: null, unitId: 'S1' }),
      agent('x1', { model: null }),
      agent('x2', { model: 'claude-mythos-5' }),
    ])
    const p = flowProps(vmOf(b))
    expect(p.leads.map(c => [c.id, c.tier, c.model, c.warn])).toEqual([['h1', 'haiku', 'model n/a · locate', false]])
    expect(p.workers.map(c => [c.id, c.tier, c.model, c.warn])).toEqual([
      ['s1', 'sonnet', 'model n/a · implement', false],
      ['x1', null, 'model n/a · no audit', true],
      ['x2', null, 'Mythos 5 · no audit', true],
    ])
  })

  test('a unit missing the routing fields reads as a unit with no tier', () => {
    const bare = { id: 'U1', label: 'Old', wave: 1, dependsOn: [], declared: null } as unknown as Unit
    const p = flowProps(vmOf(board({ units: [bare] }, [agent('main'), agent('w1', { unitId: 'U1' })])))
    expect(p.workers.map(c => [c.tier, c.model, c.warn])).toEqual([['opus', 'Opus 5.5 · no audit', true]])
  })

  test('an audited unit with no kind (malformed): just the model name', () => {
    expect(flowProps(vmOf(leadsBoard({}, { kind: null }))).leads[0]?.model).toBe('Haiku 5.5')
  })

  test('a held leads card: its verdict and the units it feeds; it stays past its linger time', () => {
    const ended = { status: 'done' as const, endedAt: NOW - 600_000 }
    expect(flowProps(vmOf(leadsBoard(ended))).leads.map(c => [c.id, c.row, c.status, c.line])).toEqual([['h1', 'leads', 'done', 'lead · unchecked · feeds 1']])
    expect(flowProps(vmOf(leadsBoard(ended, { verdict: 'accepted' }))).leads[0]?.line).toBe('accepted · feeds 1')
    // a rejected one is not held, and has lingered out
    expect(flowProps(vmOf(leadsBoard(ended, { verdict: 'rejected' }))).leads).toEqual([])
    // checked, and the unit it feeds is done: no longer held
    const fedDone = board({ units: [haikuUnit('H1', { verdict: 'accepted' }), tierUnit('W1', 'opus', { wave: 2, dependsOn: ['H1'] })] }, [
      agent('main'),
      agent('h1', { model: HAIKU, unitId: 'H1', ...ended }),
      agent('w1', { unitId: 'W1', ...ended }),
    ])
    expect(flowProps(vmOf(fedDone)).leads).toEqual([])
    // a Haiku worker just done and not held lingers with its usual line
    const lingering = flowProps(vmOf(board({}, [agent('main'), agent('h9', { model: HAIKU, status: 'done', endedAt: NOW - 1000 })]))).leads
    expect(lingering.map(c => c.line)).toEqual(['done · 3m 11s'])
    // a done Sonnet worker whose unit has its verdict is not held (rule b is for Haiku): it lingers out
    const sonnetDone = board({ units: [tierUnit('S1', 'sonnet', { verdict: 'accepted' }), tierUnit('W1', 'opus', { dependsOn: ['S1'] })] }, [
      agent('main'),
      agent('s1', { model: SONNET, unitId: 'S1', ...ended }),
    ])
    expect(flowProps(vmOf(sonnetDone)).workers).toEqual([])
  })

  test('selection marks a leads card too', () => {
    expect(flowProps(vmOf(leadsBoard(), { ui: { selected: 'h1' } })).leads[0]?.selected).toBe(true)
  })
})

describe('flowProps: the leads and feed labels', () => {
  test('empty with no leads card', () => {
    const p = flowProps(vmOf(board({}, [agent('main'), agent('w1')])))
    expect(p).toMatchObject({ leadsLabel: '', leads: [], feed: '' })
    // a Haiku worker gone from its row: still empty
    const gone = flowProps(vmOf(board({ units: [haikuUnit('H1', { verdict: 'accepted' })] }, [agent('main'), agent('h1', { model: HAIKU, unitId: 'H1', status: 'done', endedAt: NOW - 600_000 })])))
    expect(gone).toMatchObject({ leadsLabel: '', leads: [], feed: '' })
  })

  test('leadsLabel: the distinct model names of the row (not the cards\' line 2), then "leads only"', () => {
    const b = leadsBoard({}, {}, [agent('h2', { model: HAIKU }), agent('h3', { model: 'haiku' })])
    expect(flowProps(vmOf(b)).leadsLabel).toBe('Haiku 5.5, Haiku · leads only')
    const label = flowProps(vmOf(leadsBoard())).leadsLabel
    expect(label).toBe('Haiku 5.5 · leads only')
    expect(label.toLowerCase()).not.toContain('sco' + 'ut')
  })

  test('feed: accepted, rejected and unchecked counts over the haiku units only, in that order, when above zero', () => {
    expect(flowProps(vmOf(leadsBoard())).feed).toBe('leads → lead audits → workers')
    const units = [
      haikuUnit('H1', { verdict: 'accepted' }),
      haikuUnit('H2', { verdict: 'rejected' }),
      haikuUnit('H3', { verdict: 'rejected' }),
      haikuUnit('H4'),
      haikuUnit('H5'),
      tierUnit('S1', 'sonnet', { verdict: 'accepted' }), // not a haiku unit: not counted
      tierUnit('S2', 'sonnet'),
      tierUnit('W1', 'opus', { wave: 2, dependsOn: ['H1'] }),
    ]
    const b = leadsBoard({}, {}, [], { units })
    const unitStates = { H1: 'done', H2: 'failed', H3: 'failed', H4: 'done', H5: 'running', S1: 'done', S2: 'done', W1: 'ready' } as const
    expect(flowProps(vmOf(b, { unitStates })).feed).toBe('leads → lead audits → workers · 1 accepted · 2 rejected · 1 unchecked')
    expect(flowProps(vmOf(b, { unitStates: { ...unitStates, H4: 'running' } })).feed).toBe('leads → lead audits → workers · 1 accepted · 2 rejected')
    const onlyUnchecked = leadsBoard({}, {}, [], { units: [haikuUnit('H1'), tierUnit('W1', 'opus', { dependsOn: ['H1'] })] })
    expect(flowProps(vmOf(onlyUnchecked, { unitStates: { H1: 'done' } })).feed).toBe('leads → lead audits → workers · 1 unchecked')
  })

  test('the delegate label names the workers row\'s models, not their kinds', () => {
    expect(flowProps(vmOf(threeTiers())).delegate).toBe('delegate to workers · Sonnet 5.5, Opus 5.5')
  })

  test('the lead, return box and plan counts still count the leads row', () => {
    const p = flowProps(vmOf(leadsBoard()))
    expect(p.plan?.counts).toBe('running 2  failed 0  queued 0')
    expect(p.back.line).toBe('waiting on 2')
  })
})

describe('flowProps: the plan box with the leads row', () => {
  test('counts the leads row and the stem between the rows while a leads card is shown', () => {
    expect(ROWS.leads).toBe(12)
    const withLeads = leadsBoard()
    // both rows: 1+1+5+12+1+11+4+1 = 36, so the plan box needs 42
    expect(flowProps(vmOf(withLeads, { height: 41 })).plan).toBeNull()
    expect(flowProps(vmOf(withLeads, { height: 42 })).plan).not.toBeNull()
    expect(flowProps(vmOf(withLeads, { height: null })).plan).not.toBeNull()
    const without = board({}, [agent('main'), agent('w1')])
    // workers only: 1+1+5+11+4+1 = 23, so the plan box needs 29
    expect(flowProps(vmOf(without, { height: 29 })).plan).not.toBeNull()
    expect(flowProps(vmOf(without, { height: 28 })).plan).toBeNull()
  })

  test('flowProps and paneFit agree on the plan box at every height', () => {
    for (const b of [leadsBoard(), threeTiers(), board({}, [agent('main'), agent('w1')]), board({}, [agent('main')])]) {
      for (let height = 0; height <= 60; height++) {
        const vm = vmOf(b, { height, log: SOME_LOG })
        expect(flowProps(vm).plan !== null).toBe(paneFit(vm).plan)
      }
    }
  })
})

describe('legendEntries', () => {
  test('one entry per distinct (model, tier), tiers haiku, sonnet, opus, then none; each in its colour', () => {
    const b = board({ units: [tierUnit('S9', 'sonnet')] }, [
      agent('main', { model: 'claude-fable-5-2' }),
      agent('o1'),
      agent('x1', { model: 'claude-mythos-5' }),
      agent('s1', { model: SONNET }),
      agent('h1', { model: HAIKU }),
      agent('o2'), // the same model and tier as o1: one entry
      agent('h2', { model: 'haiku', status: 'done', endedAt: NOW - 600_000 }), // gone from its row, still on the board
      agent('n1', { model: null, unitId: 'S9' }), // model unknown: the unit's tier
      agent('n2', { model: null }), // model unknown, no unit: no tier
    ])
    expect(legendEntries(b)).toEqual([
      { model: 'Haiku 5.5', tier: 'haiku', color: 'bashBorder', text: ' Haiku 5.5 · leads' },
      { model: 'Haiku', tier: 'haiku', color: 'bashBorder', text: ' Haiku · leads' },
      { model: 'Sonnet 5.5', tier: 'sonnet', color: 'ide', text: ' Sonnet 5.5 · drafts' },
      { model: 'model n/a', tier: 'sonnet', color: 'ide', text: ' model n/a · drafts' },
      { model: 'Opus 5.5', tier: 'opus', color: 'suggestion', text: ' Opus 5.5 · workers' },
      { model: 'Mythos 5', tier: null, color: 'warning', text: ' Mythos 5 · unrouted' },
      { model: 'model n/a', tier: null, color: 'warning', text: ' model n/a · unrouted' },
    ])
    expect(legendEntries(board({}, [agent('main')]))).toEqual([])
  })

  test('the tier colours', () => {
    expect(TIER_COLOR).toEqual({ haiku: 'bashBorder', sonnet: 'ide', opus: 'suggestion' })
  })
})

describe('statusParts', () => {
  test('workers counts the workers row\'s boxes; leads follows when the board has a box in the leads row', () => {
    const b = leadsBoard({}, {}, [
      agent('w2', { model: SONNET, status: 'done', endedAt: NOW - 600_000 }),
      agent('h2', { model: HAIKU, status: 'done', endedAt: NOW - 600_000 }),
    ])
    expect(statusParts(vmOf(b))).toEqual([
      { label: 'lead', value: 'working' },
      { label: 'workers', value: '1/2' },
      { label: 'leads', value: '1/2' },
      { label: 'phase', value: 'executing' },
    ])
    expect(statusParts(vmOf(threeTiers())).map(p => [p.label, p.value])).toEqual([
      ['lead', 'working'],
      ['workers', '2/2'],
      ['leads', '1/1'],
      ['phase', 'executing'],
    ])
    expect(statusParts(vmOf(board({}, [agent('main'), agent('w1'), agent('w2', { model: SONNET })]))).map(p => p.label)).toEqual(['lead', 'workers', 'phase'])
  })
})

describe('detailLines: routing', () => {
  const vm = (b: Board) => vmOf(b)
  const TOKENS = { text: 'new 1.4k  cached 35.8k  out 3.1k' }

  test('an audited Haiku worker: tier and kind in bashBorder, task, route, check, the verdict, what it feeds', () => {
    const b = threeTiers()
    expect(detailLines(vm(b), b.agents.h1!, 60).slice(0, 8)).toEqual([
      { text: `general-purpose · ${HAIKU}`, dim: true },
      { text: 'haiku · LOCATE', color: 'bashBorder' },
      { text: 'task: find the call sites of foo' },
      { text: 'route: step 2, targets pinned' },
      { text: 'check: the lead greps each one' },
      { text: 'verdict: unchecked' },
      { text: 'feeds: Write tests' },
      TOKENS,
    ])
  })

  test('an audited Sonnet worker: in ide; unchecked is a draft; then its feeders, dim', () => {
    const b = threeTiers()
    expect(detailLines(vm(b), b.agents.s1!, 60).slice(0, 8)).toEqual([
      { text: `general-purpose · ${SONNET}`, dim: true },
      { text: 'sonnet · IMPLEMENT', color: 'ide' },
      { text: 'task: find the call sites of foo' },
      { text: 'route: step 2, targets pinned' },
      { text: 'check: the lead greps each one' },
      { text: 'verdict: unchecked (draft)' },
      { text: 'fed by: Find H1 (unchecked)', dim: true },
      TOKENS,
    ])
    const accepted = threeTiers({ S1: { verdict: 'accepted' }, H1: { verdict: 'accepted' } })
    const lines = detailLines(vm(accepted), accepted.agents.s1!, 60)
    expect(lines).toContainEqual({ text: 'verdict: accepted' })
    expect(lines).toContainEqual({ text: 'fed by: Find H1 (accepted)', dim: true })
    expect(lines.some(l => l.text.includes('(draft)'))).toBe(false)
  })

  test('an audited Opus worker: in suggestion; no draft mark; its spec after the verdict, before what it feeds', () => {
    const b = threeTiers()
    expect(detailLines(vm(b), b.agents.o1!, 60).slice(1, 7)).toEqual([
      { text: 'opus · DESIGN', color: 'suggestion' },
      { text: 'task: find the call sites of foo' },
      { text: 'route: step 2, targets pinned' },
      { text: 'check: the lead greps each one' },
      { text: 'verdict: unchecked' },
      TOKENS,
    ])
    const withSpec = board({ units: [tierUnit('O1', 'opus', { spec: 'decisions.md', verdict: 'rejected' }), tierUnit('W2', 'sonnet', { dependsOn: ['O1'] }, 'Build it')] }, [
      agent('main'),
      agent('o1', { unitId: 'O1' }),
    ])
    expect(detailLines(vm(withSpec), withSpec.agents.o1!, 60).slice(5, 8)).toEqual([
      { text: 'verdict: rejected' },
      { text: 'spec: decisions.md' },
      { text: 'feeds: Build it' },
    ])
  })

  test('the audit lines, spec and feeds are cut to the inner width', () => {
    const b = board({ units: [haikuUnit('H1', { spec: 'a/very/long/path/to/spec.md' }), tierUnit('W1', 'opus', { dependsOn: ['H1'] }, 'Use the finds')] }, [
      agent('main'),
      agent('h1', { model: HAIKU, unitId: 'H1' }),
    ])
    const narrow = detailLines(vm(b), b.agents.h1!, 12).map(l => l.text)
    expect(narrow).toContain('task: find …')
    expect(narrow).toContain('route: step…')
    expect(narrow).toContain('check: the …')
    expect(narrow).toContain('spec: a/ver…')
    expect(narrow).toContain('feeds: Use …')
  })

  test('no kind: just the tier; an audit line not in four parts: no audit lines; nothing fed: no feeds line', () => {
    const b = board({ units: [haikuUnit('H1', { kind: null, audit: 'just some text' })] }, [agent('main'), agent('h1', { model: HAIKU, unitId: 'H1' })])
    expect(detailLines(vm(b), b.agents.h1!, 60).slice(1, 4)).toEqual([{ text: 'haiku', color: 'bashBorder' }, { text: 'verdict: unchecked' }, TOKENS])
  })

  test('no audit: the warning after the type · model line, and nothing else of the unit', () => {
    const b = leadsBoard({}, {}, [agent('h2', { model: HAIKU }), agent('w2', { model: SONNET })])
    for (const id of ['h2', 'w2']) {
      const box = b.agents[id]!
      expect(detailLines(vm(b), box, 60).slice(0, 3)).toEqual([
        { text: `general-purpose · ${box.model}`, dim: true },
        { text: 'no audit line (policy §9)', color: 'warning' },
        TOKENS,
      ])
    }
  })

  test('tier mismatch: the model the box ran on and the unit\'s tier, in warning', () => {
    const b = board({ units: [tierUnit('S1', 'sonnet')] }, [agent('main'), agent('w1', { unitId: 'S1' })])
    expect(detailLines(vm(b), b.agents.w1!, 60).slice(0, 3)).toEqual([
      { text: `general-purpose · ${OPUS}`, dim: true },
      { text: 'ran on Opus 5.5, unit says sonnet', color: 'warning' },
      TOKENS,
    ])
    expect(detailLines(vm(b), b.agents.w1!, 60).some(l => l.text.startsWith('task:'))).toBe(false)
  })

  test('a fed worker: its feeders with a tier and their verdicts, dim', () => {
    const b = board(
      {
        units: [
          haikuUnit('H1', { verdict: 'accepted' }),
          haikuUnit('H2'),
          unit('D0', 1, [], 'By hand', { declared: 'done' }),
          tierUnit('W1', 'opus', { wave: 2, dependsOn: ['H1', 'D0', 'H2'] }, 'Use the finds'),
        ],
      },
      [agent('main'), agent('w1', { unitId: 'W1' }), agent('w0', { unitId: 'D0' })],
    )
    const lines = detailLines(vm(b), b.agents.w1!, 60)
    expect(lines).toContainEqual({ text: 'fed by: Find H1 (accepted), Find H2 (unchecked)', dim: true })
    expect(lines.findIndex(l => l.text.startsWith('fed by'))).toBe(lines.findIndex(l => l.text.startsWith('verdict')) + 1)
    expect(detailLines(vm(b), b.agents.w1!, 20).find(l => l.text.startsWith('fed by'))?.text).toBe('fed by: Find H1 (ac…')
    expect(detailLines(vm(b), b.agents.w0!, 60).some(l => l.text.startsWith('fed by'))).toBe(false)
  })
})

// ---------------------------------------------------------------- detailLines

describe('detailLines', () => {
  const vm = (agents: AgentBox[], detail: Record<string, AgentDetail> = {}): ViewModel => vmOf(board({}, agents), { detail: { agents: detail } })

  test('type · model, the routing line, tokens, no tool calls yet, brief not captured, sizes', () => {
    const w1 = agent('w1', { briefChars: 4200 })
    expect(detailLines(vm([agent('main'), w1]), w1, 60)).toEqual([
      { text: 'general-purpose · claude-opus-5-5', dim: true },
      { text: 'no audit line (policy §9)', color: 'warning' },
      { text: 'new 1.4k  cached 35.8k  out 3.1k' },
      { text: 'no tool calls yet', dim: true },
      { text: 'brief not captured', dim: true },
      { text: 'out 4.2k · back n/a', dim: true },
    ])
  })

  test('the parent line comes first; the kind line drops empty parts', () => {
    const w1 = agent('w1', { label: 'Plan the work' })
    const w2 = agent('w2', { parentId: 'w1', model: null })
    const lines = detailLines(vm([agent('main'), w1, w2]), w2, 60)
    expect(lines[0]).toEqual({ text: '↳ Plan the work', dim: true })
    expect(lines[1]).toEqual({ text: 'general-purpose', dim: true })
    const orphan = agent('w3', { parentId: 'gone' })
    expect(detailLines(vm([orphan]), orphan, 60).some(l => l.text.startsWith('↳'))).toBe(false)
    const bare = agent('w4', { type: '', model: null })
    expect(detailLines(vm([bare]), bare, 60).slice(0, 2)).toEqual([
      { text: 'no audit line (policy §9)', color: 'warning' },
      { text: 'new 1.4k  cached 35.8k  out 3.1k' },
    ])
  })

  test('the last tool when none is in flight', () => {
    const w1 = agent('w1', { lastTool: 'Read' })
    expect(detailLines(vm([w1]), w1, 60)).toContainEqual({ text: 'last: Read', dim: true })
  })

  test('tools in flight, oldest first, at most three, then +N more', () => {
    const w1 = agent('w1', { lastTool: 'Read' })
    const tools = [
      { id: 'c', tool: 'Grep', startedAt: NOW - 5_000 },
      { id: 'a', tool: 'Bash', startedAt: NOW - 125_000 },
      { id: 'b', tool: 'Read', startedAt: NOW - 30_000 },
      { id: 'd', tool: 'Edit', startedAt: NOW - 1_000 },
      { id: 'e', tool: 'Write', startedAt: NOW - 500 },
    ]
    const lines = detailLines(vm([w1], { w1: detailOf({ tools }) }), w1, 60)
    const at = lines.findIndex(l => l.text === 'tools')
    expect(lines[at]).toEqual({ text: 'tools', bold: true })
    expect(lines.slice(at + 1, at + 5).map(l => l.text)).toEqual(['  ⚙ Bash 2m', '  ⚙ Read 30s', '  ⚙ Grep 5s', '  +2 more'])
    expect(lines.some(l => l.text.startsWith('last:'))).toBe(false)
  })

  test('the brief: whitespace collapsed, split at the inner width', () => {
    const w1 = agent('w1')
    const lines = detailLines(vm([w1], { w1: detailOf({ brief: 'aaaa bbbb\n\n  cccc dddd' }) }), w1, 10)
    const at = lines.findIndex(l => l.text === 'brief')
    expect(lines[at]).toEqual({ text: 'brief', bold: true })
    expect(lines.slice(at + 1, at + 3)).toEqual([{ text: 'aaaa bbbb ' }, { text: 'cccc dddd' }])
    expect(lines[at + 3]?.dim).toBe(true) // the sizes line follows
  })

  test('the brief: four lines at most, the last ending with … when cut', () => {
    const w1 = agent('w1')
    const long = detailLines(vm([w1], { w1: detailOf({ brief: 'x'.repeat(45) }) }), w1, 10)
    const at = long.findIndex(l => l.text === 'brief')
    expect(long.slice(at + 1, at + 5).map(l => l.text)).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxxxxxx…'])
    expect(long[at + 5]?.text).toBe('out n/a · back n/a')
    const cut = detailLines(vm([w1], { w1: detailOf({ brief: 'short', briefCut: true }) }), w1, 10)
    expect(cut.map(l => l.text)).toContain('short…')
  })
})

// ---------------------------------------------------------------- the pane

const SOME_LOG = logOf(
  entry(NOW - 9000, 'phase', 'lead', 'phase → executing'),
  entry(NOW - 8000, 'spawned', 'Write state', 'spawned · Opus 5.5'),
  entry(NOW - 7000, 'spawned', 'Write view', 'spawned · Opus 5.5'),
  entry(NOW - 6000, 'spawned', 'Write tool', 'spawned · Opus 5.5'),
  entry(NOW - 1000, 'done', 'Write state', 'done · 3m 11s'),
)

/** The number of footer lines the board gives: the note, then one line for the n/a and ≥ counts. */
function footerCount(vm: ViewModel): number {
  const boxes = Object.values(vm.board.agents)
  return (vm.board.note ? 1 : 0) + (boxes.some(b => b.tokens === null || b.tokensPartial) ? 1 : 0)
}

/** The least height (0 to 200) at which paneFit gives `kind` of log. */
function heightFor(vm: ViewModel, kind: 'full' | 'compact' | 'none'): number {
  for (let height = 0; height <= 200; height++) if (paneFit({ ...vm, height }).log === kind) return height
  throw new Error(`no height gives the ${kind} log`)
}

const bothRows = () => leadsBoard()
const leadsOnly = () => board({}, [agent('main'), agent('h1', { model: HAIKU })])
const workersOnly = () => board({}, [agent('main'), agent('w1')])
const noCards = () => board({}, [agent('main')])

/** The worked examples (no card selected, no footer lines, the five-entry log). */
const FIT_EXAMPLES: Array<{ name: string; board: () => Board; height: number | null; fit: ReturnType<typeof paneFit> }> = [
  { name: 'both rows, 42', board: bothRows, height: 42, fit: { plan: true, log: 'none', logLines: 0, footer: 0 } },
  { name: 'both rows, 43', board: bothRows, height: 43, fit: { plan: true, log: 'compact', logLines: 1, footer: 0 } },
  { name: 'both rows, 41', board: bothRows, height: 41, fit: { plan: false, log: 'compact', logLines: 2, footer: 0 } },
  { name: 'both rows, 49', board: bothRows, height: 49, fit: { plan: true, log: 'full', logLines: 4, footer: 0 } },
  { name: 'leads only, 42', board: leadsOnly, height: 42, fit: { plan: true, log: 'full', logLines: 4, footer: 0 } },
  { name: 'workers only, 30', board: workersOnly, height: 30, fit: { plan: true, log: 'compact', logLines: 1, footer: 0 } },
  { name: 'no cards, 20', board: noCards, height: 20, fit: { plan: true, log: 'compact', logLines: 1, footer: 0 } },
  { name: 'height unknown', board: bothRows, height: null, fit: { plan: true, log: 'full', logLines: 4, footer: 0 } },
]

describe('paneFit: exact row accounting', () => {
  test('the row constants', () => {
    expect(ROWS).toEqual({ header: 1, legend: 1, lead: 5, plan: 6, leads: 12, between: 1, workers: 11, noWorkers: 1, back: 4, status: 1 })
    expect(LOG_FRAME_ROWS).toBe(3)
    expect(DETAIL_FRAME_ROWS).toBe(3)
    expect(LOG_SHOWN).toBe(4)
    expect(LOG_COMPACT_SHOWN).toBe(2)
  })

  test('the worked examples', () => {
    for (const ex of FIT_EXAMPLES) {
      expect([ex.name, paneFit(vmOf(ex.board(), { height: ex.height, log: SOME_LOG }))]).toEqual([ex.name, ex.fit])
    }
  })

  test('the fixed rows per row shown: both rows 36, leads only 25, workers only 23, no cards 13', () => {
    // one row over the fixed rows is the least height with a log: the compact log of one entry, no plan box
    const fixed = (b: Board) => heightFor(vmOf(b, { log: SOME_LOG }), 'compact') - 1
    expect(fixed(bothRows())).toBe(ROWS.header + ROWS.legend + ROWS.lead + ROWS.leads + ROWS.between + ROWS.workers + ROWS.back + ROWS.status)
    expect(fixed(bothRows())).toBe(36)
    expect(fixed(leadsOnly())).toBe(25)
    expect(fixed(workersOnly())).toBe(23)
    expect(fixed(noCards())).toBe(13)
  })

  test('the selected card\'s detail strip rows are counted, and can push the plan box out', () => {
    const b = workersOnly()
    const plain = vmOf(b, { height: 29, log: SOME_LOG })
    expect(paneFit(plain)).toEqual({ plan: true, log: 'none', logLines: 0, footer: 0 })
    const selected = { ...plain, ui: { selected: 'w1' } }
    const strip = DETAIL_FRAME_ROWS + detailLines(selected, b.agents.w1!, selected.width - 4).length
    expect(paneFit(selected).plan).toBe(false)
    expect(paneFit({ ...selected, height: 29 + strip - 1 }).plan).toBe(false)
    expect(paneFit({ ...selected, height: 29 + strip })).toEqual({ plan: true, log: 'none', logLines: 0, footer: 0 })
    expect(paneFit({ ...selected, height: 29 + strip + 7 })).toEqual({ plan: true, log: 'full', logLines: 4, footer: 0 })
    // the lead is never a detail strip, nor a selected id with no box
    expect(paneFit({ ...plain, ui: { selected: 'main' } })).toEqual(paneFit(plain))
    expect(paneFit({ ...plain, ui: { selected: 'gone' } })).toEqual(paneFit(plain))
  })

  test('footer lines come last: only the rows left after the plan box and the log', () => {
    const b = board({ note: 'live counts unavailable in this build' }, [agent('main'), agent('w1', { tokens: null })])
    const vm = vmOf(b, { height: 28, log: SOME_LOG })
    // two footer lines (the note and the n/a counts), not counted in the fixed rows: 23
    expect(paneFit(vm)).toEqual({ plan: false, log: 'compact', logLines: 2, footer: 2 })
    expect(paneFit({ ...vm, height: 29 })).toEqual({ plan: true, log: 'none', logLines: 0, footer: 0 })
    expect(paneFit({ ...vm, height: 30 })).toEqual({ plan: true, log: 'compact', logLines: 1, footer: 0 })
    expect(paneFit({ ...vm, height: 31 })).toEqual({ plan: true, log: 'compact', logLines: 2, footer: 0 })
    expect(paneFit({ ...vm, height: 32 })).toEqual({ plan: true, log: 'compact', logLines: 2, footer: 1 })
    expect(paneFit({ ...vm, height: 33 })).toEqual({ plan: true, log: 'compact', logLines: 2, footer: 2 })
    expect(paneFit({ ...vm, height: 36 })).toEqual({ plan: true, log: 'full', logLines: 4, footer: 0 })
    expect(paneFit({ ...vm, height: 38 })).toEqual({ plan: true, log: 'full', logLines: 4, footer: 2 })
    // no entries: the notes take the rows after the plan box
    expect(paneFit({ ...vm, height: 30, log: logOf() })).toEqual({ plan: true, log: 'none', logLines: 0, footer: 1 })
    // height unknown: every footer line
    expect(paneFit({ ...vm, height: null })).toEqual({ plan: true, log: 'full', logLines: 4, footer: 2 })
    expect(paneFit({ ...vm, height: null, log: logOf() })).toEqual({ plan: true, log: 'none', logLines: 0, footer: 2 })
  })

  test('one footer line never pushes out the plan box or the log (both rows)', () => {
    const vm = vmOf({ ...bothRows(), note: 'live counts unavailable in this build' }, { log: SOME_LOG })
    expect(footerCount(vm)).toBe(1)
    expect(paneFit({ ...vm, height: 42 })).toEqual({ plan: true, log: 'none', logLines: 0, footer: 0 })
    expect(paneFit({ ...vm, height: 43 })).toEqual({ plan: true, log: 'compact', logLines: 1, footer: 0 })
    expect(paneFit({ ...vm, height: 44 })).toEqual({ plan: true, log: 'compact', logLines: 2, footer: 0 })
    // the full log needs 7 rows and does not fit in the 3 left
    expect(paneFit({ ...vm, height: 45 })).toEqual({ plan: true, log: 'compact', logLines: 2, footer: 1 })
    expect(paneFit({ ...vm, height: null })).toEqual({ plan: true, log: 'full', logLines: 4, footer: 1 })
  })

  test('no entries: no log at any height', () => {
    for (const b of [bothRows(), leadsOnly(), workersOnly(), noCards()]) {
      for (const height of [null, 0, 10, 20, 30, 42, 49, 80, 200]) {
        expect(paneFit(vmOf(b, { height, log: logOf() }))).toMatchObject({ log: 'none', logLines: 0 })
      }
    }
  })

  test('the compact log never shows more entries than there are', () => {
    const one = logOf(entry(NOW - 1000, 'done', 'Write state', 'done · 3m 11s'))
    // workers only, plan box in: 29; the full log of one entry needs 4
    expect(paneFit(vmOf(workersOnly(), { height: 31, log: one }))).toEqual({ plan: true, log: 'compact', logLines: 1, footer: 0 })
    expect(paneFit(vmOf(workersOnly(), { height: 33, log: one }))).toEqual({ plan: true, log: 'full', logLines: 1, footer: 0 })
  })

  test('on a pane too short even for the fixed rows: no plan box, no log', () => {
    expect(paneFit(vmOf(bothRows(), { height: 20, log: SOME_LOG }))).toEqual({ plan: false, log: 'none', logLines: 0, footer: 0 })
  })
})

/** Text nodes under `n`, nested ones included, with their text and style. */
function texts(n: any): Array<{ text: string; color: unknown; bold: unknown; dim: unknown }> {
  const out: Array<{ text: string; color: unknown; bold: unknown; dim: unknown }> = []
  walk(n, t => {
    if (t.type === 'Text') out.push({ text: textOf(t), color: t.props?.color, bold: t.props?.bold, dim: t.props?.dimColor })
  })
  return out
}

test('the sections, top to bottom with no gap: header, legend, flow, detail, log, status, footer', async ($, on) => {
  const ctx: Ctx = { vm: { ...threeAndBlocked(), ui: { selected: 'w2' }, log: SOME_LOG } }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, ctx.vm)
    const tree = await ui.drawn()
    const pane = await ui.find({ key: 'pane' })
    expect(pane?.props.gap).toBeUndefined()
    expect(pane?.props.flexDirection).toBe('column')
    expect(kids(pane).map(keyOf)).toEqual(['header', 'legend', 'flow', 'detail', 'log', 'status', 'footer'])
    const all = textOf(tree)
    expect(all).not.toMatch(/[○◉]/) // no phase stepper
    expect(all).not.toMatch(/✓ \d+ done {3}✗/) // no tally line
    if (surface === 'terminal') show(`\n--- the pane (72 columns, w2 selected, still flow, a log) ---\n${picture(tree, 72)}\n`)
    await ui.unmount()

    // with nothing selected, no log and no notes: header, legend, flow, status
    ctx.vm = vmOf(board({}, [agent('main')]))
    const bare = await mountPane($, surface, ctx.vm)
    expect(kids(await bare.find({ key: 'pane' })).map(keyOf)).toEqual(['header', 'legend', 'flow', 'status'])
    await bare.unmount()
    ctx.vm = { ...threeAndBlocked(), ui: { selected: 'w2' }, log: SOME_LOG }
  }
})

test('the header: AGENT BOARD bold, then the task; dim placeholder when none; one truncated line', async ($, on) => {
  const ctx: Ctx = { vm: vmOf(board({}, [])) }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    ctx.vm = vmOf(board({}, []))
    let ui = await mountPane($, surface, ctx.vm)
    let header = await ui.find({ key: 'header' })
    expect(header?.text).toBe('AGENT BOARD · Build the agent board mod')
    const line = kids(header)[0]
    expect(line?.type).toBe('Text')
    expect(line?.props.wrap).toBe('truncate-end')
    expect(texts(header).find(t => t.text === 'AGENT BOARD')?.bold).toBe(true)
    await ui.unmount()

    ctx.vm = vmOf(board({ task: null }))
    ui = await mountPane($, surface, ctx.vm)
    header = await ui.find({ key: 'header' })
    expect(header?.text).toBe('AGENT BOARD · no task declared')
    expect(texts(header).find(t => t.text === 'no task declared')?.dim).toBe(true)
    await ui.unmount()
  }
})

test('the legend: the lead model in claude, then one entry per (model, tier): haiku in bashBorder, sonnet in ide, opus in suggestion, unrouted in warning', async ($, on) => {
  const b = board({}, [
    agent('main', { model: 'claude-fable-5-2' }),
    agent('w1'),
    agent('w2', { model: HAIKU }),
    agent('w3'),
    agent('w4', { model: 'claude-mythos-5' }),
    agent('old', { model: 'claude-sonnet-5', status: 'done', endedAt: NOW - 600_000 }), // left the row, still on the board
    agent('h2', { model: 'haiku', status: 'done', endedAt: NOW - 600_000 }), // a Haiku worker gone from its row, still on the board
  ])
  const ctx: Ctx = { vm: vmOf(b) }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    ctx.vm = vmOf(b)
    let ui = await mountPane($, surface, ctx.vm)
    const legend = await ui.find({ key: 'legend' })
    expect(legend?.type).toBe('Box')
    expect(legend?.text).toBe('■ Fable 5.2 · lead   ■ Haiku 5.5 · leads   ■ Haiku · leads   ■ Sonnet 5 · drafts   ■ Opus 5.5 · workers   ■ Mythos 5 · unrouted')
    const squares = texts(legend).filter(t => t.text === '■')
    expect(squares.map(t => t.color)).toEqual(['claude', 'bashBorder', 'bashBorder', 'ide', 'suggestion', 'warning'])
    const named = texts(legend).filter(t => /· (lead|leads|drafts|workers|unrouted)$/.test(t.text) && !t.text.includes('■'))
    expect(named.map(t => t.text)).toEqual([' Fable 5.2 · lead', ' Haiku 5.5 · leads', ' Haiku · leads', ' Sonnet 5 · drafts', ' Opus 5.5 · workers', ' Mythos 5 · unrouted'])
    expect(legend?.text.toLowerCase()).not.toContain('sco' + 'ut')
    expect(named.every(t => t.dim === true)).toBe(true)
    expect(kids(legend)[0]?.props.wrap).toBe('truncate-end')
    await ui.unmount()

    ctx.vm = vmOf(board({}, []))
    ui = await mountPane($, surface, ctx.vm)
    expect((await ui.find({ key: 'legend' }))?.text).toBe('■ model n/a · lead')
    await ui.unmount()
  }
})

test('the flow element is used when given', async ($, on) => {
  const ctx: Ctx = { vm: threeAndBlocked(), animated: true }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, ctx.vm)
    expect((await ui.find({ key: 'flow' }))?.text).toBe('animated flow')
    expect(await ui.find({ key: 'anim-flow' })).toBeDefined()
    expect(await ui.find({ key: 'still-flow' })).toBeUndefined()
    expect(await ui.find({ key: 'slot-w2' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the still flow: lead box, plan box, worker cards and return box, stacked and left-aligned', async ($, on) => {
  const ctx: Ctx = { vm: threeAndBlocked() }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    ctx.vm = threeAndBlocked()
    let ui = await mountPane($, surface, ctx.vm)
    const still = await ui.find({ key: 'still-flow' })
    expect(still?.props).toMatchObject({ flexDirection: 'column', alignItems: 'flex-start' })
    expect(kids(still).map(keyOf)).toEqual(['still-lead', 'still-plan', 'still-row', 'still-back'])
    for (const key of ['still-lead', 'still-plan', 'still-back']) {
      expect((await ui.find({ key }))?.props).toMatchObject({ borderStyle: 'round', paddingX: 1, flexDirection: 'column' })
    }
    const p = flowProps(ctx.vm)
    expect(kids(await ui.find({ key: 'still-lead' })).map(textOf)).toEqual([p.lead.title, `${p.lead.line} · ${p.lead.tokens}`])
    expect(kids(await ui.find({ key: 'still-lead' })).map(textOf)).toEqual(['Fable 5.2 · main session', 'thinking · in 442k out 8k'])
    expect(kids(await ui.find({ key: 'still-plan' })).map(textOf)).toEqual(['PLAN · executing · wave 1', '1 of 4 units done', 'running 2  failed 0  queued 1'])
    expect(kids(await ui.find({ key: 'still-back' })).map(textOf)).toEqual(['back to Fable 5.2 · lead', 'waiting on 2 · 1 in'])
    expect(kids(kids(await ui.find({ key: 'still-row' }))[0]).map(keyOf)).toEqual(['slot-w1', 'slot-w2', 'slot-w3'])
    expect(await ui.find({ key: 'slot-main' })).toBeUndefined() // the lead is not a card
    expect(textOf(still)).not.toMatch(/[│┬┴├]/) // no rails
    await ui.unmount()

    // the fixed rows are 1+1+5+11+4+1 = 23 (w3's n/a footer line is not counted): no plan box under 29
    ctx.vm = { ...threeAndBlocked(), height: 28 }
    ui = await mountPane($, surface, ctx.vm)
    expect(kids(await ui.find({ key: 'still-flow' })).map(keyOf)).toEqual(['still-lead', 'still-row', 'still-back'])
    await ui.unmount()
    ctx.vm = { ...threeAndBlocked(), height: 29 }
    ui = await mountPane($, surface, ctx.vm)
    expect(await ui.find({ key: 'still-plan' })).toBeDefined()
    await ui.unmount()

    // no workers, no units, nothing known about the lead
    ctx.vm = vmOf(board({ phase: null, wave: null }, [agent('old', { status: 'done', endedAt: NOW - 60_000 })]))
    ui = await mountPane($, surface, ctx.vm)
    expect((await ui.find({ key: 'still-row' }))?.text).toBe('no workers running')
    expect(kids(await ui.find({ key: 'still-lead' })).map(textOf)).toEqual(['Orchestrator · main session', 'no events yet · tokens n/a'])
    expect(kids(await ui.find({ key: 'still-plan' })).map(textOf)).toEqual(['PLAN · phase not set', 'no units declared', 'running 0  failed 0  queued 0'])
    // something ended and nothing runs: the return box is lit
    const back = await ui.find({ key: 'still-back' })
    expect(kids(back).map(textOf)).toEqual(['back to lead', 'idle · 1 in'])
    expect(back?.props.borderColor).toBe('success')
    await ui.unmount()
  }
})

test('the still row: cards look like the module\'s, without the animation', async ($, on) => {
  // each worker carries an audited opus unit of its own
  const units = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map(id => tierUnit(id.toUpperCase(), 'opus'))
  const b = board({ units }, [
    agent('main'),
    agent('w1', { lastTool: 'Edit', unitId: 'W1' }),
    agent('w2', { status: 'waiting', unitId: 'W2' }),
    agent('w3', { lastEventAt: NOW - 150_000, unitId: 'W3' }),
    agent('w4', { status: 'done', endedAt: NOW - 1000, unitId: 'W4' }),
    agent('w5', { status: 'failed', endedAt: NOW - 1000, reason: 'API error 529', unitId: 'W5' }),
    agent('w6', { status: 'stopped', endedAt: NOW - 1000, unitId: 'W6' }),
  ])
  const ctx: Ctx = { vm: vmOf(b, { width: 96, quiet: { w3: true }, ui: { selected: 'w4' } }) }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, ctx.vm)
    const look = async (id: string) => {
      const card = await ui.find({ key: `slot-${id}` })
      const button = await ui.find({ key: `card-${id}` })
      const label = kids(button)[0]
      return { card, button, label, lines: kids(card).map(textOf) }
    }
    const w1 = await look('w1')
    expect(w1.lines).toEqual(['● Do w1', 'Opus 5.5 · design', 'Edit · 3m 12s', 'in 37.2k out 3.1k'])
    // a running opus card in its tier's colour
    expect(w1.card?.props).toMatchObject({ borderStyle: 'round', borderColor: 'suggestion', paddingX: 1, flexDirection: 'column' })
    expect(w1.label?.props).toMatchObject({ bold: true, color: 'suggestion' })
    expect(w1.button?.props.plain).toBe(true)
    const w2 = await look('w2')
    expect(w2.lines).toEqual(['◌ Do w2', 'Opus 5.5 · design', 'waiting · 3m 12s', 'in 37.2k out 3.1k'])
    expect(w2.card?.props).toMatchObject({ borderStyle: 'round', borderDimColor: true })
    expect(w2.label?.props.dimColor).toBe(true)
    const w3 = await look('w3')
    expect(w3.lines).toEqual(['! Do w3', 'Opus 5.5 · design', 'quiet 2m', 'in 37.2k out 3.1k'])
    expect(w3.card?.props.borderColor).toBe('warning')
    const w4 = await look('w4')
    expect(w4.lines[0]).toBe('✓ Do w4')
    expect(w4.card?.props).toMatchObject({ borderStyle: 'double', borderColor: 'success' })
    const w5 = await look('w5')
    expect(w5.lines).toEqual(['✗ Do w5', 'Opus 5.5 · design', 'failed: API error 529', 'in 37.2k out 3.1k'])
    expect(w5.card?.props).toMatchObject({ borderStyle: 'bold', borderColor: 'error' })
    const w6 = await look('w6')
    expect(w6.lines[0]).toBe('■ Do w6')
    expect(w6.label?.props.color).toBe('inactive')
    for (const id of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6']) expect((await look(id)).lines).toHaveLength(4)
    for (const id of ['w1', 'w5']) {
      const rows = kids((await look(id)).card).slice(1)
      expect(rows.every(r => r.props.dimColor === true && r.props.wrap === 'truncate-end')).toBe(true)
    }
    await ui.unmount()
  }
})

test('the still row: perLine = floor(width / 14), each card min(28, width / n)', async ($, on) => {
  const workers = (n: number) => Array.from({ length: n }, (_, i) => agent(`w${i + 1}`))
  const ctx: Ctx = { vm: vmOf(board({}, [agent('main'), ...workers(3)])) }
  hookUp(on, ctx)
  const cases: Array<[number, number, number[][]]> = [
    [72, 4, [[18, 18, 18, 18]]],
    [72, 2, [[28, 28]]],
    [72, 1, [[28]]],
    [48, 5, [[16, 16, 16], [24, 24]]],
    [20, 3, [[20], [20], [20]]],
  ]
  for (const surface of SURFACES) {
    for (const [width, n, expected] of cases) {
      ctx.vm = vmOf(board({}, [agent('main'), ...workers(n)]), { width })
      const ui = await mountPane($, surface, ctx.vm)
      const still = await ui.find({ key: 'still-row' })
      expect(kids(still).map(line => kids(line).map(c => c.props.width))).toEqual(expected)
      await ui.unmount()
    }
  }
})

test('pressing a still card calls onSelect with its id', async ($, on) => {
  const pressed: string[] = []
  const ctx: Ctx = { vm: vmOf(board({}, [agent('main'), agent('w1'), agent('w2')]), { onSelect: id => pressed.push(id) }) }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, ctx.vm)
    // the drawing hook lives in this test file, so the Button belongs to the 'test' plugin here
    await ui.press({ key: 'card-w2', plugin: 'test' })
    await ui.unmount()
  }
  expect(pressed).toEqual(['w2', 'w2'])
})

test('the detail strip shows only for a selected worker', async ($, on) => {
  const b = board({}, [agent('main'), agent('w1', { label: 'Plan the work' }), agent('w2', { label: 'Write the parser', parentId: 'w1', briefChars: 5100 })])
  const ctx: Ctx = { vm: vmOf(b) }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    for (const selected of [null, 'main', 'gone']) {
      ctx.vm = vmOf(b, { ui: { selected } })
      const ui = await mountPane($, surface, ctx.vm)
      expect(await ui.find({ key: 'detail' })).toBeUndefined()
      await ui.unmount()
    }
    ctx.vm = vmOf(b, { ui: { selected: 'w2' }, detail: { agents: { w2: detailOf({ brief: 'Write the parser for the board tool.' }) } } })
    const ui = await mountPane($, surface, ctx.vm)
    const strip = await ui.find({ key: 'detail' })
    expect(strip?.props).toMatchObject({ borderStyle: 'round', borderDimColor: true, paddingX: 1, flexDirection: 'column', width: 72 })
    const lines = kids(strip)
    expect(textOf(lines[0])).toBe('Write the parser')
    expect(lines[0]?.props.bold).toBe(true)
    expect(lines.slice(1).map(textOf)).toEqual(detailLines(ctx.vm, b.agents.w2!, 68).map(l => l.text))
    expect(lines.map(textOf)).toContain('↳ Plan the work')
    expect(lines.map(textOf)).toContain('out 5.1k · back n/a')
    await ui.unmount()
  }
})

test('the session log: the newest four, oldest first, time, who and text, coloured by kind', async ($, on) => {
  const log = logOf(
    entry(NOW - 9000, 'spawned', 'Write state', 'spawned · Opus 5.5'),
    entry(NOW - 5000, 'phase', 'lead', 'phase → testing'),
    entry(NOW - 4000, 'done', 'Write state', 'done · 2m 03s'),
    entry(NOW - 3000, 'failed', 'Write view', 'failed: error'),
    entry(NOW - 2000, 'stopped', 'Write tool', 'stopped · 5s'),
    entry(NOW - 1000, 'spawned', 'A worker with a long label', 'spawned · Haiku 5.5'),
  )
  const ctx: Ctx = { vm: vmOf(board({}, [agent('main')]), { log }) }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, ctx.vm)
    const box = await ui.find({ key: 'log' })
    expect(box?.props).toMatchObject({ borderStyle: 'round', borderDimColor: true, width: 72, flexDirection: 'column' })
    const lines = kids(box)
    expect(lines).toHaveLength(5)
    expect(textOf(lines[0])).toBe('session log')
    expect(lines[0]?.props.dimColor).toBe(true)
    const expected = logLines(log, 4)
    expect(lines.slice(1).map(textOf)).toEqual(expected.map(l => `${l.time}  ${l.who}  ${l.text}`))
    expect(lines.slice(1).map(textOf)).toEqual([
      `${clockText(NOW - 4000)}  Write state     done · 2m 03s`,
      `${clockText(NOW - 3000)}  Write view      failed: error`,
      `${clockText(NOW - 2000)}  Write tool      stopped · 5s`,
      `${clockText(NOW - 1000)}  A worker with…  spawned · Haiku 5.5`,
    ])
    expect(lines.slice(1).every(l => l.props.wrap === 'truncate-end')).toBe(true)
    const whoColors = lines.slice(1).map(l => texts(l).find(t => t.bold === true)?.color)
    expect(whoColors).toEqual(['success', 'error', 'inactive', 'suggestion'])
    expect(lines.slice(1).every(l => texts(l).find(t => /^\d\d:\d\d:\d\d$/.test(t.text))?.dim === true)).toBe(true)
    await ui.unmount()
  }
  // a phase entry's who is in claude
  ctx.vm = vmOf(board({}, [agent('main')]), { log: logOf(entry(NOW, 'phase', 'lead', 'phase → testing')) })
  const ui = await mountPane($, 'terminal', ctx.vm)
  const line = kids(await ui.find({ key: 'log' }))[1]
  expect(textOf(line)).toBe(`${clockText(NOW)}  lead            phase → testing`)
  expect(texts(line).find(t => t.bold === true)).toMatchObject({ text: 'lead          ', color: 'claude' })
  await ui.unmount()
})

test('the full session log when its rows fit after the plan box; the compact log when only that fits; neither when empty', async ($, on) => {
  // no card: 13 fixed rows, the plan box 6, the full log of four entries 7: full from 26
  const ctx: Ctx = { vm: vmOf(board({}, [agent('main')]), { log: SOME_LOG, height: 25 }) }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    ctx.vm = vmOf(board({}, [agent('main')]), { log: SOME_LOG, height: 25 })
    let ui = await mountPane($, surface, ctx.vm)
    expect(await ui.find({ key: 'log' })).toBeUndefined()
    expect(await ui.find({ key: 'log-compact' })).toBeDefined()
    await ui.unmount()
    for (const height of [26, null]) {
      ctx.vm = vmOf(board({}, [agent('main')]), { log: SOME_LOG, height })
      ui = await mountPane($, surface, ctx.vm)
      expect(await ui.find({ key: 'log' })).toBeDefined()
      expect(await ui.find({ key: 'log-compact' })).toBeUndefined()
      await ui.unmount()
    }
    for (const height of [80, 20]) {
      ctx.vm = vmOf(board({}, [agent('main')]), { log: logOf(), height })
      ui = await mountPane($, surface, ctx.vm)
      expect(await ui.find({ key: 'log' })).toBeUndefined()
      expect(await ui.find({ key: 'log-compact' })).toBeUndefined()
      await ui.unmount()
    }
  }
})

test('the compact log: the newest two, oldest first, time, who and text, coloured by kind; no border, no title', async ($, on) => {
  const log = logOf(
    entry(NOW - 4000, 'spawned', 'Write state', 'spawned · Opus 5.5'),
    entry(NOW - 3000, 'phase', 'lead', 'phase → executing'),
    entry(NOW - 2000, 'audit', 'Find call sites', 'find the call sites of foo | haiku | step 2 | the lead greps'),
    entry(NOW - 1000, 'verdict', 'Find H1', 'accepted → feeds Use the finds'),
  )
  // both rows: 36 fixed rows and the plan box 6; 44 leaves two rows, the full log needs seven
  const ctx: Ctx = { vm: vmOf(leadsBoard(), { log, height: 44 }) }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, ctx.vm)
    expect(await ui.find({ key: 'log' })).toBeUndefined()
    const box = await ui.find({ key: 'log-compact' })
    expect(box?.props).toMatchObject({ width: 72, flexDirection: 'column' })
    expect(box?.props.borderStyle).toBeUndefined()
    expect(textOf(box)).not.toContain('session log')
    const lines = kids(box)
    expect(LOG_COMPACT_SHOWN).toBe(2)
    expect(lines).toHaveLength(2)
    expect(lines.map(textOf)).toEqual(logLines(log, 2).map(l => `${l.time}  ${l.who}  ${l.text}`))
    expect(lines.map(textOf)).toEqual([
      `${clockText(NOW - 2000)}  Find call sit…  find the call sites of foo | haiku | step 2 | the lead greps`,
      `${clockText(NOW - 1000)}  Find H1         accepted → feeds Use the finds`,
    ])
    expect(lines.every(l => l.props.wrap === 'truncate-end')).toBe(true)
    expect(lines.map(l => texts(l).find(t => t.bold === true)?.color)).toEqual(['suggestion', 'claude'])
    expect(lines.every(l => texts(l).find(t => /^\d\d:\d\d:\d\d$/.test(t.text))?.dim === true)).toBe(true)
    // pane order: the compact log sits where the full log would
    expect(kids(await ui.find({ key: 'pane' })).map(keyOf)).toEqual(['header', 'legend', 'flow', 'log-compact', 'status'])
    await ui.unmount()
  }
})

test('the status line: lead, workers running of all, phase, no cost; labels dim', async ($, on) => {
  const ctx: Ctx = { vm: threeAndBlocked() }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    ctx.vm = threeAndBlocked()
    let ui = await mountPane($, surface, ctx.vm)
    let status = await ui.find({ key: 'status' })
    expect(status?.text).toBe('lead [working]   workers [2/3]   phase [executing]')
    expect(status?.text).not.toContain('$')
    expect(kids(status)[0]?.props.wrap).toBe('truncate-end')
    const parts = texts(status)
    for (const label of ['lead ', '   workers ', '   phase ']) expect(parts.find(t => t.text === label)?.dim).toBe(true)
    // the values are plain text, not inside a dim run
    for (const value of ['working', '2/3', 'executing']) expect(parts.some(t => t.text.includes(value) && t.dim === true)).toBe(false)
    await ui.unmount()

    ctx.vm = vmOf(board({ phase: null }, [agent('main', { status: 'waiting' }), agent('old', { status: 'done', endedAt: NOW - 60_000 })]))
    ui = await mountPane($, surface, ctx.vm)
    status = await ui.find({ key: 'status' })
    expect(status?.text).toBe('lead [waiting]   workers [0/1]   phase [not set]')
    await ui.unmount()
  }
})

test('the notes: the note and the n/a / ≥ counts', async ($, on) => {
  const b = board({ note: 'live counts unavailable in this build' }, [agent('main'), agent('w1', { tokens: null }), agent('w2', { tokensPartial: true })])
  const ctx: Ctx = { vm: vmOf(b) }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    let ui = await mountPane($, surface, ctx.vm)
    const footer = kids(await ui.find({ key: 'footer' }))
    expect(footer.map(textOf)).toEqual(['live counts unavailable in this build', '1 box has unavailable counts (n/a); 1 box has partial counts (≥)'])
    expect(footer.every(t => t.props.dimColor === true)).toBe(true)
    await ui.unmount()
    ctx.vm = vmOf(board({}, [agent('main')]))
    ui = await mountPane($, surface, ctx.vm)
    expect(await ui.find({ key: 'footer' })).toBeUndefined()
    await ui.unmount()
    ctx.vm = vmOf(b)
  }
})

test('the drawn pane draws exactly paneFit\'s footer lines; none: no footer box', async ($, on) => {
  const b = { ...leadsBoard(), note: 'live counts unavailable in this build' }
  const ctx: Ctx = { vm: vmOf(b, { log: SOME_LOG }) }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    for (const height of [42, 43, 44, 45, null]) {
      ctx.vm = vmOf(b, { log: SOME_LOG, height })
      const fit = paneFit(ctx.vm)
      const ui = await mountPane($, surface, ctx.vm)
      const footer = await ui.find({ key: 'footer' })
      if (fit.footer === 0) expect(footer).toBeUndefined()
      else expect(kids(footer).map(textOf)).toEqual(['live counts unavailable in this build'].slice(0, fit.footer))
      expect(fit.footer).toBe(height === 45 || height === null ? 1 : 0)
      await ui.unmount()
    }
  }
})

test('no row of the pane is wider than the pane at 20, 24, 48 and 96 columns, with the full or the compact log', async ($, on) => {
  const ctx: Ctx = { vm: threeAndBlocked() }
  hookUp(on, ctx)
  for (const [width, compact] of [20, 24, 48, 96].flatMap(w => [[w, false], [w, true]] as Array<[number, boolean]>)) {
    const base = threeAndBlocked()
    const extra = [agent('w5', { label: 'A rather long label' }), agent('w6', { status: 'waiting' }), agent('w7', { status: 'failed', endedAt: NOW - 100, reason: 'a long reason for failing' })]
    const agents = { ...base.board.agents }
    for (const a of extra) agents[a.id] = a
    ctx.vm = {
      ...base,
      board: {
        ...base.board,
        task: 'A task long enough to need cutting at narrow widths, and then some more words to be sure. '.repeat(2),
        agents,
        order: [...base.board.order, ...extra.map(a => a.id)],
        note: 'live counts unavailable in this build',
      },
      width,
      height: null,
      ui: { selected: 'w2' },
      log: SOME_LOG,
      detail: {
        agents: { w2: detailOf({ brief: 'Implement the view: header, row, detail strip and tally. '.repeat(4), tools: [{ id: 't', tool: 'Write', startedAt: NOW - 3000 }] }) },
      },
    }
    // the compact case: the least height at which paneFit gives the compact log
    if (compact) ctx.vm = { ...ctx.vm, height: heightFor(ctx.vm, 'compact') }
    const height = ctx.vm.height
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, ctx.vm)
      const tree = await ui.drawn()
      walk(tree, n => {
        if (typeof n.props?.width === 'number') expect(n.props.width).toBeLessThanOrEqual(width)
        if (/^line-\d+$/.test(keyOf(n))) {
          const sum = kids(n).reduce((a, c) => a + (c?.props?.width ?? 0), 0)
          expect(sum).toBeLessThanOrEqual(width)
        }
        if (/^(slot-|still-)/.test(keyOf(n))) {
          for (const t of kids(n)) if (t.type === 'Text') expect(t.props?.wrap).toBe('truncate-end')
        }
      })
      // every one-line section is a single truncated Text
      for (const key of ['header', 'legend', 'status']) {
        const found = await ui.find({ key })
        expect(found?.props.width).toBe(width)
        expect(kids(found)).toHaveLength(1)
        expect(kids(found)[0]?.props.wrap).toBe('truncate-end')
      }
      expect((await ui.find({ key: compact ? 'log-compact' : 'log' })) !== undefined).toBe(true)
      for (const key of ['log', 'log-compact']) for (const line of kids(await ui.find({ key }))) expect(line.props.wrap).toBe('truncate-end')
      if (surface === 'terminal') {
        const pic = picture(tree, width)
        for (const line of pic.split('\n')) expect([...line].length).toBeLessThanOrEqual(width)
        if (width === 20 || width === 96) show(`\n--- the pane (${width} columns, ${height === null ? 'full log' : 'compact log'}) ---\n${pic}\n`)
      }
      await ui.unmount()
    }
  }
})

test('the still flow with a leads row: its label, row and feed label between the plan box and the workers row', async ($, on) => {
  const b = leadsBoard({}, {}, [agent('h2', { model: HAIKU, label: 'Count the tests' })])
  const ctx: Ctx = { vm: vmOf(b, { width: 96 }) }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    ctx.vm = vmOf(b, { width: 96 })
    let ui = await mountPane($, surface, ctx.vm)
    const p = flowProps(ctx.vm)
    expect(kids(await ui.find({ key: 'still-flow' })).map(keyOf)).toEqual([
      'still-lead',
      'still-plan',
      'still-leads-label',
      'still-leads',
      'still-feed',
      'still-row',
      'still-back',
    ])
    const label = kids(await ui.find({ key: 'still-leads-label' }))
    expect(label.map(textOf)).toEqual([p.leadsLabel])
    expect(label.map(textOf)).toEqual(['Haiku 5.5 · leads only'])
    expect(label[0]?.props).toMatchObject({ dimColor: true, wrap: 'truncate-end' })
    const feed = kids(await ui.find({ key: 'still-feed' }))
    expect(feed.map(textOf)).toEqual(['leads → lead audits → workers'])
    expect(feed[0]?.props).toMatchObject({ dimColor: true, wrap: 'truncate-end' })
    expect(kids(kids(await ui.find({ key: 'still-leads' }))[0]).map(keyOf)).toEqual(['slot-h1', 'slot-h2'])
    expect(kids(kids(await ui.find({ key: 'still-row' }))[0]).map(keyOf)).toEqual(['slot-w1'])
    // a running Haiku card is in bashBorder; a running opus card in suggestion
    const h1 = await ui.find({ key: 'slot-h1' })
    expect(h1?.props.borderColor).toBe('bashBorder')
    expect(kids(await ui.find({ key: 'card-h1' }))[0]?.props.color).toBe('bashBorder')
    expect(kids(h1).map(textOf)).toEqual(['● Find call sites', 'Haiku 5.5 · locate', 'working · 3m 12s', 'in 37.2k out 3.1k'])
    expect(kids(h1)[1]?.props.dimColor).toBe(true)
    expect((await ui.find({ key: 'slot-w1' }))?.props.borderColor).toBe('suggestion')
    // a Haiku worker with no audit line: line 2 in warning, not dim
    const h2 = kids(await ui.find({ key: 'slot-h2' }))
    expect(textOf(h2[1])).toBe('Haiku 5.5 · no audit')
    expect(h2[1]?.props.color).toBe('warning')
    expect(h2[1]?.props.dimColor).toBeUndefined()
    expect(textOf(await ui.find({ key: 'still-flow' })).toLowerCase()).not.toContain('sco' + 'ut')
    await ui.unmount()

    // Haiku workers all gone from their row: no leads label, row or feed label
    ctx.vm = vmOf(board({}, [agent('main'), agent('h1', { model: HAIKU, status: 'done', endedAt: NOW - 600_000 })]))
    ui = await mountPane($, surface, ctx.vm)
    expect(kids(await ui.find({ key: 'still-flow' })).map(keyOf)).toEqual(['still-lead', 'still-plan', 'still-row', 'still-back'])
    expect((await ui.find({ key: 'still-row' }))?.text).toBe('no workers running')
    await ui.unmount()

    // only Haiku workers: the workers row says no workers running
    ctx.vm = vmOf(board({}, [agent('main'), agent('h1', { model: HAIKU })]))
    ui = await mountPane($, surface, ctx.vm)
    expect((await ui.find({ key: 'still-row' }))?.text).toBe('no workers running')
    expect(await ui.find({ key: 'slot-h1' })).toBeDefined()
    await ui.unmount()
  }
})

test('the still flow: a running card\'s colour comes from its tier; no tier draws as before; line 2 warns', async ($, on) => {
  const b = board({ units: [haikuUnit('H1'), tierUnit('S1', 'sonnet'), tierUnit('O1', 'opus'), tierUnit('M1', 'sonnet')] }, [
    agent('main'),
    agent('h1', { model: HAIKU, unitId: 'H1' }),
    agent('s1', { model: SONNET, unitId: 'S1' }),
    agent('o1', { model: OPUS, unitId: 'O1' }),
    agent('x1', { model: 'claude-mythos-5' }),
    agent('m1', { model: OPUS, unitId: 'M1' }),
  ])
  const ctx: Ctx = { vm: vmOf(b, { width: 96 }) }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, ctx.vm)
    const color = async (id: string) => (await ui.find({ key: `slot-${id}` }))?.props.borderColor
    const labelColor = async (id: string) => kids(await ui.find({ key: `card-${id}` }))[0]?.props.color
    const line2 = async (id: string) => kids(await ui.find({ key: `slot-${id}` }))[1]
    expect([await color('h1'), await color('s1'), await color('o1'), await color('x1'), await color('m1')]).toEqual(['bashBorder', 'ide', 'suggestion', 'claude', 'suggestion'])
    expect([await labelColor('h1'), await labelColor('s1'), await labelColor('o1'), await labelColor('x1')]).toEqual(['bashBorder', 'ide', 'suggestion', 'claude'])
    for (const id of ['h1', 's1', 'o1']) expect((await line2(id))?.props.dimColor).toBe(true)
    expect(textOf(await line2('x1'))).toBe('Mythos 5 · no audit')
    expect((await line2('x1'))?.props.color).toBe('warning')
    expect(textOf(await line2('m1'))).toBe('Opus 5.5 · not sonnet')
    expect((await line2('m1'))?.props.color).toBe('warning')
    await ui.unmount()
  }
})

test('the drawn log matches paneFit: full, compact with exactly its lines, or none; the status line always drawn', async ($, on) => {
  const ctx: Ctx = { vm: vmOf(leadsBoard(), { log: SOME_LOG }) }
  hookUp(on, ctx)
  for (const animated of [false, true]) {
    ctx.animated = animated
    for (const surface of SURFACES) {
      for (const ex of FIT_EXAMPLES) {
        ctx.vm = vmOf(ex.board(), { log: SOME_LOG, height: ex.height })
        const fit = paneFit(ctx.vm)
        expect(fit).toEqual(ex.fit)
        const ui = await mountPane($, surface, ctx.vm)
        const full = await ui.find({ key: 'log' })
        const compact = await ui.find({ key: 'log-compact' })
        expect(full !== undefined).toBe(fit.log === 'full')
        expect(compact !== undefined).toBe(fit.log === 'compact')
        if (fit.log === 'full') expect(kids(full).slice(1).map(textOf)).toEqual(logLines(SOME_LOG, fit.logLines).map(l => `${l.time}  ${l.who}  ${l.text}`))
        if (fit.log === 'compact') expect(kids(compact).map(textOf)).toEqual(logLines(SOME_LOG, fit.logLines).map(l => `${l.time}  ${l.who}  ${l.text}`))
        expect(await ui.find({ key: 'status' })).toBeDefined()
        if (!animated) expect((await ui.find({ key: 'still-plan' })) !== undefined).toBe(fit.plan)
        await ui.unmount()
      }
    }
  }
})

test('the status line with a leads row: workers then leads', async ($, on) => {
  const ctx: Ctx = { vm: vmOf(leadsBoard()) }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    ctx.vm = vmOf(leadsBoard())
    let ui = await mountPane($, surface, ctx.vm)
    let status = await ui.find({ key: 'status' })
    expect(status?.text).toBe('lead [working]   workers [1/1]   leads [1/1]   phase [executing]')
    expect(texts(status).find(t => t.text === '   leads ')?.dim).toBe(true)
    await ui.unmount()

    // all three tiers: sonnet and opus in workers, haiku in leads
    ctx.vm = vmOf(threeTiers())
    ui = await mountPane($, surface, ctx.vm)
    status = await ui.find({ key: 'status' })
    expect(status?.text).toBe('lead [working]   workers [2/2]   leads [1/1]   phase [executing]')
    await ui.unmount()

    // no box in the leads row: no leads part
    ctx.vm = vmOf(board({}, [agent('main'), agent('s1', { model: SONNET })]))
    ui = await mountPane($, surface, ctx.vm)
    status = await ui.find({ key: 'status' })
    expect(status?.text).toBe('lead [working]   workers [1/1]   phase [executing]')
    await ui.unmount()
  }
})

test('the detail strip for a selected card of each tier: its tier line in the tier\'s colour', async ($, on) => {
  const b = threeTiers()
  const ctx: Ctx = { vm: vmOf(b, { ui: { selected: 'h1' } }) }
  hookUp(on, ctx)
  const cases: Array<[string, string, string]> = [
    ['h1', 'haiku · LOCATE', 'bashBorder'],
    ['s1', 'sonnet · IMPLEMENT', 'ide'],
    ['o1', 'opus · DESIGN', 'suggestion'],
  ]
  for (const surface of SURFACES) {
    for (const [id, tierLine, color] of cases) {
      ctx.vm = vmOf(b, { ui: { selected: id } })
      const ui = await mountPane($, surface, ctx.vm)
      const lines = kids(await ui.find({ key: 'detail' }))
      expect(textOf(lines[0])).toBe(b.agents[id]!.label)
      expect(lines.slice(1).map(textOf)).toEqual(detailLines(ctx.vm, b.agents[id]!, 68).map(l => l.text))
      expect(lines.find(l => textOf(l) === tierLine)?.props.color).toBe(color)
      expect(lines.find(l => textOf(l) === tierLine)?.props.color).toBe(TIER_COLOR[id === 'h1' ? 'haiku' : id === 's1' ? 'sonnet' : 'opus'])
      await ui.unmount()
    }
    // no audit line: the warning, in warning
    ctx.vm = vmOf(board({}, [agent('main'), agent('w1')]), { ui: { selected: 'w1' } })
    const ui = await mountPane($, surface, ctx.vm)
    const warn = kids(await ui.find({ key: 'detail' })).find(l => textOf(l) === 'no audit line (policy §9)')
    expect(warn?.props.color).toBe('warning')
    await ui.unmount()
  }
})

test('the session log: audit and verdict entries\' who in suggestion and claude', async ($, on) => {
  const log = logOf(
    entry(NOW - 2000, 'audit', 'Find call sites', 'find the call sites of foo | haiku | step 2 | the lead greps'),
    entry(NOW - 1000, 'verdict', 'Find H1', 'accepted → feeds Use the finds'),
  )
  const ctx: Ctx = { vm: vmOf(board({}, [agent('main')]), { log }) }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, ctx.vm)
    const lines = kids(await ui.find({ key: 'log' })).slice(1)
    expect(lines.map(l => texts(l).find(t => t.bold === true)?.color)).toEqual(['suggestion', 'claude'])
    expect(textOf(lines[1])).toBe(`${clockText(NOW - 1000)}  Find H1         accepted → feeds Use the finds`)
    await ui.unmount()
  }
})

test('no row of the pane is wider than the pane with all three tiers on it, at 20, 24, 48 and 96 columns', async ($, on) => {
  const ctx: Ctx = { vm: vmOf(leadsBoard()) }
  hookUp(on, ctx)
  const longAudit = 'locate every call site of the parser across the whole tree | haiku | step 2: the targets and the output format are pinned | the lead greps each location before use'
  for (const width of [20, 24, 48, 96]) {
    const b = leadsBoard(
      { label: 'Find the call sites' },
      { audit: longAudit, spec: 'docs/a/rather/long/path/to/the/approved/spec/for/this/unit.md' },
      [
        agent('h2', { model: HAIKU, label: 'A Haiku worker with no audit' }),
        agent('h3', { model: HAIKU, unitId: 'H3', status: 'done', endedAt: NOW - 600_000 }),
        agent('s1', { model: SONNET, unitId: 'S1', label: 'Write the tests for it' }),
        agent('m1', { model: OPUS, unitId: 'M1', label: 'Mismatched tier here' }),
        agent('x1', { model: 'claude-mythos-5', label: 'A rather long label' }),
      ],
      {
        task: 'A task long enough to need cutting at narrow widths, and then some more words to be sure. '.repeat(2),
        units: [
          haikuUnit('H1', { audit: longAudit, spec: 'docs/a/rather/long/path/to/the/approved/spec/for/this/unit.md' }),
          haikuUnit('H3', { kind: 'inventory' }),
          tierUnit('S1', 'sonnet', { dependsOn: ['H1', 'H3'] }, 'Write the tests for the finds'),
          tierUnit('M1', 'sonnet', {}, 'Mismatched'),
          tierUnit('W1', 'opus', { wave: 2, dependsOn: ['H1', 'H3'] }, 'Use the finds from the leads row'),
        ],
        note: 'live counts unavailable in this build',
      },
    )
    for (const selected of ['h1', 's1', 'w1', 'm1', 'x1']) {
      ctx.vm = vmOf(b, { width, ui: { selected }, log: SOME_LOG, unitStates: { H1: 'running', H3: 'done', S1: 'running', M1: 'running', W1: 'blocked' } })
      for (const surface of SURFACES) {
        const ui = await mountPane($, surface, ctx.vm)
        const tree = await ui.drawn()
        expect(await ui.find({ key: 'still-leads' })).toBeDefined()
        walk(tree, n => {
          if (typeof n.props?.width === 'number') expect(n.props.width).toBeLessThanOrEqual(width)
          if (/^line-\d+$/.test(keyOf(n))) {
            const sum = kids(n).reduce((a, c) => a + (c?.props?.width ?? 0), 0)
            expect(sum).toBeLessThanOrEqual(width)
          }
          if (/^(slot-|still-)/.test(keyOf(n))) {
            for (const t of kids(n)) if (t.type === 'Text') expect(t.props?.wrap).toBe('truncate-end')
          }
        })
        for (const key of ['header', 'legend', 'status']) {
          const found = await ui.find({ key })
          expect(found?.props.width).toBe(width)
          expect(kids(found)).toHaveLength(1)
          expect(kids(found)[0]?.props.wrap).toBe('truncate-end')
        }
        for (const line of kids(await ui.find({ key: 'detail' }))) expect(line.props.wrap).toBe('truncate-end')
        if (surface === 'terminal') {
          const pic = picture(tree, width)
          for (const line of pic.split('\n')) expect([...line].length).toBeLessThanOrEqual(width)
          if (selected === 'h1' && (width === 24 || width === 96)) show(`\n--- the pane with three tiers (${width} columns, h1 selected) ---\n${pic}\n`)
        }
        await ui.unmount()
      }
    }
  }
})

test('the band: phase, running/total, the three summed numbers and /board', async ($, on) => {
  const vm = threeAndBlocked()
  const ctx: Ctx = { vm }
  hookUp(on, ctx)
  // main + w1 + w2 known, w3 null: the sum is a floor, shown with ≥
  expect(bandText(vm)).toBe(
    'Agent Board  [executing · wave 1]  ● 2/3 running  new ≥34.9k  cached ≥482k  out ≥14.2k  · /board to open',
  )
  expect(bandText(vmOf(board({ phase: null }, [])))).toBe('Agent Board  phase not set  ● 0/0 running  new n/a  cached n/a  out n/a  · /board to open')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'flowestra',
      component: 'AbovePrompt',
      requestId: 'flowestra',
      surface,
      props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
    })
    expect((await ui.find({ key: 'band' }))?.text).toBe(bandText(vm))
    await ui.unmount()
  }
})

// ---------------------------------------------------------------- workstreams (0.7.0)

function slot(taskId: string, task: string | null, over: Partial<TaskSlot> = {}): TaskSlot {
  return { taskId, task, repo: '/work/repo', phase: 'executing', wave: 1, units: [], status: 'open', activeAt: 0, ...over }
}

/** Task `wb-ui` active (title "Workbench UI") with a lead; `parked` other open tasks; `agents` after the lead. */
function taskBoard(parked: TaskSlot[], agents: AgentBox[] = [], over: Partial<Board> = {}): Board {
  return board({ taskId: 'wb-ui', repo: '/work/repo', task: 'Workbench UI', parked, ...over }, [agent('main', { model: 'claude-fable-5-2' }), ...agents])
}

const ROUTED_OPUS = { tier: 'opus' as const, kind: 'design' as const, audit: auditFor('opus') }

/** wb-ui active with a running opus worker of its own, and a running Haiku worker of the parked task ab-journal (unit J1, in that task's list). */
function twoTasks(): Board {
  const j1 = haikuUnit('J1', {}, 'Find journal calls')
  return taskBoard(
    [slot('ab-journal', 'Journal work', { units: [j1] }), slot('cr-fix', null)],
    [
      agent('o1', { unitId: 'U1', taskId: 'wb-ui', label: 'Write view', routed: ROUTED_OPUS }),
      agent('j1', { model: HAIKU, unitId: 'J1', taskId: 'ab-journal', label: 'Find journal calls', routed: { tier: 'haiku', kind: 'locate', audit: auditFor('haiku') } }),
    ],
    { units: [tierUnit('U1', 'opus', {}, 'Write view')] },
  )
}

describe('cards of another task', () => {
  test('line 2 is "<model> · ⇄ <task>" in place of the kind, never a warning; the active task\'s card is as before', () => {
    const p = flowProps(vmOf(twoTasks()))
    expect(p.leads.map(c => [c.id, c.model, c.warn, c.tier])).toEqual([['j1', 'Haiku 5.5 · ⇄ ab-journal', false, 'haiku']])
    expect(p.workers.map(c => [c.id, c.model, c.warn])).toEqual([['o1', 'Opus 5.5 · design', false]])
  })

  test('a card of another task never warns, even with no audit or another tier than recorded', () => {
    const none = taskBoard([slot('ab-journal', 'Journal work')], [agent('x1', { taskId: 'ab-journal', routed: null })])
    expect(flowProps(vmOf(none)).workers.map(c => [c.model, c.warn])).toEqual([['Opus 5.5 · ⇄ ab-journal', false]])
    const mismatch = taskBoard([slot('ab-journal', 'Journal work')], [agent('x1', { taskId: 'ab-journal', routed: { tier: 'sonnet', kind: 'tests', audit: auditFor('sonnet') } })])
    expect(flowProps(vmOf(mismatch)).workers.map(c => [c.model, c.warn])).toEqual([['Opus 5.5 · ⇄ ab-journal', false]])
  })

  test('an ended card of another task has left its row', () => {
    const b = taskBoard([slot('ab-journal', 'Journal work')], [agent('x1', { taskId: 'ab-journal', status: 'done', endedAt: NOW - 600_000 })])
    expect(flowProps(vmOf(b)).workers).toEqual([])
  })

  test('the detail strip gains "task: <id> · <title>" (dim) right after the type · model line; "no title" when null; none for the active task', () => {
    const b = twoTasks()
    const j1 = b.agents.j1!
    const lines = detailLines(vmOf(b), j1, 60)
    expect(lines[0]).toEqual({ text: 'general-purpose · claude-haiku-5-5-20261001', dim: true })
    expect(lines[1]).toEqual({ text: 'task: ab-journal · Journal work', dim: true })
    expect(lines.map(l => l.text).filter(t => t.startsWith('task: '))).toContain('task: ab-journal · Journal work')
    const untitled = taskBoard([slot('cr-fix', null)], [agent('c1', { taskId: 'cr-fix' })])
    expect(detailLines(vmOf(untitled), untitled.agents.c1!, 60)[1]).toEqual({ text: 'task: cr-fix · no title', dim: true })
    // the active task's own card: no such line
    expect(detailLines(vmOf(b), b.agents.o1!, 60).some(l => l.text.startsWith('task: ') && l.dim === true && l.text.includes(' · Workbench'))).toBe(false)
    // cut to the inner width
    expect([...(detailLines(vmOf(b), j1, 12)[1]?.text ?? '')].length).toBeLessThanOrEqual(12)
  })
})

describe('a card\'s kind after its unit left the list', () => {
  test('the kind recorded at spawn (routed) is shown, never "no audit"; with no routed and no unit: no audit', () => {
    const gone = taskBoard([], [agent('o1', { unitId: 'GONE', taskId: 'wb-ui', routed: { tier: 'opus', kind: 'debug', audit: auditFor('opus') } })])
    expect(flowProps(vmOf(gone)).workers.map(c => [c.model, c.warn])).toEqual([['Opus 5.5 · debug', false]])
    const unrouted = taskBoard([], [agent('o1', { unitId: 'GONE', taskId: 'wb-ui' })])
    expect(flowProps(vmOf(unrouted)).workers.map(c => [c.model, c.warn])).toEqual([['Opus 5.5 · no audit', true]])
  })

  test('while the unit is found, its kind wins', () => {
    const b = taskBoard([], [agent('o1', { unitId: 'U1', taskId: 'wb-ui', routed: { tier: 'opus', kind: 'debug', audit: auditFor('opus') } })], { units: [tierUnit('U1', 'opus', { kind: 'design' })] })
    expect(flowProps(vmOf(b)).workers[0]?.model).toBe('Opus 5.5 · design')
  })

  test('a tier other than the recorded one still warns, naming the recorded tier', () => {
    const b = taskBoard([], [agent('o1', { unitId: 'GONE', taskId: 'wb-ui', routed: { tier: 'sonnet', kind: 'tests', audit: auditFor('sonnet') } })])
    expect(flowProps(vmOf(b)).workers.map(c => [c.model, c.warn])).toEqual([['Opus 5.5 · not sonnet', true]])
  })
})

describe('held cards (B3.3): line 4', () => {
  const ended = { status: 'done' as const, endedAt: NOW - 600_000 }
  const held = (b: Board, row: 'leads' | 'workers') => (row === 'leads' ? flowProps(vmOf(b)).leads : flowProps(vmOf(b)).workers).map(c => [c.id, c.status, c.line])

  test('a Haiku lead with no verdict: "lead · unchecked", plus " · feeds N" when it feeds units', () => {
    const feeding = taskBoard([], [agent('h1', { model: HAIKU, unitId: 'H1', taskId: 'wb-ui', ...ended })], {
      units: [haikuUnit('H1'), tierUnit('W1', 'opus', { wave: 2, dependsOn: ['H1'] }), tierUnit('W2', 'opus', { wave: 2, dependsOn: ['H1'] })],
    })
    expect(held(feeding, 'leads')).toEqual([['h1', 'done', 'lead · unchecked · feeds 2']])
    const alone = taskBoard([], [agent('h1', { model: HAIKU, unitId: 'H1', taskId: 'wb-ui', ...ended })], { units: [haikuUnit('H1')] })
    expect(held(alone, 'leads')).toEqual([['h1', 'done', 'lead · unchecked']])
  })

  test('a Sonnet draft with no verdict: "draft · unchecked"', () => {
    const b = taskBoard([], [agent('s1', { model: SONNET, unitId: 'S1', taskId: 'wb-ui', ...ended })], { units: [tierUnit('S1', 'sonnet')] })
    expect(held(b, 'workers')).toEqual([['s1', 'done', 'draft · unchecked']])
    const checked = taskBoard([], [agent('s1', { model: SONNET, unitId: 'S1', taskId: 'wb-ui', ...ended })], { units: [tierUnit('S1', 'sonnet', { verdict: 'accepted' })] })
    expect(held(checked, 'workers')).toEqual([])
  })

  test('a Haiku lead with a verdict, held because a unit it feeds is unfinished: "<verdict> · feeds N"', () => {
    const b = taskBoard([], [agent('h1', { model: HAIKU, unitId: 'H1', taskId: 'wb-ui', ...ended })], {
      units: [haikuUnit('H1', { verdict: 'accepted' }), tierUnit('W1', 'opus', { wave: 2, dependsOn: ['H1'] })],
    })
    expect(held(b, 'leads')).toEqual([['h1', 'done', 'accepted · feeds 1']])
  })

  test('a held card of another task is not held: it has left its row', () => {
    const b = taskBoard([slot('ab-journal', 'Journal work', { units: [haikuUnit('H1')] })], [agent('h1', { model: HAIKU, unitId: 'H1', taskId: 'ab-journal', ...ended })])
    expect(held(b, 'leads')).toEqual([])
  })
})

describe('counts per task', () => {
  test('statusParts counts only the active task\'s boxes', () => {
    const b = twoTasks()
    expect(statusParts(vmOf(b)).map(p => [p.label, p.value])).toEqual([
      ['lead', 'working'],
      ['workers', '1/1'],
      ['phase', 'executing'],
    ])
    // a leads box of the active task brings the leads count back, still without the other task's
    const withLead = taskBoard([slot('ab-journal', 'Journal work')], [
      agent('h1', { model: HAIKU, taskId: 'wb-ui' }),
      agent('h2', { model: HAIKU, taskId: 'ab-journal' }),
      agent('h3', { model: HAIKU, taskId: 'ab-journal' }),
    ])
    expect(statusParts(vmOf(withLead)).map(p => [p.label, p.value])).toContainEqual(['leads', '1/1'])
  })

  test('bandText: the task id first; running/total of the active task; whole-session token sums', () => {
    const b = twoTasks()
    const sum = bandText(vmOf(b))
    expect(sum).toBe('Agent Board  wb-ui  [executing · wave 1]  ● 1/1 running  new 4.2k  cached 107k  out 9.3k  · /board to open')
    expect(bandText(vmOf(board({ phase: null }, [])))).toBe('Agent Board  phase not set  ● 0/0 running  new n/a  cached n/a  out n/a  · /board to open')
  })

  test('the plan box and the return box count the active task only', () => {
    const p = flowProps(vmOf(twoTasks()))
    expect(p.plan?.counts).toBe('running 1  failed 0  queued 0')
    expect(p.back.line).toBe('waiting on 1')
    const idle = flowProps(vmOf(taskBoard([slot('ab-journal', 'Journal work')], [agent('j1', { taskId: 'ab-journal' })])))
    expect(idle.back.line).toBe('idle')
  })
})

describe('the legend over shownBoxes', () => {
  test('the active task\'s boxes and the live boxes of another task; an ended box of another task is left out', () => {
    const b = taskBoard([slot('ab-journal', 'Journal work')], [
      agent('o1', { taskId: 'wb-ui', status: 'done', endedAt: NOW - 600_000 }), // active task, ended: still counted
      agent('h1', { model: HAIKU, taskId: 'ab-journal' }), // live, other task: counted
      agent('s1', { model: SONNET, taskId: 'ab-journal', status: 'done', endedAt: NOW - 600_000 }), // ended, other task: left out
    ])
    expect(legendEntries(b).map(e => e.text)).toEqual([' Haiku 5.5 · leads', ' Opus 5.5 · workers'])
  })
})

test('the header with a task open: AGENT BOARD, the id, the other tasks and those running, then the title', async ($, on) => {
  const ctx: Ctx = { vm: vmOf(taskBoard([])) }
  hookUp(on, ctx)
  const open = (extra: AgentBox[]) => taskBoard([slot('ab-journal', 'Journal work'), slot('cr-fix', null)], extra)
  const cases: Array<[Board, string]> = [
    [taskBoard([]), 'AGENT BOARD · wb-ui · Workbench UI'],
    [taskBoard([slot('ab-journal', 'Journal work')]), 'AGENT BOARD · wb-ui +1 · Workbench UI'],
    [open([]), 'AGENT BOARD · wb-ui +2 · Workbench UI'],
    [open([agent('j1', { taskId: 'ab-journal' })]), 'AGENT BOARD · wb-ui +2 (1 running) · Workbench UI'],
    [open([agent('j1', { taskId: 'ab-journal', status: 'done', endedAt: NOW - 600_000 })]), 'AGENT BOARD · wb-ui +2 · Workbench UI'],
    [{ ...open([agent('j1', { taskId: 'ab-journal' })]), task: null }, 'AGENT BOARD · wb-ui +2 (1 running) · no task declared'],
  ]
  for (const surface of SURFACES) {
    for (const [b, text] of cases) {
      ctx.vm = vmOf(b)
      const ui = await mountPane($, surface, ctx.vm)
      const header = await ui.find({ key: 'header' })
      expect(header?.text).toBe(text)
      expect(kids(header)).toHaveLength(1)
      expect(kids(header)[0]?.props.wrap).toBe('truncate-end')
      expect(texts(header).find(t => t.text === 'AGENT BOARD')?.bold).toBe(true)
      if (b.task === null) expect(texts(header).find(t => t.text === 'no task declared')?.dim).toBe(true)
      await ui.unmount()
    }
  }
})

test('the header: a long title is truncated within the one row; the count stays before it', async ($, on) => {
  const long = 'A title long enough to need cutting at narrow widths, and then some more words. '.repeat(3)
  const ctx: Ctx = { vm: vmOf(taskBoard([slot('ab-journal', 'Journal work'), slot('cr-fix', null)], [agent('j1', { taskId: 'ab-journal' })], { task: long })) }
  hookUp(on, ctx)
  for (const width of [20, 24, 48, 96]) {
    ctx.vm = { ...ctx.vm, width }
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, ctx.vm)
      const header = await ui.find({ key: 'header' })
      expect(header?.props.width).toBe(width)
      expect(header?.text.startsWith('AGENT BOARD · wb-ui +2 (1 running) · ')).toBe(true)
      expect(kids(header)).toHaveLength(1)
      expect(kids(header)[0]?.props.wrap).toBe('truncate-end')
      if (surface === 'terminal') {
        const rows = picture(await ui.drawn(), width).split('\n')
        expect(rows[0] !== undefined && [...rows[0]].length <= width).toBe(true)
        expect(rows[0]?.startsWith('AGENT BOARD')).toBe(true)
        // the header is one row: the legend is the next
        expect(rows[1]?.startsWith('■')).toBe(true)
      }
      await ui.unmount()
    }
  }
})

test('the drawn pane with two tasks open: the other task\'s card line 2 and the legend; no row wider than the pane at 20, 24, 48 and 96 columns', async ($, on) => {
  const base = twoTasks()
  const ctx: Ctx = { vm: vmOf(base) }
  hookUp(on, ctx)
  for (const width of [20, 24, 48, 96]) {
    ctx.vm = vmOf(
      { ...base, task: 'A task long enough to need cutting at narrow widths, and then some more words to be sure. '.repeat(2), note: 'live counts unavailable in this build' },
      { width, height: null, ui: { selected: 'j1' }, log: SOME_LOG },
    )
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, ctx.vm)
      const tree = await ui.drawn()
      walk(tree, n => {
        if (typeof n.props?.width === 'number') expect(n.props.width).toBeLessThanOrEqual(width)
        if (/^line-\d+$/.test(keyOf(n))) {
          const sum = kids(n).reduce((a, c) => a + (c?.props?.width ?? 0), 0)
          expect(sum).toBeLessThanOrEqual(width)
        }
      })
      for (const key of ['header', 'legend', 'status']) {
        const found = await ui.find({ key })
        expect(found?.props.width).toBe(width)
        expect(kids(found)).toHaveLength(1)
        expect(kids(found)[0]?.props.wrap).toBe('truncate-end')
      }
      expect((await ui.find({ key: 'status' }))?.text.startsWith('lead [working]   workers [1/1]')).toBe(true)
      if (surface === 'terminal') {
        const pic = picture(tree, width)
        for (const line of pic.split('\n')) expect([...line].length).toBeLessThanOrEqual(width)
        if (width === 48) {
          expect(pic).toContain('⇄ ab-journal')
          show(`\n--- two tasks (${width} columns) ---\n${pic}\n`)
        }
      }
      await ui.unmount()
    }
  }
})

test('the band opens with the task id when one is open (mounted)', async ($, on) => {
  const vm = vmOf(twoTasks())
  hookUp(on, { vm })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'flowestra',
      component: 'AbovePrompt',
      requestId: 'flowestra',
      surface,
      props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
    })
    expect((await ui.find({ key: 'band' }))?.text.startsWith('Agent Board  wb-ui  [executing')).toBe(true)
    await ui.unmount()
  }
})

// ---------------------------------------------------------------- a worker model switched off (0.10.0)

describe('a substituted run (routed.ranOn differs from the unit\'s tier)', () => {
  const routedOn = (tier: Tier, ranOn: Tier) => ({ tier, kind: DEFAULT_KIND[tier], audit: auditFor(tier), ranOn })

  test('opus work on Sonnet: workers row, tier opus, line 2 "opus→Sonnet 5.5 · design"', () => {
    const b = board({ units: [tierUnit('O1', 'opus')] }, [
      agent('main'),
      agent('o1', { model: SONNET, unitId: 'O1', routed: routedOn('opus', 'sonnet') }),
    ])
    const c = flowProps(vmOf(b)).workers.find(w => w.id === 'o1')!
    expect({ row: c.row, tier: c.tier, model: c.model, warn: c.warn }).toEqual({ row: 'workers', tier: 'opus', model: 'opus→Sonnet 5.5 · design', warn: false })
  })

  test('haiku work on Sonnet stays in the leads row, tier haiku, line 2 "haiku→Sonnet 5.5 · locate"', () => {
    const b = board({ units: [haikuUnit('H1')] }, [
      agent('main'),
      agent('h1', { model: SONNET, unitId: 'H1', routed: routedOn('haiku', 'sonnet') }),
    ])
    const c = flowProps(vmOf(b)).leads.find(w => w.id === 'h1')!
    expect({ row: c.row, tier: c.tier, model: c.model, warn: c.warn }).toEqual({ row: 'leads', tier: 'haiku', model: 'haiku→Sonnet 5.5 · locate', warn: false })
  })

  test('the detail strip says which model it ran on', () => {
    const b = board({ units: [tierUnit('O1', 'opus')] }, [
      agent('main'),
      agent('o1', { model: SONNET, unitId: 'O1', routed: routedOn('opus', 'sonnet') }),
    ])
    const lines = detailLines(vmOf(b), b.agents.o1!, 60)
    expect(lines.map(l => l.text)).toContain('on Sonnet 5.5: Opus was switched off')
    expect(lines[1]).toEqual({ text: 'opus · DESIGN', color: 'suggestion' })
    expect(lines[2]).toEqual({ text: 'on Sonnet 5.5: Opus was switched off' })
  })

  test('the legend names the tier of the work: " Sonnet 5.5 · opus workers" in the opus colour', () => {
    const b = board({ units: [tierUnit('O1', 'opus')] }, [
      agent('main'),
      agent('o1', { model: SONNET, unitId: 'O1', routed: routedOn('opus', 'sonnet') }),
    ])
    expect(legendEntries(b)).toEqual([{ model: 'Sonnet 5.5', tier: 'opus', color: 'suggestion', text: ' Sonnet 5.5 · opus workers' }])
  })

  test('on the wrong model (Haiku) it is a mismatch against the substituted tier: "not sonnet"', () => {
    const b = board({ units: [tierUnit('O1', 'opus')] }, [
      agent('main'),
      agent('o1', { model: HAIKU, unitId: 'O1', routed: routedOn('opus', 'sonnet') }),
    ])
    const c = flowProps(vmOf(b)).leads.find(w => w.id === 'o1')!
    expect(c.model).toBe('Haiku 5.5 · not sonnet')
    expect(c.warn).toBe(true)
  })
})

describe('ungated marks and the degraded gate (0.11.0)', () => {
  const marked = () => board({}, [agent('main'), agent('w1', { model: HAIKU, ungated: { why: 'workflow', run: 'wf_1' } })])
  const healthy = { checkFailures: 0, recordFailures: 0, last: null, since: NOW - 600_000 }
  const degraded = { ...healthy, checkFailures: 2 }

  test('a marked card: model line, warn and tier', () => {
    const c = flowProps(vmOf(marked())).leads.find(w => w.id === 'w1')!
    expect(c.model).toBe('Haiku 5.5 · ungated: workflow')
    expect(c.warn).toBe(true)
    expect(c.tier).toBe('haiku')
  })

  test('a marked card of another task still reads ungated', () => {
    const b = taskBoard([slot('ab-journal', 'Journal work')], [agent('h1', { model: HAIKU, taskId: 'ab-journal', ungated: { why: 'resumed' } })])
    const c = flowProps(vmOf(b)).workers.find(w => w.id === 'h1') ?? flowProps(vmOf(b)).leads.find(w => w.id === 'h1')
    expect(c?.model).toBe('Haiku 5.5 · ungated: resumed')
  })

  test('detail lines: the warning, the run id, no task or route lines', () => {
    const b = marked()
    const lines = detailLines(vmOf(b), b.agents.w1!, 70)
    expect(lines.slice(0, 3)).toEqual([
      { text: `general-purpose · ${HAIKU}`, dim: true },
      { text: 'ungated (workflow): no unit, tier or audit line was checked', color: 'warning' },
      { text: 'run: wf_1' },
    ])
    expect(lines.some(l => l.text.startsWith('task:') || l.text.startsWith('route:'))).toBe(false)
  })

  test('detail lines of a non-workflow mark carry no run line', () => {
    const b = board({}, [agent('main'), agent('w1', { model: HAIKU, ungated: { why: 'exempt' } })])
    const lines = detailLines(vmOf(b), b.agents.w1!, 70)
    expect(lines[1]).toEqual({ text: 'ungated (exempt): no unit, tier or audit line was checked', color: 'warning' })
    expect(lines.some(l => l.text.startsWith('run:'))).toBe(false)
  })

  test('statusParts: unchanged with no gate and with a healthy gate; a degraded gate comes first', () => {
    const b = marked()
    const base = statusParts(vmOf(b))
    expect(statusParts(vmOf(b, { gate: healthy }))).toEqual(base)
    expect(base.some(p => p.label === 'gate')).toBe(false)
    const d = statusParts(vmOf(b, { gate: degraded }))
    expect(d[0]).toEqual({ label: 'gate', value: 'degraded · 2 failed', warn: true })
    expect(d.slice(1)).toEqual(base)
  })

  test('bandText: the gate part after the title when degraded, unchanged otherwise', () => {
    const b = marked()
    const base = bandText(vmOf(b))
    expect(bandText(vmOf(b, { gate: healthy }))).toBe(base)
    expect(bandText(vmOf(b, { gate: degraded }))).toBe(base.replace('Agent Board  ', 'Agent Board  gate degraded (2)  '))
    expect(bandText(vmOf(b, { gate: degraded })).startsWith('Agent Board  gate degraded (2)  ')).toBe(true)
  })
})
