# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it through GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**. That channel is private between you and
the maintainers until a fix ships.

Expect an acknowledgement within a few working days. cccollab is maintained by
a small team, so please allow reasonable time for a fix before disclosing.

## Supported versions

Only the latest published release receives security fixes. There are no
long-term support branches.

## Scope

cccollab runs as a local stdio MCP server spawned by Claude Code, and
optionally connects to a remote Convex deployment over HTTPS. Reports that are
in scope include:

- Anything that lets one session read or write another session's messages
  without being subscribed to the relevant channel or topic.
- Token handling: `~/.cccollab/config.json` holds OAuth access and refresh
  tokens and is written with mode `0600`. Any path that leaks those tokens,
  writes them with looser permissions, or sends a bearer token over a
  non-HTTPS connection is in scope.
- Any way to make the local broker accept connections from outside the
  machine it runs on.
- Command or path injection reachable through configuration files, channel
  names, topic names, or message content.

Out of scope:

- Vulnerabilities in Claude Code itself. Report those to Anthropic.
- The hosted backend at `collab.kollaborativeai.com`, which is operated by
  Kollaborative AI and is not part of this repository.
- Anything requiring an attacker who already has local code execution as your
  user. At that point they can read the config file directly.

## What we will not treat as a vulnerability

Credential fields committed to a project-level `.cccollab.json` are stripped at
load time, by design. Committing secrets to your own repository is still your
responsibility.
