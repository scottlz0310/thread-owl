# Webhook 運用ガイド

## 概要

Thread Owl の Webhook サーバーは `--webhook` モードで起動し、`POST /webhook` で GitHub App からのイベントを受信する。

本ガイドでは以下をカバーする:
- ローカル開発時の疎通確認（smee.io / ngrok）
- 本番環境への Webhook URL 設定
- 疎通確認チェックリスト
- トラブルシューティング

---

## 前提

[github-app-setup.md](./github-app-setup.md) の手順（App 作成・権限設定・Private key 取得・インストール）を完了しておく。`.env` に以下が設定済みであること:

```env
GITHUB_APP_ID=<App の数値 ID>
GITHUB_APP_PRIVATE_KEY_B64=<.pem を base64 化した値>  # Docker では B64 を推奨
GITHUB_WEBHOOK_SECRET=<Webhook secret>
ALLOWED_REPOS=owner/repo
APP_SLUG=<GitHub App の slug>  # デフォルト thread-owl 以外の場合
```

> **Docker 実行時の秘密鍵について**: `docker compose` の `env_file` はホストファイルをコンテナ内へ**マウントしない**。`GITHUB_APP_PRIVATE_KEY_FILE` にホスト上のパスを設定したままでは、コンテナ起動時にファイルが見つからず失敗する。Docker 実行では **`GITHUB_APP_PRIVATE_KEY_B64`（base64 形式）を推奨**する。FILE 形式を使う場合は `docker-compose.yml` の volumes セクションのコメントを参照して bind mount を設定すること。

---

## ローカル開発: smee.io を使った疎通確認

GitHub は直接 `localhost` に Webhook を送信できないため、smee.io のプロキシを経由する。

### 手順

**Step 1: smee.io チャンネルを作成する**

https://smee.io/new を開き、表示された URL（例: `https://smee.io/AbCdEf123456`）を控える。

**Step 2: GitHub App の Webhook URL を更新する**

GitHub App の設定ページ（**Settings → Developer settings → GitHub Apps → 対象 App → Edit**）で:
- **Webhook URL** を smee.io の URL に更新する
- **Active** を有効にする

**Step 3: smee クライアントを起動する**

```bash
npx smee-client --url https://smee.io/AbCdEf123456 --target http://localhost:3001/webhook
```

**Step 4: Webhook サーバーを起動する**

```bash
# ローカル実行
PORT=3001 node dist/index.js --webhook

# または Docker Compose
docker compose up thread-owl-webhook --build
```

**Step 5: イベントを発火させて確認する**

対象リポジトリで PR を作成・更新するか、コメントを投稿する。Webhook サーバーのログに以下のようなエントリが出力されれば疎通成功:

```json
{"event":"webhook.pull_request.queued","owner":"org","repo":"repo","prNumber":1,"action":"opened","reason":"opened"}
```

---

## ローカル開発: ngrok を使った疎通確認

smee.io の代替として ngrok を使用できる。

```bash
ngrok http 3001
```

表示された `https://<random>.ngrok-free.app` を GitHub App の Webhook URL に設定し、`/webhook` を末尾に付ける:

```
https://<random>.ngrok-free.app/webhook
```

> ngrok 無料プランはセッション再起動のたびに URL が変わるため、毎回 GitHub App の設定更新が必要になる。smee.io は URL が固定のため、繰り返しの開発には smee.io が便利。

---

## 本番環境の Webhook URL 設定

**Step 1: Webhook サーバーを公開する**

Reverse proxy（nginx / Caddy 等）または クラウドサービス（Railway / Fly.io / VPS 等）で Thread Owl Webhook サーバーを公開し、HTTPS でアクセス可能にする。

Docker Compose でのポート公開例:

```yaml
# docker-compose.yml
services:
  thread-owl-webhook:
    build: .
    command: ["--webhook"]
    ports:
      - "3001:3001"
    environment:
      PORT: "3001"
      HOST: "0.0.0.0"
    env_file:
      - .env
    restart: unless-stopped
```

reverse proxy の upstream:

```nginx
location /webhook {
    proxy_pass http://thread-owl-webhook:3001/webhook;
    proxy_set_header X-Real-IP $remote_addr;
}
```

**Step 2: GitHub App の Webhook URL を更新する**

GitHub App の設定ページで:
- **Webhook URL** を `https://<公開ドメイン>/webhook` に更新する
- **Active** が有効であることを確認する

---

## 疎通確認チェックリスト

### 起動確認

- [ ] `node dist/index.js --webhook` が起動する（または `docker compose up thread-owl-webhook`）
- [ ] `GET /health` が `{"status":"ok"}` を返す

```bash
curl http://localhost:3001/health
```

### 署名検証確認

不正なリクエストが `401` を返すことを確認する:

```bash
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:3001/webhook \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: test-1" \
  -H "X-Hub-Signature-256: sha256=invalid" \
  -d '{"action":"opened"}'
# → 401
```

### イベント受信確認

PR を作成・更新してログに `webhook.pull_request.queued` が出力されることを確認する。

GitHub App の設定ページ → **Recent Deliveries** でも配信履歴（ステータスコード・ペイロード・レスポンス）を確認できる。

### ヘルスチェックエンドポイント

Webhook サーバーには `/health` が存在する（内部 API サーバーと共有）:

```
GET /health → {"status":"ok"}
```

バージョンや uptime は `/status` エンドポイントから取得できる（内部 API モードのみ）。

---

## ログの確認

Webhook サーバーは構造化 JSON ログを出力する。主要なログイベント:

| event | 意味 |
|-------|------|
| `webhook.pull_request.queued` | PR がレビューキューに投入された |
| `webhook.pull_request.draft.skipped` | draft PR のため処理をスキップ |
| `webhook.pull_request.allowlist.rejected` | allowlist 外リポジトリのため無視 |
| `webhook.issue_comment.received` | PR コメントを受信（Phase 6 でキュー投入予定） |
| `webhook.pull_request_review.received` | PR レビューを受信（Phase 6 でキュー投入予定） |
| `webhook.pull_request_review_comment.received` | PR レビューコメントを受信（Phase 6 でキュー投入予定） |
| `webhook.signature.invalid` | 署名検証失敗（`GITHUB_WEBHOOK_SECRET` の不一致） |
| `webhook.normalize.error` | ペイロード正規化失敗（不正なペイロード） |
| `webhook.handler.error` | ハンドラ内部エラー |

Docker Compose でのログ確認:

```bash
docker compose logs -f thread-owl-webhook
```

---

## トラブルシューティング

### 401 Unauthorized が返る

`GITHUB_WEBHOOK_SECRET` の値が GitHub App の設定と一致しているか確認する。値に余分なスペース・改行が含まれていないことを確認する。

### イベントが届かない

1. GitHub App の設定 → **Recent Deliveries** で配信ステータスを確認する
2. Webhook URL が正しいか確認する（末尾 `/webhook` が必要）
3. smee.io / ngrok が起動しているか確認する
4. `GITHUB_WEBHOOK_SECRET` が Active になっているか確認する（**Active** チェックボックス）

### 自 App のイベントがループする

`APP_SLUG` が実際の GitHub App slug と一致しているか確認する。

GitHub App の slug は App URL `https://github.com/apps/<slug>` の末尾部分。設定ページの **Public link** で確認できる。

### allowlist 外エラー

`ALLOWED_REPOS` に対象リポジトリ（`owner/repo` 形式）が含まれているか確認する。設定変更後はサービスの再起動が必要。
