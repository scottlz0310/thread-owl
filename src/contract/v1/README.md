# レビュー依頼サイクルの契約 v1（#144 R1 / O1 / I1 共通）

状態: 契約案（schemaVersion 1）。review-raven・thread-owl・Squirrel の実装は未着手で、この契約を満たすように実装する。
根拠: [責務設計](../review-responsibility-boundaries.md)、[後続Issue案](../review-responsibility-followups.md)。起票済みIssue: R1 [#147](https://github.com/scottlz0310/review-raven/issues/147)、O1 [thread-owl#279](https://github.com/scottlz0310/thread-owl/issues/279)、I1 [Mcp-Docker#392](https://github.com/scottlz0310/Mcp-Docker/issues/392)。

review-raven（依頼窓口）と thread-owl（レビュー側）が**同じ契約を別々の言語（Go / TypeScript）で実装する**ため、入出力の形・不変条件・エラー code・設定の既定を、実装から独立した成果物として固定する。設計文書の表現を変えるものではなく、設計文書の「型・エラーコード・再送上限は実装Issueで確定する」部分を埋める。

## 構成

| パス | 内容 |
|---|---|
| `schemas/` | JSON Schema（2020-12）。公開 MCP 3 面 + snapshot、内部 MCP 5 面、エラー envelope、設定 |
| `fixtures/<schema>/valid/` | 受理されなければならない例 |
| `fixtures/<schema>/invalid/` | `{base, patch}`。`valid/` の `base` に RFC 6902 風の最小パッチ（add / replace / remove）を当てた**拒否されなければならない例**。拒否の原因がパッチの 1 点に特定できる |
| `scenarios/` | 複数 tool 呼び出しの順序・期待結果（R1 / O1 の相互接続テストの共通入力） |
| `../../../internal/contracts/` | 上記の整合を検証する Go テスト（本番コードは持たない） |

## 面と schema

| 面 | 呼び出し | 入力 | 出力 |
|---|---|---|---|
| 公開 | `request_review` | `request_review.input` | `request_review.output` |
| 公開 | `get_review_request` / resource `review-raven://requests/{cycleId}` | `get_review_request.input` | `snapshot` |
| 公開 | `cancel_review_request` | `cancel_review_request.input` | `cancel_review_request.output` |
| 内部 raven → owl | `accept_review_candidate` | `accept_review_candidate.input` | `accept_review_candidate.output` |
| 内部 raven → owl | `cancel_review_candidate` | `cancel_review_candidate.input` | `cancel_review_candidate.output` |
| 内部 raven → owl | `get_review_result` | `get_review_result.input` | `get_review_result.output` |
| 内部 owl → raven | `ingest_review_candidate` | `ingest_review_candidate.input` | `ingest_review_candidate.output` |
| 内部 owl → raven | `publish_review_result` | `publish_review_result.input` | `publish_review_result.output` |
| 内部 Squirrel → raven | `publish_review_observation` | `publish_review_observation.input` | `publish_review_observation.output` |

失敗はすべて `error` の envelope で返す。内部面は専用のサービス用公開面と権限で分離し、agent 向け `tools/list` に含めない。呼び出し主体は gateway が検証した identity から得る。入力に自己申告の主体（`requestedBy` など）を含めることは**拒否**する。

## 版の扱い

- すべてのメッセージが `schemaVersion: 1` を持つ。破壊的変更は別 schemaVersion とし、既存の版の項目名・意味・必須性を変えない。
- `additionalProperties: false` が既定。**未知の項目は拒否する**（観測にログ本文やローカルパスを紛れ込ませないため、受信側が許可項目だけを受理する契約を schema で固定する）。項目を足すときは版を上げる。
- 各 repo は、この契約の**固定したコミット**のコピーを取り込み、元との差分を検出するテストを置く。repo 間の実行時依存は作らない。

## schema で表現できない不変条件（実装とシナリオで検証する）

1. `snapshot.result.headSha` は `snapshot.expectedHeadSha` と一致する。`publish_review_result.headSha` が cycle の HEAD と違えば `RESULT_HEAD_MISMATCH`。
2. `snapshotRevision` は cycle ごとに単調増加し、状態が変わるたびに増える。同一内容の再送は増やさない。
3. `round` は PR ごとの永続単調増加値で、Squirrel のローカル round・owl の旧 round とは別物。`cycleId` は再起動後も重複せず、別 cycle に再利用しない。`round` は cycle の削除（保持期限）後も残る PR 単位のカウンタから採番し、削除・再起動をまたいでも再利用しない。
4. 同じ `idempotencyKey` は**認証主体と PR の scope**で一意。同一 payload は同じ cycle、payload 違いは `IDEMPOTENCY_CONFLICT`。key が違っても同一 PR/HEAD/reason の**未完了**依頼は既存 cycle に結合する。**取消要求中（`cancellation.state = requested`）の cycle は、同じ HEAD への再依頼を reason に関わらず結合する**（GitHub 書込み結果が不明な旧候補と新候補を並行させない）。新しい HEAD は別の対象なので新 cycle とし、旧 cycle を superseded にする。取消が確定した cycle は旧 key・旧 `sourceId` で旧 cycle を返し続け、新 round を作らない。
5. `resultVersion` は owl で単調増加。raven は、cycle の `expectedHeadSha` と異なる HEAD の結果（`RESULT_HEAD_MISMATCH`）、古い version（`RESULT_VERSION_STALE`）、取消確定済み cycle への結果（`CANDIDATE_CANCELLED`）を拒否する。結果到着後の実行終了や heartbeat で `result` / `terminal` を退行させない。
   - **superseded な cycle への遅着**: 旧 HEAD の実行結果が新 HEAD の受付後に届いた場合は拒否せず、**旧 cycle の結果参照として保存**する（その cycle は `terminalReason = superseded` のまま `result` だけを持つ）。新 cycle の `result` と状態は更新しない。GitHub 上の投稿は実在し、owl の outbox が再送し続けないようにするため。
6. `execution.sequence` は同一 `producerId`・`producerEpoch` 内で増加する。同じ sequence・同じ内容は `duplicate`（冪等 ACK）、同じ sequence・違う内容は `SEQUENCE_CONFLICT`、より小さい sequence は `OBSERVATION_STALE`。
7. 取消要求の間（`cancellation.state = requested`）は `terminal = false`。owl の無効化 ACK が返って初めて `confirmed` / `terminal = true`。
8. 結果投稿が取消より先に確定していれば取消は `CANCEL_RESULT_POSTED`。取消の配送は、同じ取消 ID の系列を**常に 1 つ**だけ保つ：配送が生きている間（バックオフ中を含む）の同じ取消 key の再送は何も変えず、試行上限とバックオフを守る。配送が終わった後（上限到達・非再送の拒否）の同じ key の再送だけが、新しい系列としての明示的な再開になる。GitHub 書込みが進行中または結果不明の間は `CANCEL_UNCONFIRMED` とし、**新 round に進めない**。
9. 非終端（`terminal = false`）の snapshot は `result = null` かつ `cancellation.state` が `none` / `requested` のいずれか。取消が確定した（`confirmed`）cycle は必ず terminal で、`result = null`。結果を持つ cycle は必ず terminal（`result` または `superseded`）。これらは schema の制約として検証する。

## snapshot の補足（設計文書に対する明確化）

設計文書の必須項目に加え、次の 2 項目を**必須**とした。`terminal` が成功完了ではない 2 つの場合（superseded / cancelled）を、消費者が区別できるようにするため。

| 項目 | 意味 |
|---|---|
| `terminalReason` | `null`（terminal でない）/ `result` / `superseded` / `cancelled`。`terminal = true` と 1 対 1 に対応する |
| `supersededBy` | `superseded` のとき後続 cycle の `cycleId`、それ以外は `null` |

プロセス終了（`execution.state = finished`）、観測停止（`freshness = stale` / `stopped`）、配送失敗（`dispatch.state = failed`）だけでは `terminal` にならない。`result` は GitHub 上の thread-owl 投稿への**参照**で、本文や Verdict の承認フラグは持たない。

## 観測 epoch の解釈（設計文書の「新 epoch を登録し旧 epoch を失効」の具体化）

専用の登録 API は設けず、`publish_review_observation` が運ぶ `producerEpoch` で表す。

- 登録済みの epoch より**大きい**値を最初に受けた観測が新 epoch を登録し、旧 epoch を失効させる。
- 同じ epoch は sequence の増加を要求する。**小さい** epoch は `EPOCH_STALE`。
- cycle に割り当てられていない `producerId`、別 PR・別 HEAD の観測は `PRODUCER_NOT_ASSIGNED`（または `HEAD_CONFLICT`）で拒否し、正しい観測を上書きしない。

## エラー code

`retryable = true` にできるのは、ACK 未受信のネットワーク障害と 5xx 相当（`UNAVAILABLE`）だけ。認証・権限・schema 競合は**自動で迂回せず**、構造化して返す。

| code | 意味 | retryable |
|---|---|---|
| `INVALID_ARGUMENT` | schema 違反（HEAD の書式、未知の項目など）。副作用なし | 不可 |
| `PERMISSION_DENIED` | repo ACL / installation 対象外。cycleId を知っていても許可しない | 不可 |
| `REQUEST_NOT_FOUND` | 該当 cycle がない | 不可 |
| `REQUEST_EXPIRED` | 保持期限後。URI を別 cycle に再利用しない | 不可 |
| `HEAD_CONFLICT` | `expectedHeadSha` が現在の PR HEAD / cycle の HEAD と異なる | 不可 |
| `IDEMPOTENCY_CONFLICT` | 同じ key で payload が異なる | 不可 |
| `REVISION_CONFLICT` | `expectedSnapshotRevision` が古い | 不可 |
| `CANCEL_RESULT_POSTED` | 結果投稿が先に確定。結果を削除・取消扱いにしない | 不可 |
| `CANCEL_UNCONFIRMED` | GitHub 書込みが進行中・結果不明。取消 ACK を保留する | 可（同じ取消 ID で再試行） |
| `CANDIDATE_CANCELLED` | 取消済みの候補への受付・起動・結果投稿 | 不可 |
| `ORIGIN_REJECTED` | owl の origin / 作成者 / fork policy に違反 | 不可 |
| `DELIVERY_EXPIRED` | 内部面（owl / Squirrel → raven）から、保持期限後に削除された依頼への遅延配送（410 相当）。公開面の読み取りは `REQUEST_EXPIRED` | 不可 |
| `EPOCH_STALE` | 失効した producerEpoch | 不可 |
| `SEQUENCE_CONFLICT` | 同じ sequence で内容が違う | 不可 |
| `OBSERVATION_STALE` | 現在より古い sequence の遅着 | 不可 |
| `PRODUCER_NOT_ASSIGNED` | 割当外の producer | 不可 |
| `RESULT_VERSION_STALE` | 古い `resultVersion` | 不可 |
| `RESULT_HEAD_MISMATCH` | 結果の HEAD が cycle の HEAD と異なる | 不可 |
| `UNAVAILABLE` | 一時的な障害（ACK 未受信、5xx 相当） | 可（上限付き） |

## 設定の既定（`fixtures/settings/valid/defaults.json`）

実装は設定値を変更できるが、`settings.schema.json` の下限を下回る値は起動時に拒否する。

| 項目 | 既定 | 下限・制約 |
|---|---|---|
| 完了・superseded・cancelled の依頼 / 冪等性台帳 / 取消記録 / owl の結果索引 | 30 日 | 30 日以上（取消記録は旧受付の再送可能期間以上）。**保持期間は互いに独立**で、依頼を削除しても冪等性 key・source の束縛は自身の期間まで残り、取消記録は**取消自身の時計**で保持する：無効化 ACK 前（`requested`）の取消は削除せず、確定（`confirmed`）した取消は確定時刻から数えて取消記録の期間まで残す（superseded などで先に終端になっていても、遅れて作られた取消記録を早期に消さない）。削除済みの依頼に届く旧 key・旧 source の再送は新 cycle を作らず、失効として返す |
| 配送の最大試行回数 | 8 | 1〜20 |
| 配送の初期バックオフ / 倍率 / 上限 / ジッタ | 1000 ms / 2 / 60000 ms / 0.2 | 100 ms 以上 / 1 以上 / 100 ms 以上 / 0〜1 |
| 再送の対象 | `network`, `http5xx` | 認証・権限・schema 競合は対象外 |
| heartbeat / stale 判定 / 許容時計差 | 60 秒 / 180 秒 / 30 秒 | stale は 120 秒以上、時計差は 0〜300 秒 |

再送上限に達したときは `dispatch.state = failed`（`errorCode = UNAVAILABLE`）とし、自動で別経路へ切り替えない。復旧は `cancel_review_request` による明示操作のみ。

## シナリオ

`scenarios/scenarios.json` は、設計文書の「後続実装の必須検証例」を、実装から独立した順序つきの呼び出しとして表す。各 step は `actor` / `op` / `input` / `expect` を持ち、`expect` は `error`（code）・`output`（出力 schema に適合する完全な出力）・`snapshot`（snapshot の項目パス → 期待値）のどれか。`event` は呼び出し以外の前提（時間経過・障害など）を表す。

Go テストが検証するのは**形**（各 `input` / `output` が schema に適合する、`snapshot` のパスが実在する、全エラー code がいずれかのシナリオで使われる）であり、実装の挙動ではない。R1 / O1 は同じシナリオを自分の実装に対して実行する相互接続テストを実装する。

## 実装状況

| 範囲 | 状況 |
|---|---|
| 台帳コア（状態遷移・冪等性・snapshot 射影・outbox への登録） | `internal/reviewrequest` に実装済み（R1 段階 1）。出力はすべて本契約の schema で検証する |
| 公開 MCP・Resource・repo ACL | 実装済み（R1 段階 2）。専用 App モード限定の opt-in（`REVIEW_RAVEN_REVIEW_REQUESTS` と `REVIEW_RAVEN_REQUEST_ACL`）。エラーは本契約の envelope を structured content で返す |
| 内部面（`ingest_review_candidate` / `publish_review_result` / `publish_review_observation`） | 実装済み（R1 段階 3a）。別 MCP サーバー `/internal/mcp`・専用 proxy 秘密・サービス主体 ACL。opt-in（`REVIEW_RAVEN_INTERNAL_SURFACE`） |
| outbox の配送 worker（再送・バックオフ・上限、取消の再開） | 実装済み（R1 段階 3b-1）。`Deliverer` インターフェース経由 |
| thread-owl 向けの配送クライアント(`internal/owlclient`)とサーバーへの配線 | 実装済み（R1 段階 3b-2）。契約 schema で入力を検証する fake の thread-owl に対してテスト。opt-in（`REVIEW_RAVEN_OWL_INTERNAL_URL` / `_TOKEN`） |
| thread-owl 側の内部面と、review-raven との相互接続 | 未実装（O1、thread-owl#279） |

## 契約を変えるとき

1. `schemas/` を変更し、対応する `valid` / `invalid` fixture とシナリオを同じ変更で更新する（`go test ./internal/contracts/` が整合を検証する）。
2. 破壊的変更は schemaVersion を上げる。
3. thread-owl・Mcp-Docker・Squirrel の取り込みコピーを更新する。
