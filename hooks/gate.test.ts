import { describe, expect, test } from 'claude-code/testing'

import type { GateFault } from '../types'
import {
  GATE_ON_ERROR_SETTING,
  GATE_SHAPE,
  UNGATED_SHORT,
  classifySpawn,
  emptyHealth,
  faultError,
  gateAnswerLine,
  gateBandPart,
  gateFaultLine,
  gateLogText,
  gateNotice,
  gateOnError,
  gateStatusValue,
  isCheck,
  isDegraded,
  recordFault,
  strictRefusal,
  ungatedDetail,
  ungatedLine,
} from './gate'

const fault = (over: Partial<GateFault> = {}): GateFault => ({
  where: 'spawn check',
  at: 1000,
  error: "Cannot read properties of undefined (reading 'units')",
  outcome: 'started unchecked',
  ...over,
})

describe('the setting', () => {
  test('names', () => {
    expect(GATE_ON_ERROR_SETTING).toBe('gateOnError')
    expect(GATE_SHAPE).toBe('gate-1')
  })

  test('only exactly refuse is refuse', () => {
    expect(gateOnError(undefined)).toBe('allow')
    expect(gateOnError({})).toBe('allow')
    expect(gateOnError({ gateOnError: 'allow' })).toBe('allow')
    expect(gateOnError({ gateOnError: 'REFUSE' })).toBe('allow')
    expect(gateOnError({ gateOnError: 'refuse' })).toBe('refuse')
  })
})

describe('health', () => {
  test('empty', () => {
    expect(emptyHealth(5)).toEqual({ checkFailures: 0, recordFailures: 0, last: null, since: 5 })
    expect(isDegraded(emptyHealth(5))).toBe(false)
  })

  test('isCheck', () => {
    for (const w of ['spawn check', 'spec check', 'context check', 'fork check', 'spawn hook'] as const) expect(isCheck(w)).toBe(true)
    expect(isCheck('spawn bookkeeping')).toBe(false)
    expect(isCheck('audit file')).toBe(false)
  })

  test('recordFault counts by kind, keeps since, never mutates', () => {
    const h0 = emptyHealth(42)
    const f1 = fault()
    const h1 = recordFault(h0, f1)
    expect(h1).toEqual({ checkFailures: 1, recordFailures: 0, last: f1, since: 42 })
    expect(h0).toEqual({ checkFailures: 0, recordFailures: 0, last: null, since: 42 })
    const f2 = fault({ where: 'audit file', outcome: 'recorded only' })
    const h2 = recordFault(h1, f2)
    expect(h2).toEqual({ checkFailures: 1, recordFailures: 1, last: f2, since: 42 })
    expect(isDegraded(h1)).toBe(true)
    expect(isDegraded(recordFault(h0, f2))).toBe(false)
  })
})

describe('faultError', () => {
  test('collapses whitespace and replaces the field separator', () => {
    expect(faultError('a  b\n c\t d')).toBe('a b c d')
    expect(faultError('x | y')).toBe('x / y')
  })

  test('cuts at 160 with an ellipsis', () => {
    expect(faultError('a'.repeat(160))).toBe('a'.repeat(160))
    expect(faultError('a'.repeat(161))).toBe('a'.repeat(160) + '…')
  })

  test('empty gives unknown error', () => {
    expect(faultError('')).toBe('unknown error')
    expect(faultError(undefined)).toBe('unknown error')
    expect(faultError('   ')).toBe('unknown error')
  })

  test('other values', () => {
    expect(faultError(new Error('down'))).toBe('down')
    expect(faultError(7)).toBe('7')
  })
})

describe('audit-file lines', () => {
  test('gate error line (3.5 example)', () => {
    expect(
      gateFaultLine('2026-11-15T19:20:01.123Z', 'a1b2c3d4e5f60718', fault()),
    ).toBe(
      "2026-11-15T19:20:01.123Z | !gate-error | a1b2c3d4e5f60718 | spawn check | started unchecked | Cannot read properties of undefined (reading 'units')",
    )
    expect(gateFaultLine('2026-11-15T19:20:01.123Z', null, fault({ where: 'fork check', outcome: 'refused (strict)', error: 'timeout' }))).toBe(
      '2026-11-15T19:20:01.123Z | !gate-error | - | fork check | refused (strict) | timeout',
    )
  })

  test('ungated line (3.5 example)', () => {
    expect(
      ungatedLine('2026-11-15T19:21:07.000Z', 'a21dfd01022c3f441', { why: 'workflow', run: 'wf_e329600b-ef2' }, 'workflow-subagent', 'haiku', 'wf plain'),
    ).toBe('2026-11-15T19:21:07.000Z | !ungated | a21dfd01022c3f441 | workflow wf_e329600b-ef2 | workflow-subagent | haiku | wf plain')
  })

  test('ungated line without run or model, description cut to 60', () => {
    expect(ungatedLine('T', 'a1', { why: 'resumed' }, 'probeg:leaf', null, 'x'.repeat(70))).toBe(
      'T | !ungated | a1 | resumed | probeg:leaf | - | ' + 'x'.repeat(60),
    )
  })
})

describe('ungated texts', () => {
  test('short names', () => {
    expect(UNGATED_SHORT).toEqual({ workflow: 'workflow', resumed: 'resumed', nested: 'nested', exempt: 'exempt', unseen: 'unseen' })
  })

  test('details (5.2)', () => {
    expect(ungatedDetail({ why: 'workflow', run: 'wf_e329600b-ef2' }, 'workflow-subagent')).toBe(
      'workflow run wf_e329600b-ef2: its agents start unchecked',
    )
    expect(ungatedDetail({ why: 'resumed' }, 'x')).toBe('resumed run of an agent no unit covered')
    expect(ungatedDetail({ why: 'exempt' }, 'statusline-setup')).toBe('exempt type statusline-setup')
    expect(ungatedDetail({ why: 'unseen' }, 'x')).toBe(
      'not seen by the gate (a skill in its own agent, or started before the board loaded)',
    )
    expect(ungatedDetail({ why: 'nested' }, 'x')).toBe('started by another agent')
  })
})

describe('status, band, log, notice', () => {
  const h = { ...emptyHealth(0), checkFailures: 2 }

  test('status value and band part', () => {
    expect(gateStatusValue(h)).toBe('degraded · 2 failed')
    expect(gateBandPart(h)).toBe('gate degraded (2)')
  })

  test('log text (5.3)', () => {
    expect(gateLogText(fault(), 'x1')).toBe(
      "gate failed: spawn check (Cannot read properties of undefined (reading 'units')) · x1 started unchecked",
    )
    expect(gateLogText(fault({ error: 'boom', outcome: 'refused (fallback check)' }), null)).toBe(
      'gate failed: spawn check (boom) · refused (fallback check)',
    )
    expect(gateLogText(fault({ error: 'e'.repeat(80) }), 'Find call sites')).toBe(
      'gate failed: spawn check (' + 'e'.repeat(60) + ') · Find call sites started unchecked',
    )
  })

  test('notice (3.4)', () => {
    const f = fault({ error: 'boom' })
    expect(gateNotice(f, '/p/audit.log', false)).toBe(
      'Flowestra: a check of the spawn gate failed (spawn check: boom), so that spawn started unchecked. The board shows "gate degraded" until the mod loads again; every failure is written to /p/audit.log.',
    )
    expect(gateNotice(f, '/p/audit.log', true)).toBe(
      'Flowestra: a check of the spawn gate failed (spawn check: boom), so that spawn was refused (setting "When the gate fails": refuse). The board shows "gate degraded" until the mod loads again; every failure is written to /p/audit.log.',
    )
  })

  test('strict refusal (5.1)', () => {
    expect(strictRefusal('spawn check', 'boom')).toBe(
      'Spawn refused: the Agent Board\'s gate could not check this spawn (spawn check: boom), and the Flowestra setting "When the gate fails" is set to refuse. Do the work yourself, or ask the user to set it back to allow in /config.',
    )
  })
})

describe('the AgentBoard answer line (5.4)', () => {
  test('healthy is empty', () => {
    expect(gateAnswerLine(emptyHealth(0), 5000, '/p/audit.log')).toBe('')
  })

  test('degraded, one failure', () => {
    const h = recordFault(emptyHealth(0), fault({ at: 1000, error: 'boom' }))
    expect(gateAnswerLine(h, 193000, '/p/audit.log')).toBe(
      'gate degraded: 1 check failure since the mod loaded, the last 3m 12s ago (spawn check: boom); a spawn checked during a failure started unchecked. Tell the user. Failures are in /p/audit.log.',
    )
  })

  test('degraded, refused, with record failures', () => {
    let h = recordFault(emptyHealth(0), fault({ at: 1000, error: 'boom' }))
    h = recordFault(h, fault({ at: 2000, error: 'bad', outcome: 'refused (strict)' }))
    h = recordFault(h, fault({ where: 'audit file', at: 3000, error: 'disk', outcome: 'recorded only' }))
    h = recordFault(h, fault({ where: 'spawn check', at: 40000, error: 'worse', outcome: 'refused (strict)' }))
    expect(gateAnswerLine(h, 45000, '/p/audit.log')).toBe(
      'gate degraded: 3 check failures since the mod loaded, the last 5s ago (spawn check: worse); a spawn checked during a failure was refused. Tell the user. Failures are in /p/audit.log. 1 record could not be written.',
    )
  })

  test('only record failures', () => {
    let h = recordFault(emptyHealth(0), fault({ where: 'audit file', error: 'disk', outcome: 'recorded only' }))
    expect(gateAnswerLine(h, 5000, '/p/audit.log')).toBe(
      'gate records: 1 record could not be written since the mod loaded (last: audit file: disk); the checks themselves ran. Details in /p/audit.log.',
    )
    h = recordFault(h, fault({ where: 'spawn bookkeeping', error: 'x', outcome: 'recorded only' }))
    expect(gateAnswerLine(h, 5000, '/p/audit.log')).toBe(
      'gate records: 2 records could not be written since the mod loaded (last: spawn bookkeeping: x); the checks themselves ran. Details in /p/audit.log.',
    )
  })
})

describe('classifySpawn', () => {
  test('P1 top-level and nested are checked', () => {
    expect(classifySpawn({ subagentType: 'probeg:nester', fork: false })).toBe('checked')
    expect(classifySpawn({ subagentType: 'probeg:leaf', fork: false })).toBe('checked')
  })

  test('P2 resume', () => {
    expect(classifySpawn({ subagentType: 'probeg:leaf', fork: false, resume: { agentId: 'adb2f5af' } })).toBe('resume')
  })

  test('P3 workflow, both', () => {
    expect(classifySpawn({ subagentType: 'workflow-subagent', fork: false, workflow: { runId: 'wf_e329600b-ef2', agentIndex: 1 } })).toBe('workflow')
    expect(classifySpawn({ subagentType: 'probeg:leaf', fork: false, workflow: { runId: 'wf_e329600b-ef2', agentIndex: 2 } })).toBe('workflow')
  })

  test('exempt', () => {
    expect(classifySpawn({ subagentType: 'statusline-setup', fork: false })).toBe('exempt')
  })

  test('a fork is checked even with a workflow', () => {
    expect(classifySpawn({ subagentType: 'x', fork: true, workflow: { runId: 'wf_1', agentIndex: 1 } })).toBe('checked')
  })
})
