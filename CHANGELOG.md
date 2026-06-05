# Changelog

## [Unreleased]

### Changed
- ドキュメント（README・docs/）を日本語にリライト
- renovate.json をカスタムプリセット方式（scottlz0310/renovate-config）に変更
- plan.md をルートから docs/plan.md に移動

### Added
- GitHub App JWT 生成（RS256・jose・PKCS#1/PKCS#8 両対応）
- GitHub App installation 解決・installation token 発行・token キャッシュ（@octokit/rest 直叩き・repository スコープ必須・要求スコープでキャッシュ）
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
