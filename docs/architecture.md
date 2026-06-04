# Architecture

## Overview

Thread Owl is structured as a single Node.js service that exposes three interfaces:

- **MCP server** — tools and subscriptions consumed by LLM frontends
- **Internal API** — HTTP endpoints for token brokering and status
- **Webhook receiver** — GitHub event ingestion (Phase 4+)

## Module Map

```
src/
  index.ts              entry point; wires up all subsystems
  config/               env validation and application config
  app-auth/             GitHub App JWT and installation token management
  github/               REST and GraphQL operations against GitHub API
  policy/               allowlist enforcement and per-repo policy
  webhook/              GitHub Webhook receiver and event handlers
  queue/                review candidate queue and delivery deduplication
  mcp/                  MCP server, tools, and subscription notifications
  internal-api/         health, token-source, and status endpoints
```

## Data Flow

```
GitHub Webhook
  → verify-signature
  → normalize-event
  → delivery-dedup
  → handler (pull-request / issue-comment / review / review-comment)
  → review-queue

MCP Client / LLM Frontend
  → MCP tool call (get_pr / list_review_threads / post_* / reply_* / resolve_*)
  → policy check (allowlist + repository-policy)
  → app-auth (token-cache → installation-token if expired)
  → github/rest or github/graphql
  → GitHub API

Internal API Client
  → token-source endpoint
  → policy check
  → app-auth
  → InstallationToken response
```

## GitHub App Authentication Flow

```
App private key (env)
  → generateAppJwt()         RS256 JWT, 10-minute lifetime
  → resolveInstallationId()  owner/repo → installation_id
  → getInstallationToken()   installation_id → token (1-hour lifetime)
  → TokenCache               avoid redundant token requests
```

## Key Design Decisions

- **NodeNext modules**: strict ESM, `.js` extensions in local imports
- **No LLM embedded**: Thread Owl is a proxy, not an AI system
- **unknown for external types in stubs**: replaced with real Octokit types in Phase 1
- **Allowlist as hard gate**: all operations check allowlist before touching GitHub API
