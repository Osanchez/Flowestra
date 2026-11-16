// The Model Routing Policy as the mod carries it (0.6.0): the policy text,
// verbatim, the note that ties it to the Agent Board, the system-prompt
// section that carries both, the slices of the text the tier workers' prompts
// are built from (./workers), and the pieces board.ts validates a unit with
// (tiers, task types, verdicts, the §9 audit line). The policy lives here and
// nowhere else: everything else cites it by name and section number.
// Pure: no `$`, type-only imports.

import type { PromptComposeSection } from 'claude-code'

import type { TaskKind, Tier } from '../types'

export const TIERS: readonly Tier[] = ['opus', 'sonnet', 'haiku']

// The task types a tier takes (policy §3, §4; design and debug are §2 triggers). execute and edit were Haiku's until 0.10.
export const HAIKU_KINDS: readonly TaskKind[] = ['locate', 'extract', 'inventory']
export const SONNET_KINDS: readonly TaskKind[] = ['execute', 'edit', 'implement', 'tests', 'fix', 'explore', 'summarize', 'review', 'docs']
export const OPUS_KINDS: readonly TaskKind[] = ['design', 'debug']

// A task escalated from a lower tier keeps its type, so each tier takes the
// types of the tiers below it.
// The canonical order the lists below keep, so the sonnet and opus lists (and
// every message built from them) read as they did before 0.10.
const KIND_ORDER: readonly TaskKind[] = [
  'locate', 'extract', 'execute', 'inventory', 'edit', 'implement', 'tests', 'fix', 'explore', 'summarize', 'review', 'docs', 'design', 'debug',
]
const inOrder = (kinds: readonly TaskKind[]): readonly TaskKind[] => KIND_ORDER.filter(kind => kinds.includes(kind))
export const KINDS_BY_TIER: Record<Tier, readonly TaskKind[]> = {
  haiku: inOrder(HAIKU_KINDS),
  sonnet: inOrder([...HAIKU_KINDS, ...SONNET_KINDS]),
  opus: KIND_ORDER,
}

export const VERDICTS = ['accepted', 'rejected'] as const
export const AUDIT_MAX_CHARS = 400
export const SPEC_MAX_CHARS = 500

/**
 * The four trimmed parts of a §9 audit line ("<task> | <tier> | <§1 step and
 * conditions that selected it> | <what catches an error>"), or null unless
 * there are exactly four and none is empty. Pure.
 */
export function auditParts(audit: string): [task: string, tier: string, route: string, check: string] | null {
  const parts = audit.split('|').map(part => part.trim())
  if (parts.length !== 4) return null
  const [task, tier, route, check] = parts
  if (task === undefined || tier === undefined || route === undefined || check === undefined) return null
  if (task.length === 0 || tier.length === 0 || route.length === 0 || check.length === 0) return null
  return [task, tier, route, check]
}

/** The tier an audit line's second part names (case-insensitive), or null. Pure. */
export function auditTier(audit: string): Tier | null {
  const parts = auditParts(audit)
  if (parts === null) return null
  const tier = parts[1].toLowerCase()
  return (TIERS as readonly string[]).includes(tier) ? (tier as Tier) : null
}

// The policy, verbatim, no trailing newline (no backticks, `$` or backslashes
// in it, so the template literal holds it character for character).
export const ROUTING_POLICY_TEXT: string = `# Model Routing Policy

Tiers: the orchestrator plans, routes, and reviews. Workers are Opus, Sonnet,
or Haiku. This policy is the only source of routing rules.

## 1. Routing procedure: run in this order for every delegation
1. Any OPUS TRIGGER (§2) present? -> Opus. Stop.
2. Every HAIKU GATE condition (§3) holds? -> Haiku. Stop.
3. Every SONNET GATE condition (§4) holds? -> Sonnet. Stop.
4. Otherwise -> Opus.
In doubt between two tiers, take the higher one. Never route by task label
("it's just a test", "it's just a search"); route by the conditions.
Split mixed tasks: route each part separately instead of sending the whole
task to the lowest tier any part qualifies for.

## 2. OPUS TRIGGERS: any one forces Opus
- Planning, architecture, design, or choosing between approaches.
- Debugging where the root cause is unknown or ambiguous.
- A change that spans more than one repo, or a shared contract between them.
- Security, auth, migrations, data deletion, prod infra, irreversible actions.
- No automated check and no reviewer downstream of the output.
- Final review of any change before it is presented as done.
- A conclusion that will feed a decision without the source being re-read.
- The brief can't be written without phrases like "figure out" or "look into."

## 3. HAIKU GATE: all must hold
1. The task is one of: LOCATE (return locations), EXTRACT (verbatim values
   into a schema), or INVENTORY (list or count by a mechanical criterion).
2. The brief pins exact targets, scope, and output format.
3. The output is checkable by schema, a deterministic tool, or by reading the
   cited source.
4. No summarizing, relevance judgment, recommendation, or non-trivial logic.

## 4. SONNET GATE: all must hold
1. The work stays in one repo and one functional area.
2. Acceptance criteria are written in the brief and are testable.
3. A named check catches errors: tests, build, lint, or an Opus or
   orchestrator review. The brief says which.
4. Any design decision the task needs is already made in the brief.
Typical fits: implementing a specified change, writing tests, fix-until-green
loops, scoped exploration that returns locations with reasoning, cited
summaries, first-pass diff review, drafting PR descriptions and docs,
running a given command and reporting its output, mechanical edits.

## 5. Briefs
Every brief states: TASK, SCOPE (including what is out of scope), TARGETS or
ACCEPTANCE CRITERIA, CHECK (what will verify the result), STOP WHEN, and the
return schema for that tier.
Sonnet and Haiku briefs also carry this rule: "If the task needs a decision
the brief doesn't make, touches anything in §2, or goes outside SCOPE, stop
and return BLOCKED with the reason. Do not resolve it yourself."

## 6. Return schemas
Haiku:
  STATUS: COMPLETE | PARTIAL | BLOCKED
  METHOD_USED: every search or read run, verbatim
  RESULTS: location (path:line range) + verbatim evidence (15 lines max)
  NOT_FOUND / UNCERTAIN / OUT_OF_SCOPE_SEEN
  No prose, no conclusions.
Sonnet:
  STATUS: COMPLETE | PARTIAL | BLOCKED
  CHANGES: files touched, one line each on what changed
  CHECKS_RUN: command + its summary line; verbatim lines only for failures
  CLAIMS: at most 8, what the orchestrator must decide or verify, each with path:line
  ASSUMPTIONS: anything decided that the brief didn't specify, one line each
  UNCERTAIN / OUT_OF_SCOPE_SEEN
  About 250 words in all; never restate the brief or paste whole outputs.
Opus: same as Sonnet, plus ALTERNATIVES_REJECTED for design work; a design's detail goes in its draft file.

## 7. Using worker output
- Haiku results are leads. Read the cited source before deciding anything, and
  audit METHOD_USED for coverage gaps. NOT_FOUND is not proof of absence.
- Sonnet results are drafts. Confirm CHECKS_RUN actually passed, read every
  ASSUMPTIONS entry, and spot-check at least one CLAIMS citation. Any
  assumption that amounts to a design decision sends the task to Opus.
- Reject output that breaks the schema.

## 8. Escalation: upward only
- Haiku PARTIAL, BLOCKED, schema violation, or failed spot-check: re-route
  from §1 step 3 (Sonnet if its gate holds, otherwise Opus).
- Sonnet PARTIAL, BLOCKED, failed check after one fix attempt, or a
  design-level assumption: Opus.
- Opus BLOCKED: the orchestrator resolves it or asks the user.
- Never retry the same tier more than once. Never escalate downward.
- Two failures of one task type at a tier in a session: that type goes one
  tier up for the rest of the session.

## 9. Audit line: required for every delegation
<task> | <tier> | <§1 step and conditions that selected it> | <what catches an error>
If any field can't be filled in, route to Opus.`

// ---------------------------------------------------------------------------
// Slices of the policy, computed from ROUTING_POLICY_TEXT (never retyped)
// ---------------------------------------------------------------------------

const POLICY_LINES = ROUTING_POLICY_TEXT.split('\n')

// The lines of one `## n. …` section, heading excluded.
function sectionLines(n: number): string[] {
  const start = POLICY_LINES.findIndex(line => line.startsWith(`## ${n}. `))
  if (start < 0) return []
  const rest = POLICY_LINES.slice(start + 1)
  const end = rest.findIndex(line => line.startsWith('## '))
  return end < 0 ? rest : rest.slice(0, end)
}

// Lines with the policy's two-space indent removed, joined and trimmed.
function unindented(lines: readonly string[]): string {
  return lines.map(line => (line.startsWith('  ') ? line.slice(2) : line)).join('\n').trim()
}

const SCHEMA_LINES = sectionLines(6)
const HAIKU_AT = SCHEMA_LINES.indexOf('Haiku:')
const SONNET_AT = SCHEMA_LINES.indexOf('Sonnet:')
const OPUS_AT = SCHEMA_LINES.findIndex(line => line.startsWith('Opus: same as Sonnet'))

/** §6: the Haiku return schema (the lines after `Haiku:`, up to `Sonnet:`). */
export const HAIKU_SCHEMA: string =
  HAIKU_AT >= 0 && SONNET_AT > HAIKU_AT ? unindented(SCHEMA_LINES.slice(HAIKU_AT + 1, SONNET_AT)) : ''

/** §6: the Sonnet return schema (the lines after `Sonnet:`, up to the Opus line). */
export const SONNET_SCHEMA: string =
  SONNET_AT >= 0 && OPUS_AT > SONNET_AT ? unindented(SCHEMA_LINES.slice(SONNET_AT + 1, OPUS_AT)) : ''

/** §6: the whole `Opus: same as Sonnet, …` line. */
export const OPUS_SCHEMA_NOTE: string = OPUS_AT >= 0 ? unindented([SCHEMA_LINES[OPUS_AT]!]) : ''

/** §5: the rule Sonnet and Haiku briefs carry, quoted there; whitespace collapsed. */
export const BLOCKED_RULE: string = (() => {
  const briefs = sectionLines(5).join('\n')
  const open = briefs.indexOf('"')
  const close = open < 0 ? -1 : briefs.indexOf('"', open + 1)
  return close < 0 ? '' : briefs.slice(open + 1, close).split(/\s+/).filter(word => word.length > 0).join(' ')
})()

// ---------------------------------------------------------------------------
// The system-prompt section
// ---------------------------------------------------------------------------

export const ROUTING_BOARD_NOTE: string =
  `On the Agent Board: every delegation is a work unit, declared before its worker is spawned: tier (opus, sonnet or haiku: what §1 selected), kind (the task type; haiku: locate, extract or inventory; sonnet: those and execute, edit, implement, tests, fix, explore, summarize, review or docs; opus: any of those, design or debug) and audit, the §9 line "<task> | <tier> | <§1 step and conditions that selected it> | <what catches an error>". Spawn it with the tier's worker type, flowestra:haiku-worker, flowestra:sonnet-worker or flowestra:opus-worker, and a name equal to the unit id (where the Agent tool takes no name, a description equal to the unit's label). A call that no such unit covers is refused, and so are the built-in types Explore, Plan, general-purpose, claude, web-fetch and claude-code-guide: the tier workers replace them, and web reading goes to a Sonnet or Opus worker, which both have the web tools. A unit that builds from an approved spec names the file in spec, and its worker is refused while that file does not exist. A unit that uses another unit's results lists it in dependsOn. After you check a worker's output (§7), send the units again with its verdict, "accepted" or "rejected". A rejection is a failure under §8: re-route the task upward under a new unit, never retry a tier more than once, and after two rejections of one kind at haiku or sonnet that kind is refused at that tier for the rest of the session. Each audit line is also written to this session's audit file. A unit you carry out yourself has no tier: give it declared (pending, done or failed). A fork is refused too: it would copy this whole conversation and run on your own model, with no tier and no audit line. Agents that other agents start are held to the same units, named in the call; a resumed worker (a message to a finished one) is refused when its unit was rejected, its kind is barred at its tier, or its tier's model has changed since it started. Workflow agents, skills that run in their own agent and agents the board did not see start are not checked: the board marks them ungated. When the board's answer says the gate is degraded, a check failed with an error: tell the user. A unit may also name context, up to 8 things its worker needs from earlier work (a file path, optionally with "#heading", or "<task-id>:<unit-id>" for that unit's newest journal entry): their text is placed in the worker's brief, so name the journal entries and the decisions.md entry instead of retelling them. Work is kept as tasks: a taskId opens a task or switches to it, units, phase and wave belong to their task, a worker is always spawned under the active task, and the answer to a switch gives you that task's state, so you need not hold its history; every delegation's brief, result and verdict are kept in the work journal on disk. For verbatim web content (exact text, a title, a version string), brief the worker to fetch the page with a shell command and return the output unchanged: the web tools return a summarised page, which is for reading with judgment, not for quoting.`

export const POLICY_SECTION_ID = 'flowestra:routing-policy'

export const ROUTING_POLICY_SECTION: PromptComposeSection = {
  id: POLICY_SECTION_ID,
  text: ROUTING_POLICY_TEXT + '\n\n' + ROUTING_BOARD_NOTE,
  scope: 'session',
}

/** The policy section, with the worker-models note as its last paragraph when there is one. */
export function routingPolicySection(note: string): PromptComposeSection {
  if (note === '') return ROUTING_POLICY_SECTION
  return { id: POLICY_SECTION_ID, text: `${ROUTING_POLICY_TEXT}\n\n${ROUTING_BOARD_NOTE}\n\n${note}`, scope: 'session' }
}
