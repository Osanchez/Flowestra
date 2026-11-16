// Gate health and the ungated marks (0.11.0, decisions.md "Gate hardening: the
// exceptions and a visible degraded state", 4.4). Pure: type-only imports, plus
// `formatDuration` and `EXEMPT_TYPES` from ./state; no `$`. The texts here are
// the ones the view, the session log, the audit file and the AgentBoard answer
// show.

import type { PluginOptions } from 'claude-code'

import type { GateCheck, GateFault, GateHealth, GateRecord, Ungated, UngatedMark } from '../types'
import { EXEMPT_TYPES, formatDuration } from './state'

export const GATE_SHAPE = 'gate-1'
export const GATE_ON_ERROR_SETTING = 'gateOnError'

/** `refuse` only when the setting is exactly `'refuse'`; otherwise `allow`. */
export const gateOnError = (options: PluginOptions | undefined): 'allow' | 'refuse' => {
  const value: unknown = options?.[GATE_ON_ERROR_SETTING]
  return value === 'refuse' ? 'refuse' : 'allow'
}

export const emptyHealth = (now: number): GateHealth => ({ checkFailures: 0, recordFailures: 0, last: null, since: now })

const CHECKS: readonly string[] = ['spawn check', 'spec check', 'context check', 'fork check', 'spawn hook']

export const isCheck = (where: GateCheck | GateRecord): boolean => CHECKS.includes(where)

/** Counts the fault by its kind and keeps it as `last`. Never mutates. */
export const recordFault = (h: GateHealth, f: GateFault): GateHealth =>
  isCheck(f.where)
    ? { ...h, checkFailures: h.checkFailures + 1, last: f }
    : { ...h, recordFailures: h.recordFailures + 1, last: f }

export const isDegraded = (h: GateHealth): boolean => h.checkFailures > 0

const ERROR_CUT = 160

/** Whitespace collapsed, ` | ` replaced by ` / `, cut to 160 characters (`…` appended when cut), `unknown error` when empty. */
export const faultError = (err: unknown): string => {
  const raw = err === undefined || err === null ? '' : err instanceof Error ? err.message : String(err)
  const text = raw.replace(/\s+/g, ' ').trim().split(' | ').join(' / ')
  if (text === '') return 'unknown error'
  return text.length > ERROR_CUT ? text.slice(0, ERROR_CUT) + '…' : text
}

const field = (text: string): string => text.replace(/\s+/g, ' ').trim().split(' | ').join(' / ')

/** `<ISO time> | !gate-error | <agent id or -> | <check> | <outcome> | <error>` */
export const gateFaultLine = (iso: string, agentId: string | null, f: GateFault): string =>
  `${iso} | !gate-error | ${agentId ?? '-'} | ${f.where} | ${f.outcome} | ${f.error}`

/** `<ISO time> | !ungated | <agent id> | <why>[ <run id>] | <agent type> | <model or -> | <description, cut to 60>` */
export const ungatedLine = (
  iso: string,
  agentId: string,
  mark: UngatedMark,
  subagentType: string,
  model: string | null,
  description: string,
): string =>
  `${iso} | !ungated | ${agentId} | ${mark.why}${mark.run ? ' ' + mark.run : ''} | ${subagentType} | ${model ?? '-'} | ${field(description).slice(0, 60)}`

export const UNGATED_SHORT: Record<Ungated, string> = {
  workflow: 'workflow',
  resumed: 'resumed',
  nested: 'nested',
  exempt: 'exempt',
  unseen: 'unseen',
}

/** The session-log text after `ungated: ` (5.2); `type` is the box's agent type. */
export const ungatedDetail = (mark: UngatedMark, type: string): string => {
  switch (mark.why) {
    case 'workflow':
      return `workflow run${mark.run ? ' ' + mark.run : ''}: its agents start unchecked`
    case 'resumed':
      return 'resumed run of an agent no unit covered'
    case 'exempt':
      return `exempt type ${type}`
    case 'unseen':
      return 'not seen by the gate (a skill in its own agent, or started before the board loaded)'
    case 'nested':
      return 'started by another agent'
  }
}

export const gateStatusValue = (h: GateHealth): string => `degraded · ${h.checkFailures} failed`

export const gateBandPart = (h: GateHealth): string => `gate degraded (${h.checkFailures})`

/** `gate failed: <where> (<error cut to 60>) · <label> <outcome>`; the label and its space are omitted when null. */
export const gateLogText = (f: GateFault, label: string | null): string =>
  `gate failed: ${f.where} (${f.error.slice(0, 60)}) · ${label === null ? '' : label + ' '}${f.outcome}`

/** The one-time transcript notice (3.4). */
export const gateNotice = (f: GateFault, auditPath: string, strict: boolean): string =>
  `Flowestra: a check of the spawn gate failed (${f.where}: ${f.error}), so that spawn ` +
  (strict ? 'was refused (setting "When the gate fails": refuse)' : 'started unchecked') +
  `. The board shows "gate degraded" until the mod loads again; every failure is written to ${auditPath}.`

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

/** The AgentBoard answer's gate line (5.4); empty when nothing failed. */
export const gateAnswerLine = (h: GateHealth, now: number, auditPath: string): string => {
  const last = h.last
  const lastText = last === null ? '' : `${last.where}: ${last.error}`
  if (h.checkFailures > 0) {
    const verb = last !== null && last.outcome.startsWith('refused') ? 'was refused' : 'started unchecked'
    const ago = last === null ? '' : `, the last ${formatDuration(now - last.at)} ago (${lastText})`
    const records = h.recordFailures > 0 ? ` ${h.recordFailures} ${plural(h.recordFailures, 'record', 'records')} could not be written.` : ''
    return (
      `gate degraded: ${h.checkFailures} check ${plural(h.checkFailures, 'failure', 'failures')} since the mod loaded${ago}; ` +
      `a spawn checked during a failure ${verb}. Tell the user. Failures are in ${auditPath}.` +
      records
    )
  }
  if (h.recordFailures > 0) {
    return (
      `gate records: ${h.recordFailures} ${plural(h.recordFailures, 'record', 'records')} could not be written since the mod loaded` +
      `${last === null ? '' : ` (last: ${lastText})`}; the checks themselves ran. Details in ${auditPath}.`
    )
  }
  return ''
}

/** The strict-mode refusal text (5.1). */
export const strictRefusal = (where: GateCheck, error: string): string =>
  `Spawn refused: the Agent Board's gate could not check this spawn (${where}: ${error}), and the Flowestra setting "When the gate fails" is set to refuse. Do the work yourself, or ask the user to set it back to allow in /config.`

/** Which pass rule a spawn falls under. A fork is `checked` (the gate refuses forks); a nested spawn is `checked` too. */
export const classifySpawn = (e: {
  workflow?: unknown
  resume?: unknown
  subagentType: string
  fork: boolean
}): 'workflow' | 'resume' | 'exempt' | 'checked' => {
  if (e.fork) return 'checked'
  if (e.workflow !== undefined) return 'workflow'
  if (e.resume !== undefined) return 'resume'
  if (EXEMPT_TYPES.includes(e.subagentType)) return 'exempt'
  return 'checked'
}
