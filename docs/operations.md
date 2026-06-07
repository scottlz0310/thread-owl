# 運用ガイド

## 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `GITHUB_APP_ID` | 必須 | GitHub App の数値 ID |
| `GITHUB_APP_PRIVATE_KEY_FILE` | 秘密鍵のいずれか1つ | `.pem` のファイルパス（ローカル開発推奨） |
| `GITHUB_APP_PRIVATE_KEY_B64` | 秘密鍵のいずれか1つ | `.pem` を base64 化した1行（Bitwarden / dsx 注入推奨） |
| `GITHUB_APP_PRIVATE_KEY` | 秘密鍵のいずれか1つ | PEM の改行を `\n` でエスケープした1行（後方互換・脆弱） |
| `GITHUB_WEBHOOK_SECRET` | `--webhook` モードで必須 | Webhook 署名検証用 HMAC シークレット |
| `ALLOWED_REPOS` | 必須 | `owner/repo` 形式をカンマ区切りで列挙（空なら全 write 拒否） |
| `APP_SLUG` | 任意（デフォルト: `thread-owl`） | GitHub App の slug。自 App bot イベントのループ防止に使用。App 名を変えた場合は必ず設定する |
| `PORT` | 任意（デフォルト: 3000） | HTTP サーバーポート |
| `HOST` | 任意（デフォルト: 127.0.0.1） | HTTP サーバー bind アドレス |
| `MCP_HTTP_PATH` | 任意（デフォルト: `/mcp`） | Streamable HTTP MCP endpoint のパス |
| `LOG_LEVEL` | 任意（デフォルト: `info`） | ログレベル: `trace` / `debug` / `info` / `warn` / `error` |

秘密鍵は `*_FILE` > `*_B64` > `*`（raw）の優先順位で解決する。詳細は [github-app-setup.md](./github-app-setup.md) を参照。

## ローカル実行

```bash
pnpm install
cp .env.example .env
# .env を編集して認証情報を記入する
pnpm run build

# 内部 API サーバー（HTTP）
node dist/index.js

# MCP server（stdio）
node dist/index.js --mcp

# MCP server（Streamable HTTP）
node dist/index.js --mcp-http

# Webhook 受信サーバー
node dist/index.js --webhook
```

## Docker で実行

```bash
# 内部 API サーバーのみ
docker compose up thread-owl --build

# Webhook 受信サーバーのみ
docker compose up thread-owl-webhook --build

# 両方同時に起動
docker compose up --build
```

各サービスのデフォルトポート:

| サービス | ポート | 用途 |
|---------|--------|------|
| `thread-owl` | 3000 | 内部 API（`/health`・`/status`・`/token`） |
| `thread-owl-webhook` | 3001 | Webhook 受信（`POST /webhook`） |

## ヘルスチェック

```
GET /health
→ { "status": "ok", "version": "0.1.0", "uptime": 42.1 }
```

## Token Source（内部 API）

allowlist 登録済みリポジトリの installation token を取得する:

```
GET /token?owner=<owner>&repo=<repo>

→ { "token": "ghs_...", "expiresAt": "2026-01-01T00:00:00Z" }
```

- allowlist 外リポジトリは `403`（token 発行前に拒否）
- App 未インストールのリポジトリは `404`
- token は secret。既定で `127.0.0.1` bind。HTTP 公開時は別途 caller 認証（API key 等）を必須にすること

## MCP server

起動モードは排他的であり、`--mcp` と `--mcp-http` を同時指定すると起動に失敗する。

| 起動方法 | モード | 用途 |
|----------|--------|------|
| `node dist/index.js` | internal API | `/health`・`/status`・`/token` |
| `node dist/index.js --mcp` | stdio MCP | local-only / trusted local client |
| `node dist/index.js --mcp-http` | Streamable HTTP MCP | mcp-gateway からの内部接続 |
| `node dist/index.js --webhook` | Webhook 受信 | GitHub App Webhook イベントの受信・キュー投入 |

各モードは排他的であり、複数フラグの同時指定は起動失敗する。

### stdio

stdio transport の MCP server を起動し、review tools を MCP クライアント（Claude Desktop / Claude Code / ChatGPT Project 等）へ提供する:

```bash
node dist/index.js --mcp
```

提供する tools:

| tool | 説明 |
|------|------|
| `get_pr` | PR 基本情報と変更ファイル一覧 |
| `list_review_threads` | レビュースレッド一覧（resolved/outdated・コメント含む） |
| `post_summary_comment` | PR サマリーコメント投稿 |
| `post_inline_comment` | インラインレビューコメント投稿 |
| `reply_review_thread` | レビュースレッドへ返信 |

- 各 tool は `owner`/`repo` から installation token を都度発行する（allowlist ゲートが token 発行時に効くため、allowlist 外リポジトリは read/write とも拒否される）
- MCP stdio モードではログを stderr に出力する（stdout は JSON-RPC 専用のため）
- review thread の resolve は、PR author または repository write access を持つ修正側が `github-mcp` / `copilot-review-mcp`（MCP server 登録名: `copilot-review`）等で行う

### Streamable HTTP

Streamable HTTP transport を起動する:

```bash
HOST=127.0.0.1 PORT=3000 node dist/index.js --mcp-http
```

- endpoint は `http://127.0.0.1:3000/mcp`
- MCP session ID ごとに独立した `McpServer` と `StreamableHTTPServerTransport` を生成する
- session の DELETE、transport close、HTTP server shutdown 時に session を破棄する
- 既定 bind は `127.0.0.1`。Thread Owl の Streamable HTTP endpoint を直接 public exposure する構成は非対応
- caller 認証は mcp-gateway の責務であり、Thread Owl 側の Bearer 認証は本実装に含まれない
- mcp-gateway と別コンテナで接続する場合のみ、private Docker network 内で `HOST=0.0.0.0` とし、Thread Owl の port をホストへ publish しない

mcp-gateway から指定する内部 URL の例:

```text
http://thread-owl:3000/mcp
```

Claude Desktop の設定例（`claude_desktop_config.json`）:

```json
{
  "mcpServers": {
    "thread-owl": {
      "command": "node",
      "args": ["/path/to/thread-owl/dist/index.js", "--mcp"],
      "env": {
        "GITHUB_APP_ID": "...",
        "GITHUB_APP_PRIVATE_KEY_FILE": "/path/to/github-app.pem",
        "GITHUB_WEBHOOK_SECRET": "...",
        "ALLOWED_REPOS": "owner/repo"
      }
    }
  }
}
```

## ログ

- レビュー操作はすべて `owner`・`repo`・`prNumber`（または `threadId`）・`action` を含めて記録する
- token・private key・コメント body 全文はログに出力しない
- ログフォーマット: JSON（構造化ログ）

## Allowlist の更新

`ALLOWED_REPOS` を新しい `owner/repo` のカンマ区切りリストに設定してサービスを再起動する。
ホットリロードには対応していないため、再起動が必要である。

## レビュアー個人アカウントから GitHub App への移行

疑似チーム開発でレビュー用の別個人アカウントを organization の member / collaborator として維持している場合、Thread Owl (GitHub App) 権限へ移行することで、シート課金・PAT 管理・権限境界の曖昧さを解消できる。

### 移行チェックリスト

1. **GitHub App セットアップ**: [github-app-setup.md](./github-app-setup.md) に従い App を作成・権限設定・秘密鍵取得し、対象リポジトリを所有する organization にインストールする。
2. **`.env` 設定**: `GITHUB_APP_ID` / 秘密鍵（`*_FILE` 推奨）/ `GITHUB_WEBHOOK_SECRET` / `ALLOWED_REPOS` を設定する。
3. **Thread Owl 動作確認**:
   - `GET /token?owner=...&repo=...` が allowlist 内リポジトリで `200` + installation token を返す。
   - `node dist/index.js --mcp` が起動し、MCP クライアントから tools が見える。
   - `get_pr` / `list_review_threads` で PR・レビュースレッドが取得できる。
   - `post_summary_comment` / `post_inline_comment` / `reply_review_thread` が **App 権限で**投稿・返信できる（コメント author が `<app-slug>[bot]` になる）。
4. **allowlist 外の拒否確認**: allowlist 外リポジトリへの write が拒否される（`403` / `RepositoryNotAllowedError`）ことを確認する。
5. **レビュー用個人アカウントを外す**: 上記が確認できたら、レビュー用個人アカウントを対象リポジトリ／organization の member / collaborator から外す。
6. **PAT の無効化**: そのアカウントが使っていた Personal Access Token を GitHub の **Settings → Developer settings → Personal access tokens** から revoke する。
7. **半自動レビューの動作確認**: レビュー用個人アカウントを外した状態で、MCP クライアント（Claude Desktop / ChatGPT Project 等）経由のレビュー運用が成立することを確認する。

> 注: レビューの「判断」を行う human / LLM レビュアーは引き続き必要だが、GitHub へのレビュー投稿主体は Thread Owl (App) に一本化される。レビュー用個人アカウントを外す前に、必ず手順 3-4 で App 権限による投稿・返信が成立することを確認すること（fail-closed のため allowlist 設定漏れがあると write が拒否される）。resolve は修正側の権限で行う。

## Webhook サーバー

Webhook サーバーは GitHub App から送信されるイベントを受信し、レビューキューに投入する。

### 処理するイベント

| イベント | 処理する action | 処理内容 |
|---------|----------------|---------|
| `pull_request` | `opened` / `synchronize` / `ready_for_review` | レビューキューに投入 |
| `issue_comment` | `created`（PR コメントのみ） | ログ記録（Phase 6 でキュー投入に変更予定） |
| `pull_request_review` | `submitted` | ログ記録（Phase 6 でキュー投入に変更予定） |
| `pull_request_review_comment` | `created` | ログ記録（Phase 6 でキュー投入に変更予定） |

### Webhook エンドポイント

```
POST /webhook
```

必須ヘッダー:

| ヘッダー | 説明 |
|---------|------|
| `X-Hub-Signature-256` | HMAC-SHA256 署名（`GITHUB_WEBHOOK_SECRET` で検証） |
| `X-GitHub-Event` | イベント種別 |
| `X-GitHub-Delivery` | 配信 ID（重複受信の dedup に使用） |

### セキュリティ

- 署名検証: `GITHUB_WEBHOOK_SECRET` を使用した HMAC-SHA256 検証。署名不一致は `401` を返す
- 自己ループ防止: `APP_SLUG` に一致する bot sender からのイベントはスキップする
- allowlist: `ALLOWED_REPOS` 外のリポジトリからのイベントはハンドラ内で無視する
- 重複配信: delivery ID ベースの dedup（TTL 24h）で同一 delivery ID を無視する

Webhook の設定手順・疎通確認は [webhook-operations.md](./webhook-operations.md) を参照。

## Claude Code skill / review MCP servers との責務整理

| コンポーネント | 役割 |
|---------------|------|
| **Thread Owl (MCP server)** | レビュアー側 GitHub App 権限での review 操作（PR/スレッド取得・コメント投稿・返信）を MCP tools として提供。認証・権限（allowlist）・監査ログを担う。LLM は内蔵しない |
| **`pr-review-subscribe`（Claude Code skill）** | PR レビューサイクルの管理（レビュー取得 → スレッド分類 → 修正 → reply → resolve → サマリ）。acquisition provider（copilot-review / codex / external / existing）を抽象化する |
| **`github-mcp`** | 修正側のユーザー権限で review thread への返信・resolve を行う |
| **`copilot-review-mcp`（MCP server 登録名: `copilot-review`）** | GitHub Copilot review の取得経路。修正側のユーザー権限で review thread への返信・resolve も行う |

- Thread Owl は「GitHub への安全な read/write」、`pr-review-subscribe` は「いつ・どのレビューを取得し、どう処理するか」のワークフローを担当し、責務が分離している。
- Thread Owl はレビュアー側としてスレッドを resolve しない。修正完了の判断と resolve は修正側 MCP の責務とする。
- レビューの判断（指摘内容の生成や合否）は MCP クライアント側の LLM / human が行う。
