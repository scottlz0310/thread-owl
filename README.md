# Thread Owl

A GitHub App backend for AI-assisted pull request review threads.

## Overview

Thread Owl provides bot identity, installation-token handling, repository allowlisting, webhook entry points, and review-thread operations for AI-assisted PR workflows.

The primary goal is to move PR review operations (comment posting, thread reply, resolve, summary) from personal GitHub accounts to a GitHub App installation, eliminating the need for a dedicated reviewer account as an organization member or repository collaborator.

## Design Principles

- **GitHub App as posting identity** — all review operations use installation tokens, not personal access tokens
- **LLM-agnostic** — Thread Owl does not contain or run an LLM; it serves as the auth/posting layer for ChatGPT, Claude, Codex, and other frontends
- **Semi-automated first** — full automation is opt-in and comes later; initial focus is on stable review operations with human approval

## Architecture

```
LLM Frontends (ChatGPT / Claude / Codex)
        ↓ MCP tools / internal API
Thread Owl
  ├─ GitHub App Auth (JWT → installation token → cached)
  ├─ Repository Policy (allowlist, per-repo config)
  ├─ Review Operations (get PR, list threads, post comment, reply, resolve)
  ├─ Webhook Receiver (signature verify, dedup, event normalize, queue insert)
  ├─ MCP Server (tools + subscriptions)
  └─ Internal API (health, token-source, status)
        ↓ GitHub REST / GraphQL API
GitHub
```

## Roadmap

| Phase | Description |
|-------|-------------|
| 0 | Repository initialization (current) |
| 1 | GitHub App authentication MVP |
| 2 | Review operations MVP |
| 3 | MCP integration |
| 4 | Webhook receiver |
| 5 | Subscribe notifications |
| 6 | Controlled automation |
| 7 | API LLM worker (opt-in) |

## Requirements

- Node.js >= 20.0.0
- pnpm

## Setup

```bash
pnpm install
cp .env.example .env
# Fill in .env with your GitHub App credentials
```

## Development

```bash
pnpm run check      # Biome lint + format check
pnpm run typecheck  # TypeScript type check
pnpm test           # Run tests
pnpm run build      # Compile to dist/
```

## GitHub App Permissions

Minimum required permissions:

| Permission | Level |
|-----------|-------|
| Metadata | Read |
| Contents | Read |
| Pull requests | Read & Write |
| Issues | Read & Write |

See [docs/permissions.md](docs/permissions.md) for details.

## Security

- GitHub App private key must be set via environment variable, never committed
- Webhook signature verification is mandatory
- Repository allowlist is enforced for all operations
- See [docs/security.md](docs/security.md) for the full security policy

## License

MIT
