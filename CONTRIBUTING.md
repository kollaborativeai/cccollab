# Contributing to cccollab

## Layout

A yarn 4 monorepo. One published workspace:

| Path          | What it is                                                                            |
| ------------- | ------------------------------------------------------------------------------------- |
| `mcp_server/` | The stdio MCP server Claude Code spawns per session. Broker, transports, tools.       |
| `plugin/`     | The Claude Code plugin bundle. Not a workspace; its version rides with `mcp_server/`. |
| `cctree/`     | A Python prototype. See `cctree/README.md` — it does not run out of the box.          |
| `test/`       | A manual two-session end-to-end harness.                                              |

The Convex backend is **not** in this repo. New queries and mutations go in
Kollaborative AI's repository — see `docs/architecture/mcp-servers.md`.

## Setup

```bash
yarn install
yarn build
```

## Checks

Run these before opening a pull request. CI runs the same five.

```bash
yarn test          # vitest
yarn typecheck     # tsc --noEmit across workspaces
yarn lint          # eslint
yarn format:check  # prettier
yarn build
```

`cctree`'s tests are Python and are not part of `yarn test`:

```bash
cd cctree && python3 -m unittest test_cctree -v
```

For a real two-session run, see `test/README.md`.

## Commits

Use [conventional commits](https://www.conventionalcommits.org/). The release
workflow derives the version bump from commit prefixes, so this is not
cosmetic: `feat:` produces a minor bump, `fix:`/`docs:`/`chore:` a patch.

Do not edit `version` in `mcp_server/package.json` or
`plugin/.claude-plugin/plugin.json` by hand — CI owns both.

Do not bypass the pre-commit hook. It runs eslint, prettier and the full test
suite on staged files, and it is the check most likely to catch a problem
before review.

## Tests are required

Every behaviour change needs a test. The suite is the only thing standing
between a transport bug and a silent message loss, and transport bugs are the
most common defect in this codebase.

## Branding

`mcp_server/tests/branding.test.ts` fails the build on references to the
project's former owner or to unrelated company names. If it flags your change,
fix the reference rather than extending the allowlist.

## Pull requests

Target `main`. Keep one logical change per pull request. If your change builds
on another that hasn't merged, stack it rather than bundling the two.
