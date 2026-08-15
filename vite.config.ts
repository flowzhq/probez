import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The frontend `probez view` serves.
 *
 * It builds to `dist/view`, a sibling of the `dist/src` that `tsc` emits, because the server
 * resolves its assets relative to its own compiled location. `base` is absolute rather than
 * relative: the app has deep routes like `/p/<slug>/s/<id>`, and relative asset paths would be
 * resolved against those instead of against the root.
 *
 * Nothing here may reach the network. No CDN, no remote fonts, no analytics — the built page is
 * served under a content-security-policy that would refuse them anyway, and CI greps for them.
 */
export default defineConfig({
  root: 'web',
  base: '/',
  plugins: [react()],
  server: {
    // `npm run dev` serves the app with hot reload and hands the data to a real `probez view`
    // running alongside it on its default port. Open the dev server with the token that command
    // printed — `?t=…` — and the page keeps it from there.
    proxy: { '/api': { target: 'http://127.0.0.1:7373', changeOrigin: true } },
  },
  build: {
    outDir: '../dist/view',
    emptyOutDir: true,
    assetsDir: 'assets',
    // One store's worth of session prose can make a large payload; the warning is not useful here.
    chunkSizeWarningLimit: 1500,
  },
})
