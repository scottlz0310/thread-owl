# Roadmap

## Phase 0 — Repository Initialization ✓

Development baseline: TypeScript, pnpm, Biome, Vitest, lefthook, Renovate, CI, Docker skeleton.

**Done when:** `pnpm install --frozen-lockfile && pnpm run check && pnpm test && pnpm run build` passes in CI.

## Phase 1 — GitHub App Authentication MVP

- GitHub App JWT generation (RS256)
- `installation_id` resolution from owner/repo
- Installation token issuance
- Token cache with expiry tracking
- Env schema validation (zod)
- Health endpoint
- Minimal CLI or internal API

**Done when:** private key → App JWT → installation token → read target repo basic info works end-to-end.

## Phase 2 — Review Operations MVP

- PR info fetch (title, body, draft status, head/base SHAs)
- Changed files fetch
- Review threads list (GraphQL)
- Summary comment post
- Inline review comment post
- Review thread reply
- Review thread resolve
- Allowlist + permission checks on all write operations

**Done when:** reviewer personal account can be removed as org member / collaborator.

## Phase 3 — MCP Integration

- MCP server with stdio transport
- `get_pr`, `list_review_threads`, `post_summary_comment`, `post_inline_comment`, `reply_review_thread`, `resolve_review_thread` tools
- `token-source` endpoint for MCP clients that need direct token access
- Migration guide from existing `copilot-review-mcp` usage

**Done when:** Claude Desktop / ChatGPT Project can perform semi-automated reviews via MCP tools.

## Phase 4 — Webhook Receiver

- Hono-based HTTP server
- Signature verification, delivery dedup, bot loop prevention
- `pull_request`, `issue_comment`, `pull_request_review`, `pull_request_review_comment` handlers
- Review candidate queue

**Done when:** PR open / push events reliably enter the review queue.

## Phase 5 — Subscribe Notifications

- MCP subscription endpoint
- Review-ready, re-review, stale-thread notifications
- Queue status notifications

**Done when:** MCP clients receive notifications without polling.

## Phase 6 — Controlled Automation

- Per-repo config (label trigger, draft skip, skip label)
- `dry-run` mode, `require-human-approval` mode, `summary-only` mode

## Phase 7 — API LLM Worker (opt-in)

- LLM provider abstraction (OpenAI / Anthropic)
- Diff chunking, review severity classification
- Posting policy, retry/budget control, audit log
