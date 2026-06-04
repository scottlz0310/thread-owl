# 運用ガイド

## 環境変数

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `GITHUB_APP_ID` | 必須 | GitHub App の数値 ID |
| `GITHUB_APP_PRIVATE_KEY` | 必須 | PEM 形式の private key（改行を `\n` に置換したもの） |
| `GITHUB_WEBHOOK_SECRET` | 必須（Phase 4 以降） | Webhook 署名検証用 HMAC シークレット |
| `ALLOWED_REPOS` | 必須 | `owner/repo` 形式をカンマ区切りで列挙 |
| `PORT` | 任意（デフォルト: 3000） | HTTP サーバーポート |
| `LOG_LEVEL` | 任意（デフォルト: `info`） | ログレベル: `debug` / `info` / `warn` / `error` |

## ローカル実行

```bash
pnpm install
cp .env.example .env
# .env を編集して認証情報を記入する
pnpm run build
node dist/index.js
```

## Docker で実行

```bash
docker compose up --build
```

## ヘルスチェック

```
GET /health
→ { "status": "ok", "version": "0.1.0", "uptime": 42.1 }
```

## Token Source

allowlist 登録済みリポジトリの installation token を取得する:

```
POST /token-source
Content-Type: application/json
{ "owner": "myorg", "repo": "myrepo" }

→ { "token": "ghs_...", "expiresAt": "2026-01-01T00:00:00Z" }
```

## ログ

- レビュー操作はすべて `owner`・`repo`・`prNumber`・`action` を含めて記録する
- token および private key はログに出力しない
- ログフォーマット: JSON（構造化ログ）

## Allowlist の更新

`ALLOWED_REPOS` を新しい `owner/repo` のカンマ区切りリストに設定してサービスを再起動する。
Phase 1 ではホットリロードに対応していないため、再起動が必要である。
