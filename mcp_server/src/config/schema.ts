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
 * Auth credential fields (`accessToken`, `refreshToken`,
 * `accessTokenExpiresAt`, `userEmail`, `userId`, `updatedAt`) are
 * recognised on every location but are silently stripped when they
 * appear in a project-level config (with one warning per occurrence).
 * See `src/config/merge.ts`. The Clerk *app pointer* fields
 * (`authType`, `clerkIssuer`, `clerkClientId`, `clerkRedirectPort`) are
 * configuration rather than credentials and stay on project-level
 * configs.
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

/** Clerk PKCE location shape. All Clerk-specific fields are optional at the
 *  schema layer; the actual "Clerk auth must be configured to use this
 *  location" requirement is enforced at the use-site (`transport/attach.ts`
 *  and `tools/identity.ts`) where a clearer error message can be produced
 *  than a generic schema rejection. This keeps `~/.cccollab/config.json`
 *  parseable after `saveLocationAuth` writes credential-only entries that
 *  don't carry the project-level `clerkIssuer` / `clerkClientId` pointer. */
const LocationConfigFields = {
  ...BaseLocationFields,
  authType: z.literal('clerk').optional(),
  clerkIssuer: z.string().optional(),
  clerkClientId: z.string().optional(),
  clerkRedirectPort: z.number().int().positive().optional(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  /** OIDC ID token (JWT). This is what authenticates Convex — its `aud`
   *  claim is the OAuth Client ID, which the deployment's auth.config.ts
   *  registers as a provider. The access token carries no usable `aud` and
   *  is never sent to Convex. */
  idToken: z.string().optional(),
  accessTokenExpiresAt: z.number().optional(),
}

/** Project-level (`.cccollab.json`) location shape — `.strict()` so typos in a
 *  committed config surface as errors rather than being silently ignored. */
export const LocationConfigSchema = z.object(LocationConfigFields).strict()

/** User-level (`~/.cccollab/config.json`) location shape — `.passthrough()`
 *  instead of strict, and the difference is load-bearing: when a NEWER cccollab
 *  version writes a credential field this version doesn't know yet (exactly how
 *  `idToken` was introduced), an OLDER version sharing the same file must still
 *  load it. Strict parsing would throw "failed schema validation" on read,
 *  which blocks every read AND write for the old binary until the field is
 *  removed. Passthrough preserves unknown keys through read-modify-write so
 *  future credential additions can't brick a side-by-side installed version. */
export const UserLocationConfigSchema = z.object(LocationConfigFields).passthrough()

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
  // `.passthrough()` for the same cross-version-skew reason as
  // `UserLocationConfigSchema`: a newer version adding a top-level field must
  // not brick an older one reading the shared user config.
  .passthrough()

export type TopicConfig = z.infer<typeof TopicConfigSchema>
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>
export type LocationConfig = z.infer<typeof LocationConfigSchema>
export type UserLocationConfig = z.infer<typeof UserLocationConfigSchema>
export type CccollabConfig = z.infer<typeof CccollabConfigSchema>
export type UserCccollabConfig = z.infer<typeof UserCccollabConfigSchema>

/** Reserved name for the in-process broker location. Always implicitly
 *  available even without an entry in `locations`. */
export const LOCAL_LOCATION = 'local'

/** Fields that represent persisted credentials. They are recognised on
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
  'idToken',
  'userEmail',
  'userId',
  'updatedAt',
  'accessTokenExpiresAt',
] as const
export type AuthField = (typeof AUTH_FIELDS)[number]
