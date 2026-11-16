// Agent Board: the visual layer's state. Pure reducers and selectors: no `$`,
// no clock (every time comes in as an argument), no drawing.

import type { AgentDetail, BoardTab, Detail, TokenScope, ToolRun, Ui } from '../types'
import { MAIN_ID } from './state'

// Change a tag when its value's fields change (see BOARD_SHAPE in state.ts).
// detail-2: AgentDetail lost `pulse`. ui-2: Ui is `{ selected }`.
// ui-3: Ui gained tab and scope.
export const DETAIL_SHAPE = 'detail-2'
export const UI_SHAPE = 'ui-3'

export const BRIEF_MAX = 600 // characters of the Agent prompt kept for the detail strip
export const TOOLS_MAX = 8 // tool calls in flight kept per agent; the oldest go first

export function emptyDetail(): Detail {
  return { agents: {} }
}

export function emptyUi(): Ui {
  return { selected: null, tab: 'board', scope: 'task' }
}

export function emptyAgentDetail(): AgentDetail {
  return { brief: null, briefCut: false, tools: [] }
}

function putAgent(detail: Detail, id: string, entry: AgentDetail): Detail {
  return { ...detail, agents: { ...detail.agents, [id]: entry } }
}

function isWorker(id: string): boolean {
  return id !== MAIN_ID
}

/** A worker was spawned: keep the start of its brief. Replaces any earlier entry. */
export function detailSpawn(detail: Detail, agentId: string, prompt: string | null, _now: number): Detail {
  const text = (prompt ?? '').trim()
  const entry: AgentDetail = {
    brief: text.length > 0 ? text.slice(0, BRIEF_MAX) : null,
    briefCut: text.length > BRIEF_MAX,
    tools: [],
  }
  return putAgent(detail, agentId, entry)
}

/**
 * A tool call started in an agent's loop (`agentId` undefined: the orchestrator).
 * `target` (a SendMessage's recipient) is accepted for callers and ignored.
 */
export function detailToolStart(
  detail: Detail,
  agentId: string | undefined,
  callId: string,
  tool: string,
  now: number,
  _target?: string | null,
): Detail {
  const id = agentId ?? MAIN_ID
  const prev = detail.agents[id] ?? emptyAgentDetail()
  const run: ToolRun = { id: callId, tool, startedAt: now }
  const tools = [...prev.tools.filter(t => t.id !== callId), run]
  const kept = tools.length > TOOLS_MAX ? tools.slice(tools.length - TOOLS_MAX) : tools
  return putAgent(detail, id, { ...prev, tools: kept })
}

/** A tool call ended: drop it from the agent's runs. Unknown agent or call: unchanged. */
export function detailToolEnd(detail: Detail, agentId: string | undefined, callId: string, _now: number): Detail {
  const id = agentId ?? MAIN_ID
  const prev = detail.agents[id]
  if (prev === undefined || !prev.tools.some(t => t.id === callId)) return detail
  return putAgent(detail, id, { ...prev, tools: prev.tools.filter(t => t.id !== callId) })
}

/** An agent finished: no runs left. A worker with no entry gets one; the orchestrator with no entry: unchanged. */
export function detailComplete(detail: Detail, agentId: string | undefined, _now: number): Detail {
  const id = agentId ?? MAIN_ID
  const prev = detail.agents[id]
  if (!isWorker(id)) {
    if (prev === undefined) return detail
    return putAgent(detail, id, { ...prev, tools: [] })
  }
  return putAgent(detail, id, { ...(prev ?? emptyAgentDetail()), tools: [] })
}

/** Open a card's detail strip, or close it when it is the one already open. */
export function selectCard(ui: Ui, id: string): Ui {
  return { ...ui, selected: ui.selected === id ? null : id }
}

/** Close the detail strip when its card is no longer among `present`; otherwise the same object. */
export function dropSelection(ui: Ui, present: readonly string[]): Ui {
  if (ui.selected !== null && !present.includes(ui.selected)) return { ...ui, selected: null }
  return ui
}

const TABS: readonly BoardTab[] = ['board', 'tokens']
const SCOPES: readonly TokenScope[] = ['task', 'all']

/** Switch the pane's tab; the same object when unchanged or when `tab` is unknown. */
export function selectTab(ui: Ui, tab: BoardTab): Ui {
  if (!TABS.includes(tab) || ui.tab === tab) return ui
  return { ...ui, tab }
}

/** Switch the Tokens tab's scope; the same object when unchanged or when `scope` is unknown. */
export function selectScope(ui: Ui, scope: TokenScope): Ui {
  if (!SCOPES.includes(scope) || ui.scope === scope) return ui
  return { ...ui, scope }
}
