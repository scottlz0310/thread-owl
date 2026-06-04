# セキュリティ

## 脅威モデル

Thread Owl は GitHub App の private key と installation token を扱う。
主なリスクは以下の通り。

1. **Private key の漏洩** — インストール済みの全リポジトリで App を偽装可能になる
2. **Token の漏洩** — 短命ではあるが、ログに出力してはならない
3. **不正操作** — allowlist 外のリポジトリへのコメント投稿・resolve
4. **Webhook スプーフィング** — 偽のペイロードを処理してしまう
5. **Bot ループ** — App が自分自身のコメントに反応し無限ループに陥る

## 対策

### Private Key 管理

- Private key は環境変数または secret store からのみ読み込む
- リポジトリにコミットしない（`.gitignore` に `*.pem` を含める）
- key ローテーションは新しい環境変数を設定してサービスを再起動する

### Token 管理

- Installation token は有効期限 1 時間。短命の秘密情報として扱う
- Token はいかなるログレベルでも出力しない
- Token キャッシュは有効期限前にエントリを破棄する

### Allowlist 適用

- `ALLOWED_REPOS` は必ず明示的に設定する。空の場合は全操作をブロックする
- allowlist チェックはすべての GitHub API 呼び出しの前に実行する
- allowlist はサービス起動時にバリデーションする

### Webhook 署名検証

- 受信した Webhook はすべて `GITHUB_WEBHOOK_SECRET` を使った HMAC-SHA256 で検証する
- 署名が無効または欠落したリクエストは 401 で拒否する
- タイミング攻撃を防ぐため、比較には定数時間比較を使用する

### Delivery 重複排除

- GitHub は同じ Webhook イベントを複数回配信することがある
- Delivery ID を時間制限付きセットで追跡し、重複を抑止する

### Bot ループ防止

- イベント処理前に送信者ログインを App の slug と照合する
- App 自身が発信したイベントはハンドラに渡す前に破棄する

### 破壊的操作

- Phase 0〜3 では delete・close・merge 操作を実装しない
- 将来的に破壊的操作を追加する場合は、明示的な allowlist とポリシーチェックを必須とする
