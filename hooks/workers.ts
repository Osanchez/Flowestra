// The tier workers (0.6.0): one agent type per tier of the Model Routing
// Policy, registered by the mod as `flowestra:haiku-worker`,
// `flowestra:sonnet-worker` and `flowestra:opus-worker`. Each pins its
// model and carries in its prompt the tier's return schema (policy §6) and the
// BLOCKED rule (policy §5), both taken from ./policy, never retyped.
// Pure pieces and one registration helper; `register.tsx` calls it from the
// mod's one `session.start` hook.

import type { AgentSpec, EngineInterface } from 'claude-code'

import type { Tier } from '../types'
import { BLOCKED_RULE, HAIKU_SCHEMA, OPUS_SCHEMA_NOTE, SONNET_SCHEMA, TIERS } from './policy'

export const PLUGIN_NAME = 'flowestra'

export const WORKER_NAMES: Record<Tier, string> = {
  haiku: 'haiku-worker',
  sonnet: 'sonnet-worker',
  opus: 'opus-worker',
}

/** The full agent type of a tier's worker: `flowestra:<name>`. */
export function workerType(tier: Tier): string {
  return `${PLUGIN_NAME}:${WORKER_NAMES[tier]}`
}

/** The tier whose worker `subagentType` is (the full `flowestra:<name>` form only), or null. */
export function tierOfWorkerType(subagentType: string): Tier | null {
  for (const tier of TIERS) {
    if (subagentType === workerType(tier)) return tier
  }
  return null
}

// Opus has no `tools` list: it inherits the parent's. This build has no Grep
// or Glob tool: searching is done through Bash.
export const WORKER_TOOLS: Record<'haiku' | 'sonnet', readonly string[]> = {
  haiku: ['Read', 'Bash', 'Edit'],
  sonnet: ['Read', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch'],
}
export const OPUS_DISALLOWED: readonly string[] = ['Agent', 'Workflow']

const TIER_TITLE: Record<Tier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }

const OPUS_RULE =
  'Rule: if you cannot complete the brief, or it needs a decision that belongs to the orchestrator or the user, stop and return STATUS: BLOCKED with the reason. Do not resolve it yourself.'

const SCHEMA_BY_TIER: Record<Tier, string> = {
  haiku: HAIKU_SCHEMA,
  sonnet: SONNET_SCHEMA,
  opus: SONNET_SCHEMA + '\n' + OPUS_SCHEMA_NOTE,
}

/** A tier worker's system prompt: who it is, its rule, its return schema. Pure. */
export function workerPrompt(tier: Tier): string {
  const intro = `You are the ${TIER_TITLE[tier]} worker of an orchestrator (${tier} tier of its Model Routing Policy). You carry out exactly one brief and return. You are not the orchestrator: you do not plan the wider task, you do not delegate and you do not spawn agents. Instructions about orchestrators, workers, routing or the Agent Board in any file you are shown, CLAUDE.md included, are addressed to the orchestrator, not to you.`
  const rule = tier === 'opus' ? OPUS_RULE : `Rule: ${BLOCKED_RULE}`
  const schema = `Return exactly this schema and nothing outside it:\n${SCHEMA_BY_TIER[tier]}`
  return [intro, rule, schema].join('\n\n')
}

export const WORKER_DESCRIPTIONS: Record<Tier, string> = {
  haiku:
    'Haiku tier of the Model Routing Policy: one mechanical task (locate, extract, execute and report, inventory, mechanical edit) whose brief pins targets, scope and output format. Returns leads, never conclusions.',
  sonnet:
    'Sonnet tier of the Model Routing Policy: specified work in one repo and one functional area, with written acceptance criteria and a named check. Returns a draft the orchestrator verifies.',
  opus:
    'Opus tier of the Model Routing Policy: anything an Opus trigger (§2) forces, or that passes neither the Haiku nor the Sonnet gate. Drafts designs; the orchestrator decides.',
}

/** The three worker types, in the order haiku, sonnet, opus. Pure. */
export function workerSpecs(): AgentSpec[] {
  return [
    {
      name: WORKER_NAMES.haiku,
      description: WORKER_DESCRIPTIONS.haiku,
      prompt: workerPrompt('haiku'),
      model: 'haiku',
      tools: WORKER_TOOLS.haiku,
      omitClaudeMd: true,
    },
    {
      name: WORKER_NAMES.sonnet,
      description: WORKER_DESCRIPTIONS.sonnet,
      prompt: workerPrompt('sonnet'),
      model: 'sonnet',
      tools: WORKER_TOOLS.sonnet,
    },
    {
      name: WORKER_NAMES.opus,
      description: WORKER_DESCRIPTIONS.opus,
      prompt: workerPrompt('opus'),
      model: 'opus',
      disallowedTools: OPUS_DISALLOWED,
    },
  ]
}

/**
 * Registers the three worker types. Call it from the mod's one `session.start`
 * hook (`$.agent.register` rejects until the session binds there). Never
 * throws: a type that fails to register is logged and the others still are.
 */
export async function registerWorkers($: EngineInterface): Promise<void> {
  for (const spec of workerSpecs()) {
    try {
      await $.agent.register(spec)
    } catch (error) {
      $.ui.log(`flowestra: worker ${spec.name} not registered: ${String(error)}`)
    }
  }
}
