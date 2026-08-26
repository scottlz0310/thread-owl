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
bun install
cp .env.example .env
# .env を編集して認証情報を記入する
bun run build

# 内部 API サーバー（HTTP）
node dist/index.js

# MCP server（stdio）
node dist/index.js --mcp

# MCP server（Streamable HTTP）
node dist/index.js --mcp-http

# Webhook 受信サーバー（webhook only）
node dist/index.js --webhook

# Webhook + MCP HTTP combined サーバー（推奨）
node dist/index.js --webhook-mcp-http
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
| `thread-owl-webhook` | 3001 | Webhook 受信のみ（`POST /webhook`） |
| `thread-owl-combined` | 3002 | **推奨**: Webhook 受信 + MCP HTTP（`POST /webhook`・`/mcp`・`/health`・`/status`） |

## ヘルスチェック

```
GET /health
→ { "status": "ok" }
```

バージョンや起動時刻は `/status` エンドポイントから取得できる（内部 API モードのみ）:

```
GET /status
→ { "appId": "...", "version": "0.1.0", "startedAt": "2026-01-01T00:00:00.000Z" }
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
| `node dist/index.js --mcp-http` | Streamable HTTP MCP | mcp-gateway からの内部接続（queue 機能含む） |
| `node dist/index.js --webhook` | Webhook 受信 | GitHub App Webhook イベントの受信・キュー投入 |

各モードは排他的であり、複数フラグの同時指定は起動失敗する。

### combined モード（`--webhook-mcp-http`）

Webhook 受信と MCP HTTP を同一プロセス・同一ポートで提供する。Webhook ハンドラと MCP server が同じ `ReviewQueue` インスタンスを共有するため、PR がキューに投入されると MCP クライアントへ `notifications/resources/updated` が push される。

**エンドポイント:**

| パス | 説明 |
|------|------|
| `POST /webhook` | GitHub App Webhook 受信（HMAC-SHA256 署名検証） |
| `/mcp` | MCP Streamable HTTP（`queue://review/queue` を `subscriptions/listen` で購読可能） |
| `GET /health` | ヘルスチェック |
| `GET /status` | バージョン・起動時刻 |

**MCP Resource:**

| URI | mimeType | 内容 |
|-----|----------|------|
| `queue://review/queue` | `application/json` | レビュー待ち PR 一覧。`enqueue` 時に `notifications/resources/updated` を push |

**セキュリティ上の注意**: combined モードでは `/mcp` が `POST /webhook` と同じ公開面に乗る。`POST /webhook` は GitHub HMAC-SHA256 署名検証で保護されているが、`/mcp` は保護なし。production では nginx / Caddy 等のリバースプロキシで `/mcp` の公開範囲と認証を制御すること。

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
- protocol は `2026-07-28` のみ（`legacy: "reject"`）。stateless であり `Mcp-Session-Id` は発行しない
- `POST /mcp` のみを受け付ける。`GET /mcp` / `DELETE /mcp` は `405` を返す
- `subscriptions/listen` の long-lived stream をリバースプロキシにバッファリングさせないため、応答に `X-Accel-Buffering: no` を付与する
- 既定 bind は `127.0.0.1`。Thread Owl の Streamable HTTP endpoint を直接 public exposure する構成は非対応
- caller 認証は mcp-gateway の責務であり、Thread Owl 側の Bearer 認証は本実装に含まれない
- mcp-gateway と別コンテナで接続する場合のみ、private Docker network 内で `HOST=0.0.0.0` とし、Thread Owl の port をホストへ publish しない

**queue 機能（webhook 受信なし）:**

`--mcp-http` は起動時に `ReviewQueue` を生成し MCP server に注入する（#122）。`--webhook-mcp-http` と異なり `POST /webhook` は提供しないため、GitHub イベントからの自動 enqueue は行われない。代わりに以下が利用できる。

| 機能 | 説明 |
|------|------|
| `enqueue_review` tool | webhook 以外の正規経路で PR を queue に投入する |
| `queue://review/queue` resource | `subscriptions/listen` で enqueue 通知を受信 |
| `queue://review/re-review-requests` resource | `re-review-requested` のみ通知 |

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

## 周辺ツール・MCP servers との責務整理

| コンポーネント | 立場 | 役割 |
|---|---|---|
| **Thread Owl (MCP server)** | review する側 / subscribe **される**側 | レビュアー側 GitHub App 権限での review 操作（PR/スレッド取得・コメント投稿・返信）を MCP tools として提供。`queue://review/queue` を expose し通知を出す。LLM は内蔵しない |
| **`mcp-resource-subscriber`** | subscribe **する**側 / agent workflow bridge | `queue://review/queue` を `subscriptions/listen` で購読し、`notifications/resources/updated` 受信後に `resources/read` → structured JSON を返す。CLI agent が long-lived subscription を安定保持できない場合に使用する（**v0.6.0 以降が必要**） |
| **`pr-review-subscribe`（Claude Code skill）** | ワークフロー管理 | PR レビューサイクルの管理（レビュー取得 → スレッド分類 → 修正 → reply → resolve → サマリ）。acquisition provider（`thread-owl` / `copilot-review` / `codex` / `external` / `existing`）を抽象化する |
| **`github-mcp`** | review を受けて直す側 | 修正側のユーザー権限で review thread への返信・resolve を行う |
| **`copilot-review-mcp`（MCP server 登録名: `copilot-review`）** | review を受けて直す側 | GitHub Copilot review の取得経路。修正側のユーザー権限で review thread への返信・resolve も行う |

- Thread Owl は「GitHub への安全な read/write」、`pr-review-subscribe` は「いつ・どのレビューを取得し、どう処理するか」のワークフローを担当し、責務が分離している。
- Thread Owl はレビュアー側としてスレッドを resolve しない。修正完了の判断と resolve は修正側 MCP の責務とする。
- レビューの判断（指摘内容の生成や合否）は MCP クライアント側の LLM / human が行う。
- Thread Owl に subscription client / watcher CLI / agent wait loop は内蔵しない。長期待機と通知受信は `mcp-resource-subscriber` に委譲する。

詳細は [architecture.md の「周辺レビュー基盤との責務境界」](./architecture.md#周辺レビュー基盤との責務境界) を参照。

## MCP リソースの購読方法

Thread Owl は 2 つの購読可能なリソースを expose する。用途に応じて適切な URI を選択すること。

| URI | 通知タイミング | 用途 |
|-----|--------------|------|
| `queue://review/queue` | opened / synchronized / re-review-requested | 通常レビューの subscriber 起動 |
| `queue://review/re-review-requests` | **re-review-requested のみ** | re-review handoff subscriber 起動 |

**re-review handoff subscriber は必ず `queue://review/re-review-requests` を購読すること。**  
`queue://review/queue` を購読すると、commit push による `synchronized` 通知で subscriber が先に終端し、
直後の `re-review-requested` 通知を見逃す（push-first 経路での early termination）。

### 前提となる protocol バージョン

v0.4.0 以降の Thread Owl は MCP `2026-07-28` のみを受け付け、2025-era の client にはフォールバックしない
（`legacy: "reject"`、#176）。`resources/subscribe` / `resources/unsubscribe` は**存在しない**ため、
購読は `subscriptions/listen` で行う。2025-era の client は `initialize` の時点で `-32022` により拒否される。

| client | 必要バージョン |
|---|---|
| `mcp-gateway` | v0.10.0 以降 |
| `mcp-resource-subscriber` | v0.6.0 以降 |
| MCP SDK を直接使う client | TypeScript `@modelcontextprotocol/client` v2 / C# `ModelContextProtocol.Core` 2.2.0 以降 |

client 側の protocol version は `auto` ではなく `2026-07-28` に pin すること。`auto` は legacy への
暗黙のフォールバックを許すが、Thread Owl 側にフォールバック先が無いため、降格を観測できないまま失敗する。

### mcp-resource-subscriber を使う場合

CLI agent が long-lived subscription を安定保持できない場合（Claude Code skill 等）に推奨:

**通常レビュー**（opened / synchronized を含む全 enqueue を検知）:

```sh
bunx mcp-resource-subscriber \
  --url http://localhost:3000/mcp \
  --uri queue://review/queue \
  --timeout-ms 900000 \
  --json
```

**re-review handoff**（re-review-requested のみを検知。push-first 経路での early termination を防ぐ）:

```sh
bunx mcp-resource-subscriber \
  --url http://localhost:3000/mcp \
  --uri queue://review/re-review-requests \
  --timeout-ms 900000 \
  --json
```

`--json` フラグを指定すると、line-based output の代わりに単一の JSON オブジェクトが stdout に出力される。

**stdout（通知受信時）**:

```json
{
  "route": "subscription",
  "serverUrl": "http://localhost:3000/mcp",
  "resourceUri": "queue://review/re-review-requests",
  "listenAcknowledged": true,
  "honoredUris": ["queue://review/re-review-requests"],
  "notificationReceived": true,
  "notificationCount": 1,
  "closeReason": "local",
  "errorCode": null,
  "initialText": "[]",
  "finalText": "[{\"owner\":\"org\",\"repo\":\"my-repo\",\"prNumber\":42,\"installationId\":12345,\"queuedAt\":\"2026-06-08T00:00:00.000Z\",\"reason\":\"re-review-requested\",\"sourceCommentId\":99,\"requestedBy\":\"human-user\"}]",
  "recommendedNextAction": "READ_REVIEW_THREADS"
}
```

**stdout（タイムアウト時）**:

```json
{
  "route": "timeout",
  "serverUrl": "http://localhost:3000/mcp",
  "resourceUri": "queue://review/re-review-requests",
  "listenAcknowledged": true,
  "honoredUris": ["queue://review/re-review-requests"],
  "notificationReceived": false,
  "notificationCount": 0,
  "closeReason": "local",
  "errorCode": "NOTIFICATION_TIMEOUT",
  "initialText": "[]",
  "finalText": null,
  "recommendedNextAction": null
}
```

**stdout（接続失敗時）**:

```json
{
  "route": "failed",
  "serverUrl": null,
  "resourceUri": "queue://review/re-review-requests",
  "listenAcknowledged": false,
  "honoredUris": [],
  "notificationReceived": false,
  "notificationCount": 0,
  "closeReason": null,
  "errorCode": "SERVER_URL_UNKNOWN",
  "initialText": null,
  "finalText": null,
  "recommendedNextAction": null
}
```

| フィールド | 説明 |
|---|---|
| `route` | `"subscription"`: 通知受信成功 / `"pre-completion"`: listen 確立前に更新済みだったことを読み直しで検知 / `"timeout"`: タイムアウト / `"failed"`: 接続・購読失敗 |
| `serverUrl` | 接続した MCP サーバー URL（接続失敗時は `null`） |
| `resourceUri` | 購読した resource URI |
| `listenAcknowledged` | `subscriptions/listen` の ack をサーバーから受信したか |
| `honoredUris` | ack でサーバーが実際に購読を受け入れた URI 一覧。要求した URI が含まれない場合は `SUBSCRIPTION_NOT_HONORED` |
| `notificationReceived` | 通知受信フラグ |
| `notificationCount` | 受信した `notifications/resources/updated` の件数 |
| `closeReason` | stream の終了理由（`"local"`: 自分で閉じた / `"graceful"`: サーバーが正常終了 / `"remote"`: 異常切断） |
| `errorCode` | エラーコード（下表） |
| `initialText` | listen 確立前に読んだ resource content の raw JSON 文字列 |
| `finalText` | 更新後に読んだ resource content の raw JSON 文字列（未取得時は `null`） |
| `recommendedNextAction` | agent への推奨次アクション（`"READ_REVIEW_THREADS"` 等。エラー時は `null`） |

主な `errorCode`:

| errorCode | 意味 |
|---|---|
| `NOTIFICATION_TIMEOUT` | `--timeout-ms` 内に通知が来なかった |
| `SUBSCRIPTION_NOT_HONORED` | ack に要求した URI が含まれなかった |
| `SUBSCRIPTION_DISCONNECTED` | listen stream が応答なしに切断された |
| `SUBSCRIPTION_CLOSED` | サーバーが listen stream を正常終了した |
| `PROTOCOL_UNSUPPORTED` | protocol negotiation に失敗した（サーバー未移行・認証失敗・到達不能のいずれか。SDK 側で区別できない） |
| `SERVER_URL_UNKNOWN` | `--url` / `MCP_PROBE_URL` が解決できなかった |

CLI agent は `json.route` が `"subscription"` または `"pre-completion"` であることを確認し、`json.recommendedNextAction` / `json.finalText` を使って Thread Owl の MCP tools（`get_pr` → `list_review_threads` → `post_inline_comment` 等）を呼び出す。

<details>
<summary>--json なし（line-based 出力）</summary>

`--json` フラグを省略した場合、line-based output が stdout に出力される。

出力例（通知受信時）:

```
capabilities {"subscribe":true,"listChanged":false}
resource-found true
resource-uri queue://review/re-review-requests
server-url http://localhost:3000/mcp
initial
[]
route subscription
listen-acknowledged true
honored-uris ["queue://review/re-review-requests"]
notification-received true
notification-count 1
close-reason local
recommended_next_action READ_REVIEW_THREADS
error-code null
notification queue://review/re-review-requests
final
[{"owner":"org","repo":"my-repo","prNumber":42,"installationId":12345,"queuedAt":"2026-06-08T00:00:00.000Z","reason":"re-review-requested","sourceCommentId":99,"requestedBy":"human-user"}]
phase-summary route=subscription url=http://localhost:3000/mcp uri=queue://review/re-review-requests
```

出力例（タイムアウト時）:

```
error-code NOTIFICATION_TIMEOUT
phase-summary route=timeout url=http://localhost:3000/mcp uri=queue://review/re-review-requests error-code=NOTIFICATION_TIMEOUT
```

CLI agent は `phase-summary` の `route=subscription`（または `route=pre-completion`）を確認し、`final` ブロックの JSON をパースする。

</details>

### MCP client が native subscribe を使う場合

MCP client が `subscriptions/listen` を native にサポートし、long-lived 接続を安定保持できる場合は、
直接 listen して `notifications/resources/updated` を受信し、`resources/read` で最新キューを取得する。

```
# re-review handoff subscriber
const subscription = await client.listen({
  resourceSubscriptions: ["queue://review/re-review-requests"],
})
  → subscription.honoredFilter.resourceSubscriptions に URI が含まれることを確認する
  → notifications/resources/updated 受信（re-review-requested 時のみ）
  → client.readResource({ uri: "queue://review/re-review-requests" })
  → re-review-requested エントリのみ含む ReviewCandidate[] を取得してワークフローへ
  → subscription.close()
```

ack（`honoredFilter`）の検証は必須である。サーバーが URI を受け入れなかった場合、listen 自体は成功する
一方で通知は一切届かず、client 側は timeout まで待ち続けることになる。
