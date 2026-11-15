import { expect, test } from 'claude-code/testing'

import { failOpen } from './guard'

test('failOpen: a returning check gives its value', async () => {
  expect(await failOpen(() => 'refused')).toBe('refused')
  expect(await failOpen(() => null)).toBeNull()
  expect(await failOpen(() => 0)).toBe(0)
  expect(await failOpen(async () => ({ deny: 'no' }))).toEqual({ deny: 'no' })
})

test('failOpen: a throwing check gives null', async () => {
  expect(
    await failOpen<string>(() => {
      throw new Error('broken check')
    }),
  ).toBeNull()
})

test('failOpen: a rejecting check gives null, and failOpen itself never rejects', async () => {
  let rejected = false
  const r = await failOpen<string>(() => Promise.reject(new Error('down'))).catch(() => {
    rejected = true
    return 'caught'
  })
  expect(r).toBeNull()
  expect(rejected).toBe(false)
  expect(await failOpen<string>(async () => {
    throw new Error('async throw')
  })).toBeNull()
})
