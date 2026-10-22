import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { openApp, SESSION } from './harness'
import type { App } from './harness'

/**
 * Getting around: the page loading at an address, each level of a project, the sessions list's
 * drawer, bringing in someone else's export, and the names the scope bar offers once there is more
 * than one person's work in the store.
 */

let app: App
const user = userEvent.setup()
/**
 * The app's own, imported once the app is open: `api.ts` takes the token from the address when it
 * is first loaded, so importing anything of the page's before `openApp` would leave it without one.
 */
let forgetIdentity: () => void

beforeAll(async () => {
  app = await openApp('/')
  ;({ forgetIdentity } = await import('../src/meta'))
})

afterAll(async () => {
  await app?.close()
})

test('the page loads where its address says, takes the token out of it, and every level of a project opens', async () => {
  expect(await screen.findByRole('group', { name: 'Scope' })).toBeTruthy()
  expect(window.location.search).not.toContain('t=')
  expect(window.sessionStorage.getItem('probez.token')).toBe(app.server.token)

  await app.go(`/p/${app.slug}`)
  await screen.findByRole('heading', { name: 'work', level: 1 })
  await app.go(`/p/${app.slug}/s/${SESSION}`)
  await screen.findByRole('button', { name: 'Sync work' })
  await app.go(`/p/${app.slug}/s/${SESSION}/t/1`)
  await waitFor(() => expect(document.querySelector('.inspector, .trace')).not.toBeNull())

  // Under --debug the reader has a tab of its own; the server says so once, and the page keeps it.
  await app.go('/settings')
  const tabs = await screen.findByRole('tablist', { name: 'Settings' })
  await within(tabs).findByRole('tab', { name: 'Reader' })
  expect(within(tabs).getByRole('tab', { name: 'Pricing' }).getAttribute('aria-selected')).toBe('true')

  await app.go('/nowhere/at/all')
  expect(await screen.findByText('There is nothing at /nowhere/at/all.')).toBeTruthy()
})

/** The fixture session's row in the sessions list, once the list has it. */
function sessionRow(): Promise<HTMLTableRowElement> {
  return waitFor(() => {
    const found = [...document.querySelectorAll<HTMLTableRowElement>('main tr.row')].find((row) =>
      row.textContent?.includes(SESSION.slice(0, 8)),
    )
    if (found === undefined) throw new Error('the session is not in the list yet')
    return found
  })
}

test('a session chosen from the list opens in the drawer, and one that cannot be read says so there', async () => {
  const undo = app.fault('GET', new RegExp(`/sessions/${SESSION}$`), 500, 'the session could not be read')
  try {
    await app.go('/sessions?range=all')
    await user.click(await sessionRow())
    expect(await screen.findAllByText('the session could not be read')).not.toHaveLength(0)
  } finally {
    undo()
  }

  // Chosen again on a page read afresh, it opens with what the session page itself would show.
  await app.go('/projects')
  await app.go('/sessions?range=all')
  await user.click(await sessionRow())
  await user.click(await screen.findByRole('button', { name: 'Open trace →' }))
  await screen.findByRole('button', { name: 'Sync work' })
  expect(window.location.pathname).toBe(`/p/${app.slug}/s/${SESSION}`)
})

/** This project's rounds as a teammate's export of theirs, under a file name of their own. */
async function theirExport(name: string, text?: string): Promise<File> {
  if (text !== undefined) return new File([text], name)
  const response = await fetch(`/api/projects/${app.slug}/export?format=jsonl`, {
    headers: { 'x-probez-token': app.server.token },
  })
  const lines = (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.stringify({ ...JSON.parse(line), session: 'dana-0000', committer: 'Dana' }))
  return new File([lines.join('\n') + '\n'], name, { type: 'application/x-ndjson' })
}

test('an import names the project for its file, replaces it when sent again, and says what was wrong with a bad one', async () => {
  await app.go('/import')
  const input = await waitFor(() => {
    const found = document.querySelector<HTMLInputElement>('input[type="file"]')
    if (found === null) throw new Error('no file picker yet')
    return found
  })
  const take = async (file: File): Promise<HTMLElement> => {
    // The picker is hidden behind the Import button, which opens it; the browser then hands the
    // page the chosen file as a change on that input.
    await user.click(screen.getByRole('button', { name: 'Import' }))
    fireEvent.change(input, { target: { files: [file] } })
    return screen.findByRole('status')
  }

  const refused = await take(await theirExport('notes.txt', 'these are not rounds\n'))
  await waitFor(() => expect(refused.textContent).toBe('no rounds in that file'))
  expect(refused.classList.contains('bad')).toBe(true)

  const file = await theirExport('dana-rounds.jsonl')
  const first = await take(file)
  await waitFor(() => expect(first.textContent).toBe('imported dana · 5 rounds, 1 sessions'))
  expect(first.classList.contains('bad')).toBe(false)
  const second = await take(file)
  await waitFor(() => expect(second.textContent).toBe('replaced dana · 5 rounds, 1 sessions'))
})

test('the scope bar offers each person\'s work once there are two, and leaves the choice out when it cannot tell', async () => {
  // Who this is could not be read: the bar goes on without the choice rather than failing.
  const undo = app.fault('GET', /\/identity$/, 500, 'identity could not be read')
  try {
    await act(async () => forgetIdentity())
    await app.go('/sessions?range=all')
    await screen.findByRole('group', { name: 'Scope' })
    await waitFor(() => expect(app.requests.filter((one) => one.endsWith('/api/identity'))).not.toHaveLength(0))
    expect(screen.queryByRole('option', { name: 'Dana' })).toBeNull()
  } finally {
    undo()
  }

  await act(async () => forgetIdentity())
  expect(await screen.findByRole('option', { name: 'Dana' })).toBeTruthy()
  expect(screen.getByRole('option', { name: /\(you\)$/ })).toBeTruthy()
})
