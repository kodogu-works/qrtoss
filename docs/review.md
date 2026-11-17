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

以下の対応状況には、今回のCLI状態型の修正を追記した。

1. **対応済み（今回）**：CLIの`receive()`を段階ごとの明示的な状態型へ再構成し、接続準備・ペアリング・メッセージ処理・出力完了処理を分割した（初回2.2、優先順位4）。
2. **新規・低**：CLIは、ready期限とidle期限に限り、まだローカルの期限到達だけで切断する。3.1と同じ種類の競合が狭い範囲で残る（3.1節）。
3. **新規・低**：Goのコードには整形・lintのCI検査がない（3.2節）。

## 2. 前回指摘の確認結果

| 前回の項目 | 判定 | 確認内容 |
| --- | --- | --- |
| 3.1 ローカル期限とatomic commitの競合 | 解消 | Web（[`session.ts`](../web/src/session.ts)）はローカルのQR期限で切断しなくなった。期限は残り時間の表示と、未送信proofの採否にだけ使う。CLI（[`onProof()`](../cli/internal/client/receiver_pairing.go#L27)）は、期限後のproofを検証の前後で破棄する。`pair.commit`の送信期限も候補期限から切り離された。仕様4.3にローカル期限の位置付けが追記された。偽時計による回帰試験が、中継サーバー（`commit before the QR deadline permits ready exchange after the deadline`等）、実Go CLI（[`cli.test.ts:414`](../tests/interop/cli.test.ts#L414)）、ブラウザE2E（[`transfer.spec.ts:387`](../tests/e2e/transfer.spec.ts#L387)、`:448`）にそろっている |
| 3.2 IPv6のレート制限回避 | 解消 | [`ip.ts`](../server/src/ip.ts)は、scope IDの除去、圧縮・展開表記の正規化、IPv4射影アドレスのIPv4化を行い、既定/64に集約する。プロキシの信頼判定は集約前のアドレスで行う。room作成・認証失敗・同時WS数は同じキーを使う。[`ipRecord()`](../server/src/index.ts#L144-L156)は参照のたびに`delete`→`set`し、LRUで削除する。`IPV6_PREFIX_LENGTH`の範囲検査、仕様15.3の追記、[`tests/relay/ip.test.ts`](../tests/relay/ip.test.ts)の8件の試験も確認した（すべて成功） |
| 3.3 CLIの末尾touchと自己idle判定 | 解消 | `receiverActivity`（[`receiver_state.go`](../cli/internal/client/receiver_state.go#L155)）で保留状態を持ち、heartbeatで末尾送信する。最終活動から30分で`idle_timeout`により閉じる。単体試験と実CLIの試験（[`cli.test.ts:460`](../tests/interop/cli.test.ts#L460)）がある |
| 3.3 `/send`の配信HTML | 解消 | `send/index.html`を返す。試験も両HTMLを区別して確認する |
| 3.3 Envelopeのキー名の大文字・小文字 | 解消 | `fieldsOnly`による厳密な検査を、構造体デコードの前に行う。`TestEnvelopeFieldCase`がある |
| 3.3 候補senderへのerrorの重複 | 解消 | `fail()`は`closeCandidate(..., notifySender=false)`を呼ぶ。試験`candidate failure sends exactly one error`がある |
| 3.3 恒久拒否後の終了コード | 解消 | `violation()`は拒否の確定後にコード6を維持する。仕様14.9.1・14.12に追記され、試験もある |
| 3.3 受信ページの読み取り中表示 | 解消 | `peer_scanning`を表示し、仕様5.3にも記載された。E2E試験がある |
| 2.2 フォーマッター・リンター | 解消（TS・JS） | Biomeによるlintと整形の検査をCIで行い、生成コードは対象外とした。Goは対象外のまま（3.2節） |
| 2.2 `main.ts`の分割 | 解消 | `main.ts`（13行）はページの選択だけを行う。処理は`receiver.ts`・`sender.ts`・`view.ts`に分かれ、モジュールレベルの共有状態はなくなった |
| 2.2 CLI `receive()`の状態型 | **解消（今回）** | [`receive()`](../cli/internal/client/session.go#L140)を15行の接続準備と実行の呼び出しに縮小した。[`receiverState`](../cli/internal/client/receiver_state.go)の段階別の型で、ペアリング・接続・出力中・切断後の出力待ち・ACK待ちを表現する。7つの状態boolを廃止し、受信ID・ダイジェスト・出力完了チャネル・終了期限を必要な状態だけに保持する。イベント処理は[`receiver.go`](../cli/internal/client/receiver.go)、[`receiver_pairing.go`](../cli/internal/client/receiver_pairing.go)、[`receiver_messages.go`](../cli/internal/client/receiver_messages.go)へ分割した |
| 2.2 検証ロジックの重複 | 解消 | `protocol/control-messages.json`から、TSの型・検証定義とGoの検証定義を生成する。サーバーとWebは`packages/protocol`の検証を共用する。共通ベクトルを両言語で検証し、CIで生成物の差分も検査する |

## 3. 新たな指摘

### 3.1 [低] CLIはready期限・idle期限のローカル到達だけで切断する

[`onTick()`](../cli/internal/client/receiver.go#L148)は、次の2つの場合にroomを閉じてコード`DISCONNECTED`で再接続へ進む。

- `receiverConfirming`または`receiverActivating`で、ローカルのready期限に到達した。
- `receiverConnected`で、ローカルのidle期限に到達した。

これらの期限も、QR期限と同じくサーバーが単調時計で判定し、`room.closed`（`READY_TIMEOUT`・`SESSION_EXPIRED`）で通知する。ローカルでも打ち切ると、次の競合が起こり得る。

| ケース | 経過 | 影響 |
| --- | --- | --- |
| ready期限 | CLIが期限内に`pair.active`を送り、サーバーが期限直前にACTIVEへ移行した。返送された`pair.active`がローカル期限の後に届いた | サーバーと送信側は接続済みと判断しているが、CLIは切断し、`room.close`（`user_end`）を送る。送信側は「接続済み」の直後に`PEER_CLOSED`を受け取る |
| idle期限 | 期限直前の活動で緊急touchを送り、サーバーが期限を延長した。`room.touched`がローカル期限の後に届いた | 延長済みのセッションを切断する |

ローカル期限は通知を受け取った時点を基準に計算するため、片道の遅延分だけ遅くなる。このため競合が起こる範囲は狭く、重要度は低い。ただし、次の2点が仕様の方針と一致しない。

- Web（[`session.ts`](../web/src/session.ts)）は同じ期限でローカルに切断しない。
- idle期限へのローカル到達では`DISCONNECTED`を表示する。仕様14.14.2では、無操作期限による終了は`SESSION_EXPIRED`を表示する。

今回の状態型への再構成では、この切断条件の動作は変更していない。

**修正提案**

- ready期限・idle期限の判定は、サーバーの`room.closed`に任せる。サーバーが応答しない場合は、heartbeatの途絶（45秒）で検出する。仕様4.3のQR期限と同じ扱いである。
- 保険としてローカル判定を残す場合は、数秒の猶予を加える。idle期限での表示は`SESSION_EXPIRED`にそろえる。
- 自己の最終活動から30分の判定（`activity.expired`、仕様4.4）は、受信側自身が決める期限なので現状のままでよい。

### 3.2 [低] Goのコードに整形・lintの検査がない

TS・JSはBiomeで検査するようになった。一方、CIでGoに対して実行するのは`go vet`と`govulncheck`だけで、`gofmt -l`による整形の確認や静的解析（`staticcheck`等）を行わない。今回の状態型への再構成では長い条件式も分割して整形したが、Goの整形・lintのCI検査は未対応である。

**修正提案**：CIに`test -z "$(gofmt -l .)"`と`staticcheck ./...`（または`golangci-lint`）を追加する。

### 3.3 [情報] 終了時の`room.close`の二重送信

[`violation()`](../cli/internal/client/receiver.go#L245)の`closeRoom("client_error")`と、idle期限の`closeRoom("idle_timeout")`の後に、`receive()`の`defer`で`closeRoom("user_end")`がもう一度送られる。サーバーは最初の通知でroomを閉じるため、実害はない。ただし、終了時に最大100msの書き込み待ちが加わることがある。送信済みのフラグで2回目を省くと、意図が明確になる。

## 4. 試験について

- 前回提案した回帰試験（期限境界の偽時計、IPv6集約、LRU削除、末尾touch、恒久拒否後のコード6、`/send`、errorの重複）はすべて追加された。
- 3.1節の競合を再現するには、中継の通知遅延（[`socket-proxy.ts`](../tests/interop/socket-proxy.ts)）を使い、`pair.active`・`room.touched`をサーバーの期限後までCLIへ遅らせる試験が使える。
- 上記対象コミットのレビューではGoの試験・相互運用試験・E2Eを実行していない。今回の2.2対応では、`go test -race ./...`・`go vet ./...`と実Go CLIの相互運用試験9件が成功した。追加した[`receiver_test.go`](../cli/internal/client/receiver_test.go)は、ハンドシェイクの順序、出力中の切断・書き込み失敗、重複受信、ACK待ちの期限と終了コードを検証する。
- [`docs/validation.md`](validation.md)のとおり、実機（iOS SafariのWorker経路を含む）、実HTTPS配備、WebKitでのE2Eは引き続き公開前の必須項目である。

## 5. 対応の優先順位

| 順位 | 項目 | 理由 |
| ---: | --- | --- |
| 1 | 2.2 CLI `receive()`の明示的な状態型への再構成（今回対応済み） | 段階ごとの状態型により、不正な状態の組合せを排除した |
| 2 | 3.1 ready期限・idle期限のローカル切断の見直し | Webと方針をそろえ、表示する終了理由を仕様に合わせる |
| 3 | 3.2 Goの整形・lintのCI検査 | 外部レビューのコスト削減 |
| 4 | 3.3 `room.close`の二重送信 | 動作上の影響はほぼない |
