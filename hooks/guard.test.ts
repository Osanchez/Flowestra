import { expect, test } from 'claude-code/testing'

import { failOpen, runCheck } from './guard'

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

test('runCheck: a returning and a resolving check give ok with the value', async () => {
  expect(await runCheck(() => 'refused')).toEqual({ ok: true, value: 'refused' })
  expect(await runCheck(() => null)).toEqual({ ok: true, value: null })
  expect(await runCheck(async () => 7)).toEqual({ ok: true, value: 7 })
})

test('runCheck: a rejecting check gives not ok with the message, and never rejects', async () => {
  let rejected = false
  const r = await runCheck<string>(() => Promise.reject(new Error('down'))).catch(() => {
    rejected = true
    return null
  })
  expect(r).toEqual({ ok: false, error: 'down' })
  expect(rejected).toBe(false)
})

test('runCheck: a thrown non-Error gives its string', async () => {
  expect(
    await runCheck<string>(() => {
      throw 'x'
    }),
  ).toEqual({ ok: false, error: 'x' })
  expect(
    await runCheck<string>(async () => {
      throw new Error('async throw')
    }),
  ).toEqual({ ok: false, error: 'async throw' })
})
