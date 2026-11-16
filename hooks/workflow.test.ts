import { describe, expect, test } from 'claude-code/testing'

import {
  WORKFLOW_ROLE_TEXT,
  WORKFLOW_SECTION_ID,
  WORKFLOW_STEPS_TEXT,
  workflowMode,
  workflowSection,
  workflowText,
} from './workflow'

const words = (s: string): number => s.split(/\s+/).filter(w => w !== '').length

describe('the texts', () => {
  test('full starts with light and a blank line', () => {
    expect(workflowText('full').startsWith(workflowText('light') + '\n\n')).toBe(true)
    expect(workflowText('full')).toBe(WORKFLOW_ROLE_TEXT + '\n\n' + WORKFLOW_STEPS_TEXT)
    expect(workflowText('light')).toBe(WORKFLOW_ROLE_TEXT)
    expect(workflowText('off')).toBe('')
  })

  test('word counts', () => {
    expect(words(workflowText('light'))).toBeGreaterThanOrEqual(340)
    expect(words(workflowText('light'))).toBeLessThanOrEqual(380)
    expect(words(workflowText('full'))).toBeGreaterThanOrEqual(1040)
    expect(words(workflowText('full'))).toBeLessThanOrEqual(1080)
  })

  test('0.16.0: who writes is in both texts; the design worker and briefs are scaled to the task', () => {
    for (const mode of ['light', 'full'] as const) {
      expect(workflowText(mode)).toContain('**Who writes.**')
      expect(workflowText(mode)).toContain('- **Every change to the project\'s files** (code, tests, docs, config) goes to a worker')
      expect(workflowText(mode)).toContain('- **Task size decides how, not whether.**')
      expect(workflowText(mode)).not.toContain('**Exception:**')
      expect(workflowText(mode)).not.toContain('Opus tier where an Opus trigger applies')
      expect(workflowText(mode)).toContain('which gives all writing to the Sonnet tier')
      expect(workflowText(mode)).not.toContain('Do it yourself')
      expect(workflowText(mode)).not.toContain('When to delegate')
    }
    expect(WORKFLOW_STEPS_TEXT).toContain('otherwise the orchestrator drafts it itself, to the same standard')
    expect(WORKFLOW_STEPS_TEXT).toContain('each unit at its own section and the sections it lists as inputs')
    expect(WORKFLOW_STEPS_TEXT).toContain('Implementation units are carried out by workers in waves (by the orchestrator only when no worker model is on).')
    expect(WORKFLOW_STEPS_TEXT).not.toContain('**Small designs.**')
  })

  test('0.17.0: A1 and the cross-project line', () => {
    expect(workflowText('light')).toContain('except writing, which stays with Sonnet')
    expect(workflowText('full')).toContain('the step 2 test decides, per repository')
  })

  test('no trailing newline', () => {
    expect(WORKFLOW_ROLE_TEXT.endsWith('\n')).toBe(false)
    expect(WORKFLOW_STEPS_TEXT.endsWith('\n')).toBe(false)
  })

  test('none of the old vocabulary', () => {
    for (const text of [workflowText('light'), workflowText('full')]) {
      for (const bad of ['§1', 'Haiku gate', 'Sonnet gate', 'OPUS TRIGGER']) {
        expect(text.includes(bad)).toBe(false)
      }
    }
  })

  test('the decisions file is named in full only', () => {
    expect(workflowText('full')).toContain('.flowestra/decisions.md')
    expect(workflowText('light')).not.toContain('decisions.md')
  })
})

describe('workflowMode', () => {
  test('the three values', () => {
    expect(workflowMode({ workflow: 'full' })).toBe('full')
    expect(workflowMode({ workflow: 'light' })).toBe('light')
    expect(workflowMode({ workflow: 'off' })).toBe('off')
  })

  test('anything else is full', () => {
    expect(workflowMode({})).toBe('full')
    expect(workflowMode({ workflow: '' })).toBe('full')
    expect(workflowMode({ workflow: 'FULL' })).toBe('full')
    expect(workflowMode({ workflow: 3 })).toBe('full')
    expect(workflowMode(undefined as never)).toBe('full')
  })
})

describe('workflowSection', () => {
  test('off has none', () => {
    expect(workflowSection('off')).toBeNull()
  })

  test('light and full', () => {
    expect(WORKFLOW_SECTION_ID).toBe('flowestra:workflow')
    expect(workflowSection('light')).toEqual({ id: 'flowestra:workflow', text: WORKFLOW_ROLE_TEXT, scope: 'session' })
    expect(workflowSection('full')).toEqual({
      id: 'flowestra:workflow',
      text: WORKFLOW_ROLE_TEXT + '\n\n' + WORKFLOW_STEPS_TEXT,
      scope: 'session',
    })
  })
})
