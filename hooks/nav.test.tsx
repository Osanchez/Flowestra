import { expect, test } from 'claude-code/testing'

import type { BoardTab, Board } from '../types'
import { emptyUi } from './detail'
import { NAV_ROWS, drawNav } from './nav'
import { drawPane, paneFit } from './view'
import type { ViewModel } from './view'

const SURFACES = ['terminal', 'desktop'] as const
const NOW = 1_000_000

function emptyBoard(): Board {
  return {
    taskId: null,
    repo: null,
    task: 'Build the agent board mod',
    phase: 'executing',
    wave: 1,
    units: [],
    agents: {},
    order: [],
    loadedAt: NOW - 600_000,
    note: null,
    rejects: [],
    parked: [],
    closed: [],
    activeAt: 0,
    leadByTask: {},
    boardSent: {},
  }
}

function vmOf(over: Partial<ViewModel> = {}): ViewModel {
  return {
    board: emptyBoard(),
    now: NOW,
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

type Ctx = { vm: ViewModel; whole: boolean }

function hookUp(on: any, ctx: Ctx): void {
  on('ui.render', { component: 'Pane' }, ($: any, e: any) => {
    const el = $.ui.resolve(e)
    return ctx.whole ? drawPane(el, ctx.vm, null) : drawNav(el, ctx.vm)
  })
}

async function mountPane($: any, surface: (typeof SURFACES)[number], vm: ViewModel) {
  return $.ui.mount({
    plugin: 'flowestra',
    component: 'Pane',
    requestId: 'nav-test',
    surface,
    props: { title: 'Agent Board', isFocused: false, bodyColumns: vm.width, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} },
  })
}

function walk(n: any, visit: (n: any) => void): void {
  if (!n || typeof n !== 'object') return
  visit(n)
  for (const k of n.children ?? []) walk(k, visit)
}
const keyOf = (n: any): string => String(n?.key ?? n?.props?.key ?? '')
const kids = (n: any): any[] => ((n?.children as any[]) ?? []).filter(c => c !== null && c !== false && c !== undefined)

const withTab = (tab: BoardTab): ViewModel['ui'] => ({ ...emptyUi(), tab })

test('the navbar: one row, AGENT BOARD then two plain Buttons keyed tab-board and tab-tokens with hotkeys b and t', async ($, on) => {
  expect(NAV_ROWS).toBe(1)
  const ctx: Ctx = { vm: vmOf(), whole: false }
  hookUp(on, ctx)
  for (const width of [72, 96]) {
    ctx.vm = vmOf({ width })
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, ctx.vm)
      const nav = await ui.find({ key: 'nav' })
      expect(nav?.props.width).toBe(width)
      const buttons: any[] = []
      walk(nav, n => {
        if (n.type === 'Button') buttons.push(n)
      })
      expect(buttons.map(keyOf)).toEqual(['tab-board', 'tab-tokens'])
      expect(buttons.map(b => b.props.hotkey)).toEqual(['b', 't'])
      expect(buttons.every(b => b.props.plain === true)).toBe(true)
      expect((await ui.find({ key: 'nav-title' }))?.text).toBe('AGENT BOARD')
      await ui.unmount()
    }
  }
})

test('below 32 columns the title is left out and only the tab Buttons show', async ($, on) => {
  const ctx: Ctx = { vm: vmOf({ width: 30 }), whole: false }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    const ui = await mountPane($, surface, ctx.vm)
    const nav = await ui.find({ key: 'nav' })
    const buttons: any[] = []
    walk(nav, n => {
      if (n.type === 'Button') buttons.push(n)
    })
    expect(buttons.map(keyOf)).toEqual(['tab-board', 'tab-tokens'])
    expect(nav?.text).not.toContain('AGENT BOARD')
    expect(await ui.find({ key: 'nav-title' })).toBeFalsy()
    await ui.unmount()
  }
})

test('the active label is bold and underlined, the other Button is dimColor; no tab reads as Board', async ($, on) => {
  const ctx: Ctx = { vm: vmOf(), whole: false }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    for (const [ui_, active] of [[undefined, 'board'], [withTab('board'), 'board'], [withTab('tokens'), 'tokens']] as const) {
      ctx.vm = vmOf(ui_ === undefined ? {} : { ui: ui_ })
      const ui = await mountPane($, surface, ctx.vm)
      for (const [key, tab, label] of [['tab-board', 'board', 'Board'], ['tab-tokens', 'tokens', 'Tokens']] as const) {
        const button = await ui.find({ key })
        expect(button?.text).toBe(label)
        const marked: any[] = []
        walk(button, n => {
          if (n.type === 'Text' && n.props?.bold === true && n.props?.underline === true) marked.push(n)
        })
        if (tab === active) {
          expect(marked).toHaveLength(1)
          expect(button?.props.dimColor).toBeFalsy()
        } else {
          expect(marked).toHaveLength(0)
          expect(button?.props.dimColor).toBe(true)
        }
      }
      await ui.unmount()
    }
  }
})

test('no Box under any Button: its children are strings and Text only (a Box there kills the pane)', async ($, on) => {
  const ctx: Ctx = { vm: vmOf(), whole: false }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    for (const tab of ['board', 'tokens'] as const) {
      ctx.vm = vmOf({ ui: withTab(tab) })
      const ui = await mountPane($, surface, ctx.vm)
      let buttons = 0
      walk(await ui.drawn(), n => {
        if (n.type !== 'Button') return
        buttons++
        walk(n, d => {
          if (d !== n) expect(['Text', undefined]).toContain(d.type === 'Box' ? 'Box!' : d.type)
        })
      })
      expect(buttons).toBe(2)
      await ui.unmount()
    }
  }
})

test('pressing a tab Button calls onTab with that tab (the onPress closures, read off the drawn element)', () => {
  const make = (type: string) => (props: any) => ({ type, props: props ?? {} })
  const fake = { Box: make('Box'), Text: make('Text'), Button: make('Button') }
  const calls: string[] = []
  const nav: any = drawNav(fake as any, vmOf({ onTab: tab => calls.push(tab) }))
  const found: Record<string, any> = {}
  const scan = (n: any): void => {
    if (!n || typeof n !== 'object') return
    if (n.type === 'Button') found[String(n.key ?? n.props?.key)] = n
    for (const c of ([] as any[]).concat(n.props?.children ?? [])) scan(c)
  }
  scan(nav)
  expect(Object.keys(found)).toEqual(['tab-board', 'tab-tokens'])
  found['tab-tokens'].props.onPress()
  found['tab-board'].props.onPress()
  expect(calls).toEqual(['tokens', 'board'])
  // no handler in the view model: a press does nothing
  const quiet: any = drawNav(fake as any, vmOf())
  expect(() => scan(quiet)).not.toThrow()
})

test('the pane draws the navbar first, except in the widget seat, which draws none and counts no row', async ($, on) => {
  const ctx: Ctx = { vm: vmOf(), whole: true }
  hookUp(on, ctx)
  for (const surface of SURFACES) {
    for (const placement of ['dock', 'inline', undefined, 'widget'] as const) {
      ctx.vm = vmOf(placement === undefined ? {} : { placement })
      const ui = await mountPane($, surface, ctx.vm)
      const keys = kids(await ui.find({ key: 'pane' })).map(keyOf)
      if (placement === 'widget') expect(keys).toEqual(['header', 'legend', 'spacer', 'flow', 'status'])
      else expect(keys.slice(0, 4)).toEqual(['nav', 'header', 'legend', 'spacer'])
      await ui.unmount()
    }
  }
  // the widget seat's rows: one fewer fixed row, so the plan box fits one row sooner
  const least = (placement: ViewModel['placement']) => {
    for (let height = 0; height <= 100; height++) if (paneFit(vmOf({ height, placement })).plan) return height
    throw new Error('no height')
  }
  expect(least('dock')).toBe(least('widget') + 1)
})
