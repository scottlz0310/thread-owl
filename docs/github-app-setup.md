# GitHub App セットアップ

## 1. GitHub App を作成する

1. **Settings → Developer settings → GitHub Apps → New GitHub App** を開く
2. 以下を入力する:
   - **GitHub App name**: `Thread Owl`（任意の名前でよい。GitHub が名前から slug を自動生成する。slug は App URL `https://github.com/apps/<slug>` の末尾部分で、後述の `APP_SLUG` 環境変数に設定する）
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

### `.pem` の推奨置場

リポジトリ**外**のユーザー専用ディレクトリに置く。`.gitignore` 済み（`*.pem`）でも、リポジトリ内に置くとバックアップ・クラウド同期・誤操作で流出するリスクが残るため。

- 推奨パス: `~/.config/thread-owl/github-app.pem`
  - Windows: `%USERPROFILE%\.config\thread-owl\github-app.pem`
- Bitwarden / dsx には**鍵本体ではなくパスだけ**を保存し、`.pem` はローカルファイルとして置く（後述の `*_B64` を使う場合を除く）

## 5. App をインストールする

1. **Install App** タブに移動する
2. 対象の organization またはリポジトリにインストールする
3. インストール後の URL に含まれる **Installation ID** を控えておく

## 6. 環境変数を設定する

`.env.example` を `.env` にコピーして記入する:

```env
GITHUB_APP_ID=<App の数値 ID>
GITHUB_WEBHOOK_SECRET=<Webhook secret>
ALLOWED_REPOS=owner/repo1,owner/repo2

# App 名を Thread Owl 以外にした場合は slug を変更する（デフォルト: thread-owl）
APP_SLUG=<GitHub App URL の slug>
```

> **`APP_SLUG` について**: 自 App が作成した webhook イベントのループ防止に使用する。デフォルト値は `thread-owl` だが、App 名を変えると slug も変わるため、デフォルトのままでは自己イベントを除外できなくなる。App 名を変えた場合は必ず設定する。

### 秘密鍵の渡し方（3形式）

`.pem` は改行が意味を持つ secret のため、受け取り形式を選べる。解決の優先順位は **FILE > B64 > raw**。いずれか1つを設定する。

| 環境変数 | 用途 | 推奨度 |
|---|---|---|
| `GITHUB_APP_PRIVATE_KEY_FILE` | `.pem` のファイルパスを指定 | **ローカル開発の第一推奨** |
| `GITHUB_APP_PRIVATE_KEY_B64` | `.pem` を base64 化した1行 secret | **Bitwarden / dsx 注入の本命** |
| `GITHUB_APP_PRIVATE_KEY` | 改行を `\n` でエスケープした1行 | 後方互換（脆弱・非推奨） |

**ローカル開発（FILE）:**

```env
GITHUB_APP_PRIVATE_KEY_FILE=C:\Users\<you>\.config\thread-owl\github-app.pem
```

**Bitwarden / dsx 注入（B64）:**

base64 生成（PowerShell）:

```powershell
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Content -Raw .\github-app.pem)))
```

```env
GITHUB_APP_PRIVATE_KEY_B64=LS0tLS1CRUdJTi...
```

> `\n` エスケープ形式（`GITHUB_APP_PRIVATE_KEY`）は、注入過程で `\n` がスペースに置換されると `createPrivateKey` が `error:1E08010C:DECODER routines::unsupported` で失敗する。後方互換としてのみ残しており、新規運用では FILE / B64 を使う。

## 7. レビュー用個人アカウントから移行する

App のインストールと `.env` 設定が完了したら、レビュー投稿主体を個人アカウントから Thread Owl に切り替える。動作確認・org member / collaborator からの除外・PAT 無効化の移行チェックリストは [operations.md](./operations.md#レビュアー個人アカウントから-github-app-への移行) を参照。
