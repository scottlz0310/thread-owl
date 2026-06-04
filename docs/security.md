# Security

## Threat Model

Thread Owl handles GitHub App private keys and installation tokens.
The primary risks are:

1. **Private key exposure** — enables impersonating the App on all installed repos
2. **Token leakage** — short-lived but must not appear in logs
3. **Unauthorized operations** — posting/resolving comments on repos outside the allowlist
4. **Webhook spoofing** — processing forged webhook payloads
5. **Bot loop** — App reacting to its own comments, causing infinite loops

## Mitigations

### Private Key Management

- Private key is loaded from environment variable or secret store only
- Never committed to the repository (`.gitignore` includes `*.pem`)
- Key rotation requires restarting the service with a new env var

### Token Handling

- Installation tokens have a 1-hour lifetime; treat them as short-lived secrets
- Tokens are never logged (even at debug level)
- Token cache evicts entries before expiry

### Allowlist Enforcement

- `ALLOWED_REPOS` must be explicitly set; empty list blocks all operations
- Allowlist check runs before any GitHub API call
- Allowlist is validated at startup

### Webhook Signature Verification

- All incoming webhooks are verified with HMAC-SHA256 using `GITHUB_WEBHOOK_SECRET`
- Requests with missing or invalid signatures are rejected with 401
- Verification uses constant-time comparison to prevent timing attacks

### Delivery Deduplication

- GitHub may deliver the same webhook event multiple times
- Delivery IDs are tracked in a time-bounded set to suppress duplicates

### Bot Loop Prevention

- Before processing any event, the sender login is checked against the App's slug
- Events originating from the App itself are dropped before handler dispatch

### Destructive Operations

- No delete, close, or merge operations are implemented in Phase 0–3
- Any future destructive operation requires explicit allowlist and policy check
