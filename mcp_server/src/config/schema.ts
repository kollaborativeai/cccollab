import * as z from 'zod'

/**
 * Unified cccollab configuration schema.
 *
 * The same shape is accepted from both `~/.cccollab/config.json` (user-level)
 * and `.cccollab.json` (project-level, discovered by walking up from the
 * current working directory). See `src/config/resolve.ts` for the load /
 * merge / cascade pipeline that turns both files plus environment
 * variables into the `ResolvedConfig` consumed by `server.ts`.
 *
 * Identifiers are referenced by name throughout:
 *
 * - Top-level `locations` is a record keyed by location name. The key
 *   `"local"` is reserved: it refers to the in-process broker and is
 *   always implicitly available even when absent from the config. All
 *   other locations need a `url` at validation time.
 * - `channels` is a record keyed by channel name, per location.
 * - `topics` is a record keyed by topic name, per channel.
 *
 * Active state cascades: if a topic has `active: true`, its enclosing
 * channel and location are considered active even if their own `active`
 * flag is omitted. The cascade + "exactly one active at each level"
 * rule is enforced during validation, not here in the shape schema.
 *
 * Auth fields (`accessToken`, `refreshToken`, `userEmail`, `userId`,
 * `updatedAt`) are recognised on every location but are silently
 * stripped when they appear in a project-level config (with one warning
 * per occurrence). See `src/config/merge.ts`.
 */

export const TopicConfigSchema = z
  .object({
    active: z.boolean().optional(),
  })
  .strict()

export const ChannelConfigSchema = z
  .object({
    active: z.boolean().optional(),
    topics: z.record(z.string(), TopicConfigSchema).optional(),
  })
  .strict()

const BaseLocationFields = {
  url: z.string().optional(),
  active: z.boolean().optional(),
  userEmail: z.string().optional(),
  userId: z.string().optional(),
  updatedAt: z.number().optional(),
  channels: z.record(z.string(), ChannelConfigSchema).optional(),
}

/** Existing Convex Auth flow (Google OAuth → Convex Auth tokens). */
const ConvexGoogleLocationSchema = z
  .object({
    ...BaseLocationFields,
    authType: z.literal('convex-google').optional(), // optional for back-compat
    accessToken: z.string().optional(),
    refreshToken: z.string().optional(),
  })
  .strict()

/** New Clerk PKCE flow. */
const ClerkLocationSchema = z
  .object({
    ...BaseLocationFields,
    authType: z.literal('clerk'),
    clerkIssuer: z.string(),
    clerkClientId: z.string(),
    accessToken: z.string().optional(),
    refreshToken: z.string().optional(),
    accessTokenExpiresAt: z.number().optional(),
  })
  .strict()

export const LocationConfigSchema = z.union([ClerkLocationSchema, ConvexGoogleLocationSchema])

export const CccollabConfigSchema = z
  .object({
    name: z.string().optional(),
    objective: z.string().optional(),
    locations: z.record(z.string(), LocationConfigSchema).optional(),
  })
  .strict()

export type TopicConfig = z.infer<typeof TopicConfigSchema>
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>
export type LocationConfig = z.infer<typeof LocationConfigSchema>
export type CccollabConfig = z.infer<typeof CccollabConfigSchema>

/** Reserved name for the in-process broker location. Always implicitly
 *  available even without an entry in `locations`. */
export const LOCAL_LOCATION = 'local'

/** Fields that represent persisted OAuth state. They are recognised on
 *  every location but are stripped from project-level configs (with one
 *  `console.error` per occurrence) so secrets never leak into a repo. */
export const AUTH_FIELDS = ['accessToken', 'refreshToken', 'userEmail', 'userId', 'updatedAt'] as const
export type AuthField = (typeof AUTH_FIELDS)[number]
