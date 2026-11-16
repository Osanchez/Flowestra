// Agent Board: the Tokens tab (0.13.0). Pure: no `$`, no state reads, no clock.
// Box/Text tables and glyph-bar charts built from the board's measured counts
// (usage.ts). Nothing is estimated; characters stay characters. A Button's
// children are strings and Text only: a Box there makes the whole pane fail to
// draw. Every Text here is `truncate-end`; prose is cut into lines by
// `proseLines` so nothing wraps and nothing overlaps.

import type { RenderElement } from 'claude-code'

import type { Tier, Tokens } from '../types'
import { drawNav } from './nav'
import { modelTier } from './state'
import { hasUsage, usageScope, workerUsage } from './usage'
import type { UsageRow, UsageScope, WorkerUsage } from './usage'
import { clockText, formatCount, statusGlyph, tierColor } from './view'
import type { El, ViewModel } from './view'

export type TokensClass = 'wide' | 'medium' | 'narrow' | 'tiny'

/** Workers drawn in the worker table; the rest are summed in one `+N more` line. */
export const WORKERS_SHOWN = 12

/** The class of a pane width and the column widths its charts use (bar 0 in the tiny class). */
export function tokensLayout(width: number): { cls: TokensClass; label: number; value: number; bar: number } {
  if (width >= 72) return { cls: 'wide', label: 18, value: 7, bar: Math.max(0, width - 18 - 7 - 5) }
  if (width >= 48) return { cls: 'medium', label: 14, value: 7, bar: Math.max(0, width - 14 - 7) }
  if (width >= 24) return { cls: 'narrow', label: 9, value: 6, bar: Math.max(0, width - 9 - 6) }
  return { cls: 'tiny', label: 8, value: 6, bar: 0 }
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** A bar of `value` against `max` over `cells` cells: whole `█` and one eighth glyph; '' when there is nothing to draw. */
export function barCells(value: number, max: number, cells: number): string {
  if (!(value > 0) || !(max > 0) || !(cells > 0)) return ''
  const eighths = Math.min(cells * 8, Math.round((value / max) * cells * 8))
  return '█'.repeat(Math.floor(eighths / 8)) + EIGHTHS[eighths % 8]
}

// ---------------------------------------------------------------- small helpers

const inOf = (t: Tokens): number => t.input + t.cacheWrite + t.cacheRead
const newOf = (t: Tokens): number => t.input + t.cacheWrite
const allOf = (t: Tokens): number => inOf(t) + t.output
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
const count = (n: number, partial: boolean): string => (partial ? '≥' : '') + formatCount(n)
const pct = (part: number, whole: number): string => (whole > 0 ? `${Math.round((100 * part) / whole)}%` : '')
const TIER_ORDER: Tier[] = ['haiku', 'sonnet', 'opus']

/** `text` cut to `w` characters with an ellipsis when longer. */
function cut(text: string, w: number): string {
  if (w <= 0) return ''
  return text.length <= w ? text : w === 1 ? '…' : text.slice(0, w - 1) + '…'
}
const padL = (text: string, w: number): string => cut(text, w).padStart(w)

/** `text` broken at spaces into lines of at most `width` characters (a longer word is cut). */
function proseLines(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line === '' ? word : `${line} ${word}`
    if (next.length <= w) line = next
    else {
      if (line !== '') out.push(line)
      line = cut(word, w)
    }
  }
  if (line !== '') out.push(line)
  return out
}

type Cell = { w: number; text: string; exact?: boolean; right?: boolean; color?: string; dim?: boolean; bold?: boolean; mono?: boolean }

function row(el: El, key: string, cells: Cell[]): RenderElement {
  const { Box, Text } = el
  return (
    <Box key={key}>
      {cells.map((c, i) => (
        <Box key={`c${i}`} width={c.w}>
          <Text
            wrap="truncate-end"
            tabular={c.right === true ? true : undefined}
            mono={c.mono === true ? true : undefined}
            color={c.color as any}
            dimColor={c.dim === true ? true : undefined}
            bold={c.bold === true ? true : undefined}
          >
            {c.exact === true ? cut(c.text, c.w) : c.right === true ? padL(c.text, c.w) : cut(c.text, c.w - (c.w > 1 ? 1 : 0))}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

function prose(el: El, key: string, text: string, width: number, dim = true): RenderElement[] {
  const { Text } = el
  return proseLines(text, width).map((line, i) => (
    <Text key={`${key}${i}`} wrap="truncate-end" dimColor={dim ? true : undefined}>
      {line}
    </Text>
  ))
}

function heading(el: El, key: string, text: string): RenderElement {
  const { Text } = el
  return (
    <Text key={key} bold wrap="truncate-end">
      {text}
    </Text>
  )
}

const section = (el: El, vm: ViewModel, key: string, children: RenderElement[], gap = true): RenderElement => {
  const { Box } = el
  return (
    <Box key={key} flexDirection="column" width={vm.width} marginTop={gap ? 1 : undefined}>
      {children}
    </Box>
  )
}

/** A label and its value: on one row when they fit, else the value on a line of its own under the label. */
function keyValue(el: El, key: string, label: string, value: string, width: number): RenderElement[] {
  const LABEL = 40
  const { Text } = el
  if (LABEL + value.length <= width) {
    return [
      row(el, key, [
        { w: LABEL, text: label },
        { w: Math.max(1, width - LABEL), text: value },
      ]),
    ]
  }
  return [
    <Text key={`${key}a`} wrap="truncate-end">
      {cut(label, width)}
    </Text>,
    <Text key={`${key}b`} wrap="truncate-end">
      {cut(`  ${value}`, width)}
    </Text>,
  ]
}

// ---------------------------------------------------------------- the sections

function drawHead(el: El, vm: ViewModel, scope: 'task' | 'all', layout: ReturnType<typeof tokensLayout>): RenderElement {
  const { Box, Text, Button } = el
  const since = clockText(vm.board.loadedAt)
  const title =
    scope === 'all' ? `TOKENS · since ${since}, every task` : vm.board.taskId === null ? 'TOKENS · no task' : `TOKENS · task ${vm.board.taskId}`
  const label = (active: boolean, text: string) =>
    active ? (
      <Text bold underline wrap="truncate-end">
        {text}
      </Text>
    ) : (
      text
    )
  const buttons = (
    <Box key="scope">
      <Button key="scope-task" plain hotkey="1" dimColor={scope !== 'task'} onPress={() => vm.onScope?.('task')}>
        {label(scope === 'task', 'this task')}
      </Button>
      <Text wrap="truncate-end">{'  '}</Text>
      <Button key="scope-all" plain hotkey="2" dimColor={scope !== 'all'} onPress={() => vm.onScope?.('all')}>
        {label(scope === 'all', `since ${since}`)}
      </Button>
    </Box>
  )
  // the engine draws each hotkey's `1: ` / `2: ` itself, so it is counted here but not in the labels
  const buttonsWidth = `1: this task`.length + 2 + `2: since ${since}`.length
  if (layout.cls === 'wide') {
    return (
      <Box key="tokens-head" width={vm.width} marginTop={1}>
        <Box key="title" width={Math.max(1, vm.width - buttonsWidth - 2)}>
          <Text bold wrap="truncate-end">
            {title}
          </Text>
        </Box>
        {buttons}
      </Box>
    )
  }
  return (
    <Box key="tokens-head" flexDirection="column" width={vm.width} marginTop={1}>
      <Text key="title" bold wrap="truncate-end">
        {title}
      </Text>
      {buttons}
    </Box>
  )
}

type ChartRow = { label: string; tier: Tier | null; tokens: Tokens; partial: boolean }

function chartRows(s: UsageScope, leadTier: Tier | null): ChartRow[] {
  const rows: ChartRow[] = []
  if (s.lead.tokens !== null) rows.push({ label: `lead · ${s.lead.model}`, tier: leadTier, tokens: s.lead.tokens, partial: s.lead.partial })
  for (const r of s.rows) rows.push({ label: r.model, tier: r.tier, tokens: r.tokens, partial: r.partial })
  return rows
}

function drawChart(
  el: El,
  vm: ViewModel,
  key: string,
  title: string,
  rows: ChartRow[],
  of: (t: Tokens) => number,
  layout: ReturnType<typeof tokensLayout>,
  withShare: boolean,
): RenderElement {
  const total = rows.reduce((n, r) => n + of(r.tokens), 0)
  const max = rows.reduce((n, r) => Math.max(n, of(r.tokens)), 0)
  const small = layout.cls === 'tiny' || layout.bar < 4
  const lines = rows.map((r, i) => {
    const value = count(of(r.tokens), r.partial)
    if (small) {
      return row(el, `r${i}`, [
        { w: Math.max(1, vm.width - layout.value - 1), text: r.label, color: tierColorOf(r.tier) },
        { w: layout.value + 1, text: value, right: true },
      ])
    }
    const cells: Cell[] = [
      { w: layout.label, text: r.label, color: tierColorOf(r.tier) },
      { w: layout.bar, text: barCells(of(r.tokens), max, layout.bar), color: tierColorOf(r.tier), dim: r.partial, mono: true, exact: true },
      { w: layout.value, text: value, right: true },
    ]
    if (layout.cls === 'wide') cells.push({ w: 5, text: withShare ? pct(of(r.tokens), total) : '', right: true, dim: true })
    return row(el, `r${i}`, cells)
  })
  return section(el, vm, key, [heading(el, 'title', title), ...lines])
}

const tierColorOf = (tier: Tier | null): string => tierColor(tier)

function drawSplit(el: El, vm: ViewModel, s: UsageScope, leadTier: Tier | null, hasWorkers: boolean): RenderElement | null {
  const { Text } = el
  if (s.share === null) {
    return hasWorkers ? section(el, vm, 'tokens-split', prose(el, 'p', 'Delegated: not shown while some counts are partial (≥).', vm.width)) : null
  }
  const leadAll = s.lead.tokens === null ? 0 : allOf(s.lead.tokens)
  const all = s.all.tokens
  const total = allOf(all)
  const delegated = s.share.all
  const leadPct = 100 - delegated
  const prefix = `lead ${leadPct}% `
  const suffix = ` ${delegated}% delegated`
  const bar = vm.width - prefix.length - suffix.length
  if (bar < 4) {
    return section(el, vm, 'tokens-split', [
      <Text key="line" wrap="truncate-end">
        {cut(`lead ${leadPct}% · delegated ${delegated}%`, vm.width)}
      </Text>,
    ])
  }
  const leadBar = barCells(leadAll, total, bar)
  const rest = '▓'.repeat(Math.max(0, bar - leadBar.length))
  return section(el, vm, 'tokens-split', [
    <Text key="line" wrap="truncate-end" mono>
      {prefix}
      <Text color={tierColor(leadTier)} wrap="truncate-end">
        {leadBar}
      </Text>
      <Text color={'subtle' as any} wrap="truncate-end">
        {rest}
      </Text>
      {suffix}
    </Text>,
  ])
}

function substitution(r: UsageRow, narrow: boolean): string {
  const subs = TIER_ORDER.filter(t => (r.substituted[t] ?? 0) > 0)
  if (subs.length === 0) return ''
  return narrow ? ' *' : ` · incl. ${subs.map(t => `${r.substituted[t]} ${t}-tier`).join(', ')}`
}

function drawModels(el: El, vm: ViewModel, s: UsageScope, leadTier: Tier | null, layout: ReturnType<typeof tokensLayout>): RenderElement {
  const cls = layout.cls
  const narrow = cls === 'narrow' || cls === 'tiny'
  const cols: Array<{ head: string; w: number; of: (t: Tokens) => number; agents?: boolean }> =
    cls === 'wide'
      ? [
          { head: 'new', w: 8, of: newOf },
          { head: 'cached', w: 9, of: t => t.cacheRead },
          { head: 'out', w: 8, of: t => t.output },
          { head: 'req', w: 6, of: t => t.requests },
          { head: 'agents', w: 7, of: () => 0, agents: true },
        ]
      : cls === 'medium'
        ? [
            { head: 'in', w: 8, of: inOf },
            { head: 'out', w: 8, of: t => t.output },
          ]
        : [{ head: 'all', w: 8, of: allOf }]
  const labelW = Math.max(1, vm.width - cols.reduce((n, c) => n + c.w, 0))
  const cellsFor = (label: string, color: string | undefined, t: Tokens | null, partial: boolean, agents: number, bold = false): Cell[] => [
    { w: labelW, text: label, color, bold },
    ...cols.map(c => ({
      w: c.w,
      right: true,
      text: c.agents === true ? String(agents) : t === null ? 'n/a' : count(c.of(t), partial),
    })),
  ]
  const lines: RenderElement[] = [
    row(el, 'head', [{ w: labelW, text: 'by model', bold: true }, ...cols.map(c => ({ w: c.w, right: true, text: c.head, dim: true }))]),
    row(el, 'lead', cellsFor(`lead · ${s.lead.model}`, tierColor(leadTier), s.lead.tokens, s.lead.partial, s.lead.tokens === null ? 0 : 1)),
  ]
  let anySub = false
  s.rows.forEach((r, i) => {
    const sub = substitution(r, narrow)
    if (sub !== '') anySub = true
    const label = narrow && sub !== '' ? cut(r.model, Math.max(1, labelW - 1 - sub.length)) + sub : r.model + sub
    lines.push(row(el, `m${i}`, cellsFor(label, tierColor(r.tier), r.tokens, r.partial, r.agents)))
  })
  lines.push(row(el, 'all', cellsFor('all', undefined, s.all.tokens, s.all.partial, s.rows.reduce((n, r) => n + r.agents, 0) + (s.lead.tokens === null ? 0 : 1), true)))
  if (narrow && anySub) lines.push(...prose(el, 'key', '* incl. work of another tier', vm.width))
  return section(el, vm, 'tokens-models', lines)
}

function notesOf(w: WorkerUsage, glyphs: boolean): string {
  if (glyphs) {
    return [w.rejected ? '✗' : '', w.run >= 2 ? '↻' : '', w.partial ? '≥' : '', w.ungated ? '·' : ''].filter(g => g !== '').join(' ')
  }
  const parts: string[] = []
  if (w.rejected) parts.push('rejected')
  if (w.run >= 2) parts.push(`run ${w.run}`)
  if (w.ungated) parts.push('ungated')
  if (w.tokens === null) parts.push('n/a')
  else if (w.partial) parts.push('≥ partial')
  if (w.otherTask) parts.push('other task')
  return parts.join(', ')
}

function drawWorkers(el: El, vm: ViewModel, workers: WorkerUsage[], layout: ReturnType<typeof tokensLayout>): RenderElement {
  const cls = layout.cls
  const glyphs = cls === 'medium' || cls === 'narrow'
  if (workers.length === 0) {
    return section(el, vm, 'tokens-workers', [heading(el, 'title', 'by worker'), ...prose(el, 'none', 'Nothing delegated in this task yet.', vm.width)])
  }
  const shown = workers.slice(0, WORKERS_SHOWN)
  const rest = workers.slice(WORKERS_SHOWN)
  const val = (w: WorkerUsage, of: (t: Tokens) => number): string => (w.tokens === null ? 'n/a' : count(of(w.tokens), w.partial))

  let fixed: Array<{ head: string; w: number }>
  if (cls === 'wide') fixed = [{ head: 'model', w: 10 }, { head: 'st', w: 3 }, { head: 'in', w: 8 }, { head: 'out', w: 8 }, { head: 'req', w: 5 }]
  else if (cls === 'medium') fixed = [{ head: 'in', w: 8 }, { head: 'out', w: 8 }]
  else fixed = [{ head: 'all', w: 8 }]
  const noteW = cls === 'wide' ? Math.max(8, vm.width - 54) : glyphs ? 8 : 0
  const labelW = Math.max(1, vm.width - fixed.reduce((n, c) => n + c.w, 0) - noteW)

  const head: Cell[] = [{ w: labelW, text: 'by worker', bold: true }]
  if (cls === 'wide') head.push({ w: 10, text: 'model', dim: true }, { w: 3, text: 'st', dim: true, right: true })
  for (const c of fixed.filter(c => c.head !== 'model' && c.head !== 'st')) head.push({ w: c.w, text: c.head, dim: true, right: true })
  if (noteW > 0) head.push({ w: noteW, text: 'note', dim: true })

  const lines: RenderElement[] = [row(el, 'head', head)]
  let anyGlyph = { rejected: false, run: false, partial: false, ungated: false }
  shown.forEach((w, i) => {
    const cells: Cell[] = [{ w: labelW, text: w.label }]
    if (cls === 'wide') {
      cells.push({ w: 10, text: w.model, color: tierColor(w.tier) }, { w: 3, text: statusGlyph(w.status), right: true })
      cells.push({ w: 8, text: val(w, inOf), right: true }, { w: 8, text: val(w, t => t.output), right: true }, { w: 5, text: w.tokens === null ? 'n/a' : count(w.tokens.requests, w.partial), right: true })
    } else if (cls === 'medium') {
      cells.push({ w: 8, text: val(w, inOf), right: true }, { w: 8, text: val(w, t => t.output), right: true })
    } else {
      cells.push({ w: 8, text: val(w, allOf), right: true })
    }
    if (noteW > 0) cells.push({ w: noteW, text: notesOf(w, glyphs) })
    if (w.rejected) anyGlyph.rejected = true
    if (w.run >= 2) anyGlyph.run = true
    if (w.partial) anyGlyph.partial = true
    if (w.ungated) anyGlyph.ungated = true
    lines.push(row(el, `w${i}`, cells))
  })
  if (rest.length > 0) {
    let inSum = 0
    let outSum = 0
    let uncertain = false
    for (const w of rest) {
      if (w.tokens === null || w.partial) uncertain = true
      if (w.tokens !== null) {
        inSum += inOf(w.tokens)
        outSum += w.tokens.output
      }
    }
    lines.push(...prose(el, 'more', `+${rest.length} more · in ${count(inSum, uncertain)} out ${count(outSum, uncertain)}`, vm.width))
  }
  if (glyphs) {
    const keys = [
      anyGlyph.rejected ? '✗ rejected' : '',
      anyGlyph.run ? '↻ run 2 or later' : '',
      anyGlyph.partial ? '≥ partial' : '',
      anyGlyph.ungated ? '· ungated' : '',
    ].filter(k => k !== '')
    if (keys.length > 0) lines.push(...prose(el, 'key', keys.join('  '), vm.width))
  }
  return section(el, vm, 'tokens-workers', lines)
}

function drawKept(el: El, vm: ViewModel, s: UsageScope, hasWorkers: boolean): RenderElement {
  const k = s.kept
  const lines: RenderElement[] = [heading(el, 'title', 'kept out of the lead')]
  if (!hasWorkers) {
    lines.push(...prose(el, 'none', 'none', vm.width))
    return section(el, vm, 'tokens-kept', lines)
  }
  lines.push(...keyValue(el, 'peaks', "workers' largest contexts, summed", `${count(k.peaks, k.partial)} tokens`, vm.width))
  lines.push(...keyValue(el, 'back', 'their answers back', `${formatCount(k.back)} chars`, vm.width))
  lines.push(...keyValue(el, 'lead', "the lead's largest context", k.leadPeak === null ? 'n/a' : `${formatCount(k.leadPeak)} tokens`, vm.width))
  lines.push(...keyValue(el, 'in', "workers' input over all their requests", `${count(k.workersIn, k.partial)} tokens  (each request counts its whole context again)`, vm.width))
  return section(el, vm, 'tokens-kept', lines)
}

function drawOverhead(el: El, vm: ViewModel, s: UsageScope): RenderElement {
  const o = s.overhead
  const agents = (n: number): string => plural(n, 'agent', 'agents')
  const counted = (c: { agents: number; in: number; out: number; partial: boolean }): string =>
    c.agents === 0 ? 'none' : `${agents(c.agents)} · in ${count(c.in, c.partial)} out ${count(c.out, c.partial)}`
  const together =
    o.together.agents === 0
      ? 'none'
      : o.together.share === null
        ? counted(o.together)
        : `${agents(o.together.agents)} · ${o.together.share}% of all tokens`
  const lines: RenderElement[] = [heading(el, 'title', 'overhead')]
  lines.push(...keyValue(el, 'rej', 'runs whose unit was rejected', counted(o.rejected), vm.width))
  lines.push(...keyValue(el, 'later', 'later runs of a unit already run', counted(o.later), vm.width))
  lines.push(...keyValue(el, 'tog', 'together, each agent once', together, vm.width))
  lines.push(
    ...keyValue(
      el,
      'brief',
      'briefs and follow-up messages',
      o.briefAgents === 0 ? 'none' : `${formatCount(o.briefChars)} chars to ${agents(o.briefAgents)} (part of the lead's out)`,
      vm.width,
    ),
  )
  lines.push(
    ...keyValue(
      el,
      'board',
      'board updates',
      o.board.calls === 0 ? 'none' : `${plural(o.board.calls, 'call', 'calls')} · ${formatCount(o.board.chars)} chars (part of the lead's out)`,
      vm.width,
    ),
  )
  const injected = vm.injected ?? []
  if (injected.length > 0) {
    const chars = injected.reduce((n, p) => n + p.chars, 0)
    const requests = s.lead.tokens?.requests ?? 0
    lines.push(
      ...keyValue(
        el,
        'inj',
        "Flowestra's text in the lead's prompt",
        `${formatCount(chars)} chars, sent with each of the lead's ${plural(requests, 'request', 'requests')}`,
        vm.width,
      ),
    )
  }
  return section(el, vm, 'tokens-overhead', lines)
}

/** The Tokens tab: the navbar, one blank row (the head's marginTop, 0.15.0), then the sections of the design in order, drawn in full (the pane scrolls). */
export function drawTokens(el: El, vm: ViewModel): RenderElement {
  const { Box } = el
  const scope = (vm.ui as { scope?: 'task' | 'all' }).scope === 'all' ? 'all' : 'task'
  const layout = tokensLayout(vm.width)
  const since = clockText(vm.board.loadedAt)
  const children: RenderElement[] = [drawNav(el, vm), drawHead(el, vm, scope, layout)]

  const sinceLines = prose(el, 's', "measured from each request's reported usage · nothing estimated", vm.width)
  if (!hasUsage(vm.board)) {
    sinceLines.push(...prose(el, 'e', 'No token counts yet. They appear after the first model request the board sees.', vm.width, false))
    children.push(section(el, vm, 'tokens-since', sinceLines, false))
  } else {
    children.push(section(el, vm, 'tokens-since', sinceLines, false))
    const s = usageScope(vm.board, scope)
    const workers = workerUsage(vm.board, scope)
    const leadTier = modelTier(vm.board.agents.main?.model ?? null)
    const split = drawSplit(el, vm, s, leadTier, workers.length > 0)
    if (split !== null) children.push(split)
    const rows = chartRows(s, leadTier)
    if (rows.length >= 2) {
      const certain = !s.all.partial && s.partialAgents === 0 && s.unknownAgents === 0
      children.push(drawChart(el, vm, 'tokens-in', 'in, by model', rows, inOf, layout, certain))
      children.push(drawChart(el, vm, 'tokens-out', 'out, by model', rows, t => t.output, layout, certain))
    }
    children.push(drawModels(el, vm, s, leadTier, layout))
    children.push(drawWorkers(el, vm, workers, layout))
    children.push(drawKept(el, vm, s, workers.length > 0))
    children.push(drawOverhead(el, vm, s))
  }

  const notes = [`counted since ${since}, when the board started.`, 'Not shown: how many tokens the same work would use without Flowestra.']
  const noteLines = notes.flatMap((t, i) => prose(el, `n${i}`, t, vm.width))
  children.push(section(el, vm, 'tokens-notes', noteLines))
  return (
    <Box key="tokens" flexDirection="column" width={vm.width}>
      {children}
    </Box>
  )
}
