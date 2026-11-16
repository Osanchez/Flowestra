// Agent Board: the flow diagram (visual layer 0.4.0; two rows 0.5.0; three
// tiers 0.6.0), top to bottom: the lead's box, the plan box, then (while a
// leads card is shown) the leads row's label, fan-out rail, row of leads
// cards, fan-in rail and feed label, then a fan-out rail, one row of worker
// cards (no rail or box under the last row; 0.15.0). A surface module: runs on the terminal's drawing thread,
// animates on its own clock (`surface.every`), and posts `{ select: id }`
// when a card is pressed.
// Self-contained: only type imports, no value imports from sibling files.

import type { ClientModule, ClientSurface, RenderElement } from 'claude-code'

import type { FlowLead, FlowProps, Row, RowCard, RowCardStatus, RowPost, Tier } from '../types'

export type Slot = { card: RowCard; bornAt: number; goneAt: number | null; changedAt: number } // frames
/** A travelling dot: toward (fan-out) or from (fan-in) the card `id`, set off at frame `start`. */
export type Dot = { id: string; start: number }
/** One row's dots. */
export type TierDots = {
  out: Dot | null // the fan-out dot
  inn: Dot | null // the fan-in dot
  sent: string[] // done or failed cards whose fan-in dot has set off
  inPending: boolean // a shown done or failed card still has a fan-in dot to send
}
export type FlowState = {
  frame: number
  order: string[] // both rows, one flat list (ids are unique across rows)
  slots: Record<string, Slot> // a slot's row is slot.card.row
  lead: FlowLead
  dots: Record<Row, TierDots>
}

export const FRAME_MS = 80
export const ENTER_FRAMES = 5
export const EXIT_FRAMES = 5
export const MIN_CARD = 14
export const MAX_CARD = 24
export const GAP = 1
export const FLASH_FRAMES = 3
export const SHIMMER_WIDTH = 3
export const SHIMMER_REST = 10
export const CARD_HEIGHT = 7 // five text lines and the two border rows
export const BOX_WIDTH = 34 // the lead and plan boxes
export const BAR_WINDOW = 3 // the running bar's sweeping window
export const NARROW = 14 // below this many columns: the lead box and the cards only
export const MORE_ID = 'more'
export const LEADS_MORE_ID = 'more-leads'

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const NO_LEAD: FlowLead = { title: '', running: false, line: '', tokens: '' }

function noDots(): TierDots {
  return { out: null, inn: null, sent: [], inPending: false }
}

/** The row a card is drawn in; a card with no row is a workers card. */
function rowOf(card: RowCard): Row {
  return card.row === 'leads' ? 'leads' : 'workers'
}

/** A running card's colour, from its measured tier; a null or unknown tier draws as opus. */
function tierColor(tier: Tier | null | undefined): string {
  if (tier === 'haiku') return 'bashBorder'
  if (tier === 'sonnet') return 'ide'
  return 'suggestion'
}

function spin(frame: number): string {
  return SPINNER[((frame % SPINNER.length) + SPINNER.length) % SPINNER.length] ?? '⠋'
}

function sameCard(a: RowCard, b: RowCard): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.status === b.status &&
    a.line === b.line &&
    a.tokens === b.tokens &&
    a.selected === b.selected &&
    a.model === b.model &&
    a.row === b.row &&
    a.tier === b.tier &&
    a.warn === b.warn
  )
}

function sameLead(a: FlowLead, b: FlowLead): boolean {
  return a.title === b.title && a.running === b.running && a.line === b.line && a.tokens === b.tokens
}

/** Brings the slots and the lead in line with the props; the same object when nothing changed. */
export function reconcileFlow(state: FlowState | undefined, props: Pick<FlowProps, 'lead' | 'workers'> & Partial<Pick<FlowProps, 'leads'>>): FlowState {
  const cards = [...(props.leads ?? []), ...(props.workers ?? [])]
  const lead = props.lead ?? NO_LEAD
  const frame = state ? state.frame : 0
  const slots: Record<string, Slot> = state ? { ...state.slots } : {}
  const order: string[] = state ? [...state.order] : []
  let changed = state === undefined
  const present: Record<string, true> = {}

  for (const card of cards) {
    present[card.id] = true
    const slot = slots[card.id]
    if (slot === undefined) {
      slots[card.id] = { card, bornAt: frame, goneAt: null, changedAt: frame }
      order.push(card.id)
      changed = true
      continue
    }
    const returning = slot.goneAt !== null
    const statusChanged = slot.card.status !== card.status
    if (!returning && sameCard(slot.card, card)) continue
    slots[card.id] = {
      card,
      bornAt: returning ? frame : slot.bornAt,
      goneAt: null,
      changedAt: statusChanged ? frame : slot.changedAt,
    }
    changed = true
  }

  for (const id of order) {
    const slot = slots[id]
    if (present[id] || slot === undefined || slot.goneAt !== null) continue
    slots[id] = { ...slot, goneAt: frame }
    changed = true
  }

  const leadChanged = state === undefined || !sameLead(state.lead, lead)
  if (!changed && !leadChanged && state !== undefined) return state
  if (state === undefined) return { frame, order, slots, lead, dots: { leads: noDots(), workers: noDots() } }
  return { ...state, order, slots, lead: leadChanged ? lead : state.lead }
}

/** Drops the slots whose exit has finished; the same object when nothing dropped. */
export function pruneFlow(state: FlowState): FlowState {
  const drop = state.order.filter(id => {
    const slot = state.slots[id]
    return slot === undefined || (slot.goneAt !== null && state.frame - slot.goneAt >= EXIT_FRAMES)
  })
  if (drop.length === 0) return state
  const slots: Record<string, Slot> = { ...state.slots }
  for (const id of drop) delete slots[id]
  return { ...state, order: state.order.filter(id => slots[id] !== undefined), slots }
}

/** How much of its full width a card takes, 0..1: eased in on entry, eased out on exit. */
export function weightOf(slot: Slot, frame: number): number {
  const tIn = Math.min(1, Math.max(0, (frame - slot.bornAt + 1) / ENTER_FRAMES))
  let w = 1 - (1 - tIn) * (1 - tIn)
  if (slot.goneAt !== null) {
    const tOut = Math.max(0, (frame - slot.goneAt) / EXIT_FRAMES)
    w *= Math.max(0, 1 - tOut * tOut)
  }
  return w
}

/** How many cards fit on the one row at `columns`, gaps included. */
export function perRowOf(columns: number): number {
  return Math.max(1, Math.floor((columns + 1) / (MIN_CARD + GAP)))
}

/**
 * Each shown card's left column and integer width, the row centred in
 * `columns`. More slots than fit: the first perRow - 1, then one `+N more`
 * card (weight 1); one per row: the first card alone. A card of width 0 takes
 * no gap; the row never runs past `columns`.
 */
export function layoutFlow(weights: number[], columns: number): { x: number; width: number }[] {
  if (weights.length === 0) return []
  const per = perRowOf(columns)
  let ws: number[]
  if (weights.length <= per) ws = weights.slice()
  else if (per === 1) ws = weights.slice(0, 1)
  else ws = [...weights.slice(0, per - 1), 1]
  if (columns <= 0) return ws.map(() => ({ x: 0, width: 0 }))

  const sum = ws.reduce((a, b) => a + Math.max(0, b), 0)
  const live = ws.filter(w => w > 0).length
  const room = Math.max(0, columns - Math.max(0, live - 1) * GAP)
  const unit = Math.min(MAX_CARD, Math.floor(room / Math.max(sum, 1)))
  const widths = ws.map(w => Math.max(0, Math.round(unit * Math.max(0, w))))
  const total = (): number => {
    const n = widths.filter(w => w > 0).length
    return widths.reduce((a, b) => a + b, 0) + Math.max(0, n - 1) * GAP
  }
  // Take any excess off the last card with a width, then the ones before it.
  for (let guard = 0; total() > columns && guard < 1000; guard++) {
    let j = widths.length - 1
    while (j >= 0 && (widths[j] ?? 0) === 0) j--
    if (j < 0) break
    const have = widths[j] ?? 0
    widths[j] = have - Math.min(have, total() - columns)
  }

  let cursor = Math.floor((columns - total()) / 2)
  let placed = false
  return widths.map(width => {
    if (width > 0 && placed) cursor += GAP
    const x = cursor
    cursor += width
    if (width > 0) placed = true
    return { x, width }
  })
}

export function centreOf(x: number, width: number): number {
  return x + Math.floor(width / 2)
}

/**
 * One rail row, exactly `columns` characters: a `─` run from the leftmost to
 * the rightmost of the card centres and the trunk, cornered at the ends and
 * joined at each centre and at the trunk. `out`: the trunk comes from above,
 * the cards hang below; `in`: the cards sit above, the trunk leaves below.
 */
export function railLine(centres: number[], trunk: number, columns: number, kind: 'out' | 'in'): string {
  if (columns <= 0) return ''
  const clamp = (n: number): number => Math.max(0, Math.min(columns - 1, n))
  const t = clamp(trunk)
  const cs = new Set(centres.map(clamp))
  const cells = Array.from({ length: columns }, () => ' ')
  const all = [...cs, t]
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  if (lo === hi) {
    cells[t] = '│'
    return cells.join('')
  }
  const out = kind === 'out'
  for (let i = lo; i <= hi; i++) {
    const card = cs.has(i)
    const isTrunk = i === t
    let ch = '─'
    if (card && isTrunk) ch = i === lo ? '├' : i === hi ? '┤' : '┼'
    else if (card) ch = i === lo ? (out ? '┌' : '└') : i === hi ? (out ? '┐' : '┘') : out ? '┬' : '┴'
    else if (isTrunk) ch = i === lo ? (out ? '└' : '┌') : i === hi ? (out ? '┘' : '┐') : out ? '┴' : '┬'
    cells[i] = ch
  }
  return cells.join('')
}

/** The dot's column `step` frames after setting off from `from` toward `to`; null before it sets off and once it has arrived. */
export function dotAt(from: number, to: number, step: number): number | null {
  const d = Math.abs(to - from)
  if (step < 0 || step > d) return null
  return from + Math.sign(to - from) * step
}

/** A worker card's bar, `width` cells, at `frame`. */
export function barText(status: RowCardStatus, width: number, frame: number): string {
  if (width <= 0) return ''
  switch (status) {
    case 'running': {
      const p = ((frame % width) + width) % width
      let s = ''
      for (let i = 0; i < width; i++) s += (i - p + width) % width < BAR_WINDOW ? '█' : '▒'
      return s
    }
    case 'quiet': return '▒'.repeat(width)
    case 'waiting': return '░'.repeat(width)
    case 'done': return '█'.repeat(width)
    case 'failed': return '█'.repeat(width)
    case 'stopped': return '░'.repeat(width)
  }
}

/**
 * Start index of the 3-character shimmer window at `frame`, or null while it
 * rests: label length + 3 frames of sweep, then 10 of rest.
 */
export function shimmerAt(labelLength: number, frame: number): number | null {
  const sweep = labelLength + SHIMMER_WIDTH
  const cycle = sweep + SHIMMER_REST
  const p = ((frame % cycle) + cycle) % cycle
  return p < sweep ? p - (SHIMMER_WIDTH - 1) : null
}

/** One card as laid out: a slot's, or the synthetic `+N more` (slot null). */
export type Shown = { id: string; slot: Slot | null; more: number; x: number; width: number; centre: number }

/** The cards of one row as laid out at `columns`. */
export function shownCards(state: FlowState, columns: number, row: Row): Shown[] {
  const slots = state.order
    .map(id => state.slots[id])
    .filter((s): s is Slot => s !== undefined && rowOf(s.card) === row)
  const layout = layoutFlow(slots.map(s => weightOf(s, state.frame)), columns)
  const per = perRowOf(columns)
  const hasMore = slots.length > per && per > 1
  return layout.map((l, i) => {
    const isMore = hasMore && i === layout.length - 1
    const slot = isMore ? null : slots[i] ?? null
    return {
      id: slot ? slot.card.id : row === 'leads' ? LEADS_MORE_ID : MORE_ID,
      slot,
      more: isMore ? slots.length - (per - 1) : 0,
      x: l.x,
      width: l.width,
      centre: centreOf(l.x, l.width),
    }
  })
}

/** One frame on: the clock moves, finished exits drop, and each row's dots travel. */
export function advanceFlow(state: FlowState, columns: number): FlowState {
  const s = pruneFlow({ ...state, frame: state.frame + 1 })
  const trunk = Math.floor(columns / 2)
  const step = (row: Row): TierDots => {
    const shown = shownCards(s, columns, row).filter(e => e.slot !== null && e.width > 0)
    return stepDots(s, shown, s.dots[row], trunk)
  }
  return { ...s, dots: { leads: step('leads'), workers: step('workers') } }
}

/** One row's dots one frame on, over that row's shown cards (with a slot and a width). */
function stepDots(s: FlowState, shown: Shown[], dots: TierDots, trunk: number): TierDots {
  const frame = s.frame
  const byId = (id: string): Shown | undefined => shown.find(e => e.id === id)

  // fan-out: round robin over the running cards
  const running = shown.filter(e => e.slot !== null && e.slot.goneAt === null && e.slot.card.status === 'running')
  let out = dots.out
  if (running.length === 0) out = null
  else {
    const target = out ? running.find(e => e.id === out!.id) : undefined
    const arrived = !out || !target || dotAt(trunk, target.centre, frame - out.start) === null
    if (arrived) {
      const at = out ? running.findIndex(e => s.order.indexOf(e.id) > s.order.indexOf(out!.id)) : 0
      const next = running[at < 0 ? 0 : at] ?? running[0]
      out = next ? { id: next.id, start: frame } : null
    }
  }

  // fan-in: each shown done or failed card sends one dot to the trunk, one at a time
  const finished = (e: Shown): boolean =>
    e.slot !== null && e.slot.goneAt === null && (e.slot.card.status === 'done' || e.slot.card.status === 'failed')
  let sent = dots.sent.filter(id => {
    const st = s.slots[id]?.card.status
    return st === 'done' || st === 'failed'
  })
  let inn = dots.inn
  if (inn) {
    const src = byId(inn.id)
    if (!src || !finished(src) || dotAt(src.centre, trunk, frame - inn.start) === null) inn = null
  }
  const eligible = shown.filter(finished)
  if (!inn) {
    const next = eligible.find(e => !sent.includes(e.id))
    if (next) {
      inn = { id: next.id, start: frame }
      sent = [...sent, next.id]
    }
  }
  const inPending = eligible.some(e => !sent.includes(e.id))
  return { out, inn, sent, inPending }
}

/** Nothing on the diagram moves: no spinner, no card entering, leaving or flashing, no dot. The clock then draws nothing. */
export function isStill(state: FlowState): boolean {
  if (state.lead.running) return false
  for (const d of [state.dots.workers, state.dots.leads]) if (d.inn !== null || d.inPending) return false
  for (const slot of Object.values(state.slots)) {
    if (slot.goneAt !== null || slot.card.status === 'running') return false
    if (state.frame - slot.bornAt < ENTER_FRAMES || state.frame - slot.changedAt < FLASH_FRAMES) return false
  }
  return true
}

export function isIdle(state: FlowState): boolean {
  return state.order.length === 0 && Object.keys(state.slots).length === 0 && !state.lead.running
}

// ---- drawing

/** A run of text with one style. */
export type Seg = { text: string; color?: string; dim?: boolean; bold?: boolean }

/** Cuts the segments to `width` characters in all. */
export function clipSegs(segs: Seg[], width: number): Seg[] {
  const res: Seg[] = []
  let left = Math.max(0, width)
  for (const seg of segs) {
    if (left <= 0) break
    const chars = [...seg.text]
    const text = chars.slice(0, left).join('')
    left -= Math.min(chars.length, left)
    if (text.length > 0) res.push({ ...seg, text })
  }
  return res
}

/** Leading spaces moved out into a margin, trailing spaces dropped. */
export function trimSegs(segs: Seg[]): { margin: number; segs: Seg[] } {
  let margin = 0
  const res = segs.map(s => ({ ...s }))
  while (res.length > 0) {
    const first = res[0]!
    const stripped = first.text.replace(/^ +/, '')
    margin += first.text.length - stripped.length
    if (stripped.length > 0) {
      first.text = stripped
      break
    }
    res.shift()
  }
  while (res.length > 0) {
    const last = res[res.length - 1]!
    last.text = last.text.replace(/ +$/, '')
    if (last.text.length > 0) break
    res.pop()
  }
  return { margin, segs: res }
}

/** A rail row as before / dot / after, the dot replacing the rail's character at `at`. */
export function railSegs(rail: string, at: number | null, color: string): Seg[] {
  if (at === null || at < 0 || at >= rail.length) return [{ text: rail, dim: true }]
  return [
    { text: rail.slice(0, at), dim: true },
    { text: '●', color },
    { text: rail.slice(at + 1), dim: true },
  ]
}

/** The arrow row: `▼` at each card's centre. */
export function arrowSegs(shown: Shown[], columns: number): Seg[] {
  const res: Seg[] = []
  let cursor = 0
  const live = shown.filter(e => e.width > 0).sort((a, b) => a.centre - b.centre)
  for (const e of live) {
    if (e.centre < cursor || e.centre >= columns) continue
    if (e.centre > cursor) res.push({ text: ' '.repeat(e.centre - cursor) })
    const running = e.slot !== null && e.slot.goneAt === null && e.slot.card.status === 'running'
    res.push(running && e.slot !== null ? { text: '▼', color: tierColor(e.slot.card.tier) } : { text: '▼', dim: true })
    cursor = e.centre + 1
  }
  return res
}

type Surface = ClientSurface<FlowState>

function segText(surface: Surface, seg: Seg): RenderElement {
  const { Text } = surface.elements
  const style: { color?: string; dimColor?: boolean; bold?: boolean } = {}
  if (seg.color !== undefined) style.color = seg.color
  if (seg.dim) style.dimColor = true
  if (seg.bold) style.bold = true
  return <Text wrap="truncate-end" {...style}>{seg.text}</Text>
}

function segRow(surface: Surface, key: string, segs: Seg[], columns: number): RenderElement {
  const { Box } = surface.elements
  const t = trimSegs(clipSegs(segs, columns))
  return (
    <Box key={key} flexDirection="row" height={1} marginLeft={t.margin}>
      {t.segs.length === 0 ? [segText(surface, { text: ' ' })] : t.segs.map(s => segText(surface, s))}
    </Box>
  )
}

function stem(surface: Surface, key: string, columns: number): RenderElement {
  return segRow(surface, key, [{ text: ' '.repeat(Math.floor(columns / 2)) }, { text: '│', dim: true }], columns)
}

function fixedBox(
  surface: Surface,
  key: string,
  columns: number,
  border: { borderColor?: string; borderDimColor?: boolean },
  lines: Seg[][],
): RenderElement {
  const { Box } = surface.elements
  const width = Math.min(columns, BOX_WIDTH)
  const inner = Math.max(1, width - 4)
  if (width < 4) {
    // too narrow for a border and its padding: the first line alone
    return (
      <Box key={key} width={width} flexDirection="column">
        {segText(surface, { ...(lines[0]?.[0] ?? { text: ' ' }), text: [...(lines[0]?.[0]?.text ?? ' ')].slice(0, width).join('') })}
      </Box>
    )
  }
  return (
    <Box key={key} width={width} marginLeft={Math.floor((columns - width) / 2)} flexDirection="column" borderStyle="round" paddingX={1} {...border}>
      {lines.map((segs, i) => {
        const cut = clipSegs(segs, inner)
        return (
          <Box key={`${key}-${i}`} flexDirection="row" height={1}>
            {cut.length === 0 ? [segText(surface, { text: ' ' })] : cut.map(s => segText(surface, s))}
          </Box>
        )
      })}
    </Box>
  )
}

/** The plan box's second line: `units ` + the bar + `  done/total`, fitted to `inner`. */
export function planUnitsSegs(done: number, total: number, inner: number): Seg[] {
  if (total <= 0) return [{ text: 'no units declared', dim: true }]
  const count = `  ${done}/${total}`
  const barWidth = Math.max(4, inner - 'units '.length - count.length)
  const full = Math.max(0, Math.min(barWidth, Math.round((Math.max(0, done) / total) * barWidth)))
  return [
    { text: 'units ' },
    { text: '█'.repeat(full), color: 'success' },
    { text: '░'.repeat(barWidth - full), dim: true },
    { text: count },
  ]
}

type Look = { border: string; color: string | null; glyph: string }

function statusLook(status: RowCardStatus, tier: Tier | null | undefined): Look {
  switch (status) {
    case 'running': return { border: 'round', color: tierColor(tier), glyph: '' }
    case 'waiting': return { border: 'round', color: null, glyph: '◌' }
    case 'quiet': return { border: 'round', color: 'warning', glyph: '!' }
    case 'done': return { border: 'round', color: 'success', glyph: '✓' }
    case 'failed': return { border: 'bold', color: 'error', glyph: '✗' }
    case 'stopped': return { border: 'round', color: 'inactive', glyph: '■' }
  }
}

function barColor(status: RowCardStatus, tier: Tier | null | undefined): { color?: string; dimColor?: boolean } {
  switch (status) {
    case 'running': return { color: tierColor(tier) }
    case 'quiet': return { color: 'warning' }
    case 'waiting': return { dimColor: true }
    case 'done': return { color: 'success' }
    case 'failed': return { color: 'error' }
    case 'stopped': return { color: 'inactive' }
  }
}

function borderProps(card: RowCard): { borderStyle: string; borderColor?: string; borderDimColor?: boolean } {
  const look = statusLook(card.status, card.tier)
  const borderStyle = card.selected ? 'double' : look.border
  return look.color === null ? { borderStyle, borderDimColor: true } : { borderStyle, borderColor: look.color }
}

function drawMore(surface: Surface, e: Shown, marginLeft: number): RenderElement | null {
  const { Box, Text } = surface.elements
  const key = `slot-${e.id}` // slot-more, or slot-more-leads
  if (e.width <= 0) return null
  if (e.width < 4) return <Box key={key} width={e.width} height={CARD_HEIGHT} marginLeft={marginLeft} borderStyle="round" borderDimColor />
  return (
    <Box key={key} width={e.width} marginLeft={marginLeft} flexDirection="column" paddingX={1} borderStyle="round" borderDimColor>
      <Text wrap="truncate-end" dimColor>{`+${e.more} more`}</Text>
      <Text wrap="truncate-end"> </Text>
      <Text wrap="truncate-end"> </Text>
      <Text wrap="truncate-end"> </Text>
      <Text wrap="truncate-end"> </Text>
    </Box>
  )
}

function drawCard(surface: Surface, slot: Slot, width: number, marginLeft: number, frame: number): RenderElement | null {
  const { Box, Text, Button } = surface.elements
  const card = slot.card
  const leaving = slot.goneAt !== null
  const key = `slot-${card.id}`
  if (width <= 0) return null
  if (width === 1) {
    return (
      <Box key={key} width={1} height={CARD_HEIGHT} marginLeft={marginLeft} flexDirection="column">
        {Array.from({ length: CARD_HEIGHT }, (_, i) => i).map(i => (
          <Box key={`${key}-${i}`} height={1}>
            <Text dimColor wrap="truncate-end">│</Text>
          </Box>
        ))}
      </Box>
    )
  }
  if (width < 4) return <Box key={key} width={width} height={CARD_HEIGHT} marginLeft={marginLeft} {...borderProps(card)} />

  const look = statusLook(card.status, card.tier)
  const runColor = tierColor(card.tier)
  const flash = (card.status === 'done' || card.status === 'failed') && frame - slot.changedAt < FLASH_FRAMES
  const inverse = flash ? { inverse: true } : {}
  const select = () => surface.post({ select: card.id } as RowPost)
  const inner = Math.max(1, width - 4)

  const chars = [...card.label]
  const label = chars.length > inner ? chars.slice(0, inner - 1).join('') + '…' : card.label
  const labelLength = [...label].length

  let labelParts: RenderElement[]
  if (leaving) {
    labelParts = [<Text wrap="truncate-end" dimColor {...inverse}>{label}</Text>]
  } else if (card.status === 'running') {
    const part = (from: number, to: number): string => [...label].slice(from, to).join('')
    const at = shimmerAt(labelLength, frame)
    const lo = at === null ? labelLength : Math.max(0, at)
    const hi = at === null ? labelLength : Math.max(0, Math.min(labelLength, at + SHIMMER_WIDTH))
    labelParts = []
    if (lo > 0) labelParts.push(<Text wrap="truncate-end" color={runColor} {...inverse}>{part(0, lo)}</Text>)
    if (hi > lo) labelParts.push(<Text wrap="truncate-end" bold color="text" {...inverse}>{part(lo, hi)}</Text>)
    if (hi < labelLength) labelParts.push(<Text wrap="truncate-end" color={runColor} {...inverse}>{part(hi, labelLength)}</Text>)
    if (labelParts.length === 0) labelParts.push(<Text wrap="truncate-end"> </Text>)
  } else if (card.status === 'waiting') {
    labelParts = [<Text wrap="truncate-end" dimColor {...inverse}>{label}</Text>]
  } else if (card.status === 'stopped') {
    labelParts = [<Text wrap="truncate-end" color="inactive" {...inverse}>{label}</Text>]
  } else {
    labelParts = [<Text wrap="truncate-end" bold color={look.color ?? undefined} {...inverse}>{label}</Text>]
  }

  const glyph = card.status === 'running' ? spin(frame) : look.glyph
  const glyphStyle = card.status === 'waiting' ? { dimColor: true } : { color: look.color ?? undefined }

  return (
    <Box key={key} width={width} marginLeft={marginLeft} flexDirection="column" paddingX={1} {...borderProps(card)}>
      <Box key={`label-${card.id}`} flexDirection="row" height={1}>
        <Button key={`card-${card.id}`} plain onPress={select}>
          {labelParts}
        </Button>
      </Box>
      <Text wrap="truncate-end" {...(card.warn ? { color: 'warning' } : { dimColor: true })}>{card.model}</Text>
      <Text wrap="truncate-end" {...barColor(card.status, card.tier)}>{barText(card.status, inner, frame)}</Text>
      <Text wrap="truncate-end" dimColor>{card.line}</Text>
      <Box flexDirection="row" height={1}>
        <Text wrap="truncate-end" {...glyphStyle}>{glyph}</Text>
        <Text wrap="truncate-end" dimColor>{` ${card.tokens}`}</Text>
      </Box>
    </Box>
  )
}

function cardsRow(surface: Surface, shown: Shown[], frame: number, key: string): RenderElement {
  const { Box } = surface.elements
  let cursor = 0
  const cards: (RenderElement | null)[] = []
  for (const e of shown) {
    if (e.width <= 0) continue
    const margin = Math.max(0, e.x - cursor)
    cursor = e.x + e.width
    cards.push(e.slot === null ? drawMore(surface, e, margin) : drawCard(surface, e.slot, e.width, margin, frame))
  }
  return (
    <Box key={key} flexDirection="row" height={CARD_HEIGHT}>
      {cards}
    </Box>
  )
}

export function drawFlow(surface: Surface, state: FlowState, props: FlowProps): RenderElement {
  const { Box } = surface.elements
  const columns = surface.columns
  if (columns <= 0) return <Box key="flow" flexDirection="column" />
  const frame = state.frame
  const trunk = Math.floor(columns / 2)
  const lead = state.lead
  const parts: RenderElement[] = []

  parts.push(
    fixedBox(
      surface,
      'lead',
      columns,
      lead.running ? { borderColor: 'claude' } : { borderDimColor: true },
      [
        [lead.running ? { text: lead.title, bold: true, color: 'claude' } : { text: lead.title, bold: true }],
        [lead.running ? { text: `${spin(frame)} ${lead.line}`, color: 'claude' } : { text: `◆ ${lead.line}`, dim: true }],
        [{ text: lead.tokens, dim: true }],
      ],
    ),
  )

  const leads = shownCards(state, columns, 'leads')
  const shown = shownCards(state, columns, 'workers')
  if (columns < NARROW) {
    if (leads.length > 0) parts.push(cardsRow(surface, leads, frame, 'leads-cards'))
    if (shown.length > 0) parts.push(cardsRow(surface, shown, frame, 'cards'))
    return <Box key="flow" flexDirection="column">{parts}</Box>
  }

  const plan = props.plan
  if (plan) {
    const inner = Math.max(1, Math.min(columns, BOX_WIDTH) - 4)
    parts.push(stem(surface, 'stem-plan', columns))
    parts.push(
      fixedBox(surface, 'plan', columns, { borderDimColor: true }, [
        [{ text: plan.title, bold: true }],
        planUnitsSegs(plan.done, plan.total, inner),
        [{ text: plan.counts, dim: true }],
      ]),
    )
  }

  const labelRow = (key: string, text: string): RenderElement => {
    const label = [...text].slice(0, columns).join('')
    return segRow(surface, key, [{ text: ' '.repeat(Math.floor((columns - [...label].length) / 2)) }, { text: label, dim: true }], columns)
  }
  // One row's fan-out rail, arrow row, cards row and fan-in rail.
  const tierRows = (cards: Shown[], dots: TierDots, keys: { out: string; arrows: string; cards: string; inn: string }, outColor: string, last = false): void => {
    const live = cards.filter(e => e.width > 0)
    const centres = live.map(e => e.centre)
    const out = dots.out
    const outTarget = out ? live.find(e => e.id === out.id) : undefined
    const outAt = out && outTarget ? dotAt(trunk, outTarget.centre, frame - out.start) : null
    parts.push(segRow(surface, keys.out, railSegs(railLine(centres, trunk, columns, 'out'), outAt, outColor), columns))
    parts.push(segRow(surface, keys.arrows, arrowSegs(cards, columns), columns))
    parts.push(cardsRow(surface, cards, frame, keys.cards))
    if (last) return // the last row has nothing under it to fan in to
    const inn = dots.inn
    const inSource = inn ? live.find(e => e.id === inn.id) : undefined
    const inAt = inn && inSource ? dotAt(inSource.centre, trunk, frame - inn.start) : null
    const inColor = inSource?.slot?.card.status === 'failed' ? 'error' : 'success'
    parts.push(segRow(surface, keys.inn, railSegs(railLine(centres, trunk, columns, 'in'), inAt, inColor), columns))
  }

  if (leads.length > 0) {
    parts.push(labelRow('leads-label', props.leadsLabel ?? ''))
    tierRows(leads, state.dots.leads, { out: 'leads-rail-out', arrows: 'leads-arrows', cards: 'leads-cards', inn: 'leads-rail-in' }, 'bashBorder')
    parts.push(labelRow('feed', props.feed ?? ''))
    if (shown.length > 0) parts.push(stem(surface, 'stem-workers', columns))
  }

  if (shown.length > 0) {
    parts.push(labelRow('delegate', props.delegate ?? ''))
    tierRows(shown, state.dots.workers, { out: 'rail-out', arrows: 'arrows', cards: 'cards', inn: 'rail-in' }, 'suggestion', true)
  }

  return <Box key="flow" flexDirection="column">{parts}</Box>
}

const Flow: ClientModule<FlowProps, FlowState> = (props, surface) => {
  const first = surface.state === undefined
  const base = reconcileFlow(surface.state, props)
  if (base !== surface.state) surface.setState(base)
  if (first) {
    surface.every(FRAME_MS, () => {
      const s = surface.state
      if (!s || isIdle(s) || isStill(s)) return
      surface.setState(advanceFlow(s, surface.columns))
    })
  }
  return drawFlow(surface, base, props)
}

export default Flow
