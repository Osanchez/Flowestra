import { describe, expect, test } from 'claude-code/testing'

import { BOARD_PROMPT_SECTION_TEXT, BOARD_TOOL_DESCRIPTION, BOARD_TOOL_SCHEMA } from './board'
import { routingPolicySection } from './policy'
import { injectedParts } from './report'
import { WORKFLOW_ROLE_TEXT, workflowText } from './workflow'

describe('injectedParts', () => {
  test('full: the lengths of the four source texts', () => {
    expect(injectedParts('full', '')).toEqual([
      { name: 'workflow', chars: workflowText('full').length },
      { name: 'board', chars: BOARD_PROMPT_SECTION_TEXT.length },
      { name: 'routing policy', chars: routingPolicySection('').text.length },
      { name: 'AgentBoard tool', chars: BOARD_TOOL_DESCRIPTION.length + JSON.stringify(BOARD_TOOL_SCHEMA).length },
    ])
  })

  test('light uses the role text; the note is part of the policy section', () => {
    expect(injectedParts('light', '')[0]).toEqual({ name: 'workflow', chars: WORKFLOW_ROLE_TEXT.length })
    const plain = injectedParts('full', '')[2] as { chars: number }
    const noted = injectedParts('full', 'Haiku work runs on Sonnet.')[2] as { chars: number }
    expect(noted.chars).toBe(plain.chars + 2 + 'Haiku work runs on Sonnet.'.length)
  })
})
