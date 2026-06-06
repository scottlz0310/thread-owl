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

## 主要な設計判断

- **NodeNext モジュール**: 厳密な ESM。ローカル import には `.js` 拡張子が必要
- **LLM を内蔵しない**: Thread Owl はプロキシであり、AI システムではない
- **スタブでは `unknown` を使用**: Phase 1 以降で実際の Octokit 型に置き換える
- **Allowlist をハードゲートとする**: GitHub API 呼び出し前に必ず allowlist チェックを行う
- **resolve は修正側の責務とする**: Thread Owl はレビュアー側 GitHub App であり、スレッドの resolve は PR author または repository write access を持つ修正側の MCP が行う
