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
- レビュースレッド resolve
- 全 write 操作への allowlist・権限チェック

**完了条件:** レビュー用個人アカウントを org member / collaborator から外せること。

## Phase 3 — MCP 統合

- stdio transport での MCP server 実装
- `get_pr`・`list_review_threads`・`post_summary_comment`・`post_inline_comment`・`reply_review_thread`・`resolve_review_thread` tools 実装
- 直接 token アクセスが必要な MCP クライアント向け `token-source` エンドポイント
- 既存 `copilot-review-mcp` からの移行ガイド

**完了条件:** Claude Desktop / ChatGPT Project から MCP tools 経由で半自動レビューができること。

## Phase 4 — Webhook 受信

- Hono ベースの HTTP サーバー
- 署名検証・delivery 重複排除・bot ループ防止
- `pull_request`・`issue_comment`・`pull_request_review`・`pull_request_review_comment` ハンドラ
- レビュー候補キュー

**完了条件:** PR の open / push イベントがレビューキューに確実に入ること。

## Phase 5 — subscribe 通知

- MCP subscription エンドポイント
- レビュー準備完了・再レビュー・stale スレッド通知
- キューステータス通知

**完了条件:** MCP クライアントがポーリングなしで通知を受け取れること。

## Phase 6 — 制御付き自動化

- per-repo 設定（label トリガー・draft スキップ・スキップ label）
- `dry-run` モード・`require-human-approval` モード・`summary-only` モード

## Phase 7 — API LLM ワーカー（opt-in）

- LLM プロバイダー抽象化（OpenAI / Anthropic）
- diff チャンキング・レビュー重大度分類
- 投稿ポリシー・リトライ/予算制御・監査ログ
