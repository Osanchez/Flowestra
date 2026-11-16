<p align="center"><img src=".claude-plugin/icon.png" alt="Flowestra logo" width="150"></p>

# Flowestra

**Run Claude Code as an orchestrator with a team of Opus, Sonnet and Haiku workers, and watch the whole thing live.**

Flowestra is a Claude Code mod. It gives the main session a routing policy for choosing which model does each piece of work, a gate that enforces that policy, a live board showing every worker, tasks that span several repositories at once, and a journal on disk of everything that was delegated.

![The Agent Board during a run: two Haiku workers, two Sonnet workers and one Opus worker](docs/demo.gif)

*A staged demo run: the workers here only pause for a few seconds, so the recording shows the board and not real work.*

## When to use it

Flowestra is for work where you want control over which model does what, and a record of it; it is not a way to make quick fixes cheaper.

- **Multi-step changes in one repository.** The orchestrator writes the spec, a Sonnet worker implements and tests, and the orchestrator reviews. In the [benchmark](docs/BENCHMARK.md) this used 17% fewer tokens in total and 35–61% fewer Opus tokens than a plain session.
- **Long sessions and multi-part projects.** Workers do the reading and the edit/test loop in contexts that end, so the lead's context stays small instead of growing every turn.
- **Work across several repositories, for structure rather than savings.** The work splits into parallel units, one per repository, and shared contracts and migrations get an Opus worker by rule. In the benchmark's three-repository task this cost 46% more input than a plain session, at the same pass rate.
- **Changes where a mistake does real damage (migrations, security, auth, data deletion).** These are routed to Opus by rule, and in the `full` workflow nothing is built before you approve a written design.
- **Teams or audits that need to know what was done and why.** Every brief, result and verdict is in the journal, and approved designs are in `.flowestra/decisions.md`.
- **Bulk mechanical work (searching, inventories, extraction, fix-until-green loops).** It goes to Haiku or Sonnet, in parallel where the units are independent.
- **Seeing how agents spend tokens.** The board shows each worker's model, current tool and real token counts; the Tokens tab splits the lead from the workers.
- **Keeping the top model for decisions.** The lead frames, routes and reviews; workers write.

**When not to use it**

- **A quick one-line or one-file fix.** The overhead and a worker's cold start buy you little; plain Claude Code is simpler.
- **Fully unattended runs with `full`.** It stops for your approval. Use `light`, or state the approval up front.
- **Work that needs the built-in agent types (Explore, Plan, general-purpose and the rest).** They are unavailable while the mod is loaded.

## Limitations

- **Fixed prompt overhead.** About 8.9k tokens of instructions are added to every request of the lead, mostly read from cache.
- **Workers start cold.** Each rereads the files it needs, and a unit that fails at Sonnet is rerun on Opus (escalation), which adds tokens.
- **Slower on some work.** On the benchmark's larger task, total output rose 18% and wall-clock time 12% against a plain session.
- **Dearer on cross-repository changes.** On the benchmark's three-repository contract change, total input rose 46% and Opus input 36%: in every run the policy sent one unit to an Opus worker (shared contract or migration), and the lead's own input fell only 15%.
- **Small evidence base.** The benchmark is 3 runs per cell, with tasks of about 2–10 minutes: two in one repository and one across three small repositories. Hours-long work has not been measured yet.
- **No counterfactual in the Tokens tab.** It shows what was spent, not what the same work would have used without the mod.
- **The gate only sees agent starts.** Workflow agents, skills that run in their own agent, and agents started before the board loaded run unchecked; they are marked, not refused. See "What the gate does not check".
- **The journal is plain text.** Briefs and results are stored unencrypted on your machine, and secret masking is best effort.
- **The approval gate needs you.** In `full`, implementation waits for your approval.
- **Surfaces.** The pane has been checked in the terminal; the desktop app shows a simpler fallback view. A Claude Code build that supports mods is required (tested on 2.1.325).

## Token cost, measured

Measured on 18 fresh sessions (Flowestra 0.16.0, Opus 5.5 lead, 3 runs per cell, median):

| Task | Without Flowestra | With 0.16.0 | Difference (total) | Opus tokens |
|---|---:|---:|---:|---:|
| Small: one fix | 1.00M tokens | 0.83M tokens | −17% | −35% |
| Larger: three fixes | 3.47M tokens | 2.88M tokens | −17% | −61% |
| Three repositories, one shared contract | 1.81M tokens | 2.65M tokens | +46% | +36% |
| Fixed cost per request | | | +8.9k tokens, mostly cached | |

Delegation happens on its own: in all 9 runs the work went to workers, and the lead made no file edits. On the single-repository tasks the work went mostly to Sonnet, so the Opus share fell. On the three-repository task, every run also sent one unit to an Opus worker (shared contract or migration), and the total rose. The tests passed in every run, including a hidden 40-test acceptance suite on the multi-repo task. The sample is small (3 runs per cell), and on the small and multi-repo tasks the total-input ranges overlap.

**[Full benchmark: method, every run, benefits, limitations and when it's worth it →](docs/BENCHMARK.md)**

## How it works

**Three tiers of workers.** The mod registers one worker type per tier, each with its model and its own return format:

| Worker | Model | Used for | Tools |
|---|---|---|---|
| `flowestra:haiku-worker` | Haiku | One read-only task: locate, extract, inventory. Its results are leads, never conclusions | Read, Grep, Glob |
| `flowestra:sonnet-worker` | Sonnet | Specified work in one repository and one area, with written acceptance criteria and a named check. Its results are drafts the orchestrator verifies | Read, Bash, Edit, Write, WebFetch, WebSearch |
| `flowestra:opus-worker` | Opus | Design, unknown root causes, cross-repository changes, security, migrations, and anything the other two gates do not pass | Everything the orchestrator has, except spawning agents |

Each tier's model can be switched off (see "Choose worker models" below); the tier's work then runs on another model, with the same tools and return format.

**Implementation is always delegated.** The orchestrator keeps the planning and the review: framing, the spec, routing, the checks and the final review. Every change to the project's files (code, tests, docs, config) goes to a worker, usually Sonnet. Task size decides how: a small task (one area, one or two files) goes whole, tests included, to one Sonnet worker; a larger one is split by the files each unit owns, and units that write different files run in parallel. When the Sonnet switch is off, the orchestrator writes the implementation itself as a declared unit. Designs go to an Opus worker only when they need code the orchestrator has not read. Worker returns are kept to about 250 words: the detail is in the diff and the journal.

**A routing policy, in one place.** The mod adds a Model Routing Policy to the orchestrator's instructions: a procedure to run for every delegation (any Opus trigger? does the Haiku gate hold? does the Sonnet gate hold? otherwise Opus), what each tier's brief must state, what each tier returns, and how failures escalate upward. Its text lives in `hooks/policy.ts` and nowhere else.

**A gate that enforces it.** Before a worker starts, the board checks that a declared unit of work covers it, with a tier, a task type and an audit line of four parts: the task, the tier, the routing step that selected it, and what will catch an error. A worker with no such unit is refused. So are:

- the built-in agent types the tier workers replace (`Explore`, `Plan`, `general-purpose`, `claude`, `web-fetch`, `claude-code-guide`);
- forks, which would copy the whole conversation and run on the orchestrator's own model with no tier and no audit line;
- an agent started by another agent that no declared unit covers, and a built-in type started by another agent;
- a worker for a unit that was rejected, a third run of one unit at the same tier, and a task type barred at a tier after two rejections in a session;
- a resumed worker (a message sent to a finished one) whose unit was rejected, whose task type has since been barred at its tier, or whose tier's model has been switched off since it started;
- a worker whose unit names a spec file or a context item that does not exist.

**When the gate itself fails.** A check that fails with an error does not block the session: by default the spawn starts unchecked. The refusals that need no board state (forks, the replaced built-in types, a model a worker may not run on) are still made. Each failure is shown: the board's status line reads `gate [degraded · 2 failed]` until the mod loads again, the session log and the audit file record it, and the orchestrator is told in the board's answer. To refuse spawns instead while the gate cannot check them, set "When a worker can't be verified" to `block` in `/config`; a fault in the mod then stops all delegation until it is fixed.

**What the gate does not check.** The gate sees an agent when Claude Code asks the mod before starting it. These agents run with no unit, no tier check and no audit line; each is marked on its card (`ungated: …`), in the session log, in the board's answer and, except the unseen ones, in the audit file:

- **Workflow agents.** The agents a Workflow script starts. They run on the model the script names, or on the main session's model when it names none. The Workflow tool is used only when you ask for it.
- **Skills that run in their own agent** (`context: fork` in the skill). Claude Code starts these without asking any mod, so the gate cannot refuse them; the board shows the agent once it appears, marked `unseen`. Agents that such an agent starts are checked.
- **Agents started before the board loaded**, for example when the mod is turned on mid-session: also `unseen`.
- **`statusline-setup`**, the settings utility behind `/statusline`: exempt.
- **A resumed agent that no unit covered**, such as one of the above.

A resumed tier worker is checked again (above) and is not counted as another run. Agents started by other agents are held to the same rules as the orchestrator's: a declared unit, named in the call.

**Context instead of forks.** A unit can name up to eight things its worker needs from earlier work: a file (optionally one `#heading` of it) or an earlier unit's journal entry. The mod places their text in the worker's brief, so the worker never needs the orchestrator's conversation. When a task works in another repository, the worker runs in that repository's folder and is given its `CLAUDE.md`.

**A work journal.** Every covered delegation is written to disk as it starts, finishes and receives its verdict:

```
~/.claude/flowestra/journal/
  index.md                           one line per repository
  <repo>/index.md                    one line per task
  <repo>/<task>/index.md             one line per phase, plus the task's state file
  <repo>/<task>/<phase>/index.md     one line per delegation
  <repo>/<task>/<phase>/<entry>.md   the audit line, the brief, the result, the verdict
```

The mod writes it mechanically from what it sees; no model writes summaries for it. Index lines are capped at 160 characters, so the indexes stay small however long the work runs, and several sessions can write to the same journal at once.

**What it holds.** The journal stores every brief and every result in plain text files under your Claude Code config folder. Whatever a brief or a result contains is in it: source code, file contents, command output, and any credential or private text that passed through them. The mod sends none of it anywhere; a journal entry you name as a unit's context is placed in that worker's brief, which goes to the model like any prompt. With "Mask secrets in the journal" on (the default), text that looks like a known kind of credential is replaced by `[redacted:<kind>]` before it is written. This is best effort: a secret in any other form is stored as written. Masking covers briefs, messages and results; the one-line routing reason the orchestrator writes for each unit is stored as written. "Journal content" can keep only the head and tail of each brief and result, or none of them. Nothing is ever deleted on its own: the only way to delete is `/journal prune`, confirmed by your own typed command, and it removes only the mod's own journal and audit files under your Claude Code config folder. Deleting does not remove copies in backups of your home folder. Treat the folder like your shell history: do not commit, sync or share it.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install flowestra --marketplace Osanchez/Flowestra
```

Answer `y` to add the marketplace, then choose a scope (the user scope makes it available in every project).

From a shell:

```
claude plugin install flowestra --marketplace Osanchez/Flowestra
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `Osanchez/Flowestra`, then **Add plugin**.

The pane opens by itself when workers start. `/board` opens or closes it. `/board tokens` opens it on the Tokens tab.

`/journal` shows the journal's size and settings. `/journal prune <days>` shows which closed tasks and audit files are that old and what deleting them would free; nothing is deleted until you type the confirmation it prints, which only works when you type it yourself. Open tasks are kept; one you abandoned can be deleted by name with `/journal prune task <repo>/<task>`. `/journal check` finds entries missing from the indexes, restores damaged task state files from their backup, and rebuilds the indexes. It deletes only task folders and audit files inside the mod's own `flowestra` folder in your Claude Code config folder, never anything in a project, and where it cannot delete (outside the terminal, or on Windows) it lists the folders for you to remove.

**Requirements.** A Claude Code build that supports mods (plugins with a hooks module). Flowestra was built and tested on Claude Code 2.1.325, with an account that can use the worker models you leave switched on (Opus, Sonnet and Haiku by default).

## Setting it up in your repository

Installing the mod gives the main session the routing policy, the workers, the gate, the board, the journal and, by default, the orchestrator workflow. No `CLAUDE.md` is needed.

1. **Choose a workflow.** Open `/config` and set the row "Workflow" (the install screen shows it too). It applies from the next session.

   | Value | What the main session gets |
   |---|---|
   | `full` (default) | The orchestrator role and the whole workflow: frame, design (by an Opus worker when it needs code the orchestrator has not read), design review, your approval before anything is built, the approved spec written to `.flowestra/decisions.md`, execution in waves, test, review |
   | `light` | The orchestrator role only: delegate to the tier workers, brief them, review what comes back. No approval gate and no decisions file |
   | `off` | Only the routing policy and the board instructions, for a workflow you write yourself in your own `CLAUDE.md` |

2. **Choose worker models.** Open `/config` and set the rows "Opus workers", "Sonnet workers" and "Haiku workers", all on by default. The routing does not change; only the model that runs a tier. The main session's model is never changed. The first model in a tier's list that is on runs it (1 = on):

   | Opus | Sonnet | Haiku | Opus tier runs on | Sonnet tier runs on | Haiku tier runs on |
   |---|---|---|---|---|---|
   | 1 | 1 | 1 | Opus | Sonnet | Haiku |
   | 0 | 1 | 1 | Sonnet | Sonnet | Haiku |
   | 1 | 0 | 1 | Opus | Opus | Haiku |
   | 1 | 1 | 0 | Opus | Sonnet | Sonnet |
   | 0 | 1 | 0 | Sonnet | Sonnet | Sonnet |
   | 1 | 0 | 0 | Opus | Opus | Opus |
   | 0 | 0 | 1 | refused | refused | Haiku |
   | 0 | 0 | 0 | refused | refused | refused |

   When no model is on for a tier, work routed to it is refused and the orchestrator does it itself or asks you. A change applies from the next session.

   "When a worker can't be verified" (`start anyway` by default): `block` refuses a worker the gate could not check instead of letting it start unchecked.
3. **Choose what the journal keeps.** Open `/config` and set "Mask secrets in the journal" (on by default) and "Journal content" (`full` by default, or `capped`, or `index`). A change applies from the next session. Nothing is deleted automatically; see `/journal` below.
4. **Approved designs go to `.flowestra/decisions.md`** (`full` only). Each approved design is a dated entry in that file at the project root, and worker briefs point at that entry. Commit the folder or add it to `.gitignore`, as you prefer.
5. **Add project constraints, if any.** A project's `CLAUDE.md` can list resources its work shares (one test database, one device, one editor) and can send a kind of work to a higher tier than the policy would. It should never send work to a lower one: the policy is the only source of routing rules.
6. **Start working.** Ask for something that needs more than one step. The orchestrator opens a task, declares its units and spawns workers, and the board shows them.

What a declaration looks like, through the `AgentBoard` tool the mod registers:

```json
{
  "taskId": "rate-limit",
  "task": "Add rate limiting to the API",
  "phase": "executing",
  "wave": 1,
  "units": [
    {
      "id": "find",
      "label": "Locate call sites",
      "wave": 1,
      "tier": "haiku",
      "kind": "locate",
      "audit": "find every call site of the request handler | haiku | step 2: Haiku gate holds: exact symbol and scope pinned, checkable by re-running the search | I read the cited lines"
    },
    {
      "id": "build",
      "label": "Implement the limiter",
      "wave": 2,
      "dependsOn": ["find"],
      "tier": "sonnet",
      "kind": "implement",
      "audit": "implement the limiter from the approved spec | sonnet | step 3: Sonnet gate holds: one area, criteria in the spec, tests named as the check | the tests, then my review",
      "spec": ".flowestra/decisions.md",
      "context": ["rate-limit:find", "/path/to/repo/.flowestra/decisions.md#Rate limiter"]
    }
  ]
}
```

A worker is linked to its unit by the Agent call's `name` (the unit id) or, where the Agent tool takes no name, by a description equal to the unit's label.

## The `AgentBoard` tool

| Field | Meaning |
|---|---|
| `taskId` | The task this update is about. A new id opens a task, an open id switches to it, and a known id from an earlier session resumes it from its state file |
| `task` | The task's one-line title |
| `repo` | The repository or folder the task works in (default: the session's) |
| `phase` | analysis, design, approval, executing, testing, review or done |
| `wave` | The wave of workers running or about to start |
| `units` | The full list of the task's work units (it replaces the previous list) |
| `close` | `true` closes the active task |

Each unit has an `id`, a `label` of one to four words, a `wave` and optional `dependsOn`. A unit a worker carries out also has:

| Field | Meaning |
|---|---|
| `tier` | opus, sonnet or haiku: what the routing procedure selected |
| `kind` | The task type. Haiku: locate, extract, inventory. Sonnet: those and execute, edit, implement, tests, fix, explore, summarize, review, docs. Opus: all of those and design, debug |
| `audit` | `<task> \| <tier> \| <routing step and conditions> \| <what catches an error>` |
| `verdict` | accepted or rejected, sent once the orchestrator has checked the result. A rejection can later be corrected to accepted, which withdraws the failure |
| `spec` | The approved spec the unit builds from; its worker is refused while the file does not exist |
| `context` | Up to eight files or earlier units whose text is placed in the worker's brief (32,000 characters an item, 96,000 in all) |

A unit the orchestrator carries out itself has no tier and takes `declared` (pending, done or failed) instead.

## The Agent Board

The pane is a flow diagram, top to bottom: the lead's box, the plan box (phase, wave, units finished), a row of Haiku workers whose results are leads, and a row of Sonnet and Opus workers. A card's own done state shows that its result is in.

- **Colours by tier:** Haiku magenta, Sonnet blue, Opus lavender. A finished card turns green, a failed one red.
- **Live cards:** each shows its model and task type, a moving bar, its current tool, elapsed time and tokens in and out. Dots travel along the rails as work goes out, and back from the leads row. Token counts are real, never estimated. When a tier ran on another model because its own is switched off, the card reads, for example, opus→Sonnet 5.5 · design and keeps the tier's colour.
- **Nothing slides past unchecked:** a finished Haiku or Sonnet card stays in its row, reading `lead · unchecked` or `draft · unchecked`, until its verdict is recorded.
- **Header:** the top row holds the title AGENT BOARD and the two tabs, and under it a row reads `task <id>`, how many other tasks are open and the task line. The title is left out below 32 columns.
- **Tasks:** that row shows the active task and how many others are open. Counts follow the active task; a worker of another task that is still running keeps its card, marked with that task's id.
- **Session log and detail:** below the diagram, a log of spawns, audit lines, verdicts and task changes. Click a card for its brief, routing and tools in flight.

On a narrow terminal a one-line row above the prompt stands in for the pane.

## Token figures

The pane has a row at the top with the title and two tabs, **Board** and **Tokens**. Click one, or press its key: `b` for Board, `t` for Tokens. Keys only reach the pane once it holds the keyboard: press ctrl+x then tab, or click in it. `/board tokens` opens the pane on the Tokens tab (and leaves it open if it is already open); it answers in one short line and writes nothing to the transcript or to the model. When the terminal is too narrow to place the pane, the answer says the tab will show once it is wide enough. In the desktop app's widget seat there is no tab row and the Board is always drawn.

A line under the status line on the Board tab still shows this task's tokens: the lead's and the delegated workers', and the share delegated.

The Tokens tab has two scopes, switched with the buttons on its header or the keys `1` (this task) and `2` (every task since the board started). It shows when counting started, how the tokens split between the lead and the delegated workers, bar charts of tokens in and out by model, a table of the workers (at most 12, then one line summing the rest), what each brief and answer carried, the length of Flowestra's own text in the lead's prompt, in characters, and notes. A worker that ran on another tier's model is marked, for example `incl. 1 opus-tier`, or with `*` and a key line when the pane is narrow. Runs whose unit was rejected, and repeated runs of a unit, are marked. Where some counts are partial, values read with a leading `≥`, their bars are dim, and no percentage is shown. The tab fits what it can to the width: below 24 columns it shows labels and values only, with no bars. Tall tabs scroll with the pane.

What is counted: every model request the board saw, with the four numbers the API reports (new input, cache writes, cache reads, output), by the model that answered. "in" adds new input, cache writes and cache reads; cache reads are counted at full size and never weighed. The lead's tokens are split by the task that was active at each request. Counts start when the board starts (session start or /clear) and live in memory only.

What it cannot tell you: how many tokens the same work would have used without Flowestra. There is no run without it to compare with, so the tab shows no comparison and no score. A worker's requests are extra requests; what delegation gives is a smaller lead context, and the tab shows both sides. Requests outside agent turns, such as compaction summaries and the engine's own side requests, may not be counted, and a resumed session starts from zero.

## Where files live

Flowestra keeps its files under Claude Code's config folder: the `CLAUDE_CONFIG_DIR` environment variable when it is set, otherwise `~/.claude`.

| Path | What |
|---|---|
| `<config>/flowestra/journal/` | The work journal |
| `<config>/flowestra/audit/<session id>.log` | One line per delegation that started in that session, one per agent that started ungated (`!ungated`), and one per gate failure (`!gate-error`) |
| `<config>/flowestra/prune.log` | One line per task or audit file deleted from the journal: names and sizes, never content |

The board's answer to opening or switching a task states both paths.

Each task folder also holds state.bak.json, a backup of its state file. The workflow may ask workers to write design drafts under <config>/flowestra/drafts; the mod does not write or delete that folder.

## Things to know

- **Briefs and results are stored in plain text** on your machine (see "What it holds" above). Masking is best effort. Nothing is deleted unless you run `/journal prune` and confirm it yourself.
- **The built-in agent types listed above are unavailable** while the mod is loaded, to the main session and to every agent it starts. A skill that starts agents through the Agent tool is refused unless a unit covers each one; a skill that runs in its own agent is not checked (see "What the gate does not check").
- **The gate governs agent starts, not everything a session does.** It checks the agents Claude Code tells mods about; the exceptions above are shown, not refused, and a fault in the mod lets spawns through unchecked unless "When a worker can't be verified" is set to block. Every such case is on the board and in the audit file.
- **Other mods that start agents of their own** go through the same gate, and are refused unless a unit covers them.
- **The mod is generic.** It contains nothing specific to any project.

## Development

```
claude plugin test <folder>       # runs every *.test.ts
claude plugin validate <folder>   # reads the manifest and type-checks the module
```

The module is `hooks/register.tsx`; everything else under `hooks/` is pure and tested on its own: `policy.ts` (the policy text), `workflow.ts` (the workflow text and the `workflow` setting), `workers.ts` (the three worker types), `models.ts` (the worker model settings and their cascade), `board.ts` (the tool's parser), `state.ts` (the board's reducers and the gate), `journal.ts` (the journal's formats), `log.ts`, `view.tsx` and `flow.client.tsx` (the drawing), `gate.ts` (the gate's health and texts), `redact.ts` (masking and storing less), `prune.ts` (what `/journal` may delete and every text it prints), `journal-fs.ts` (the journal's file layer), `upkeep.ts` (`/journal`), `guard.ts` (the guarded-check helpers), `usage.ts` (the token figures), `report.ts` (the lengths of Flowestra's own prompt text), `nav.tsx` (the tab row), `tokens.tsx` (the Tokens tab).

## License

MIT. See [LICENSE](LICENSE).
