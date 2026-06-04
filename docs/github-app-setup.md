# GitHub App セットアップ

## 1. GitHub App を作成する

1. **Settings → Developer settings → GitHub Apps → New GitHub App** を開く
2. 以下を入力する:
   - **GitHub App name**: `Thread Owl`（任意の名前でよい）
   - **Homepage URL**: リポジトリの URL
   - **Webhook URL**: `https://<ホスト名>/webhook`（後で設定しても可）
   - **Webhook secret**: ランダムな文字列を生成して控えておく

## 2. 権限を設定する

**Repository permissions** で以下を設定する:

| 権限 | レベル |
|------|--------|
| Metadata | 読み取りのみ |
| Contents | 読み取りのみ |
| Pull requests | 読み取り・書き込み |
| Issues | 読み取り・書き込み |

この段階ではこれ以上の権限を付与しない。

## 3. Webhook イベントを購読する

以下のイベントを有効化する（Phase 4 で使用）:

- `Pull request`
- `Issue comment`
- `Pull request review`
- `Pull request review comment`

## 4. Private key を生成する

1. **Private keys** → **Generate a private key** をクリックする
2. `.pem` ファイルをダウンロードする
3. 安全な場所に保管する — git にコミットしてはならない

## 5. App をインストールする

1. **Install App** タブに移動する
2. 対象の organization またはリポジトリにインストールする
3. インストール後の URL に含まれる **Installation ID** を控えておく

## 6. 環境変数を設定する

`.env.example` を `.env` にコピーして記入する:

```env
GITHUB_APP_ID=<App の数値 ID>
GITHUB_APP_PRIVATE_KEY=<.pem ファイルの内容を1行にまとめたもの>
GITHUB_WEBHOOK_SECRET=<Webhook secret>
ALLOWED_REPOS=owner/repo1,owner/repo2
```

`GITHUB_APP_PRIVATE_KEY` の改行は `\n` に置換するか、デプロイ環境に応じた複数行環境変数の記法を使用する。
