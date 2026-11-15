// Agent Board: pure drawing functions (visual layer 0.4.0; three tiers 0.6.0).
// No `$`, no state reads, no clock: every input arrives in the ViewModel,
// and the element table comes from the caller's `$.ui.resolve(e)`.
// The pane, top to bottom: a header line (AGENT BOARD and the task), a legend
// of the models at work, the flow diagram (lead box, plan box, fan-out, worker
// cards, fan-in, return box; while a leads card (a Haiku worker) is shown, the leads row's label,
// row and feed label sit between the plan box and the fan-out: drawn and animated by the surface module
// flow.client.tsx from `flowProps`, or as a still stack here where there is no
// module), the selected worker's detail strip, the session log, a status line
// and the notes. What fits on a pane of known height is decided by exact row
// accounting in `paneFit`: the status line always shows, then the plan box,
// then the full session log, else a compact log of as many entries as fit, and
// last the notes, in whatever rows are left over.

import type { BoxProps, ButtonProps, ElementConstructor, RenderElement, TextProps, ThemeKey } from 'claude-code'

import type { AgentBox, Board, BoxStatus, Detail, FlowProps, Log, LogKind, Row, RowCard, RowCardStatus, Tier, Tokens, Ui, Unit } from '../types'
import { auditParts } from './policy'
import {
  auditIssue,
  feederUnits,
  fedUnits,
  formatDuration,
  inActiveTask,
  isHeld,
  otherOpen,
  otherTaskOf,
  prettyModel,
  rowLeads,
  rowOf,
  rowWorkers,
  shortModel,
  shownBoxes,
  slotOf,
  tally,
  tierOf,
  unitOf,
} from './state'

export { formatDuration, shortModel }

/** The colour of each measured tier (running cards, the legend, the detail strip's tier line). */
export const TIER_COLOR: Record<Tier, ThemeKey> = { haiku: 'bashBorder', sonnet: 'ide', opus: 'suggestion' }

/** A tier's colour; a null (or unknown) tier draws as `'suggestion'`. */
function tierColor(tier: Tier | null | undefined): ThemeKey {
  return tier === 'haiku' || tier === 'sonnet' || tier === 'opus' ? TIER_COLOR[tier] : 'suggestion'
}

export type UnitState = 'running' | 'blocked' | 'ready' | 'done' | 'failed'

export type ViewModel = {
  board: Board
  now: number
  width: number
  height: number | null
  unitStates: Record<string, UnitState>
  quiet: Record<string, boolean>
  detail: Detail // per-agent brief and tool calls in flight
  ui: Ui // the card whose detail strip is open
  log: Log // the session log, oldest first
  onSelect: (id: string) => void // a press on a card (still fallback row only)
}

/** The part of a surface's element table the view uses: present on every surface. */
export type El = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

export type DrawerLine = { text: string; color?: string; dim?: boolean; bold?: boolean }

// Still-row card sizes: the same as the flow module's worker cards.
const MIN_CARD = 14
const MAX_CARD = 28
/**
 * Rows each part of the pane takes, as drawn by the flow module: the header,
 * the legend, the lead box, the plan box with its stem, the leads row (label,
 * fan-out rail, arrows, cards, fan-in rail, feed label), the stem between the
 * two rows, the workers row (label, rail, arrows, cards, rail), the stem drawn
 * when there is no worker card, the return box and the status line.
 */
export const ROWS = {
  header: 1,
  legend: 1,
  lead: 5,
  plan: 6,
  leads: 12,
  between: 1,
  workers: 11,
  noWorkers: 1,
  back: 4,
  status: 1,
} as const
// Rows the full session log takes besides its entries: two border rows and the title.
export const LOG_FRAME_ROWS = 3
// Rows the detail strip takes besides its lines: two border rows and the label.
export const DETAIL_FRAME_ROWS = 3
// Session log: entries shown, and the width of the `who` column.
export const LOG_SHOWN = 4
// Entries shown by the compact log (no border, no title) on a pane too short for the full log.
export const LOG_COMPACT_SHOWN = 2
// The plan box's inner width.
export const PLAN_INNER = 30
const WHO_WIDTH = 14

// ---------------------------------------------------------------- helpers

export function formatCount(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'n/a'
  if (n < 1000) return String(Math.round(n))
  const scaled = (value: number, suffix: string): string => {
    const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '')
    return text + suffix
  }
  const k = n / 1000
  if (Math.round(k * 10) / 10 < 1000) return scaled(k, 'k')
  return scaled(n / 1_000_000, 'M')
}

/** Counting-up form for the quiet mark: `45s`, `2m`, `1h`. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h`
}

export function statusGlyph(status: BoxStatus): string {
  switch (status) {
    case 'starting':
    case 'running':
      return '●'
    case 'waiting':
      return '◌'
    case 'done':
      return '✓'
    case 'failed':
      return '✗'
    case 'stopped':
      return '■'
  }
}

/** The three separate numbers (never combined): new, cached, out. */
export function tokenParts(tokens: Tokens | null, partial: boolean): { new: string; cached: string; out: string } {
  if (tokens === null) return { new: 'n/a', cached: 'n/a', out: 'n/a' }
  const p = partial ? '≥' : ''
  return {
    new: p + formatCount(tokens.input + tokens.cacheWrite),
    cached: p + formatCount(tokens.cacheRead),
    out: p + formatCount(tokens.output),
  }
}

/** Token lines for a box whose inner width is `inner`: one line when it fits, else two, else three. */
export function tokenLines(tokens: Tokens | null, partial: boolean, inner: number): string[] {
  const t = tokenParts(tokens, partial)
  const a = `new ${t.new}`
  const b = `cached ${t.cached}`
  const c = `out ${t.out}`
  const one = `${a}  ${b}  ${c}`
  if (one.length <= inner) return [one]
  const two = `${a}  ${b}`
  if (two.length <= inner) return [two, c]
  return [a, b, c]
}

/** Summed counts over every box: `≥` when any box is partial or unknown while another is known. */
export function sumTokens(board: Board): { tokens: Tokens | null; isPartial: boolean } {
  const boxes = Object.values(board.agents)
  const known = boxes.filter(b => b.tokens !== null)
  if (known.length === 0) return { tokens: null, isPartial: false }
  const tokens: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 }
  for (const b of known) {
    const t = b.tokens as Tokens
    tokens.input += t.input
    tokens.output += t.output
    tokens.cacheRead += t.cacheRead
    tokens.cacheWrite += t.cacheWrite
    tokens.requests += t.requests
  }
  const isPartial = known.length < boxes.length || known.some(b => b.tokensPartial)
  return { tokens, isPartial }
}

function workersOf(board: Board): AgentBox[] {
  const seen = new Set<string>()
  const out: AgentBox[] = []
  const take = (id: string): void => {
    if (id === 'main' || seen.has(id)) return
    const box = board.agents[id]
    if (!box) return
    seen.add(id)
    out.push(box)
  }
  for (const id of board.order) take(id)
  for (const id of Object.keys(board.agents)) take(id)
  return out
}

/** The non-lead boxes of the active task in one row, in order of first appearance. */
function rowBoxes(board: Board, row: Row): AgentBox[] {
  return workersOf(board).filter(b => inActiveTask(board, b) && rowOf(board, b) === row)
}

function isRunning(box: AgentBox): boolean {
  return box.status === 'starting' || box.status === 'running'
}

function elapsedOf(box: AgentBox, now: number): string | null {
  return box.startedAt === null ? null : formatDuration((box.endedAt ?? now) - box.startedAt)
}

function withElapsed(head: string, elapsed: string | null): string {
  return elapsed === null ? head : `${head} · ${elapsed}`
}

/** `in 45k out 8.1k`, `in ≥45k out ≥8.1k`, or `tokens n/a`; in is every token the model read. */
function tokensText(box: AgentBox): string {
  if (box.tokens === null) return 'tokens n/a'
  const p = box.tokensPartial ? '≥' : ''
  const inTotal = box.tokens.input + box.tokens.cacheWrite + box.tokens.cacheRead
  return `in ${p}${formatCount(inTotal)} out ${p}${formatCount(box.tokens.output)}`
}

/** Cut to `max` characters, the last one `…` when cut. */
function cut(text: string, max: number): string {
  const chars = [...text]
  if (chars.length <= max) return text
  if (max <= 0) return ''
  return chars.slice(0, max - 1).join('') + '…'
}

// ---------------------------------------------------------------- the worker cards

function cardStatus(vm: ViewModel, box: AgentBox): RowCardStatus {
  switch (box.status) {
    case 'starting':
    case 'running':
      return vm.quiet[box.id] ? 'quiet' : 'running'
    case 'waiting':
      return 'waiting'
    case 'done':
    case 'failed':
    case 'stopped':
      return box.status
  }
}

/** The tool of the most recently started call in flight, else the last tool, else `working`. */
function currentTool(vm: ViewModel, box: AgentBox): string {
  const tools = vm.detail.agents[box.id]?.tools ?? []
  let latest: { tool: string; startedAt: number } | null = null
  for (const run of tools) if (latest === null || run.startedAt >= latest.startedAt) latest = run
  return latest?.tool ?? box.lastTool ?? 'working'
}

function cardLine(vm: ViewModel, box: AgentBox, status: RowCardStatus): string {
  const elapsed = elapsedOf(box, vm.now)
  switch (status) {
    case 'quiet': {
      const since = box.lastEventAt ?? box.startedAt
      return since === null ? 'quiet' : `quiet ${formatAge(vm.now - since)}`
    }
    case 'running':
      return withElapsed(box.status === 'starting' ? 'starting' : currentTool(vm, box), elapsed)
    case 'waiting':
      return withElapsed('waiting', elapsed)
    case 'done':
      return withElapsed('done', elapsed)
    case 'stopped':
      return withElapsed('stopped', elapsed)
    case 'failed':
      return box.reason ? `failed: ${box.reason}` : withElapsed('failed', elapsed)
  }
}

/**
 * A held card's line 4 (B3.3): a Haiku lead not yet checked is `lead ·
 * unchecked` (with the units it feeds), a Sonnet draft `draft · unchecked`;
 * a card held with a verdict (a Haiku lead whose fed unit is unfinished) gives
 * the verdict and the units it feeds.
 */
function heldLine(board: Board, unit: Unit): string {
  const fed = fedUnits(board, unit.id).length
  const verdict = unit.verdict ?? null
  if (verdict === null && unit.tier === 'haiku') return fed > 0 ? `lead · unchecked · feeds ${fed}` : 'lead · unchecked'
  if (verdict === null && unit.tier === 'sonnet') return 'draft · unchecked'
  return `${verdict ?? 'unchecked'} · feeds ${fed}`
}

/**
 * One box's card. Line 2 names the model and the unit's kind (the kind
 * recorded at spawn once the unit has left the list), or warns (policy §9)
 * when the box carries out no unit with an audit line, or runs on another tier
 * than its unit declares; a card of another task reads `<model> · ⇄ <task>`,
 * never a warning. A held card's line 4 is `heldLine`.
 */
function cardOf(vm: ViewModel, box: AgentBox): RowCard {
  const { board } = vm
  const status = cardStatus(vm, box)
  const other = otherTaskOf(board, box)
  const issue = other !== null ? 'none' : auditIssue(board, box)
  const unit = unitOf(board, box)
  const name = prettyModel(box.model)
  const kind = unit !== null ? unit.kind : (box.routed?.kind ?? null)
  const tier = unit?.tier ?? box.routed?.tier ?? null
  let model = name
  if (other !== null) model = `${name} · ⇄ ${other}`
  else if (issue === 'no-audit') model = `${name} · no audit`
  else if (issue === 'tier-mismatch' && tier !== null) model = `${name} · not ${tier}`
  else if (kind !== null && kind !== undefined) model = `${name} · ${kind}`
  const line = isHeld(board, box) && unit !== null ? heldLine(board, unit) : cardLine(vm, box, status)
  return {
    id: box.id,
    row: rowOf(board, box),
    tier: tierOf(board, box),
    warn: issue !== 'none',
    label: box.label,
    status,
    model,
    line,
    tokens: tokensText(box),
    selected: vm.ui.selected === box.id,
  }
}

/** One card per box in the workers row (live and lingering), in order of first appearance. */
function workerCards(vm: ViewModel): RowCard[] {
  return rowWorkers(vm.board, vm.now).map(box => cardOf(vm, box))
}

/** One card per Haiku worker in the leads row (live, lingering and held), in order of first appearance. */
function leadsCards(vm: ViewModel): RowCard[] {
  return rowLeads(vm.board, vm.now).map(box => cardOf(vm, box))
}

// ---------------------------------------------------------------- the flow's props

/** The lead's model as a display name, or null when it is not known. */
function leadModel(vm: ViewModel): string | null {
  const model = vm.board.agents.main?.model ?? null
  return model === null || model === '' ? null : prettyModel(model)
}

/** Workers (not the lead) of the active task starting or running. */
function runningCount(board: Board): number {
  return workersOf(board).filter(w => inActiveTask(board, w) && (w.status === 'starting' || w.status === 'running')).length
}

function distinct(items: readonly string[]): string[] {
  const out: string[] = []
  for (const s of items) if (!out.includes(s)) out.push(s)
  return out
}

/** The lead's state: running (its latest tool in flight, else thinking) or waiting. */
function leadState(vm: ViewModel): { running: boolean; line: string; tokens: string } {
  const main = vm.board.agents.main
  const running = main !== undefined && (main.status === 'running' || main.status === 'starting')
  let line: string
  if (main === undefined) {
    line = 'no events yet'
  } else if (running) {
    let latest: { tool: string; startedAt: number } | null = null
    for (const run of vm.detail.agents.main?.tools ?? []) if (latest === null || run.startedAt >= latest.startedAt) latest = run
    line = latest?.tool ?? 'thinking'
  } else {
    line = 'waiting'
  }
  return { running, line, tokens: main === undefined ? 'tokens n/a' : tokensText(main) }
}

/** The plan box's counts: the three parts joined with two spaces when that fits in PLAN_INNER, else one. */
function countsText(running: number, failed: number, queued: number): string {
  const parts = [`running ${running}`, `failed ${failed}`, `queued ${queued}`]
  const wide = parts.join('  ')
  return [...wide].length <= PLAN_INNER ? wide : parts.join(' ')
}

/** What the flow module is handed: every text ready to print. */
export function flowProps(vm: ViewModel): FlowProps {
  const { board } = vm
  const lead = leadModel(vm)
  const t = tally(board)
  const r = runningCount(board)

  const leads = leadsCards(vm)
  let plan: FlowProps['plan'] = null
  if (paneFit(vm).plan) {
    let title = 'PLAN · phase not set'
    if (board.phase !== null) {
      title = `PLAN · ${board.phase}${board.phase === 'executing' && board.wave !== null ? ` · wave ${board.wave}` : ''}`
    }
    plan = {
      title,
      done: board.units.filter(u => vm.unitStates[u.id] === 'done').length,
      total: board.units.length,
      counts: countsText(r, t.failed, t.queued),
    }
  }

  const workers = workerCards(vm)
  // the models' display names (a card's line 2 also carries the kind or a warning)
  const models = distinct(rowWorkers(board, vm.now).map(b => prettyModel(b.model)))
  const delegate = models.length > 0 ? `delegate to workers · ${models.join(', ')}` : 'delegate to workers'

  let leadsLabel = ''
  let feed = ''
  if (leads.length > 0) {
    const leadsModels = distinct(rowLeads(board, vm.now).map(b => prettyModel(b.model)))
    leadsLabel = `${leadsModels.join(', ')} · leads only`
    const haikuUnits = board.units.filter(u => u.tier === 'haiku')
    const accepted = haikuUnits.filter(u => u.verdict === 'accepted').length
    const rejected = haikuUnits.filter(u => u.verdict === 'rejected').length
    const unchecked = haikuUnits.filter(u => (u.verdict === null || u.verdict === undefined) && vm.unitStates[u.id] === 'done').length
    feed = 'leads → lead audits → workers'
    if (accepted > 0) feed += ` · ${accepted} accepted`
    if (rejected > 0) feed += ` · ${rejected} rejected`
    if (unchecked > 0) feed += ` · ${unchecked} unchecked`
  }

  const reviewing = board.phase === 'testing' || board.phase === 'review'
  let line = reviewing ? 'review + verify' : r > 0 ? `waiting on ${r}` : 'idle'
  if (t.done > 0) line += ` · ${t.done} in`
  if (t.failed > 0) line += ` · ${t.failed} failed`
  const active = reviewing || board.phase === 'done' || (r === 0 && t.done + t.failed > 0)

  return {
    lead: { title: `${lead ?? 'Orchestrator'} · main session`, ...leadState(vm) },
    plan,
    leadsLabel,
    leads,
    feed,
    delegate,
    workers,
    back: { title: lead === null ? 'back to lead' : `back to ${lead} · lead`, line, active },
  }
}

// ---------------------------------------------------------------- the still flow
// Where there is no surface module: the flow's boxes stacked, with no rails and
// no animation. The worker cards look like the module's.

type Look = { border: 'round' | 'bold'; color: ThemeKey | null; glyph: string }

function lookOf(card: RowCard): Look {
  switch (card.status) {
    // a running card in its tier's colour; a card with no tier as before tiers were measured
    case 'running': {
      const t = card.tier
      return { border: 'round', color: t === 'haiku' || t === 'sonnet' || t === 'opus' ? TIER_COLOR[t] : 'claude', glyph: '●' }
    }
    case 'waiting': return { border: 'round', color: null, glyph: '◌' }
    case 'quiet': return { border: 'round', color: 'warning', glyph: '!' }
    case 'done': return { border: 'round', color: 'success', glyph: '✓' }
    case 'failed': return { border: 'bold', color: 'error', glyph: '✗' }
    case 'stopped': return { border: 'round', color: 'inactive', glyph: '■' }
  }
}

function borderProps(card: RowCard): { borderStyle: string; borderColor?: ThemeKey; borderDimColor?: boolean } {
  const look = lookOf(card)
  const borderStyle = card.selected ? 'double' : look.border
  return look.color === null ? { borderStyle, borderDimColor: true } : { borderStyle, borderColor: look.color }
}

function drawStillCard(el: El, vm: ViewModel, card: RowCard, width: number): RenderElement | null {
  const { Box, Text, Button } = el
  const key = `slot-${card.id}`
  if (width <= 0) return null
  if (width < 4) return <Box key={key} width={width} height={6} {...borderProps(card)} />
  const look = lookOf(card)
  const text = `${look.glyph} ${card.label}`
  let label: RenderElement
  if (card.status === 'waiting') label = <Text wrap="truncate-end" dimColor>{text}</Text>
  else if (card.status === 'stopped') label = <Text wrap="truncate-end" color="inactive">{text}</Text>
  else label = <Text wrap="truncate-end" bold color={look.color ?? undefined}>{text}</Text>
  return (
    <Box key={key} width={width} flexDirection="column" paddingX={1} {...borderProps(card)}>
      <Button key={`card-${card.id}`} plain onPress={() => vm.onSelect(card.id)}>
        {label}
      </Button>
      {card.warn ? (
        <Text wrap="truncate-end" color="warning">{card.model}</Text>
      ) : (
        <Text wrap="truncate-end" dimColor>{card.model}</Text>
      )}
      <Text wrap="truncate-end" dimColor>{card.line}</Text>
      <Text wrap="truncate-end" dimColor>{card.tokens}</Text>
    </Box>
  )
}

function drawStillRow(el: El, vm: ViewModel, cards: RowCard[], key: string): RenderElement {
  const { Box, Text } = el
  if (cards.length === 0) {
    return (
      <Box key={key}>
        <Text dimColor wrap="truncate-end">no workers running</Text>
      </Box>
    )
  }
  const perLine = Math.max(1, Math.floor(vm.width / MIN_CARD))
  const lines: RowCard[][] = []
  for (let i = 0; i < cards.length; i += perLine) lines.push(cards.slice(i, i + perLine))
  return (
    <Box key={key} flexDirection="column">
      {lines.map((line, li) => {
        const w = Math.min(MAX_CARD, Math.floor(vm.width / line.length))
        return (
          <Box key={`line-${li}`} flexDirection="row">
            {line.map(card => drawStillCard(el, vm, card, w))}
          </Box>
        )
      })}
    </Box>
  )
}

function drawStillFlow(el: El, vm: ViewModel): RenderElement {
  const { Box, Text } = el
  const p = flowProps(vm)
  return (
    <Box key="still-flow" flexDirection="column" alignItems="flex-start" width={vm.width}>
      <Box key="still-lead" flexDirection="column" borderStyle="round" paddingX={1} {...(p.lead.running ? { borderColor: 'claude' as const } : { borderDimColor: true })}>
        {p.lead.running ? (
          <Text wrap="truncate-end" bold color="claude">{p.lead.title}</Text>
        ) : (
          <Text wrap="truncate-end" bold>{p.lead.title}</Text>
        )}
        <Text wrap="truncate-end" dimColor>{`${p.lead.line} · ${p.lead.tokens}`}</Text>
      </Box>
      {p.plan !== null && (
        <Box key="still-plan" flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Text wrap="truncate-end" bold>{p.plan.title}</Text>
          <Text wrap="truncate-end" dimColor>{p.plan.total === 0 ? 'no units declared' : `${p.plan.done} of ${p.plan.total} units done`}</Text>
          <Text wrap="truncate-end" dimColor>{p.plan.counts}</Text>
        </Box>
      )}
      {p.leads.length > 0 && (
        <Box key="still-leads-label">
          <Text wrap="truncate-end" dimColor>{p.leadsLabel}</Text>
        </Box>
      )}
      {p.leads.length > 0 && drawStillRow(el, vm, p.leads, 'still-leads')}
      {p.leads.length > 0 && (
        <Box key="still-feed">
          <Text wrap="truncate-end" dimColor>{p.feed}</Text>
        </Box>
      )}
      {drawStillRow(el, vm, p.workers, 'still-row')}
      <Box key="still-back" flexDirection="column" borderStyle="round" paddingX={1} {...(p.back.active ? { borderColor: 'success' as const } : { borderDimColor: true })}>
        {p.back.active ? (
          <Text wrap="truncate-end" bold color="success">{p.back.title}</Text>
        ) : (
          <Text wrap="truncate-end" bold>{p.back.title}</Text>
        )}
        <Text wrap="truncate-end" dimColor>{p.back.line}</Text>
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------- the detail strip

/** The box this one was spawned by, when it is a known box other than itself. */
function parentOf(vm: ViewModel, box: AgentBox): AgentBox | null {
  if (box.parentId === null || box.parentId === box.id) return null
  return vm.board.agents[box.parentId] ?? null
}

/**
 * The routing lines of the detail strip (policy §9): the warning when the box
 * carries out no unit with an audit line, or runs on another tier than its
 * unit declares; otherwise its unit's tier and kind, the audit line's task,
 * route and check, the verdict (a Sonnet unit not yet checked is a draft), its
 * spec and the units it feeds. Then, for a unit fed by others, its feeders.
 */
function tierLines(board: Board, box: AgentBox, inner: number): DrawerLine[] {
  const out: DrawerLine[] = []
  const unit = unitOf(board, box)
  const issue = auditIssue(board, box)
  if (issue === 'no-audit') {
    out.push({ text: 'no audit line (policy §9)', color: 'warning' })
  } else if (issue === 'tier-mismatch' && unit !== null) {
    out.push({ text: cut(`ran on ${prettyModel(box.model)}, unit says ${unit.tier}`, inner), color: 'warning' })
  } else if (unit !== null && unit.tier !== null && unit.tier !== undefined) {
    const tier = unit.tier
    out.push({ text: unit.kind ? `${tier} · ${unit.kind.toUpperCase()}` : tier, color: tierColor(tier) })
    const parts = auditParts(unit.audit ?? '')
    if (parts !== null) {
      const [task, , route, check] = parts
      out.push({ text: cut(`task: ${task}`, inner) })
      out.push({ text: cut(`route: ${route}`, inner) })
      out.push({ text: cut(`check: ${check}`, inner) })
    }
    const verdict = unit.verdict ?? null
    out.push({ text: `verdict: ${verdict ?? 'unchecked'}${verdict === null && tier === 'sonnet' ? ' (draft)' : ''}` })
    if (unit.spec) out.push({ text: cut(`spec: ${unit.spec}`, inner) })
    const fed = fedUnits(board, unit.id)
    if (fed.length > 0) out.push({ text: cut(`feeds: ${fed.map(u => u.label).join(', ')}`, inner) })
  }
  if (unit !== null) {
    const feeders = feederUnits(board, unit)
    if (feeders.length > 0) {
      out.push({ text: cut(`fed by: ${feeders.map(u => `${u.label} (${u.verdict ?? 'unchecked'})`).join(', ')}`, inner), dim: true })
    }
  }
  return out
}

/** Lines of the selected card's detail strip after its label, in order (pure). */
export function detailLines(vm: ViewModel, box: AgentBox, inner: number): DrawerLine[] {
  const out: DrawerLine[] = []
  const parent = parentOf(vm, box)
  if (parent !== null) out.push({ text: `↳ ${parent.label}`, dim: true })
  const kind = [box.type, box.model].filter((s): s is string => !!s).join(' · ')
  if (kind) out.push({ text: kind, dim: true })
  const other = otherTaskOf(vm.board, box)
  if (other !== null) out.push({ text: cut(`task: ${other} · ${slotOf(vm.board, other)?.task ?? 'no title'}`, inner), dim: true })
  out.push(...tierLines(vm.board, box, inner))
  for (const line of tokenLines(box.tokens, box.tokensPartial, inner)) out.push({ text: line })

  const detail = vm.detail.agents[box.id]
  const tools = [...(detail?.tools ?? [])].sort((a, b) => a.startedAt - b.startedAt)
  if (tools.length > 0) {
    out.push({ text: 'tools', bold: true })
    for (const run of tools.slice(0, 3)) out.push({ text: `  ⚙ ${run.tool} ${formatAge(vm.now - run.startedAt)}` })
    if (tools.length > 3) out.push({ text: `  +${tools.length - 3} more` })
  } else if (box.lastTool !== null) {
    out.push({ text: `last: ${box.lastTool}`, dim: true })
  } else {
    out.push({ text: 'no tool calls yet', dim: true })
  }

  const brief = detail?.brief ?? null
  if (brief === null) {
    out.push({ text: 'brief not captured', dim: true })
  } else {
    out.push({ text: 'brief', bold: true })
    const chars = [...brief.replace(/\s+/g, ' ').trim()]
    const size = Math.max(1, inner)
    const chunks: string[] = []
    for (let i = 0; i < chars.length; i += size) chunks.push(chars.slice(i, i + size).join(''))
    const shown = chunks.slice(0, 4)
    if (chunks.length > 4 || detail?.briefCut === true) {
      const last = shown.length > 0 ? [...(shown.pop() as string)] : []
      shown.push((last.length >= size ? last.slice(0, size - 1) : last).join('') + '…')
    }
    for (const line of shown) out.push({ text: line })
  }

  out.push({ text: `out ${formatCount(box.briefChars)} · back ${formatCount(box.resultChars)}`, dim: true })
  return out
}

function lineText(el: El, line: DrawerLine): RenderElement {
  const { Text } = el
  return (
    <Text wrap="truncate-end" {...(line.color ? { color: line.color } : {})} {...(line.dim ? { dimColor: true } : {})} {...(line.bold ? { bold: true } : {})}>
      {line.text}
    </Text>
  )
}

/** The detail strip's inner width: two border cells and one cell of padding each side. */
function detailInner(vm: ViewModel): number {
  return Math.max(1, vm.width - 4)
}

/** The box whose detail strip is open, when a card other than the lead is selected and its box exists. */
function selectedBox(vm: ViewModel): AgentBox | undefined {
  const selected = vm.ui.selected
  return selected !== null && selected !== 'main' ? vm.board.agents[selected] : undefined
}

function drawDetail(el: El, vm: ViewModel, box: AgentBox): RenderElement {
  const { Box, Text } = el
  const inner = detailInner(vm)
  return (
    <Box key="detail" width={vm.width} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      <Text wrap="truncate-end" bold>{box.label}</Text>
      {detailLines(vm, box, inner).map(line => lineText(el, line))}
    </Box>
  )
}

// ---------------------------------------------------------------- the header and legend

function drawHeader(el: El, vm: ViewModel): RenderElement {
  const { Box, Text } = el
  const { task, taskId } = vm.board
  const open = otherOpen(vm.board)
  const others = open.tasks > 0 ? ` +${open.tasks}${open.running > 0 ? ` (${open.running} running)` : ''}` : ''
  return (
    <Box key="header" width={vm.width}>
      <Text wrap="truncate-end">
        <Text bold>AGENT BOARD</Text>
        {' · '}
        {taskId !== null && `${taskId}${others} · `}
        {task === null ? <Text dimColor>no task declared</Text> : task}
      </Text>
    </Box>
  )
}

// The legend's tiers in order, and what each tier's workers are called there.
const LEGEND_TIERS: ReadonlyArray<Tier | null> = ['haiku', 'sonnet', 'opus', null]
const LEGEND_ROLE: Record<Tier, string> = { haiku: 'leads', sonnet: 'drafts', opus: 'workers' }

export type LegendEntry = { model: string; tier: Tier | null; color: ThemeKey; text: string }

/**
 * The legend's entries after the lead's: one per distinct (model, tier) among
 * `shownBoxes` (the active task's boxes and the live boxes of any other task), tiers in the order haiku, sonnet,
 * opus, then none; models in order of first appearance (pure).
 */
export function legendEntries(board: Board): LegendEntry[] {
  const seen: Array<{ model: string; tier: Tier | null }> = []
  for (const box of shownBoxes(board)) {
    const model = prettyModel(box.model)
    const tier = tierOf(board, box)
    if (!seen.some(s => s.model === model && s.tier === tier)) seen.push({ model, tier })
  }
  const out: LegendEntry[] = []
  for (const tier of LEGEND_TIERS) {
    for (const s of seen) {
      if (s.tier !== tier) continue
      out.push({
        model: s.model,
        tier,
        color: tier === null ? 'warning' : TIER_COLOR[tier],
        text: ` ${s.model} · ${tier === null ? 'unrouted' : LEGEND_ROLE[tier]}`,
      })
    }
  }
  return out
}

function drawLegend(el: El, vm: ViewModel): RenderElement {
  const { Box, Text } = el
  const lead = prettyModel(vm.board.agents.main?.model ?? null)
  return (
    <Box key="legend" width={vm.width}>
      <Text wrap="truncate-end">
        <Text color="claude">■</Text>
        <Text dimColor>{` ${lead} · lead`}</Text>
        {legendEntries(vm.board).map(e => (
          <Text>
            {'   '}
            <Text color={e.color}>■</Text>
            <Text dimColor>{e.text}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  )
}

// ---------------------------------------------------------------- the session log

/** `HH:MM:SS` in local time. */
export function clockText(at: number): string {
  const d = new Date(at)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

export type LogLine = { time: string; who: string; text: string; kind: LogKind }

/** The newest `count` entries, oldest of those first; `who` cut or padded to 14 characters. */
export function logLines(log: Log, count: number): LogLine[] {
  if (count <= 0) return []
  return log.entries.slice(-count).map(e => {
    const who = cut(e.who, WHO_WIDTH)
    return { time: clockText(e.at), who: who + ' '.repeat(Math.max(0, WHO_WIDTH - [...who].length)), text: e.text, kind: e.kind }
  })
}

const WHO_COLOR: Record<LogKind, ThemeKey> = {
  done: 'success',
  failed: 'error',
  phase: 'claude',
  spawned: 'suggestion',
  stopped: 'inactive',
  audit: 'suggestion',
  verdict: 'claude',
}

/** One line of the log (full or compact): dim time, the bold `who` in its kind's colour, the text. */
function drawLogLine(el: El, line: LogLine): RenderElement {
  const { Text } = el
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{line.time}</Text>
      {'  '}
      <Text bold color={WHO_COLOR[line.kind]}>{line.who}</Text>
      {'  '}
      {line.text}
    </Text>
  )
}

function drawLog(el: El, vm: ViewModel): RenderElement {
  const { Box, Text } = el
  return (
    <Box key="log" width={vm.width} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      <Text wrap="truncate-end" dimColor>session log</Text>
      {logLines(vm.log, LOG_SHOWN).map(line => drawLogLine(el, line))}
    </Box>
  )
}

/** The compact log, on a pane too short for the full one: the newest `count` entries, no border, no title. */
function drawCompactLog(el: El, vm: ViewModel, count: number): RenderElement {
  const { Box } = el
  return (
    <Box key="log-compact" width={vm.width} flexDirection="column">
      {logLines(vm.log, count).map(line => drawLogLine(el, line))}
    </Box>
  )
}

// ---------------------------------------------------------------- the status line and notes

/** The status line's parts: label (dim) and value (normal), in order. */
export function statusParts(vm: ViewModel): Array<{ label: string; value: string }> {
  const { board } = vm
  const workers = rowBoxes(board, 'workers')
  const leads = rowBoxes(board, 'leads')
  const parts = [
    { label: 'lead', value: leadState(vm).running ? 'working' : 'waiting' },
    { label: 'workers', value: `${workers.filter(isRunning).length}/${workers.length}` },
  ]
  if (leads.length > 0) parts.push({ label: 'leads', value: `${leads.filter(isRunning).length}/${leads.length}` })
  parts.push({ label: 'phase', value: board.phase ?? 'not set' })
  return parts
}

function drawStatus(el: El, vm: ViewModel): RenderElement {
  const { Box, Text } = el
  return (
    <Box key="status" width={vm.width}>
      <Text wrap="truncate-end">
        {statusParts(vm).map((p, i) => (
          <Text>
            <Text dimColor>{`${i > 0 ? '   ' : ''}${p.label} `}</Text>
            {`[${p.value}]`}
          </Text>
        ))}
      </Text>
    </Box>
  )
}

function footerLines(vm: ViewModel): string[] {
  const lines: string[] = []
  if (vm.board.note) lines.push(vm.board.note)
  const boxes = Object.values(vm.board.agents)
  const unavailable = boxes.filter(b => b.tokens === null).length
  const partial = boxes.filter(b => b.tokens !== null && b.tokensPartial).length
  const parts: string[] = []
  if (unavailable > 0) parts.push(`${unavailable} ${unavailable === 1 ? 'box has' : 'boxes have'} unavailable counts (n/a)`)
  if (partial > 0) parts.push(`${partial} ${partial === 1 ? 'box has' : 'boxes have'} partial counts (≥)`)
  if (parts.length > 0) lines.push(parts.join('; '))
  return lines
}

// ---------------------------------------------------------------- the pane

export type PaneFit = { plan: boolean; log: 'full' | 'compact' | 'none'; logLines: number; footer: number }

/**
 * What fits on the pane, by exact row accounting (pure). The fixed rows are the
 * header, the legend, the flow without its plan box (lead box, each tier shown
 * and its stems, return box), the selected card's detail strip and the status
 * line: these are never pushed out. The plan box comes next when its rows fit,
 * then the full session log, else the compact log with as many of its newest
 * entries (up to LOG_COMPACT_SHOWN) as the rows left allow, else no log. The
 * notes come last: `footer` is how many of them fit in the rows left over.
 * With the height unknown: the plan box, the full log and every note.
 */
export function paneFit(vm: ViewModel): PaneFit {
  const entries = vm.log.entries.length
  const fullLines = Math.min(LOG_SHOWN, entries)
  const notes = footerLines(vm).length
  if (vm.height === null) {
    return entries > 0
      ? { plan: true, log: 'full', logLines: fullLines, footer: notes }
      : { plan: true, log: 'none', logLines: 0, footer: notes }
  }
  const leadsShown = rowLeads(vm.board, vm.now).length > 0
  const workersShown = rowWorkers(vm.board, vm.now).length > 0
  let fixed = ROWS.header + ROWS.legend + ROWS.lead
  if (leadsShown) fixed += ROWS.leads
  if (leadsShown && workersShown) fixed += ROWS.between
  fixed += workersShown ? ROWS.workers : ROWS.noWorkers
  fixed += ROWS.back + ROWS.status
  const box = selectedBox(vm)
  if (box !== undefined) fixed += DETAIL_FRAME_ROWS + detailLines(vm, box, detailInner(vm)).length
  const plan = fixed + ROWS.plan <= vm.height
  const left = vm.height - fixed - (plan ? ROWS.plan : 0)
  const footer = (rows: number) => Math.max(0, Math.min(notes, rows))
  if (entries === 0) return { plan, log: 'none', logLines: 0, footer: footer(left) }
  if (LOG_FRAME_ROWS + fullLines <= left) {
    return { plan, log: 'full', logLines: fullLines, footer: footer(left - LOG_FRAME_ROWS - fullLines) }
  }
  const n = Math.min(LOG_COMPACT_SHOWN, entries, left)
  return n >= 1
    ? { plan, log: 'compact', logLines: n, footer: footer(left - n) }
    : { plan, log: 'none', logLines: 0, footer: footer(left) }
}

/**
 * The pane's whole tree, top to bottom with no gap: the header, the legend,
 * the flow (`flow`, the surface module's element, or the still stack when
 * null), the selected worker's detail strip, the session log as `paneFit`
 * decides (the full log, the compact log of exactly its `logLines` newest
 * entries, or none), the status line and the first `footer` notes that
 * `paneFit` leaves room for (none: no notes box).
 */
export function drawPane(el: El, vm: ViewModel, flow: RenderElement | null): RenderElement {
  const { Box, Text } = el
  const box = selectedBox(vm)
  const fit = paneFit(vm)
  const footer = footerLines(vm).slice(0, fit.footer)

  return (
    <Box key="pane" flexDirection="column" width={vm.width}>
      {drawHeader(el, vm)}
      {drawLegend(el, vm)}
      <Box key="flow" flexDirection="column" width={vm.width}>
        {flow ?? drawStillFlow(el, vm)}
      </Box>
      {box !== undefined && drawDetail(el, vm, box)}
      {fit.log === 'full' && drawLog(el, vm)}
      {fit.log === 'compact' && drawCompactLog(el, vm, fit.logLines)}
      {drawStatus(el, vm)}
      {footer.length > 0 && (
        <Box key="footer" flexDirection="column" width={vm.width}>
          {footer.map(line => (
            <Text dimColor>{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

// ---------------------------------------------------------------- the band

export function bandText(vm: ViewModel): string {
  const { board } = vm
  const workers = workersOf(board).filter(w => inActiveTask(board, w))
  const running = workers.filter(w => w.status === 'running' || w.status === 'starting').length
  const phase =
    board.phase === null ? 'phase not set' : `[${board.phase}${board.phase === 'executing' && board.wave !== null ? ` · wave ${board.wave}` : ''}]`
  const sum = sumTokens(board)
  const t = tokenParts(sum.tokens, sum.isPartial)
  return `Agent Board  ${board.taskId === null ? '' : `${board.taskId}  `}${phase}  ● ${running}/${workers.length} running  new ${t.new}  cached ${t.cached}  out ${t.out}  · /board to open`
}

/** The one-line fallback row above the prompt (spec 2.9). */
export function drawBand(el: El, vm: ViewModel): RenderElement {
  const { Box, Text } = el
  return (
    <Box key="band">
      <Text wrap="truncate-end">{bandText(vm)}</Text>
    </Box>
  )
}
