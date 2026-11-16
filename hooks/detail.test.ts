import { describe, expect, test } from 'claude-code/testing'

import type { AgentDetail, Detail, Ui } from '../types'
import {
  BRIEF_MAX,
  DETAIL_SHAPE,
  TOOLS_MAX,
  UI_SHAPE,
  detailComplete,
  detailSpawn,
  detailToolEnd,
  detailToolStart,
  dropSelection,
  emptyAgentDetail,
  emptyDetail,
  emptyUi,
  selectCard,
  selectScope,
  selectTab,
} from './detail'
import { MAIN_ID } from './state'

const T0 = 1_000_000

const entry = (d: Detail, id: string): AgentDetail => {
  const found = d.agents[id]
  if (!found) throw new Error(`no detail ${id}`)
  return found
}

describe('constants and empties', () => {
  test('shape tags and limits', () => {
    expect(DETAIL_SHAPE).toBe('detail-2')
    expect(UI_SHAPE).toBe('ui-3')
    expect(BRIEF_MAX).toBe(600)
    expect(TOOLS_MAX).toBe(8)
  })
  test('empty values', () => {
    expect(emptyDetail()).toEqual({ agents: {} })
    expect(emptyUi()).toEqual({ selected: null, tab: 'board', scope: 'task' })
    expect(emptyAgentDetail()).toEqual({ brief: null, briefCut: false, tools: [] })
  })
})

describe('detailSpawn', () => {
  test('keeps a short brief trimmed', () => {
    const d = detailSpawn(emptyDetail(), 'a1', '  do the thing \n', T0)
    expect(entry(d, 'a1')).toEqual({ brief: 'do the thing', briefCut: false, tools: [] })
  })
  test('exactly 600 characters is not cut', () => {
    const d = detailSpawn(emptyDetail(), 'a1', 'x'.repeat(600), T0)
    expect(entry(d, 'a1').brief).toHaveLength(600)
    expect(entry(d, 'a1').briefCut).toBe(false)
  })
  test('601 characters is cut to 600', () => {
    const d = detailSpawn(emptyDetail(), 'a1', 'y'.repeat(601), T0)
    expect(entry(d, 'a1').brief).toBe('y'.repeat(600))
    expect(entry(d, 'a1').briefCut).toBe(true)
  })
  test('null and whitespace prompts give a null brief', () => {
    expect(entry(detailSpawn(emptyDetail(), 'a1', null, T0), 'a1').brief).toBeNull()
    const w = entry(detailSpawn(emptyDetail(), 'a1', '   \n\t ', T0), 'a1')
    expect(w.brief).toBeNull()
    expect(w.briefCut).toBe(false)
  })
  test('replaces an earlier entry and does not mutate the input', () => {
    const before = detailToolStart(emptyDetail(), 'a1', 'c1', 'Read', T0)
    const d = detailSpawn(before, 'a1', 'again', T0 + 5)
    expect(entry(d, 'a1')).toEqual({ brief: 'again', briefCut: false, tools: [] })
    expect(entry(before, 'a1').tools).toHaveLength(1)
  })
})

describe('detailToolStart', () => {
  test('a worker gets the run; entry created when missing', () => {
    const d = detailToolStart(emptyDetail(), 'a1', 'c1', 'Read', T0)
    expect(entry(d, 'a1')).toEqual({ brief: null, briefCut: false, tools: [{ id: 'c1', tool: 'Read', startedAt: T0 }] })
  })
  test('the orchestrator is stored under main', () => {
    const d = detailToolStart(emptyDetail(), undefined, 'c1', 'Bash', T0)
    expect(entry(d, MAIN_ID)).toEqual({ brief: null, briefCut: false, tools: [{ id: 'c1', tool: 'Bash', startedAt: T0 }] })
    const e = detailToolStart(emptyDetail(), MAIN_ID, 'c2', 'Bash', T0)
    expect(entry(e, MAIN_ID).tools.map(t => t.id)).toEqual(['c2'])
  })
  test('a duplicate call id replaces the run', () => {
    let d = detailToolStart(emptyDetail(), 'a1', 'c1', 'Read', T0)
    d = detailToolStart(d, 'a1', 'c1', 'Grep', T0 + 10)
    expect(entry(d, 'a1').tools).toEqual([{ id: 'c1', tool: 'Grep', startedAt: T0 + 10 }])
  })
  test('keeps at most 8 runs, dropping the oldest', () => {
    let d = emptyDetail()
    for (let i = 0; i < 10; i++) d = detailToolStart(d, 'a1', `c${i}`, 'Read', T0 + i)
    const ids = entry(d, 'a1').tools.map(t => t.id)
    expect(ids).toEqual(['c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'])
  })
  test("the orchestrator's SendMessage target is ignored: no entry is made for it", () => {
    const d = detailToolStart(emptyDetail(), undefined, 'c1', 'SendMessage', T0, 'a7')
    expect(d.agents['a7']).toBeUndefined()
    expect(Object.keys(d.agents)).toEqual([MAIN_ID])
    const base = detailSpawn(emptyDetail(), 'a7', 'brief', T0)
    const e = detailToolStart(base, undefined, 'c1', 'SendMessage', T0 + 50, 'a7')
    expect(e.agents['a7']).toBe(base.agents['a7'])
  })
  test('does not mutate the input', () => {
    const before = detailToolStart(emptyDetail(), 'a1', 'c1', 'Read', T0)
    detailToolStart(before, 'a1', 'c2', 'Read', T0 + 1)
    expect(entry(before, 'a1').tools.map(t => t.id)).toEqual(['c1'])
  })
})

describe('detailToolEnd', () => {
  test('a worker drops the run', () => {
    let d = detailToolStart(emptyDetail(), 'a1', 'c1', 'Read', T0)
    d = detailToolStart(d, 'a1', 'c2', 'Grep', T0 + 1)
    d = detailToolEnd(d, 'a1', 'c1', T0 + 100)
    expect(entry(d, 'a1')).toEqual({ brief: null, briefCut: false, tools: [{ id: 'c2', tool: 'Grep', startedAt: T0 + 1 }] })
  })
  test('the orchestrator drops the run', () => {
    let d = detailToolStart(emptyDetail(), undefined, 'c1', 'Bash', T0)
    d = detailToolEnd(d, undefined, 'c1', T0 + 100)
    expect(entry(d, MAIN_ID)).toEqual(emptyAgentDetail())
  })
  test('unknown agent or call id returns the same object', () => {
    const d = detailToolStart(emptyDetail(), 'a1', 'c1', 'Read', T0)
    expect(detailToolEnd(d, 'nobody', 'c1', T0 + 1)).toBe(d)
    expect(detailToolEnd(d, 'a1', 'zzz', T0 + 1)).toBe(d)
    expect(detailToolEnd(d, undefined, 'c1', T0 + 1)).toBe(d)
  })
})

describe('detailComplete', () => {
  test('a worker clears its runs and keeps its brief', () => {
    let d = detailSpawn(emptyDetail(), 'a1', 'go', T0)
    d = detailToolStart(d, 'a1', 'c1', 'Read', T0 + 1)
    d = detailComplete(d, 'a1', T0 + 200)
    expect(entry(d, 'a1')).toEqual({ brief: 'go', briefCut: false, tools: [] })
  })
  test('an unknown worker gets an empty entry', () => {
    const d = detailComplete(emptyDetail(), 'a9', T0)
    expect(entry(d, 'a9')).toEqual(emptyAgentDetail())
  })
  test('the orchestrator: unchanged with no entry, runs cleared otherwise', () => {
    const empty = emptyDetail()
    expect(detailComplete(empty, undefined, T0)).toBe(empty)
    let d = detailToolStart(emptyDetail(), undefined, 'c1', 'Bash', T0)
    d = detailComplete(d, undefined, T0 + 5)
    expect(entry(d, MAIN_ID)).toEqual(emptyAgentDetail())
  })
})

describe('selectCard', () => {
  test('selects a card, then closes it on a second press', () => {
    const on = selectCard(emptyUi(), 'a1')
    expect(on).toEqual({ selected: 'a1', tab: 'board', scope: 'task' })
    expect(selectCard(on, 'a1')).toEqual({ selected: null, tab: 'board', scope: 'task' })
  })
  test('another card moves the selection', () => {
    expect(selectCard({ ...emptyUi(), selected: 'a1' }, 'a2').selected).toBe('a2')
  })
  test('does not mutate the input', () => {
    const ui: Ui = { ...emptyUi(), selected: 'a1' }
    selectCard(ui, 'a1')
    selectCard(ui, 'a2')
    expect(ui).toEqual({ selected: 'a1', tab: 'board', scope: 'task' })
  })
})

describe('dropSelection', () => {
  test('clears a selection whose card has gone', () => {
    expect(dropSelection({ ...emptyUi(), selected: 'a1' }, ['a2', 'a3']).selected).toBeNull()
    expect(dropSelection({ ...emptyUi(), selected: 'a1' }, []).selected).toBeNull()
  })
  test('keeps the same object when the card is present', () => {
    const ui: Ui = { ...emptyUi(), selected: 'a2' }
    expect(dropSelection(ui, ['a1', 'a2'])).toBe(ui)
  })
  test('keeps the same object when nothing is selected', () => {
    const ui = emptyUi()
    expect(dropSelection(ui, [])).toBe(ui)
    expect(dropSelection(ui, ['a1'])).toBe(ui)
  })
})

describe('tab and scope keep through card changes', () => {
  const tokens: Ui = { selected: null, tab: 'tokens', scope: 'all' }
  test('selectCard toggles selected and keeps tab and scope', () => {
    const on = selectCard(tokens, 'a1')
    expect(on).toEqual({ selected: 'a1', tab: 'tokens', scope: 'all' })
    expect(selectCard(on, 'a1')).toEqual(tokens)
  })
  test('dropSelection keeps tab and scope when it drops', () => {
    const ui: Ui = { ...tokens, selected: 'a1' }
    expect(dropSelection(ui, [])).toEqual({ selected: null, tab: 'tokens', scope: 'all' })
  })
  test('dropSelection returns the same object when nothing drops', () => {
    expect(dropSelection(tokens, [])).toBe(tokens)
    const ui: Ui = { ...tokens, selected: 'a1' }
    expect(dropSelection(ui, ['a1'])).toBe(ui)
  })
})

describe('selectTab and selectScope', () => {
  test('selectTab sets the tab, keeps the rest', () => {
    const ui = emptyUi()
    expect(selectTab(ui, 'tokens')).toEqual({ selected: null, tab: 'tokens', scope: 'task' })
    expect(ui.tab).toBe('board')
  })
  test('selectTab returns the same object when unchanged', () => {
    const ui = emptyUi()
    expect(selectTab(ui, 'board')).toBe(ui)
  })
  test('selectTab ignores an unknown value', () => {
    const ui = emptyUi()
    expect(selectTab(ui, 'nope' as never)).toBe(ui)
  })
  test('selectScope sets the scope, keeps the rest', () => {
    const ui = emptyUi()
    expect(selectScope(ui, 'all')).toEqual({ selected: null, tab: 'board', scope: 'all' })
    expect(ui.scope).toBe('task')
  })
  test('selectScope returns the same object when unchanged', () => {
    const ui = emptyUi()
    expect(selectScope(ui, 'task')).toBe(ui)
  })
  test('selectScope ignores an unknown value', () => {
    const ui = emptyUi()
    expect(selectScope(ui, 'nope' as never)).toBe(ui)
  })
})
