# 実装レビュー（再レビュー）

| 項目 | 内容 |
| --- | --- |
| 対象 | 初回レビュー（`f7274f9`時点）の指摘への対応一式 |
| 対象コミット | `469537e`（ci: gate production audit and keep full audit advisory） |
| 差分 | `f7274f9..469537e`（60ファイル、+6,330／−1,351行） |
| 実施日 | 2026-11-18 |
| 方法 | 初回レビューの各指摘と、修正後のソースコード・[`docs/spec.md`](spec.md)・試験の突き合わせ。静的検査と一部の試験の実行 |
| 実行した検査 | `biome lint`・`biome format`・`tsc --noEmit`・`generate-protocol --check`はすべて成功。`tests/{protocol,relay,web}`は140件中137件成功（下記） |
| 未実施 | Go CLIの試験・`go vet`・TSとGoの相互運用試験（レビュー環境にGoがない）、Playwright E2E、実機・実配備での確認 |

失敗した3件（`tests/protocol/crypto.test.ts`）は、レビュー環境のNode.js 18にグローバル`crypto`と`String.prototype.isWellFormed`がないことが原因である。プロジェクトはNode.js 26以上を要求している（`engines`、CI）ため、コードの不具合ではない。中継サーバーとIP制限の試験はすべて成功した。

本書は外部セキュリティ監査ではない。重要度は、仕様違反の有無と公開時の影響を基準にした目安である。

## 1. 総評

上記対象コミットでは、初回レビューの指摘は1件を除いて適切に対応されていた。仕様違反だった3.1（期限競合）と、公開前に必要だった3.2（IPv6のレート制限）は、仕様の更新と回帰試験を含めて解消した。修正内容に新たなセキュリティ上の問題は見つからなかった。

以下の対応状況には、CLI状態型・ready期限とidle期限・GoのCI検査の修正を追記した。

1. **対応済み**：CLIの`receive()`を段階ごとの明示的な状態型へ再構成し、接続準備・ペアリング・メッセージ処理・出力完了処理を分割した（初回2.2、優先順位4）。
2. **対応済み**：CLIもready期限・idle期限の失効をサーバーの通知で確定するようにし、通知遅延による誤切断を解消した。無操作による終了では`SESSION_EXPIRED`を表示する（3.1節）。
3. **対応済み（今回）**：Goの整形検査と版を固定したStaticcheckをCIに追加した。導入時に見つかった暗号テストの未確認エラー3件も修正した（3.2節）。

## 2. 前回指摘の確認結果

| 前回の項目 | 判定 | 確認内容 |
| --- | --- | --- |
| 3.1 ローカル期限とatomic commitの競合 | 解消 | Web（[`session.ts`](../web/src/session.ts)）はローカルのQR期限で切断しなくなった。期限は残り時間の表示と、未送信proofの採否にだけ使う。CLI（[`onProof()`](../cli/internal/client/receiver_pairing.go#L27)）は、期限後のproofを検証の前後で破棄する。`pair.commit`の送信期限も候補期限から切り離された。仕様4.3にローカル期限の位置付けが追記された。偽時計による回帰試験が、中継サーバー（`commit before the QR deadline permits ready exchange after the deadline`等）、実Go CLI（[`cli.test.ts:462`](../tests/interop/cli.test.ts#L462)）、ブラウザE2E（[`transfer.spec.ts:387`](../tests/e2e/transfer.spec.ts#L387)、`:448`）にそろっている |
| 3.2 IPv6のレート制限回避 | 解消 | [`ip.ts`](../server/src/ip.ts)は、scope IDの除去、圧縮・展開表記の正規化、IPv4射影アドレスのIPv4化を行い、既定/64に集約する。プロキシの信頼判定は集約前のアドレスで行う。room作成・認証失敗・同時WS数は同じキーを使う。[`ipRecord()`](../server/src/index.ts#L144-L156)は参照のたびに`delete`→`set`し、LRUで削除する。`IPV6_PREFIX_LENGTH`の範囲検査、仕様15.3の追記、[`tests/relay/ip.test.ts`](../tests/relay/ip.test.ts)の8件の試験も確認した（すべて成功） |
| 3.3 CLIの末尾touchと自己idle判定 | 解消 | `receiverActivity`（[`receiver_state.go`](../cli/internal/client/receiver_state.go)）で保留状態を持ち、heartbeatで末尾送信する。最終活動から30分で`idle_timeout`により閉じる。単体試験と実CLIの試験（[`cli.test.ts:545`](../tests/interop/cli.test.ts#L545)）がある |
| 3.3 `/send`の配信HTML | 解消 | `send/index.html`を返す。試験も両HTMLを区別して確認する |
| 3.3 Envelopeのキー名の大文字・小文字 | 解消 | `fieldsOnly`による厳密な検査を、構造体デコードの前に行う。`TestEnvelopeFieldCase`がある |
| 3.3 候補senderへのerrorの重複 | 解消 | `fail()`は`closeCandidate(..., notifySender=false)`を呼ぶ。試験`candidate failure sends exactly one error`がある |
| 3.3 恒久拒否後の終了コード | 解消 | `violation()`は拒否の確定後にコード6を維持する。仕様14.9.1・14.12に追記され、試験もある |
| 3.3 受信ページの読み取り中表示 | 解消 | `peer_scanning`を表示し、仕様5.3にも記載された。E2E試験がある |
| 2.2 フォーマッター・リンター | 解消 | TS・JSはBiomeによるlintと整形の検査をCIで行い、生成コードは対象外とした。Goは`gofmt -l .`と版を固定した`staticcheck ./...`をCIで検査する（3.2節） |
| 2.2 `main.ts`の分割 | 解消 | `main.ts`（13行）はページの選択だけを行う。処理は`receiver.ts`・`sender.ts`・`view.ts`に分かれ、モジュールレベルの共有状態はなくなった |
| 2.2 CLI `receive()`の状態型 | **解消** | [`receive()`](../cli/internal/client/session.go#L140)を15行の接続準備と実行の呼び出しに縮小した。[`receiverState`](../cli/internal/client/receiver_state.go)の段階別の型で、ペアリング・接続・出力中・切断後の出力待ち・ACK待ちを表現する。7つの状態boolを廃止し、受信ID・ダイジェスト・出力完了チャネル・終了期限を必要な状態だけに保持する。イベント処理は[`receiver.go`](../cli/internal/client/receiver.go)、[`receiver_pairing.go`](../cli/internal/client/receiver_pairing.go)、[`receiver_messages.go`](../cli/internal/client/receiver_messages.go)へ分割した |
| 2.2 検証ロジックの重複 | 解消 | `protocol/control-messages.json`から、TSの型・検証定義とGoの検証定義を生成する。サーバーとWebは`packages/protocol`の検証を共用する。共通ベクトルを両言語で検証し、CIで生成物の差分も検査する |

## 3. 新たな指摘

### 3.1 [解消] CLIのready期限・idle期限によるローカル切断

CLIには、ローカルのready期限・idle期限だけで切断し、期限直前に成立したACTIVEやtouchの通知が遅れると有効なroomを閉じてしまう問題があった。idle期限へのローカル到達では、仕様14.14.2の`SESSION_EXPIRED`ではなく`DISCONNECTED`を表示していた。

今回、次のように修正した。

- [`onTick()`](../cli/internal/client/receiver.go#L148)から、サーバーが通知したready期限・idle期限へのローカル到達による切断を削除した。失効は`room.closed`（`READY_TIMEOUT`・`SESSION_EXPIRED`）で確定し、Web（[`session.ts`](../web/src/session.ts)）と方針をそろえた。
- `receiverConfirming`・`receiverActivating`の期限フィールド、`pair.confirm`・`pair.active`のready期限による送信打ち切り、期限後に届いた`ready`を違反とする判定を削除した。暗号化メッセージの順序とseqの検証は引き続き行う。
- `idleExpiresAt`は緊急touchの送信時期にだけ使う。受信側自身の最終活動から30分で`idle_timeout`により終了する判定は維持した。
- `SESSION_EXPIRED`による終了では同名の診断を表示してQRを更新する。`READY_TIMEOUT`は仕様どおり`DISCONNECTED`として回復する。サーバーが応答しない場合のheartbeat（45秒）と、利用者が指定した`--timeout`の判定も維持した。

仕様4.4・11.3にも、サーバーの期限判定と通知遅延の扱いを明記した。[`receiver_test.go`](../cli/internal/client/receiver_test.go#L206)と実Go CLIの相互運用試験（[`cli.test.ts:482`](../tests/interop/cli.test.ts#L482)、`:501`）で、通知遅延中の通信継続・終了理由・QR更新・ローカルの終了条件を検証した。

### 3.2 [解消] Goの整形・lintのCI検査

Goの整形・lintをCIで検査していなかったため、[`.github/workflows/ci.yml`](../.github/workflows/ci.yml#L24)に次の2ステップを追加した。どちらもGoのセットアップ直後、Node・ブラウザの試験より前に`cli/`で実行し、失敗すればCIを停止する。

- `Check Go formatting`：`gofmt -l .`がファイルを報告したら、対象ファイル名を表示して失敗する。Goの構文エラーでも失敗する。
- `Lint Go`：`go install honnef.co/go/tools/cmd/staticcheck@v0.8.2`で版を固定して導入し、`staticcheck ./...`でテストを含む全パッケージを解析する。利用版は[Staticcheck 2026.2.2（v0.8.2）](https://github.com/dominikh/go-tools/releases/tag/2026.2.2)である。

導入時にStaticcheckが検出した`SA4006`は、[`client_test.go`](../cli/internal/client/client_test.go#L153)で`Seal()`のエラーを次の復号結果で上書きしていた3件だった。各箇所で暗号化のエラーを確認するように修正した。[`CONTRIBUTING.md`](../CONTRIBUTING.md)に同じ固定版での実行手順を追加し、仕様17.3・18.6と[`docs/validation.md`](validation.md)の検査項目も更新した。

### 3.3 [情報] 終了時の`room.close`の二重送信

[`violation()`](../cli/internal/client/receiver.go)の`closeRoom("client_error")`と、自己の最終活動からの無操作期限による`closeRoom("idle_timeout")`の後に、`receive()`の`defer`で`closeRoom("user_end")`がもう一度送られる。サーバーは最初の通知でroomを閉じるため、実害はない。ただし、終了時に最大100msの書き込み待ちが加わることがある。送信済みのフラグで2回目を省くと、意図が明確になる。

## 4. 試験について

- 前回提案した回帰試験（期限境界の偽時計、IPv6集約、LRU削除、末尾touch、恒久拒否後のコード6、`/send`、errorの重複）はすべて追加された。
- 3.1節の回帰試験を追加した。中継の通知遅延（[`socket-proxy.ts`](../tests/interop/socket-proxy.ts)）でCLIへの残り期間を短縮し、`pair.active`・`room.touched`をその期限後まで遅らせる。ACTIVE成立後にサーバーのready期限を越えても通信できることと、サーバーのidle失効通知で`SESSION_EXPIRED`とQR更新へ進むことも検証する。修正前は追加したGo試験と相互運用試験で早期切断を再現し、修正後は成功した。
- 上記対象コミットのレビューではGoの試験・相互運用試験・E2Eを実行していない。今回の2.2対応では、`go test -race ./...`・`go vet ./...`と実Go CLIの相互運用試験9件が成功した。追加した[`receiver_test.go`](../cli/internal/client/receiver_test.go)は、ハンドシェイクの順序、出力中の切断・書き込み失敗、重複受信、ACK待ちの期限と終了コードを検証する。
- 今回の3.1対応では、`go test -race -count=1 ./...`・`go vet ./...`、実Go CLIの相互運用試験12件、`tsc --noEmit`、変更したTSファイルのBiome lint・format検査がすべて成功した。
- 今回の3.2対応では、Go 1.26.2とStaticcheck v0.8.2で、追加したCIステップ・`go test -race -count=1 ./...`・`go vet ./...`がすべて成功した。ワークフローYAMLの読み込みと追加ステップのシェル構文も確認した。一時的なGoモジュールで、整形済み・lint指摘なしのコードは成功し、未整形・構文エラー・未使用コードではそれぞれ検査が失敗することを確認した。
- [`docs/validation.md`](validation.md)のとおり、実機（iOS SafariのWorker経路を含む）、実HTTPS配備、WebKitでのE2Eは引き続き公開前の必須項目である。

## 5. 対応の優先順位

| 順位 | 項目 | 理由 |
| ---: | --- | --- |
| 1 | 2.2 CLI `receive()`の明示的な状態型への再構成（対応済み） | 段階ごとの状態型により、不正な状態の組合せを排除した |
| 2 | 3.1 ready期限・idle期限のローカル切断の見直し（対応済み） | 通知遅延による誤切断を防ぎ、終了理由をWebの方針と仕様に合わせた |
| 3 | 3.2 Goの整形・lintのCI検査（今回対応済み） | 整形と静的解析の指摘をCIで検出し、外部レビューのコストを削減する |
| 4 | 3.3 `room.close`の二重送信 | 動作上の影響はほぼない |
