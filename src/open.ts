import { spawn } from 'node:child_process'

/**
 * Hand a local URL to whatever the desktop uses to open one.
 *
 * This is the only file in probez that touches `child_process`, and it is deliberately the whole of
 * what it does. The URL is passed as an argv element with `shell: false`, so nothing in it can be
 * read as a command, and it is checked against the loopback address first so this cannot be turned
 * into a way to make the machine open something else.
 *
 * Failure is not an error worth stopping for: the caller has already printed the URL, and a machine
 * with no opener is a machine where you click it yourself.
 */
export function openInBrowser(url: string): boolean {
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return false

  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]

  try {
    const child = spawn(command as string, args as string[], {
      shell: false,
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}
