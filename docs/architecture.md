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

## MCP プロトコル

Thread Owl は MCP **`2026-07-28`** のみを受け付ける（v0.4.0 以降、#176）。
`@modelcontextprotocol/{server,node,client,core}` v2 を使用し、HTTP は `createMcpHandler`、
stdio は `serveStdio` をいずれも `legacy: "reject"` で構成する。

| 項目 | 挙動 |
|---|---|
| protocol version | `2026-07-28` のみ。2025-era の `initialize`（`2025-06-18` / `2025-11-25`）は `-32022` で拒否する |
| handshake | `server/discover`（`_meta` に protocol version / client info を載せる） |
| session | 持たない。`Mcp-Session-Id` は mint しない |
| 通知の購読 | `subscriptions/listen`。`resources/subscribe` / `resources/unsubscribe` は実装しない |
| standalone GET SSE | 提供しない。`GET /mcp` / `DELETE /mcp` は `405` を返す |
| 通知の配信 | `ServerNotifier.resourceUpdated(uri)` が listen 中の全 stream へ配信する |

`legacy: "reject"` はフォールバックを持たない。2025-era の client は接続段階で弾かれるため、
**client 側も `2026-07-28` へ移行済みである必要がある**。

| client | 必要バージョン |
|---|---|
| `mcp-gateway` | v0.10.0 以降 |
| `mcp-resource-subscriber` | v0.6.0 以降 |
| MCP SDK を直接使う client | TypeScript `@modelcontextprotocol/client` v2 / C# `ModelContextProtocol.Core` 2.2.0 以降 |

client 側の protocol version は `auto` ではなく `2026-07-28` に pin することを推奨する。
`auto` は legacy への暗黙のフォールバックを許すため、降格したことを呼び出し側から観測できない。

## 周辺レビュー基盤との責務境界

Thread Owl は **review する側 / subscribe される側** のコンポーネントとして責務を限定し、
周辺ツールと連携して半自動レビュー基盤を構成する。

### コンポーネント一覧

| コンポーネント | 立場 | 責務 |
|---|---|---|
| **Thread Owl**（本 repo） | review する側 / subscribe **される**側 | GitHub App 認証・webhook 受信・review candidate 判定・queue 管理・MCP tools/resources 提供 |
| **mcp-resource-subscriber**（`scottlz0310/mcp-resource-subscriber`） | subscribe **する**側 / agent workflow bridge | MCP server に接続し `subscriptions/listen` → ack 検証 → `notifications/resources/updated` 待機 → `resources/read` → structured output を返す |
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
  ├─► queue://review/queue              ─── notifications/resources/updated ──►  通常レビュー subscriber
  │     opened / synchronized / re-review-requested を通知
  └─► queue://review/re-review-requests ─── notifications/resources/updated ──►  re-review handoff subscriber
        re-review-requested のみ通知（push-first 経路で synchronized が先着しても終端しない）

  │  resources/read
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

### MCP リソース一覧

| URI | 通知トリガー | 用途 |
|-----|-------------|------|
| `queue://review/queue` | `opened` / `synchronized` / `re-review-requested` | 通常レビューの subscriber 起動 |
| `queue://review/re-review-requests` | `re-review-requested` のみ | re-review handoff subscriber 起動（push-first 経路での early termination を防ぐ） |

`--mcp-http`（webhook 受信なし）も同じ resources を expose するが、GitHub イベントからの自動 enqueue は行わない。enqueue は `enqueue_review` tool 呼び出し経由に限られる（[#122](https://github.com/scottlz0310/thread-owl/issues/122)）。

### 設計原則

- Thread Owl 本体に subscription client / watcher CLI / agent wait loop を内蔵しない
- Thread Owl は `queue://review/queue` と `queue://review/re-review-requests` を expose し、subscribe される側に徹する
- MCP client が `subscriptions/listen` の stream を native に安定保持できる場合は直接利用してよい
- CLI agent が long-lived subscription を安定保持できない場合は `mcp-resource-subscriber` を外部コマンドとして呼び出す
- review を受けて直す側の操作（resolve / unresolve / 再レビュー依頼）は Thread Owl ではなく review-response 系 repo に寄せる
- Thread Owl repo をレビュー基盤の全部入り repo にしない

> 参照: [#75](https://github.com/scottlz0310/thread-owl/issues/75)

## 主要な設計判断

- **NodeNext モジュール**: 厳密な ESM。ローカル import には `.js` 拡張子が必要
- **MCP transport 分離**: `createMcpServer` は transport 非依存とし、stdio は `serveStdio`、Streamable HTTP は `createMcpHandler` に渡す factory として再利用する
- **MCP は stateless**: Streamable HTTP に protocol-level session（`Mcp-Session-Id`）を持たせない。SDK が request/stream 単位でライフサイクルを管理するため、Thread Owl 側に session map は存在しない
- **Streamable HTTP は internal endpoint**: 既定は `127.0.0.1` bind。remote client からは caller 認証を担う mcp-gateway 経由で接続し、直接公開しない
- **LLM を内蔵しない**: Thread Owl はプロキシであり、AI システムではない
- **Allowlist をハードゲートとする**: GitHub API 呼び出し前に必ず allowlist チェックを行う
- **resolve は修正側の責務とする**: Thread Owl はレビュアー側 GitHub App であり、スレッドの resolve は PR author または repository write access を持つ修正側の MCP が行う
- **subscription 状態を自前で持たない**: 購読の受け付けと通知の宛先管理は SDK（`subscriptions/listen`）の責務とし、Thread Owl は `ServerNotifier.resourceUpdated(uri)` を呼ぶだけにする。`ReviewQueue` の `onEnqueue` / `onReReviewRequested` フックを `src/index.ts` で notifier に接続する
- **Thread Owl は subscribe される側**: subscription client / watcher CLI を内蔵しない。長期待機と通知受信は `mcp-resource-subscriber` に委譲する
