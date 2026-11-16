import { describe, expect, test } from 'claude-code/testing'

import type { AgentBox, Board, Tokens } from '../types'
import { emptyUi } from './detail'
import { emptyBoard } from './state'
import { WORKERS_SHOWN, barCells, drawTokens, tokensLayout } from './tokens'
import type { ViewModel } from './view'

const SURFACES = ['terminal', 'desktop'] as const
const LOADED = new Date(2026, 10, 15, 14, 2, 11).getTime()
const SINCE = '14:02:11'
const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'

const tk = (input: number, cacheWrite: number, cacheRead: number, output: number, requests: number): Tokens => ({ input, cacheWrite, cacheRead, output, requests })

function box(id: string, over: Partial<AgentBox> = {}): AgentBox {
  return {
    id,
    label: `Do ${id}`,
    type: 'general-purpose',
    model: OPUS,
    unitId: id,
    name: id,
    parentId: null,
    status: 'done',
    reason: null,
    tokens: tk(1000, 500, 40_000, 2000, 10),
    tokensPartial: false,
    startedAt: 500,
    endedAt: null,
    lastEventAt: null,
    lastTool: null,
    briefChars: null,
    resultChars: null,
    peakIn: null,
    flow: { dir: null, at: null },
    taskId: 'wb-ui',
    routed: null,
    ungated: null,
    ...over,
  }
}

function boardOf(boxes: AgentBox[], over: Partial<Board> = {}): Board {
  const b = emptyBoard(LOADED)
  b.taskId = 'wb-ui'
  b.task = 'A task'
  for (const x of boxes) {
    b.agents[x.id] = x
    b.order.push(x.id)
  }
  b.leadByTask = { 'wb-ui': tk(2000, 1000, 90_000, 4000, 30) }
  return Object.assign(b, over)
}

const lead = (): AgentBox => box('main', { label: 'Orchestrator', type: 'main', unitId: null, name: null, taskId: null, tokens: tk(2000, 1000, 90_000, 4000, 30) })

/** A lead and two workers on two models, every count whole. */
function worked(): Board {
  return boardOf([
    lead(),
    box('U2', { label: 'Design draft', model: OPUS, tokens: tk(1000, 500, 900_000, 30_000, 90) }),
    box('U3', { label: 'Implementation', model: SONNET, tokens: tk(500, 200, 180_000, 4100, 18) }),
  ])
}

function vmOf(b: Board, over: Partial<ViewModel> = {}): ViewModel {
  return {
    board: b,
    now: LOADED + 1000,
    width: 72,
    height: null,
    unitStates: {},
    quiet: {},
    detail: { agents: {} },
    ui: emptyUi(),
    log: { entries: [] },
    onSelect: () => {},
    ...over,
  }
}

type Ctx = { vm: ViewModel }

function hookUp(on: any, ctx: Ctx): void {
  on('ui.render', { component: 'Pane' }, ($: any, e: any) => drawTokens($.ui.resolve(e), ctx.vm))
}

async function mountPane($: any, surface: (typeof SURFACES)[number], vm: ViewModel) {
  return $.ui.mount({
    plugin: 'flowestra',
    component: 'Pane',
    requestId: 'tokens-test',
    surface,
    props: { title: 'Agent Board', isFocused: false, bodyColumns: vm.width, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 200 }, view: {} },
  })
}

function walk(n: any, visit: (n: any) => void): void {
  if (!n || typeof n !== 'object') return
  visit(n)
  for (const k of n.children ?? []) walk(k, visit)
}
const keyOf = (n: any): string => String(n?.key ?? n?.props?.key ?? '')
const kids = (n: any): any[] => ((n?.children as any[]) ?? []).filter(c => c !== null && c !== false && c !== undefined)
const textOf = (n: any): string => {
  if (typeof n === 'string') return n
  if (!n || typeof n !== 'object') return ''
  const inner = (n.children ?? []).map(textOf)
  if (inner.join('') === '' && typeof n.text === 'string') return n.text
  if (inner.join('') === '' && typeof n.props?.children === 'string') return n.props.children
  return inner.join(n.props?.flexDirection === 'column' ? '\n' : '')
}
/** The text of each direct child (a row), by key. */
const rowsOf = (section: any): string[] => kids(section).map(textOf)

const FULL_KEYS = ['nav', 'tokens-head', 'tokens-since', 'tokens-split', 'tokens-in', 'tokens-out', 'tokens-models', 'tokens-workers', 'tokens-kept', 'tokens-overhead', 'tokens-notes']

async function drawnText($: any, ctx: Ctx, surface: (typeof SURFACES)[number]): Promise<{ text: string; tree: any }> {
  const ui = await mountPane($, surface, ctx.vm)
  const tree = await ui.find({ key: 'tokens' })
  const text = kids(tree).map(textOf).join('\n')
  await ui.unmount()
  return { text, tree }
}

describe('barCells and tokensLayout', () => {
  test('bars are whole blocks plus one eighth glyph; nothing for a value that is not above zero', () => {
    expect(barCells(1, 1, 8)).toBe('████████')
    expect(barCells(1, 8, 8)).toBe('█')
    expect(barCells(1, 16, 8)).toBe('▌')
    expect(barCells(0, 5, 8)).toBe('')
    expect(barCells(5, 0, 8)).toBe('')
    expect(barCells(1, 1000, 8)).toBe('')
    expect(barCells(3, 2, 8)).toBe('████████')
  })

  test('the class by width: 20 tiny, 24 narrow, 48 medium, 72 and 96 wide', () => {
    expect([20, 24, 48, 72, 96].map(w => tokensLayout(w).cls)).toEqual(['tiny', 'narrow', 'medium', 'wide', 'wide'])
    expect(tokensLayout(72)).toEqual({ cls: 'wide', label: 18, value: 7, bar: 42 })
    expect(tokensLayout(20).bar).toBe(0)
  })
})

describe('the Tokens tab', () => {
  test('both surfaces: the section keys in order, nav first, each section keyed', async ($, on) => {
    const ctx: Ctx = { vm: vmOf(worked(), { injected: [{ name: 'board', chars: 1000 }, { name: 'routing policy', chars: 2000 }] }) }
    hookUp(on, ctx)
    for (const surface of SURFACES) {
      const { tree } = await drawnText($, ctx, surface)
      expect(kids(tree).map(keyOf)).toEqual(FULL_KEYS)
    }
  })

  test('the empty states: no counts at all, and a lead with no worker', async ($, on) => {
    const ctx: Ctx = { vm: vmOf(boardOf([], { leadByTask: {} })) }
    hookUp(on, ctx)
    for (const surface of SURFACES) {
      ctx.vm = vmOf(boardOf([], { leadByTask: {} }))
      let { text, tree } = await drawnText($, ctx, surface)
      expect(kids(tree).map(keyOf)).toEqual(['nav', 'tokens-head', 'tokens-since', 'tokens-notes'])
      expect(text.replace(/\s+/g, ' ')).toContain('No token counts yet. They appear after the first model request the board sees.')
      expect(text).toContain(`counted since ${SINCE}`)

      ctx.vm = vmOf(boardOf([lead()]))
      ;({ text, tree } = await drawnText($, ctx, surface))
      expect(kids(tree).map(keyOf)).toEqual(['nav', 'tokens-head', 'tokens-since', 'tokens-models', 'tokens-workers', 'tokens-kept', 'tokens-overhead', 'tokens-notes'])
      expect(text).toContain('Nothing delegated in this task yet.')
      const kept = kids(tree).find(k => keyOf(k) === 'tokens-kept')
      expect(rowsOf(kept)).toEqual(['kept out of the lead', 'none'])

      ctx.vm = vmOf(boardOf([lead()], { taskId: null, leadByTask: { '': tk(1, 0, 0, 1, 1) } }))
      ;({ text } = await drawnText($, ctx, surface))
      expect(text).toContain('TOKENS · no task')
    }
  })

  test('the header names the scope; the scope Buttons are plain, hotkeys 1 and 2, the active one bold and underlined', async ($, on) => {
    const ctx: Ctx = { vm: vmOf(worked()) }
    hookUp(on, ctx)
    for (const surface of SURFACES) {
      for (const scope of ['task', 'all'] as const) {
        ctx.vm = vmOf(worked(), { ui: { ...emptyUi(), tab: 'tokens', scope } })
        const { text, tree } = await drawnText($, ctx, surface)
        const head = kids(tree).find(k => keyOf(k) === 'tokens-head')
        expect(textOf(head)).toContain(scope === 'task' ? 'TOKENS · task wb-ui' : `TOKENS · since ${SINCE}, every task`)
        const buttons: any[] = []
        walk(head, n => n.type === 'Button' && buttons.push(n))
        expect(buttons.map(keyOf)).toEqual(['scope-task', 'scope-all'])
        expect(buttons.map(b => b.props.hotkey)).toEqual(['1', '2'])
        expect(buttons.every(b => b.props.plain === true)).toBe(true)
        const active = scope === 'task' ? 0 : 1
        const ui = await mountPane($, surface, ctx.vm)
        expect((await ui.find({ key: 'scope-task' }))?.text).toBe('this task')
        expect((await ui.find({ key: 'scope-all' }))?.text).toBe(`since ${SINCE}`)
        await ui.unmount()
        buttons.forEach((b, i) => {
          const marked: any[] = []
          walk(b, n => n.type === 'Text' && n.props?.bold === true && n.props?.underline === true && marked.push(n))
          expect(marked).toHaveLength(i === active ? 1 : 0)
          expect(!!b.props.dimColor).toBe(i !== active)
        })
        expect(text).toContain('nothing estimated')
      }
    }
  })

  test('pressing a scope Button calls onScope (the onPress closures, read off the drawn element)', () => {
    const make = (type: string) => (props: any) => ({ type, props: props ?? {} })
    const fake = { Box: make('Box'), Text: make('Text'), Button: make('Button') }
    const calls: string[] = []
    const tree: any = drawTokens(fake as any, vmOf(worked(), { onScope: s => calls.push(s) }))
    const found: Record<string, any> = {}
    const scan = (n: any): void => {
      if (!n || typeof n !== 'object') return
      if (n.type === 'Button') found[String(n.key ?? n.props?.key)] = n
      for (const c of ([] as any[]).concat(n.props?.children ?? [])) scan(c)
    }
    scan(tree)
    expect(Object.keys(found)).toEqual(['tab-board', 'tab-tokens', 'scope-task', 'scope-all'])
    found['scope-all'].props.onPress()
    found['scope-task'].props.onPress()
    expect(calls).toEqual(['all', 'task'])
    const quiet: any = drawTokens(fake as any, vmOf(worked()))
    expect(() => scan(quiet)).not.toThrow()
  })

  test('whole counts: the split bar, both charts with a percent column, the tables, the overhead', async ($, on) => {
    const injected = [{ name: 'board', chars: 1000 }, { name: 'routing policy', chars: 2000 }]
    const ctx: Ctx = { vm: vmOf(worked(), { injected }) }
    hookUp(on, ctx)
    for (const surface of SURFACES) {
      const { tree } = await drawnText($, ctx, surface)
      const by = (key: string) => kids(tree).find(k => keyOf(k) === key)
      const split = textOf(by('tokens-split'))
      expect(split).toMatch(/^lead \d+% .*▓.* \d+% delegated$/)
      for (const key of ['tokens-in', 'tokens-out']) {
        const rows = rowsOf(by(key))
        expect(rows[0]).toBe(key === 'tokens-in' ? 'in, by model' : 'out, by model')
        expect(rows).toHaveLength(4)
        expect(rows[1]).toContain('lead · ')
        expect(rows.slice(1).every(r => r.includes('%'))).toBe(true)
        expect(rows.slice(1).some(r => r.includes('█'))).toBe(true)
        const sum = rows.slice(1).reduce((n, r) => n + Number(/(\d+)%\s*$/.exec(r)?.[1] ?? 0), 0)
        expect(Math.abs(sum - 100)).toBeLessThanOrEqual(2)
      }
      const models = rowsOf(by('tokens-models'))
      expect(models[0]).toMatch(/by model\s*new\s*cached\s*out\s*req\s*agents/)
      expect(models[1]).toMatch(/^lead · Opus/)
      expect(models[models.length - 1]).toMatch(/^all\s/)
      const workers = rowsOf(by('tokens-workers'))
      expect(workers[0]).toMatch(/by worker\s*model\s*st\s*in\s*out\s*req\s*note/)
      expect(workers).toHaveLength(3)
      expect(workers[1]).toContain('U2 Design draft')
      expect(workers[1]).toContain('✓')
      const kept = rowsOf(by('tokens-kept'))
      expect(kept[0]).toBe('kept out of the lead')
      expect(kept.some(r => r.includes('their answers back'))).toBe(true)
      const over = rowsOf(by('tokens-overhead'))
      expect(over[0]).toBe('overhead')
      expect(over.join('|')).toMatch(/Flowestra's text in the lead's prompt\|?\s*3k chars, sent with each of the lead's 30 requests/)
      expect(over.some(r => /runs whose unit was rejected\s*none/.test(r))).toBe(true)
    }
  })

  test('the Flowestra-text line is omitted when injected is missing or empty', async ($, on) => {
    const ctx: Ctx = { vm: vmOf(worked()) }
    hookUp(on, ctx)
    for (const surface of SURFACES) {
      for (const injected of [undefined, []] as const) {
        ctx.vm = vmOf(worked(), injected === undefined ? {} : { injected })
        const { text } = await drawnText($, ctx, surface)
        expect(text).not.toContain("Flowestra's text in the lead's prompt")
      }
    }
  })

  test('a partial box: no percent anywhere, no split bar, a ≥ on its values, its bars dim', async ($, on) => {
    const b = boardOf([
      lead(),
      box('U2', { model: OPUS, tokens: tk(1000, 500, 900_000, 30_000, 90), tokensPartial: true }),
      box('U3', { model: SONNET, tokens: tk(500, 200, 180_000, 4100, 18) }),
    ])
    const ctx: Ctx = { vm: vmOf(b) }
    hookUp(on, ctx)
    for (const surface of SURFACES) {
      const { text, tree } = await drawnText($, ctx, surface)
      const keys = kids(tree).map(keyOf)
      expect(keys).toContain('tokens-split')
      expect(text).toContain('Delegated: not shown while some counts are partial (≥).')
      const by = (key: string) => kids(tree).find(k => keyOf(k) === key)
      for (const key of ['tokens-in', 'tokens-out']) {
        const rows = kids(by(key)).slice(1)
        expect(rows.map(textOf).some(r => r.includes('%'))).toBe(false)
        const opusRow = rows.find(r => !textOf(r).includes('lead') && textOf(r).includes('Opus'))
        expect(textOf(opusRow)).toContain('≥')
        const bars: any[] = []
        walk(opusRow, n => n.type === 'Text' && textOf(n).includes('█') && bars.push(n))
        expect(bars.length).toBeGreaterThan(0)
        expect(bars.every(n => n.props?.dimColor === true)).toBe(true)
        const other = rows.find(r => textOf(r).includes('Sonnet'))
        walk(other, n => n.type === 'Text' && textOf(n).includes('█') && expect(!!n.props?.dimColor).toBe(false))
      }
      expect(textOf(by('tokens-models'))).toContain('≥')
      expect(textOf(by('tokens-workers'))).toContain('≥')
      expect(text).not.toMatch(/\d%/)
    }
  })

  test('a unit run on another tier: `incl. 1 opus-tier` when wide, ` *` and a key line when narrow', async ($, on) => {
    const b = boardOf([
      lead(),
      box('U2', { model: OPUS }),
      box('U3', { model: SONNET, routed: { tier: 'opus', kind: 'design', audit: 'a | opus | b | c', ranOn: 'sonnet' } as AgentBox['routed'] }),
    ])
    const ctx: Ctx = { vm: vmOf(b) }
    hookUp(on, ctx)
    for (const surface of SURFACES) {
      ctx.vm = vmOf(b, { width: 72 })
      let { tree } = await drawnText($, ctx, surface)
      let models = rowsOf(kids(tree).find(k => keyOf(k) === 'tokens-models'))
      expect(models.some(r => r.includes('Sonnet 5.5 · incl. 1 opus-tier'))).toBe(true)
      expect(models.some(r => r.includes('* incl. work of another tier'))).toBe(false)
      for (const width of [30, 20]) {
        ctx.vm = vmOf(b, { width })
        ;({ tree } = await drawnText($, ctx, surface))
        models = rowsOf(kids(tree).find(k => keyOf(k) === 'tokens-models'))
        expect(models.some(r => /^Sonnet[^*]* \*/.test(r))).toBe(true)
        expect(models.slice(-3).join(' ')).toContain('* incl. work of')
        expect(models.join(' ')).toContain('another tier')
      }
    }
  })

  test('the worker table shows 12 and sums the rest on one `+N more` line', async ($, on) => {
    const many = Array.from({ length: 15 }, (_, i) => box(`W${String(i).padStart(2, '0')}`, { tokens: tk(100, 0, 900, 50, 2), startedAt: 100 + i }))
    const ctx: Ctx = { vm: vmOf(boardOf([lead(), ...many])) }
    hookUp(on, ctx)
    expect(WORKERS_SHOWN).toBe(12)
    for (const surface of SURFACES) {
      const { tree } = await drawnText($, ctx, surface)
      const rows = rowsOf(kids(tree).find(k => keyOf(k) === 'tokens-workers'))
      // header, 12 workers, the +N more line
      expect(rows).toHaveLength(14)
      expect(rows[13]).toBe('+3 more · in 3k out 150')
    }
  })

  test('scope all: the worker of another task is marked `other task`', async ($, on) => {
    const b = boardOf([lead(), box('U2'), box('U9', { taskId: 'other-task', label: 'Elsewhere' })])
    const ctx: Ctx = { vm: vmOf(b, { ui: { ...emptyUi(), tab: 'tokens', scope: 'all' } }) }
    hookUp(on, ctx)
    for (const surface of SURFACES) {
      ctx.vm = vmOf(b, { ui: { ...emptyUi(), tab: 'tokens', scope: 'all' } })
      let { tree } = await drawnText($, ctx, surface)
      let rows = rowsOf(kids(tree).find(k => keyOf(k) === 'tokens-workers'))
      expect(rows.find(r => r.includes('U9 Elsewhere'))).toContain('other task')
      expect(rows.find(r => r.includes('U2 '))).not.toContain('other task')
      ctx.vm = vmOf(b)
      ;({ tree } = await drawnText($, ctx, surface))
      rows = rowsOf(kids(tree).find(k => keyOf(k) === 'tokens-workers'))
      expect(rows.some(r => r.includes('U9'))).toBe(false)
    }
  })

  test('at widths 20, 24, 48, 72, 96 every Text outside the navbar is truncate-end and no row is wider than the pane', async ($, on) => {
    const b = boardOf([
      lead(),
      box('U2', { label: 'Design draft with a long label', model: OPUS, tokensPartial: true }),
      box('U3', { model: SONNET, status: 'failed', unitId: 'U3' }),
      box('U4', { model: SONNET, tokens: null, ungated: { reason: 'x' } as any }),
    ])
    b.rejects = [{ unitId: 'U3', tier: 'sonnet', kind: 'implement', taskId: 'wb-ui' }]
    const ctx: Ctx = { vm: vmOf(b) }
    hookUp(on, ctx)
    for (const surface of SURFACES) {
      for (const width of [20, 24, 48, 72, 96]) {
        ctx.vm = vmOf(b, { width, injected: [{ name: 'board', chars: 1000 }] })
        const { tree } = await drawnText($, ctx, surface)
        let texts = 0
        for (const section of kids(tree)) {
          if (keyOf(section) === 'nav') continue
          walk(section, n => {
            if (n.type !== 'Text') return
            texts++
            expect(n.props?.wrap).toBe('truncate-end')
          })
        }
        expect(texts).toBeGreaterThan(10)
        for (const section of kids(tree)) {
          if (keyOf(section) === 'nav') continue
          for (const line of kids(section)) {
            if (keyOf(line) === 'scope' || keyOf(line) === 'tokens-head') continue
            expect(textOf(line).length).toBeLessThanOrEqual(width)
          }
        }
      }
    }
  })

  test('the classes draw their own columns: medium in/out, narrow and tiny all, glyph notes with a key line', async ($, on) => {
    const b = boardOf([lead(), box('U2', { tokensPartial: true }), box('U3', { status: 'failed' }), box('U4', { unitId: 'U3', name: 'U3', startedAt: 900 })])
    b.rejects = [{ unitId: 'U3', tier: 'sonnet', kind: 'implement', taskId: 'wb-ui' }]
    const ctx: Ctx = { vm: vmOf(b) }
    hookUp(on, ctx)
    for (const surface of SURFACES) {
      ctx.vm = vmOf(b, { width: 56 })
      let { tree } = await drawnText($, ctx, surface)
      const by = (key: string) => kids(tree).find(k => keyOf(k) === key)
      expect(rowsOf(by('tokens-models'))[0]).toMatch(/by model\s*in\s*out$/)
      expect(rowsOf(by('tokens-workers'))[0]).toMatch(/by worker\s*in\s*out\s*note$/)
      const workers = rowsOf(by('tokens-workers')).join('\n')
      expect(workers).toMatch(/✗/)
      expect(workers).toMatch(/↻/)
      expect(workers).toContain('✗ rejected')
      ctx.vm = vmOf(b, { width: 30 })
      ;({ tree } = await drawnText($, ctx, surface))
      expect(rowsOf(kids(tree).find(k => keyOf(k) === 'tokens-models'))[0]).toMatch(/by model\s*all$/)
      ctx.vm = vmOf(b, { width: 20 })
      ;({ tree } = await drawnText($, ctx, surface))
      const tiny = rowsOf(kids(tree).find(k => keyOf(k) === 'tokens-in'))
      expect(tiny.slice(1).every(r => !r.includes('█'))).toBe(true)
      expect(rowsOf(kids(tree).find(k => keyOf(k) === 'tokens-workers'))[0]).toMatch(/by worker\s*all$/)
    }
  })

  test('no Box under any Button, on every class and both scopes', async ($, on) => {
    const ctx: Ctx = { vm: vmOf(worked()) }
    hookUp(on, ctx)
    for (const surface of SURFACES) {
      for (const width of [20, 48, 72]) {
        for (const scope of ['task', 'all'] as const) {
          ctx.vm = vmOf(worked(), { width, ui: { ...emptyUi(), tab: 'tokens', scope } })
          const { tree } = await drawnText($, ctx, surface)
          let buttons = 0
          walk(tree, n => {
            if (n.type !== 'Button') return
            buttons++
            walk(n, d => {
              if (d !== n) expect(d.type).not.toBe('Box')
            })
          })
          expect(buttons).toBe(4)
        }
      }
    }
  })

  test('the drawn text never says cost, price, cheap, expensive, saving, saved, usd, score or a dollar amount', async ($, on) => {
    const injected = [{ name: 'board', chars: 1000 }]
    const boards = [
      worked(),
      boardOf([], { leadByTask: {} }),
      boardOf([lead(), box('U2', { tokensPartial: true }), box('U3', { tokens: null }), box('U4', { routed: { tier: 'opus', kind: 'design', audit: 'a', ranOn: 'sonnet' } as AgentBox['routed'], model: SONNET })]),
    ]
    const ctx: Ctx = { vm: vmOf(boards[0] as Board) }
    hookUp(on, ctx)
    for (const surface of SURFACES) {
      for (const b of boards) {
        for (const width of [20, 48, 72]) {
          for (const scope of ['task', 'all'] as const) {
            ctx.vm = vmOf(b, { width, injected, ui: { ...emptyUi(), tab: 'tokens', scope } })
            const { text } = await drawnText($, ctx, surface)
            expect(text.length).toBeGreaterThan(20)
            expect(text).not.toMatch(/cost|price|cheap|expensive|saving|saved|usd|score|\$\s?\d|×/i)
          }
        }
      }
    }
  })
})
