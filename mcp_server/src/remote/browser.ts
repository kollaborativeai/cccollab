import { spawn } from 'node:child_process'
import { platform } from 'node:os'

/**
 * Open `url` in the user's default browser.
 *
 * Platform-minimal handrolled launcher so we don't need the `open` npm
 * package. Uses macOS `open`, Linux `xdg-open`, and Windows
 * `cmd /c start`. The promise resolves as soon as the launcher is
 * spawned (fire-and-forget); it does NOT wait for the browser to
 * close.
 *
 * On failure (missing launcher, non-interactive environment) the
 * promise rejects - callers print setup instructions in that case so
 * the user can paste the URL manually.
 */
export async function openBrowser(url: string): Promise<void> {
  const [cmd, args] = resolveLauncher(url)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.once('error', reject)
    // Give the launcher ~100ms to fail synchronously (missing binary).
    // If it's still alive after that, assume success and unref it.
    const timer = setTimeout(() => {
      child.unref()
      resolve()
    }, 100)
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0 || code === null) {
        resolve()
      } else {
        reject(new Error(`Browser launcher exited with code ${code}`))
      }
    })
  })
}

function resolveLauncher(url: string): [string, string[]] {
  const p = platform()
  if (p === 'darwin') return ['open', [url]]
  if (p === 'win32') return ['cmd', ['/c', 'start', '""', url]]
  // linux and others
  return ['xdg-open', [url]]
}
