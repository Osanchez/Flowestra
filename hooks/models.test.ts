import { describe, expect, test } from 'claude-code/testing'

import type { WorkerModels } from '../types'
import {
  ALL_ON,
  CASCADE,
  MODEL_SETTINGS,
  isSubstituted,
  modelSwitches,
  modelsFromOptions,
  modelsNote,
  offList,
  tierTitle,
  workerModels,
} from './models'

describe('the switches', () => {
  test('settings names', () => {
    expect(MODEL_SETTINGS).toEqual({ opus: 'opusWorkers', sonnet: 'sonnetWorkers', haiku: 'haikuWorkers' })
  })

  test('missing, empty and non-false values count as on', () => {
    const on = { opus: true, sonnet: true, haiku: true }
    expect(modelSwitches(undefined as never)).toEqual(on)
    expect(modelSwitches({})).toEqual(on)
    expect(modelSwitches({ opusWorkers: 'false' })).toEqual(on)
    expect(modelSwitches({ opusWorkers: 0 })).toEqual(on)
    expect(modelSwitches(null as never)).toEqual(on)
    expect(modelSwitches({ opusWorkers: true, sonnetWorkers: true, haikuWorkers: true })).toEqual(on)
  })

  test('only false is off', () => {
    expect(modelSwitches({ opusWorkers: false })).toEqual({ opus: false, sonnet: true, haiku: true })
    expect(modelSwitches({ sonnetWorkers: false })).toEqual({ opus: true, sonnet: false, haiku: true })
    expect(modelSwitches({ haikuWorkers: false })).toEqual({ opus: true, sonnet: true, haiku: false })
  })
})

describe('the cascade', () => {
  test('lists', () => {
    expect(CASCADE.opus).toEqual(['opus', 'sonnet'])
    expect(CASCADE.sonnet).toEqual(['sonnet', 'opus'])
    expect(CASCADE.haiku).toEqual(['haiku', 'sonnet', 'opus'])
  })

  test('all on is ALL_ON', () => {
    expect(ALL_ON).toEqual({ opus: 'opus', sonnet: 'sonnet', haiku: 'haiku' })
    expect(modelsFromOptions({})).toEqual(ALL_ON)
  })

  const rows: [string, Record<string, boolean>, WorkerModels][] = [
    ['1 1 1', {}, { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku' }],
    ['0 1 1', { opusWorkers: false }, { opus: 'sonnet', sonnet: 'sonnet', haiku: 'haiku' }],
    ['1 0 1', { sonnetWorkers: false }, { opus: 'opus', sonnet: 'opus', haiku: 'haiku' }],
    ['1 1 0', { haikuWorkers: false }, { opus: 'opus', sonnet: 'sonnet', haiku: 'sonnet' }],
    ['0 1 0', { opusWorkers: false, haikuWorkers: false }, { opus: 'sonnet', sonnet: 'sonnet', haiku: 'sonnet' }],
    ['1 0 0', { sonnetWorkers: false, haikuWorkers: false }, { opus: 'opus', sonnet: 'opus', haiku: 'opus' }],
    ['0 0 1', { opusWorkers: false, sonnetWorkers: false }, { opus: null, sonnet: null, haiku: 'haiku' }],
    ['0 0 0', { opusWorkers: false, sonnetWorkers: false, haikuWorkers: false }, { opus: null, sonnet: null, haiku: null }],
  ]
  for (const [name, options, expected] of rows) {
    test('row ' + name, () => {
      expect(modelsFromOptions(options)).toEqual(expected)
    })
  }

  test('workerModels reads the switches directly', () => {
    expect(workerModels({ opus: false, sonnet: true, haiku: false })).toEqual({ opus: 'sonnet', sonnet: 'sonnet', haiku: 'sonnet' })
  })

  test('isSubstituted', () => {
    expect(isSubstituted(ALL_ON)).toBe(false)
    expect(isSubstituted({ opus: 'sonnet', sonnet: 'sonnet', haiku: 'haiku' })).toBe(true)
    expect(isSubstituted({ opus: null, sonnet: null, haiku: 'haiku' })).toBe(true)
  })
})

describe('names', () => {
  test('tierTitle', () => {
    expect(tierTitle('opus')).toBe('Opus')
    expect(tierTitle('sonnet')).toBe('Sonnet')
    expect(tierTitle('haiku')).toBe('Haiku')
  })

  test('offList joins A, A and B, A, B and C', () => {
    expect(offList(ALL_ON)).toBe('')
    expect(offList(modelsFromOptions({ opusWorkers: false }))).toBe('Opus')
    expect(offList(modelsFromOptions({ sonnetWorkers: false, haikuWorkers: false }))).toBe('Sonnet and Haiku')
    expect(offList(modelsFromOptions({ opusWorkers: false, sonnetWorkers: false, haikuWorkers: false }))).toBe('Opus, Sonnet and Haiku')
  })
})

describe('the note', () => {
  test('empty when every tier runs on itself', () => {
    expect(modelsNote(ALL_ON)).toBe('')
  })

  test('opus off', () => {
    expect(modelsNote(modelsFromOptions({ opusWorkers: false }))).toBe(
      'Worker models: Opus is switched off in the Flowestra settings, so opus-tier work runs on Sonnet. Routing is unchanged: run §1, declare the tier it selects and spawn that tier\'s worker with no model parameter; only the model that runs a tier changes, and the board shows both. Escalation (§8) still goes by tier. Where the tier above runs on the same model, escalating changes the brief, tools and return schema but not the model: when a task fails there too, resolve it yourself or ask the user instead of re-routing it again.',
    )
  })

  test('sonnet off', () => {
    expect(modelsNote(modelsFromOptions({ sonnetWorkers: false }))).toBe(
      'Worker models: Sonnet is switched off in the Flowestra settings, so sonnet-tier work runs on Opus. Routing is unchanged: run §1, declare the tier it selects and spawn that tier\'s worker with no model parameter; only the model that runs a tier changes, and the board shows both. Escalation (§8) still goes by tier. Where the tier above runs on the same model, escalating changes the brief, tools and return schema but not the model: when a task fails there too, resolve it yourself or ask the user instead of re-routing it again.',
    )
  })

  test('haiku off', () => {
    expect(modelsNote(modelsFromOptions({ haikuWorkers: false }))).toBe(
      'Worker models: Haiku is switched off in the Flowestra settings, so haiku-tier work runs on Sonnet. Routing is unchanged: run §1, declare the tier it selects and spawn that tier\'s worker with no model parameter; only the model that runs a tier changes, and the board shows both. Escalation (§8) still goes by tier. Where the tier above runs on the same model, escalating changes the brief, tools and return schema but not the model: when a task fails there too, resolve it yourself or ask the user instead of re-routing it again.',
    )
  })

  test('opus and haiku off', () => {
    expect(modelsNote(modelsFromOptions({ opusWorkers: false, haikuWorkers: false }))).toBe(
      'Worker models: Opus and Haiku are switched off in the Flowestra settings, so opus-tier work runs on Sonnet, and haiku-tier work runs on Sonnet. Routing is unchanged: run §1, declare the tier it selects and spawn that tier\'s worker with no model parameter; only the model that runs a tier changes, and the board shows both. Escalation (§8) still goes by tier. Where the tier above runs on the same model, escalating changes the brief, tools and return schema but not the model: when a task fails there too, resolve it yourself or ask the user instead of re-routing it again.',
    )
  })

  test('sonnet and haiku off', () => {
    expect(modelsNote(modelsFromOptions({ sonnetWorkers: false, haikuWorkers: false }))).toBe(
      'Worker models: Sonnet and Haiku are switched off in the Flowestra settings, so sonnet-tier work runs on Opus, and haiku-tier work runs on Opus. Routing is unchanged: run §1, declare the tier it selects and spawn that tier\'s worker with no model parameter; only the model that runs a tier changes, and the board shows both. Escalation (§8) still goes by tier. Where the tier above runs on the same model, escalating changes the brief, tools and return schema but not the model: when a task fails there too, resolve it yourself or ask the user instead of re-routing it again.',
    )
  })

  test('opus and sonnet off', () => {
    expect(modelsNote(modelsFromOptions({ opusWorkers: false, sonnetWorkers: false }))).toBe(
      'Worker models: Opus and Sonnet are switched off in the Flowestra settings. No model is on for opus-tier or sonnet-tier work: a unit at those tiers is refused at spawn, so do that work yourself or ask the user to turn a worker model back on. Routing is unchanged: run §1, declare the tier it selects and spawn that tier\'s worker with no model parameter; only the model that runs a tier changes, and the board shows both.',
    )
  })

  test('all off', () => {
    expect(modelsNote(modelsFromOptions({ opusWorkers: false, sonnetWorkers: false, haikuWorkers: false }))).toBe(
      'Worker models: Opus, Sonnet and Haiku are switched off in the Flowestra settings. No model is on for opus-tier, sonnet-tier or haiku-tier work: a unit at those tiers is refused at spawn, so do that work yourself or ask the user to turn a worker model back on. Routing is unchanged: run §1, declare the tier it selects and spawn that tier\'s worker with no model parameter; only the model that runs a tier changes, and the board shows both.',
    )
  })

  test('never mentions cost or price', () => {
    const all: Record<string, boolean>[] = [
      { opusWorkers: false },
      { sonnetWorkers: false },
      { haikuWorkers: false },
      { opusWorkers: false, haikuWorkers: false },
      { sonnetWorkers: false, haikuWorkers: false },
      { opusWorkers: false, sonnetWorkers: false },
      { opusWorkers: false, sonnetWorkers: false, haikuWorkers: false },
    ]
    for (const options of all) {
      expect(modelsNote(modelsFromOptions(options))).not.toMatch(/cost|price|cheap|expens|\$/i)
    }
  })
})
