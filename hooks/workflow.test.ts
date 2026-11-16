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
    expect(words(workflowText('light'))).toBeGreaterThanOrEqual(170)
    expect(words(workflowText('light'))).toBeLessThanOrEqual(210)
    expect(words(workflowText('full'))).toBeGreaterThanOrEqual(780)
    expect(words(workflowText('full'))).toBeLessThanOrEqual(870)
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
