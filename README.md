<p align="center"><img src=".claude-plugin/icon.png" alt="Flowestra logo" width="150"></p>

# Flowestra

**Run Claude Code as an orchestrator with a team of Opus, Sonnet and Haiku workers, and watch the whole thing live.**

Flowestra is a Claude Code mod. It gives the main session a routing policy for choosing which model does each piece of work, and a gate that enforces that policy. It adds a live board showing every worker, tasks that span several repositories at once, and a journal on disk of everything that was delegated.

![The Agent Board during a run: two Haiku workers, two Sonnet workers and one Opus worker](docs/demo.gif)

*A staged demo run: the workers here only pause for a few seconds, so the recording shows the board and not real work.*

## Why use it

Results from the 0.17.0 benchmark (Opus 5.5 lead, 3 runs per cell, medians against plain Claude Code):

- **Opus spend fell on every task.** Opus input fell 17% to 60%, and Opus cost fell 18% to 44%.
- **Cheaper where it counts.** The larger task cost 16% less and the three-repository task 5% less, at list prices. The small task was about even.
- **Parallel work finishes sooner.** The three-repository task ran 29% faster.
- **Same quality.** Every run passed its tests (18/18), and the multi-repo task passed 40/40 on a hidden acceptance suite.
- **Every delegation is accounted for.** It is routed by a written policy, enforced by a gate, and recorded with its brief, result and verdict.

[Full benchmark: method, every run and every caveat](docs/BENCHMARK.md)

## What you get

- **A routing policy with a gate.** Opus designs and reviews, Sonnet writes, Haiku looks things up. The gate refuses workers that break the policy.
- **Parallel waves.** Units that write different files run at the same time, including across several repositories, with an Opus-level design and review for shared contracts.
- **A live Agent Board.** Every worker shows its model, current tool and real token counts. The Tokens tab splits the lead from the workers.
- **An approval gate.** In the `full` workflow nothing is built before you approve a written design, and approved designs are kept in `.flowestra/decisions.md`.
- **A work journal.** Every brief, result and verdict is written to disk as plain files, with small indexes.
- **Model switches in /config.** Turn a tier's model off and its work cascades to the next model that is on.

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

The pane opens by itself when workers start. `/board` opens or closes it. The desktop app and the `/journal` commands are covered in the [guide](docs/GUIDE.md#install-in-detail).

## How it works

The main session acts as the orchestrator. It frames the task, writes the spec and routes each unit of work to a worker tier by a fixed procedure. The gate checks every worker before it starts, and the journal records what happened.

1. **Frame** the task and open it on the board.
2. **Design** the change; an Opus worker does this when it needs code the orchestrator has not read.
3. **You approve** the written design (`full` workflow).
4. **Workers build in waves**, with Sonnet writing and independent units in parallel.
5. **Review** by the orchestrator, then a verdict on every result.

The routing policy, the gate and the workflow are described in full in the [guide](docs/GUIDE.md#how-it-works).

## Settings

Open `/config`. A change applies from the next session.

| Setting | Values | Default |
|---|---|---|
| Workflow | `full`, `light`, `off` | `full` |
| Opus workers | on, off | on |
| Sonnet workers | on, off | on |
| Haiku workers | on, off | on |
| When a worker can't be verified | `start anyway`, `block` | `start anyway` |
| Mask secrets in the journal | on, off | on |
| Journal content | `full`, `capped`, `index` | `full` |

Details are in [Setting it up in your repository](docs/GUIDE.md#setting-it-up-in-your-repository).

## Limitations

- **Overhead on short tasks.** About 9k tokens of instructions on every lead request (mostly cached) and a cold start per worker; on a short task that about cancels the saving.
- **Unattended runs can stop for you.** `full` waits for your approval of the design, and a writing unit that fails its one Sonnet retry stops and asks.
- **Enforcement has edges.** The gate checks agent starts; the lead's own edits follow "Sonnet writes" by instruction only, and workflow agents and skills that run their own agent are marked, not refused.

Measured on tasks of 2–10 minutes; see the [benchmark](docs/BENCHMARK.md) for every caveat. Requires a Claude Code build that supports mods (tested on 2.1.325).

## Learn more

- [Guide](docs/GUIDE.md): when to use it, how it works in full, setting it up in a repository, the `AgentBoard` tool, the board, token figures, where files live, things to know, development and the full limitations.
- [Benchmark](docs/BENCHMARK.md): method, every run and every caveat.

## License

MIT. See [LICENSE](LICENSE).
