# ロードマップ

## Phase 0 — リポジトリ初期化 ✓

開発基盤の整備: TypeScript・pnpm・Biome・Vitest・lefthook・Renovate・CI・Docker スケルトン。

**完了条件:** `pnpm install --frozen-lockfile && pnpm run check && pnpm test && pnpm run build` が CI で通ること。

## Phase 1 — GitHub App 認証 MVP

- GitHub App JWT 生成（RS256）
- owner/repo から `installation_id` を解決
- Installation token 発行
- 有効期限管理付き token キャッシュ
- 環境変数バリデーション（zod）
- Health エンドポイント
- 最小限の CLI または internal API

**完了条件:** private key → App JWT → installation token → 対象リポジトリの基本情報取得がエンドツーエンドで動作すること。

## Phase 2 — レビュー操作 MVP

- PR 情報取得（タイトル・本文・draft 状態・head/base SHA）
- 変更ファイル取得
- レビュースレッド一覧取得（GraphQL）
- summary コメント投稿
- インラインレビューコメント投稿
- レビュースレッド返信
- 全 write 操作への allowlist・権限チェック

**完了条件:** レビュー用個人アカウントを org member / collaborator から外せること。

> Thread Owl はレビュアー側 GitHub App として動作する。review thread の resolve は PR author または repository write access を持つ修正側が担当する。

## Phase 3 — MCP 統合

- stdio transport での MCP server 実装
- `get_pr`・`list_review_threads`・`post_summary_comment`・`post_inline_comment`・`reply_review_thread` tools 実装
- 直接 token アクセスが必要な MCP クライアント向け `token-source` エンドポイント
- 既存 `copilot-review-mcp` からの移行ガイド

**完了条件:** Claude Desktop / ChatGPT Project から MCP tools 経由で半自動レビューができること。

## Phase 4 — MCP Streamable HTTP / mcp-gateway 連携

stdio MCP（Phase 3）の自然な拡張として Streamable HTTP transport を追加し、リバースプロキシ `mcp-gateway` 配下の remote MCP server として動作させる。

> 以下は策定当時の計画である。session ID ごとの server/transport 生成は v0.4.0（#176）の MCP `2026-07-28` 移行で stateless 化により撤去された。現行仕様は [architecture.md の「MCP プロトコル」](./architecture.md#mcp-プロトコル)を参照。

- `StreamableHTTPServerTransport` を実装する（`createMcpServer(deps, options)` を transport 非依存のまま再利用）
- 起動部を `startMcpStdioServer(server)` / `startMcpHttpServer(createServer, options)` に分離し、HTTP は session ID ごとに server/transport を生成する
- 起動フラグで stdio / streamable-http / internal-api を切り替える
- stdio（`--mcp`）は local-only / trusted local client 用として維持する
- mcp-gateway への登録・routing（`/mcp/thread-owl`）
- caller 認証は **mcp-gateway の責務**。thread-owl は gateway 背後の internal MCP server とし、既定で localhost / container internal bind、Streamable HTTP endpoint を直接 public exposure しない
- gateway 経由の rate limit / 監査境界を明示する

**完了条件:** mcp-gateway 経由で remote MCP client から thread-owl の review tools を呼び出せること。stdio 経路も従来どおり動作すること。

> caller 認証は gateway 必須。gateway bypass に耐える thread-owl 側の Bearer 検証は follow-up hardening として別途扱う。

## Phase 5 — Webhook 受信

（旧 Phase 4）GitHub イベントを受信し、レビュー候補を管理できるようにする。

- Hono ベースの HTTP サーバー
- 署名検証・delivery 重複排除・bot ループ防止
- `pull_request`・`issue_comment`・`pull_request_review`・`pull_request_review_comment` ハンドラ
- レビュー候補キュー

**完了条件:** PR の open / push イベントがレビューキューに確実に入ること。

## Phase 6 — subscribe 通知

（旧 Phase 5）

- MCP subscription エンドポイント
- レビュー準備完了・再レビュー・stale スレッド通知
- キューステータス通知

**完了条件:** MCP クライアントがポーリングなしで通知を受け取れること。

## Phase 7 — 制御付き自動化

（旧 Phase 6）

- per-repo 設定（label トリガー・draft スキップ・スキップ label）
- `dry-run` モード・`require-human-approval` モード・`summary-only` モード

## Phase 8 — API LLM ワーカー（opt-in）

（旧 Phase 7）

- LLM プロバイダー抽象化（OpenAI / Anthropic）
- diff チャンキング・レビュー重大度分類
- 投稿ポリシー・リトライ/予算制御・監査ログ
