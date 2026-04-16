import { createServer } from 'node:http'
import { URL } from 'node:url'
import { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, OAUTH_REDIRECT_URI, OAUTH_PORT } from './constants.js'
import { saveCredentials, type StoredCredentials } from './credentials.js'

export async function runOAuthFlow(): Promise<StoredCredentials> {
  const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${SLACK_CLIENT_ID}&scope=channels:manage,channels:read,channels:history,channels:join,chat:write,users:read,groups:read,groups:history&user_scope=chat:write&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}`

  // Try to open browser
  try {
    const { execFileSync } = await import('node:child_process')
    execFileSync('open', [authUrl], { stdio: 'ignore' })
  } catch {
    // Will be handled by the caller showing the URL
  }

  // Start local server to capture callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${OAUTH_PORT}`)
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      const codeParam = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<h1>Authorization denied</h1><p>You can close this tab.</p>')
        server.close()
        reject(new Error(`OAuth error: ${error}`))
        return
      }
      if (!codeParam) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<h1>Missing code</h1>')
        server.close()
        reject(new Error('No code in callback'))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<h1>Authorized!</h1><p>You can close this tab and return to Claude Code.</p>')
      server.close()
      resolve(codeParam)
    })

    server.listen(OAUTH_PORT, '127.0.0.1')

    setTimeout(() => {
      server.close()
      reject(new Error('Timed out waiting for OAuth callback (2 minutes)'))
    }, 120_000)
  })

  // Exchange code for tokens
  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      code,
      redirect_uri: OAUTH_REDIRECT_URI,
    }),
  })

  const data = await response.json() as {
    ok: boolean
    error?: string
    access_token?: string
    authed_user?: { id: string; access_token: string }
    team?: { id: string; name: string }
  }

  if (!data.ok || !data.access_token || !data.authed_user?.access_token) {
    throw new Error(`OAuth token exchange failed: ${data.error ?? 'unknown error'}`)
  }

  // Get user display name
  const { WebClient } = await import('@slack/web-api')
  const userClient = new WebClient(data.authed_user.access_token)
  let userName = 'unknown'
  try {
    const userInfo = await userClient.auth.test()
    userName = (userInfo.user as string) ?? 'unknown'
  } catch {
    // Fall back to unknown
  }

  const creds: StoredCredentials = {
    botToken: data.access_token,
    userToken: data.authed_user.access_token,
    teamId: data.team?.id ?? '',
    teamName: data.team?.name ?? '',
    userId: data.authed_user.id,
    userName,
  }

  saveCredentials(creds)
  return creds
}

// Allow running as standalone script
const isMainModule = process.argv[1]?.endsWith('auth.ts') || process.argv[1]?.endsWith('auth.js')
if (isMainModule) {
  runOAuthFlow()
    .then((creds) => {
      console.log(`\nAuthenticated as ${creds.userName} in ${creds.teamName}`)
      console.log(`Credentials saved. Restart your Claude Code session to use them.`)
    })
    .catch((err: unknown) => {
      console.error('Auth failed:', err instanceof Error ? err.message : String(err))
      process.exit(1)
    })
}
