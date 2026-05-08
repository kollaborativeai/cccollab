import type { AuthConfig } from 'convex/server'

/**
 * Convex Auth's JWT configuration.
 *
 * The `domain` is the Convex deployment's HTTP actions URL (`*.convex.site`),
 * which is the issuer of the JWTs signed by `@convex-dev/auth`. Convex injects
 * `CONVEX_SITE_URL` into every deployment automatically.
 */
export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL!,
      applicationID: 'convex',
    },
  ],
} satisfies AuthConfig
