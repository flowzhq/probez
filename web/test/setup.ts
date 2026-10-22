import { cleanup, configure } from '@testing-library/react'
import { afterEach } from 'vitest'

// Every answer here comes from a real server reading a real store, several files at once; a second
// is a short wait for that, and a test that waits longer only does so when something is wrong.
configure({ asyncUtilTimeout: 5_000 })

// What a browser has and jsdom does not, and the page reaches for. None of it is under test here.
class Observer {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return []
  }
}
globalThis.ResizeObserver ??= Observer as unknown as typeof ResizeObserver
globalThis.IntersectionObserver ??= Observer as unknown as typeof IntersectionObserver
window.scrollTo = (() => undefined) as typeof window.scrollTo
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {}
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
  dispatchEvent: () => false,
})) as typeof window.matchMedia

afterEach(() => {
  cleanup()
})
