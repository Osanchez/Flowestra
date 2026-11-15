// The state contract of flowestra (spec 2.3). Fixed: the view, the tool and
// the wiring code against these names and fields.

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number; requests: number }
// `null` wherever a count is not known. The view prints "n/a". Nothing is ever estimated.
export type BoxStatus = 'starting' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped'
export type AgentBox = {
  id: string                 // agentId; 'main' for the orchestrator
  label: string              // orchestrator: 'Orchestrator'; worker: Agent description cut to 4 words
  type: string               // subagent type, shown small
  model: string | null       // as the API reported it
  unitId: string | null      // the work unit it carries out, from the Agent call's `name`
  name: string | null        // the Agent call's `name` as given (kept so a unit declared later can link it)
  parentId: string | null    // the agent whose loop spawned it; null when the main loop did
  status: BoxStatus
  reason: string | null      // why it failed or stopped, when known
  tokens: Tokens | null      // null = no usage has been reported for this agent
  tokensPartial: boolean     // true when the agent was already running before the board loaded
  startedAt: number | null; endedAt: number | null; lastEventAt: number | null
  lastTool: string | null
  briefChars: number | null; resultChars: number | null   // sizes of what went out and came back
  flow: { dir: 'out' | 'in' | null; at: number | null }   // last transfer, for the arrow highlight
  taskId: string | null      // the task (workstream) it was spawned under; null: none was open
  routed: Routed | null      // what its covering unit said when it started; null: no unit covered it
}
// A delegation's routing, recorded on the agent at spawn (0.7.0), so a box stays
// audited after its unit leaves the list, its task is switched away from, or closed.
export type Routed = { tier: Tier; kind: TaskKind; audit: string }
export type Phase = 'analysis' | 'design' | 'approval' | 'executing' | 'testing' | 'review' | 'done'
// ---- routing (0.6.0): the Model Routing Policy on the board. The policy's own
// text lives in hooks/policy.ts and nowhere else. A worker's tier is MEASURED
// from the model its agent runs on; a UNIT's tier is the orchestrator's
// declaration of one delegation: the tier the policy's §1 procedure selected,
// the task type, the §9 audit line and, once the orchestrator has checked the
// output (§7), its verdict.
export type Tier = 'opus' | 'sonnet' | 'haiku'
// The task type of a delegation. Haiku: the five of §3. Sonnet: those (a task
// escalated from Haiku keeps its type) and the seven typical fits of §4. Opus:
// every type, 'design' and 'debug' included.
export type TaskKind =
  | 'locate' | 'extract' | 'execute' | 'inventory' | 'edit'
  | 'implement' | 'tests' | 'fix' | 'explore' | 'summarize' | 'review' | 'docs'
  | 'design' | 'debug'
export type Verdict = 'accepted' | 'rejected'
export type Unit = {
  id: string; label: string; wave: number; dependsOn: string[]; declared: 'pending' | 'done' | 'failed' | null
  tier: Tier | null          // null only on a unit no worker carries out (one with `declared` set)
  kind: TaskKind | null      // set whenever tier is
  audit: string | null       // set whenever tier is: "<task> | <tier> | <§1 step and conditions that selected it> | <what catches an error>"
  verdict: Verdict | null    // null until the orchestrator has checked the output; 'rejected' is a failure (§8)
  spec: string | null        // path of the approved spec the unit builds from (absolute, or relative to the working directory)
  context: string[]          // up to 8 items the worker is given: an absolute path (optionally `#heading`) or `<task-id>:<unit-id>` (that unit's newest journal entry); [] when none
}
// One rejected unit, counted once per (task, unit). Two of one task type at one tier
// send that type one tier up for the rest of the session (§8): enforced for haiku and sonnet.
// An entry is withdrawn when its unit's verdict is corrected to accepted.
export type TierReject = { unitId: string; tier: Tier; kind: TaskKind; taskId: string | null }

// ---- workstreams (0.7.0): several tasks at once, across repositories. The board's
// own `task`, `phase`, `wave`, `units` (with `taskId` and `repo`) are the ACTIVE
// task's slot; the other open tasks are `parked`, the ones closed this session
// `closed` (kept read-only, so their agents' units can still be looked up).
export type TaskStatus = 'open' | 'closed'
export type TaskSlot = {
  taskId: string             // fixed for the task's life: ^[a-z0-9][a-z0-9-]{1,31}$
  task: string | null        // the title (the board's one-line task summary)
  repo: string | null        // the repository (or folder) the task works in, absolute
  phase: Phase | null; wave: number | null
  units: Unit[]
  status: TaskStatus
  activeAt: number           // epoch ms it was last the active task (the most recent parked one becomes active on a close)
}
export type Board = {
  taskId: string | null; repo: string | null                         // the active task's id and repository; null: no task is open
  task: string | null; phase: Phase | null; wave: number | null      // the active task's title, phase and wave
  units: Unit[]                                                      // the active task's units
  agents: Record<string, AgentBox>; order: string[]                  // every agent of the session, in order of first appearance
  loadedAt: number; note: string | null                              // note: e.g. "live counts unavailable in this build"
  rejects: TierReject[]                                              // oldest first; session-wide; outlives a replaced units list
  parked: TaskSlot[]                                                 // the other open tasks
  closed: TaskSlot[]                                                 // tasks closed this session
  activeAt: number                                                   // epoch ms the active task became active
}

// What the pane draws from besides the board: the clock tick, the session
// total text refreshed at each reconcile, and whether the pane is open.
export type Live = { now: number; sessionTotal: string | null; paneOpen: boolean }

// ---- visual layer (0.4.0; two rows 0.5.0; three tiers 0.6.0): a flow diagram,
// top to bottom: the lead's box, the plan box, then (only while a card is shown
// in it) the LEADS row: Haiku workers, whose results are leads the orchestrator
// audits: its label, fan-out rail, cards, fan-in rail and feed label; then the
// WORKERS row: Sonnet and Opus workers (and any agent on another model): a
// fan-out rail, the cards, a fan-in rail; then the return box. Drawn and animated by the surface module hooks/flow.client.tsx
// from FlowProps. The header, the session log, the detail strip and the footer
// are drawn by hooks/view.tsx around it.
export type ToolRun = { id: string; tool: string; startedAt: number }   // a tool call in flight
export type AgentDetail = { brief: string | null; briefCut: boolean; tools: ToolRun[] }
export type Detail = { agents: Record<string, AgentDetail> }            // keyed by box id ('main' included)
export type Ui = { selected: string | null }                            // the worker card whose detail strip is open

// The session log: what happened, oldest first, at most 50 entries.
export type LogKind = 'spawned' | 'done' | 'failed' | 'stopped' | 'phase' | 'audit' | 'verdict'
export type LogEntry = {
  at: number             // epoch ms
  kind: LogKind
  who: string            // the agent's label; a unit's label for a verdict; 'lead' for a phase change or a barred kind
  text: string           // "spawned · Opus 5.5 · design", "done · 2m 03s", "failed: error", "stopped", "phase → testing",
                         // audit: the unit's audit line, "no audit line (policy §9)", "ran on Opus 5.5, unit says sonnet",
                         //        "spawn refused: <label>",
                         // verdict: "accepted → feeds A, B", "rejected → re-route upward (policy §8)",
                         //          "rejection withdrawn → accepted", "haiku barred for locate (2 rejected)"
                         // phase (who 'lead'), for tasks: "task wb-ui opened", "task → wb-ui", "task wb-ui closed"
}
export type Log = { entries: LogEntry[] }

// What the flow module is handed (plain JSON). Every text is ready to print.
export type RowCardStatus = 'running' | 'waiting' | 'quiet' | 'done' | 'failed' | 'stopped'
export type Row = 'leads' | 'workers'   // the row a card is drawn in: Haiku workers in 'leads', everyone else in 'workers'
export type RowCard = {       // one agent's card in its row
  id: string
  row: Row
  tier: Tier | null      // the measured tier, for the card's colour; null: a model outside the three tiers, or unknown
  warn: boolean          // line 2 drawn in the warning colour: no audit line, or a tier the unit did not declare
  label: string          // at most 4 words
  status: RowCardStatus
  model: string          // line 2: "Opus 5.5 · design", "Haiku 5.5 · locate", "Sonnet 5.5 · no audit", "Opus 5.5 · not sonnet", "model n/a"
  line: string           // line 4: "Edit · 1m 12s", "done · 2m 03s", "quiet 3m", "failed: error"
  tokens: string         // line 5, after the status glyph: "out 8.1k", or "out n/a"
  selected: boolean
}
export type FlowLead = {
  title: string          // "Fable 5.2 · main session"
  running: boolean       // false: waiting
  line: string           // "Edit", "thinking", "waiting", "no events yet"
  tokens: string         // "out 8.1k"
}
export type FlowPlan = {
  title: string          // "PLAN · executing · wave 2", "PLAN · phase not set"
  done: number           // units finished
  total: number          // units declared; 0: none declared
  counts: string         // "running 2   failed 0   queued 1"
}
export type FlowBack = {
  title: string          // "back to Fable 5.2 · lead"
  line: string           // "review + verify · 2 in", "waiting on 3", "idle"
  active: boolean        // results are in the lead's hands: drawn lit
}
export type FlowProps = {
  lead: FlowLead
  plan: FlowPlan | null  // null: the pane is too short for the plan box
  leadsLabel: string     // the label over the leads row's fan-out: "Haiku 5.5 · leads only"
  leads: RowCard[]       // the leads row (every card row 'leads'); empty: the leads row is not drawn
  feed: string           // the label under the leads row's fan-in: "leads → lead audits → workers · 1 accepted · 1 unchecked"
  delegate: string       // the label over the workers row's fan-out: "delegate to workers · Sonnet 5.5, Opus 5.5"
  workers: RowCard[]     // in order of first appearance; a card left out has gone (every card row 'workers')
  back: FlowBack
}
// What the flow module posts (ui.message) when a worker card is pressed.
export type RowPost = { select: string }

declare module 'claude-code' {
  interface PluginState {
    'flowestra': { board: Shaped<Board>; live: Shaped<Live>; detail: Shaped<Detail>; ui: Shaped<Ui>; log: Shaped<Log> }
  }
}
