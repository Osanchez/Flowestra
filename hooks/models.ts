// Which model runs each tier's work, from the three worker-model switches (0.10.0), and
// the note about it that joins the routing policy section. Pure: type-only imports, no
// `$`, no side effects.

import type { PluginOptions } from 'claude-code'
import type { Tier, WorkerModels } from '../types'

export const MODEL_SETTINGS: Record<Tier, string> = { opus: 'opusWorkers', sonnet: 'sonnetWorkers', haiku: 'haikuWorkers' }

// The first model in a tier's list whose switch is on runs the tier; none on: unavailable.
export const CASCADE: Record<Tier, readonly Tier[]> = {
  opus: ['opus', 'sonnet'],
  sonnet: ['sonnet', 'opus'],
  haiku: ['haiku', 'sonnet', 'opus'],
}

export const ALL_ON: WorkerModels = { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku' }

const TIERS: readonly Tier[] = ['opus', 'sonnet', 'haiku']

// A switch is on unless its setting is exactly `false`.
export const modelSwitches = (options: PluginOptions): Record<Tier, boolean> => {
  const on = (t: Tier): boolean => (options as Record<string, unknown> | null | undefined)?.[MODEL_SETTINGS[t]] !== false
  return { opus: on('opus'), sonnet: on('sonnet'), haiku: on('haiku') }
}

export const workerModels = (on: Record<Tier, boolean>): WorkerModels => {
  const pick = (t: Tier): Tier | null => CASCADE[t].find(m => on[m]) ?? null
  return { opus: pick('opus'), sonnet: pick('sonnet'), haiku: pick('haiku') }
}

export const modelsFromOptions = (options: PluginOptions): WorkerModels => workerModels(modelSwitches(options))

export const isSubstituted = (models: WorkerModels): boolean => TIERS.some(t => models[t] !== t)

export const tierTitle = (t: Tier): string => (t === 'opus' ? 'Opus' : t === 'sonnet' ? 'Sonnet' : 'Haiku')

// `A`, `A and B`, `A, B and C` (word: 'and'); `A`, `A or B`, `A, B or C` (word: 'or').
const joinWords = (items: string[], word: string): string =>
  items.length <= 1 ? items.join('') : items.slice(0, -1).join(', ') + ' ' + word + ' ' + items[items.length - 1]

// The capitalised names of the tiers whose switch is off (their model is not themselves).
export const offList = (models: WorkerModels): string =>
  joinWords(TIERS.filter(t => models[t] !== t).map(tierTitle), 'and')

const ROUTING_UNCHANGED =
  "Routing is unchanged: run §1, declare the tier it selects and spawn that tier's worker with no model parameter; only the model that runs a tier changes, and the board shows both."
const ESCALATION =
  'Escalation (§8) still goes by tier. Where the tier above runs on the same model, escalating changes the brief, tools and return schema but not the model: when a task fails there too, resolve it yourself or ask the user instead of re-routing it again.'

export const modelsNote = (models: WorkerModels): string => {
  if (!isSubstituted(models)) return ''
  const off = TIERS.filter(t => models[t] !== t)
  const subs = TIERS.filter(t => models[t] !== null && models[t] !== t).map(t => `${t}-tier work runs on ${tierTitle(models[t]!)}`)
  const unavailable = TIERS.filter(t => models[t] === null)
  const parts = [
    `Worker models: ${offList(models)} ${off.length === 1 ? 'is' : 'are'} switched off in the Flowestra settings${subs.length > 0 ? ', so ' + subs.join(', and ') : ''}.`,
  ]
  if (unavailable.length > 0) {
    parts.push(
      `No model is on for ${joinWords(unavailable.map(t => `${t}-tier`), 'or')} work: a unit at ${unavailable.length === 1 ? 'that tier' : 'those tiers'} is refused at spawn, so do that work yourself or ask the user to turn a worker model back on.`,
    )
  }
  if (models.sonnet !== null && models.sonnet !== 'sonnet') {
    const m = tierTitle(models.sonnet)
    parts.push(
      `Implementation that the Sonnet tier would carry is done by you as declared units, not by an ${m}-run worker; other Sonnet-tier work (reviews, summaries, exploration) still runs on ${m}.`,
    )
  }
  parts.push(ROUTING_UNCHANGED)
  if ((models.haiku !== null && models.haiku === models.sonnet) || (models.sonnet !== null && models.sonnet === models.opus)) {
    parts.push(ESCALATION)
  }
  return parts.join(' ')
}
