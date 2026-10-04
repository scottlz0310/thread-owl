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

- `ALLOWED_REPOS` は write の対象を制限するため必ず明示的に設定する。空の場合は write 操作と Webhook / enqueue をブロックする
- allowlist チェックは write の GitHub API 呼び出し前に実行し、read は GitHub App installation の repo scope に委ねる
- allowlist はサービス起動時にバリデーションする

### PR の作成者・fork の検証

リポジトリ単位の allowlist（`ALLOWED_REPOS`）は write の封じ込めであり、PR の作成者の信頼とは別の軸である。他者の PR が queue に載ると、reviewer がそのコードをビルド・テストとして実行し得るため、作成者と fork を検証する（#236）。基本はソロ開発で、他者の PR は既定で不信とし、受け入れる相手を `ALLOWED_AUTHORS` に明示的に追加する。

- `ALLOWED_AUTHORS`（GitHub の login のカンマ区切り）に含まれる作成者の、**同一リポジトリの PR だけ**を受け付ける。**fork からの PR は、作成者が許可されていても常に拒否する**（head の repository が削除されている場合を含む）
- login は、ASCII の大文字を小文字にし、末尾の `[bot]` を 1 回だけ取り除いて比較する（Mcp-Docker の skill の `normalize_login` と同じ規則。GraphQL と REST で App の login の表記が変わるため）。wildcard は不可で、形式不正は起動時に fail-fast で拒否する
- 検証する入口:
  - `enqueue_review`: GitHub API で PR を取得して照合する。`requestedBy` は自己申告で信頼しない。取得に失敗したら fail-closed で、queue にも `review://status` にも載せない
  - webhook `pull_request`: `pr.user.login` と `pr.head.repo.full_name` を照合する。読めない項目は拒否する
  - webhook `issue_comment`（再レビュー依頼）: コメントの投稿者が許可されている場合だけ、GitHub API で PR を取得して、PR の作成者と fork を照合する（payload に head の repository が無いため）。投稿者が許可されていなければ、PR を取得せずに拒否する。PR の取得に失敗したら例外のまま伝播し、queue に載せない（fail-closed）。許可された投稿者でも、他者の PR や fork の PR への再レビューは queue に載せない
- 拒否は監査ログに残す。作成者・投稿者の login は記録するが、本文は記録しない
- `get_pr` は、reviewer が実行前に検証できるよう、作成者（`author`）と head の repository（`head.repo.fork`）を返す。あわせて、`enqueue_review` と同じ判定の結果（`origin`: `allowed` と `reason`）を返す。許可リストの正本は `ALLOWED_AUTHORS` の 1 か所で、reviewer skill はリストを持たず、この結果で、ローカル検証の前に許可外の PR を止める（queue を経由しない CLI からの直接起動でも）
- **`ALLOWED_AUTHORS` が未設定（空）の間は、すべての PR と再レビュー依頼を拒否する**（fail-closed。`ALLOWED_REPOS` が空のときと同じ流儀で、起動は止めず、実行時に拒否する。拒否の理由は `author_allowlist_empty`で、`enqueue_review` は PR を取得せずに拒否する）。起動のたびに、エラーを記録する（`config.allowed_authors.unset`）。必ず `ALLOWED_AUTHORS`（例: 自分の login と、再レビューを依頼する bot 名義）を設定すること。bot の PR（Renovate など）をレビューしたい場合は、その login も追加する。v0.6.0 までは、未設定の間は検証しなかった（#244 で変更）

### Streamable HTTP の公開境界

- `--mcp-http` は mcp-gateway 背後の internal endpoint としてのみ運用する
- 既定の `HOST=127.0.0.1` を維持し、直接 public exposure しない
- コンテナ間接続で `HOST=0.0.0.0` が必要な場合も private network に限定し、port をホストへ publish しない
- caller 認証・rate limit・外部向け監査境界は mcp-gateway 側で適用する
- Thread Owl 側の Bearer 認証は follow-up hardening とし、本実装には含めない

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
