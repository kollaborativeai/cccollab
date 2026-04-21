// Clerk JWT issuer config consumed by Convex's built-in auth layer.
// The domain is read from env so the same code runs against dev / prod Clerk instances.
// See https://docs.convex.dev/auth/clerk for the setup expected on the Clerk side.

const domain = process.env.CLERK_JWT_ISSUER_DOMAIN ?? 'https://example.clerk.accounts.dev'

export default {
  providers: [
    {
      domain,
      applicationID: 'convex',
    },
  ],
}
