# Changelog

## [Unreleased]

### Added
- `README.md` に Thread Owl のアバターアイコンを表示
- `docs/skills/thread-owl-pr-reviewer/` を新規配置: mcp-resource-subscriber `--json` モード対応済みの skill 定義（SKILL.md + agents/openai.yaml）
- `approvePR` のユニットテスト追加（#90）: allowlist ガード・expectedHeadSha 不一致エラー・正常系（監査ログ記録・body 転送）の 4 ケースを網羅

### Changed
- `docs/operations.md` の mcp-resource-subscriber 呼び出し例を `--json` モードに更新（#83）: `--json` フラグを primary に変更し、JSON 出力フィールド（`route` / `errorCode` / `recommendedNextAction` / `finalText` 等）の説明テーブルを追記。line-based 出力例は `<details>` 補足に格下げ。「将来の `--json` mode」注記を削除
- `docs/skills/thread-owl-pr-reviewer/SKILL.md` を更新: 安全性の観点から自律的な `APPROVE` 送信を禁止し、ユーザーの明示的指示を必須とすること、およびレビュー結果でマージ推奨の判断を明確に報告する運用ルールを追加

## [0.2.0] - 2026-06-10

### Changed
- Docker イメージタグを開発/安定リリースに分離（#84）: main push は `:main`（+ `:sha-*`）のみ発行し、`:latest` と version タグ（`:X.Y.Z` / `:X.Y`）は git tag `vX.Y.Z` push 時に新設の `release.yml` が発行する。`release.yml` はテスト通過後に multi-platform（amd64/arm64）イメージを push し GitHub Release を自動作成する。タグ運用方針を README に明記

### Fixed
- GitHub App JWT の `exp` をクロックドリフト考慮なしで `now + 600` に設定していたため、実行環境の時計が GitHub より数秒進んでいると `'exp' is too far in the future` 401 が発生していた（#77）。`exp = iat + 600`（= `now + 540`）に修正し、`exp - iat <= 600` を単体テストで保証

### Added (next)
- `issue_comment` webhook で `@<appSlug>` mention + re-review intent（`re-review` / `rereview` / `review again` / `再レビュー`）を検出し、`reason: "re-review-requested"` で review queue に enqueue する（#79）。`ReviewCandidate` に `sourceCommentId` / `requestedBy` を optional フィールドとして追加。`queue://review/queue` の `resources/updated` 通知は既存の `onEnqueue` フックで自動発火

### Added
- combined モード `--webhook-mcp-http`（#67, #68）: 同一プロセス・同一ポートで Webhook 受信と MCP HTTP を共存。`createSharedRuntime()` で queue/dedup を一元生成し、enqueue イベントが `notifications/resources/updated` として MCP クライアントへ push される。`docker-compose.yml` に `thread-owl-combined` サービス（port 3002）追加
- MCP resource `queue://review/queue`（#68）: `--webhook-mcp-http` / `--mcp-http` + queue 注入時に有効。`resources/subscribe` で enqueue 通知を受信可能。subscribe → unsubscribe → re-subscribe の listener 重複バグおよび pending 中レース条件を修正済み
- `ReviewQueue.onEnqueue(listener)` フック（#68）: enqueue 発生時に呼び出す listener を登録し、dispose 関数を返す
- `McpHttpServerOptions.fallbackHandler`（#68）: MCP パス以外のリクエストを Hono 等の別ハンドラに委譲するオプション。combined モードで `/webhook` / `/health` / `/status` を同一ポートにマウントするために使用

### Changed
- review thread コメント取得のページネーション対応（#29）: `listReviewThreads` / `getReviewThread` が各 thread の先頭100件に加え、`comments.pageInfo` と cursor を使って101件目以降も順次取得する。100件以下では追加 GraphQL 呼び出しを行わない
- レビュー責務の修正（#37）: Thread Owl はレビュアー側 GitHub App としてコメント投稿・スレッド返信までを担い、review thread の resolve は PR author / repository write access を持つ修正側の `github-mcp` / `copilot-review-mcp`（MCP server 登録名: `copilot-review`）に委ねる。`resolve_review_thread` MCP tool と関連する GraphQL mutation・テスト・文書を削除
- ロードマップ改訂: Phase 4 を「MCP Streamable HTTP / mcp-gateway 連携」に差し替え、旧「Webhook 受信」以降を Phase 5-8 に繰り下げ（`docs/roadmap.md` / `docs/plan.md`）。caller 認証は mcp-gateway の責務、thread-owl は gateway 背後の internal MCP server（直接 public exposure しない）、stdio MCP は維持の方針
- 移行ドキュメント整備（#15）: `docs/operations.md` に「レビュアー個人アカウント→GitHub App 移行チェックリスト」「MCP server 運用（`--mcp`・Claude Desktop 設定例）」「`pr-review-subscribe` / `copilot-review-mcp` との責務整理」を追加。環境変数表（秘密鍵3形式）と Token Source（`GET /token`）を実装に合わせて修正
- ドキュメント（README・docs/）を日本語にリライト
- renovate.json をカスタムプリセット方式（scottlz0310/renovate-config）に変更
- plan.md をルートから docs/plan.md に移動

### Added
- Webhook 実運用ドキュメント整備: `docs/webhook-operations.md` 新規作成（smee.io/ngrok ローカルテスト手順・本番 URL 設定・疎通確認チェックリスト・トラブルシューティング）。`docker-compose.yml` に `thread-owl-webhook` サービス追加（`--webhook` モード・ポート 3001）。`operations.md` に `--webhook` 起動方法・`APP_SLUG`/`MCP_HTTP_PATH` 環境変数・Webhook セクション追加。`github-app-setup.md` に Webhook URL 設定ステップ（セクション 5）を追加しセクション番号を更新
- `issue_comment` / `pull_request_review` / `pull_request_review_comment` webhook イベントハンドラ（#48）: 各ハンドラで対象 action フィルタ・allowlist チェックを実施。`issue_comment` は PR に紐づくコメントのみ処理。`receiver.ts` から `allowedRepos` を各ハンドラに渡すよう更新
- `APP_SLUG` 環境変数による GitHub App スラッグの外部設定対応（#46 review fix）: `src/index.ts` のハードコード `"thread-owl"` を除去し `config.appSlug` 経由で参照。`APP_SLUG` 未設定時はデフォルト `"thread-owl"` を使用。`.env.example` と `docs/github-app-setup.md` に設定方法・注意事項を追加
- `pull_request` webhook イベントハンドラ（#46）: `opened` / `synchronize` / `ready_for_review` をキューに投入。draft PR はスキップ（`ready_for_review` は通過）、allowlist 外は無視。`WebhookReceiverDeps` に `allowedRepos` を追加
- `approve_pull_request` MCP ツール（#52）: `pulls.createReview` + `event: "APPROVE"` で PR を承認する。allowlist ガード・監査ログ付き。body は任意
- delivery-dedup 定期 GC（#51）: `createDeliveryDedup` に `gcIntervalMs`（デフォルト 1h）パラメータを追加し、`setInterval` で期限切れエントリを定期全スキャン削除する。プロセス終了をブロックしないよう `.unref()` を付与し、`dispose()` で停止可能にした
- mcp-gateway 統合（#35）: `MCP_HTTP_PATH` 環境変数を追加し、mcp-gateway がプレフィックスをストリップせず転送する挙動に合わせて MCP HTTP endpoint のサーブパスを設定可能にした（Docker 運用時は `MCP_HTTP_PATH=/mcp/thread-owl`）。`GITHUB_WEBHOOK_SECRET` を optional 化（Phase 5 Webhook 受信まで未使用）。Dockerfile を `ENTRYPOINT` + `CMD []` に分離し compose の `command: ["--mcp-http"]` でモード指定できるようにした
- MCP Streamable HTTP transport（#34）: `node dist/index.js --mcp-http` で `/mcp` endpoint を起動する。session ID ごとに独立した `McpServer` / `StreamableHTTPServerTransport` を生成・cleanup し、`--mcp` の stdio と既定の internal API を排他的に切り替える。既定は localhost bind で、mcp-gateway 背後の internal endpoint としてのみ運用する
- MCP server（#14）: stdio transport の `@modelcontextprotocol/sdk` server と review tools 5種（`get_pr` / `list_review_threads` / `post_summary_comment` / `post_inline_comment` / `reply_review_thread`）。各 tool は owner/repo から installation token を都度発行（`issueToken` 再利用・allowlist ゲートが効く）して github 層を呼ぶ。input schema は zod 定義。`node dist/index.js --mcp` で起動し、MCP モードはログを stderr に出力（stdout は JSON-RPC 専用）
- review write 操作（#13）: `postSummaryComment`（issue comment）/ `postInlineComment`（review comment・commitId/path/line）/ `replyToThread`（GraphQL mutation）。全 write は `WriteContext`（client + allowedRepos + logger）経由で **allowlist ガード**（`assertRepoWritable` / `RepositoryNotAllowedError` を policy 層に集約）+ **監査ログ**（`auditWrite`・body 全文や token は非出力）を組み込み。low-level（rest/graphql）は純粋 API 呼び出しに分離。GraphQL thread reply は threadId から所属 repo を取得して allowlist 照合し、引数経由の bypass を防止
- review thread read 操作（#12）: `graphql.ts` `listReviewThreads`（GraphQL・全件ページネーション・resolved/outdated 状態・コメント/位置情報を取得）、`getReviewThread`（threadId 単体取得）、`review-threads.ts` `listOpenThreads`（unresolved フィルタ）
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
