# reviewed 側 reader の契約 v2（Mcp-Docker#408 / review-raven・thread-owl 共通）

状態: 契約（schemaVersion 2）。review-ravenの`internal/reader`とthread-owlのTypeScript実装で共有する。契約の更新と公開・配備状況は区別する。
根拠: [責務設計](../../review-responsibility-boundaries.md)、[後続Issue案](../../review-responsibility-followups.md)のB1。

PRのreview thread・review body・issue commentは未信頼データである。全ページの投稿者メタデータ取得→投稿者検証→本文取得の順序を、呼出し側の任意手順ではなくreader自身で強制する。

## 不変条件

1. resolvedを含む全種類・全ページの投稿者を確認するまで、本文を要求しない。検証に失敗した試行は本文を要求しない。
2. 許可リストはサーバーのcanonical allowlist（`TRUSTED_COMMENT_AUTHORS`）と、PRの**現在のbase branch先頭**の`.review-raven/trusted-comment-authors.json`の和集合。PR比較元SHA・head・既定branch・作業ツリーには代替しない。
   - GitHubのPRから`baseRefName`と`baseRef`を取得する。参照名一致、prefix=`refs/heads/`、target種別=`Commit`を確認し、その40桁小文字SHAを`policyBaseSha`として宣言を読む。
   - branch削除・名前不一致・Commit以外・SHA不明は`POLICY_REF_UNAVAILABLE`で停止する。認証・権限・通信エラーも宣言なしとして扱わない。
   - loginはASCII小文字化し、末尾の`[bot]`を1回だけ除く。trimや部分一致はしない。
   - 投稿者null/空は`AUTHOR_CHECK_FAILED`、許可外は`UNTRUSTED_COMMENT`。サーバーallowlistが空ならGitHubにも問い合わせず`TRUSTED_AUTHORS_NOT_CONFIGURED`。
   - 宣言ファイルが存在して不正なら`PROJECT_ALLOWLIST_INVALID`。ファイル取得の404だけを追加なしとする。
3. 本文取得後、コメント集合・投稿者・種別・`editedAt`・PRのhead/base・`baseRefName`・`policyBaseSha`がmetadataと一致した場合だけ返す。ページ取得中の参照変動やmetadata→本文間の変動は、宣言取得と投稿者検証から取り直す。試行は最大3回。変動が続けば`SNAPSHOT_CHANGED`（retryable）で停止する。threadのresolved状態だけの変化は再試行しない。
4. 失敗応答に本文を含めない。`details.comments`は種別・ID・thread ID・投稿者・URLだけ。
5. 成功の`snapshotId`は、検証したコメントと宣言元の指紋。本文自体は含めず、編集は`editedAt`で追う。

## 参照情報と移行

| 成功応答の必須項目 | 意味 |
|---|---|
| `baseSha` | PR比較元snapshot（GitHubの`baseRefOid`）。従来の意味を維持 |
| `baseRefName` | PRが現在対象にしているbase branch名 |
| `policyBaseSha` | そのbranchの現在のCommit target。プロジェクトallowlistの取得元 |

CI方針も読むconsumerは同じbase branchを解決し、readerの`baseRefName` / `policyBaseSha`と一致することを確認する。v1やprovenance欠落時に旧SHAへ代替しない。旧consumerもv2を検出したら停止する。両readerと両skillを整合させた版で公開・配備し、移行中の不一致は成功扱いにしない。v1実行時互換処理は持たない。

## snapshotの指紋とsnapshotId

先頭4行は固定し、コメント行だけ辞書順に並べ、`\n`で連結する。末尾改行なしのUTF-8バイト列のSHA-256を小文字16進64桁にする。

```text
head=<headSha>
base=<baseSha>
baseRef=<baseRefName>
policy=<policyBaseSha>
<kind>|<id>|<threadId>|<author>|<authorType>|<editedAt>
```

`kind`は`review_thread_comment` / `review_body` / `issue_comment`。thread以外の`threadId`、未編集の`editedAt`は空文字。

## ツールとファイル

review-ravenは専用GitHub Appモードの`read_pr_comments`として公開する。入力は`{owner, repo, pr}`。旧gatewayモードの公開面は変えない。成功・gate失敗はそれぞれ下記schemaのenvelopeを`structuredContent`に返し、失敗は`isError: true`。GitHubの認証・権限エラーは既存toolの分類を維持する。

| パス | 内容 |
|---|---|
| `read_pr_comments.output.schema.json` | v2成功応答 |
| `read_pr_comments.error.schema.json` | v2失敗応答 |
| `scenarios.json` | Go/TypeScriptで共用する取得列と期待結果 |

## 共有シナリオ

fixtureの`schemaVersion`も2。各シナリオは次を持つ。

- `serverAllowlist`: 正規化済みサーバーlogin列。
- `projectAllowlist`: 参照変動のないfixture用の単一宣言。`state`は`absent` / `present` / `invalid`、`present`の`logins`が追加login列。
- または`projectAllowlists`: SHAをkey、上記宣言をvalueとするmap。要求SHAに完全一致する項目だけを返し、未定義SHAの要求はテスト失敗。単一宣言との選択はfixture形式であり、製品の代替処理ではない。
- `fetches`: snapshotまたは`{"moved": true}`の列。snapshotには`headSha` / `baseSha` / `baseRefName` / `policyBaseSha`と全コメント本文を書く。metadata要求には本文を除く。`moved`はページ取得中の参照変動を表す。
- `expect`: `outcome`（`ok` / `error`）、`code`、`fetchCalls`、`bodyFetchCalls`、`commentIds`、`errorCommentIds`、任意の`allowlist`件数。

宣言取得要求SHAは直前metadataの`policyBaseSha`と一致しなければならない。取得回数が列を超えれば失敗。成功はoutput schema、失敗はerror schemaを満たし、失敗にどのコメント本文も含めない。

投稿者検証で停止した場合は`fetchCalls = 2 * bodyFetchCalls + 1`（既に再試行したmetadata/本文の組と最後のmetadataだけ）。サーバーallowlist空なら0回。追加シナリオは現在branchでの許可追加・取消、本文取得中の取消、同じSHAへのbranch変更、連続変動、branch名/SHAの欠落・不正を検証する。

## 保証の限界

最後の参照観測後のコメント・branch・宣言変更を原子的に防ぐものではない。consumerは外部書込み前とサイクル終端に再取得し、`snapshotId`と宣言元を比較する。書込みの自動再試行は含めない。

旧`get_review_threads`はこの強制契約の対象外である。
