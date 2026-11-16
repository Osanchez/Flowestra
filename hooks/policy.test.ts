import { describe, expect, test } from 'claude-code/testing'

import {
  AUDIT_MAX_CHARS,
  BLOCKED_RULE,
  HAIKU_KINDS,
  HAIKU_SCHEMA,
  KINDS_BY_TIER,
  OPUS_KINDS,
  OPUS_SCHEMA_NOTE,
  POLICY_SECTION_ID,
  ROUTING_BOARD_NOTE,
  ROUTING_POLICY_SECTION,
  ROUTING_POLICY_TEXT,
  SONNET_KINDS,
  SONNET_SCHEMA,
  SPEC_MAX_CHARS,
  TIERS,
  VERDICTS,
  auditParts,
  auditTier,
  routingPolicySection,
} from './policy'

// The 0.5 vocabulary, spelled apart so that a grep of the mod for it finds nothing.
const OLD_WORD = 'sco' + 'ut'
const OLD_POLICY = 'Haiku ' + 'Delegation'

describe('the constants', () => {
  test('tiers, verdicts and the limits', () => {
    expect([...TIERS]).toEqual(['opus', 'sonnet', 'haiku'])
    expect([...VERDICTS]).toEqual(['accepted', 'rejected'])
    expect(AUDIT_MAX_CHARS).toBe(400)
    expect(SPEC_MAX_CHARS).toBe(500)
  })
  test('the task types of each tier', () => {
    expect([...HAIKU_KINDS]).toEqual(['locate', 'extract', 'inventory'])
    expect([...SONNET_KINDS]).toEqual(['execute', 'edit', 'implement', 'tests', 'fix', 'explore', 'summarize', 'review', 'docs'])
    expect([...OPUS_KINDS]).toEqual(['design', 'debug'])
    expect([...KINDS_BY_TIER.haiku]).toEqual([...HAIKU_KINDS])
    expect([...KINDS_BY_TIER.sonnet]).toEqual(['locate', 'extract', 'execute', 'inventory', 'edit', 'implement', 'tests', 'fix', 'explore', 'summarize', 'review', 'docs'])
    expect([...KINDS_BY_TIER.opus]).toEqual(['locate', 'extract', 'execute', 'inventory', 'edit', 'implement', 'tests', 'fix', 'explore', 'summarize', 'review', 'docs', 'design', 'debug'])
    expect(KINDS_BY_TIER.opus.length).toBe(14)
  })
})

describe('auditParts', () => {
  test('returns the four trimmed parts', () => {
    expect(auditParts('find foo | haiku | step 2, gate holds | I read each line')).toEqual([
      'find foo', 'haiku', 'step 2, gate holds', 'I read each line',
    ])
    expect(auditParts('  a|b  |  c |d ')).toEqual(['a', 'b', 'c', 'd'])
  })
  test('null for fewer or more than four parts', () => {
    expect(auditParts('just a task')).toBe(null)
    expect(auditParts('a | b | c')).toBe(null)
    expect(auditParts('a | b | c | d | e')).toBe(null)
  })
  test('null when a part is empty or blank', () => {
    expect(auditParts('a |  | c | d')).toBe(null)
    expect(auditParts('| b | c | d')).toBe(null)
    expect(auditParts('a | b | c |')).toBe(null)
    expect(auditParts('')).toBe(null)
  })
})

describe('auditTier', () => {
  test('the second part, lower-cased, when it is a tier', () => {
    expect(auditTier('t | haiku | r | c')).toBe('haiku')
    expect(auditTier('t | Sonnet | r | c')).toBe('sonnet')
    expect(auditTier('t |  OPUS  | r | c')).toBe('opus')
  })
  test('null when the second part is not a tier or the line is malformed', () => {
    expect(auditTier('t | worker | r | c')).toBe(null)
    expect(auditTier('t | haiku | r')).toBe(null)
    expect(auditTier('')).toBe(null)
  })
})

describe('the policy text', () => {
  const last = "If any field can't be filled in, route to Opus."

  test('starts with the title and carries the nine headings', () => {
    expect(ROUTING_POLICY_TEXT.startsWith('# Model Routing Policy\n')).toBe(true)
    for (const heading of [
      '## 1. Routing procedure: run in this order for every delegation',
      '## 2. OPUS TRIGGERS: any one forces Opus',
      '## 3. HAIKU GATE: all must hold',
      '## 4. SONNET GATE: all must hold',
      '## 5. Briefs',
      '## 6. Return schemas',
      '## 7. Using worker output',
      '## 8. Escalation: upward only',
      '## 9. Audit line: required for every delegation',
    ]) {
      expect(ROUTING_POLICY_TEXT).toContain(`\n${heading}\n`)
    }
  })
  test('carries key lines and ends with the last one, no trailing newline', () => {
    expect(ROUTING_POLICY_TEXT).toContain('1. Any OPUS TRIGGER (§2) present? -> Opus. Stop.')
    expect(ROUTING_POLICY_TEXT).toContain('- Never retry the same tier more than once. Never escalate downward.')
    expect(ROUTING_POLICY_TEXT).toContain('\n<task> | <tier> | <§1 step and conditions that selected it> | <what catches an error>\n')
    expect(ROUTING_POLICY_TEXT.endsWith(last)).toBe(true)
    expect(ROUTING_POLICY_TEXT.endsWith('\n')).toBe(false)
    expect(ROUTING_POLICY_TEXT.split('\n').length).toBe(89)
  })
  test('Haiku is read-only: no execute or edit task, METHOD_USED names searches and reads', () => {
    expect(ROUTING_POLICY_TEXT).not.toContain('EXECUTE & REPORT')
    expect(ROUTING_POLICY_TEXT).not.toContain('MECHANICAL EDIT')
    expect(ROUTING_POLICY_TEXT).toContain('METHOD_USED: every search or read run, verbatim')
  })
})

describe('the slices', () => {
  test('HAIKU_SCHEMA: the Haiku lines of §6, unindented', () => {
    expect(HAIKU_SCHEMA.startsWith('STATUS: COMPLETE | PARTIAL | BLOCKED\n')).toBe(true)
    expect(HAIKU_SCHEMA.endsWith('\nNo prose, no conclusions.')).toBe(true)
    expect(HAIKU_SCHEMA.split('\n').length).toBe(5)
    expect(HAIKU_SCHEMA).toContain('\nRESULTS: location (path:line range) + verbatim evidence (15 lines max)\n')
    expect(HAIKU_SCHEMA).not.toContain('Sonnet')
    expect(HAIKU_SCHEMA.split('\n').every(line => !line.startsWith(' '))).toBe(true)
  })
  test('SONNET_SCHEMA: the Sonnet lines of §6, unindented', () => {
    expect(SONNET_SCHEMA.startsWith('STATUS: COMPLETE | PARTIAL | BLOCKED\n')).toBe(true)
    expect(SONNET_SCHEMA.endsWith('\nUNCERTAIN / OUT_OF_SCOPE_SEEN')).toBe(true)
    expect(SONNET_SCHEMA.split('\n').length).toBe(6)
    expect(SONNET_SCHEMA).toContain('\nASSUMPTIONS: anything decided that the brief didn\'t specify\n')
    expect(SONNET_SCHEMA).not.toContain('Opus')
    expect(SONNET_SCHEMA.split('\n').every(line => !line.startsWith(' '))).toBe(true)
  })
  test('OPUS_SCHEMA_NOTE: the whole Opus line', () => {
    expect(OPUS_SCHEMA_NOTE).toBe('Opus: same as Sonnet, plus ALTERNATIVES_REJECTED for design work.')
  })
  test('BLOCKED_RULE: the §5 sentence, whitespace collapsed', () => {
    expect(BLOCKED_RULE).toBe(
      "If the task needs a decision the brief doesn't make, touches anything in §2, or goes outside SCOPE, stop and return BLOCKED with the reason. Do not resolve it yourself.",
    )
  })
  test('the schema slices sit in the policy text as §6 lays them out', () => {
    const indented = (text: string) => text.split('\n').map(line => `  ${line}`).join('\n')
    expect(ROUTING_POLICY_TEXT).toContain(`\nHaiku:\n${indented(HAIKU_SCHEMA)}\nSonnet:\n${indented(SONNET_SCHEMA)}\n${OPUS_SCHEMA_NOTE}\n`)
  })
})

describe('the policy section', () => {
  test('has its id, session scope, and the policy then the board note', () => {
    expect(POLICY_SECTION_ID).toBe('flowestra:routing-policy')
    expect(ROUTING_POLICY_SECTION.id).toBe(POLICY_SECTION_ID)
    expect(ROUTING_POLICY_SECTION.scope).toBe('session')
    expect(ROUTING_POLICY_SECTION.text).toBe(`${ROUTING_POLICY_TEXT}\n\n${ROUTING_BOARD_NOTE}`)
  })
  test('the board note is one line and says what the spec asks', () => {
    expect(ROUTING_BOARD_NOTE.includes('\n')).toBe(false)
    expect(ROUTING_BOARD_NOTE.startsWith('On the Agent Board: every delegation is a work unit, declared before its worker is spawned:')).toBe(true)
    expect(ROUTING_BOARD_NOTE.endsWith('which is for reading with judgment, not for quoting.')).toBe(true)
    expect(ROUTING_BOARD_NOTE).toContain('A unit you carry out yourself has no tier: give it declared (pending, done or failed).')
    for (const needle of [
      'the §9 line "<task> | <tier> | <§1 step and conditions that selected it> | <what catches an error>"',
      'flowestra:haiku-worker, flowestra:sonnet-worker or flowestra:opus-worker',
      'the built-in types Explore, Plan, general-purpose, claude, web-fetch and claude-code-guide: the tier workers replace them, and web reading goes to a Sonnet or Opus worker, which both have the web tools.',
      'names the file in spec, and its worker is refused while that file does not exist',
      'After you check a worker\'s output (§7), send the units again with its verdict, "accepted" or "rejected".',
      'after two rejections of one kind at haiku or sonnet that kind is refused at that tier for the rest of the session',
      'Each audit line is also written to this session\'s audit file.',
    ]) {
      expect(ROUTING_BOARD_NOTE).toContain(needle)
    }
  })
  test('the board note ends with the fork, context, task and web sentences, in order, on one line', () => {
    const sentences = [
      'A fork is refused too: it would copy this whole conversation and run on your own model, with no tier and no audit line.',
      'A unit may also name context, up to 8 things its worker needs from earlier work (a file path, optionally with "#heading", or "<task-id>:<unit-id>" for that unit\'s newest journal entry): their text is placed in the worker\'s brief, so name the journal entries and the decisions.md entry instead of retelling them.',
      'Work is kept as tasks: a taskId opens a task or switches to it, units, phase and wave belong to their task, a worker is always spawned under the active task, and the answer to a switch gives you that task\'s state, so you need not hold its history; every delegation\'s brief, result and verdict are kept in the work journal on disk.',
      'For verbatim web content (exact text, a title, a version string), brief the worker to fetch the page with a shell command and return the output unchanged: the web tools return a summarised page, which is for reading with judgment, not for quoting.',
    ]
    let at: number = ROUTING_BOARD_NOTE.indexOf('A unit you carry out yourself has no tier')
    expect(at).toBeGreaterThan(-1)
    for (const sentence of sentences) {
      const found: number = ROUTING_BOARD_NOTE.indexOf(` ${sentence}`, at)
      expect(found).toBeGreaterThan(-1)
      at = found + sentence.length
    }
    expect(ROUTING_BOARD_NOTE.endsWith(sentences[3] ?? '')).toBe(true)
    expect(ROUTING_BOARD_NOTE.includes('\n')).toBe(false)
  })
  test('nothing of the old policy remains', () => {
    expect(ROUTING_POLICY_SECTION.text.toLowerCase()).not.toContain(OLD_WORD)
    expect(ROUTING_POLICY_SECTION.text).not.toContain(OLD_POLICY)
  })
})

describe('routingPolicySection', () => {
  test('an empty note gives the constant itself', () => {
    expect(routingPolicySection('')).toBe(ROUTING_POLICY_SECTION)
  })
  test('a note is the last paragraph, with the same id and scope', () => {
    const section = routingPolicySection('A note.')
    expect(section.id).toBe(POLICY_SECTION_ID)
    expect(section.scope).toBe('session')
    expect(section.text).toBe(`${ROUTING_POLICY_TEXT}\n\n${ROUTING_BOARD_NOTE}\n\nA note.`)
    expect(section.text.split('\n\n').pop()).toBe('A note.')
  })
})
