import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { readThresholds } from '../../src/findings'
import { openApp } from './harness'
import type { App } from './harness'

/**
 * Every Save on every Settings tab, and the Danger zone: what each says when the server took it,
 * what each says when it did not, and what it wrote to the store.
 */

let app: App
const user = userEvent.setup()

beforeAll(async () => {
  app = await openApp('/settings')
  await screen.findByRole('heading', { name: 'Settings', level: 1 })
})

afterAll(async () => {
  await app?.close()
})

const stored = (file: string): unknown => JSON.parse(readFileSync(join(app.dataDir, file), 'utf8'))

/** Fail the next write to `path` with `error`, run `step`, and take the fault away whatever happens. */
async function failing(path: RegExp, error: string, step: () => Promise<void>): Promise<void> {
  const undo = app.fault('POST', path, 400, error)
  try {
    await step()
  } finally {
    undo()
  }
}

test('rates are saved as typed, and a refusal from the server is shown beside the button', async () => {
  const output = await screen.findByLabelText('claude-opus-5 Output')
  await user.clear(output)
  await user.type(output, '30')
  await user.click(screen.getByRole('button', { name: 'Save rates' }))
  await screen.findByText('Saved. Every share on every page is now a share of these rates.')
  expect((stored('pricing.json') as { models: Record<string, { out: number }> }).models['claude-opus-5']?.out).toBe(30)
  // Saved means it is what the table now reads back as, and the row says it is no longer the list price.
  expect(screen.getByText('edited')).toBeTruthy()

  await failing(/\/pricing$/, 'claude-opus-5 out must be a number of dollars', async () => {
    await user.type(output, '0')
    await user.click(screen.getByRole('button', { name: 'Save rates' }))
    const refused = await screen.findByText('claude-opus-5 out must be a number of dollars')
    expect(refused.classList.contains('bad')).toBe(true)
  })

  // A model named here gets a row like any other, saved by the same button.
  await user.type(screen.getByLabelText('Add a model by name'), 'gpt-5')
  await user.click(screen.getByRole('button', { name: 'Add a model' }))
  expect(await screen.findByLabelText('gpt-5 Output')).toBeTruthy()
})

test('your name is saved for exports to carry, and a refusal says why', async () => {
  await app.go('/settings/data')
  const name = await screen.findByLabelText('Your name')
  await user.clear(name)
  await user.type(name, 'Itay')
  await user.click(screen.getByRole('button', { name: 'Save name' }))
  await screen.findByText('Saved. Your exports name their rounds Itay.')
  expect(stored('identity.json')).toMatchObject({ name: 'Itay' })

  await failing(/\/identity$/, 'a name cannot be only spaces', async () => {
    await user.click(screen.getByRole('button', { name: 'Save name' }))
    const refused = await screen.findByText('a name cannot be only spaces')
    expect(refused.classList.contains('bad')).toBe(true)
  })
})

test('thresholds are checked as percentages, saved as shares, and put back to the defaults on request', async () => {
  await app.go('/settings/findings')
  const share = await screen.findByLabelText('Reconstruction share, percent')

  // Refused here, before anything is sent: a share is between 0 and 100 percent.
  await user.clear(share)
  await user.type(share, '150')
  const before = app.requests.length
  await user.click(screen.getByRole('button', { name: 'Save thresholds' }))
  await screen.findByText('Reconstruction share must be a percentage above 0 and below 100.')
  expect(app.requests.length).toBe(before)

  await user.clear(share)
  await user.type(share, '25')
  await user.click(screen.getByRole('button', { name: 'Save thresholds' }))
  await screen.findByText('Saved. The Findings page now draws at these lines.')
  expect((await readThresholds(app.dataDir)).reconstruction).toBe(0.25)

  await failing(/\/thresholds$/, 'thresholds must be shares between 0 and 1', async () => {
    await user.click(screen.getByRole('button', { name: 'Reset to defaults' }))
    const refused = await screen.findByText('thresholds must be shares between 0 and 1')
    expect(refused.classList.contains('bad')).toBe(true)
  })
  expect((share as HTMLInputElement).value).toBe('25')

  await user.click(screen.getByRole('button', { name: 'Reset to defaults' }))
  await screen.findByText('Saved. The Findings page now draws at these lines.')
  await waitFor(() => expect((share as HTMLInputElement).value).not.toBe('25'))
  expect((await readThresholds(app.dataDir)).reconstruction).not.toBe(0.25)
})

test('the reader is saved as argv, can be emptied, and a refusal says why', async () => {
  await app.go('/settings/reader')
  // Nothing is configured, so the one-click fill is offered; it fills, it does not save.
  await user.click(await screen.findByRole('button', { name: 'Use Claude Code (claude -p)' }))
  expect((screen.getByLabelText('Reader command') as HTMLInputElement).value).toBe('claude -p')
  expect(existsSync(join(app.dataDir, 'reader.json'))).toBe(false)

  await user.click(screen.getByRole('button', { name: 'Save reader' }))
  await screen.findByText('Saved. `explain` now runs claude -p.')
  expect(stored('reader.json')).toMatchObject({ command: ['claude', '-p'] })

  await user.clear(screen.getByLabelText('Reader command'))
  await user.click(screen.getByRole('button', { name: 'Save reader' }))
  await screen.findByText('Saved. With no command there is nothing probez can run.')

  await failing(/\/reader$/, 'the timeout must be a whole number of milliseconds', async () => {
    await user.click(screen.getByRole('button', { name: 'Save reader' }))
    const refused = await screen.findByText('the timeout must be a whole number of milliseconds')
    expect(refused.classList.contains('bad')).toBe(true)
  })
})

test('command names are saved for the next analyze, and a refusal says why', async () => {
  await app.go('/settings/commands')
  await screen.findByRole('heading', { name: 'What this machine calls things' })
  await user.click(screen.getByRole('button', { name: 'Save names' }))
  await screen.findByText('Saved. Rounds are counted under these from the next analyze.')

  await failing(/\/commands$/, 'mystery is not a kind probez counts', async () => {
    await user.click(screen.getByRole('button', { name: 'Save names' }))
    const refused = await screen.findByText('mystery is not a kind probez counts')
    expect(refused.classList.contains('bad')).toBe(true)
  })
})

test('the danger zone says what would go before taking anything, and then takes exactly that', async () => {
  await app.go('/settings/data')
  const keep = await screen.findByLabelText('How much to keep')
  const [trim, whole] = screen.getAllByRole('button', { name: 'Show what would go' })

  // Nothing is a year old, and the plan says so rather than offering to remove nothing.
  await user.selectOptions(keep, '365d')
  await user.click(trim!)
  const nothing = await screen.findByRole('dialog', { name: 'What would be removed' })
  expect(within(nothing).getByText('Nothing in the store is older than that.')).toBeTruthy()
  await user.click(within(nothing).getByRole('button', { name: 'Close' }))

  await user.selectOptions(keep, '30d')
  await user.click(trim!)
  const plan = await screen.findByRole('dialog', { name: 'What would be removed' })
  expect(within(plan).getByText('Remove 1 sessions from 1 projects?')).toBeTruthy()
  expect(within(plan).getByText('work')).toBeTruthy()
  await user.click(within(plan).getByRole('button', { name: 'Cancel' }))

  await failing(/\/clear$/, 'the store could not be read', async () => {
    await user.click(whole!)
    const refused = await screen.findByText('the store could not be read')
    expect(refused.classList.contains('bad')).toBe(true)
  })

  await user.click(whole!)
  const all = await screen.findByRole('dialog', { name: 'What would be removed' })
  expect(within(all).getByText('Remove all 1 projects?')).toBeTruthy()

  await failing(/\/clear$/, 'a project is still being written', async () => {
    await user.click(within(all).getByRole('button', { name: 'Remove' }))
    const refused = await screen.findByText('a project is still being written')
    expect(refused.classList.contains('bad')).toBe(true)
  })
  expect(existsSync(join(app.dataDir, 'projects', app.slug))).toBe(true)

  // Asked afresh, so the plan is read again before Remove can be pressed.
  await user.click(whole!)
  const again = await screen.findByRole('dialog', { name: 'What would be removed' })
  await user.click(await within(again).findByRole('button', { name: 'Remove' }))
  await screen.findByText(/^removed 1 sessions · 5 rounds · .* freed$/)
  expect(existsSync(join(app.dataDir, 'projects', app.slug))).toBe(false)
})
