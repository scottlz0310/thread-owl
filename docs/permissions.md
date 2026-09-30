# 権限設計

## GitHub App 権限

### 現在の実装に必要な権限

| スコープ | レベル | 理由 |
|---------|--------|------|
| Metadata | 読み取り | すべての API アクセスに必要。有効 ruleset（`rules/branches/{branch}`）の required status checks 参照 |
| Contents | 読み取り | PR diff とファイル内容の参照。classic branch protection の required status checks 参照（`branches/{branch}` の `protection` の要約） |
| Pull requests | 読み取り・書き込み | レビューコメント投稿・スレッド返信 |
| Issues | 読み取り・書き込み | summary コメント投稿（issue comment エンドポイント使用） |
| Checks | 読み取り | 同一 SHA の check-runs 検証 |
| Commit statuses | 読み取り | 同一 SHA の commit statuses 検証 |

### 将来機能で追加を検討する権限

| スコープ | レベル | 理由 |
|---------|--------|------|
| Actions | 読み取り | ワークフロー実行状況の確認 |

### 付与しない権限

- `Administration`（書き込みはもちろん、読み取りも不要）。classic branch protection の required status checks は、admin 専用の `branches/{branch}/protection` ではなく、`branches/{branch}` の `protection`（要約）から読む（#237）。`Administration: read` を付与済みの installation は、外してよい
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

Allowlist はコメント投稿・スレッド返信・approve・enqueue などの write 操作に適用し、
GitHub API 呼び出し前に拒否する。read 操作は GitHub App installation の repo scope に委ねる。
