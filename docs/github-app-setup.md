# GitHub App Setup

## 1. Create the GitHub App

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App**
2. Fill in:
   - **GitHub App name**: `Thread Owl` (or your preferred name)
   - **Homepage URL**: your repository URL
   - **Webhook URL**: `https://<your-host>/webhook` (can be set later)
   - **Webhook secret**: generate a random secret and note it

## 2. Configure Permissions

Under **Repository permissions**:

| Permission | Level |
|-----------|-------|
| Metadata | Read-only |
| Contents | Read-only |
| Pull requests | Read & write |
| Issues | Read & write |

Do not grant any additional permissions at this stage.

## 3. Subscribe to Webhook Events

Enable these events (Phase 4):

- `Pull request`
- `Issue comment`
- `Pull request review`
- `Pull request review comment`

## 4. Generate a Private Key

1. Scroll to **Private keys** → **Generate a private key**
2. Download the `.pem` file
3. Store it securely — do NOT commit to git

## 5. Install the App

1. Go to **Install App** tab
2. Install on the target organization or specific repositories
3. Note the **Installation ID** from the URL after install

## 6. Configure Environment

Copy `.env.example` to `.env` and fill in:

```env
GITHUB_APP_ID=<your-app-id>
GITHUB_APP_PRIVATE_KEY=<contents-of-.pem-file-on-one-line>
GITHUB_WEBHOOK_SECRET=<your-webhook-secret>
ALLOWED_REPOS=owner/repo1,owner/repo2
```

For `GITHUB_APP_PRIVATE_KEY`, replace newlines with `\n` or use a multi-line env var depending on your deployment method.
