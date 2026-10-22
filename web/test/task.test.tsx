import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { openApp, SESSION } from './harness'
import type { App } from './harness'

/**
 * Inside a task: the round inspector and the result bodies it reads on request, and a question's
 * reading — asked of a reader, or copied to ask anywhere.
 */

let app: App
let user: ReturnType<typeof userEvent.setup>
/** The fixture's one question, as the server addresses it. */
let question: { task: number; at: number }

beforeAll(async () => {
  app = await openApp('/')
  user = userEvent.setup()
  const response = await fetch(`/api/projects/${app.slug}/questions`, { headers: { 'x-probez-token': app.server.token } })
  const payload = (await response.json()) as { questions: Array<{ task: number; at: number }> }
  question = payload.questions[0]!
  // A reader that answers the way a model would, so `explain` has something to run.
  writeFileSync(
    join(app.dataDir, 'reader.json'),
    JSON.stringify({
      command: [
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify({asked:"Where is the fetch loop?",kind:"refs",why:"a name, then its file"}))',
      ],
    }) + '\n',
  )
})

afterAll(async () => {
  await app?.close()
})

const task = (query: string): string => `/p/${app.slug}/s/${SESSION}/t/${question.task}?${query}`

test('a round opens in the inspector, and one that cannot be read says so in its place', async () => {
  const undo = app.fault('GET', /\/rounds\/\d+$/, 500, 'that round could not be read')
  try {
    await app.go(task('round=0'))
    expect(await screen.findByText('that round could not be read')).toBeTruthy()
  } finally {
    undo()
  }
  // Closed and opened again, it is read again, and this time there is a round to show.
  await app.go(task(''))
  await app.go(task('round=0'))
  await waitFor(() => expect(screen.queryByText(/Reading round 0…/)).toBeNull())
  expect(document.querySelector('.inspector .call-head')).not.toBeNull()
})

test('a call\'s result is read only when asked for, shown and hidden again, and a failed read says why', async () => {
  await app.go(task('round=0'))
  const head = await waitFor(() => {
    const found = document.querySelector<HTMLButtonElement>('.inspector .call-head')
    if (found === null) throw new Error('no call in the inspector yet')
    return found
  })
  await user.click(head)

  const undo = app.fault('GET', /\/results\//, 500, 'the archived session could not be opened')
  try {
    await user.click(await screen.findByRole('button', { name: /^Show result · / }))
    const refused = await screen.findByText('the archived session could not be opened')
    expect(refused.classList.contains('bad')).toBe(true)
  } finally {
    undo()
  }

  const reads = (): number => app.requests.filter((one) => one.includes('/results/')).length
  await user.click(screen.getByRole('button', { name: /^Show result · / }))
  const hide = await screen.findByRole('button', { name: 'Hide result' })
  // The body sits under the button that fetched it, apart from the call's own input above it.
  const body = (): Element | null => document.querySelector('.inspector .call-result ~ pre')
  expect(body()?.textContent).toMatch(/x{10}/)
  const read = reads()

  // Already read: hiding and showing again is the page's own business, not another request.
  await user.click(hide)
  expect(body()).toBeNull()
  await user.click(screen.getByRole('button', { name: /^Show result · / }))
  expect(body()).not.toBeNull()
  expect(reads()).toBe(read)
})

/** The open question's panel. */
async function panel(): Promise<HTMLElement> {
  await app.go(task(`question=${question.at}`))
  const head = await screen.findByText(/^question .* → /)
  return head.closest('.trail-panel') as HTMLElement
}

test('explain asks the reader and shows what it said; a failed ask says why, and asking again replaces it', async () => {
  const open = await panel()
  expect(within(open).getByText(/asks .* what these calls were after\. Only the calls go\./)).toBeTruthy()

  const undo = app.fault('POST', /\/explain$/, 504, 'the reader took longer than 60 s')
  try {
    await user.click(within(open).getByRole('button', { name: 'explain' }))
    const refused = await within(open).findByText('the reader took longer than 60 s')
    expect(refused.classList.contains('bad')).toBe(true)
  } finally {
    undo()
  }

  await user.click(within(open).getByRole('button', { name: 'explain' }))
  expect(await within(open).findByText('Where is the fetch loop?')).toBeTruthy()
  expect(within(open).getByText('a name, then its file')).toBeTruthy()
  // Asking again is a deliberate second spend, so it is its own button once there is a reading.
  const asks = (): number => app.requests.filter((one) => one.startsWith('POST') && one.endsWith('/explain')).length
  const before = asks()
  await user.click(within(open).getByRole('button', { name: 'ask again' }))
  await waitFor(() => expect(asks()).toBe(before + 1))
  expect(await within(open).findByText('Where is the fetch loop?')).toBeTruthy()
})

test('copy prompt puts the calls on the clipboard, shows them to copy by hand when it cannot, and says why when there is no prompt', async () => {
  const open = await panel()
  await user.click(within(open).getByRole('button', { name: 'copy prompt' }))
  await within(open).findByRole('button', { name: 'copied' })
  expect(await navigator.clipboard.readText()).toMatch(/A coding agent made the tool calls below/)

  const write = navigator.clipboard.writeText
  navigator.clipboard.writeText = () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
  try {
    await user.click(within(open).getByRole('button', { name: 'copied' }))
    expect(await within(open).findByText(/the browser would not take it — select and copy it from here/)).toBeTruthy()
    expect((within(open).getByRole('textbox') as HTMLTextAreaElement).value).toMatch(/A coding agent made the tool calls below/)
  } finally {
    navigator.clipboard.writeText = write
  }

  const undo = app.fault('GET', /\/prompt\?/, 404, 'no question at that call')
  try {
    await user.click(within(open).getByRole('button', { name: 'copy prompt' }))
    const refused = await within(open).findByText('no question at that call')
    expect(refused.classList.contains('bad')).toBe(true)
  } finally {
    undo()
  }
})
