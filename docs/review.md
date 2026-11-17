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
| 追加の再レビュー | `469537e..c3ef4a5`（`0e04e67`・`72c847f`・`3fe6ac7`・`c3ef4a5`、15ファイル、+1,709／−676行）。2026-11-18実施。コードと試験の読み合わせのみで、Goの試験・Staticcheck・相互運用試験とCIの結果は確認していない（レビュー環境にGoと`gh`がない）。結果は6節 |
| Cloudflare版のレビュー | `c3ef4a5..9eca609`（feat: add Cloudflare Durable Objects relay、43ファイル、+3,991／−623行）。2026-11-18実施。結果は7節 |

失敗した3件（`tests/protocol/crypto.test.ts`）は、レビュー環境のNode.js 18にグローバル`crypto`と`String.prototype.isWellFormed`がないことが原因である。プロジェクトはNode.js 26以上を要求している（`engines`、CI）ため、コードの不具合ではない。中継サーバーとIP制限の試験はすべて成功した。

本書は外部セキュリティ監査ではない。重要度は、仕様違反の有無と公開時の影響を基準にした目安である。

## 1. 総評

上記対象コミットでは、初回レビューの指摘は1件を除いて適切に対応されていた。仕様違反だった3.1（期限競合）と、公開前に必要だった3.2（IPv6のレート制限）は、仕様の更新と回帰試験を含めて解消した。修正内容に新たなセキュリティ上の問題は見つからなかった。

以下の対応状況には、CLI状態型・ready期限とidle期限・GoのCI検査・終了処理の修正を追記した。

1. **対応済み**：CLIの`receive()`を段階ごとの明示的な状態型へ再構成し、接続準備・ペアリング・メッセージ処理・出力完了処理を分割した（初回2.2、優先順位4）。
2. **対応済み**：CLIもready期限・idle期限の失効をサーバーの通知で確定するようにし、通知遅延による誤切断を解消した。無操作による終了では`SESSION_EXPIRED`を表示する（3.1節）。
3. **対応済み**：Goの整形検査と版を固定したStaticcheckをCIに追加した。導入時に見つかった暗号テストの未確認エラー3件も修正した（3.2節）。
4. **対応済み（今回）**：CLIの`room.close`は受信セッションごとに1回だけ送信を試行するようにし、終了処理と`defer`による二重送信を解消した（3.3節）。

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

- [`onTick()`](../cli/internal/client/receiver.go#L150)から、サーバーが通知したready期限・idle期限へのローカル到達による切断を削除した。失効は`room.closed`（`READY_TIMEOUT`・`SESSION_EXPIRED`）で確定し、Web（[`session.ts`](../web/src/session.ts)）と方針をそろえた。
- `receiverConfirming`・`receiverActivating`の期限フィールド、`pair.confirm`・`pair.active`のready期限による送信打ち切り、期限後に届いた`ready`を違反とする判定を削除した。暗号化メッセージの順序とseqの検証は引き続き行う。
- `idleExpiresAt`は緊急touchの送信時期にだけ使う。受信側自身の最終活動から30分で`idle_timeout`により終了する判定は維持した。
- `SESSION_EXPIRED`による終了では同名の診断を表示してQRを更新する。`READY_TIMEOUT`は仕様どおり`DISCONNECTED`として回復する。サーバーが応答しない場合のheartbeat（45秒）と、利用者が指定した`--timeout`の判定も維持した。

仕様4.4・11.3にも、サーバーの期限判定と通知遅延の扱いを明記した。[`receiver_test.go`](../cli/internal/client/receiver_test.go#L208)と実Go CLIの相互運用試験（[`cli.test.ts:482`](../tests/interop/cli.test.ts#L482)、`:501`）で、通知遅延中の通信継続・終了理由・QR更新・ローカルの終了条件を検証した。

### 3.2 [解消] Goの整形・lintのCI検査

Goの整形・lintをCIで検査していなかったため、[`.github/workflows/ci.yml`](../.github/workflows/ci.yml#L24)に次の2ステップを追加した。どちらもGoのセットアップ直後、Node・ブラウザの試験より前に`cli/`で実行し、失敗すればCIを停止する。

- `Check Go formatting`：`gofmt -l .`がファイルを報告したら、対象ファイル名を表示して失敗する。Goの構文エラーでも失敗する。
- `Lint Go`：`go install honnef.co/go/tools/cmd/staticcheck@v0.8.2`で版を固定して導入し、`staticcheck ./...`でテストを含む全パッケージを解析する。利用版は[Staticcheck 2026.2.2（v0.8.2）](https://github.com/dominikh/go-tools/releases/tag/2026.2.2)である。

導入時にStaticcheckが検出した`SA4006`は、[`client_test.go`](../cli/internal/client/client_test.go#L153)で`Seal()`のエラーを次の復号結果で上書きしていた3件だった。各箇所で暗号化のエラーを確認するように修正した。[`CONTRIBUTING.md`](../CONTRIBUTING.md)に同じ固定版での実行手順を追加し、仕様17.3・18.6と[`docs/validation.md`](validation.md)の検査項目も更新した。

### 3.3 [解消] 終了時の`room.close`の二重送信

プロトコル違反の`closeRoom("client_error")`と、自己の最終活動からの無操作期限による`closeRoom("idle_timeout")`の後に、`receive()`の`defer`で`closeRoom("user_end")`をもう一度試行していた。サーバーは最初の通知でroomを閉じるものの、終了時に最大100msの書き込み待ちが加わる可能性があった。

[`closeRoom()`](../cli/internal/client/receiver.go#L323)に受信セッション単位の`closeAttempted`フラグを追加し、最初の送信試行より前に記録するようにした。これにより、終了処理と`defer`の両方から呼ばれても送信の試行は1回で、`client_error`・`idle_timeout`の理由を維持する。最初の書き込みが失敗した場合も追加の試行を行わず、2回目の待ち時間を加えない。通常の後処理では`user_end`を1回試行する。

[`TestReceiverCloseRoomDuringCleanup`](../cli/internal/client/receiver_test.go#L298)は、受信待機期限・プロトコル違反・無操作期限の3経路と、書き込み成功・失敗の組合せ6ケースを検証する。試行回数、送信した終了理由、終了コードと診断キーを確認し、修正前の二重送信も再現した。

## 4. 試験について

- 前回提案した回帰試験（期限境界の偽時計、IPv6集約、LRU削除、末尾touch、恒久拒否後のコード6、`/send`、errorの重複）はすべて追加された。
- 3.1節の回帰試験を追加した。中継の通知遅延（[`socket-proxy.ts`](../tests/interop/socket-proxy.ts)）でCLIへの残り期間を短縮し、`pair.active`・`room.touched`をその期限後まで遅らせる。ACTIVE成立後にサーバーのready期限を越えても通信できることと、サーバーのidle失効通知で`SESSION_EXPIRED`とQR更新へ進むことも検証する。修正前は追加したGo試験と相互運用試験で早期切断を再現し、修正後は成功した。
- 上記対象コミットのレビューではGoの試験・相互運用試験・E2Eを実行していない。今回の2.2対応では、`go test -race ./...`・`go vet ./...`と実Go CLIの相互運用試験9件が成功した。追加した[`receiver_test.go`](../cli/internal/client/receiver_test.go)は、ハンドシェイクの順序、出力中の切断・書き込み失敗、重複受信、ACK待ちの期限と終了コードを検証する。
- 今回の3.1対応では、`go test -race -count=1 ./...`・`go vet ./...`、実Go CLIの相互運用試験12件、`tsc --noEmit`、変更したTSファイルのBiome lint・format検査がすべて成功した。
- 今回の3.2対応では、Go 1.26.2とStaticcheck v0.8.2で、追加したCIステップ・`go test -race -count=1 ./...`・`go vet ./...`がすべて成功した。ワークフローYAMLの読み込みと追加ステップのシェル構文も確認した。一時的なGoモジュールで、整形済み・lint指摘なしのコードは成功し、未整形・構文エラー・未使用コードではそれぞれ検査が失敗することを確認した。
- 今回の3.3対応では、`go test -race -count=1 ./...`・`go vet ./...`・`gofmt`の整形検査・Staticcheck v0.8.2と、実Go CLIの相互運用試験12件がすべて成功した。追加した後処理の回帰試験6ケースも成功した。
- [`docs/validation.md`](validation.md)のとおり、実機（iOS SafariのWorker経路を含む）、実HTTPS配備、WebKitでのE2Eは引き続き公開前の必須項目である。

## 5. 対応の優先順位

| 順位 | 項目 | 理由 |
| ---: | --- | --- |
| 1 | 2.2 CLI `receive()`の明示的な状態型への再構成（対応済み） | 段階ごとの状態型により、不正な状態の組合せを排除した |
| 2 | 3.1 ready期限・idle期限のローカル切断の見直し（対応済み） | 通知遅延による誤切断を防ぎ、終了理由をWebの方針と仕様に合わせた |
| 3 | 3.2 Goの整形・lintのCI検査（対応済み） | 整形と静的解析の指摘をCIで検出し、外部レビューのコストを削減する |
| 4 | 3.3 `room.close`の二重送信（今回対応済み） | 終了通知の試行を1回に抑え、最初の終了理由を維持する |

## 6. 追加の再レビュー（`469537e..c3ef4a5`）

### 6.1 対応内容の確認

| 項目 | 判定 | 確認内容 |
| --- | --- | --- |
| 2.2 CLI `receive()`の状態型 | 解消 | 旧実装（`469537e`の`session.go`）とメッセージごとの受理条件を照合し、挙動の差がないことを確認した。旧実装の`committed`・`ready`・`active`・`writing`・`written`・`rejected`・`disconnected`の組合せは状態型で表現されている。[`onData()`](../cli/internal/client/receiver_messages.go#L111)の`s.state.(*receiverConnected)`は、直前の条件により型が必ず一致するためパニックしない |
| 3.1 ready期限・idle期限のローカル切断 | 解消 | [`onTick()`](../cli/internal/client/receiver.go#L150)にサーバーの期限による切断はなく、自己の最終活動から30分・`--timeout`・heartbeatの判定は維持されている。仕様4.4・11.3の追記は実装と一致する。[`socket-proxy.ts`](../tests/interop/socket-proxy.ts)は受信順を保ったまま遅延させるため、相互運用試験の前提は実際の配送順序と一致する |
| 3.2 Goの整形・lintのCI検査 | 解消 | 追加した2ステップの位置と失敗条件は記載どおりである。`client_test.go`の修正も適切である |
| 3.3 `room.close`の二重送信 | 解消 | `closeAttempted`は受信セッションごとに初期化され、QRの再生成をまたいで残らない。6ケースの試験で、終了理由の維持と送信試行が1回であることを確認できる |

本書で参照しているコードの行番号はすべて`c3ef4a5`と一致し、実Go CLIの相互運用試験は記載どおり12件である。

### 6.2 [低] SIGINT・SIGTERMでの`room.close`（`user_end`）が届かない

[`main.go`](../cli/cmd/qrtoss/main.go#L18)はシグナルの受信時に`ctx`を取り消す。[`closeRoom()`](../cli/internal/client/receiver.go#L323)は同じ`ctx`から作ったcontextで書き込むため、`receive()`の`defer`で呼ばれた時点で取り消し済みである。coder/websocketでは、この書き込みはすぐに失敗するか、送信途中で接続が閉じられる。仕様14章（SIGINT・SIGTERMでは可能な範囲で`room.close`（`user_end`）を送る）を満たさない。

この挙動は`469537e`以前からあり、今回の変更で生じたものではない。ただし3.3の対応で送信の試行を1回にしたため、シグナルによる終了ではその1回が確実に失われる。

修正案として、`closeRoom()`だけ`context.WithoutCancel(s.ctx)`を元に100msの期限を付ける。取り消し済みの`ctx`で`closeRoom()`を呼ぶ単体試験を追加すると、回帰を防げる。

### 6.3 [低] `pair.proof`の受理状態が広い

[`onProof()`](../cli/internal/client/receiver_pairing.go#L27)は`s.candidate()`で判定するため、`receiverCommitting`（`pair.commit`の送信後）でもproofを受理する。この状態で無効なproofを受けると[L45](../cli/internal/client/receiver_pairing.go#L45)で`receiverCandidate`へ戻り、その後の`pair.committed`はプロトコル違反になる。有効なproofなら`pair.commit`を再送する。

旧実装と同じ挙動であり、サーバーが1つのcandidateに2通目のproofを中継しなければ実害はない。`s.state.(*receiverCandidate)`で受理状態を限定すれば、状態型にした意図と一致する。

### 6.4 [文書] 本書冒頭の対象範囲

冒頭の表の「対象コミット」「差分」は`469537e`のままで、本文には`0e04e67`〜`c3ef4a5`の対応も記載されている。1節の「上記対象コミットでは」と4節の「今回の…対応では」も、どの時点の記述かが混在している。対象範囲を`c3ef4a5`まで広げるか、追加コミットを表に明記するとよい。

### 6.5 [参考] CIとローカル検証のGoの版

CIはGo 1.27.4を使うが、[`docs/validation.md`](validation.md)の記録ではローカル検証にGo 1.26.2を使っている。Staticcheckの指摘はGoの版によって変わり得るため、GitHub ActionsでのCIの成功もあわせて確認する。

### 6.6 対応の優先順位

| 順位 | 項目 | 理由 |
| ---: | --- | --- |
| 1 | 6.2 シグナル終了時の`room.close` | 仕様違反であり、修正と試験が小さい |
| 2 | 6.5 CIの成功の確認 | 検証時のGoの版がCIと異なる |
| 3 | 6.3 `pair.proof`の受理状態 | 実害はないが、状態型による不正状態の排除を徹底できる |
| 4 | 6.4 本書冒頭の対象範囲 | 記録の正確さのため |

## 7. Cloudflare版のレビュー（`c3ef4a5..9eca609`）

対象は、Cloudflare WorkersとDurable Objects（DO）を使う中継サーバーの追加と、room処理の共有モジュールへの分離である。主に次のファイルを読んだ：[`packages/relay-core/src/`](../packages/relay-core/src/)、[`server/cloudflare/src/`](../server/cloudflare/src/)、[`server/src/index.ts`](../server/src/index.ts)、[`wrangler.jsonc`](../wrangler.jsonc)、[`scripts/check-cloudflare.mjs`](../scripts/check-cloudflare.mjs)、[`tests/cloudflare/`](../tests/cloudflare/)、[`tests/core/`](../tests/core/)。これらを仕様15.6節・16.10節・18.7節と突き合わせた。

### 7.1 総評

仕様15.6節の構成（Worker・RoomDO・CapacityDO）、最初の`auth`による振り分け、ストレージを使わないことは、仕様どおり実装されている。room処理は[`createRelayCore()`](../packages/relay-core/src/index.ts#L60)へ分離され、Node版もこのモジュールを使う。両版の状態遷移が分かれていない点は評価できる。仕様違反や、公開の妨げになる不具合は見つからなかった。Worker中継の送信バッファに上限がなかった点（7.3節）は今回、累計送信量の上限と回帰試験を追加して解消した。

| 仕様 | 判定 | 確認内容 |
| --- | --- | --- |
| 15.6.3 room作成 | 適合 | Workerがcapabilityを生成し、RoomDOにはSHA-256だけを渡す（[`index.ts:121-126`](../server/cloudflare/src/index.ts#L121-L126)）。CapacityDOの枠は、RoomDOの呼出しが失敗したとき、または期限内に応答がないときに返却する |
| 15.6.4 `/ws`の振り分け | 適合 | [`bridge()`](../server/cloudflare/src/bridge.ts#L20)は、最初のメッセージが`auth`として正しいことを確かめてからRoomDOへ接続する。`connecting`中に届いたメッセージは溜めずに拒否する。認証前の時間切れ・バイナリ・過大メッセージ・schema違反では、RoomDOへ接続しない（TD04で試験） |
| 15.6.5 atomicな処理 | 適合 | [`auth()`](../packages/relay-core/src/index.ts#L211)はハッシュ計算と照合の`await`を先に済ませ、その後は`await`を挟まずに状態を確認・変更する。`room`と`hash`が待機の前後で同じことも確認する。`pair.commit`は同期処理である |
| 15.6.5 Hibernationを使わないこと | 適合 | `accept()`だけを使う。`acceptWebSocket`・`serializeAttachment`・Alarmは静的検査で禁止している |
| 15.6.5 close処理 | 適合 | [`closeSocket()`](../server/cloudflare/src/runtime.ts#L36)は1005・1006等をclose codeとして送らず、1011に置き換える。互換性日付`2026-11-17`では`web_socket_auto_reply_to_close`（既定の有効化日2026-04-07）が有効になり、相手からのcloseに自動で応答する。このことはworkerdのバイナリで確認した |
| 15.6.6 非保存 | 適合（ローカル） | [`check-cloudflare.mjs`](../scripts/check-cloudflare.mjs)が、ストレージ・Alarm・attachment・cache・`console`への参照と、許可していない設定キーを禁止する。CIで実行している。TD11は、永続化ディレクトリのSQLiteの全テーブルが空であることと、秘密値がファイルにないことを確認する。本番のストレージ使用量は未確認（仕様どおり手動確認の項目） |
| 15.6.7 上限 | 適合 | [`CapacityState`](../packages/relay-core/src/capacity.ts#L17)は、リース（期限120秒、更新60秒ごと）、更新時の再登録（上限を超えていても行う）、IPごとの上限を実装している。CapacityDOに失敗したとき、または期限内に応答がないときは新規受付を503で拒否し、既存の接続は維持する（TD10） |
| 15.6.8 クライアントIP | 適合 | `CF-Connecting-IP`だけを使い、`X-Forwarded-For`は使わない。正規化のコードはNode版と共有している |
| 16.10 設定 | 適合 | `workers_dev`・`preview_urls`・`observability`が無効で、`no_web_socket_compression`、`run_worker_first`、`html_handling: "none"`、`not_found_handling: "none"`を設定している。これらは静的検査で固定されている |

### 7.2 確認した事項

- レビュー時点で101応答に付けていた空の`Sec-WebSocket-Extensions`ヘッダーについて確認した。ChromiumのWebSocket実装は、値が空の`Sec-WebSocket-Extensions`を受け取るとハンドシェイクを失敗させる。そこで、同梱のworkerd（`@cloudflare/workerd-linux-64`）に同じ応答を返すWorkerを置いて、実際の101応答を確認した。その時点のworkerdはこのヘッダーを応答から除いており、ブラウザへは届いていなかった。今回、空のヘッダー自体を削除した（7.6節を参照）。
- Node版とCloudflare版の共有試験は、`createTestRelay()`で接続先だけを切り替え、試験の内容は変えていない。Cloudflare版だけで試験を省略している箇所はない。

### 7.3 [解消] Workerが中継する送信の量に上限がない

レビュー時点では、WorkersのWebSocketに`bufferedAmount`がないため、Node版と共通の送信前検査だけでは送信量を制限できなかった。Workerも未送信量の上限なしに中継していた。受信側がTCP読み取りを止め、`hb.ping`と`room.touch`だけを送り続けた場合、heartbeatでは切断できず、送信キューが増え続けて同じisolateの他の接続へ影響する可能性があった。

今回、次のように修正した。

- [`limits.ts`](../server/cloudflare/src/limits.ts)で、ソケットの各送信方向に`MAX_TRANSFERS_PER_ROOM × MAX_WS_MESSAGE_BYTES + 1 MiB`（4,325,376バイト）の累計上限を定めた。最大100件のdata envelopeに加え、認証・ready・ack・ack_seen・activity・heartbeat・touch等の余裕を持たせた。時間経過や送信成功では回復せず、候補の交代でもリセットしない。
- Workerの[`bridge.ts`](../server/cloudflare/src/bridge.ts)は、最初の`auth`を含むWorker→RoomDOと、RoomDO→クライアントを別々に数える。共有モジュール（[`index.ts`](../packages/relay-core/src/index.ts)）には任意指定の累計送信上限を追加し、RoomDOだけで有効にした。`cipher`に限らず、すべての送信テキストをUTF-8バイト数で数え、送信前に確認する。Node版は従来の`bufferedAmount`検査を使う。
- 超過メッセージは送信せず、`SLOW_PEER`と1008で終了する。Workerでの超過も固定の内部close reasonでRoomDOに伝え、対向の通知を同じ終了理由にする。クライアントが指定したclose reasonは内部の失敗として扱わない。`error`・`room.closed`用に上限の内側に4,096バイトを予約し、終了通知も総量を超えない。
- 仕様15.6.4・15.6.5の「受信レートとheartbeatで代替する」という規定を上記方式へ改め、試験TD16を追加した。長時間の正常利用や多数の再送・操作でも累計上限に達すれば、新しいQRで再接続することを明記した。

[`backpressure.test.ts`](../tests/core/backpressure.test.ts)は、累計上限の境界、終了通知の予約領域、heartbeat応答だけでも上限に達することを確認する。TD16（[`runtime.integration.ts`](../tests/cloudflare/runtime.integration.ts)）は、試験用の中間WSプロキシを迂回してworkerdへ直接TCP接続し、読み取りを停止してもheartbeatとtouchを送り続ける。s2r・r2sそれぞれでRoomDO出力と、空白で膨らませたWorker入力の上限を検証し、別roomの通信継続、最大本文100件とack・ack_seenの完了も確認する。ランタイム内部の送信キューの上限や、heartbeatが読み取り停止を検出することには依存しない。

今回の7.3対応では、Node.js 26.13.1とGo 1.26.2で`npm test`（161件）と`npm run test:cloudflare`（53件）がすべて成功した。両runtimeの型検査、lint・整形、生成物の整合性検査、Cloudflareの静的検査、本番build、Wranglerの配備なしのパッケージ検査も成功した。検証用配備・実機での確認は行っていない。詳細は[`docs/validation.md`](validation.md)に記録した。

### 7.4 [解消] subprotocolの受理条件がNode版と違う

レビュー時点では、Node版は`qrtoss.v1`の1つだけを要求していたが、Cloudflare版は一覧に`qrtoss.v1`が含まれていれば受け付けていた。今回、[`acceptsWebSocketProtocol()`](../packages/relay-core/src/http.ts)に判定を共通化し、両アダプターから呼ぶようにした。単一の`qrtoss.v1`と前後のSP・HTABだけを許可し、未指定・空・異なる値・他のprotocolとの併記・重複指定を400（`VERSION_UNSUPPORTED`）で拒否する。判定は接続枠の取得より前に行う。

共通の中継試験（[`relay.test.ts`](../tests/relay/relay.test.ts)）は、生のHTTP upgrade要求で、複数のヘッダー行を含む12通りの不正な指定を拒否することと、単一指定・前後の空白を含む指定が101と`Sec-WebSocket-Protocol: qrtoss.v1`で成功することを確認する。TD04（[`runtime.integration.ts`](../tests/cloudflare/runtime.integration.ts)）はworkerdへ直接要求し、拒否時のエラーコードとCapacityDOの枠が消費されないことも確認する。WebSocketクライアントが不正な指定を送信前に拒否する挙動や、試験用プロキシの判定で問題を隠さない構成にした。修正前のWorkerでは`qrtoss.v1, other.v1`が101となり、追加試験が失敗することも再現した。

同一IPの接続数超過では、Node版の503（`CAPACITY`）とCloudflare版の429（`RATE_LIMITED`、`Retry-After: 6`）を維持する。この応答の差も仕様15.6.4に明記した。subprotocolの規定は仕様10.3・15.6.4とTD04にそろえた。

今回の7.4対応では、Node.js 26.13.1とGo 1.26.2で`npm test`（162件）と`npm run test:cloudflare`（55件）がすべて成功した。両runtimeの型検査、lint・整形、生成物の整合性検査、Cloudflareの静的検査、本番buildも成功した。

### 7.5 [解消] リースの返却より後に更新が届くと、最大120秒数え続ける

レビュー時点では、更新と返却を別のstubから完了を待たずに送るため、返却後に遅れた更新が届くことがあった。CapacityDOは更新時にリースを無条件で登録し直していたため、閉じたroom・接続が最大120秒、総数や同一IPの接続数に残る可能性があった。

今回、[`CapacityState`](../packages/relay-core/src/capacity.ts)が返却済みIDをroom・ソケット別に120秒間メモリへ記録するようにした。対象が見つからない返却も記録し、記録中のIDへの更新を無視して同じIDの再取得を拒否する。返却記録は有効な件数・同一IPの接続数には含めず、IDと削除期限だけを保持する。保持中の記録への遅延更新・重複返却で期限を延ばさず、期限切れの記録を次の処理で削除する。CapacityDO再起動後の既存リースの再登録は維持する。

[`capacity.test.ts`](../tests/core/capacity.test.ts)では、登録の有無、認証状態、更新・返却の両順序の8組合せと、新しいIDの受付、120秒の境界での記録削除、roomとソケットのIDの独立性を確認する。TD10（[`runtime.integration.ts`](../tests/cloudflare/runtime.integration.ts)）はworkerd上で別のstubから返却後に更新を届け、件数が復活せず、上限1件のroom・ソケット・同一IP枠でも新規認証とheartbeatが成功することを確認する。この順序を作る制御RPCは試験用エントリポイントだけにある。修正前はroom数が1へ復活して追加試験が失敗することを再現した。仕様15.6.2・15.6.7・TD10と配備手順にも返却記録の扱いを追記した。

今回の7.5対応では、Node.js 26.13.1とGo 1.26.2で`npm test`（165件）と`npm run test:cloudflare`（56件）がすべて成功した。両runtimeの型検査、lint・整形、生成物の整合性検査、Cloudflareの静的検査・非保存試験、WebビルドとWranglerの配備なしパッケージ検査も成功した。

### 7.6 [解消] 空の`Sec-WebSocket-Extensions`ヘッダーとTD04の判定

レビュー時点では、WorkerとRoomDOの101応答、WorkerからRoomDOへの内部upgrade要求に、空の`Sec-WebSocket-Extensions`を付けていた。workerdが空のヘッダーを除く挙動に依存しており、TD04の`?? ''`を使った判定も、ヘッダーの欠落と空の値を区別できなかった。

今回、[`index.ts`](../server/cloudflare/src/index.ts)・[`room.ts`](../server/cloudflare/src/room.ts)・[`bridge.ts`](../server/cloudflare/src/bridge.ts)の3か所からこのヘッダーを削除した。圧縮の無効化には互換性フラグ`no_web_socket_compression`を使う。TD04（[`runtime.integration.ts`](../tests/cloudflare/runtime.integration.ts)）はworkerdへ直接`permessage-deflate`を提示し、101応答のヘッダー値が厳密に`undefined`であることを確認する。空の値が付いていれば試験を失敗させる。

[`check-cloudflare.mjs`](../scripts/check-cloudflare.mjs)には、実行コードで拡張ヘッダーを手動指定することを禁止する検査を追加した。これにより、workerdが空の値を除去しても、空ヘッダーの再導入をCIで検出できる。修正前のコードが`CLOUDFLARE_WEBSOCKET_EXTENSIONS`で失敗し、削除後に成功することも確認した。仕様15.6.4・TD04・S46と配備手順も同じ規定へ更新した。

今回の7.6対応では、Node.js 26.13.1とGo 1.26.2で`npm run test:cloudflare`（55件）がすべて成功した。両runtimeの型検査、lint・整形、Cloudflareの静的検査、WebビルドとWranglerの配備なしパッケージ検査も成功した。検証用配備と実機ブラウザの確認は7.8節の未実施項目として残る。

### 7.7 [解消] 仕様と実装の対応

仕様17.1の提案段階のパスを、現在の実装に合わせて更新した。Node版は`server/src/`、Cloudflare版は`server/cloudflare/src/`、`wrangler.jsonc`はルートである。Web・CLI・生成スクリプト・試験の配置も実在するパスへそろえ、ルートのnpm packageと`cli/`のGo moduleを使う構成を明記した。TypeScriptの型検査の説明もこの構成に合わせた。

修正開始時点の仕様20章では、S37〜S45はすでに確認済みと記載されていた。今回、S46を含むCloudflare公式資料10件のURLと該当箇所を再確認し、確認日・対象を明記した。公式資料の確認記録と、7.8節で残る実配備・実機の受入試験の実施状況を区別した。構成表のパスの実在と、変更文書の相対リンクも確認した。

### 7.8 試験について

- このレビュー環境（Node.js 18.19.1）で実行した結果は次のとおりである。
  - `npm run check:cloudflare`、`tsc --noEmit`、`tsc --project server/cloudflare/tsconfig.json`、`biome lint`、`biome format`はすべて成功した。
  - `tests/core`と`tests/relay`は36件中35件成功した。失敗した1件は、Node.js 18に`Promise.withResolvers`がないことが原因で、コードの不具合ではない。
- `npm run test:cloudflare`は、Miniflareが`node:sqlite`（Node.js 22.5以降）を必要とするため、この環境では実行できなかった。[`docs/validation.md`](validation.md)には、Node.js 26.13.1で47件すべてが成功したと記録されている。TD04〜TD14の試験コードは読み、仕様18.7の条件を確認していることを確かめた。
- [`tests/cloudflare/worker.ts`](../tests/cloudflare/worker.ts)の仮想時計と制御用RPCは試験用のエントリポイントだけにあり、`wrangler.jsonc`が指す本番のエントリポイントには含まれていない。
- 本番相当の配備で行う試験（TD03、TD08の配備、TD11〜TD13の本番分、TD15）と、ブラウザからCloudflare版への接続は未実施である。E2EはNode版に対してだけ実行されている。7.6節のヘッダーを含め、Chromium・Safariから検証用配備へ接続する確認を、公開前の必須項目に加えることを推奨する。

### 7.9 対応の優先順位

| 順位 | 項目 | 理由 |
| ---: | --- | --- |
| 1 | 7.3 Worker中継の送信量の上限（対応済み） | 累計送信量を送信前に制限し、`SLOW_PEER`で終了する。仕様15.6.4・15.6.5とTD16も更新した |
| 2 | 7.8 検証用配備での試験とブラウザからの接続 | ローカルのworkerdでは、Cloudflareのエッジとゾーン設定の挙動を確認できない |
| 3 | 7.4 subprotocolの受理条件（対応済み） | 共通の判定関数で単一の`qrtoss.v1`だけを受理し、両版の回帰試験と仕様を更新した |
| 4 | 7.6 不要なヘッダーとTD04の判定（対応済み） | 空ヘッダーを3か所から削除し、TD04で欠落を厳密に検査する。再導入は静的検査で拒否する |
| 5 | 7.5 リースの更新と返却の順序（対応済み） | 返却済みIDへの遅延更新を120秒間無視し、件数の復活を防ぐ。期限・再起動回復とworkerdでの順序逆転を検証する |
| 6 | 7.7 仕様の記述（対応済み） | 構成表を実装に合わせ、Cloudflare公式資料の再確認日・対象と実配備での未検証項目を明記した |
