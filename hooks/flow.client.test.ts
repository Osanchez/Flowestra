import { describe, expect, test } from 'claude-code/testing'

import type { FlowLead, FlowProps, RowCard } from '../types'
import {
  CARD_HEIGHT,
  ENTER_FRAMES,
  EXIT_FRAMES,
  MAX_CARD,
  MIN_CARD,
  advanceFlow,
  barText,
  dotAt,
  drawFlow,
  isIdle,
  isStill,
  layoutFlow,
  perRowOf,
  planUnitsSegs,
  pruneFlow,
  railLine,
  reconcileFlow,
  shimmerAt,
  shownCards,
  weightOf,
} from './flow.client'
import type { FlowState, Slot } from './flow.client'

function card(id: string, over: Partial<RowCard> = {}): RowCard {
  return { id, row: 'workers', tier: 'opus', warn: false, label: `Do ${id}`, status: 'running', line: 'Edit · 1m 12s', tokens: 'out 8.1k', selected: false, model: 'Opus 5.5', ...over }
}

function lead(id: string, over: Partial<RowCard> = {}): RowCard {
  return card(id, { row: 'leads', tier: 'haiku', model: 'Haiku 5.5 · locate', ...over })
}

const WAITING: FlowLead = { title: 'Fable 5.2 · main session', running: false, line: 'waiting', tokens: 'out 8.1k' }
const RUNNING: FlowLead = { ...WAITING, running: true, line: 'Edit' }

function props(workers: RowCard[], over: Partial<FlowProps> = {}): FlowProps {
  return {
    lead: WAITING,
    plan: { title: 'PLAN · executing · wave 2', done: 4, total: 5, counts: 'running 2   failed 0' },
    leadsLabel: 'Haiku 5.5 · leads only',
    leads: [],
    feed: 'leads → lead audits → workers',
    delegate: 'delegate to workers · Opus 5.5',
    workers,
    back: { title: 'back to Fable 5.2 · lead', line: 'review + verify · 1 in', active: false },
    ...over,
  }
}

function at(state: FlowState, frame: number): FlowState {
  return { ...state, frame }
}

function settled(cards: RowCard[], lead: FlowLead = WAITING, leads: RowCard[] = []): FlowState {
  return at(reconcileFlow(undefined, { lead, workers: cards, leads }), 50)
}

// ---- a rough painter for the drawn tree: column Boxes stack, row Boxes sit side by side, marginLeft shifts
type Node = { type: string; props: Record<string, unknown> }
const BORDERS: Record<string, [string, string, string, string, string, string]> = {
  round: ['╭', '╮', '╰', '╯', '─', '│'],
  bold: ['┏', '┓', '┗', '┛', '━', '┃'],
  double: ['╔', '╗', '╚', '╝', '═', '║'],
}

function kidsOf(n: Node): unknown[] {
  const c = n.props.children
  const flat = (x: unknown): unknown[] => (Array.isArray(x) ? x.flatMap(flat) : x === null || x === undefined || x === false ? [] : [x])
  return flat(c)
}

function textOf(n: unknown): string {
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (n && typeof n === 'object') return kidsOf(n as Node).map(textOf).join('')
  return ''
}

function widthOf(n: unknown): number {
  if (typeof n === 'string') return [...n].length
  const node = n as Node
  const ml = typeof node.props.marginLeft === 'number' ? node.props.marginLeft : 0
  if (typeof node.props.width === 'number') return ml + node.props.width
  if (node.type === 'Text' || node.type === 'Button') return [...textOf(node)].length
  const kids = kidsOf(node)
  if ((node.props.flexDirection ?? 'row') === 'row') return ml + kids.reduce<number>((a, k) => a + widthOf(k), 0)
  return ml + Math.max(0, ...kids.map(widthOf))
}

/** Lines of the node, without its margin, each as wide as it draws. */
function paint(n: unknown): string[] {
  if (typeof n === 'string') return [n]
  const node = n as Node
  if (node.type === 'Text' || node.type === 'Button') return [textOf(node)]
  const p = node.props
  const kids = kidsOf(node)
  const border = typeof p.borderStyle === 'string' ? BORDERS[p.borderStyle] ?? BORDERS.round! : null
  const px = typeof p.paddingX === 'number' ? p.paddingX : 0
  const w = typeof p.width === 'number' ? p.width : null
  let lines: string[] = []
  if ((p.flexDirection ?? 'row') === 'row') {
    const cols = kids.map(k => {
      const kn = k as Node
      const ml = typeof kn.props?.marginLeft === 'number' ? (kn.props.marginLeft as number) : 0
      const lw = widthOf(k) - ml
      return { ml, lw, lines: paint(k).map(l => ' '.repeat(ml) + padTo(l, lw)) }
    })
    const h = Math.max(0, ...cols.map(c => c.lines.length))
    for (let i = 0; i < h; i++) lines.push(cols.map(c => c.lines[i] ?? ' '.repeat(c.ml + c.lw)).join(''))
  } else {
    for (const k of kids) {
      const kn = k as Node
      const ml = typeof kn.props?.marginLeft === 'number' ? (kn.props.marginLeft as number) : 0
      lines.push(...paint(k).map(l => ' '.repeat(ml) + l))
    }
  }
  if (w !== null) {
    const inner = Math.max(0, w - (border ? 2 : 0) - px * 2)
    lines = lines.map(l => ' '.repeat(px) + padTo(l, inner) + ' '.repeat(px))
    if (border) {
      const [tl, tr, bl, br, hz, vt] = border
      lines = [tl + hz.repeat(Math.max(0, w - 2)) + tr, ...lines.map(l => vt + l + vt), bl + hz.repeat(Math.max(0, w - 2)) + br]
    }
  }
  return lines
}

function padTo(s: string, w: number): string {
  const chars = [...s]
  return chars.length >= w ? chars.slice(0, w).join('') : s + ' '.repeat(w - chars.length)
}

function fakeSurface(columns: number): any {
  const mk = (type: string) => (p: Record<string, unknown>) => ({ type, props: p })
  return {
    elements: { Box: mk('Box'), Text: mk('Text'), Button: mk('Button') },
    columns,
    rows: 40,
    state: undefined,
    setState() {},
    post() {},
    every() { return () => {} },
  }
}

function picture(state: FlowState, p: FlowProps, columns: number): string[] {
  return paint(drawFlow(fakeSurface(columns), state, p)).map(l => l.replace(/ +$/, ''))
}

function show(lines: string[]): void {
  ;(globalThis as unknown as { console?: { log: (s: string) => void } }).console?.log(lines.join('\n'))
}

function walk(n: unknown, visit: (n: Node) => void): void {
  if (!n || typeof n !== 'object') return
  visit(n as Node)
  for (const k of kidsOf(n as Node)) walk(k, visit)
}

// ---- railLine

describe('railLine', () => {
  test('one card on the trunk is a plain stem', () => {
    expect(railLine([10], 10, 21, 'out')).toBe(' '.repeat(10) + '│' + ' '.repeat(10))
    expect(railLine([10], 10, 21, 'in')).toBe(' '.repeat(10) + '│' + ' '.repeat(10))
  })

  test('two cards either side of the trunk', () => {
    expect(railLine([4, 16], 10, 21, 'out')).toBe('    ┌─────┴─────┐    ')
    expect(railLine([4, 16], 10, 21, 'in')).toBe('    └─────┬─────┘    ')
  })

  test('three cards, the middle one on the trunk', () => {
    expect(railLine([2, 10, 18], 10, 21, 'out')).toBe('  ┌───────┼───────┐  ')
    expect(railLine([2, 10, 18], 10, 21, 'in')).toBe('  └───────┼───────┘  ')
  })

  test('three cards with the trunk between two of them', () => {
    expect(railLine([2, 8, 18], 12, 21, 'out')).toBe('  ┌─────┬───┴─────┐  ')
    expect(railLine([2, 8, 18], 12, 21, 'in')).toBe('  └─────┴───┬─────┘  ')
  })

  test('the trunk on an end card', () => {
    expect(railLine([5, 12], 5, 16, 'out')).toBe('     ├──────┐   ')
    expect(railLine([5, 12], 12, 16, 'in')).toBe('     └──────┤   ')
  })

  test('the trunk outside the cards on either side', () => {
    expect(railLine([8, 12], 2, 16, 'out')).toBe('  └─────┬───┐   ')
    expect(railLine([3, 6], 12, 16, 'out')).toBe('   ┌──┬─────┘   ')
    expect(railLine([8, 12], 2, 16, 'in')).toBe('  ┌─────┴───┘   ')
    expect(railLine([3, 6], 12, 16, 'in')).toBe('   └──┴─────┐   ')
  })

  test('always exactly columns characters', () => {
    for (const columns of [1, 14, 30, 61, 100]) {
      for (const centres of [[], [0], [columns - 1], [1, columns - 2], [3, 7, 11]]) {
        expect([...railLine(centres, Math.floor(columns / 2), columns, 'out')].length).toBe(columns)
        expect([...railLine(centres, Math.floor(columns / 2), columns, 'in')].length).toBe(columns)
      }
    }
    expect(railLine([1], 0, 0, 'out')).toBe('')
  })
})

// ---- layoutFlow

describe('layoutFlow', () => {
  const mixes = [1, 0.36, 0.64, 0.84, 0.96, 0.99, 0.5, 0.04, 0.2]
  const extent = (l: { x: number; width: number }[]) => {
    const live = l.filter(c => c.width > 0)
    if (live.length === 0) return { lo: 0, hi: 0 }
    return { lo: live[0]!.x, hi: live[live.length - 1]!.x + live[live.length - 1]!.width }
  }

  test('never past the columns, gaps between cards with a width, integer widths', () => {
    for (const columns of [14, 30, 60, 100, 200]) {
      for (let n = 1; n <= 9; n++) {
        for (const weights of [Array(n).fill(1), mixes.slice(0, n), mixes.slice(9 - n)]) {
          const l = layoutFlow(weights, columns)
          expect(l.length).toBe(Math.min(n, perRowOf(columns)))
          let end = -1
          for (const c of l) {
            expect(Number.isInteger(c.width) && c.width >= 0 && Number.isInteger(c.x) && c.x >= 0).toBe(true)
            if (c.width === 0) continue
            if (end >= 0) expect(c.x).toBe(end + 1) // one gap
            end = c.x + c.width
            expect(end <= columns).toBe(true)
          }
        }
      }
    }
  })

  test('the row is centred', () => {
    for (const columns of [30, 60, 100, 200]) {
      for (let n = 1; n <= 4; n++) {
        const l = layoutFlow(Array(n).fill(1), columns)
        const { lo, hi } = extent(l)
        expect(Math.abs(lo - (columns - hi)) <= 1).toBe(true)
      }
    }
  })

  test('settled cards are MAX_CARD wide when there is room, at least MIN_CARD when they fit', () => {
    expect(layoutFlow([1, 1, 1], 100).map(c => c.width)).toEqual([MAX_CARD, MAX_CARD, MAX_CARD])
    expect(layoutFlow([1, 1, 1], 100)).toEqual([{ x: 13, width: 24 }, { x: 38, width: 24 }, { x: 63, width: 24 }])
    for (const columns of [14, 30, 60, 100]) {
      const per = perRowOf(columns)
      for (const c of layoutFlow(Array(per).fill(1), columns)) expect(c.width >= MIN_CARD).toBe(true)
    }
  })

  test('the +N more rule: perRow - 1 cards and one more card; one per row shows just the first', () => {
    expect(perRowOf(14)).toBe(1)
    expect(perRowOf(29)).toBe(2)
    expect(perRowOf(60)).toBe(4)
    expect(layoutFlow(Array(9).fill(1), 60).length).toBe(4)
    expect(layoutFlow(Array(4).fill(1), 60).length).toBe(4)
    expect(layoutFlow(Array(3).fill(1), 14)).toEqual([{ x: 0, width: 14 }])
    // the more card takes a full weight even while the cards before it enter
    const l = layoutFlow([0.36, 0.36, 0.36, 0.36, 0.36], 60)
    expect(l.length).toBe(4)
    expect(l[3]!.width >= l[0]!.width).toBe(true)
  })

  test('shownCards names the more card with the hidden count', () => {
    const s = settled(['a', 'b', 'c', 'd', 'e', 'f'].map(id => card(id)))
    const shown = shownCards(s, 60, 'workers')
    expect(shown.map(e => e.id)).toEqual(['a', 'b', 'c', 'more'])
    expect(shown[3]!.more).toBe(3)
    expect(shown[3]!.slot).toBe(null)
  })

  test('a card of width 0 takes no gap; no weights, no cards', () => {
    expect(layoutFlow([1, 0], 100)).toEqual([{ x: 38, width: 24 }, { x: 62, width: 0 }])
    expect(layoutFlow([], 80)).toEqual([])
  })
})

// ---- the bars, the dots, shimmer

describe('barText', () => {
  test('running sweeps a 3-cell window one cell a frame, wrapping', () => {
    expect(barText('running', 8, 0)).toBe('███▒▒▒▒▒')
    expect(barText('running', 8, 1)).toBe('▒███▒▒▒▒')
    expect(barText('running', 8, 6)).toBe('█▒▒▒▒▒██')
    expect(barText('running', 8, 8)).toBe('███▒▒▒▒▒')
  })

  test('the settled statuses', () => {
    expect(barText('quiet', 4, 3)).toBe('▒▒▒▒')
    expect(barText('waiting', 4, 3)).toBe('░░░░')
    expect(barText('done', 4, 3)).toBe('████')
    expect(barText('failed', 4, 3)).toBe('████')
    expect(barText('stopped', 4, 3)).toBe('░░░░')
    expect(barText('done', 0, 3)).toBe('')
  })

  test('the plan bar fills its share and fits its line', () => {
    const segs = planUnitsSegs(4, 5, 30)
    expect(segs.map(s => s.text).join('').length).toBe(30)
    expect(segs[1]!.text.length + segs[2]!.text.length).toBe(30 - 6 - 5)
    expect(segs[1]!.color).toBe('success')
    expect(planUnitsSegs(0, 0, 30)).toEqual([{ text: 'no units declared', dim: true }])
    expect(planUnitsSegs(1, 2, 4)[2]!.text.length + planUnitsSegs(1, 2, 4)[1]!.text.length).toBe(4)
  })
})

describe('dotAt', () => {
  test('one cell a frame toward the target, then null', () => {
    expect([0, 1, 2, 3, 4].map(s => dotAt(10, 13, s))).toEqual([10, 11, 12, 13, null])
    expect([0, 1, 2, 3].map(s => dotAt(10, 8, s))).toEqual([10, 9, 8, null])
    expect(dotAt(5, 5, 0)).toBe(5)
    expect(dotAt(5, 5, 1)).toBe(null)
    expect(dotAt(5, 9, -1)).toBe(null)
  })
})

describe('shimmerAt', () => {
  test('sweeps one character per frame over length + 3 frames, then rests 10', () => {
    const starts = []
    for (let f = 0; f < 6 + 3 + 10; f++) starts.push(shimmerAt(6, f))
    expect(starts.slice(0, 9)).toEqual([-2, -1, 0, 1, 2, 3, 4, 5, 6])
    expect(starts.slice(9).every(s => s === null)).toBe(true)
  })
})

// ---- reconcile, prune, weight

describe('reconcileFlow', () => {
  test('first cards get slots at frame 0, in order; the lead is kept', () => {
    const s = reconcileFlow(undefined, { lead: RUNNING, workers: [card('a'), card('b')] })
    expect(s.frame).toBe(0)
    expect(s.order).toEqual(['a', 'b'])
    expect(s.slots.a).toEqual({ card: card('a'), bornAt: 0, goneAt: null, changedAt: 0 })
    expect(s.lead).toEqual(RUNNING)
    expect(s.dots.workers).toEqual({ out: null, inn: null, sent: [], inPending: false })
    expect(s.dots.leads).toEqual({ out: null, inn: null, sent: [], inPending: false })
  })

  test('the same object when nothing changed, lead included', () => {
    const s = reconcileFlow(undefined, { lead: WAITING, workers: [card('a')] })
    expect(reconcileFlow(s, { lead: { ...WAITING }, workers: [card('a')] })).toBe(s)
    const l = reconcileFlow(s, { lead: RUNNING, workers: [card('a')] })
    expect(l).not.toBe(s)
    expect(l.lead.running).toBe(true)
    expect(l.slots).toEqual(s.slots)
  })

  test('a status change sets changedAt; another field change does not', () => {
    const s = at(reconcileFlow(undefined, { lead: WAITING, workers: [card('a')] }), 4)
    const n = reconcileFlow(s, { lead: WAITING, workers: [card('a', { status: 'done' })] })
    expect(n.slots.a!.changedAt).toBe(4)
    const m = reconcileFlow(at(n, 9), { lead: WAITING, workers: [card('a', { status: 'done', line: 'done · 2m' })] })
    expect(m.slots.a!.card.line).toBe('done · 2m')
    expect(m.slots.a!.changedAt).toBe(4)
  })

  test('a missing card starts leaving; a returning one is born again', () => {
    const s = at(reconcileFlow(undefined, { lead: WAITING, workers: [card('a'), card('b')] }), 6)
    const n = reconcileFlow(s, { lead: WAITING, workers: [card('a')] })
    expect(n.slots.b!.goneAt).toBe(6)
    expect(reconcileFlow(at(n, 8), { lead: WAITING, workers: [card('a')] }).slots.b!.goneAt).toBe(6)
    const back = reconcileFlow(at(n, 9), { lead: WAITING, workers: [card('a'), card('b')] })
    expect(back.slots.b!.goneAt).toBe(null)
    expect(back.slots.b!.bornAt).toBe(9)
  })

  test('a card is seven rows high', () => {
    expect(CARD_HEIGHT).toBe(7)
  })
})

describe('pruneFlow', () => {
  test('drops a slot once its exit is over, not before; the same object when nothing drops', () => {
    const s = at(reconcileFlow(undefined, { lead: WAITING, workers: [card('a'), card('b')] }), 10)
    const gone = reconcileFlow(s, { lead: WAITING, workers: [card('a')] })
    const early = at(gone, 10 + EXIT_FRAMES - 1)
    expect(pruneFlow(early)).toBe(early)
    const late = pruneFlow(at(gone, 10 + EXIT_FRAMES))
    expect(late.order).toEqual(['a'])
    expect(late.slots.b).toBe(undefined)
  })

  test('idle once every slot is pruned and the lead waits', () => {
    const s = reconcileFlow(undefined, { lead: WAITING, workers: [card('a')] })
    const gone = reconcileFlow(s, { lead: WAITING, workers: [] })
    expect(isIdle(gone)).toBe(false)
    expect(isIdle(pruneFlow(at(gone, EXIT_FRAMES)))).toBe(true)
    expect(isIdle(reconcileFlow(undefined, { lead: RUNNING, workers: [] }))).toBe(false)
  })
})

describe('weightOf', () => {
  const slot = (bornAt: number, goneAt: number | null): Slot => ({ card: card('a'), bornAt, goneAt, changedAt: bornAt })
  test('eases in to 1 and out to 0', () => {
    expect(weightOf(slot(0, null), 0) > 0).toBe(true)
    expect(weightOf(slot(0, null), ENTER_FRAMES - 1)).toBe(1)
    expect(weightOf(slot(0, 20), 20 + EXIT_FRAMES)).toBe(0)
  })
})

// ---- the clock

describe('isStill', () => {
  test('settled waiting cards and a waiting lead are still', () => {
    expect(isStill(settled([card('a', { status: 'waiting' })]))).toBe(true)
    expect(isStill(settled([]))).toBe(true)
  })

  test('a running lead is not still, even with no cards', () => {
    expect(isStill(settled([], RUNNING))).toBe(false)
    expect(isStill(settled([card('a', { status: 'waiting' })], RUNNING))).toBe(false)
  })

  test('a running, entering, flashing or leaving card is not still', () => {
    expect(isStill(settled([card('a')]))).toBe(false)
    const w = settled([card('a', { status: 'waiting' })])
    expect(isStill(at(w, 2))).toBe(false)
    const done = reconcileFlow(w, { lead: WAITING, workers: [card('a', { status: 'done' })] })
    expect(isStill(done)).toBe(false)
    const gone = reconcileFlow(w, { lead: WAITING, workers: [] })
    expect(isStill(gone)).toBe(false)
  })

  test('a travelling fan-in dot is not still', () => {
    const w = settled([card('a', { status: 'waiting' })])
    expect(isStill({ ...w, dots: { ...w.dots, workers: { ...w.dots.workers, inn: { id: 'a', start: 50 } } } })).toBe(false)
    expect(isStill({ ...w, dots: { ...w.dots, workers: { ...w.dots.workers, inPending: true } } })).toBe(false)
  })
})

describe('advanceFlow', () => {
  test('the fan-out dot travels from the trunk to a running card, then to the next one', () => {
    const s = settled([card('a'), card('b', { status: 'waiting' }), card('c')])
    const shown = shownCards(s, 60, 'workers')
    const trunk = 30
    let n = advanceFlow(s, 60)
    expect(n.dots.workers.out).toEqual({ id: 'a', start: 51 })
    const steps = Math.abs(shown[0]!.centre - trunk)
    for (let i = 0; i < steps + 1; i++) n = advanceFlow(n, 60)
    expect(n.dots.workers.out!.id).toBe('c')
    for (let i = 0; i < Math.abs(shown[2]!.centre - trunk) + 1; i++) n = advanceFlow(n, 60)
    expect(n.dots.workers.out!.id).toBe('a')
  })

  test('a done card sends one fan-in dot, then the diagram goes still', () => {
    const w = settled([card('a', { status: 'waiting' }), card('b', { status: 'waiting' })])
    let n = reconcileFlow(w, { lead: WAITING, workers: [card('a', { status: 'done' }), card('b', { status: 'waiting' })] })
    n = advanceFlow(n, 60)
    expect(n.dots.workers.inn).toEqual({ id: 'a', start: 51 })
    expect(n.dots.workers.sent).toEqual(['a'])
    let frames = 0
    while (!isStill(n) && frames < 100) {
      n = advanceFlow(n, 60)
      frames++
    }
    expect(isStill(n)).toBe(true)
    expect(n.dots.workers.inn).toBe(null)
    // the dot shows on the trunk on its last frame, then is gone
    expect(frames).toBe(Math.abs(shownCards(n, 60, 'workers')[0]!.centre - 30) + 1)
  })

  test('two cards finishing together send their dots one after the other', () => {
    const w = settled([card('a', { status: 'waiting' }), card('b', { status: 'waiting' })])
    let n = reconcileFlow(w, { lead: WAITING, workers: [card('a', { status: 'done' }), card('b', { status: 'failed' })] })
    n = advanceFlow(n, 60)
    expect(n.dots.workers.inn!.id).toBe('a')
    expect(n.dots.workers.inPending).toBe(true)
    while (n.dots.workers.inn?.id === 'a') n = advanceFlow(n, 60)
    expect(n.dots.workers.inn!.id).toBe('b')
    expect(n.dots.workers.inPending).toBe(false)
  })
})

// ---- drawing

describe('drawFlow', () => {
  const three = [card('a'), card('b', { status: 'done' }), card('c', { status: 'waiting' })]

  test('at 60 columns with 3 cards the rail junctions sit on the cards\' centres', () => {
    const s = settled(three)
    const lines = picture(s, props(three), 60)
    show(lines)
    const centres = shownCards(s, 60, 'workers').map(e => e.centre)
    const junction = (line: string, chars: string) => [...line].map((ch, i) => (chars.includes(ch) ? i : -1)).filter(i => i >= 0)
    const out = lines.find(l => /[┌┐]/.test(l))!
    const inn = lines.find(l => /[└┘]/.test(l) && !l.includes('╰'))!
    expect(junction(out, '┌┐┬┼├┤')).toEqual(centres)
    expect(junction(inn, '└┘┴┼├┤')).toEqual(centres)
    const arrows = lines.find(l => l.includes('▼'))!
    expect(junction(arrows, '▼')).toEqual(centres)
    // the trunk junctions sit on the centre column
    expect([...out].indexOf('┴') === 30 || [...out][30] === '┼').toBe(true)
    // the cards' top borders start at their x
    const top = lines.find(l => l.includes('╭') && l.split('╭').length > 3)!
    expect(junction(top, '╭')).toEqual(shownCards(s, 60, 'workers').map(e => e.x))
    for (const l of lines) expect([...l].length <= 60).toBe(true)
  })

  test('a card press posts its id; the cards hold five lines in a seven-row box', () => {
    const s = settled(three)
    const surface = fakeSurface(60)
    const posted: unknown[] = []
    surface.post = (d: unknown) => posted.push(d)
    const tree = drawFlow(surface, s, props(three))
    const buttons: Node[] = []
    walk(tree, n => { if (n.type === 'Button') buttons.push(n) })
    expect(buttons.map(b => b.props.key)).toEqual(['card-a', 'card-b', 'card-c'])
    ;(buttons[1]!.props.onPress as () => void)()
    expect(posted).toEqual([{ select: 'b' }])
    const lines = picture(s, props(three), 60)
    const top = lines.findIndex(l => l.includes('╭') && l.split('╭').length > 3)
    expect(lines[top + CARD_HEIGHT - 1]!.split('╰').length).toBe(4)
  })

  test('no workers: one stem between the plan and the return box', () => {
    const lines = picture(settled([]), props([]), 60)
    show(lines)
    expect(lines.some(l => l.includes('▼'))).toBe(false)
    expect(lines.some(l => l.includes('delegate'))).toBe(false)
    expect(lines.filter(l => l.trim() === '│').length).toBe(2) // lead-plan and plan-back
    expect(lines.some(l => l.includes('back to Fable'))).toBe(true)
  })

  test('nothing wider than the pane, from 1 to 200 columns, more cards than fit', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((id, i) => card(id, { status: i % 2 ? 'done' : 'running' }))
    for (const columns of [1, 8, 13, 14, 20, 30, 45, 60, 100, 200]) {
      const s = settled(many, RUNNING)
      const lines = picture(s, props(many), columns)
      for (const l of lines) expect([...l].length <= columns).toBe(true)
      const per = perRowOf(columns)
      expect(lines.some(l => /\+\d+ more/.test(l))).toBe(per > 1 && per < many.length)
      if (per > 1 && per < many.length) expect(lines.some(l => l.includes(`+${many.length - per + 1} more`))).toBe(true)
    }
  })

  test('below 14 columns only the lead box and the cards row', () => {
    const lines = picture(settled([card('a')]), props([card('a')]), 13)
    expect(lines.some(l => l.includes('PLAN'))).toBe(false)
    expect(lines.some(l => l.includes('▼'))).toBe(false)
    expect(lines.length).toBe(5 + CARD_HEIGHT)
  })

  test('the fan-out dot is drawn on the rail', () => {
    let s = settled(three)
    s = advanceFlow(s, 60)
    s = advanceFlow(s, 60)
    const lines = picture(s, props(three), 60)
    const rail = lines.find(l => l.includes('●'))!
    expect([...rail].indexOf('●')).toBe(29) // one step left of the trunk toward card a
  })
})


// ---- the leads row

function keysOf(tree: unknown): unknown[] {
  return kidsOf(tree as Node).map(k => (k as Node).props.key)
}

describe('leads: state', () => {
  test('reconcileFlow takes leads and workers into one order, leads first', () => {
    const s = reconcileFlow(undefined, { lead: WAITING, workers: [card('a'), card('b')], leads: [lead('l1'), lead('l2')] })
    expect(s.order).toEqual(['l1', 'l2', 'a', 'b'])
    expect(s.slots.l1!.card.row).toBe('leads')
    expect(s.slots.a!.card.row).toBe('workers')
  })

  test('a warn, row or tier change is a change', () => {
    const s = reconcileFlow(undefined, { lead: WAITING, workers: [], leads: [lead('l')] })
    expect(reconcileFlow(s, { lead: WAITING, workers: [], leads: [lead('l')] })).toBe(s)
    const w = reconcileFlow(s, { lead: WAITING, workers: [], leads: [lead('l', { warn: true })] })
    expect(w).not.toBe(s)
    expect(w.slots.l!.card.warn).toBe(true)
    const r = reconcileFlow(s, { lead: WAITING, workers: [lead('l', { row: 'workers' })], leads: [] })
    expect(r).not.toBe(s)
    expect(r.slots.l!.card.row).toBe('workers')
    const t = reconcileFlow(s, { lead: WAITING, workers: [], leads: [lead('l', { tier: 'sonnet' })] })
    expect(t).not.toBe(s)
    expect(t.slots.l!.card.tier).toBe('sonnet')
  })

  test('shownCards lays out one row; a card with no row is a workers card', () => {
    const bare: Partial<RowCard> = card('b')
    delete bare.row
    const s = at(reconcileFlow(undefined, { lead: WAITING, workers: [card('a'), bare as RowCard], leads: [lead('l')] }), 50)
    expect(shownCards(s, 60, 'leads').map(e => e.id)).toEqual(['l'])
    expect(shownCards(s, 60, 'workers').map(e => e.id)).toEqual(['a', 'b'])
    const many = settled([], WAITING, ['l1', 'l2', 'l3', 'l4', 'l5'].map(id => lead(id)))
    expect(shownCards(many, 60, 'leads').map(e => e.id)).toEqual(['l1', 'l2', 'l3', 'more-leads'])
    expect(shownCards(many, 60, 'workers')).toEqual([])
  })

  test('a card with no row given to leads is still drawn in the workers row', () => {
    const bare: Partial<RowCard> = lead('x')
    delete bare.row
    const s = settled([], WAITING, [bare as RowCard])
    expect(shownCards(s, 60, 'leads')).toEqual([])
    expect(shownCards(s, 60, 'workers').map(e => e.id)).toEqual(['x'])
    const keys = keysOf(drawFlow(fakeSurface(60), s, props([], { leads: [bare as RowCard] })))
    expect(keys.includes('leads-cards')).toBe(false)
    expect(keys.includes('cards')).toBe(true)
  })

  test('advanceFlow runs each row\'s dots on their own', () => {
    const s = settled([card('a')], WAITING, [lead('l')])
    const n = advanceFlow(s, 60)
    expect(n.dots.workers.out).toEqual({ id: 'a', start: 51 })
    expect(n.dots.leads.out).toEqual({ id: 'l', start: 51 })
  })

  test('a done leads card sends one leads fan-in dot, once', () => {
    const w = settled([card('a', { status: 'waiting' })], WAITING, [lead('l', { status: 'waiting' })])
    let n = reconcileFlow(w, { lead: WAITING, workers: [card('a', { status: 'waiting' })], leads: [lead('l', { status: 'done' })] })
    n = advanceFlow(n, 60)
    expect(n.dots.leads.inn).toEqual({ id: 'l', start: 51 })
    expect(n.dots.leads.sent).toEqual(['l'])
    expect(n.dots.workers.inn).toBe(null)
    expect(n.dots.workers.sent).toEqual([])
    for (let i = 0; i < 100; i++) {
      n = advanceFlow(n, 60)
      if (n.dots.leads.inn !== null) expect(n.dots.leads.inn.start).toBe(51)
    }
    expect(n.dots.leads.inn).toBe(null)
    expect(n.dots.leads.sent).toEqual(['l'])
    expect(isStill(n)).toBe(true)
  })

  test('isStill is false while a leads fan-in dot travels or is pending', () => {
    const w = settled([], WAITING, [lead('l', { status: 'waiting' })])
    expect(isStill(w)).toBe(true)
    expect(isStill({ ...w, dots: { ...w.dots, leads: { ...w.dots.leads, inPending: true } } })).toBe(false)
    expect(isStill({ ...w, dots: { ...w.dots, leads: { ...w.dots.leads, inn: { id: 'l', start: 50 } } } })).toBe(false)
  })
})

describe('leads: drawFlow', () => {
  const workers = [card('a'), card('b', { status: 'done' })]
  const leads = [lead('l'), lead('t', { status: 'done', warn: true, model: 'Haiku 5.5 · no audit' })]

  function nodes(tree: unknown): { texts: Node[]; boxes: Record<string, Node> } {
    const texts: Node[] = []
    const boxes: Record<string, Node> = {}
    walk(tree, n => {
      if (n.type === 'Text') texts.push(n)
      if (n.type === 'Box' && typeof n.props.key === 'string') boxes[n.props.key] = n
    })
    return { texts, boxes }
  }
  function arrowColors(boxes: Record<string, Node>, key: string): unknown[] {
    const out: unknown[] = []
    walk(boxes[key], n => { if (n.type === 'Text' && textOf(n) === '▼') out.push(n.props.color) })
    return out
  }

  test('no leads: the same rows as before', () => {
    const tree = drawFlow(fakeSurface(60), settled(workers), props(workers))
    expect(keysOf(tree)).toEqual(['lead', 'stem-plan', 'plan', 'delegate', 'rail-out', 'arrows', 'cards', 'rail-in', 'back'])
    const none = drawFlow(fakeSurface(60), settled([]), props([]))
    expect(keysOf(none)).toEqual(['lead', 'stem-plan', 'plan', 'stem-back', 'back'])
    // props with no leads fields at all
    const old = props(workers) as Partial<FlowProps>
    delete old.leads
    delete old.leadsLabel
    delete old.feed
    expect(keysOf(drawFlow(fakeSurface(60), settled(workers), old as FlowProps))).toEqual(keysOf(tree))
  })

  test('leads and workers: the leads row between the plan and the workers', () => {
    const tree = drawFlow(fakeSurface(60), settled(workers, WAITING, leads), props(workers, { leads }))
    expect(keysOf(tree)).toEqual([
      'lead', 'stem-plan', 'plan',
      'leads-label', 'leads-rail-out', 'leads-arrows', 'leads-cards', 'leads-rail-in', 'feed',
      'stem-workers',
      'delegate', 'rail-out', 'arrows', 'cards', 'rail-in', 'back',
    ])
    const lines = picture(settled(workers, WAITING, leads), props(workers, { leads }), 60)
    show(lines)
    expect(lines.some(l => l.includes('Haiku 5.5 · leads only'))).toBe(true)
    expect(lines.some(l => l.includes('leads → lead audits → workers'))).toBe(true)
    // a stem between the feed label and the delegate label
    const feedAt = lines.findIndex(l => l.includes('leads → lead audits → workers'))
    expect(lines[feedAt + 1]!.trim()).toBe('│')
    expect(lines[feedAt + 2]!.includes('delegate to workers')).toBe(true)
  })

  test('only leads or only workers: no stem-workers row', () => {
    const onlyLeads = keysOf(drawFlow(fakeSurface(60), settled([], WAITING, leads), props([], { leads })))
    expect(onlyLeads.includes('stem-workers')).toBe(false)
    const onlyWorkers = keysOf(drawFlow(fakeSurface(60), settled(workers), props(workers)))
    expect(onlyWorkers.includes('stem-workers')).toBe(false)
    const narrow = keysOf(drawFlow(fakeSurface(13), settled(workers, WAITING, leads), props(workers, { leads })))
    expect(narrow.includes('stem-workers')).toBe(false)
  })

  test('leads and no workers: the leads row, then the stem back', () => {
    const tree = drawFlow(fakeSurface(60), settled([], WAITING, leads), props([], { leads }))
    expect(keysOf(tree)).toEqual([
      'lead', 'stem-plan', 'plan',
      'leads-label', 'leads-rail-out', 'leads-arrows', 'leads-cards', 'leads-rail-in', 'feed',
      'stem-back', 'back',
    ])
  })

  test('below 14 columns: the lead box, the leads cards and the worker cards only', () => {
    const tree = drawFlow(fakeSurface(13), settled(workers, WAITING, leads), props(workers, { leads }))
    expect(keysOf(tree)).toEqual(['lead', 'leads-cards', 'cards'])
    const only = drawFlow(fakeSurface(13), settled([], WAITING, leads), props([], { leads }))
    expect(keysOf(only)).toEqual(['lead', 'leads-cards'])
  })

  test('a warn card draws line 2 in the warning colour; a running haiku card is bordered bashBorder', () => {
    const tree = drawFlow(fakeSurface(60), settled(workers, WAITING, leads), props(workers, { leads }))
    const { texts, boxes } = nodes(tree)
    const warn = texts.find(t => textOf(t) === 'Haiku 5.5 · no audit')!
    expect(warn.props.color).toBe('warning')
    expect(warn.props.dimColor).toBe(undefined)
    const plain = texts.find(t => textOf(t) === 'Haiku 5.5 · locate')!
    expect(plain.props.dimColor).toBe(true)
    expect(plain.props.color).toBe(undefined)
    expect(boxes['slot-l']!.props.borderColor).toBe('bashBorder')
    expect(boxes['slot-a']!.props.borderColor).toBe('suggestion')
    expect(boxes['slot-t']!.props.borderColor).toBe('success')
    // the running haiku card's arrow is bashBorder, the running opus card's suggestion
    expect(arrowColors(boxes, 'leads-arrows').includes('bashBorder')).toBe(true)
    expect(arrowColors(boxes, 'arrows').includes('suggestion')).toBe(true)
    expect(arrowColors(boxes, 'arrows').includes('bashBorder')).toBe(false)
    expect(arrowColors(boxes, 'leads-arrows').includes('merged')).toBe(false)
  })

  test('a running sonnet card is ide, a running opus card beside it suggestion', () => {
    const ws = [card('o'), card('s', { tier: 'sonnet', model: 'Sonnet 5.5 · implement' })]
    const s = settled(ws)
    const { boxes } = nodes(drawFlow(fakeSurface(60), s, props(ws)))
    expect(boxes['slot-s']!.props.borderColor).toBe('ide')
    expect(boxes['slot-o']!.props.borderColor).toBe('suggestion')
    const arrows = arrowColors(boxes, 'arrows')
    expect(arrows).toEqual(['suggestion', 'ide'])
    // the bar takes the tier's colour too
    const bars = nodes(boxes['cards']).texts.filter(t => /^[█▒]+$/.test(textOf(t)))
    expect(bars.map(b => b.props.color)).toEqual(['suggestion', 'ide'])
    // settled statuses look the same for every tier
    const done = [card('o', { status: 'done' }), card('s', { tier: 'sonnet', status: 'done' })]
    const d = nodes(drawFlow(fakeSurface(60), settled(done), props(done))).boxes
    expect(d['slot-s']!.props.borderColor).toBe('success')
    expect(d['slot-o']!.props.borderColor).toBe('success')
  })

  test('a card with a null tier draws as suggestion', () => {
    const ws = [card('n', { tier: null })]
    const { boxes } = nodes(drawFlow(fakeSurface(60), settled(ws), props(ws)))
    expect(boxes['slot-n']!.props.borderColor).toBe('suggestion')
    expect(arrowColors(boxes, 'arrows')).toEqual(['suggestion'])
  })

  test('each row\'s fan-out dot has its own colour', () => {
    let s = settled([card('a')], WAITING, [lead('l')])
    s = advanceFlow(s, 60)
    s = advanceFlow(s, 60)
    const { boxes } = nodes(drawFlow(fakeSurface(60), s, props([card('a')], { leads: [lead('l')] })))
    const dotColor = (key: string): unknown[] => {
      const out: unknown[] = []
      walk(boxes[key], n => { if (n.type === 'Text' && textOf(n) === '●') out.push(n.props.color) })
      return out
    }
    expect(dotColor('leads-rail-out')).toEqual(['bashBorder'])
    expect(dotColor('rail-out')).toEqual(['suggestion'])
  })

  test('each row\'s more card has its own key', () => {
    const ws = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => card(id))
    const ls = ['l1', 'l2', 'l3', 'l4', 'l5'].map(id => lead(id))
    const tree = drawFlow(fakeSurface(60), settled(ws, WAITING, ls), props(ws, { leads: ls }))
    const keys: unknown[] = []
    walk(tree, n => { if (n.type === 'Box') keys.push(n.props.key) })
    expect(keys.includes('slot-more')).toBe(true)
    expect(keys.includes('slot-more-leads')).toBe(true)
  })

  test('nothing wider than the pane with both rows shown', () => {
    const ws = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => card(id, { status: i % 2 ? 'done' : 'running', tier: i % 3 === 1 ? 'sonnet' : 'opus' }))
    const ls = ['l1', 'l2', 'l3', 'l4', 'l5'].map((id, i) => lead(id, { status: i % 2 ? 'failed' : 'running', warn: i === 1 }))
    for (const columns of [20, 24, 48, 96]) {
      let s = settled(ws, RUNNING, ls)
      for (let i = 0; i < 5; i++) s = advanceFlow(s, columns)
      const p = props(ws, { leads: ls, leadsLabel: 'x'.repeat(200), feed: 'y'.repeat(200) })
      expect(keysOf(drawFlow(fakeSurface(columns), s, p)).includes('stem-workers')).toBe(true)
      const lines = picture(s, p, columns)
      for (const l of lines) expect([...l].length <= columns).toBe(true)
    }
  })
})

describe('card labels stay on one row', () => {
  const LONG = 'Implement the limiter for every single request'

  // The label row is a Box of height 1 that HOLDS the card's Button; the Button's own children are
  // Text only. (A Box inside a Button is refused by the terminal surface: the whole diagram then fails to draw.)
  function labelOf(cards: RowCard[], id: string): { row: Node; kids: Node[]; text: string; inner: number } {
    const tree = drawFlow(fakeSurface(100), settled(cards), props(cards))
    let slot: Node | undefined
    let row: Node | undefined
    let button: Node | undefined
    walk(tree, n => {
      if (n.type === 'Box' && n.props.key === `slot-${id}`) slot = n
      if (n.type === 'Box' && n.props.key === `label-${id}`) row = n
      if (n.type === 'Button' && n.props.key === `card-${id}`) button = n
    })
    return { row: row!, kids: kidsOf(button!) as Node[], text: textOf(button), inner: (slot!.props.width as number) - 4 }
  }

  for (const status of ['running', 'waiting', 'done'] as const) {
    test(`a ${status} card with a long label draws the inner width ending in an ellipsis, in one row`, () => {
      const { row, kids, text, inner } = labelOf([card('a', { status, label: LONG })], 'a')
      expect(row.props.height).toBe(1)
      expect((kidsOf(row) as Node[]).map(k => k.type)).toEqual(['Button'])
      expect(kids.length > 0).toBe(true)
      expect(kids.every(k => k.type === 'Text')).toBe(true)
      expect([...text].length).toBe(inner)
      expect(text.endsWith('…')).toBe(true)
      expect(text).toBe([...LONG].slice(0, inner - 1).join('') + '…')
    })
  }

  test('a label that fits is unchanged', () => {
    for (const status of ['running', 'waiting', 'done'] as const) {
      const { text, inner } = labelOf([card('a', { status, label: 'Do a' })], 'a')
      expect(inner >= 4).toBe(true)
      expect(text).toBe('Do a')
    }
    const exact = 'x'.repeat(20)
    expect(labelOf([card('a', { label: exact })], 'a').text).toBe(exact)
  })
})
