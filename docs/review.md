# 初期実装レビュー

| 項目 | 内容 |
| --- | --- |
| 対象 | 初期実装一式（Web受信・送信ページ、中継サーバー、CLI受信クライアント、配布スクリプト） |
| 対象コミット | `f7274f9`（feat: add support for custom paths in web application） |
| 実施日 | 2026-11-17 |
| 方法 | [`docs/spec.md`](spec.md)の全節とソースコードの突き合わせによる静的レビュー |
| 未実施 | テストの実行（レビュー環境にNode.js・Goがなかったため）、実機・実配備での確認 |

本書は外部セキュリティ監査ではない。指摘の重要度は、仕様違反の有無と公開時の影響を基準にした目安である。

## 1. 総評

実装方針・実装内容ともに概ね良好で、致命的なセキュリティ上の問題は見つからなかった。主な課題は次の3点である。

1. クライアント側のローカル期限判定が、サーバーのatomic commitと競合する（仕様違反）。
2. IP単位のレート制限がIPv6で実質的に機能しない（公開前に対応が必要）。
3. TypeScript・Goのコードの記述密度が高く、レビュー・保守のコストが大きい。

## 2. 実装方針の評価

### 2.1 良い点

- **暗号設計**：PSKはURLフラグメントだけで共有し、サーバーへ送らない。HKDFのsaltに`roomId/peerId/rNonce/sNonce`を含むトランスクリプトのSHA-256を使い、役割ラベル付きのHMACで相互proofを行う。方向別鍵、`seq`由来のIV、`room/peer/dir/seq`を束縛するAAD、`ready`/`ready_ack`による鍵確認後のACTIVE移行により、中継サーバーによる改ざん・方向偽装・別roomへの流用・リプレイを一通り検出できる。前方秘匿性がないことも仕様に明記されている。
- **共通定義の一元化**：`protocol/*.json`からTS・Goの定数を生成し、テストベクトルを共有しているため、言語間の互換性を機械的に検証できる。
- **中継サーバーの防御**：同期処理によるatomic commit、単調時計による期限管理、capabilityのハッシュ保持と`timingSafeEqual`による照合、認証前エラーの`PAIR_UNAVAILABLE`への一本化、ログ非出力、上限付きバッファ、Originの完全一致検査。
- **CLIの出力安全性**：text形式でC0/C1制御文字とbidi制御文字を拒否し、端末へのエスケープシーケンス注入を防いでいる。stdoutへの書き込みは別goroutineで行い、flush後にackを送る。TLS検証を無効化するオプションを持たない。
- **試用ランチャー**：キャッシュの所有者・権限の検査、検証後のrenameによる置換など、丁寧に作られている。
- **検証記録**：[`docs/validation.md`](validation.md)が未検証項目を明示しており、検証状況を過大に主張していない。

### 2.2 懸念

#### コードの記述密度と静的検査

**対応済み（TypeScript・JavaScript）**：Biomeによる整形とlintを導入し、CIで両方を検査する。型検査は`npm run check`として維持し、生成コードは整形対象から除外する。以下は修正前の指摘である。

[`server/src/index.ts`](../server/src/index.ts#L307-L310)には300文字を超える条件式があり、[`web/src/main.ts`](../web/src/main.ts)・[`web/src/session.ts`](../web/src/session.ts)は1行に複数の文を詰めた記述が多い。外部レビューを前提とするセキュリティ関連コードでは、読みにくさがレビューコストと見落としのリスクに直結する。また`npm run lint`は`tsc --noEmit`と同一で、実質的なリンターがない。

**提案**：Prettier（またはBiome）とESLintを導入し、CIで検査する。整形は機能変更と別のコミットで行う。

#### 状態の暗黙性

**Web部分は対応済み**：`main.ts`を初期化とページ選択に絞り、送信・受信の処理と状態を`sender.ts`・`receiver.ts`へ分離した。共通の画面枠は`view.ts`で共有する。CLIの明示的な状態型への置き換えは未対応。以下は修正前の指摘である。

- [`web/src/main.ts`](../web/src/main.ts)は約25個のモジュールレベル変数で、受信ページと送信ページを`sender ? … : …`の分岐により1ファイルで扱っている。
- CLIの[`receive()`](../cli/internal/client/session.go#L154)は約530行の単一関数で、状態を`committed/ready/active/writing/written/rejected/disconnected`の7つのboolで表している。

**提案**：`main.ts`を`receiver.ts`と`sender.ts`に分割する。CLIは仕様14.9.1の状態図（Starting/Pairing/Connected/Writing/Draining/Renewing/Done/Failed）に対応する明示的な状態型へ置き換え、不正な状態の組合せを表現できないようにする。

#### 検証ロジックの重複

**制御メッセージは対応済み**：`protocol/control-messages.json`からTSの型・検証定義とGoの検証定義を生成する。Web・サーバーの制御検証とサーバーのenvelope検証を共通パッケージへ統合した。独立した共通ベクトルで両言語の型・値域・宛先・厳密なフィールド集合を検証する。暗号化された内部メッセージの検証と、接続状態・権限の検証は各実装に残る。以下は修正前の指摘である。

入力検証が4か所に分散している：サーバーの`b64`/`exact`、`packages/protocol`、`web/src/session.ts`の`parseControl`、Goの`cli/internal/client/json.go`。サーバーは`packages/protocol`を利用していない。

**提案**：サーバーで`packages/protocol`の検証関数を共用する。さらに制御メッセージのschemaを`protocol/`の言語非依存JSONで定義し、定数と同様にTS・Goへ生成する（仕様17.2の拡張）。

## 3. 実装上の指摘と修正提案

### 3.1 [中] ローカル期限判定がサーバーのatomic commitと競合する

**対応済み**：Web・CLIのローカルQR期限による切断・room更新を廃止し、サーバーの失効通知を待つよう修正した。CLIはcommit送信の通信期限を候補期限から切り離し、期限後のproofを無視する。サーバーの偽時計と通知遅延を使った期限境界の回帰試験を、Web・実Go CLI・中継サーバーに追加した。以下は修正前の指摘である。

仕様4.3は「commit成功後は300秒のQR期限を接続済みセッションに適用しない」、仕様14.9.2は「期限境界での成立と失効の競合はサーバーのatomic commitで一意に決まる」「未使用QRの失効はサーバーの`room.closed`（`PAIR_EXPIRED`）で知る」と定める。次の箇所がこれに反する。

| 箇所 | 問題 | 影響 |
| --- | --- | --- |
| [`web/src/main.ts:272`](../web/src/main.ts#L272) | `phase`が`waiting`または`pairing`ならローカル期限で`close()`する。`phase`はcommit後も`pair.active`受信まで`pairing`のまま | 期限直前にcommitし、ready交換が期限をまたぐと成立済みセッションを自ら切断する |
| [`cli/internal/client/session.go:442`](../cli/internal/client/session.go#L442) | `!committed`の間にローカル期限が来るとroomを作り直す | `pair.commit`送信から`pair.committed`受信までの間に期限が来ると同様に切断する |
| [`cli/internal/client/session.go:517`](../cli/internal/client/session.go#L517) | ローカル候補期限・QR期限を過ぎて届いた`pair.proof`を`violation()`扱いにする | ネットワーク遅延の揺らぎだけで終了コード4（プロトコルエラー）で終了する。Web側（[`session.ts:230`](../web/src/session.ts#L230)）は同条件を黙って破棄しており、こちらが正しい |

**修正提案**

- Web：`pair.commit`送信後（または`committed`後）はローカル期限による切断を行わない。`Session`にcommit済みかを公開するか、`phase`に`committing`相当を設けて区別する。
- CLI：`pair.commit`を送った後は`pairDeadline`を判定に使わない。未commitの期限切れは、通信断がない限りサーバーの`room.closed`（`PAIR_EXPIRED`）を待つ。サーバーが応答しない場合の保険として、ローカル期限に数秒の猶予を加えた上限を設けるのは差し支えない。
- CLI：期限後に届いた`pair.proof`は`violation()`ではなく無視（`continue`）する。サーバーが候補を閉じれば`pair.candidate_closed`が届く。
- 試験：サーバーの`now`を注入した偽の時計で、期限直前のcommitとready交換が期限をまたぐケース、期限直後にproofが届くケースを追加する（Web・CLIとも）。

### 3.2 [中] IP単位のレート制限がIPv6で回避できる

**対応済み**：IPv6を既定/64（`IPV6_PREFIX_LENGTH`で変更可能）に集約し、IPv4射影アドレスの表記も正規化した。同一のキーをroom作成・認証失敗・同時WS数に適用し、制限記録をLRUで削除する。集約・表記揺れ・プロキシの信頼境界・4,096件での削除を検証する回帰試験を追加し、仕様15.3と自己ホスト設定を更新した。以下は修正前の指摘である。

[`server/src/index.ts:104-114`](../server/src/index.ts#L104-L114)はIPv6アドレスを完全一致でキーにしている。利用者は通常/64のアドレス空間を自由に使えるため、room作成（10回／分）や認証失敗（20回／分）の制限を容易に回避できる。また4,096件に達したときの削除が挿入順（FIFO）であり、`entry.at`の更新でMapの順序が変わらないため、多数のアドレスで既存の記録を押し出してリセットできる。

**修正提案**

- IPv6はプレフィックス（既定/64、設定で/56等に変更可能）に正規化してからキーにする。IPv4射影アドレス（`::ffff:`）の正規化と同じ箇所で行う。
- Mapの削除をLRUにする（参照時に`delete`→`set`し直して末尾へ移す）。
- 同一IP同時WS数（`maxSocketsPerIp`）の集計も同じ正規化キーで行う。
- 仕様15.3にIPv6の集約単位を追記する。

### 3.3 [低] その他

**対応済み**：CLIの末尾touchと自己の最終活動に基づく無操作終了、送信専用HTMLの配信、Envelopeのキー名の厳密検査、候補senderへのerror通知の重複解消、恒久拒否後の終了コード6の維持、受信ページの読み取り中表示を実装した。拒否確定後の扱いを仕様に追記し、関連する回帰試験を追加した。以下は修正前の指摘である。

| 箇所 | 問題 | 修正提案 |
| --- | --- | --- |
| [`cli/internal/client/session.go:371`](../cli/internal/client/session.go#L371) | `room.touch`の集約で捨てた活動を後から送らない（仕様4.4の末尾送信がない）。サーバーのidle期限が最大15秒早まる。また自己の最終活動から30分の判定と`room.close`（`idle_timeout`）を行わない | Webの`touchPending`と同様に保留フラグを持ち、heartbeatのタイミングで送る。自己判定のidle期限到達時は`idle_timeout`で閉じる |
| [`server/src/index.ts:170`](../server/src/index.ts#L170) | `/send`に受信側の`index.html`を返す。動作はするが、送信ページのtitle・descriptionが受信用になり、ビルドされた`send/index.html`が本番で使われない | `/send`は`send/index.html`を返す。テスト（[`tests/relay/relay.test.ts:287`](../tests/relay/relay.test.ts#L287)）も両方のHTMLを用意して区別を確認する |
| [`cli/internal/client/crypto.go:140`](../cli/internal/client/crypto.go#L140) | `Envelope`を構造体へデコードするため、Goの`encoding/json`の仕様でキー名の大文字・小文字を区別しない（`{"ROOM":…}`を受け付ける）。サーバーの検査とAEADがあるため実害はないが、仕様9.4の厳密さと異なる | 内側メッセージと同様に`map[string]json.RawMessage`で受けて`fieldsOnly`で検査する |
| [`server/src/index.ts:225-228`](../server/src/index.ts#L225-L228) | `fail()`が候補senderに`error`を送った後、`closeCandidate()`も`error`を送るため、2回届く | `fail()`から`closeCandidate(..., notifySender=false)`を呼ぶ |
| [`cli/internal/client/session.go:399-405`](../cli/internal/client/session.go#L399-L405) | 恒久拒否の確定後にプロトコル違反を受けると終了コード4になる。出力成功後の違反は0を維持する設計と一貫しない | 拒否確定後の違反は警告を出してコード6を維持する。仕様14.12に拒否時の扱いを明記する |
| [`web/src/main.ts:152`](../web/src/main.ts#L152) | 受信ページが`status: scanning`を表示しない（`scanned`のみ） | 送信側で読み取り中であることを状態表示に反映するか、意図的に表示しない旨を仕様に記載する |

## 4. 試験について

- 中継サーバー、CLI、TS送信側とGo受信側の相互運用、ブラウザE2Eの各試験が揃っており、特に実際のGo受信側との相互運用試験は価値が高い。
- 3.1の期限境界の競合は、サーバーの`now`注入を使えば決定的に再現できる。修正と同時に回帰試験を追加する。
- 3.2はIPv6アドレスを変えた多数のroom作成要求で検証できる。
- [`docs/validation.md`](validation.md)のとおり、実機（iOS SafariのWorker経路を含む）、実HTTPS配備、WebKitでのE2Eは未検証であり、公開前の必須項目として残る。

## 5. 対応の優先順位

| 順位 | 項目 | 理由 |
| ---: | --- | --- |
| 1 | 3.1 期限競合の修正と回帰試験 | 仕様違反。CLIは異常終了（コード4）につながる |
| 2 | 3.2 IPv6の集約とLRU削除 | 公開配備での濫用対策 |
| 3 | 2.2 フォーマッター・リンター導入、`main.ts`の分割（対応済み） | 外部レビューと保守のコスト削減 |
| 4 | 2.2 CLI `receive()`の明示的な状態型への再構成 | 不正な状態の組合せを排除 |
| 5 | 2.2 制御メッセージschemaの`protocol/`からの生成（対応済み） | 言語間の検証のずれを防止 |
| 6 | 3.3 その他の低重要度項目 | 個別に小さく対応可能 |
