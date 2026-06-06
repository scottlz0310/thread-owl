# Thread Owl

AI 支援による Pull Request レビューのための GitHub App バックエンド。

## 概要

Thread Owl は、AI 支援 PR ワークフローにおける Bot アイデンティティ・installation token 管理・リポジトリ allowlist・Webhook エントリポイント・レビュースレッド操作を提供する。

主目的は、PR レビュー操作（コメント投稿・スレッド返信・summary）の実行主体を個人 GitHub アカウントから GitHub App installation に移行し、organization メンバーまたはリポジトリ collaborator としてのレビュー専用アカウントを不要にすることである。

## 設計方針

- **GitHub App を投稿主体にする** — レビュー操作はすべて installation token を使って実行する。個人アクセストークンに依存しない
- **resolve は修正側に委ねる** — Thread Owl はレビュアー側として指摘と返信を投稿し、スレッドの resolve は PR author または repository write access を持つ修正側が行う
- **LLM を内蔵しない** — Thread Owl は LLM を持たない。ChatGPT・Claude・Codex などの認証・投稿レイヤーとして機能する
- **半自動化から始める** — 完全自動化は opt-in で後続フェーズに委ねる。初期は人間承認付きレビュー操作の安定化を優先する

## アーキテクチャ

```
LLM フロントエンド（ChatGPT / Claude / Codex）
        ↓ MCP tools / internal API
Thread Owl
  ├─ GitHub App Auth（JWT → installation token → キャッシュ）
  ├─ Repository Policy（allowlist・per-repo config）
  ├─ Review Operations（PR 取得・スレッド一覧・コメント投稿・返信）
  ├─ Webhook Receiver（署名検証・重複排除・イベント正規化・キュー投入）
  ├─ MCP Server（tools + subscriptions）
  └─ Internal API（health・token-source・status）
        ↓ GitHub REST / GraphQL API
GitHub
```

## ロードマップ

| フェーズ | 内容 |
|---------|------|
| 0 | リポジトリ初期化（完了） |
| 1 | GitHub App 認証 MVP |
| 2 | レビュー操作 MVP |
| 3 | MCP 統合 |
| 4 | Webhook 受信 |
| 5 | subscribe 通知 |
| 6 | 制御付き自動化 |
| 7 | API LLM ワーカー（opt-in） |

詳細は [docs/roadmap.md](docs/roadmap.md) を参照。

## 動作要件

- Node.js >= 20.0.0
- pnpm

## セットアップ

```bash
pnpm install
cp .env.example .env
# .env に GitHub App の認証情報を記入する
```

GitHub App の登録手順は [docs/github-app-setup.md](docs/github-app-setup.md) を参照。

## 開発コマンド

```bash
pnpm run check      # Biome lint + フォーマット確認
pnpm run typecheck  # TypeScript 型チェック
pnpm test           # テスト実行
pnpm run build      # dist/ へコンパイル
```

## GitHub App 権限

最小限必要な権限:

| 権限 | レベル |
|------|--------|
| Metadata | 読み取り |
| Contents | 読み取り |
| Pull requests | 読み取り・書き込み |
| Issues | 読み取り・書き込み |

詳細は [docs/permissions.md](docs/permissions.md) を参照。

## セキュリティ

- GitHub App private key は環境変数で管理し、リポジトリにコミットしない
- Webhook 署名検証は必須
- すべての操作に対して repository allowlist を適用する

詳細は [docs/security.md](docs/security.md) を参照。

## ライセンス

MIT
