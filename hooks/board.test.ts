import { describe, expect, test } from 'claude-code/testing'

import {
  BOARD_COMMAND_DESCRIPTION,
  BOARD_COMMAND_HINT,
  BOARD_PROMPT_SECTION,
  BOARD_PROMPT_SECTION_TEXT,
  BOARD_TOOL,
  BOARD_TOOL_DESCRIPTION,
  BOARD_TOOL_FULL_NAME,
  BOARD_TOOL_SCHEMA,
  BOARD_USAGE_TEXT,
  TOKENS_FAILED_TEXT,
  TOKENS_SHOWN_TEXT,
  TOKENS_WAITING_TEXT,
  PHASES,
  POLICY_SECTION_ID,
  ROUTING_POLICY_SECTION,
  answerBoardCall,
  boardCommandText,
  parseBoardUpdate,
  summarizeUpdate,
  wantsBoardSection,
  withBoardSection,
  withFlowestraSections,
} from './board'
import type { BoardUpdate } from './board'
import type { Unit } from '../types'
import { WORKFLOW_SECTION_ID, workflowText } from './workflow'
import type { WorkflowMode } from './workflow'

// The 0.5 vocabulary, spelled apart so that a grep of the mod for it finds nothing.
const OLD_WORD = 'sco' + 'ut'
const OLD_POLICY = 'Haiku ' + 'Delegation'

function accepted(input: unknown): BoardUpdate {
  const parsed = parseBoardUpdate(input)
  if (!parsed.ok) throw new Error(`expected accept, got: ${parsed.reason}`)
  return parsed.update
}

function refused(input: unknown): string {
  const parsed = parseBoardUpdate(input)
  if (parsed.ok) throw new Error(`expected refusal, got: ${JSON.stringify(parsed.update)}`)
  return parsed.reason
}

// A unit the orchestrator carries out itself: no tier, `declared` given.
const unit = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: `Build ${id}`, wave: 1, declared: 'pending', ...extra })
const auditFor = (tier: string) => `find call sites of foo | ${tier} | step 2, every gate condition holds | I read each cited line`
const AUDIT = auditFor('haiku')
const tiered = (id: string, extra: Record<string, unknown> = {}) =>
  unit(id, { declared: undefined, tier: 'haiku', kind: 'locate', audit: AUDIT, ...extra })
const parsedUnit = (id: string, extra: Partial<Unit> = {}): Unit => ({
  id, label: 'x', wave: 1, dependsOn: [], declared: 'pending', tier: null, kind: null, audit: null, verdict: null, spec: null, context: [], ...extra,
})
const SELF = { declared: 'pending', tier: null, kind: null, audit: null, verdict: null, spec: null, context: [] }

describe('parseBoardUpdate: the update as a whole', () => {
  test('refuses an empty update', () => {
    expect(refused({})).toMatch(/^empty update: give at least one of task, taskId, repo, close, phase, wave, units$/)
  })
  test('refuses an update whose fields are all undefined', () => {
    expect(refused({ task: undefined })).toMatch(/^empty update/)
  })
  test('refuses a non-object', () => {
    expect(refused(null)).toMatch(/must be an object.*got null/)
    expect(refused([])).toMatch(/must be an object.*got an array/)
    expect(refused('task')).toMatch(/must be an object/)
  })
  test('refuses an unknown extra field, naming it', () => {
    expect(refused({ phase: 'design', colour: 'red' })).toBe(
      'unknown field "colour"; allowed fields are task, taskId, repo, close, phase, wave, units',
    )
  })
  test('refuses token counts, saying they are measured', () => {
    expect(refused({ phase: 'design', tokens: 1200 })).toMatch(/unknown field "tokens" \(token counts are measured/)
  })
  test('accepts each field alone', () => {
    expect(accepted({ task: 'Ship it' })).toEqual({ task: 'Ship it' })
    expect(accepted({ phase: 'review' })).toEqual({ phase: 'review' })
    expect(accepted({ wave: 3 })).toEqual({ wave: 3 })
    expect(accepted({ units: [] })).toEqual({ units: [] })
  })
  test('accepts all fields together', () => {
    expect(accepted({ task: 'T', phase: 'executing', wave: 2, units: [unit('a')] })).toEqual({
      task: 'T',
      phase: 'executing',
      wave: 2,
      units: [{ id: 'a', label: 'Build a', wave: 1, dependsOn: [], ...SELF }],
    })
  })
})

describe('parseBoardUpdate: task', () => {
  test('trims the task', () => {
    expect(accepted({ task: '   Build the board  ' }).task).toBe('Build the board')
  })
  test('accepts exactly 120 characters after trimming, with padding around', () => {
    const task = 'x'.repeat(120)
    expect(accepted({ task: `  ${task}  ` }).task).toBe(task)
  })
  test('refuses 121 characters', () => {
    expect(refused({ task: 'x'.repeat(121) })).toBe(
      'field "task" is 121 characters after trimming; at most 120 are allowed',
    )
  })
  test('refuses an empty or blank task', () => {
    expect(refused({ task: '' })).toMatch(/^field "task" is empty/)
    expect(refused({ task: '   ' })).toMatch(/^field "task" is empty/)
  })
  test('refuses a non-string task', () => {
    expect(refused({ task: 5 })).toBe('field "task" must be a string, got 5')
  })
})

describe('parseBoardUpdate: phase', () => {
  test('accepts each of the seven phases', () => {
    expect(PHASES.length).toBe(7)
    for (const phase of ['analysis', 'design', 'approval', 'executing', 'testing', 'review', 'done']) {
      expect(accepted({ phase }).phase).toBe(phase)
    }
  })
  test('refuses another phase, listing the allowed ones', () => {
    expect(refused({ phase: 'shipping' })).toBe(
      'field "phase" must be one of analysis, design, approval, executing, testing, review, done, got "shipping"',
    )
    expect(refused({ phase: 'Design' })).toMatch(/^field "phase" must be one of/)
    expect(refused({ phase: null })).toMatch(/^field "phase" must be one of .* got null$/)
  })
})

describe('parseBoardUpdate: wave', () => {
  test('accepts integers from 1', () => {
    expect(accepted({ wave: 1 }).wave).toBe(1)
    expect(accepted({ wave: 12 }).wave).toBe(12)
  })
  test('refuses 0, negatives, fractions and strings', () => {
    expect(refused({ wave: 0 })).toBe('field "wave" must be an integer of at least 1, got 0')
    expect(refused({ wave: -2 })).toMatch(/^field "wave" must be an integer of at least 1/)
    expect(refused({ wave: 1.5 })).toMatch(/got 1\.5$/)
    expect(refused({ wave: '2' })).toMatch(/got "2"$/)
  })
})

describe('parseBoardUpdate: units', () => {
  test('refuses units that is not an array', () => {
    expect(refused({ units: {} })).toMatch(/^field "units" must be an array/)
  })
  test('refuses a unit that is not an object', () => {
    expect(refused({ units: [unit('a'), 'b'] })).toBe('units[1]: must be an object, got "b"')
  })
  test('fills defaults: dependsOn [], nulls for the routing fields', () => {
    expect(accepted({ units: [unit('a')] }).units).toEqual([
      { id: 'a', label: 'Build a', wave: 1, dependsOn: [], ...SELF },
    ])
  })
  test('refuses a missing or empty id', () => {
    expect(refused({ units: [{ label: 'x', wave: 1 }] })).toBe(
      'units[0]: field "id" must be a non-empty string, got undefined',
    )
    expect(refused({ units: [unit('a'), unit('  ')] })).toMatch(/^units\[1\]: field "id" must be a non-empty string/)
  })
  test('refuses a repeated id, naming both positions', () => {
    expect(refused({ units: [unit('a'), unit('b'), unit('a')] })).toBe(
      'unit "a" (units[2]): field "id" repeats units[0]; every unit id must be unique',
    )
  })
  test('refuses an unknown field on a unit, naming unit and field', () => {
    expect(refused({ units: [unit('a', { owner: 'me' })] })).toBe(
      'unit "a" (units[0]): unknown field "owner"; allowed fields are id, label, wave, dependsOn, declared, tier, kind, audit, verdict, spec, context',
    )
  })
  test('refuses token counts on a unit', () => {
    expect(refused({ units: [unit('a', { outputTokens: 5 })] })).toMatch(
      /^unit "a" \(units\[0\]\): unknown field "outputTokens" \(token counts are measured/,
    )
  })

  test('accepts labels of 1 to 4 words, trimmed and with spaces collapsed', () => {
    expect(accepted({ units: [unit('a', { label: 'Probe' })] }).units?.[0]?.label).toBe('Probe')
    expect(accepted({ units: [unit('a', { label: '  Write   state  reducers now ' })] }).units?.[0]?.label).toBe(
      'Write state reducers now',
    )
  })
  test('refuses a 5-word label, saying how many words and the limit', () => {
    expect(refused({ units: [unit('a'), unit('b', { label: 'Write the state reducer tests' })] })).toBe(
      'unit "b" (units[1]): field "label" has 5 words ("Write the state reducer tests"); at most 4 are allowed',
    )
  })
  test('refuses an empty or missing label', () => {
    expect(refused({ units: [unit('a', { label: ' ' })] })).toMatch(/^unit "a" \(units\[0\]\): field "label" must be a non-empty string/)
    expect(refused({ units: [{ id: 'a', wave: 1 }] })).toMatch(/^unit "a" \(units\[0\]\): field "label"/)
  })

  test('refuses a bad unit wave, naming unit and field', () => {
    expect(refused({ units: [unit('a', { wave: 0 })] })).toBe(
      'unit "a" (units[0]): field "wave" must be an integer of at least 1, got 0',
    )
    expect(refused({ units: [unit('a', { wave: 2.5 })] })).toMatch(/field "wave" .* got 2\.5$/)
    expect(refused({ units: [{ id: 'a', label: 'x' }] })).toMatch(/^unit "a" \(units\[0\]\): field "wave"/)
  })

  test('accepts dependencies on units in the same list, in any order', () => {
    const units = accepted({ units: [unit('c', { dependsOn: ['a', 'b'] }), unit('a'), unit('b', { dependsOn: ['a'] })] }).units
    expect(units?.map(u => u.dependsOn)).toEqual([['a', 'b'], [], ['a']])
  })
  test('refuses dependsOn that is not an array of ids', () => {
    expect(refused({ units: [unit('a', { dependsOn: 'b' })] })).toBe(
      'unit "a" (units[0]): field "dependsOn" must be an array of unit ids, got "b"',
    )
    expect(refused({ units: [unit('a', { dependsOn: [3] })] })).toBe(
      'unit "a" (units[0]): field "dependsOn"[0] must be a non-empty unit id, got 3',
    )
  })
  test('refuses an unknown dependency, naming it', () => {
    expect(refused({ units: [unit('a'), unit('b', { dependsOn: ['a', 'z'] })] })).toBe(
      'unit "b" (units[1]): field "dependsOn" names "z", which is not a unit id in this list',
    )
  })
  test('refuses a self-dependency', () => {
    expect(refused({ units: [unit('a', { dependsOn: ['a'] })] })).toBe(
      'unit "a" (units[0]): field "dependsOn" names the unit itself; a unit cannot depend on itself',
    )
  })
  test('refuses a two-unit cycle', () => {
    expect(refused({ units: [unit('a', { dependsOn: ['b'] }), unit('b', { dependsOn: ['a'] })] })).toBe(
      'field "units": dependency cycle "a" -> "b" -> "a"; dependencies must not loop',
    )
  })
  test('refuses a longer cycle behind an acyclic head', () => {
    const reason = refused({
      units: [
        unit('root'),
        unit('x', { dependsOn: ['root', 'y'] }),
        unit('y', { dependsOn: ['z'] }),
        unit('z', { dependsOn: ['x'] }),
      ],
    })
    expect(reason).toBe('field "units": dependency cycle "x" -> "y" -> "z" -> "x"; dependencies must not loop')
  })
  test('accepts a diamond (shared dependency, no cycle)', () => {
    expect(
      accepted({
        units: [unit('a'), unit('b', { dependsOn: ['a'] }), unit('c', { dependsOn: ['a'] }), unit('d', { dependsOn: ['b', 'c'] })],
      }).units?.length,
    ).toBe(4)
  })

  test('accepts declared pending, done and failed', () => {
    for (const declared of ['pending', 'done', 'failed']) {
      expect(accepted({ units: [unit('a', { declared })] }).units?.[0]?.declared).toBe(declared)
    }
  })
  test('refuses another declared value', () => {
    expect(refused({ units: [unit('a', { declared: 'running' })] })).toBe(
      'unit "a" (units[0]): field "declared" must be one of pending, done, failed, got "running"',
    )
  })
  test('reports the first problem in list order', () => {
    expect(refused({ units: [unit('a', { wave: 0 }), unit('b', { label: 'one two three four five' })] })).toMatch(
      /^unit "a" \(units\[0\]\): field "wave"/,
    )
  })
})

describe('parseBoardUpdate: a unit with no tier', () => {
  const at = 'unit "s" (units[0]): '
  const needs = `${at}a unit a worker carries out needs "tier", "kind" and "audit" (policy §9); a unit you carry out yourself needs "declared"`

  test('with declared it is accepted, routing fields null', () => {
    for (const declared of ['pending', 'done', 'failed']) {
      expect(accepted({ units: [unit('s', { declared })] }).units?.[0]).toEqual({
        id: 's', label: 'Build s', wave: 1, dependsOn: [], ...SELF, declared,
      })
    }
  })
  test('tier undefined or null both mean no tier', () => {
    expect(accepted({ units: [unit('s', { tier: null })] }).units?.[0]?.tier).toBe(null)
    expect(accepted({ units: [unit('s', { tier: undefined })] }).units?.[0]?.tier).toBe(null)
  })
  test('without declared it is refused', () => {
    expect(refused({ units: [unit('s', { declared: undefined })] })).toBe(needs)
    expect(refused({ units: [unit('s', { declared: null })] })).toBe(needs)
    expect(refused({ units: [{ id: 's', label: 'x', wave: 1, tier: null }] })).toBe(needs)
  })
  test('refuses kind, audit, verdict or spec without a tier', () => {
    expect(refused({ units: [unit('s', { kind: 'locate' })] })).toBe(`${at}field "kind" is only for a unit with a tier`)
    expect(refused({ units: [unit('s', { tier: null, audit: AUDIT })] })).toBe(`${at}field "audit" is only for a unit with a tier`)
    expect(refused({ units: [unit('s', { verdict: 'accepted' })] })).toBe(`${at}field "verdict" is only for a unit with a tier`)
    expect(refused({ units: [unit('s', { spec: 'spec.md' })] })).toBe(`${at}field "spec" is only for a unit with a tier`)
    expect(refused({ units: [unit('s', { declared: undefined, kind: 'locate' })] })).toBe(`${at}field "kind" is only for a unit with a tier`)
  })
  test('accepts null kind, audit, verdict and spec, stored as null', () => {
    expect(accepted({ units: [unit('s', { kind: null, audit: null, verdict: null, spec: null })] }).units?.[0]).toEqual(
      { id: 's', label: 'Build s', wave: 1, dependsOn: [], ...SELF },
    )
  })
})

describe('parseBoardUpdate: a unit with a tier', () => {
  const at = 'unit "s" (units[0]): '

  test('a full valid unit of each tier round-trips', () => {
    expect(accepted({ units: [tiered('s', { dependsOn: [] })] }).units).toEqual([
      { id: 's', label: 'Build s', wave: 1, dependsOn: [], declared: null, tier: 'haiku', kind: 'locate', audit: AUDIT, verdict: null, spec: null, context: [] },
    ])
    const units = accepted({
      units: [
        tiered('h', { kind: 'extract', verdict: 'accepted' }),
        tiered('s', { tier: 'sonnet', kind: 'implement', audit: auditFor('sonnet'), dependsOn: ['h'], spec: 'docs/spec.md' }),
        tiered('o', { tier: 'opus', kind: 'design', audit: auditFor('opus'), verdict: 'rejected', spec: '/abs/design.md', declared: 'pending' }),
      ],
    }).units
    expect(units).toEqual([
      { id: 'h', label: 'Build h', wave: 1, dependsOn: [], declared: null, tier: 'haiku', kind: 'extract', audit: auditFor('haiku'), verdict: 'accepted', spec: null, context: [] },
      { id: 's', label: 'Build s', wave: 1, dependsOn: ['h'], declared: null, tier: 'sonnet', kind: 'implement', audit: auditFor('sonnet'), verdict: null, spec: 'docs/spec.md', context: [] },
      { id: 'o', label: 'Build o', wave: 1, dependsOn: [], declared: 'pending', tier: 'opus', kind: 'design', audit: auditFor('opus'), verdict: 'rejected', spec: '/abs/design.md', context: [] },
    ])
  })
  test('refuses a bad tier', () => {
    expect(refused({ units: [tiered('s', { tier: 'worker' })] })).toBe(`${at}field "tier" must be one of opus, sonnet, haiku, got "worker"`)
    expect(refused({ units: [tiered('s', { tier: OLD_WORD })] })).toBe(`${at}field "tier" must be one of opus, sonnet, haiku, got "${OLD_WORD}"`)
    expect(refused({ units: [tiered('s', { tier: 'Haiku' })] })).toBe(`${at}field "tier" must be one of opus, sonnet, haiku, got "Haiku"`)
    expect(refused({ units: [tiered('s', { tier: 3 })] })).toBe(`${at}field "tier" must be one of opus, sonnet, haiku, got 3`)
  })

  test('haiku takes its three kinds', () => {
    for (const kind of ['locate', 'extract', 'inventory']) {
      expect(accepted({ units: [tiered('s', { kind })] }).units?.[0]?.kind).toBe(kind)
    }
  })
  test('refuses a haiku unit of kind execute or edit that has no verdict', () => {
    for (const kind of ['execute', 'edit']) {
      expect(refused({ units: [tiered('s', { kind })] })).toBe(
        `${at}kind "${kind}" is not a haiku task type (haiku takes locate, extract, inventory); route the unit to a higher tier`,
      )
    }
  })
  test('accepts a haiku unit of kind execute or edit that carries a verdict', () => {
    for (const kind of ['execute', 'edit']) {
      for (const verdict of ['accepted', 'rejected']) {
        expect(accepted({ units: [tiered('s', { kind, verdict })] }).units?.[0]?.kind).toBe(kind)
      }
    }
  })
  test('accepts a sonnet unit of kind execute', () => {
    expect(accepted({ units: [tiered('s', { tier: 'sonnet', kind: 'execute', audit: auditFor('sonnet') })] }).units?.[0]?.kind).toBe('execute')
  })
  test('sonnet takes the haiku kinds and its seven', () => {
    for (const kind of ['locate', 'extract', 'execute', 'inventory', 'edit', 'implement', 'tests', 'fix', 'explore', 'summarize', 'review', 'docs']) {
      expect(accepted({ units: [tiered('s', { tier: 'sonnet', kind, audit: auditFor('sonnet') })] }).units?.[0]?.kind).toBe(kind)
    }
  })
  test('opus takes all fourteen', () => {
    for (const kind of ['locate', 'extract', 'execute', 'inventory', 'edit', 'implement', 'tests', 'fix', 'explore', 'summarize', 'review', 'docs', 'design', 'debug']) {
      expect(accepted({ units: [tiered('s', { tier: 'opus', kind, audit: auditFor('opus') })] }).units?.[0]?.kind).toBe(kind)
    }
  })
  test('refuses a unit with a tier and no kind, listing that tier\'s kinds', () => {
    const haiku = `${at}a haiku unit needs field "kind", one of locate, extract, inventory`
    expect(refused({ units: [tiered('s', { kind: undefined })] })).toBe(haiku)
    expect(refused({ units: [tiered('s', { kind: null })] })).toBe(haiku)
    expect(refused({ units: [tiered('s', { tier: 'sonnet', kind: null, audit: auditFor('sonnet') })] })).toBe(
      `${at}a sonnet unit needs field "kind", one of locate, extract, execute, inventory, edit, implement, tests, fix, explore, summarize, review, docs`,
    )
    expect(refused({ units: [tiered('s', { tier: 'opus', kind: undefined, audit: auditFor('opus') })] })).toBe(
      `${at}a opus unit needs field "kind", one of locate, extract, execute, inventory, edit, implement, tests, fix, explore, summarize, review, docs, design, debug`,
    )
  })
  test('refuses a kind of a higher tier, saying to route upward', () => {
    expect(refused({ units: [tiered('s', { kind: 'summarize' })] })).toBe(
      `${at}kind "summarize" is not a haiku task type (haiku takes locate, extract, inventory); route the unit to a higher tier`,
    )
    expect(refused({ units: [tiered('s', { kind: 'design' })] })).toBe(
      `${at}kind "design" is not a haiku task type (haiku takes locate, extract, inventory); route the unit to a higher tier`,
    )
    expect(refused({ units: [tiered('s', { tier: 'sonnet', kind: 'debug', audit: auditFor('sonnet') })] })).toBe(
      `${at}kind "debug" is not a sonnet task type (sonnet takes locate, extract, execute, inventory, edit, implement, tests, fix, explore, summarize, review, docs); route the unit to a higher tier`,
    )
  })
  test('refuses something that is no kind at all', () => {
    expect(refused({ units: [tiered('s', { kind: 'refactor' })] })).toBe(
      `${at}field "kind" must be one of locate, extract, inventory, got "refactor"`,
    )
    expect(refused({ units: [tiered('s', { tier: 'opus', kind: 3, audit: auditFor('opus') })] })).toBe(
      `${at}field "kind" must be one of locate, extract, execute, inventory, edit, implement, tests, fix, explore, summarize, review, docs, design, debug, got 3`,
    )
    expect(refused({ units: [tiered('s', { kind: 'Locate' })] })).toMatch(/field "kind" must be one of .* got "Locate"$/)
  })

  test('refuses a missing, non-string or blank audit', () => {
    const reason = (tier: string) =>
      `${at}a ${tier} unit needs field "audit", the policy §9 line "<task> | <tier> | <§1 step and conditions that selected it> | <what catches an error>"; if any field can't be filled in, route to Opus`
    expect(refused({ units: [tiered('s', { audit: undefined })] })).toBe(reason('haiku'))
    expect(refused({ units: [tiered('s', { audit: null })] })).toBe(reason('haiku'))
    expect(refused({ units: [tiered('s', { audit: 42 })] })).toBe(reason('haiku'))
    expect(refused({ units: [tiered('s', { audit: '   ' })] })).toBe(reason('haiku'))
    expect(refused({ units: [tiered('s', { tier: 'sonnet', kind: 'tests', audit: undefined })] })).toBe(reason('sonnet'))
  })
  test('refuses an audit without four non-empty parts', () => {
    const reason = `${at}field "audit" must have exactly four non-empty parts separated by "|": <task> | <tier> | <§1 step and conditions that selected it> | <what catches an error>; if any field can't be filled in, route to Opus`
    expect(refused({ units: [tiered('s', { audit: 'find foo | haiku | step 2' })] })).toBe(reason)
    expect(refused({ units: [tiered('s', { audit: 'find foo | haiku |  | I check' })] })).toBe(reason)
    expect(refused({ units: [tiered('s', { audit: 'a | haiku | c | d | e' })] })).toBe(reason)
  })
  test('refuses an audit whose tier part is not the unit\'s tier', () => {
    expect(refused({ units: [tiered('s', { audit: auditFor('sonnet') })] })).toBe(
      `${at}field "audit" names tier "sonnet" but the unit's tier is "haiku"`,
    )
    expect(refused({ units: [tiered('s', { tier: 'opus', kind: 'design', audit: 't | Haiku | r | c' })] })).toBe(
      `${at}field "audit" names tier "Haiku" but the unit's tier is "opus"`,
    )
    expect(refused({ units: [tiered('s', { audit: 't | cheap | r | c' })] })).toBe(
      `${at}field "audit" names tier "cheap" but the unit's tier is "haiku"`,
    )
  })
  test('refuses an audit over 400 characters after trimming, accepts exactly 400', () => {
    const long = `${'x'.repeat(391)}|haiku|y|z`
    expect(long.length).toBe(401)
    expect(refused({ units: [tiered('s', { audit: `  ${long}  ` })] })).toBe(
      `${at}field "audit" is 401 characters after trimming; at most 400 are allowed`,
    )
    const exact = `${'x'.repeat(390)}|haiku|y|z`
    expect(accepted({ units: [tiered('s', { audit: `  ${exact} ` })] }).units?.[0]?.audit).toBe(`${'x'.repeat(390)} | haiku | y | z`)
  })
  test('normalises the audit: four trimmed parts joined with " | ", the tier part lower-cased', () => {
    expect(accepted({ units: [tiered('s', { audit: '  find foo|HaiKu   |  step 2 |I read each line ' })] }).units?.[0]?.audit).toBe(
      'find foo | haiku | step 2 | I read each line',
    )
    expect(accepted({ units: [tiered('s', { tier: 'sonnet', kind: 'fix', audit: 'fix it |SONNET| step 3 | tests' })] }).units?.[0]?.audit).toBe(
      'fix it | sonnet | step 3 | tests',
    )
  })

  test('verdict: accepted, rejected, null; a bad one is refused', () => {
    expect(accepted({ units: [tiered('s', { verdict: 'accepted' })] }).units?.[0]?.verdict).toBe('accepted')
    expect(accepted({ units: [tiered('s', { verdict: 'rejected' })] }).units?.[0]?.verdict).toBe('rejected')
    expect(accepted({ units: [tiered('s', { verdict: null })] }).units?.[0]?.verdict).toBe(null)
    expect(refused({ units: [tiered('s', { verdict: 'ok' })] })).toBe(`${at}field "verdict" must be one of accepted, rejected, got "ok"`)
  })
  test('spec: trimmed, null when not given; empty, blank, non-string or too long refused', () => {
    expect(accepted({ units: [tiered('s', { spec: '  docs/spec.md ' })] }).units?.[0]?.spec).toBe('docs/spec.md')
    expect(accepted({ units: [tiered('s', { spec: null })] }).units?.[0]?.spec).toBe(null)
    expect(accepted({ units: [tiered('s')] }).units?.[0]?.spec).toBe(null)
    expect(accepted({ units: [tiered('s', { spec: ` ${'p'.repeat(500)} ` })] }).units?.[0]?.spec).toBe('p'.repeat(500))
    const bad = (got: string) => `${at}field "spec" must be a non-empty path of at most 500 characters, got ${got}`
    expect(refused({ units: [tiered('s', { spec: '' })] })).toBe(bad('""'))
    expect(refused({ units: [tiered('s', { spec: '   ' })] })).toBe(bad('"   "'))
    expect(refused({ units: [tiered('s', { spec: 7 })] })).toBe(bad('7'))
    expect(refused({ units: [tiered('s', { spec: 'p'.repeat(501) })] })).toBe(bad(JSON.stringify('p'.repeat(501))))
  })
  test('a unit may depend on a unit with a tier', () => {
    const units = accepted({ units: [tiered('s'), unit('w', { dependsOn: ['s'] })] }).units
    expect(units?.map(u => u.tier)).toEqual(['haiku', null])
  })
})

describe('parseBoardUpdate: taskId, repo, close', () => {
  const badId = (got: string) => `field "taskId" must be 2 to 32 characters of a-z, 0-9 and "-", starting with a letter or digit, got ${got}`
  test('taskId is trimmed and accepted alone', () => {
    expect(accepted({ taskId: ' wb-ui ' })).toEqual({ taskId: 'wb-ui' })
    expect(accepted({ taskId: '1a' }).taskId).toBe('1a')
    expect(accepted({ taskId: 'a'.repeat(32) }).taskId).toBe('a'.repeat(32))
  })
  test('taskId refusals', () => {
    expect(refused({ taskId: 'a' })).toBe(badId('"a"'))
    expect(refused({ taskId: 'a'.repeat(33) })).toBe(badId(JSON.stringify('a'.repeat(33))))
    expect(refused({ taskId: '-ab' })).toBe(badId('"-ab"'))
    expect(refused({ taskId: 'Ab' })).toBe(badId('"Ab"'))
    expect(refused({ taskId: 'a b' })).toBe(badId('"a b"'))
    expect(refused({ taskId: '' })).toBe(badId('""'))
    expect(refused({ taskId: 5 })).toBe(badId('5'))
    expect(refused({ taskId: null })).toBe(badId('null'))
  })
  test('repo is trimmed; absolute paths only, at most 500 characters', () => {
    expect(accepted({ repo: ' /work/app ' })).toEqual({ repo: '/work/app' })
    expect(accepted({ repo: 'C:\\work' }).repo).toBe('C:\\work')
    expect(accepted({ repo: '/' + 'p'.repeat(499) }).repo?.length).toBe(500)
    const bad = (got: string) => `field "repo" must be an absolute path of at most 500 characters, got ${got}`
    expect(refused({ repo: 'work/app' })).toBe(bad('"work/app"'))
    expect(refused({ repo: '' })).toBe(bad('""'))
    expect(refused({ repo: 3 })).toBe(bad('3'))
    expect(refused({ repo: '/' + 'p'.repeat(500) })).toBe(bad(JSON.stringify('/' + 'p'.repeat(500))))
  })
  test('close is only true', () => {
    expect(accepted({ close: true })).toEqual({ close: true })
    const bad = (got: string) => `field "close" must be true when given, got ${got}`
    expect(refused({ close: false })).toBe(bad('false'))
    expect(refused({ close: 'true' })).toBe(bad('"true"'))
    expect(refused({ close: null })).toBe(bad('null'))
  })
  test('they combine with the other fields', () => {
    expect(accepted({ taskId: 'wb-ui', repo: '/r', task: 'T', phase: 'design' })).toEqual({ taskId: 'wb-ui', repo: '/r', task: 'T', phase: 'design' })
  })
})

describe('parseBoardUpdate: context and duplicate labels', () => {
  const at = 'unit "s" (units[0]): '
  test('every parsed unit carries context, [] when not given', () => {
    expect(accepted({ units: [unit('a'), tiered('b', { label: 'Other thing' }), tiered('c', { label: 'Third', context: null })] }).units?.map(u => u.context)).toEqual([[], [], []])
  })
  test('context is trimmed and kept in order', () => {
    expect(accepted({ units: [tiered('s', { context: [' /a/b.md#Intro ', 'wb-ui:u1'] })] }).units?.[0]?.context).toEqual(['/a/b.md#Intro', 'wb-ui:u1'])
    expect(accepted({ units: [tiered('s', { context: Array(8).fill('/x') })] }).units?.[0]?.context.length).toBe(8)
    expect(accepted({ units: [tiered('s', { context: ['/' + 'p'.repeat(499)] })] }).units?.[0]?.context[0]?.length).toBe(500)
  })
  test('context is only for a unit with a tier', () => {
    expect(refused({ units: [unit('s', { context: ['/x'] })] })).toBe(`${at}field "context" is only for a unit with a tier`)
    expect(accepted({ units: [unit('s', { context: null })] }).units?.[0]?.context).toEqual([])
  })
  test('context refusals', () => {
    expect(refused({ units: [tiered('s', { context: '/x' })] })).toBe(`${at}field "context" must be an array of at most 8 paths or task:unit references, got "/x"`)
    expect(refused({ units: [tiered('s', { context: Array(9).fill('/x') })] })).toBe(`${at}field "context" has 9 items; at most 8 are allowed`)
    const bad = (i: number, got: string) => `${at}field "context"[${i}] must be a non-empty string of at most 500 characters, got ${got}`
    expect(refused({ units: [tiered('s', { context: ['/x', '  '] })] })).toBe(bad(1, '"  "'))
    expect(refused({ units: [tiered('s', { context: [4] })] })).toBe(bad(0, '4'))
    expect(refused({ units: [tiered('s', { context: ['/' + 'p'.repeat(500)] })] })).toBe(bad(0, JSON.stringify('/' + 'p'.repeat(500))))
  })
  test('refuses two units whose labels have the same key', () => {
    expect(refused({ units: [unit('a', { label: 'Write state' }), unit('b', { label: 'Other' }), unit('c', { label: 'write  STATE' })] })).toBe(
      'unit "c" (units[2]): label "write STATE" repeats unit "a"\'s; labels must differ within a task',
    )
    expect(refused({ units: [unit('a', { label: 'one two three four' }), unit('b', { label: 'One Two Three Four' })] })).toMatch(/repeats unit "a"'s/)
  })
})

describe('answers', () => {
  test('summarizeUpdate counts the units of each tier, non-zero tiers only, opus first', () => {
    const t = (id: string, tier: 'opus' | 'sonnet' | 'haiku') => parsedUnit(id, { declared: null, tier, kind: 'locate', audit: `a | ${tier} | c | d` })
    expect(summarizeUpdate({ units: [t('a', 'haiku')] })).toBe('board updated: 1 unit (1 haiku)')
    const units = [t('a', 'haiku'), t('b', 'opus'), t('c', 'sonnet'), t('d', 'haiku'), t('e', 'opus')]
    expect(summarizeUpdate({ phase: 'executing', units })).toBe('board updated: phase executing, 5 units (2 opus, 1 sonnet, 2 haiku)')
    expect(summarizeUpdate({ units: [parsedUnit('x'), t('a', 'sonnet'), t('b', 'sonnet')] })).toBe('board updated: 3 units (2 sonnet)')
    expect(summarizeUpdate({ units: [parsedUnit('x'), t('a', 'haiku'), t('b', 'opus')] })).toBe('board updated: 3 units (1 opus, 1 haiku)')
  })
  test('a unit object missing the new fields counts as no tier', () => {
    const old = { id: 'a', label: 'x', wave: 1, dependsOn: [], declared: null } as unknown as Unit
    expect(summarizeUpdate({ units: [old] })).toBe('board updated: 1 unit')
  })
  test('the schema lists the six routing properties, keeping the unit item closed', () => {
    const units = (BOARD_TOOL_SCHEMA.properties as Record<string, Record<string, unknown>>).units
    const items = units?.items as { additionalProperties: unknown; required: unknown; properties: Record<string, Record<string, unknown>> }
    expect(items.additionalProperties).toBe(false)
    expect(items.required).toEqual(['id', 'label', 'wave'])
    expect(Object.keys(items.properties)).toEqual(['id', 'label', 'wave', 'dependsOn', 'declared', 'tier', 'kind', 'audit', 'verdict', 'spec', 'context'])
    expect(items.properties.tier?.enum).toEqual(['opus', 'sonnet', 'haiku', null])
    expect(items.properties.tier?.type).toEqual(['string', 'null'])
    expect(items.properties.kind?.enum).toEqual([
      'locate', 'extract', 'execute', 'inventory', 'edit',
      'implement', 'tests', 'fix', 'explore', 'summarize', 'review', 'docs',
      'design', 'debug', null,
    ])
    expect(items.properties.audit?.maxLength).toBe(400)
    expect(items.properties.audit?.type).toEqual(['string', 'null'])
    expect(items.properties.verdict?.enum).toEqual(['accepted', 'rejected', null])
    expect(items.properties.spec?.maxLength).toBe(500)
    expect(items.properties.spec?.type).toEqual(['string', 'null'])
  })
  test('the schema has taskId, repo, close and unit context', () => {
    const props = BOARD_TOOL_SCHEMA.properties as Record<string, Record<string, unknown>>
    expect(Object.keys(props)).toEqual(['task', 'taskId', 'repo', 'close', 'phase', 'wave', 'units'])
    expect(props.taskId?.type).toBe('string')
    expect(props.repo?.type).toBe('string')
    expect(props.close?.type).toBe('boolean')
    const items = props.units?.items as { properties: Record<string, Record<string, unknown>> }
    expect(items.properties.context?.type).toBe('array')
    expect(items.properties.context?.maxItems).toBe(8)
    expect(items.properties.context?.items).toMatchObject({ type: 'string' })
  })
  test('the description has the task lines and context', () => {
    expect(BOARD_TOOL_DESCRIPTION).toContain('- taskId: the task (workstream) this update is about: a short fixed id (2 to 32 characters, a-z, 0-9 and "-").')
    expect(BOARD_TOOL_DESCRIPTION).toContain('switch before you spawn for another one.')
    expect(BOARD_TOOL_DESCRIPTION).toContain('- repo: the absolute path of the repository or folder the task works in (default: this session\'s).')
    expect(BOARD_TOOL_DESCRIPTION).toContain('- close: true closes the active task.')
    expect(BOARD_TOOL_DESCRIPTION.indexOf('- taskId:')).toBeGreaterThan(BOARD_TOOL_DESCRIPTION.indexOf('- task:'))
    expect(BOARD_TOOL_DESCRIPTION).toContain('context (optional: up to 8 things the worker is given, each an absolute path, optionally with "#heading", or "<task-id>:<unit-id>" for that unit\'s newest journal entry; their text is placed in the worker\'s brief)')
  })
  test('summarizeUpdate names the task and the close', () => {
    const t = (id: string, tier: 'opus' | 'sonnet' | 'haiku') => parsedUnit(id, { declared: null, tier, kind: 'locate', audit: `a | ${tier} | c | d` })
    const units = [t('a', 'opus'), t('b', 'sonnet'), t('c', 'haiku'), t('d', 'opus'), t('e', 'haiku')]
    expect(summarizeUpdate({ taskId: 'wb-ui', phase: 'executing', units })).toBe('board updated: task wb-ui, phase executing, 5 units (2 opus, 1 sonnet, 2 haiku)')
    expect(summarizeUpdate({ close: true })).toBe('board updated: closed')
    expect(summarizeUpdate({ taskId: 'wb-ui', task: 'T' })).toBe('board updated: task wb-ui, task set')
  })
  test('the description names the routing fields and what is refused', () => {
    expect(BOARD_TOOL_DESCRIPTION).toContain('tier (opus, sonnet or haiku: what the Model Routing Policy\'s §1 selected)')
    expect(BOARD_TOOL_DESCRIPTION).toContain('"<task> | <tier> | <§1 step and conditions that selected it> | <what catches an error>"')
    expect(BOARD_TOOL_DESCRIPTION).toContain('spec (optional: the path of the approved spec the unit builds from)')
    expect(BOARD_TOOL_DESCRIPTION).toContain(
      'A unit a worker carries out with no tier, no kind or no complete audit line is refused; a unit you carry out yourself has no tier and takes declared instead.',
    )
  })
  test('no text of the tool carries the 0.5 vocabulary', () => {
    expect(BOARD_TOOL_DESCRIPTION.toLowerCase()).not.toContain(OLD_WORD)
    expect(JSON.stringify(BOARD_TOOL_SCHEMA).toLowerCase()).not.toContain(OLD_WORD)
    expect(JSON.stringify(BOARD_TOOL_SCHEMA)).not.toContain(OLD_POLICY)
  })
  test('summarizeUpdate is one short line', () => {
    expect(summarizeUpdate({ phase: 'executing', wave: 2, units: new Array(5).fill(null).map((_, i) => parsedUnit(`${i}`)) })).toBe(
      'board updated: phase executing, wave 2, 5 units',
    )
    expect(summarizeUpdate({ task: 'T' })).toBe('board updated: task set')
    expect(summarizeUpdate({ units: [parsedUnit('a')] })).toBe('board updated: 1 unit')
    expect(summarizeUpdate({ units: [] })).toBe('board updated: 0 units')
  })
  test('answerBoardCall takes the tool.call event, reserved keys and all', () => {
    expect(
      answerBoardCall({ tool: BOARD_TOOL_FULL_NAME, tool_use_id: 'tu1', agentId: undefined, phase: 'testing', wave: 1 }),
    ).toEqual({ update: { phase: 'testing', wave: 1 }, line: 'board updated: phase testing, wave 1' })
  })
  test('answerBoardCall denies with the reason, and gives no update', () => {
    const answer = answerBoardCall({ tool: BOARD_TOOL_FULL_NAME, tool_use_id: 'tu2', phase: 'later' })
    expect(answer).toEqual({ deny: refused({ phase: 'later' }) })
    expect('update' in answer).toBe(false)
  })
  test('answerBoardCall denies an empty call', () => {
    expect(answerBoardCall({ tool: BOARD_TOOL_FULL_NAME, tool_use_id: 'tu3' })).toEqual({
      deny: 'empty update: give at least one of task, taskId, repo, close, phase, wave, units',
    })
  })
  test('boardCommandText', () => {
    expect(boardCommandText('opened')).toBe('Agent Board opened.')
    expect(boardCommandText('closed')).toBe('Agent Board closed.')
    expect(boardCommandText('waiting')).toMatch(/once the terminal is wide enough.*row above the prompt/)
  })
})

describe('the prompt section', () => {
  test('is added last, once, as session, followed by the policy section', () => {
    const base = [
      { id: 'intro', text: 'a', scope: 'shared' as const },
      { id: 'memory', text: 'b', scope: 'session' as const },
    ]
    const once = withBoardSection(base)
    expect(once.map(s => s.id)).toEqual(['intro', 'memory', 'flowestra:orchestrator', 'flowestra:routing-policy'])
    expect(once[2]).toEqual(BOARD_PROMPT_SECTION)
    expect(once[3]).toEqual(ROUTING_POLICY_SECTION)
    expect(BOARD_PROMPT_SECTION.scope).toBe('session')
    expect(withBoardSection(once)).toBe(once)
  })
  test('adds only the policy section when the board section is already there', () => {
    const base = [{ id: 'intro', text: 'a', scope: 'shared' as const }, BOARD_PROMPT_SECTION]
    const out = withBoardSection(base)
    expect(out.map(s => s.id)).toEqual(['intro', 'flowestra:orchestrator', POLICY_SECTION_ID])
    expect(base.length).toBe(2)
  })
  test('adds only the board section when the policy section is already there', () => {
    const base = [ROUTING_POLICY_SECTION]
    expect(withBoardSection(base).map(s => s.id)).toEqual([POLICY_SECTION_ID, 'flowestra:orchestrator'])
  })
  test('returns the same list when both are there', () => {
    const both = [BOARD_PROMPT_SECTION, ROUTING_POLICY_SECTION]
    expect(withBoardSection(both)).toBe(both)
  })
  test('is about 120 words and says what the brief asks', () => {
    const words = BOARD_PROMPT_SECTION_TEXT.split(/\s+/).length
    expect(words >= 70 && words <= 150).toBe(true)
    for (const needle of [BOARD_TOOL, 'analysis, design, approval, executing, testing, review, done', 'before each wave', 'description of 2 to 4 words starting with a verb', 'name equal to the id of the work unit', 'where the Agent tool takes no name, make the description equal to that unit\'s label', 'Never put token counts']) {
      expect(BOARD_PROMPT_SECTION_TEXT).toContain(needle)
    }
  })
  test('is skipped for a teammate render only', () => {
    expect(wantsBoardSection([])).toBe(true)
    expect(wantsBoardSection(['skills', 'lean'])).toBe(true)
    expect(wantsBoardSection(['teammate'])).toBe(false)
  })
})

describe('withFlowestraSections', () => {
  const base = [
    { id: 'intro', text: 'a', scope: 'shared' as const },
    { id: 'memory', text: 'b', scope: 'session' as const },
  ]
  const modes: WorkflowMode[] = ['full', 'light', 'off']
  for (const mode of modes) {
    test(`appends the sections in order for ${mode}`, () => {
      const out = withFlowestraSections(base, mode)
      const expected = ['intro', 'memory', ...(mode === 'off' ? [] : [WORKFLOW_SECTION_ID]), 'flowestra:orchestrator', POLICY_SECTION_ID]
      expect(out.map(s => s.id)).toEqual(expected)
      if (mode !== 'off') {
        const workflow = out[2]
        expect(workflow?.text).toBe(workflowText(mode))
        expect(workflow?.scope).toBe('session')
      }
      expect(out[out.length - 2]).toEqual(BOARD_PROMPT_SECTION)
      expect(out[out.length - 1]).toEqual(ROUTING_POLICY_SECTION)
    })
    test(`is idempotent for ${mode}`, () => {
      const once = withFlowestraSections(base, mode)
      const twice = withFlowestraSections(once, mode)
      expect(twice).toBe(once)
      expect(twice).toEqual(once)
    })
  }
  test('returns the same list when all are there', () => {
    const all = [
      { id: WORKFLOW_SECTION_ID, text: 'mine', scope: 'session' as const },
      BOARD_PROMPT_SECTION,
      ROUTING_POLICY_SECTION,
    ]
    expect(withFlowestraSections(all, 'full')).toBe(all)
  })
  test('does not duplicate or replace a present workflow section, even for another mode', () => {
    const present = { id: WORKFLOW_SECTION_ID, text: 'mine', scope: 'session' as const }
    const out = withFlowestraSections([present], 'light')
    expect(out.filter(s => s.id === WORKFLOW_SECTION_ID).length).toBe(1)
    expect(out[0]).toBe(present)
    expect(out.map(s => s.id)).toEqual([WORKFLOW_SECTION_ID, 'flowestra:orchestrator', POLICY_SECTION_ID])
    const full = withFlowestraSections([present], 'full')
    expect(full[0]?.text).toBe('mine')
    expect(full.length).toBe(3)
  })
  test('does not mutate its input', () => {
    const input = [...base]
    withFlowestraSections(input, 'full')
    expect(input).toEqual(base)
    expect(input.length).toBe(2)
  })
})

// Not covered here: registerBoardTool, registerBoardCommand and the hooks that
// use these pieces. The test's own `$` has no `tool.register` or
// `command.register`, and an inline plugin is loaded as a separate module that
// cannot pass `$` to a helper from this mod, so they are exercised only once
// register.tsx (U4) wires them into the plugin under test.

describe('withFlowestraSections with a models note', () => {
  test('the note goes into the policy section and no section is added', () => {
    const plain = withFlowestraSections([], 'full')
    const out = withFlowestraSections([], 'full', 'A note.')
    expect(out.length).toBe(plain.length)
    expect(out.map(s => s.id)).toEqual(plain.map(s => s.id))
    const policy = out.find(s => s.id === POLICY_SECTION_ID)
    expect(policy?.text).toBe(`${ROUTING_POLICY_SECTION.text}\n\nA note.`)
  })
  test('an empty note gives the same sections as no argument', () => {
    expect(withFlowestraSections([], 'light', '')).toEqual(withFlowestraSections([], 'light'))
  })
})

describe('the /board command texts (0.13.0)', () => {
  test('the description and the three Tokens answers', () => {
    expect(BOARD_COMMAND_DESCRIPTION).toBe('Open or close the Agent Board; /board tokens opens it on the Tokens tab')
    expect(BOARD_COMMAND_HINT).toBe('[tokens]')
    expect(TOKENS_SHOWN_TEXT).toBe('Agent Board: Tokens tab shown.')
    expect(TOKENS_WAITING_TEXT).toBe('Agent Board: the Tokens tab will show once the terminal is wide enough.')
    expect(TOKENS_FAILED_TEXT).toBe('Agent Board: the Tokens tab could not be shown.')
    expect(BOARD_USAGE_TEXT).toBe('/board opens or closes the pane; /board tokens opens it on the Tokens tab.')
  })
})
