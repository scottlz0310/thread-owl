# 権限設計

## GitHub App 権限

### 初期権限（Phase 1〜3）

| スコープ | レベル | 理由 |
|---------|--------|------|
| Metadata | 読み取り | すべての API アクセスに必要 |
| Contents | 読み取り | PR diff とファイル内容の参照 |
| Pull requests | 読み取り・書き込み | レビューコメント投稿・スレッド返信 |
| Issues | 読み取り・書き込み | summary コメント投稿（issue comment エンドポイント使用） |

### 必要に応じて追加する権限（Phase 4 以降）

| スコープ | レベル | 理由 |
|---------|--------|------|
| Checks | 読み取り | PR の CI ステータス確認 |
| Actions | 読み取り | ワークフロー実行状況の確認 |
| Commit statuses | 読み取り | コミットステータスの確認 |

### 付与しない権限

- `admin` 系の権限（いかなるもの）
- `Members`
- `Organization administration`
- レビューワークフローのスコープ外のもの

## 最小権限の原則

Thread Owl は Phase 1〜3 に必要な最小限の権限からスタートする。
追加権限は、具体的なユースケースが生じた場合にのみリクエストし、
その理由をこのドキュメントに明記する。

## リポジトリ Allowlist

GitHub App installation で権限が付与されていても、Thread Owl は
環境変数 `ALLOWED_REPOS` による追加の allowlist を適用する。

Allowlist に含まれないリポジトリへの操作は、GitHub API 呼び出しの前に拒否される。
