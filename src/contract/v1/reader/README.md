# reviewed 側 reader の契約 v1（#144 B1 / review-raven#148・thread-owl#280 共通）

状態: 契約（schemaVersion 1）。review-raven は `internal/reader`、thread-owl は同じ契約の TypeScript 実装で満たす。
根拠: [責務設計](../../review-responsibility-boundaries.md)（reader の信頼境界）、[後続Issue案](../../review-responsibility-followups.md) の B1。

PR のコメント（review thread・review body・issue comment）は、他者が書き得る未信頼のデータである。これまではスキルが「本文なしの metadata → 投稿者検証 → 本文」の順を守っていたが、`get_review_threads` の `include_bodies=false` は任意で、守るかどうかは呼び出し側に委ねられていた。この契約は、**順序をツール側で強制する reader** を定める。

## 不変条件

1. 本文は、**全種類・全ページ・resolved を含む全コメント**の投稿者メタデータを取得し、投稿者を検証した後にだけ要求する。検証に失敗した試行は、本文を一切要求しない。
2. 検証は、サーバーの canonical allowlist（`TRUSTED_COMMENT_AUTHORS`）と、PR の **base ref** にあるプロジェクト allowlist（`.review-raven/trusted-comment-authors.json`）の和集合に対して、正規化後の login の完全一致で行う。PR の head や作業ツリーは参照しない。
   - 正規化: ASCII の大文字を小文字にし、末尾の `[bot]` を**1 回だけ**除く。空白の trim・途中の置換・複数回の除去はしない。
   - 投稿者が特定できない（null・空）コメントが 1 件でもあれば、許可外とは区別して止める（`AUTHOR_CHECK_FAILED`）。
   - サーバーの allowlist が空なら誰も信頼せず、GitHub へも問い合わせずに止める（`TRUSTED_AUTHORS_NOT_CONFIGURED`）。
   - プロジェクト allowlist が存在して壊れていれば、「追加なし」とは読まずに止める（`PROJECT_ALLOWLIST_INVALID`）。存在しない（404）ときだけ追加なし。
3. 本文を取得したら、検証した metadata と**同じコメント**であることを確かめてから返す。コメントの集合・各コメントの投稿者と種別・`editedAt`（最後の編集時刻）・PR の head / base が 1 つでも違えば、その snapshot は返さず、最初から取り直す。取り直しは最大 3 回で、3 回続けて変わり続けたら `SNAPSHOT_CHANGED`（retryable）で止める。thread の resolved の変化は、投稿者も本文も変えないので、取り直しの理由にしない。
4. 失敗の応答にコメント本文を含めない。`details.comments` は、止めたコメントの種別・ID・thread ID・投稿者・URL だけ。
5. 成功の応答の `snapshotId` は、検証した snapshot の識別子である。後で再取得して値が変われば、その間にコメント・投稿者・編集・head のいずれかが変わっている（修正後の再取得で、新しい指摘や未許可の投稿を検出するために使う）。値は snapshot の指紋（下記）の SHA-256 で、コメント本文は含めない（本文の変更は `editedAt` で追う）。

## snapshot の指紋と `snapshotId`

次の行を文字列として**並べ替えて**（先頭の 2 行は固定、残りは辞書順）`\n` で連結し、SHA-256 の 16 進（小文字 64 桁）にする。

```text
head=<headSha>
base=<baseSha>
<kind>|<id>|<threadId>|<author>|<authorType>|<editedAt>   ← コメント 1 件ごと
```

`kind` は `review_thread_comment` / `review_body` / `issue_comment`、`threadId` は thread のコメントだけ（他は空）、`editedAt` は編集されていなければ空文字。

## ツール

review-raven は `read_pr_comments` として公開する（**専用 GitHub App モードだけ**。旧 `gateway` モードの公開面は変えない）。入力は `{owner, repo, pr}`。成功は output schema、失敗は error schema の envelope を `structuredContent` に返し、失敗の結果は `isError: true`。GitHub の認証・権限のエラーは、他のツールと同じ分類で返す（reader の gate の code ではない）。

## 構成

| パス | 内容 |
|---|---|
| `read_pr_comments.output.schema.json` | 成功応答の JSON Schema |
| `read_pr_comments.error.schema.json` | 失敗応答（エラー envelope）の JSON Schema |
| `scenarios.json` | 取得結果の列 → 期待結果の共通シナリオ。review-raven（Go）と thread-owl（TypeScript）が、それぞれの実装に対して同じものを実行する |

## シナリオの形式

```jsonc
{
  "name": "...",
  "serverAllowlist": ["thread-owl", ...],          // サーバーの allowlist（正規化済み）
  "projectAllowlist": {"state": "absent"}           // ファイルなし（追加なし）
                    | {"state": "present", "logins": ["ci-bot"]}
                    | {"state": "invalid"},        // ファイルがあるが壊れている
  "fetches": [ <snapshot> | {"moved": true}, ... ],  // 取得（Fetch）の呼び出し 1 回ごとの応答。順番に使う
  "expect": {
    "outcome": "ok" | "error",
    "code": "...",                       // error のとき
    "fetchCalls": 2, "bodyFetchCalls": 1,  // 取得の呼び出し回数（うち、本文を要求した回数）
    "commentIds": ["kind:id", ...],        // ok のとき返るコメント（順不同）
    "errorCommentIds": ["kind:id", ...],   // error のとき details.comments に載るコメント（順不同）
    "allowlist": {"serverLogins": 4, "projectFile": true, "projectLogins": 1}  // 任意
  }
}
```

- `fetches` の各 snapshot は**本文つき**で書く。`withBodies=false`（メタデータ）の呼び出しには、本文を除いて返す（GitHub に本文を選択させない問い合わせの応答を模す）。`{"moved": true}` は、ページ取得中に PR の commit が動いたことを表す（`ErrSnapshotMoved`）。
- 呼び出し回数がシナリオの `fetches` を超えたら失敗とする（取り直しの回数の誤りを検出する）。
- 失敗の応答は error schema を満たし、どのコメントの本文も含まない。成功の応答は output schema を満たし、全コメントに本文がある。
- 検証で止まったシナリオ（`UNTRUSTED_COMMENT` / `AUTHOR_CHECK_FAILED` / `PROJECT_ALLOWLIST_INVALID`）は、メタデータの呼び出し回数 = 本文の呼び出し回数 + 1 を満たす（取り直した試行は「メタデータ → 本文」の組、最後に止まった試行は「メタデータ」だけ）。`TRUSTED_AUTHORS_NOT_CONFIGURED` は 0 回。

## 実装が満たす範囲と、満たさない範囲

- 満たす: 検証前に本文を要求しない、検証後に変わった snapshot を返さない、失敗に本文を含めない。
- 満たさない: 返した後にコメントが追加・編集されること。呼び出し側は、サイクルの終端で再取得して `snapshotId` を比べる。
- 旧来の `get_review_threads`（`include_bodies` を呼び出し側が選べる）は、この契約の対象外で、スキルが新しいツールへ移行するまで残す。
