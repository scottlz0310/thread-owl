# Changelog

## [Unreleased]

### Changed
- ドキュメント（README・docs/）を日本語にリライト
- renovate.json をカスタムプリセット方式（scottlz0310/renovate-config）に変更
- plan.md をルートから docs/plan.md に移動

### Added
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
