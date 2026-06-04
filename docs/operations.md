# Operations

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_APP_ID` | Yes | GitHub App numeric ID |
| `GITHUB_APP_PRIVATE_KEY` | Yes | PEM-formatted private key (newlines as `\n`) |
| `GITHUB_WEBHOOK_SECRET` | Yes (Phase 4+) | HMAC secret for webhook signature verification |
| `ALLOWED_REPOS` | Yes | Comma-separated list of `owner/repo` |
| `PORT` | No (default: 3000) | HTTP server port |
| `LOG_LEVEL` | No (default: `info`) | Log level: `debug`, `info`, `warn`, `error` |

## Running Locally

```bash
pnpm install
cp .env.example .env
# Fill in .env
pnpm run build
node dist/index.js
```

## Running with Docker

```bash
docker compose up --build
```

## Health Check

```
GET /health
→ { "status": "ok", "version": "0.1.0", "uptime": 42.1 }
```

## Token Source

```
POST /token-source
Content-Type: application/json
{ "owner": "myorg", "repo": "myrepo" }

→ { "token": "ghs_...", "expiresAt": "2026-01-01T00:00:00Z" }
```

Requires the repository to be on the allowlist.

## Logs

- All review operations are logged with `owner`, `repo`, `prNumber`, and `action`
- Tokens and private keys are never logged
- Log format: JSON (structured)

## Updating the Allowlist

Set `ALLOWED_REPOS` to a comma-separated list of `owner/repo` strings and restart the service.
There is no hot-reload in Phase 1; a restart is required.
