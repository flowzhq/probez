import { defineConfig, mergeConfig } from 'vitest/config'

import viteConfig from './vite.config'

/**
 * The page's own tests: the real app, mounted in jsdom, talking to a real `probez view` server.
 *
 * Built on the same config the app is built with, so a test sees the page the browser would. The
 * root is the repository rather than the app's `web/`, so the paths below read the same to anything
 * that runs these from the top of the repo. The CLI and server tests are `node --test` over
 * `dist/test`; these are the ones that need a DOM.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    root: '.',
    test: {
      environment: 'jsdom',
      include: ['web/test/**/*.test.tsx'],
      setupFiles: ['web/test/setup.ts'],
      // A store is collected and a server started per file, and every step waits on real requests.
      testTimeout: 30_000,
      hookTimeout: 60_000,
    },
  }),
)
