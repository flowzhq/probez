import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { downloads, openApp, SESSION } from './harness'
import type { App } from './harness'

/**
 * The `⋮` on a project, and the sync button on a session: every verb, what it says when it
 * worked, and what it says when it did not. One store, used in order, so a later step sees what an
 * earlier one did — which is how the page itself is used.
 */

let app: App
const user = userEvent.setup()

beforeAll(async () => {
  app = await openApp('/')
  await app.go(`/p/${app.slug}`)
  await screen.findByRole('heading', { name: 'work', level: 1 })
})

afterAll(async () => {
  await app?.close()
})

/** The `⋮` of the only project on the page, opened. */
async function menu(): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Actions for this project' }))
  return screen.findByRole('menu')
}

async function choose(item: RegExp): Promise<void> {
  await user.click(within(await menu()).getByRole('menuitem', { name: item }))
}

/** The sentence a verb leaves behind, and whether it was said as a failure. */
async function said(text: RegExp): Promise<{ bad: boolean }> {
  try {
    const status = await screen.findByText(text)
    return { bad: status.classList.contains('bad') }
  } catch {
    // What it said instead is the useful part of the failure.
    const instead = screen.queryAllByRole('status').map((one) => one.textContent)
    throw new Error(`nothing said ${text}; the page said ${JSON.stringify(instead)}`)
  }
}

test('sync reports what it found, and a failed one says why', async () => {
  await choose(/^Sync/)
  expect(await said(/already up to date · 5 rounds, 1 sessions/)).toEqual({ bad: false })

  const undo = app.fault('POST', /\/sync$/, 500, 'the disk is full')
  try {
    await choose(/^Sync/)
    expect(await said(/the disk is full/)).toEqual({ bad: true })
  } finally {
    undo()
  }
  // The menu works again afterwards: a failure leaves nothing stuck busy.
  expect(screen.getByRole('button', { name: 'Actions for this project' })).toHaveProperty('disabled', false)
})

test('rename sets a name the page then shows, and clearing it puts the path name back', async () => {
  await choose(/^Rename/)
  const field = screen.getByLabelText('Call this project')
  await user.clear(field)
  await user.type(field, 'checkout service')
  await user.click(screen.getByRole('button', { name: 'Rename' }))
  expect(await said(/renamed to checkout service/)).toEqual({ bad: false })
  await screen.findByRole('heading', { name: 'checkout service', level: 1 })

  await choose(/^Rename/)
  expect(screen.getByText(/A name of your own\. Clear it to go back/)).toBeTruthy()
  await user.clear(screen.getByLabelText('Call this project'))
  await user.click(screen.getByRole('button', { name: 'Rename' }))
  expect(await said(/name cleared · back to work/)).toEqual({ bad: false })
  await screen.findByRole('heading', { name: 'work', level: 1 })

  const undo = app.fault('POST', /\/rename$/, 409, 'that name is taken')
  try {
    await choose(/^Rename/)
    await user.type(screen.getByLabelText('Call this project'), ' again')
    await user.click(screen.getByRole('button', { name: 'Rename' }))
    expect(await said(/that name is taken/)).toEqual({ bad: true })
  } finally {
    undo()
  }
  // Escape is "no" to a panel opened by accident.
  await choose(/^Rename/)
  await user.keyboard('{Escape}')
  expect(screen.queryByLabelText('Call this project')).toBeNull()
})

test('each export hands the browser a file named for the project, darkened when asked', async () => {
  downloads.length = 0
  await choose(/^Export rounds/)
  expect(await said(/^downloaded .*\.jsonl · /)).toEqual({ bad: false })
  await choose(/^Export bundle/)
  expect(await said(/^downloaded .*\.json · /)).toEqual({ bad: false })
  expect(downloads.map((one) => one.name.split('.').pop())).toEqual(['jsonl', 'json'])
  for (const one of downloads) expect(one.size).toBeGreaterThan(0)

  // Darkening is a toggle above both, and every export row says so while it is on.
  const items = await menu()
  await user.click(within(items).getByRole('menuitemcheckbox', { name: /Darken the export/ }))
  expect(within(items).getByRole('menuitemcheckbox', { name: /✓ Darken the export/ })).toBeTruthy()
  await user.click(within(items).getByRole('menuitem', { name: /Export rounds, darkened/ }))
  await said(/^downloaded .*\.jsonl · /)
  expect(app.requests.at(-1)).toMatch(/\/export\?format=jsonl&darken=1$/)

  const undo = app.fault('GET', /\/export\?/, 500, 'the rounds file could not be read')
  try {
    await choose(/^Export bundle/)
    expect(await said(/the rounds file could not be read/)).toEqual({ bad: true })
  } finally {
    undo()
  }
})

/** This project's rounds as someone else's export of it: another person's sessions, named for them. */
async function theirExport(): Promise<File> {
  const response = await fetch(`/api/projects/${app.slug}/export?format=jsonl`, {
    headers: { 'x-probez-token': app.server.token },
  })
  const lines = (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.stringify({ ...JSON.parse(line), session: 'dana-0000', committer: 'Dana' }))
  return new File([lines.join('\n') + '\n'], 'work-rounds.jsonl', { type: 'application/x-ndjson' })
}

test('merge adds another computer\'s rounds once, says nothing is new the second time, and says why it failed', async () => {
  const file = await theirExport()
  const merge = async (): Promise<void> => {
    await choose(/^Merge from another computer/)
    const form = screen.getByRole('form', { name: 'Merge into work' })
    expect(within(form).getByRole('button', { name: 'Merge' })).toHaveProperty('disabled', true)
    await user.upload(within(form).getByLabelText('The file'), file)
    await user.click(within(form).getByRole('button', { name: 'Merge' }))
  }

  await merge()
  expect(await said(/merged from Dana · \+5 rounds · 10 total/)).toEqual({ bad: false })
  await merge()
  expect(await said(/nothing new from Dana · every round in that file is already here/)).toEqual({ bad: false })

  const undo = app.fault('POST', /\/merge$/, 400, 'that file is not a probez export')
  try {
    await merge()
    expect(await said(/that file is not a probez export/)).toEqual({ bad: true })
  } finally {
    undo()
  }
})

test('the sync on a session page syncs the whole project, and says so when it cannot', async () => {
  await app.go(`/p/${app.slug}/s/${SESSION}`)
  const button = await screen.findByRole('button', { name: 'Sync work' })
  await user.click(button)
  expect(await said(/already up to date · 10 rounds/)).toEqual({ bad: false })

  const undo = app.fault('POST', /\/sync$/, 500, 'the agent directory could not be read')
  try {
    await user.click(screen.getByRole('button', { name: 'Sync work' }))
    expect(await said(/the agent directory could not be read/)).toEqual({ bad: true })
  } finally {
    undo()
  }
})

test('from the projects list, a rename re-reads the list, and a delete that fails leaves it, one that works takes it', async () => {
  await app.go('/projects')
  await screen.findByRole('link', { name: 'work' })

  await choose(/^Rename/)
  await user.clear(screen.getByLabelText('Call this project'))
  await user.type(screen.getByLabelText('Call this project'), 'payments')
  await user.click(screen.getByRole('button', { name: 'Rename' }))
  await screen.findByRole('link', { name: 'payments' })

  const undo = app.fault('POST', /\/delete$/, 404, 'no project in this store')
  try {
    await choose(/^Delete/)
    const asked = screen.getByRole('dialog', { name: 'Delete payments' })
    expect(within(asked).getByText(/All 10 rounds probez recorded/)).toBeTruthy()
    await user.click(within(asked).getByRole('button', { name: 'Delete' }))
    expect(await said(/no project in this store/)).toEqual({ bad: true })
  } finally {
    undo()
  }
  expect(screen.getByRole('link', { name: 'payments' })).toBeTruthy()

  await choose(/^Delete/)
  await user.click(within(screen.getByRole('dialog', { name: 'Delete payments' })).getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(screen.queryByRole('link', { name: 'payments' })).toBeNull())
})
