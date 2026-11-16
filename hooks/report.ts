// The lengths of the texts the mod puts in the lead's prompt (pure); the Tokens tab
// shows them as characters, never turned into tokens. No I/O.

import { BOARD_PROMPT_SECTION_TEXT, BOARD_TOOL_DESCRIPTION, BOARD_TOOL_SCHEMA } from './board'
import { routingPolicySection } from './policy'
import { workflowText } from './workflow'
import type { WorkflowMode } from './workflow'

export type Injected = { name: string; chars: number }

/** The length, in characters, of each text the mod puts in the lead's prompt this session; no workflow part when the mode is off. */
export function injectedParts(mode: WorkflowMode, note: string): Injected[] {
  const parts: Injected[] = []
  const workflow = workflowText(mode)
  if (workflow !== '') parts.push({ name: 'workflow', chars: workflow.length })
  parts.push({ name: 'board', chars: BOARD_PROMPT_SECTION_TEXT.length })
  parts.push({ name: 'routing policy', chars: routingPolicySection(note).text.length })
  parts.push({ name: 'AgentBoard tool', chars: BOARD_TOOL_DESCRIPTION.length + JSON.stringify(BOARD_TOOL_SCHEMA).length })
  return parts
}
