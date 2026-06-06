# Changelog

## [Unreleased]

### Changed
- ドキュメント（README・docs/）を日本語にリライト
- renovate.json をカスタムプリセット方式（scottlz0310/renovate-config）に変更
- plan.md をルートから docs/plan.md に移動

### Added
- MCP server（#14）: stdio transport の `@modelcontextprotocol/sdk` server と review tools 6種（`get_pr` / `list_review_threads` / `post_summary_comment` / `post_inline_comment` / `reply_review_thread` / `resolve_review_thread`）。各 tool は owner/repo から installation token を都度発行（`issueToken` 再利用・allowlist ゲートが効く）して github 層を呼ぶ。input schema は zod 定義。`node dist/index.js --mcp` で起動し、MCP モードはログを stderr に出力（stdout は JSON-RPC 専用）
- review write 操作（#13）: `postSummaryComment`（issue comment）/ `postInlineComment`（review comment・commitId/path/line）/ `replyToThread`・`resolveThread`（GraphQL mutation）。全 write は `WriteContext`（client + allowedRepos + logger）経由で **allowlist ガード**（`assertRepoWritable` / `RepositoryNotAllowedError` を policy 層に集約）+ **監査ログ**（`auditWrite`・body 全文や token は非出力）を組み込み。low-level（rest/graphql）は純粋 API 呼び出しに分離。GraphQL thread write（reply/resolve）は threadId から所属 repo を取得して allowlist 照合し、引数経由の bypass を防止
- review thread read 操作（#12）: `graphql.ts` `listReviewThreads`（GraphQL・全件ページネーション・resolved/outdated 状態・コメント/位置情報を取得）、`getReviewThread`（threadId 単体取得）、`review-threads.ts` `listOpenThreads`（unresolved フィルタ）。write 系（resolve/reply）と `permissions.ts` は #13 用に throw 維持
- PR read 操作（#11）: `createClient`（installation token で Octokit REST + GraphQL クライアント構築）、`getPullRequest`（PR 基本情報）、`listPullRequestFiles`（変更ファイル一覧・paginate）。Octokit 呼び出しを共通ラップし失敗時に操作名と HTTP status を付与
- リポジトリ allowlist ポリシー（#10）: `parseAllowlist`（トリム・小文字化・重複除去・形式検証 fail-fast）、`resolveRepositoryPolicy`（allowlist 内は write 許可・外は read-only の fail-closed）、`isBotActor`/`shouldIgnoreEvent`（bot 自己ループ防止）。`ALLOWED_REPOS` の正規化・形式検証を `parseAllowlist` に一元化し env に統合
- GitHub App 秘密鍵の受け取り形式を3種サポート（優先順位 FILE > B64 > raw）。`GITHUB_APP_PRIVATE_KEY_FILE`（ファイルパス）・`GITHUB_APP_PRIVATE_KEY_B64`（base64）を追加し、改行を含む secret の注入を堅牢化。パース失敗時に原因と推奨形式を案内するエラーメッセージを追加
- GitHub App JWT 生成（RS256・jose・PKCS#1/PKCS#8 両対応）
- GitHub App installation 解決・installation token 発行・token キャッシュ（repository スコープ必須）
- 内部 API サーバ（hono / @hono/node-server）: `/health`・`/status`・`/token`（installation token ブローカー。allowlist を発行前ゲートにし、既定 localhost bind・token を log/`/status` に非出力）
- Codecov によるカバレッジ測定（vitest v8 coverage・CI で lcov アップロード）
- 環境変数バリデーションと設定スキーマ（zod ベース、fail-fast）
- 構造化 JSON ロガー（予約フィールド保護付き）
- `.gitattributes` による改行コード正規化（LF）
- Initial repository skeleton with project structure
- GitHub App authentication module stubs
- Review operations module stubs
- Policy enforcement module stubs
- Webhook receiver module stubs
- Review queue module stubs
- MCP server and tools module stubs
- Internal API module stubs
- CI workflow, Dockerfile, and configuration files
