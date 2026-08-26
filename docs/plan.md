# Thread Owl 基本設計・初期ロードマップ

## 1. 概要

Thread Owl は、AI 支援による Pull Request レビュー運用を安定化するための GitHub App backend である。

主目的は、レビューコメント投稿・スレッド返信・summary 投稿などの GitHub 上の操作主体を、個人アカウントから GitHub App に移行することである。

これにより、レビュー専用の別 GitHub 個人アカウントを organization member または private repository collaborator として維持する必要を減らし、シート課金・認証管理・ログイン状態依存を解消する。

Thread Owl は、初期段階では LLM API による完全自動レビューを前提としない。
既存の ChatGPT Project、Claude Desktop、Codex CLI/Desktop、MCP subscribe 運用などと組み合わせ、半自動レビュー運用の投稿・通知・権限境界を担う。

## 2. 背景

現在の疑似チーム開発では、AI エージェントが Pull Request をレビューし、GitHub 上にコメントを投稿する運用が行われている。

しかし、個人アカウントベースの運用には以下の課題がある。

* レビュー用別アカウントを organization member / collaborator として維持するとシート料が発生する
* PAT や gh login の管理が煩雑になる
* メインアカウントとレビュー用アカウントの権限境界が曖昧になる
* ChatGPT / Claude / Codex など複数エージェント間で投稿主体が揺れる
* 再レビュー、返信、summary 投稿などの操作を統一しづらい
* 将来の Webhook / subscribe / 自動化に拡張しにくい

Thread Owl は、これらを GitHub App を中心とした設計に置き換える。

## 3. 設計方針

### 3.1 GitHub App を投稿主体にする

Thread Owl は GitHub App として対象 repository に install される。

レビュー関連操作は GitHub App installation token を使って実行する。

対象操作の例:

* PR review comment 投稿
* PR summary comment 投稿
* 既存 review thread への reply
* review 状態の取得
* PR diff / files / commits / checks の参照
* 再レビュー依頼用コメントの投稿

review thread の resolve は Thread Owl の責務に含めない。PR author または repository write access を持つ修正側が `github-mcp` / `copilot-review-mcp`（MCP server 登録名: `copilot-review`）等で行う。

これにより、レビュー Bot 用の別個人アカウントを不要にする。

### 3.2 LLM 実行主体とは分離する

Thread Owl は LLM そのものを内蔵しない。

初期段階では、以下のような既存の LLM 実行環境から利用されることを想定する。

* ChatGPT Project
* Claude Desktop / Claude Code
* Codex CLI / Desktop
* MCP client
* 将来の API LLM worker

Thread Owl は、LLM の推論処理ではなく、GitHub App としての認証・権限・投稿・通知を担当する。

### 3.3 完全自動化より半自動運用を優先する

初期段階では、PR 作成時に完全自動でレビューを生成・投稿することを目標にしない。

まずは以下を優先する。

* GitHub App 権限による投稿安定化
* 別個人アカウントの廃止
* MCP tool / subscribe からの利用
* 人間承認付きレビュー投稿
* review thread の再取得・返信の安定化

完全自動レビューは、後続フェーズで opt-in 機能として検討する。

### 3.4 Webhook は通知・キュー投入から始める

Webhook は最初から自動レビュー生成に直結させない。

初期用途は以下に限定する。

* PR 作成・更新の検知
* review comment / issue comment / review event の検知
* subscribe 通知への変換
* review candidate queue への投入
* force-push や outdated thread の検知

Webhook はトリガーであり、信頼境界ではない。
署名検証、重複排除、allowlist、bot 自身への反応抑止を必須とする。

## 4. 想定アーキテクチャ

```text
GitHub
  ├─ Pull Request
  ├─ Review Threads
  ├─ Webhooks
  └─ GitHub App Installation
        ↓

Thread Owl
  ├─ GitHub App Auth
  │   ├─ App JWT generation
  │   ├─ Installation ID resolution
  │   └─ Installation token issuance/cache
  │
  ├─ Repository Policy
  │   ├─ allowlist
  │   ├─ permission checks
  │   └─ repo-level opt-in config
  │
  ├─ Review Operations
  │   ├─ list review threads
  │   ├─ post inline comment
  │   ├─ reply to thread
  │   └─ post summary comment
  │
  ├─ Webhook Receiver
  │   ├─ signature verification
  │   ├─ event normalization
  │   ├─ duplicate delivery handling
  │   └─ queue insertion
  │
  ├─ MCP / Internal API
  │   ├─ tokenSource endpoint
  │   ├─ review operation tools
  │   ├─ status endpoints
  │   └─ subscribe notifications
  │
  └─ Review Queue
      ├─ pending PR updates
      ├─ pending re-review requests
      └─ stale / outdated thread detection

        ↓

MCP Clients / LLM Frontends
  ├─ ChatGPT Project
  ├─ Claude Desktop / Claude Code
  ├─ Codex
  └─ future API LLM workers
```

## 5. スコープ

### 5.1 初期スコープ

初期スコープは以下とする。

* GitHub App 認証
* installation token 発行
* owner/repo から installation_id を解決
* repo allowlist
* GitHub App 権限で PR 情報を取得
* GitHub App 権限で review comment / summary を投稿
* MCP または internal API から利用可能な tokenSource
* 既存レビュー運用からの移行
* 最小限のログと監査情報

### 5.2 後続スコープ

後続フェーズで扱う。

* Webhook 受信
* subscribe 通知
* review candidate queue
* review thread 状態管理
* re-review request の検出
* stale review thread の検出
* 完全自動レビュー
* API LLM worker
* dashboard
* 複数 organization 対応
* 複数 GitHub App 対応

### 5.3 初期段階でやらないこと

初期段階では以下をやらない。

* 完全無人レビュー
* LLM API worker の内蔵
* 複雑な UI dashboard
* SaaS 化
* Marketplace 公開
* GitHub 以外の forge 対応
* 汎用 GitHub bot framework 化

## 6. Repository 名

Repository 名は以下とする。

```text
thread-owl
```

表示名は以下とする。

```text
Thread Owl
```

説明文:

```text
A GitHub App backend for AI-assisted pull request review threads.
```

より詳しい説明:

```text
Thread Owl provides bot identity, installation-token handling, repository allowlisting, webhook entry points, and review-thread operations for AI-assisted PR workflows.
```

## 7. 想定ディレクトリ構成

```text
thread-owl/
  README.md
  docs/
    architecture.md
    github-app-setup.md
    permissions.md
    security.md
    roadmap.md
    operations.md
  src/
    app-auth/
      app-jwt.ts
      installation-token.ts
      installation-resolver.ts
      token-cache.ts
    github/
      client.ts
      graphql.ts
      rest.ts
      permissions.ts
      review-threads.ts
      pull-requests.ts
    policy/
      allowlist.ts
      repository-policy.ts
      actor-policy.ts
    webhook/
      receiver.ts
      verify-signature.ts
      normalize-event.ts
      handlers/
        pull-request.ts
        issue-comment.ts
        pull-request-review.ts
        pull-request-review-comment.ts
    queue/
      review-queue.ts
      delivery-dedup.ts
    mcp/
      server.ts
      tools/
        get-pr.ts
        list-review-threads.ts
        post-summary.ts
        post-inline-comment.ts
        reply-thread.ts
      subscriptions/
        listen.ts
        notify.ts
    internal-api/
      health.ts
      token-source.ts
      status.ts
    config/
      env.ts
      schema.ts
      logging.ts
  tests/
    unit/
    integration/
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  tsconfig.json
  biome.json
  lefthook.yml
  renovate.json
```

## 8. 技術スタック

初期技術スタックは以下を推奨する。

* TypeScript
* Node.js
* pnpm
* Biome
* tsc
* lefthook
* Vitest
* GitHub REST API
* GitHub GraphQL API
* Docker
* Renovate

GitHub App 認証・Webhook・MCP 周辺の実装は TypeScript との相性が良く、既存 MCP 系列との統一性も高い。

## 9. 権限設計

GitHub App の初期権限は最小権限から始める。

推奨初期権限:

```text
Repository permissions:
- Metadata: read
- Contents: read
- Pull requests: read & write
- Issues: read & write
```

必要になった場合に追加検討する権限:

```text
- Checks: read
- Actions: read
- Commit statuses: read
```

最初から不要な write 権限は付与しない。

## 10. セキュリティ方針

Thread Owl は GitHub App の秘密鍵と installation token を扱うため、セキュリティ境界を明確にする。

必須方針:

* GitHub App private key は環境変数または secret store で管理する
* private key を repository に含めない
* installation token は短寿命として扱う
* token cache は期限を厳密に管理する
* repo allowlist を必須にする
* Webhook secret による署名検証を必須にする
* Webhook delivery id による重複排除を行う
* Bot 自身のコメントに反応して無限ループしない
* force-push 後の古い review thread 操作に注意する
* 投稿操作は監査ログに残す
* destructive operation は初期段階では実装しない

## 11. MCP / subscribe との関係

Thread Owl は MCP 専用ではないが、MCP client から利用できることを重要なユースケースとする。

初期段階では、以下の MCP tool を提供する。

```text
get_pr
list_review_threads
post_summary_comment
post_inline_comment
reply_review_thread
get_review_status
```

subscribe 対応では、以下の通知を想定する。

```text
pr_opened
pr_synchronized
review_comment_created
review_thread_replied
review_requested
review_ready
review_stale
```

ただし、subscribe は通知・起動補助であり、LLM 推論の実行主体ではない。

## 12. ロードマップ

### Phase 0: Repository 初期化

目的: 開発基盤を作る。

* `thread-owl` repository 作成
* README 作成
* docs 初期化
* pnpm / TypeScript / Biome / tsc / lefthook 導入
* Vitest 導入
* Renovate 設定
* Dockerfile / docker-compose 雛形作成
* GitHub Actions CI 作成

完了条件:

* `pnpm install --frozen-lockfile`
* `pnpm run check`
* `pnpm test`
* `pnpm run build`
* CI 成功

### Phase 1: GitHub App 認証 MVP

目的: GitHub App として installation token を発行できるようにする。

* GitHub App JWT 生成
* installation_id 指定による token 発行
* owner/repo から installation_id 解決
* token cache
* env schema validation
* health endpoint
* minimal CLI または internal API

完了条件:

* private key から App JWT を生成できる
* installation token を取得できる
* 対象 repo の基本情報を App 権限で読める
* token expiry を考慮して再取得できる

### Phase 2: Review Operations MVP

目的: GitHub App 権限でレビュー操作を行えるようにする。

* PR 情報取得
* changed files 取得
* review threads 取得
* summary comment 投稿
* inline review comment 投稿
* review thread reply
* permission / allowlist check

完了条件:

* 別個人アカウントを使わずに App 権限で PR review 操作ができる
* 既存の review workflow から呼び出せる
* 操作ログが残る

### Phase 3: MCP Integration

目的: ChatGPT / Claude / Codex などの MCP client から利用できるようにする。

* MCP server 実装
* review 操作用 tools 実装
* tokenSource としての利用
* 既存 `copilot-review-mcp` との責務整理
* 既存 review skill との接続手順作成

完了条件:

* MCP client から PR 情報を取得できる
* MCP client から App 権限でコメント投稿できる
* ChatGPT Project / Claude Desktop から半自動レビュー運用できる

### Phase 4: MCP Streamable HTTP / mcp-gateway 連携

目的: stdio MCP（Phase 3）を拡張し、リバースプロキシ `mcp-gateway` 配下の remote MCP server として利用できるようにする。

> 以下は策定当時の計画である。session ID ごとの server/transport 生成は v0.4.0（#176）の MCP `2026-07-28` 移行で stateless 化により撤去された。現行仕様は [architecture.md の「MCP プロトコル」](./architecture.md#mcp-プロトコル)を参照。

* StreamableHTTPServerTransport 実装
* `createMcpServer(deps, options)` を transport 非依存のまま再利用
* 起動部を `startMcpStdioServer(server)` / `startMcpHttpServer(createServer, options)` に分離
* Streamable HTTP は session ID ごとに `McpServer` / transport を生成・管理
* 起動フラグで stdio / streamable-http / internal-api を切替
* stdio（`--mcp`）は local-only / trusted local client 用に維持
* mcp-gateway への登録・routing（`/mcp/thread-owl`）
* caller 認証は mcp-gateway の責務（thread-owl は gateway 背後の internal MCP server）
* thread-owl は default localhost / container internal bind、Streamable HTTP endpoint を直接 public exposure しない
* gateway 経由の rate limit / 監査境界を明示

完了条件:

* mcp-gateway 経由で remote MCP client から review tools を呼び出せる
* stdio 経路も従来どおり動作する
* Streamable HTTP endpoint を直接 public exposure しない運用が明記される

注: gateway bypass に耐える thread-owl 側 Bearer 検証は follow-up hardening として別途扱う。

### Phase 5: Webhook Receiver

目的: GitHub イベントを受信し、レビュー候補を管理できるようにする。

* Webhook endpoint
* signature verification
* delivery id dedup
* pull_request / issue_comment / pull_request_review / pull_request_review_comment event handling
* bot loop prevention
* review candidate queue

完了条件:

* PR 作成・更新を検知できる
* review comment / reply を検知できる
* 重複イベントを除外できる
* bot 自身の投稿でループしない

### Phase 6: subscribe 通知

目的: Webhook で検知した review candidate を MCP subscribe で通知する。

* subscription endpoint
* review candidate notification
* stale thread notification
* re-review request notification
* queue status notification

完了条件:

* MCP client がレビュー待ち PR を通知として受け取れる
* 人間がレビュー開始を判断できる
* LLM API なしで半自動レビュー運用が成立する

### Phase 7: Controlled Automation

目的: repo 単位 opt-in の限定自動化を導入する。

* repo config
* label-based trigger
* draft PR skip
* skip label
* review mode config
* dry-run mode
* require-human-approval mode
* summary-only mode

完了条件:

* repository ごとに自動化レベルを制御できる
* 完全自動投稿せずに dry-run / approval mode を運用できる
* 誤爆時に安全に停止できる

### Phase 8: API LLM Worker

目的: 必要になった場合のみ、完全自動レビュー生成を追加する。

* LLM provider abstraction
* OpenAI / Anthropic などの provider 実装
* prompt policy
* diff chunking
* review severity classification
* posting policy
* retry / budget control
* audit log

完了条件:

* opt-in repo で API LLM によるレビュー生成ができる
* 投稿前承認または summary-only から開始できる
* 誤投稿を抑制する policy がある

## 13. 初期 MVP のゴール

最初の実用ゴールは以下とする。

```text
GitHub App 権限で PR review thread 操作ができ、
レビュー用別個人アカウントを organization member / collaborator から外せる。
```

この時点では、完全自動レビューや API LLM worker は不要である。

## 14. 非ゴール

Thread Owl は初期段階では以下を目指さない。

* GitHub Copilot Review の完全代替
* CodeRabbit などの SaaS レビューサービスの完全代替
* 汎用 CI bot
* 汎用 GitHub automation framework
* LLM prompt 管理サービス
* Web dashboard 中心のサービス
* Marketplace 向け商用 GitHub App

## 15. 成功条件

初期成功条件は以下。

* GitHub App の installation token でレビュー操作できる
* 別個人アカウントなしで review comment / reply / summary 投稿ができる
* MCP client から半自動レビューできる
* repo allowlist により対象 repo を制御できる
* private key / token / webhook secret の管理が安全である
* 既存 review skill / github-thread-reviewer 運用に自然に接続できる

## 16. 目指すイメージ

Thread Owl の将来像は、AI エージェント時代の Pull Request review thread coordinator である。

人間、ChatGPT、Claude、Codex、API LLM worker など複数のレビュー主体が存在しても、GitHub 上でのレビュー投稿主体・スレッド取得・再レビュー依頼を Thread Owl に集約する。修正完了の判断と resolve は修正側の権限境界に残す。

これにより、疑似チーム開発におけるレビュー運用を、個人アカウント依存から Bot/App ベースの安定した権限境界へ移行する。

## 17. 初期実装ISSUE案

#1 Initialize thread-owl repository
#2 Add GitHub App authentication MVP
#3 Add installation token source and cache
#4 Add repository allowlist policy
#5 Add PR read operations
#6 Add review thread read operations
#7 Add summary comment posting
#8 Add inline/reply review operations
#9 Add MCP tool interface
#10 Document migration from reviewer account to GitHub App

## 18. 将来計画

**Phase 1〜3 までは「自分用のレビュー投稿基盤」**とし、
**Webhook / subscribe まで入ると一気にプロダクト品質**に。

### 18-1 フェーズごとの機能イメージ

```text
Phase 1〜3:
- GitHub App 認証
- installation token
- App権限で投稿
- MCP tool（stdio）から操作
→ 別個人アカウントを外すための実用基盤

Phase 4:
- MCP Streamable HTTP
- mcp-gateway 連携（remote MCP）
→ gateway 配下で remote client から利用可能に

Phase 5〜6:
- Webhook 受信
- event 正規化
- delivery dedup
- bot loop 防止
- review queue
- subscribe 通知
→ レビュー運用システムとして成立

Phase 7以降:
- repo別 opt-in
- label trigger
- dry-run
- approval mode
- API LLM worker
→ SaaS / OSS プロダクト的な品質
```

特に **Webhook + subscribe** が入ると、単なる「投稿用 Bot」ではなくなります。

```text
PRが更新される
↓
Thread Owl が検知する
↓
レビュー待ち・再レビュー待ち・返信待ちを状態化する
↓
MCP client / ChatGPT / Claude に通知する
↓
人間またはLLMがレビューする
↓
Thread Owl がレビュアー App 権限で投稿・返信する
↓
修正側が変更を反映し、自身の権限で resolve する
```

この流れになるので、`thread-owl` という名前もかなり活きます。
`thread` を「GitHub review thread」だけでなく、**レビュー作業の状態管理単位**として扱えるようになる。

### 18-2　フェーズごとのロードマップイメージ

```text
v0.1: App認証 + token broker
v0.2: PR/review操作
v0.3: MCP tools (stdio)
v0.4: MCP Streamable HTTP / mcp-gateway 連携
v0.5: Webhook receiver
v0.6: review queue + subscribe notifications
v0.7: controlled automation
v0.8: API LLM worker
```
