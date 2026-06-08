# アーキテクチャ

## 概要

Thread Owl は単一の Node.js サービスとして構成され、3 つのインターフェースを公開する。

- **MCP server** — LLM フロントエンドから利用される tools と subscriptions
- **Internal API** — token ブローカーとステータス確認用 HTTP エンドポイント
- **Webhook receiver** — GitHub イベント受信（Phase 4 以降）

## モジュール構成

```
src/
  index.ts              エントリポイント。全サブシステムを起動・接続する
  config/               環境変数バリデーションとアプリケーション設定
  app-auth/             GitHub App JWT および installation token 管理
  github/               GitHub API への REST / GraphQL 操作
  policy/               allowlist 適用および per-repo ポリシー
  webhook/              GitHub Webhook 受信とイベントハンドラ
  queue/                レビュー候補キューと delivery 重複排除
  mcp/                  MCP server・tools・subscription 通知
  internal-api/         health・token-source・status エンドポイント
```

## データフロー

```
GitHub Webhook
  → verify-signature（署名検証）
  → normalize-event（イベント正規化）
  → delivery-dedup（重複排除）
  → handler（pull-request / issue-comment / review / review-comment）
  → review-queue（レビュー候補キューに投入）

MCP クライアント / LLM フロントエンド
  → stdio（local client）または Streamable HTTP `/mcp`（mcp-gateway 内部接続）
  → MCP tool 呼び出し（get_pr / list_review_threads / post_* / reply_*）
  → policy チェック（allowlist + repository-policy）
  → app-auth（token-cache → 期限切れなら installation-token を再取得）
  → github/rest または github/graphql
  → GitHub API

Internal API クライアント
  → token-source エンドポイント
  → policy チェック
  → app-auth
  → InstallationToken レスポンス
```

## GitHub App 認証フロー

```
App private key（環境変数）
  → generateAppJwt()         RS256 JWT、有効期限 10 分
  → resolveInstallationId()  owner/repo → installation_id を解決
  → getInstallationToken()   installation_id → token（有効期限 1 時間）
  → TokenCache               不要な token 再取得を抑制
```

## 周辺レビュー基盤との責務境界

Thread Owl は **review する側 / subscribe される側** のコンポーネントとして責務を限定し、
周辺ツールと連携して半自動レビュー基盤を構成する。

### コンポーネント一覧

| コンポーネント | 立場 | 責務 |
|---|---|---|
| **Thread Owl**（本 repo） | review する側 / subscribe **される**側 | GitHub App 認証・webhook 受信・review candidate 判定・queue 管理・MCP tools/resources 提供 |
| **mcp-resource-subscriber**（`scottlz0310/mcp-resource-subscriber`） | subscribe **する**側 / agent workflow bridge | MCP server に接続し `resources/subscribe` → `notifications/resources/updated` 待機 → `resources/read` → structured output を返す |
| **review-response 系 repo**（旧 `copilot-review-mcp` の汎用化構想） | review を受けて直す側 | review thread 読み取り・返信・resolve / unresolve・再レビュー依頼 |

Thread Owl は「通知を出す側」であり、「自分自身の resource を購読して待つ側」ではない。
subscription client / watcher CLI / agent wait loop は Thread Owl に内蔵しない。

### データフロー（レビューサイクル全体）

```
GitHub
  │  pull_request.opened / synchronized
  ▼
Thread Owl (--webhook-mcp-http)
  │  review candidate を判定・enqueue
  ▼
queue://review/queue  ─── notifications/resources/updated ──►  MCP client
  │  resources/read                                            （native subscribe の場合）
  │
  ▼
mcp-resource-subscriber（CLI agent が long-lived subscribe を保持できない場合）
  │  structured JSON output
  ▼
Claude Code / agent workflow
  │
  ├─ Thread Owl MCP tools（review する側）
  │    get_pr / list_review_threads
  │    post_summary_comment / post_inline_comment
  │    reply_review_thread / approve_pull_request
  │
  └─ review-response 系 MCP（review を受けて直す側）
       reply_review_thread / resolve_review_thread
       re-review 依頼
```

### 設計原則

- Thread Owl 本体に subscription client / watcher CLI / agent wait loop を内蔵しない
- Thread Owl は `queue://review/queue` を expose し、subscribe される側に徹する
- MCP client が `resources/subscribe` を native に安定保持できる場合は直接利用してよい
- CLI agent が long-lived subscription を安定保持できない場合は `mcp-resource-subscriber` を外部コマンドとして呼び出す
- review を受けて直す側の操作（resolve / unresolve / 再レビュー依頼）は Thread Owl ではなく review-response 系 repo に寄せる
- Thread Owl repo をレビュー基盤の全部入り repo にしない

> 参照: [#75](https://github.com/scottlz0310/thread-owl/issues/75)

## 主要な設計判断

- **NodeNext モジュール**: 厳密な ESM。ローカル import には `.js` 拡張子が必要
- **MCP transport 分離**: `createMcpServer` は transport 非依存とし、stdio は単一 server、Streamable HTTP は session ID ごとに server/transport を生成する
- **Streamable HTTP は internal endpoint**: 既定は `127.0.0.1` bind。remote client からは caller 認証を担う mcp-gateway 経由で接続し、直接公開しない
- **LLM を内蔵しない**: Thread Owl はプロキシであり、AI システムではない
- **Allowlist をハードゲートとする**: GitHub API 呼び出し前に必ず allowlist チェックを行う
- **resolve は修正側の責務とする**: Thread Owl はレビュアー側 GitHub App であり、スレッドの resolve は PR author または repository write access を持つ修正側の MCP が行う
- **subscription 責務の分離**: subscription 状態管理（`src/mcp/subscriptions/listen.ts`）と queue → MCP push 変換（`src/mcp/subscriptions/notify.ts`）を `server.ts` から分離。`server.ts` はハンドラ登録に徹する
- **Thread Owl は subscribe される側**: subscription client / watcher CLI を内蔵しない。長期待機と通知受信は `mcp-resource-subscriber` に委譲する
