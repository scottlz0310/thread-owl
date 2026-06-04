# Permissions

## GitHub App Permissions

### Initial (Phase 1–3)

| Scope | Level | Reason |
|-------|-------|--------|
| Metadata | Read | Required for all API access |
| Contents | Read | Read PR diff and file contents |
| Pull requests | Read & Write | Post review comments, reply to threads, resolve |
| Issues | Read & Write | Post summary comments (issue comment endpoint) |

### Added as needed (Phase 4+)

| Scope | Level | Reason |
|-------|-------|--------|
| Checks | Read | Monitor CI status on PR |
| Actions | Read | Monitor workflow runs |
| Commit statuses | Read | Check commit status |

### Never granted

- Any `admin` permission
- `Members` permission
- `Organization administration`
- Anything outside the review workflow scope

## Principle of Least Privilege

Thread Owl starts with the minimum permissions required for Phase 1–3.
Additional permissions are only requested when a concrete use case requires them,
and are explicitly documented here with justification.

## Repository Allowlist

Even with permissions granted via GitHub App installation, Thread Owl enforces
an additional allowlist via `ALLOWED_REPOS` environment variable.

Any operation targeting a repository not on the allowlist is rejected before
the GitHub API is called.
