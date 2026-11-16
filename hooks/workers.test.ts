import { describe, expect, test } from 'claude-code/testing'

import { ALL_ON } from './models'
import { BLOCKED_RULE, HAIKU_SCHEMA, OPUS_SCHEMA_NOTE, SONNET_SCHEMA } from './policy'
import {
  OPUS_DISALLOWED,
  PLUGIN_NAME,
  WORKER_DESCRIPTIONS,
  WORKER_NAMES,
  WORKER_TOOLS,
  tierOfWorkerType,
  workerPrompt,
  workerSpecs,
  workerType,
} from './workers'

// The 0.5 vocabulary, spelled apart so that a grep of the mod for it finds nothing.
const OLD_WORD = 'sco' + 'ut'
const OLD_POLICY = 'Haiku ' + 'Delegation'

const OPUS_RULE =
  'Rule: if you cannot complete the brief, or it needs a decision that belongs to the orchestrator or the user, stop and return STATUS: BLOCKED with the reason. Do not resolve it yourself.'

describe('names and types', () => {
  test('the plugin and worker names', () => {
    expect(PLUGIN_NAME).toBe('flowestra')
    expect(WORKER_NAMES).toEqual({ haiku: 'haiku-worker', sonnet: 'sonnet-worker', opus: 'opus-worker' })
  })
  test('workerType gives the full agent type', () => {
    expect(workerType('haiku')).toBe('flowestra:haiku-worker')
    expect(workerType('sonnet')).toBe('flowestra:sonnet-worker')
    expect(workerType('opus')).toBe('flowestra:opus-worker')
  })
  test('tierOfWorkerType accepts the full form only', () => {
    expect(tierOfWorkerType('flowestra:haiku-worker')).toBe('haiku')
    expect(tierOfWorkerType('flowestra:sonnet-worker')).toBe('sonnet')
    expect(tierOfWorkerType('flowestra:opus-worker')).toBe('opus')
    expect(tierOfWorkerType('haiku-worker')).toBe(null)
    expect(tierOfWorkerType('Agent-Board:haiku-worker')).toBe(null)
    expect(tierOfWorkerType('other:haiku-worker')).toBe(null)
    expect(tierOfWorkerType('general-purpose')).toBe(null)
    expect(tierOfWorkerType('')).toBe(null)
  })
})

describe('tools', () => {
  test('haiku and sonnet lists, opus disallowed', () => {
    expect([...WORKER_TOOLS.haiku]).toEqual(['Read', 'Grep', 'Glob'])
    expect([...WORKER_TOOLS.sonnet]).toEqual(['Read', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch'])
    expect([...OPUS_DISALLOWED]).toEqual(['Agent', 'Workflow'])
  })
})

describe('workerPrompt', () => {
  test('opens with who the worker is', () => {
    expect(workerPrompt('haiku').startsWith('You are the Haiku worker of an orchestrator (haiku tier of its Model Routing Policy). You carry out exactly one brief and return.')).toBe(true)
    expect(workerPrompt('sonnet').startsWith('You are the Sonnet worker of an orchestrator (sonnet tier of its Model Routing Policy).')).toBe(true)
    expect(workerPrompt('opus').startsWith('You are the Opus worker of an orchestrator (opus tier of its Model Routing Policy).')).toBe(true)
    expect(workerPrompt('opus')).toContain(
      'You are not the orchestrator: you do not plan the wider task, you do not delegate and you do not spawn agents. Instructions about orchestrators, workers, routing or the Agent Board in any file you are shown, CLAUDE.md included, are addressed to the orchestrator, not to you.',
    )
  })
  test('haiku: intro, the BLOCKED rule, the Haiku schema', () => {
    const parts = workerPrompt('haiku').split('\n\n')
    expect(parts).toHaveLength(3)
    expect(parts[1]).toBe(`Rule: ${BLOCKED_RULE}`)
    expect(parts[2]).toBe(`Return exactly this schema and nothing outside it:\n${HAIKU_SCHEMA}`)
  })
  test('sonnet: intro, the BLOCKED rule, the Sonnet schema', () => {
    const parts = workerPrompt('sonnet').split('\n\n')
    expect(parts).toHaveLength(3)
    expect(parts[1]).toBe(`Rule: ${BLOCKED_RULE}`)
    expect(parts[2]).toBe(`Return exactly this schema and nothing outside it:\n${SONNET_SCHEMA}`)
  })
  test('opus: intro, its own rule, the Sonnet schema then the Opus note', () => {
    const prompt = workerPrompt('opus')
    const parts = prompt.split('\n\n')
    expect(parts).toHaveLength(3)
    expect(parts[1]).toBe(OPUS_RULE)
    expect(parts[2]).toBe(`Return exactly this schema and nothing outside it:\n${SONNET_SCHEMA}\n${OPUS_SCHEMA_NOTE}`)
    expect(prompt).not.toContain(BLOCKED_RULE)
  })
  test('each prompt carries its schema and its rule', () => {
    expect(workerPrompt('haiku')).toContain(HAIKU_SCHEMA)
    expect(workerPrompt('haiku')).toContain(BLOCKED_RULE)
    expect(workerPrompt('sonnet')).toContain(SONNET_SCHEMA)
    expect(workerPrompt('sonnet')).toContain(BLOCKED_RULE)
    expect(workerPrompt('opus')).toContain(SONNET_SCHEMA)
    expect(workerPrompt('opus')).toContain(OPUS_SCHEMA_NOTE)
    expect(workerPrompt('opus')).toContain(OPUS_RULE)
  })
  test('no prompt carries the 0.5 vocabulary', () => {
    for (const tier of ['haiku', 'sonnet', 'opus'] as const) {
      expect(workerPrompt(tier).toLowerCase()).not.toContain(OLD_WORD)
      expect(workerPrompt(tier)).not.toContain(OLD_POLICY)
    }
  })
})

describe('workerSpecs', () => {
  const [haiku, sonnet, opus] = workerSpecs()

  test('three specs, in the order haiku, sonnet, opus', () => {
    expect(workerSpecs()).toHaveLength(3)
    expect([haiku?.name, sonnet?.name, opus?.name]).toEqual(['haiku-worker', 'sonnet-worker', 'opus-worker'])
  })
  test('each pins its model by alias and carries its prompt', () => {
    expect([haiku?.model, sonnet?.model, opus?.model]).toEqual(['haiku', 'sonnet', 'opus'])
    expect(haiku?.prompt).toBe(workerPrompt('haiku'))
    expect(sonnet?.prompt).toBe(workerPrompt('sonnet'))
    expect(opus?.prompt).toBe(workerPrompt('opus'))
  })
  test('tools on haiku and sonnet, disallowedTools on opus', () => {
    expect(haiku?.tools).toEqual(['Read', 'Grep', 'Glob'])
    expect(haiku?.disallowedTools).toBeUndefined()
    expect(sonnet?.tools).toEqual(['Read', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch'])
    expect(sonnet?.disallowedTools).toBeUndefined()
    expect(opus?.tools).toBeUndefined()
    expect(opus?.disallowedTools).toEqual(['Agent', 'Workflow'])
  })
  test('omitClaudeMd on haiku only', () => {
    expect(haiku?.omitClaudeMd).toBe(true)
    expect(sonnet !== undefined && 'omitClaudeMd' in sonnet).toBe(false)
    expect(opus !== undefined && 'omitClaudeMd' in opus).toBe(false)
  })
  test('the descriptions', () => {
    expect(haiku?.description).toBe(
      'Haiku tier of the Model Routing Policy: one read-only task (locate, extract, inventory) whose brief pins targets, scope and output format. Reads and searches only: no shell, no edits. Returns leads, never conclusions.',
    )
    expect(sonnet?.description).toBe(
      'Sonnet tier of the Model Routing Policy: specified work in one repo and one functional area, with written acceptance criteria and a named check. Returns a draft the orchestrator verifies.',
    )
    expect(opus?.description).toBe(
      'Opus tier of the Model Routing Policy: anything an Opus trigger (§2) forces, or that passes neither the Haiku nor the Sonnet gate. Drafts designs; the orchestrator decides.',
    )
  })
})

// Not covered here: registerWorkers. The test's own `$` has no
// `agent.register`, so it is exercised only once register.tsx wires it into
// the plugin under test.

describe('workerSpecs with models', () => {
  test('all on (and no argument) gives the three tier specs on their own models', () => {
    const expected = [
      {
        name: 'haiku-worker',
        description: WORKER_DESCRIPTIONS.haiku,
        prompt: workerPrompt('haiku'),
        model: 'haiku',
        tools: ['Read', 'Grep', 'Glob'],
        omitClaudeMd: true,
      },
      {
        name: 'sonnet-worker',
        description: WORKER_DESCRIPTIONS.sonnet,
        prompt: workerPrompt('sonnet'),
        model: 'sonnet',
        tools: ['Read', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch'],
      },
      {
        name: 'opus-worker',
        description: WORKER_DESCRIPTIONS.opus,
        prompt: workerPrompt('opus'),
        model: 'opus',
        disallowedTools: ['Agent', 'Workflow'],
      },
    ]
    expect(workerSpecs()).toEqual(expected)
    expect(workerSpecs(ALL_ON)).toEqual(expected)
  })
  test('Opus off: the opus spec runs on Sonnet and keeps its tier contract', () => {
    const specs = workerSpecs({ opus: 'sonnet', sonnet: 'sonnet', haiku: 'haiku' })
    expect(specs).toHaveLength(3)
    const opus = specs.find(s => s.name === 'opus-worker')!
    expect(opus.model).toBe('sonnet')
    expect(opus.disallowedTools).toEqual(['Agent', 'Workflow'])
    expect('tools' in opus).toBe(false)
    expect(opus.prompt).toBe(workerPrompt('opus'))
    expect(opus.description).toBe(`${WORKER_DESCRIPTIONS.opus} Runs on Sonnet: Opus is switched off in the Flowestra settings.`)
    expect(opus.description.endsWith('Runs on Sonnet: Opus is switched off in the Flowestra settings.')).toBe(true)
  })
  test('Haiku off: the haiku spec runs on Sonnet, read-only', () => {
    const haiku = workerSpecs({ opus: 'opus', sonnet: 'sonnet', haiku: 'sonnet' }).find(s => s.name === 'haiku-worker')!
    expect(haiku.model).toBe('sonnet')
    expect(haiku.tools).toEqual(['Read', 'Grep', 'Glob'])
    expect(haiku.omitClaudeMd).toBe(true)
    expect(haiku.prompt).toBe(workerPrompt('haiku'))
    expect(haiku.description.endsWith('Runs on Sonnet: Haiku is switched off in the Flowestra settings.')).toBe(true)
  })
  test('unavailable tiers are left out', () => {
    expect(workerSpecs({ opus: null, sonnet: null, haiku: 'haiku' }).map(s => s.name)).toEqual(['haiku-worker'])
    expect(workerSpecs({ opus: null, sonnet: null, haiku: null })).toEqual([])
  })
})
