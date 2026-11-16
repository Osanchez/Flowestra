// The orchestrator's side of the Agent Board (spec 2.5): the `AgentBoard`
// tool the orchestrator declares task, phase, wave and work units through,
// the system-prompt section that tells it to, and the `/board` command.
// A unit a worker carries out (0.6.0) names its tier (opus, sonnet or haiku:
// what the Model Routing Policy's §1 selected), its task type (kind), its §9
// audit line, once checked its verdict, and the approved spec it builds from;
// a unit the orchestrator carries out itself has no tier and names `declared`.
// A unit may also name context (0.7.0): up to 8 paths or task:unit references
// whose text goes into its worker's brief. Work is kept as tasks: `taskId`,
// `repo` and `close` say which task an update is about, and a task's units,
// phase and wave belong to it.
// The policy's own prompt section (./policy) is added beside the board's.
// This file holds pure pieces and two registration helpers; `register.tsx`
// (U4) writes the hooks, since `claude plugin validate` refuses `$` handed to
// a callback and a second unmatched `session.start` or `prompt.compose` hook.

import type { EngineInterface, PromptComposeSection } from 'claude-code'

import type { Phase, TaskKind, Tier, Unit, Verdict } from '../types'
import {
  AUDIT_MAX_CHARS,
  KINDS_BY_TIER,
  POLICY_SECTION_ID,
  ROUTING_POLICY_SECTION,
  routingPolicySection,
  SPEC_MAX_CHARS,
  TIERS,
  VERDICTS,
  auditParts,
} from './policy'
import { labelKey } from './state'
import { workflowSection } from './workflow'
import type { WorkflowMode } from './workflow'

export { POLICY_SECTION_ID, ROUTING_POLICY_SECTION } from './policy'

// ---------------------------------------------------------------------------
// The update the tool accepts
// ---------------------------------------------------------------------------

export type BoardUpdate = {
  taskId?: string
  repo?: string
  close?: true
  task?: string
  phase?: Phase
  wave?: number
  units?: Unit[]
}

export type ParseResult =
  | { ok: true; update: BoardUpdate }
  | { ok: false; reason: string }

export type BoardToggleResult = 'opened' | 'closed' | 'waiting'

export const PHASES: readonly Phase[] = [
  'analysis',
  'design',
  'approval',
  'executing',
  'testing',
  'review',
  'done',
]
export const DECLARED_VALUES = ['pending', 'done', 'failed'] as const
export const TASK_MAX_CHARS = 120
export const LABEL_MAX_WORDS = 4
export const CONTEXT_MAX_ITEMS = 8
export const CONTEXT_ITEM_MAX_CHARS = 500
export const REPO_MAX_CHARS = 500
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/

const UPDATE_FIELDS = ['task', 'taskId', 'repo', 'close', 'phase', 'wave', 'units'] as const
const UNIT_FIELDS = ['id', 'label', 'wave', 'dependsOn', 'declared', 'tier', 'kind', 'audit', 'verdict', 'spec', 'context'] as const
// Every task type, in tier order (the opus list holds them all).
const ALL_KINDS: readonly TaskKind[] = KINDS_BY_TIER.opus
const RETIRED_HAIKU_KINDS: readonly TaskKind[] = ['execute', 'edit']
const AUDIT_FORMAT = '<task> | <tier> | <§1 step and conditions that selected it> | <what catches an error>'

export const BOARD_TOOL = 'AgentBoard'
// What the engine lists a registered tool as: `mcp__<plugin>__<name>`.
export const BOARD_TOOL_FULL_NAME = 'mcp__flowestra__AgentBoard'
export const BOARD_COMMAND = 'board'
export const PROMPT_SECTION_ID = 'flowestra:orchestrator'

// Keys `tool.call` carries beside the tool's own arguments (ToolCallReserved,
// AgentLoop, ToolRequestMeta); the tool never sees them.
const RESERVED_CALL_KEYS = ['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'object') return 'an object'
  return String(value)
}

function unknownFieldReason(where: string, key: string, allowed: readonly string[]): string {
  const tokenNote = /token/i.test(key)
    ? ' (token counts are measured by the board, never declared)'
    : ''
  return `${where}unknown field "${key}"${tokenNote}; allowed fields are ${allowed.join(', ')}`
}

function isWave(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(word => word.length > 0).length
}

type UnitParse = { ok: true; unit: Unit } | { ok: false; reason: string }

function parseUnit(raw: unknown, index: number): UnitParse {
  const at = `units[${index}]`
  if (!isPlainObject(raw)) {
    return { ok: false, reason: `${at}: must be an object, got ${describeValue(raw)}` }
  }
  const rawId = raw.id
  if (typeof rawId !== 'string' || rawId.trim().length === 0) {
    return { ok: false, reason: `${at}: field "id" must be a non-empty string, got ${describeValue(rawId)}` }
  }
  const id = rawId.trim()
  const where = `unit "${id}" (${at}): `
  for (const key of Object.keys(raw)) {
    if (!(UNIT_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, reason: unknownFieldReason(where, key, UNIT_FIELDS) }
    }
  }

  const rawLabel = raw.label
  if (typeof rawLabel !== 'string' || rawLabel.trim().length === 0) {
    return { ok: false, reason: `${where}field "label" must be a non-empty string of 1 to ${LABEL_MAX_WORDS} words, got ${describeValue(rawLabel)}` }
  }
  const label = rawLabel.trim().split(/\s+/).join(' ')
  const words = wordCount(label)
  if (words > LABEL_MAX_WORDS) {
    return { ok: false, reason: `${where}field "label" has ${words} words ("${label}"); at most ${LABEL_MAX_WORDS} are allowed` }
  }

  if (!isWave(raw.wave)) {
    return { ok: false, reason: `${where}field "wave" must be an integer of at least 1, got ${describeValue(raw.wave)}` }
  }
  const wave = raw.wave

  let dependsOn: string[] = []
  if (raw.dependsOn !== undefined) {
    if (!Array.isArray(raw.dependsOn)) {
      return { ok: false, reason: `${where}field "dependsOn" must be an array of unit ids, got ${describeValue(raw.dependsOn)}` }
    }
    const ids: string[] = []
    for (let i = 0; i < raw.dependsOn.length; i++) {
      const dep: unknown = raw.dependsOn[i]
      if (typeof dep !== 'string' || dep.trim().length === 0) {
        return { ok: false, reason: `${where}field "dependsOn"[${i}] must be a non-empty unit id, got ${describeValue(dep)}` }
      }
      ids.push(dep.trim())
    }
    dependsOn = ids
  }

  let declared: Unit['declared'] = null
  if (raw.declared !== undefined && raw.declared !== null) {
    const value = raw.declared
    if (typeof value !== 'string' || !(DECLARED_VALUES as readonly string[]).includes(value)) {
      return { ok: false, reason: `${where}field "declared" must be one of ${DECLARED_VALUES.join(', ')}, got ${describeValue(value)}` }
    }
    declared = value as (typeof DECLARED_VALUES)[number]
  }

  // tier, kind, audit, verdict and spec: undefined and null both mean "not given".
  const given = (value: unknown): boolean => value !== undefined && value !== null

  if (!given(raw.tier)) {
    for (const field of ['kind', 'audit', 'verdict', 'spec', 'context'] as const) {
      if (given(raw[field])) {
        return { ok: false, reason: `${where}field "${field}" is only for a unit with a tier` }
      }
    }
    if (declared === null) {
      return { ok: false, reason: `${where}a unit a worker carries out needs "tier", "kind" and "audit" (policy §9); a unit you carry out yourself needs "declared"` }
    }
    return { ok: true, unit: { id, label, wave, dependsOn, declared, tier: null, kind: null, audit: null, verdict: null, spec: null, context: [] } }
  }

  const rawTier = raw.tier
  if (typeof rawTier !== 'string' || !(TIERS as readonly string[]).includes(rawTier)) {
    return { ok: false, reason: `${where}field "tier" must be one of ${TIERS.join(', ')}, got ${describeValue(rawTier)}` }
  }
  const tier = rawTier as Tier
  const kinds = KINDS_BY_TIER[tier]

  if (!given(raw.kind)) {
    return { ok: false, reason: `${where}a ${tier} unit needs field "kind", one of ${kinds.join(', ')}` }
  }
  const rawKind = raw.kind
  // A resumed task's history may hold a haiku unit of a kind haiku lost in 0.10; with a verdict it is accepted as it is.
  const retired =
    tier === 'haiku' &&
    typeof rawKind === 'string' &&
    (RETIRED_HAIKU_KINDS as readonly string[]).includes(rawKind) &&
    (raw.verdict === 'accepted' || raw.verdict === 'rejected')
  if (!retired && typeof rawKind === 'string' && (ALL_KINDS as readonly string[]).includes(rawKind) && !(kinds as readonly string[]).includes(rawKind)) {
    return { ok: false, reason: `${where}kind "${rawKind}" is not a ${tier} task type (${tier} takes ${kinds.join(', ')}); route the unit to a higher tier` }
  }
  if (typeof rawKind !== 'string' || (!retired && !(kinds as readonly string[]).includes(rawKind))) {
    return { ok: false, reason: `${where}field "kind" must be one of ${kinds.join(', ')}, got ${describeValue(rawKind)}` }
  }
  const kind = rawKind as TaskKind

  const rawAudit = raw.audit
  if (typeof rawAudit !== 'string' || rawAudit.trim().length === 0) {
    return { ok: false, reason: `${where}a ${tier} unit needs field "audit", the policy §9 line "${AUDIT_FORMAT}"; if any field can't be filled in, route to Opus` }
  }
  const trimmedAudit = rawAudit.trim()
  if (trimmedAudit.length > AUDIT_MAX_CHARS) {
    return { ok: false, reason: `${where}field "audit" is ${trimmedAudit.length} characters after trimming; at most ${AUDIT_MAX_CHARS} are allowed` }
  }
  const parts = auditParts(trimmedAudit)
  if (parts === null) {
    return { ok: false, reason: `${where}field "audit" must have exactly four non-empty parts separated by "|": ${AUDIT_FORMAT}; if any field can't be filled in, route to Opus` }
  }
  const [task, auditTierPart, route, check] = parts
  if (auditTierPart.toLowerCase() !== tier) {
    return { ok: false, reason: `${where}field "audit" names tier "${auditTierPart}" but the unit's tier is "${tier}"` }
  }
  const audit = [task, auditTierPart.toLowerCase(), route, check].join(' | ')

  let verdict: Verdict | null = null
  if (given(raw.verdict)) {
    const value = raw.verdict
    if (typeof value !== 'string' || !(VERDICTS as readonly string[]).includes(value)) {
      return { ok: false, reason: `${where}field "verdict" must be one of ${VERDICTS.join(', ')}, got ${describeValue(value)}` }
    }
    verdict = value as Verdict
  }

  let spec: string | null = null
  if (given(raw.spec)) {
    const value = raw.spec
    if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > SPEC_MAX_CHARS) {
      return { ok: false, reason: `${where}field "spec" must be a non-empty path of at most ${SPEC_MAX_CHARS} characters, got ${describeValue(value)}` }
    }
    spec = value.trim()
  }

  let context: string[] = []
  if (given(raw.context)) {
    const value = raw.context
    if (!Array.isArray(value)) {
      return { ok: false, reason: `${where}field "context" must be an array of at most ${CONTEXT_MAX_ITEMS} paths or task:unit references, got ${describeValue(value)}` }
    }
    if (value.length > CONTEXT_MAX_ITEMS) {
      return { ok: false, reason: `${where}field "context" has ${value.length} items; at most ${CONTEXT_MAX_ITEMS} are allowed` }
    }
    const items: string[] = []
    for (let i = 0; i < value.length; i++) {
      const item: unknown = value[i]
      if (typeof item !== 'string' || item.trim().length === 0 || item.trim().length > CONTEXT_ITEM_MAX_CHARS) {
        return { ok: false, reason: `${where}field "context"[${i}] must be a non-empty string of at most ${CONTEXT_ITEM_MAX_CHARS} characters, got ${describeValue(item)}` }
      }
      items.push(item.trim())
    }
    context = items
  }

  return { ok: true, unit: { id, label, wave, dependsOn, declared, tier, kind, audit, verdict, spec, context } }
}

// The first dependency cycle found, as a path that ends where it started, or null.
function findCycle(units: readonly Unit[]): string[] | null {
  const byId = new Map(units.map(unit => [unit.id, unit] as const))
  const state = new Map<string, 'visiting' | 'done'>()
  const path: string[] = []

  const visit = (id: string): string[] | null => {
    const seen = state.get(id)
    if (seen === 'done') return null
    if (seen === 'visiting') return [...path.slice(path.indexOf(id)), id]
    state.set(id, 'visiting')
    path.push(id)
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const cycle = visit(dep)
      if (cycle) return cycle
    }
    path.pop()
    state.set(id, 'done')
    return null
  }

  for (const unit of units) {
    const cycle = visit(unit.id)
    if (cycle) return cycle
  }
  return null
}

function parseUnits(raw: unknown): { ok: true; units: Unit[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: `field "units" must be an array (the full list of work units), got ${describeValue(raw)}` }
  }
  const units: Unit[] = []
  const firstIndex = new Map<string, number>()
  for (let i = 0; i < raw.length; i++) {
    const parsed = parseUnit(raw[i], i)
    if (!parsed.ok) return parsed
    const earlier = firstIndex.get(parsed.unit.id)
    if (earlier !== undefined) {
      return { ok: false, reason: `unit "${parsed.unit.id}" (units[${i}]): field "id" repeats units[${earlier}]; every unit id must be unique` }
    }
    const key = labelKey(parsed.unit.label)
    const sameLabel = units.find(other => labelKey(other.label) === key)
    if (sameLabel) {
      return { ok: false, reason: `unit "${parsed.unit.id}" (units[${i}]): label "${parsed.unit.label}" repeats unit "${sameLabel.id}"'s; labels must differ within a task` }
    }
    firstIndex.set(parsed.unit.id, i)
    units.push(parsed.unit)
  }
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]!
    for (const dep of unit.dependsOn) {
      if (dep === unit.id) {
        return { ok: false, reason: `unit "${unit.id}" (units[${i}]): field "dependsOn" names the unit itself; a unit cannot depend on itself` }
      }
      if (!firstIndex.has(dep)) {
        return { ok: false, reason: `unit "${unit.id}" (units[${i}]): field "dependsOn" names "${dep}", which is not a unit id in this list` }
      }
    }
  }
  const cycle = findCycle(units)
  if (cycle) {
    return { ok: false, reason: `field "units": dependency cycle ${cycle.map(id => `"${id}"`).join(' -> ')}; dependencies must not loop` }
  }
  return { ok: true, units }
}

/**
 * Validates an `AgentBoard` input. Pure. Every field is optional, at least
 * one must be present, and unknown fields are refused; the reason names the
 * first problem (which unit, which field).
 */
export function parseBoardUpdate(input: unknown): ParseResult {
  if (!isPlainObject(input)) {
    return { ok: false, reason: `the update must be an object with any of ${UPDATE_FIELDS.join(', ')}, got ${describeValue(input)}` }
  }
  for (const key of Object.keys(input)) {
    if (!(UPDATE_FIELDS as readonly string[]).includes(key)) {
      return { ok: false, reason: unknownFieldReason('', key, UPDATE_FIELDS) }
    }
  }
  const present = UPDATE_FIELDS.filter(key => input[key] !== undefined)
  if (present.length === 0) {
    return { ok: false, reason: `empty update: give at least one of ${UPDATE_FIELDS.join(', ')}` }
  }

  const update: BoardUpdate = {}

  if (input.taskId !== undefined) {
    const id = typeof input.taskId === 'string' ? input.taskId.trim() : null
    if (id === null || !TASK_ID_PATTERN.test(id)) {
      return { ok: false, reason: `field "taskId" must be 2 to 32 characters of a-z, 0-9 and "-", starting with a letter or digit, got ${describeValue(input.taskId)}` }
    }
    update.taskId = id
  }

  if (input.repo !== undefined) {
    const repo = typeof input.repo === 'string' ? input.repo.trim() : null
    if (repo === null || repo.length > REPO_MAX_CHARS || !(repo.startsWith('/') || /^[A-Za-z]:/.test(repo))) {
      return { ok: false, reason: `field "repo" must be an absolute path of at most ${REPO_MAX_CHARS} characters, got ${describeValue(input.repo)}` }
    }
    update.repo = repo
  }

  if (input.close !== undefined) {
    if (input.close !== true) {
      return { ok: false, reason: `field "close" must be true when given, got ${describeValue(input.close)}` }
    }
    update.close = true
  }

  if (input.task !== undefined) {
    if (typeof input.task !== 'string') {
      return { ok: false, reason: `field "task" must be a string, got ${describeValue(input.task)}` }
    }
    const task = input.task.trim()
    if (task.length === 0) {
      return { ok: false, reason: 'field "task" is empty; give a one-line summary of the task' }
    }
    if (task.length > TASK_MAX_CHARS) {
      return { ok: false, reason: `field "task" is ${task.length} characters after trimming; at most ${TASK_MAX_CHARS} are allowed` }
    }
    update.task = task
  }

  if (input.phase !== undefined) {
    const phase = input.phase
    if (typeof phase !== 'string' || !(PHASES as readonly string[]).includes(phase)) {
      return { ok: false, reason: `field "phase" must be one of ${PHASES.join(', ')}, got ${describeValue(phase)}` }
    }
    update.phase = phase as Phase
  }

  if (input.wave !== undefined) {
    if (!isWave(input.wave)) {
      return { ok: false, reason: `field "wave" must be an integer of at least 1, got ${describeValue(input.wave)}` }
    }
    update.wave = input.wave
  }

  if (input.units !== undefined) {
    const parsed = parseUnits(input.units)
    if (!parsed.ok) return parsed
    update.units = parsed.units
  }

  return { ok: true, update }
}

/** The one line the tool answers with, e.g. `board updated: phase executing, wave 2, 5 units`. */
export function summarizeUpdate(update: BoardUpdate): string {
  const parts: string[] = []
  if (update.taskId !== undefined) parts.push(`task ${update.taskId}`)
  if (update.close !== undefined) parts.push('closed')
  if (update.task !== undefined) parts.push('task set')
  if (update.phase !== undefined) parts.push(`phase ${update.phase}`)
  if (update.wave !== undefined) parts.push(`wave ${update.wave}`)
  if (update.units !== undefined) {
    const count = update.units.length
    const byTier = TIERS.map(tier => ({ tier, n: update.units!.filter(unit => unit.tier === tier).length }))
      .filter(entry => entry.n > 0)
    const tierNote = byTier.length > 0 ? ` (${byTier.map(entry => `${entry.n} ${entry.tier}`).join(', ')})` : ''
    parts.push(`${count} unit${count === 1 ? '' : 's'}${tierNote}`)
  }
  return `board updated: ${parts.join(', ')}`
}

/** The tool's arguments alone: `tool.call`'s reserved keys taken off. */
export function toolArguments(e: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(e)) {
    if (!RESERVED_CALL_KEYS.includes(key)) args[key] = value
  }
  return args
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const BOARD_TOOL_DESCRIPTION = [
  'Updates the Agent Board, the live pane beside the chat that shows you (the orchestrator) and your worker agents.',
  'Never call it alone: send it in the same response as your next action (a unit may be declared in the response that spawns it), with only the fields that changed; every field is optional, but give at least one.',
  'Fields:',
  `- task: one-line summary of the whole task, at most ${TASK_MAX_CHARS} characters.`,
  '- taskId: the task (workstream) this update is about: a short fixed id (2 to 32 characters, a-z, 0-9 and "-"). An id that is not open opens a task (give its task line and, when it is not this session\'s folder, its repo); an open id switches to it; with no taskId the update goes to the active task. Units, phase and wave belong to their task, and a worker is always spawned under the active task: switch before you spawn for another one.',
  '- repo: the absolute path of the repository or folder the task works in (default: this session\'s).',
  '- close: true closes the active task.',
  `- phase: one of ${PHASES.join(', ')}.`,
  '- wave: the wave of workers now running or about to start, an integer from 1.',
  '- units: the FULL list of work units (it replaces the previous list). Each unit: id (unique; give the Agent call that carries it out a `name` equal to this id, or, where the Agent tool takes no name, a description equal to the unit\'s label), label (1 to 4 words), wave (integer from 1), dependsOn (ids of units in this same list that must finish first; never the unit itself, no cycles; default []), declared (pending, done or failed: only for a unit you carry out yourself, which has no tier), and for a unit a worker carries out: tier (opus, sonnet or haiku: what the Model Routing Policy\'s §1 selected), kind (the task type; haiku: locate, extract or inventory; sonnet: those and execute, edit, implement, tests, fix, explore, summarize, review or docs; opus: any of those, design or debug), audit (the policy §9 line "<task> | <tier> | <§1 step and conditions that selected it> | <what catches an error>", its tier part naming the unit\'s tier), verdict (optional: accepted or rejected, sent once you have checked its output, policy §7), spec (optional: the path of the approved spec the unit builds from) and context (optional: up to 8 things the worker is given, each an absolute path, optionally with "#heading", or "<task-id>:<unit-id>" for that unit\'s newest journal entry; their text is placed in the worker\'s brief).',
  'A unit a worker carries out with no tier, no kind or no complete audit line is refused; a unit you carry out yourself has no tier and takes declared instead. A unit that uses another unit\'s results names it in its dependsOn.',
  'Running, blocked, done and token counts are measured by the board from the agents themselves: never send token counts or any other field.',
  'Invalid input is refused with the reason and the board keeps its previous value.',
].join('\n')

export const BOARD_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    task: {
      type: 'string',
      minLength: 1,
      maxLength: TASK_MAX_CHARS,
      description: `One-line summary of the task, at most ${TASK_MAX_CHARS} characters.`,
    },
    taskId: {
      type: 'string',
      pattern: '^\\s*[a-z0-9][a-z0-9-]{1,31}\\s*$',
      description: 'The task (workstream) this update is about: a short fixed id, 2 to 32 characters of a-z, 0-9 and "-". An id that is not open opens a task; an open id switches to it.',
    },
    repo: {
      type: 'string',
      minLength: 1,
      maxLength: REPO_MAX_CHARS,
      description: 'The absolute path of the repository or folder the task works in (default: this session\'s).',
    },
    close: {
      type: 'boolean',
      enum: [true],
      description: 'true closes the active task.',
    },
    phase: {
      type: 'string',
      enum: [...PHASES],
      description: 'The current phase.',
    },
    wave: {
      type: 'integer',
      minimum: 1,
      description: 'The wave of workers now running or about to start.',
    },
    units: {
      type: 'array',
      description: 'The full list of work units; replaces the previous list.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'wave'],
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            description: 'Unique id; the Agent call that carries out this unit uses it as its `name` (or, with no name, the unit\'s label as its description).',
          },
          label: {
            type: 'string',
            pattern: '^\\s*\\S+(\\s+\\S+){0,3}\\s*$',
            description: 'Short label, 1 to 4 words.',
          },
          wave: { type: 'integer', minimum: 1, description: 'The wave this unit runs in.' },
          dependsOn: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
            description: 'Ids of units in this list that must finish first; not the unit itself, no cycles. Default [].',
          },
          declared: {
            type: ['string', 'null'],
            enum: ['pending', 'done', 'failed', null],
            description: 'Optional state for a unit no worker carries out.',
          },
          tier: {
            type: ['string', 'null'],
            enum: [...TIERS, null],
            description: 'The tier the Model Routing Policy\'s §1 selected, for a unit a worker carries out; left out for a unit you carry out yourself.',
          },
          kind: {
            type: ['string', 'null'],
            enum: [...ALL_KINDS, null],
            description: 'With a tier, required: the task type, one the unit\'s tier takes.',
          },
          audit: {
            type: ['string', 'null'],
            maxLength: AUDIT_MAX_CHARS,
            description: 'With a tier, required: the policy §9 line "<task> | <tier> | <§1 step and conditions that selected it> | <what catches an error>".',
          },
          verdict: {
            type: ['string', 'null'],
            enum: [...VERDICTS, null],
            description: 'With a tier: set once you have checked the worker\'s output (policy §7); a rejection is a failure (policy §8).',
          },
          spec: {
            type: ['string', 'null'],
            minLength: 1,
            maxLength: SPEC_MAX_CHARS,
            description: 'With a tier: the path of the approved spec the unit builds from; its worker is refused while the file does not exist.',
          },
          context: {
            type: 'array',
            maxItems: CONTEXT_MAX_ITEMS,
            items: { type: 'string', minLength: 1, maxLength: CONTEXT_ITEM_MAX_CHARS },
            description: 'With a tier: up to 8 things the worker is given, each an absolute path (optionally with "#heading") or "<task-id>:<unit-id>" for that unit\'s newest journal entry; their text is placed in the worker\'s brief.',
          },
        },
      },
    },
  },
}

/**
 * Registers the `AgentBoard` tool. Call it from the mod's one `session.start`
 * hook (`$.tool.register` rejects until the session binds there, and a module
 * may hook `session.start` only once without a matcher, so this file adds no
 * `session.start` hook of its own). Never throws.
 */
export async function registerBoardTool($: EngineInterface): Promise<void> {
  try {
    await $.tool.register({
      name: BOARD_TOOL,
      description: BOARD_TOOL_DESCRIPTION,
      inputSchema: BOARD_TOOL_SCHEMA,
      isDeferred: false,
    })
  } catch (error) {
    $.ui.log(`flowestra: AgentBoard tool not registered: ${String(error)}`)
  }
}

/**
 * Answers one `AgentBoard` call, pure: `input` is the `tool.call` hook's `e`
 * (its reserved keys are taken off here) or the bare arguments. `{ deny }`
 * carries the reason for an invalid input (the board must not change);
 * otherwise `update` is to be applied and `line` returned as the result.
 */
export function answerBoardCall(input: unknown): { deny: string } | { update: BoardUpdate; line: string } {
  const args = isPlainObject(input) ? toolArguments(input) : input
  const parsed = parseBoardUpdate(args)
  if (!parsed.ok) return { deny: parsed.reason }
  return { update: parsed.update, line: summarizeUpdate(parsed.update) }
}

// ---------------------------------------------------------------------------
// The system-prompt section
// ---------------------------------------------------------------------------

export const BOARD_PROMPT_SECTION_TEXT = [
  'Agent Board: a live pane shows you and your workers.',
  `Keep it current with the ${BOARD_TOOL} tool (${BOARD_TOOL_FULL_NAME}), but never call it in a response of its own: send it with your next action (a spawn, a check, a read), only what changed (the units list always whole).`,
  `Phases, in order: ${PHASES.join(', ')}.`,
  'Give every Agent call a description of 2 to 4 words starting with a verb (for example "Write state reducers") and a name equal to the id of the work unit it carries out; where the Agent tool takes no name, make the description equal to that unit\'s label.',
  'Never put token counts in the board: they are measured.',
  'Work is kept as tasks: name a taskId to open a task or switch to it, one task per piece of work across any repositories, and close it with close when it is done.',
].join(' ')

export const BOARD_PROMPT_SECTION: PromptComposeSection = {
  id: PROMPT_SECTION_ID,
  text: BOARD_PROMPT_SECTION_TEXT,
  scope: 'session',
}

/**
 * The sections with the mod's sections added after them, in this order: the
 * orchestrator workflow's (none for mode `off`), the board's, the Model
 * Routing Policy's. Each is added only if no section with its id is there
 * already (a present one is never replaced); the same list (unchanged) when
 * nothing is added. The input is not mutated. Pure.
 */
export function withFlowestraSections(
  sections: readonly PromptComposeSection[],
  mode: WorkflowMode,
  note = '',
): readonly PromptComposeSection[] {
  const added: PromptComposeSection[] = []
  const wanted = [workflowSection(mode), BOARD_PROMPT_SECTION, routingPolicySection(note)]
  for (const section of wanted) {
    if (section !== null && !sections.some(existing => existing.id === section.id)) added.push(section)
  }
  return added.length === 0 ? sections : [...sections, ...added]
}

/**
 * The sections with the board's section and the Model Routing Policy's
 * section added after them, each exactly once, the board's before the
 * policy's: the same list (unchanged) only when both are already there.
 * `withFlowestraSections` with the workflow off. Pure.
 */
export function withBoardSection(
  sections: readonly PromptComposeSection[],
): readonly PromptComposeSection[] {
  return withFlowestraSections(sections, 'off')
}

/**
 * Whether a `prompt.compose` render should carry the section. The event has
 * no `agentId`; the one render it marks as not the main loop's is an
 * in-process teammate's (`teammate` trait).
 */
export function wantsBoardSection(traits: readonly string[]): boolean {
  return !traits.includes('teammate')
}

// ---------------------------------------------------------------------------
// The /board command
// ---------------------------------------------------------------------------

export const BOARD_COMMAND_TEXT: Record<BoardToggleResult, string> = {
  opened: 'Agent Board opened.',
  closed: 'Agent Board closed.',
  waiting:
    'Agent Board will appear once the terminal is wide enough; meanwhile the one-line row above the prompt shows the board.',
}

/** `/board`'s registered description and argument hint. */
export const BOARD_COMMAND_DESCRIPTION = 'Open or close the Agent Board; /board tokens opens it on the Tokens tab'
export const BOARD_COMMAND_HINT = '[tokens]'

/** What `/board tokens` answers once the pane is open on the Tokens tab. */
export const TOKENS_SHOWN_TEXT = 'Agent Board: Tokens tab shown.'
/** What `/board tokens` answers when the pane cannot be placed yet. */
export const TOKENS_WAITING_TEXT = 'Agent Board: the Tokens tab will show once the terminal is wide enough.'
/** What `/board tokens` answers when the tab could not be shown. */
export const TOKENS_FAILED_TEXT = 'Agent Board: the Tokens tab could not be shown.'
/** What `/board` answers to an argument it does not know; the pane is not toggled. */
export const BOARD_USAGE_TEXT = '/board opens or closes the pane; /board tokens opens it on the Tokens tab.'

/**
 * Registers `/board`. Call it from the mod's one `session.start` hook, as
 * `registerBoardTool`. Never throws.
 */
export async function registerBoardCommand($: EngineInterface): Promise<void> {
  try {
    await $.command.register({ name: BOARD_COMMAND, description: BOARD_COMMAND_DESCRIPTION, argumentHint: BOARD_COMMAND_HINT })
  } catch (error) {
    $.ui.log(`flowestra: /board not registered: ${String(error)}`)
  }
}

/** The one line `/board` answers with, for what the toggle did. Pure. */
export function boardCommandText(outcome: BoardToggleResult): string {
  return BOARD_COMMAND_TEXT[outcome]
}
