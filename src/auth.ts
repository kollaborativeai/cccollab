#!/usr/bin/env npx tsx
/**
 * OAuth flow to get a per-user Slack token.
 * Run: npx tsx src/auth.ts
 *
 * Opens your browser for Slack authorization, captures the callback,
 * exchanges the code for a user token, and prints it.
 */

import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { URL } from 'node:url'

const CLIENT_ID = '8752610368039.10920903346339'
const CLIENT_SECRET = '218468445052a9696ccea85d8a857d84'
const REDIRECT_URI = 'http://localhost:9876/oauth/callback'
const PORT = 9876

async function main() {
  const authUrl = `https://slack.com/oauth/v2/authorize?client_id=${CLIENT_ID}&user_scope=chat:write&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`

  console.log('Opening browser for Slack authorization...')
  console.log(`If it doesn't open, visit: ${authUrl}\n`)

  // Open browser
  try {
    execFileSync('open', [authUrl], { stdio: 'ignore' })
  } catch {
    // Not on macOS or open failed - user will use the URL above
  }

  // Start local server to capture the callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404)
        res.end('Not found')
        return
      }

      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<h1>Authorization denied</h1><p>You can close this tab.</p>')
        server.close()
        reject(new Error(`OAuth error: ${error}`))
        return
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<h1>Missing code</h1>')
        server.close()
        reject(new Error('No code in callback'))
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<h1>Authorized!</h1><p>You can close this tab and return to the terminal.</p>')
      server.close()
      resolve(code)
    })

    server.listen(PORT, '127.0.0.1', () => {
      console.log(`Waiting for OAuth callback on port ${PORT}...`)
    })

    // Timeout after 2 minutes
    setTimeout(() => {
      server.close()
      reject(new Error('Timed out waiting for OAuth callback'))
    }, 120_000)
  })

  // Exchange code for token
  console.log('Exchanging code for token...')

  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  })

  const data = await response.json() as {
    ok: boolean
    error?: string
    authed_user?: { id: string; access_token: string }
    team?: { id: string; name: string }
  }

  if (!data.ok) {
    console.error('OAuth token exchange failed:', data.error)
    process.exit(1)
  }

  const userToken = data.authed_user?.access_token
  const userId = data.authed_user?.id
  const teamName = data.team?.name

  console.log('\nSuccess!')
  console.log(`  Workspace: ${teamName}`)
  console.log(`  User ID:   ${userId}`)
  console.log(`  Token:     ${userToken}`)
  console.log('\nAdd this to your MCP server config as SLACK_USER_TOKEN:')
  console.log(`  claude mcp remove claudecode-slack-collab -s user`)
  console.log(`  claude mcp add -s user claudecode-slack-collab \\`)
  console.log(`    -e SLACK_BOT_TOKEN=<bot-token> \\`)
  console.log(`    -e SLACK_APP_TOKEN=<app-token> \\`)
  console.log(`    -e SLACK_USER_TOKEN=${userToken} \\`)
  console.log(`    -e USERNAME=<your-name> \\`)
  console.log(`    -e REGISTRY_CHANNEL=ai-collab-registry \\`)
  console.log(`    -- npx tsx /Users/stefan/projects/claudecode-slack-collab/src/server.ts`)
}

main().catch((err) => {
  console.error('Auth failed:', err.message)
  process.exit(1)
})
