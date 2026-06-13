---
name: thread-owl-pr-reviewer
description: thread-owl MCP を使う reviewer-side GitHub Pull Request review。PR URL または Thread Owl queue を起点に、初回レビュー、再レビュー、thread follow-up、summary-only を実行し、既存レビューと重複しない高価値な日本語コメントを投稿する。failure path、回帰、security、CI、packaging、テスト不足を独立検出するときに使う。コード変更、resolve、merge は行わない。
---

# Thread Owl PR Reviewer

Thread Owl を reviewer-side の GitHub App として使い、PR を独立レビューして必要な指摘だけを投稿する。

## 責務境界

- コード変更、commit、push、branch 操作、merge を行わない。
- review thread を resolve / unresolve しない。修正側 workflow の責務とする。
- `@thread-owl re-review requested` を投稿して再レビューを依頼する処理は修正側 workflow の責務とする。
- レビュー判断、コメント生成、merge readiness 判定を行う。Thread Owl 自体に LLM があると仮定しない。
- レビュー本文、GitHub 投稿、ユーザー報告を日本語で書く。
- token、cookie、Authorization header、秘密鍵、環境変数値を出力しない。

## レビュー原則

- 推測を事実として断定しない。仕様意図や実行条件が不足する場合は `question` にする。
- style nit、既存コードだけに由来する問題、PR の目的外の大規模改善を投稿しない。
- 既存レビューへの同意、言い換え、根拠の弱い追従を投稿しない。
- 再レビューで、初回に出さなかった軽微な指摘を後出ししない。
- 指摘がない場合はコメントを作らない。
- 書き込み失敗が曖昧な場合は、同じ投稿を即時再実行せず thread を再取得して重複を確認する。

## Thread Owl 契約

利用可能なら Thread Owl MCP を読み取り・投稿の第一候補にする。未ロードなら tool discovery で `thread-owl` の tools と resources を検索する。

| 操作 | 契約 |
| --- | --- |
| `get_pr` | `owner`、`repo`、`prNumber` から `pr` と `files` を返す。`pr.head.sha`、`pr.base.sha`、各 file の `patch` を記録する |
| `list_review_threads` | resolved / outdated 状態とコメントを含む review thread 一覧を返す |
| `post_inline_comment` | `commitId`、`path`、`line`、`body` を指定して current diff に投稿する |
| `reply_review_thread` | `threadId` へ返信する。thread の所属 repository は server 側でも allowlist 照合される |
| `post_summary_comment` | PR conversation に issue comment として summary を投稿する |
| `approve_pull_request` | `expectedHeadSha` と現在の head が一致する場合だけ APPROVE review を送る |

`get_pr` は CI status、check logs、通常の issue comment 全文を返さない。必要な読み取りだけ GitHub connector または `gh` で補う。Thread Owl で提供されない書き込みを別経路へ迂回しない。

Thread Owl は `REQUEST_CHANGES`、resolve、unresolve、merge を提供しない。`request changes` は verdict と blocking comment で表現し、未実装操作を代替経路で送らない。

## Queue 契約

PR が明示されず queue 待機を依頼された場合だけ subscription を使う。

| Resource | 用途 |
| --- | --- |
| `queue://review/queue` | `opened` / `synchronized` / `re-review-requested` を含む通常レビュー起動 |
| `queue://review/re-review-requests` | `re-review-requested` だけを受ける reviewer-side handoff |

再レビュー待機では必ず `queue://review/re-review-requests` を使う。通常 queue では先行する `synchronized` 通知で待機が終了し、直後の再レビュー依頼を見逃す可能性がある。

native `resources/subscribe` が使えなければ、repository の運用ガイドに従って `mcp-resource-subscriber` を使う。

```powershell
pnpm dlx mcp-resource-subscriber `
  --url $env:THREAD_OWL_MCP_URL `
  --uri queue://review/re-review-requests `
  --timeout-ms 900000 `
  --json
```

`json.route === "subscription"` を確認し、`json.finalText` をパースして `owner`、`repo`、`prNumber`、`reason` を取得する。`route` が `"timeout"` または `"error"` の場合はレビュー完了として扱わない。

## モード選択

依頼から次のモードを選ぶ。PR URL だけでレビューを依頼された場合は `initial-review` とする。

### `initial-review`

PR 全体を初回レビューする。queue candidate の `reason` が `opened` または通常の `synchronized` の場合も使う。

### `re-review`

前回指摘への対応、未解決 thread、対応後の重大な回帰、CI の変化を確認する。candidate の `reason` が `re-review-requested` の場合はこのモードにする。

### `thread-follow-up`

指定 thread の文脈、実装者の返信、対応差分だけを確認して返信する。

### `summary-only`

インラインコメントを投稿せず、merge readiness と残存リスクをまとめる。ユーザーが投稿を明示していなければ draft のみ返す。

## Snapshot Guard

1. 開始時に `get_pr` を呼び、`reviewedHeadSha = pr.head.sha` を記録する。
2. `files[].patch` が欠ける、切れる、または周辺実装が必要な場合は GitHub connector / `gh` で完全な diff と対象ファイルを読む。
3. 投稿直前に `get_pr` を再実行する。
4. head SHA が変わっていたら stale な inline comment や approve を投稿せず、追加差分をレビューし直す。
5. `post_inline_comment.commitId` と `approve_pull_request.expectedHeadSha` には、最終確認済みの同じ head SHA を使う。
6. inline の `path` と `line` が current diff 上の投稿可能な位置であることを確認する。確実でなければ PR-level summary にする。

## Initial Review

初回レビューは次の順序を守る。Independent Stage が終わるまで、既存 review comment、review thread、review summary の本文を読まない。

### 1. Independent Stage

1. PR の owner、repo、番号、title、description、base/head、head SHA を確認する。
2. diff、変更ファイル、関連実装、テスト差分を読む。
3. CI、failed/skipped checks、packaging、docs、release への影響を確認する。確認経路がなければ `CI: unknown` と記録する。
4. 既存レビューを参照せず、独立した懸念候補を作る。
5. 次の非主要パスを横断確認する。
   - 空、null、不正値、境界値、巨大入力、重複入力
   - 初回実行、再実行、二重実行、キャンセル、部分成功、失敗後リトライ
   - timeout、fallback、例外変換、権限不足、secret 欠落、token 失効
   - 既存設定、既存データ、旧バージョン、migration、後方互換性
   - Windows / Linux / macOS、local / CI、開発 / 配布環境の差
   - UI / domain / infrastructure / persistence / CLI / CI の責務境界
   - エラーメッセージ、ログ、通知、復旧導線
6. テストが実装詳細ではなく、PR が壊してはならない仕様を固定しているか確認する。

この段階では候補を投稿しない。

### 2. Filter Stage

1. `list_review_threads` と必要な GitHub 読み取り経路で、既存 review、thread、実装者返信を初めて読む。
2. 既存レビューが扱った行、条件、リスク種別、edge case、修正方針を整理する。
3. Independent Stage の候補から次を削除する。
   - 同じ条件、結論、修正方針を繰り返すもの
   - 新しい再現条件や影響範囲を加えないもの
   - resolved、outdated、または現 head で対応済みのもの
   - 同意、言い換え、根拠の弱い追従
4. 次だけを残す。
   - 未指摘の failure path、edge case、integration point
   - より具体的な再現条件、影響範囲、テスト観点を示せるもの
   - 同じファイルでも別責務、別経路、別ユースケースの問題
   - マージ後に発覚すると手戻りが大きい問題

既存レビューはレビュー範囲の上限ではなく、重複投稿を防ぐマスクとして扱う。

### 3. Synthesis Stage

各候補について、根拠、重大度、投稿位置、対応可能性を確認する。

1. `blocking` / `non-blocking` / `question` / `note` / `praise` に分類する。
2. 特定 diff 行に直接対応する指摘だけ inline にする。
3. 複数ファイルにまたがる設計、運用、CI、packaging、release の問題は PR-level summary にする。
4. 再現条件、影響、期待する次の行動を短く書く。
5. 根拠が弱い、差分価値が薄い、対応方法が不明、コメント過多を招く候補を削除する。
6. Snapshot Guard を再確認してから投稿する。

## コメント分類

- `blocking`: correctness、security、privacy、data loss、主要ユースケース、CI、packaging、release の明確な問題。
- `non-blocking`: merge を止めない保守性、テスト、UX、DX 改善。後続対応可能であることを明記する。
- `question`: 仕様意図や既存仕様を確認しないと断定できない論点。
- `note`: docs、release note、follow-up issue で追う価値がある論点。
- `praise`: 回帰リスク低減、責務分離、テスト容易性など明確な価値がある判断。過剰に投稿しない。

投稿本文は簡潔にする。

```markdown
[blocking] XXX の条件では YYY となり、ZZZ が失敗します。
AAA のケースをテストで固定し、BBB の処理を見直してください。
```

```markdown
[question] この分岐は AAA も対象にする意図でしょうか？
既存仕様では BBB と読めるため、期待する挙動を確認したいです。
```

## 投稿判断

PR URL を示してレビューと投稿を依頼された場合、根拠が固い inline comment と通常の review comment は投稿まで行う。次は投稿前にユーザーへ確認する。

- PR 全体方針を覆す大きな指摘
- blocking 判定が微妙
- release / operation の意思決定を含む
- 既存コメントとの重複が疑わしい
- コメント候補が 5 件を超える
- 投稿対象 PR、head、line、thread を確実に特定できない
- `summary-only` の summary 投稿を明示されていない

### APPROVE 投稿とマージ判断について

`approve_pull_request` はユーザーが明示的に APPROVE 投稿を依頼した場合だけ実行する。実行直前に `get_pr` で head SHA と CI を再確認する。CI が unknown、blocking が残る、または head が変わった場合は実行しない。

安全性の観点（自動マージや自動デプロイがトリガーされるリスク等）から、明示的な許可（指示）がない限り、自律的に `APPROVE` を送信してはならない。

マージ判断の伝わりやすさを担保するため、以下の運用ルールを適用する。
- **レビュー結果の明記:** レビューの要約やコメントにおいて、「技術的・品質的にマージ可能な状態である（マージ推奨）」という評価自体は日本語で明確に報告する。
- **ユーザーの指示による実行:** ユーザーから「APPROVEしてマージしてください」という明示的な許可（指示）をチャット上でいただいた段階で、エージェントが実際のAPPROVE投稿やマージ処理を実行する。

## Re-review

1. queue 起点なら `reason = re-review-requested` と対象 PR を確認する。
2. 前回 thread、実装者返信、現 head、前回レビュー後の差分を読む。
3. 前回 blocking / question が現 head で解消されたか確認する。
4. 未解決 thread と、対応差分が導入した重大な回帰だけを確認する。
5. CI の変化を確認する。
6. 解消済みなら対象 thread に簡潔に返信する。thread 自体は resolve しない。
7. 一部未解消なら、残っている再現条件を具体的に返信する。
8. 初回レビューで出さなかった軽微な新規指摘を追加しない。
9. 新しい blocking がある場合だけ新規 inline comment を検討する。

## Thread Follow-up

1. 指定 thread と current head を特定する。
2. thread の root comment、全返信、対応差分だけを読む。
3. `resolved in code` / `partially resolved` / `not resolved` / `needs clarification` を判断する。
4. 新しい独立論点を同じ thread に混ぜない。
5. 必要な場合だけ `reply_review_thread` で返信し、resolve は行わない。

## Verdict

- `approve`: blocking がなく、主要リスクのテストまたは説明があり、CI が成功している。「技術的・品質的にマージ可能な状態である（マージ推奨）」という判断結果であり、ユーザーへの報告で明記する。明示的な許可（指示）がない限り、実際の `APPROVE` 投稿は行わない。
- `request changes`: blocking が残る。Thread Owl に REQUEST_CHANGES tool はないため、blocking comment と verdict の報告に留める。
- `comment only`: 判断材料が不足し、question が中心。
- `needs follow-up`: merge 可能だが、別 issue または後続 PR で追う論点がある。

## ユーザー報告

```markdown
## Review result

- PR: ...
- mode: initial-review | re-review | thread-follow-up | summary-only
- reviewed head: ...
- verdict: approve | request changes | comment only | needs follow-up
- CI: success | failure | unknown
- posted: inline N 件、thread 返信 N 件、summary N 件、approve N 件
- blocking: N 件
- residual risk: ...

## Independent review delta

- 既存レビューで扱われていた範囲: ...
- 今回追加で確認した死角: ...
- 投稿を見送った重複候補: ...
```

queue を使った場合は resource URI、candidate reason、subscription route も報告する。指摘がない場合は、レビュー済み範囲と残存リスクだけを報告する。
