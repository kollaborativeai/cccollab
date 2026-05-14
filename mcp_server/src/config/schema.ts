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

/** New Clerk PKCE flow — strict variant for project-level config.
 *
 *  `clerkIssuer` and `clerkClientId` are required here: a project-level
 *  `.cccollab.json` that declares a Clerk location must supply the
 *  app-pointer fields so the team can share them via source control. */
const ClerkLocationSchema = z
  .object({
    ...BaseLocationFields,
    authType: z.literal('clerk'),
    clerkIssuer: z.string(),
    clerkClientId: z.string(),
    clerkRedirectPort: z.number().int().positive().optional(),
    accessToken: z.string().optional(),
    refreshToken: z.string().optional(),
    accessTokenExpiresAt: z.number().optional(),
  })
  .strict()

/** Clerk location variant for user-level config (`~/.cccollab/config.json`).
 *
 *  `clerkIssuer` and `clerkClientId` are optional here because the user-level
 *  file stores only credential fields plus the `authType` discriminator after
 *  `saveLocationAuth` writes tokens.  The app-pointer fields come from the
 *  project-level `.cccollab.json` and are merged in at runtime.  Using this
 *  relaxed variant for `readExisting` in `save.ts` prevents a round-trip
 *  parse failure on the user-level file. */
const ClerkUserLocationSchema = z
  .object({
    ...BaseLocationFields,
    authType: z.literal('clerk'),
    clerkIssuer: z.string().optional(),
    clerkClientId: z.string().optional(),
    clerkRedirectPort: z.number().int().positive().optional(),
    accessToken: z.string().optional(),
    refreshToken: z.string().optional(),
    accessTokenExpiresAt: z.number().optional(),
  })
  .strict()

// Order matters: ClerkLocationSchema first so a payload with
// authType: 'clerk' binds its required clerkIssuer/clerkClientId
// before the convex-google fallback is attempted. Reordering or
// inserting a more permissive predecessor would silently drop
// Clerk-required fields.
//
// Plain z.union (not z.discriminatedUnion): the legacy branch's
// authType is optional for back-compat with pre-existing
// ~/.cccollab/config.json files, which z.discriminatedUnion does
// not support (it requires the discriminator literal on every
// branch).
export const LocationConfigSchema = z.union([ClerkLocationSchema, ConvexGoogleLocationSchema])

/** Schema for the user-level `~/.cccollab/config.json` file. Uses the relaxed
 *  Clerk location variant so that files written by `saveLocationAuth` (which
 *  omits `clerkIssuer` / `clerkClientId`) continue to parse successfully on
 *  the next re-read. */
export const UserLocationConfigSchema = z.union([ClerkUserLocationSchema, ConvexGoogleLocationSchema])

export const CccollabConfigSchema = z
  .object({
    name: z.string().optional(),
    objective: z.string().optional(),
    locations: z.record(z.string(), LocationConfigSchema).optional(),
  })
  .strict()

/** Schema variant used when reading `~/.cccollab/config.json`. Identical to
 *  `CccollabConfigSchema` except Clerk locations don't require the app-pointer
 *  fields (`clerkIssuer`, `clerkClientId`) — those live in the project config. */
export const UserCccollabConfigSchema = z
  .object({
    name: z.string().optional(),
    objective: z.string().optional(),
    locations: z.record(z.string(), UserLocationConfigSchema).optional(),
  })
  .strict()

export type TopicConfig = z.infer<typeof TopicConfigSchema>
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>
export type LocationConfig = z.infer<typeof LocationConfigSchema>
export type UserLocationConfig = z.infer<typeof UserLocationConfigSchema>
export type CccollabConfig = z.infer<typeof CccollabConfigSchema>

/** Reserved name for the in-process broker location. Always implicitly
 *  available even without an entry in `locations`. */
export const LOCAL_LOCATION = 'local'

/** Fields that represent persisted OAuth state. They are recognised on
 *  every location but are stripped from project-level configs (with one
 *  `console.error` per occurrence) so secrets never leak into a repo.
 *
 *  `accessTokenExpiresAt` is included because it is a credential field
 *  (the expiry of a short-lived access token) and must not appear in a
 *  project-level config. `authType`, `clerkIssuer`, and `clerkClientId`
 *  are configuration (not credentials) and are intentionally excluded so
 *  teams can share the Clerk app pointer via a committed `.cccollab.json`. */
export const AUTH_FIELDS = [
  'accessToken',
  'refreshToken',
  'userEmail',
  'userId',
  'updatedAt',
  'accessTokenExpiresAt',
] as const
export type AuthField = (typeof AUTH_FIELDS)[number]
