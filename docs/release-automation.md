# リリースの準備と公開

prepare / publish / finalize は release-automate の同じ固定 SHA を使う。
タグ push 起点の旧公開は廃止し、開発版の `:main` 配布は既存 docker workflow で維持する。

1. 利用者の版指定後、main の `Prepare Release` に先頭の v を除いた SemVer を指定する。
   Release bot が `bump_strategy: npm` で package.json と CHANGELOG の Unreleased を更新する。
   実行時の版は package.json から読み、別の定数は更新しない。npm 戦略のため build metadata は受け付けない。
2. 原稿・比較リンク・同一 HEAD CI・独立レビュー・未解決0を確認する。
   版・対象コミット・内容の公開許可後に `chore(release): vX.Y.Z` で squash merge する。
3. トリガー SHA に固定したタグと draft を作り、同じ SHA で frozen install、
   check/typecheck/test/build、タグと package.json の版一致を検証する。
4. amd64/arm64 のイメージを GHCR へ公開する。metadata-action の semver 規約により、
   正式版には版・minor・latest を付け、RC には latest を付けない。
5. metadata が返した版タグを再取得し、digest が build の返却値と一致することと
   manifest に linux/amd64・linux/arm64 があることを確認する。
6. 成功後だけ finalize で公開し、共通書式の Docker digest・対象 SHA・run・
   依存ジョブの証跡を追記する。自動生成の What's Changed は併記しない。

通常の導入 PR のマージでは公開しない。prepare は Organization の
RELEASE_BOT_CLIENT_ID / RELEASE_BOT_PRIVATE_KEY、公開と GHCR は GITHUB_TOKEN を使う。
検証に失敗したら draft を保持し、原因解消後に同じ run の failed jobs を再実行する。
公開後の本文追記だけが失敗した場合は、failed finalize の再実行で追記する。
タグの移動・削除や別版での自動再試行は行わない。
公開後のタグ SHA・Release の対象/公開状態/本文・イメージの digest/manifest の確認と、
各 PC への配備・実機動作確認は別々に記録する。
