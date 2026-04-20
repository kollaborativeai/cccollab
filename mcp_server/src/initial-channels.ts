import { readFileSync } from 'node:fs'
import path from 'node:path'
import { normalizeChannelName } from './context.js'

export const CHANNELS_FILE_NAME = '.cccollab.json'
const CHANNELS_ENV_VAR = 'CCCOLLAB_DEFAULT_CHANNELS'
const FALLBACK_CHANNEL = 'default'

export type InitialChannels =
  | { channels: string[]; source: 'env' | 'cccollab.json' }
  | { channels: ['default']; source: 'fallback' }

/**
 * Resolve the set of channels a session should auto-join on startup.
 *
 * Precedence:
 *   1. CCCOLLAB_DEFAULT_CHANNELS env var (if defined; empty string counts as "explicit none")
 *   2. default_channels in .cccollab.json (walked up from cwd; empty array counts as "explicit none")
 *   3. Fallback to ['default']
 *
 * Malformed JSON, non-object JSON, and malformed default_channels values are logged
 * and treated as absent so a bad config never prevents startup.
 */
export function resolveInitialChannels(cwd: string, env: NodeJS.ProcessEnv = process.env): InitialChannels {
  if (CHANNELS_ENV_VAR in env) {
    return { channels: parseCsv(env[CHANNELS_ENV_VAR] ?? ''), source: 'env' }
  }

  const fromFile = readChannelsFile(cwd)
  if (fromFile) return { channels: fromFile, source: 'cccollab.json' }

  return { channels: [FALLBACK_CHANNEL], source: 'fallback' }
}

function parseCsv(raw: string): string[] {
  const parts = raw.split(',').map((p) => normalizeChannelName(p))
  return dedupe(parts.filter((p) => p.length > 0))
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

function readChannelsFile(startDir: string): string[] | undefined {
  let dir = path.resolve(startDir)
  while (true) {
    const candidate = path.join(dir, CHANNELS_FILE_NAME)
    const parsed = tryReadJsonObject(candidate)
    if (parsed !== 'missing') {
      if (parsed === 'abort') return undefined
      if ('default_channels' in parsed) {
        const value = parsed.default_channels
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
          console.error(`[cccollab] ${candidate} has malformed "default_channels" (expected string[]), ignoring`)
          return undefined
        }
        return dedupe(value.map((v) => normalizeChannelName(v)).filter((v) => v.length > 0))
      }
    }

    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

type ReadResult = 'missing' | 'abort' | Record<string, unknown>

function tryReadJsonObject(file: string): ReadResult {
  let raw: string
  try {
    raw = readFileSync(file, 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return 'missing'
    console.error(`[cccollab] Failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`)
    return 'abort'
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.error(`[cccollab] ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    return 'abort'
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`[cccollab] ${file} is not a JSON object, ignoring`)
    return 'abort'
  }

  return parsed as Record<string, unknown>
}
