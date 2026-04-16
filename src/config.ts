import { z } from 'zod'
import type { Config } from './types.js'

const envSchema = z.object({
  SLACK_BOT_TOKEN: z
    .string({ error: 'SLACK_BOT_TOKEN is required' })
    .min(1, 'SLACK_BOT_TOKEN is required'),
  SLACK_APP_TOKEN: z
    .string({ error: 'SLACK_APP_TOKEN is required' })
    .min(1, 'SLACK_APP_TOKEN is required'),
  USERNAME: z
    .string({ error: 'USERNAME is required' })
    .min(1, 'USERNAME is required'),
  SLACK_USER_TOKEN: z.string().optional(),
  SESSION_ROLE: z.string().optional(),
  REGISTRY_CHANNEL: z.string().optional(),
})

export function loadConfig(): Config {
  const result = envSchema.safeParse(process.env)

  if (!result.success) {
    const errors = result.error.issues.map((i) => i.message).join(', ')
    throw new Error(`Invalid configuration: ${errors}`)
  }

  return {
    slackBotToken: result.data.SLACK_BOT_TOKEN,
    slackAppToken: result.data.SLACK_APP_TOKEN,
    slackUserToken: result.data.SLACK_USER_TOKEN,
    username: result.data.USERNAME,
    sessionRole: result.data.SESSION_ROLE,
    registryChannel: result.data.REGISTRY_CHANNEL ?? 'ai-collab-registry',
  }
}
