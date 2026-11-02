# reviewer中断通知の契約

Mcp-Docker#391 / thread-owl#315のAPI側契約。reviewerが安全に投稿先を確定できる中断を、通常のレビュー完了と分けて記録する。実行進捗はSquirrelの公開JSON、配送はresource-bridge-cliのままとする。

## 開始時の固定値

`enqueue_review`は既存statusをpendingに戻し、不透明なUUIDの`attemptId`と、取得したPR HEADの`attemptHeadSha`を保存する。同じHEADの再enqueueでも別のIDとなる。再起動後に古いIDを再利用しない。状態は従来どおりメモリ内の直近100 PRのみで、永続的な依頼台帳ではない。

`get_pr`は`pr` / `origin` / `reviewAttempt` / `files`の順で返す。`reviewAttempt`は開始時の`{ attemptId, headSha, status }`、存在しなければnull。非同期readの途中で次enqueueが来ても開始時の値を新しいattemptへ差し替えない。reviewerはローカル検証開始前にIDとHEADを固定し、queued通知ではpendingかつPR HEADと同じheadShaを要求する。

依頼側もenqueue直後のstatusからIDを固定する。途中でIDが変われば他のラウンドとして扱い、自動で新しいIDを採用しない。

## post_review_stop

| 入力                                  | 契約                                                          |
| ------------------------------------- | ------------------------------------------------------------- |
| owner / repo / prNumber               | 確定した対象PR                                                |
| delivery                              | `queued`または`comment-only`                                  |
| attemptId                             | queuedでは開始時のUUID必須。comment-onlyでは指定禁止          |
| notificationId                        | run開始時に固定するUUID。結果不明時も変更しない               |
| reviewedHeadSha / currentHeadSha      | 40桁小文字hex。対象HEADと通知先の確認時HEADを区別する         |
| code                                  | 下記の通知可能コードのみ                                      |
| facts / unverified / resumeConditions | 各1〜4096文字。観測事実・未検証範囲・再開条件。秘密を含めない |

通知可能コードは`STALE_REVIEW`、`LOCAL_CONTENT_CHANGED`、`LOCAL_ENVIRONMENT_DIFFERENCE`、`REPOSITORY_STATE_UNSAFE`、`VERIFICATION_INTERRUPTED`、`INVALID_COMMENT_POSITION`、`VERDICT_TOOL_UNAVAILABLE`、`VERDICT_FORMAT_INVALID`。origin拒否・認証/read失敗・対象/binding不明の代替投稿経路には使わない。HEADが異なる場合はSTALE_REVIEWのみ許可する。改行差異を無視したり、環境を暗黙に変更してレビューを続行したりするAPIではない。

サーバーは両repo許可（tool設定とwrite context）、PR番号/URL/open状態、現在のoriginとHEADを検証する。コメント全ページを取得した後にもPRを再取得する。読取・認証失敗、途中HEAD移動、対象不一致はwrite前に停止する。判定後のGitHub更新との原子性はないため、コメントには確認時HEADを記す。

本文は固定の「レビュー中断」見出し、PR、両HEAD、停止コード、識別子、3つの詳細欄から生成する。詳細は引用として埋め込み、HTMLをエスケープする。正常完了の照合を壊す`Review Verdict` / `READY_TO_MERGE` / `APPROVED` / `verdict:`を含む詳細は拒否する。

queuedは開始時ID・HEAD・pendingを投稿直前にも照合する。投稿後も同じpendingなら、`status: stopped`、`headSha: reviewedHeadSha`、`summaryCommentId: null`、`stop: { notificationId, commentId, code, currentHeadSha }`を保存し、同じreview status URIへ更新通知を送る。正常完了や次attemptは上書きしない。同じroundのstoppedを通常完了へ更新することも拒否する。

comment-onlyはqueueを経由しない直接CLI用で、statusを一切更新しない。存在するpendingを推測で使わず、enqueueも行わない。

成功応答は`{ ok: true, commentId, notification: "posted" | "existing", statusUpdated, attemptId }`。`ok`は操作の結果であり、レビュー成功ではない。GitHub投稿中に次enqueueが来ると、旧attemptのコメントは残るが`statusUpdated: false`となる。comment-onlyと、既にstoppedの重複確認でもfalse。状態更新とGitHub投稿は非原子的なので、この部分成功を未通知・正常完了へ置き換えない。

## 高々1回の通知と結果不明

- queuedの重複キーはPRとattemptId。comment-onlyはPRとnotificationId。本文の固定マーカーにキーのSHA-256を含める。
- 同一PRの並行呼出しをプロセス内で排他する。成功済みの照合には全コメントを読み、`user.type=Bot`かつ`performed_via_github_app.id`が設定された数値GitHub App IDと同一であることを要求する。個人投稿や別Appのマーカーは信用しない。
- 一致コメントが1件・同一本文なら再投稿しない。複数一致や本文変更はCONFLICT。queuedが停止済みなのにコメントが消えていても再投稿しない。
- createCommentの失敗は結果不明として扱い、同一キーをプロセス内で再送禁止にする。結果不明キーは最大100件で、それ以上は通知受付を止める。これは成功扱いの自動復旧ではない。
- 呼出側は結果不明なら同じbindingの投稿者検証済みreaderで一度照合し、ID・App投稿者・対象を報告して停止する。IDを変えたり、サーバー再起動・別認証・通常summaryを使って再送したりしない。確認できたコメントも通常完了を意味しない。
- 再起動後の成功済みcomment-only通知もGitHubマーカーで検出する。ただしGitHubにはコメント作成の冪等キーがなく、別プロセス間の同時投稿や、結果不明後のreadにまだ現れない投稿まで原子的に重複排除できない。単一プロセス運用と、結果不明時に呼出側が再送しない契約を前提とする。厳密な分散exactly-onceは主張しない。

## 購読側と移行

1. APIを先に公開・配備し、正常完了APIとreader v2の意味を維持する。新skillの配布はAPI配備後に行う。未対応サーバーへのsummary fallbackはしない。
2. 両skillの対応はMcp-Docker#391で行う。reviewerは通常終了の完了writeちょうど1回と、中断通知高々1回を分離する。既に通常完了を書いたrunでは停止通知を追加しない。
3. reviewed側はack/URI/PR/固定attempt・対象HEADを照合する。stoppedを受けたら中断理由を取得して待機を打ち切り、修正・再実行条件を報告する。reviewed/approvedやREADY_TO_MERGEとして採用しない。HEAD移動では対象と現在値を別に報告し、古いattemptの結果を採用しない。
4. resource-bridge-cliは汎用の通信成功とJSONを返す。exit 0のみでレビュー完了と判断しない。購読前に既に停止していた場合も、現在値の照合でstoppedを認識する。更新配送と業務判定を分離する。
5. toolに到達せずプロセスが落ちた場合や通知不可の場合、statusはpendingのままになり得る。同じPCではSquirrelのfreshなfinishedを観測しstatusを再readした上で停止する。直接CLIなどで観測できなければ有限timeoutと未確認の報告を維持する。全クラッシュの検知や停止理由の取得を保証しない。

正常summary/Verdict/APPROVEの既存APIは投稿開始時の内部roundを照合する方式を維持する。今回の開始時attempt照合を既存API全体へ拡張したとは扱わない。新しい停止状態を使うには対応skillが必要で、APIマージだけで#391全体の完了・公開・配備・実App write E2Eとはしない。
