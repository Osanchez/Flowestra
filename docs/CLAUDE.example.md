# How work is done: orchestrator and workers

This applies to every project. A project's own CLAUDE.md adds what is specific to it, such as shared resources that shape the concurrency plan. A project file may send a kind of work to a higher tier than the routing policy would. It never sends work to a lower one.

**Roles**

- **Orchestrator: the main session, on the highest-tier model selected for it.** Frames the problem, routes every delegation, reviews designs and results, and does the final review of every change. It never delegates the design decision or the final review.
- **Workers: Opus, Sonnet and Haiku subagents.** Which tier a delegation gets is decided by the Model Routing Policy that the `flowestra` mod adds to the orchestrator's instructions. That policy is the only source of routing rules, and this file states none. When the mod is not loaded, every delegation goes to Opus.

**Workflow (every task)**

1. **Frame.** The orchestrator writes the problem, the constraints, the non-goals and the relevant earlier decisions into a brief.
2. **Design.** An Opus worker reads the code and drafts the design as a spec file: two or three options, their tradeoffs, a recommendation, and a path:line citation for every claim about the existing code. The draft is written outside the repository, in the session's scratch folder. The spec covers:
   - Goal and scope (what is in, what is explicitly out)
   - Architecture and data flow
   - Dependencies (libraries, services, files, and the order between work units)
   - Constraints (performance, compatibility, security, platform limits)
   - Considerations (edge cases, failure modes, open risks)
   - Work breakdown: discrete units, each with inputs, outputs, files touched, and acceptance criteria
   - A concurrency plan: which units run in parallel, which must wait, and why
3. **Design review.** The orchestrator challenges the recommendation and spot-checks the citations the choice depends on. When it has concerns it sends the draft back to be re-evaluated and updated. It approves or returns the design; it does not rewrite it.
4. **Approval gate.** The orchestrator presents the spec and its own recommendation to the owner. No implementation worker is spawned until the owner approves it.
5. **Spec to disk.** The approved design is added as a dated entry to `decisions.md` at the project root, and implementation briefs point at that entry. No implementation starts before its approved spec is on disk.
6. **Execution.** Workers are spawned in parallel waves. Units with no shared files or dependencies run at the same time. Dependent units wait for their prerequisites to finish.
7. **Integration and test.** The orchestrator waits for **all** workers in a wave to complete before integrating or running tests. Nothing is tested against partial work.
8. **Review.** The orchestrator reviews the result against the spec's acceptance criteria and sends fixes back to workers as needed.

**Design exceptions**

- **Small designs.** When the decision needs little code context, the orchestrator makes it itself, without a design worker. It still presents it at the approval gate and records it as a short entry in `decisions.md`.
- **Cross-project designs.** The orchestrator owns these directly, with one Opus worker per repository gathering facts. No single worker sees all sides.
- **The designer is never the only reviewer.** The Opus worker that drafted a design is never the sole reviewer of its implementation. The orchestrator reviews every result itself, and a delegated review goes to a fresh worker, never to a continuation of the designer.

**Spec gaps found while routing**

- When a unit cannot go to a Sonnet worker only because the spec leaves decisions open, the unit goes back to the Opus designer, who closes those gaps in the spec. It does not go to an Opus worker to decide and build in one pass: decisions are made in the spec, reviewed, and written down before anything is built from them.
- **The orchestrator approves the refinement itself** when it stays inside the design the owner already approved: internal structure, ordering, caching, helper boundaries, and anything else the owner would never see from outside.
- **It goes to the owner** when it changes something the owner approved or would notice: scope, behaviour, a file format, a refusal, a cost, or anything irreversible.
- The refined spec is written to `decisions.md`, and the unit is then routed again.

**Worker rules**

- Each worker gets a self-contained brief. Workers cannot see the orchestrator's context, so briefs must not assume it. What a brief states, and what each tier returns, are set by the Model Routing Policy.

**Keeping the Agent Board current (the `flowestra` mod, when it is loaded)**

- The orchestrator calls the `AgentBoard` tool when the task or the phase changes and before each wave: `task` (one line), `phase` (analysis, design, approval, executing, testing, review, done), `wave`, and the full `units` list (id, label of 1 to 4 words, wave, dependsOn).
- A unit a worker carries out is declared, with the fields the mod's instructions require, before its worker is spawned. A unit the orchestrator carries out itself takes `declared` instead.
- Every Agent call gets a `description` of 2 to 4 words starting with a verb (it becomes the worker's label) and a `name` equal to the id of the work unit it carries out. Where the Agent tool takes no `name`, the description equals the unit's label instead.
- Token counts are never written by hand: the board measures them.

**Shared resources**

- Each project's CLAUDE.md lists the resources its work units share (one working tree, a single server, a single editor or device). Read it before writing a concurrency plan. Where it lists none, units that write different files can run in parallel, and anything that runs against shared state goes one at a time, after the whole wave has finished.
