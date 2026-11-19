# qrtoss 仕様書

スマートフォンで読み取ったQRコードの内容を、別の端末のブラウザまたはターミナルへ転送するサービス qrtoss の統合実装仕様である。

| 項目 | 内容 |
| --- | --- |
| 文書名 | qrtoss 仕様書（`docs/spec.md`） |
| 文書バージョン | 1.1.0 |
| 作成日 | 2026-11-15（1.1.0の改訂：2026-11-18） |
| 状態 | 初版の開発実装あり。検証状況は[`docs/validation.md`](../docs/validation.md)。Cloudflare Durable Objects版の中継サーバー（第15.6節）も実装あり。本番環境での検証は未実施。公開・外部セキュリティ監査は未実施 |
| サービス名 | qrtoss |
| 対象 | Web受信ページ、Web送信ページ、中継サーバー（Node版・Cloudflare Durable Objects版）、CLI受信クライアント、自己ホスト構成、配布、検証・公開手順 |
| 通信プロトコル識別子 | `qrtoss/1`（WebSocket subprotocol `qrtoss.v1`） |
| CLIのコマンド名 | `qrtoss` |
| ライセンス | MIT License（SPDX識別子: `MIT`）。全文はリポジトリルートの`LICENSE.md` |
| 説明用の公開origin | `https://qrtoss.example`（例示用の予約ドメイン。稼働中のサービスを意味しない） |

## 目次

1. [目的と仕様の読み方](#1-目的と仕様の読み方)
2. [要件の対応表](#2-要件の対応表)
3. [構成と実装技術](#3-構成と実装技術)
4. [共通の設定値と有効期限](#4-共通の設定値と有効期限)
5. [Web画面仕様と状態](#5-web画面仕様と状態)
6. [転送内容の扱い](#6-転送内容の扱い)
7. [多言語仕様](#7-多言語仕様)
8. [セキュリティと非保存の境界](#8-セキュリティと非保存の境界)
9. [識別子・接続用URL・暗号方式](#9-識別子接続用url暗号方式)
10. [HTTP APIとWebSocket制御プロトコル](#10-http-apiとwebsocket制御プロトコル)
11. [ペアリングとroomの状態遷移](#11-ペアリングとroomの状態遷移)
12. [暗号化アプリメッセージと受領確認](#12-暗号化アプリメッセージと受領確認)
13. [エラーコードと表示・回復](#13-エラーコードと表示回復)
14. [CLI受信クライアント](#14-cli受信クライアント)
15. [中継サーバーの実装要件](#15-中継サーバーの実装要件)
16. [自己ホスト・配布・公開構成](#16-自己ホスト配布公開構成)
17. [リポジトリとモジュールの分担](#17-リポジトリとモジュールの分担)
18. [受け入れ条件と試験](#18-受け入れ条件と試験)
19. [実装順序と完了の定義](#19-実装順序と完了の定義)
20. [参考資料](#20-参考資料)

[付録A. 暗号プロトコルとCLI出力の公開テストベクトル](#付録a-暗号プロトコルとcli出力の公開テストベクトル)
[付録B. 変更履歴](#付録B-変更履歴)

## 1. 目的と仕様の読み方

スマートフォンで読み取ったQRコードの内容を、別の端末へ転送する。受信先は、PC・スマートフォン・タブレットのブラウザ（Web受信ページ）、またはターミナル上のコマンド（CLI受信クライアント `qrtoss`）とする。送信側はスマートフォン等のブラウザで動く送信ページである。Webで利用する場合は、両端ともアプリ、ブラウザ拡張、PWAをインストールせずに利用できる。どの構成でも利用者アカウントは不要とする。

受信側が表示した接続用QRコードを送信端末の標準カメラで読み、開いた送信ページで対象のQRコードをスキャンする。送信端末に内容を表示し、利用者が送信したときだけ、端末間で暗号化された内容を中継サーバー経由で受信側へ転送する。Web受信ページは設定に従って内容を表示するか同じタブで開き、CLIは内容を標準出力へ書き出す。

本書の「必須」「禁止」「しなければならない」は実装の受け入れ条件である。「推奨」は理由を記録したうえで変更できる。「対象外」「将来対応」は初版の完了条件に含まない。値・API・暗号化手順は、実装者がそのまま契約として使用できる初期仕様を定める。設計上の数値は業界標準の必須値ではない。

本書中のJSON例は仕様例であり、稼働中のAPIを表すものではない。暗号化の組合せと独自のペアリング手順は実装レビューの対象であり、本書を暗号プロトコルの安全性証明や第三者監査結果として扱ってはならない。

### 1.1 用語

| 用語 | 意味 |
| --- | --- |
| 受信側 / receiver / R | 転送内容を受け取る側。Web受信ページまたはCLI受信クライアント |
| Web受信ページ | ブラウザで`/`を開いた受信側。PC・スマホ・タブレットを区別しない |
| CLI受信クライアント / CLI | ターミナルで動く受信側のコマンド`qrtoss`。1回の起動につき1件の受信内容を標準出力へ書き出して終了する |
| 送信側 / sender / S | ブラウザの送信ページ`/send`。カメラでQRコードを読み、利用者の操作で内容を送信する |
| 中継サーバー / relay | WSS接続を管理し、接続中の相手へ暗号文を即時転送するサーバー |
| 接続用QR | 受信側が表示する、ペアリングURLを含むQRコード |
| 対象QR | 利用者が読み取り、内容を転送したいQRコード |
| room | 受信側1台と送信側1台を対応付ける一時セッション。CLIの説明で「セッション」と書く場合はcommit済みのroomを指す |
| candidate / peer | 接続を試みている送信側。相互認証とcommit後に正式な相手となる |
| PSK | 接続用QRで共有する32バイトの一時秘密情報。サーバーへ渡さない |
| capability | サーバー上の役割・参加権限を表すランダムなトークン。PSKとは別物 |
| 受理処理 | 受信側が内容を受け取り、受信側の種類ごとに定めた処理を完了すること（第12.3節） |
| 非保存 | 本文・暗号文をDB、ファイル、ログ、オフラインキューへ保存しないこと |
| stdout / stderr | CLIの標準出力（fd 1）と標準エラー出力（fd 2） |
| レコード | CLIが1件の受信内容についてstdoutへ書き出すバイト列 |

### 1.2 初版で実装する範囲

- ブラウザだけでの1対1の接続、カメラによるQR読み取り、送信前確認。
- Web送信ページとCLI受信クライアントの1対1の接続。スマホ側の操作はWeb受信時と同じ。
- Web受信ページは設定なしでHTTP(S) URLを開き、それ以外は原文を表示する。
- CLIによる1件の受信内容の標準出力への書き出しと終了。text形式・JSON Lines形式。
- 任意のQR文字列の転送・表示・コピー。Web受信ページで自動実行する対象は第6章で定める。
- 接続用QRの失効・再生成、接続状態・読み取り状態・送信状態の表示。
- ブラウザのWeb Crypto APIとCLIのGo標準ライブラリによる同一方式の端末間暗号化と、WSSによる即時中継。
- 日本語・英語・スペイン語の利用者向け表示。他の言語を追加できる翻訳ファイル構成。
- ソース公開可能な配布物と自己ホスト手順。CLIのOS・CPU別バイナリと版固定の試用ランチャー。
- 中継サーバーの2つの実装：VPS等でリバースプロキシの背後に置くNode版と、Cloudflare WorkersとDurable Objectsで動くCloudflare版（第3.4節、第15.6節、第16.10節）。どちらもクライアントとの通信形式と暗号方式を変えない。

### 1.3 初版の対象外

- 直接P2P接続、WebRTC、STUN、TURN。
- アプリ・拡張機能の配布、インストールを前提とするWeb利用。CLIは利用者が明示的に導入・実行するコマンドとして提供する。
- 利用者登録、ログイン、永続的な端末登録、過去の転送履歴。
- 受信側がオフラインの間の保管・後日配信。切断後に同じroomへ復帰するセッション再開。
- ファイル転送、複数送信端末・複数受信端末の同時参加、CLIからの送信。
- サーバーによるQR画像解析、URLのタイトル・サムネイル取得、短縮URLの展開。
- 外部広告、外部アクセス解析、実行時の外部翻訳API、自動クラッシュレポート。
- CLIのサブパス配備への接続、およびビルド済みブラウザアセットの配置先を再ビルドなしで起動時に切り替えること。ブラウザ版のビルド時指定によるサブパス配備は対象に含む。
- CLIのWindows対応、常駐デーモン、クリップボードの自動操作、受信内容のシェル評価・実行、URLやアプリの自動起動、`--insecure`等のTLS検証の無効化。

## 2. 要件の対応表

### 2.1 Web・共通の要件

| ID | 要件 | 実装上の決定 |
| --- | --- | --- |
| R01 | Webの両端ともインストール不要 | HTTPSの通常のWebページを使用する |
| R02 | 受信側もスマホでよい | 端末判定で役割を固定せず、受信画面をレスポンシブにする |
| R03 | 接続用QRで送信側を起動 | `/send`とフラグメントの接続情報を使用する。Web受信ページとCLIは同じ形式のURLを表示する |
| R04 | 読み取り後に送信前確認 | 読み取り完了時は本文を送らず、明示的な「送信」でのみ転送 |
| R05 | 受信操作を単純化 | QRと有効期限を表示し、Web受信モードは`auto_open`固定。選択UIなし |
| R06 | 同じタブで直接開く | 対象のWeb URLを`location.assign()`で開く。新規タブは作らない |
| R07 | URL以外を表示 | 自動遷移できない内容は原文を表示・コピー。内容欄は必要時のみ表示 |
| R08 | QRコードに有効期限 | 未接続QRは作成から60秒。接続済みの無操作期限とは分離する |
| R09 | 期限切れ後に接続し直せる | 新しいroom・capability・PSKを作り直す |
| R10 | 状態に応じた案内 | 送信側は操作とボタンの文言・無効状態、受信側は案内文・QR置換・期限で示す。通常の状態バーは設けない |
| R11 | HTTP(S)に転送対象を限定しない | 元の文字列を送る。開く動作は受信側が内容の種類で分類する |
| R12 | 中継サーバーで復号できない | PSKを端末内で共有し、本文をAES-256-GCMで暗号化する |
| R13 | 転送データを保存しない | 即時中継のみ。本文・暗号文の永続保存とオフラインキューは禁止 |
| R14 | 直接P2Pは不要 | 同一originのWSSのみを使用する |
| R15 | 日本語・英語・スペイン語 | Webの全画面・全エラーを3言語で提供する。CLIの表示は英語 |
| R16 | 他言語を追加できる | 辞書分離・言語交渉・手動切替。第7章に候補を規定 |
| R17 | ソース公開・自己ホスト | Web・中継サーバー・CLI、固定依存、配備手順を一式提供 |
| R18 | 配信コードを管理 | ライブラリを同梱し、第三者CDN・外部広告・解析スクリプトを使用しない |

### 2.2 CLI受信クライアントの要件

| ID | 必須要件 | 主な定義箇所 |
| --- | --- | --- |
| C01 | ターミナル上に、接続用URLを符号化したQRコードを文字で描画する | 14.8 |
| C02 | 単体コマンドによる通常起動と、`curl ... \| sh`による試用起動を提供する | 14.3、16.8 |
| C03 | スマホ側の接続・読み取り・確認・送信の操作をWeb受信時と共通にする | 5.2、11、12 |
| C04 | 受信内容を標準出力へ渡し、URLやアプリを自動起動しない | 14.6、14.7 |
| C05 | QRコード、状態、警告、エラーを標準エラー出力へ分離する | 14.6、14.8 |
| C06 | 1回の起動につき1件だけ受信し、出力後に終了する | 14.1、14.12 |
| C07 | HTTP/HTTPS以外のスキームと通常の文字列を転送対象とする | 14.7 |
| C08 | 任意の有効なUnicode文字列をJSON Linesで可逆に出力できる | 14.7.3 |
| C09 | 接続用QRの失効・更新、接続・受信・切断の状態を扱う | 14.8、14.9 |
| C10 | Web受信ページと同じ端末間暗号化を使い、中継サーバーで復号・永続保存しない | 9、14.13 |
| C11 | stdoutへの書き込み成功後に、スマホへ受領確認を返す | 12.3、14.11 |
| C12 | 同一セッション内の再送による重複出力を抑制する | 12.5、14.11 |
| C13 | ソース公開、自己ホスト、依存関係を固定したビルドを可能にする | 14.5、16.7、17 |

## 3. 構成と実装技術

### 3.1 全体構成

```mermaid
flowchart LR
    subgraph sender["送信端末（スマホ等）"]
        S["送信ページ /send"]
    end
    subgraph origin["公開origin（HTTPS・WSS）"]
        P["HTTPSリバースプロキシ"] --> M["中継サーバー"]
    end
    subgraph receiver["受信端末（roomごとにどちらか1台）"]
        W["Web受信ページ /"]
        C["CLI受信クライアント qrtoss"]
    end
    S <-->|"WSS・暗号文"| P
    W <-->|"WSS・暗号文"| P
    C <-->|"WSS・暗号文"| P
    W -.->|"接続用QRを画面に表示"| S
    C -.->|"接続用QRを端末に文字表示"| S
```

1つのroomの受信側は、Web受信ページかCLIのどちらか1台である。中継サーバーは受信側の種類を区別せず、同じAPIとプロトコルで扱う。User-Agent等で処理を分岐しない。

端末間の本文は次の経路を通る。WSSのTLS暗号化とは別に、送信側と受信側で本文を暗号化する。中継サーバーがWSSの終点になっても、アプリケーションの本文を復号できない構成にする。

```mermaid
sequenceDiagram
    participant S as 送信ページ
    participant M as 中継サーバー
    participant R as 受信側（Web/CLI）
    R-->>S: 接続用QRで一時秘密を共有
    S->>M: 相互認証メッセージ
    M->>R: 相互認証メッセージを中継
    R->>M: 相互認証の応答
    M->>S: 応答を中継
    S->>S: 読み取り・内容確認・送信
    S->>M: 暗号化した本文
    M->>R: 暗号文を即時中継
    R->>R: 受理処理（Webは検証・保持、CLIはstdoutへ書き出し）
    R->>M: 暗号化した受領確認
    M->>S: 受領確認を中継
    S->>M: 受領確認を受け取った通知
    M->>R: 通知を中継
    R->>R: 表示・同じタブで開く（Web）、終了（CLI）
```

### 3.2 推奨する参照実装

| 部分 | 選択 |
| --- | --- |
| Webフロントエンド | TypeScript、Vite、通常のDOM。UIフレームワークは初版では不要 |
| 中継サーバー | Node版：Node.js LTS（26 LTSを推奨）、TypeScript、`ws`。HTTP APIはNode標準HTTPで実装可能。Cloudflare版：Cloudflare Workers、Durable Objects、TypeScript、`wrangler`（第15.6節）。roomの処理は両版で共通のモジュールを使う |
| CLI | Go（サポート中の安定版。`crypto/hkdf`を標準で含むGo 1.24以降）。単一の実行ファイル |
| 暗号 | ブラウザはWeb Crypto API、CLIはGo標準の`crypto/*`。暗号プリミティブを自作しない |
| QR読み取り（Web） | 読取アダプター経由で`qr-scanner`を使用。Workerを含め同じoriginから配信 |
| QR生成 | Webは`qrcode`（soldair/node-qrcode）をブラウザ内で使用。CLIはGoのQR符号化ライブラリでモジュール行列を得て、端末描画は第14.8節の規則で実装する |
| WebSocket（CLI） | RFC 6455準拠の保守されたGoライブラリ（例：`github.com/coder/websocket`、`github.com/gorilla/websocket`） |
| 端末制御（CLI） | `golang.org/x/term`（TTY判定・端末寸法） |
| 共通定義 | `protocol/`の言語非依存JSON（定数・エラーコード・テストベクトル）からTS・Goの定数を生成（第17.2節） |
| パッケージ管理 | npmとコミット済み`package-lock.json`。CI・配備は`npm ci`。CLIはGo modulesと`go.sum` |
| テスト | Nodeのテストランナー、ブラウザ統合テスト、`go test`、相互運用試験、iPhone/Android実機確認 |
| 配備 | Node版：単一Nodeプロセス＋HTTPSリバースプロキシ。Docker Composeの例を提供。Cloudflare版：`wrangler`の設定ファイルと、カスタムドメインまたは`workers.dev`のURL（第16.10節） |
| CLI配布 | OS・CPU別バイナリ、SHA-256一覧と署名、Homebrew tap、版固定の試用ランチャー |

Node.js 26は2026年10月にLTSへ移行し、Node.js 24はMaintenance LTSの期間にある。Node.js 27以降は年1回のメジャーリリースとなる予定である。実装開始時にサポート状況と依存パッケージのライセンス・既知脆弱性を確認し、採用する正確なバージョンとコンテナdigestを固定する。新しいLTSへの変更は、プロトコル互換性を維持して行える。[S01] [S02] [S03] [S04] [S30]

`qr-scanner`は、BarcodeDetector APIが使える場合はそれを使い、使えない場合は同梱Workerで読み取る。iPhone/iPadのSafariはBarcodeDetectorを既定で提供していないため、iOSではWorker経路が主経路になる[S31]。`qr-scanner`は2024年3月より後の更新が確認できない（採用時に再確認する）。読取処理は第17章の読取アダプターに閉じ込め、実機試験で問題が出た場合に置き換えられるようにする。代替としてWebAssembly版のデコーダー（例：ZXing-C++のWASM版を用いるBarcodeDetector polyfill）を採用する場合は、wasmを同じoriginから配信する設定と、CSPの`script-src`への`'wasm-unsafe-eval'`の追加が必要になる。その場合は第16.4節のCSPと関連試験を更新する。

CLIの暗号は、`crypto/sha256`、`crypto/hmac`、`crypto/hkdf`、`crypto/aes`、`crypto/cipher`のGCM、`crypto/rand`で実装でき、第三者の暗号ライブラリを必要としない。[S32]

### 3.3 配備上の前提

- フロントエンド、API、`/ws`を同じ公開originで提供する。
- ブラウザ版は公開URLのルートパス配備に加え、ビルド時の `QRTOSS_BASE_PATH`（既定値 `/`）で指定するサブパス配備に対応する。例は `/qrtoss/`。リバースプロキシが接頭辞を取り除き、Nodeサーバーへ既存のルートパスで転送する。CLIと同梱Compose/Caddy構成はルートパス配備を対象とする。
- 同じWi-Fiへの接続は不要。送信端末と受信側（ブラウザまたはCLI）から公開originのHTTPS/WSSに接続できることが条件。CLIが外部からの接続を待ち受ける必要はない。
- Node版は1プロセスのメモリ内room管理とする。Node版を複数プロセスや複数ノードへ自動スケールすることは対象外。Cloudflare版はroomごとにDurable Objectを割り当て、room状態をそのメモリだけに持つ（第15.6節）。
- プロセス再起動時（Cloudflare版では新版の配備やDurable Objectの再起動時）には該当するroomを失効させ、再ペアリングを求める。

### 3.4 中継サーバーの実装の選択

中継サーバーにはNode版とCloudflare版がある。どちらも第10章のHTTP API・WSS・制御メッセージ、第9章の暗号方式（HKDF-SHA256、AES-256-GCM）、第4章の期限、第13章のエラーコードに従う。Web受信ページ、送信ページ、CLIはどちらにも同じ実装で接続する。

| 項目 | Node版 | Cloudflare版 |
| --- | --- | --- |
| 想定する配備先 | VPS、自宅サーバー、コンテナ。Apache・Nginx・Caddy等のHTTPSリバースプロキシの背後に置く | Cloudflare WorkersとDurable Objects。Cloudflareで管理するカスタムドメイン、または`workers.dev`のURL |
| room状態の置き場所 | 1プロセスのメモリ内`Map` | roomごとのDurable Object（RoomDO）のメモリ |
| room総数・接続数の上限 | プロセス内のカウンター | 配備に1つのDurable Object（CapacityDO）によるリース管理（第15.6.7節） |
| TLSの終端 | 運用者のリバースプロキシ | Cloudflare |
| 接続元IP・時刻・暗号文長を観測できる者 | 運用者のサーバーとプロキシ | 運用者に加えてCloudflare（第15.6.6節） |
| ブラウザ版のサブパス配備 | 可（第3.3節） | 対象外。ルートパス配備だけとする |
| roomが失われる契機 | プロセスの再起動 | 新版の配備、Durable Objectの再起動・退去 |

VPS上でApacheまたはNginxを前段に置く場合はNode版を使う。この場合はCloudflare向けのコードと設定を必要としない。1つの公開originへの要求をNode版とCloudflare版へ振り分けてはならない。同じroomへの接続が別の実装に届くと接続が成立しない。

## 4. 共通の設定値と有効期限

### 4.1 共通プロトコル定数

以下は全構成要素で同じ値を使う。`protocol/constants.json`を正とし、TS・Goのコードは生成した定数を参照する（第17.2節）。片側だけを環境変数や設定で変更してはならない。

| 設定名 | 初期値 | 意味 |
| --- | ---: | --- |
| `PAIRING_TTL_SECONDS` | 60 | room作成後、新規ペアリングを完了できる期間 |
| `CANDIDATE_TTL_SECONDS` | 10 | 候補送信端末の認証を待つ時間 |
| `READY_TIMEOUT_SECONDS` | 10 | commit後の暗号化ready交換を待つ時間 |
| `SESSION_IDLE_SECONDS` | 120 | 接続後の無操作期限 |
| `AUTH_TIMEOUT_SECONDS` | 5 | WebSocket接続後、最初のauthを待つ時間 |
| `HEARTBEAT_INTERVAL_SECONDS` | 15 | 接続確認の間隔 |
| `HEARTBEAT_TIMEOUT_SECONDS` | 45 | 相手から応答がない場合の切断判定の上限 |
| `DELIVERY_ACK_TIMEOUT_SECONDS` | 10 | 本文送信後に送信側がackを待つ時間 |
| `ACK_SEEN_TIMEOUT_SECONDS` | 5 | 受信側がack送信後にack_seenを待つ時間 |
| `TOUCH_COALESCE_SECONDS` | 15 | `room.touch`と`activity`を集約する間隔 |
| `TOUCH_URGENT_REMAINING_SECONDS` | 30 | 無操作期限の残りがこれ以下なら`room.touch`を即時送信 |
| `MAX_TEXT_UTF8_BYTES` | 16384 | 1件の読み取り文字列の上限 |
| `MAX_PLAINTEXT_BYTES` | 22528 | 暗号化前JSON全体の上限。本文は`textB64`で格納 |
| `MAX_WS_MESSAGE_BYTES` | 32768 | 外側のWSメッセージ上限 |
| `MAX_CONTROL_MESSAGE_BYTES` | 2048 | 暗号文以外の制御メッセージ上限 |
| `MAX_SOCKET_BUFFER_BYTES` | 65536 | 接続ごとの送信バッファ上限、復号待ち行列の合計上限 |
| `MAX_RECEIVE_QUEUE_MESSAGES` | 8 | クライアントの復号待ち行列の件数上限 |
| `MAX_TRANSFERS_PER_ROOM` | 100 | 1つのroomで受理または拒否を確定できる一意のmessageId数 |

中継サーバーの運用上限（room総数、接続数、レート制限等）は第15.3節と第16.2節で定め、配備設定で調整できる。

### 4.2 CLI固有の設定値

| 設定 | 値 | 意味 |
| --- | --- | --- |
| 1回の接続試行の上限 | 15秒 | DNS、TCP、TLS、room作成、WebSocketハンドシェイク、受信側の`auth.ok`までを含む。回復予算・`--timeout`の残りでさらに短縮する |
| 回復予算 | 30秒 | 初期接続と、roomの作り直しのたびに適用する再試行全体の上限 |
| 再試行の待ち時間 | 1、2、4、8、8秒… | 各回±20%の揺らぎを付ける。429の`Retry-After`が長ければそれを下限とする。予算を超えて開始しない |
| 受信後の終了猶予 | 2秒 | 出力成功の確定から、ack送信・ack_seen待ち・終了処理までの上限 |
| 1回の起動で受け付ける新規メッセージ | 1件 | 出力または恒久拒否の結果を確定し、受領確認と終了処理を行う |
| `--timeout`の既定値 | 0 | 0は利用者指定の待機期限なし |

CLIの重複判定記録は、受け付けた1件のメッセージについてだけ保持する。受信WebSocketメッセージの上限は共通値の`MAX_WS_MESSAGE_BYTES`に従う。

### 4.3 QRの有効期限

公開する時刻の単位はミリ秒とし、`pairingExpiresAt = roomCreatedAt + PAIRING_TTL_SECONDS * 1000`とする。新規参加時とcommit直前の両方で、サーバー時刻が期限未満であることを確認する。期限と同時刻は期限切れとする。

候補の期限は`min(pairingExpiresAt, candidateCreatedAt + CANDIDATE_TTL_SECONDS * 1000)`とする。候補の認証が終わる前に期限が切れた場合、接続を確定しない。

commitが成功した後は、この60秒の期限を接続済みセッションに適用しない。接続済みセッションは無操作期限で管理する。単にQRの残り時間がゼロになったことを理由に、認証済み通信を切断してはならない。

残り時間はサーバーから受け取る`serverTime`と`pairingExpiresAt`を基に計算し、画面復帰時に再評価する。タイマーが呼ばれた回数で残り秒数を減らす実装は禁止。

ローカルのQR期限は残り時間表示と未送信proofの採否にだけ使い、期限到達だけで切断・roomの更新を行わない。commitの送信中・応答待ちも含め、失効はサーバーの`room.closed`（`PAIR_EXPIRED`）で確定する。ローカル期限後に届いた候補のproofはプロトコル違反とせず無視し、候補の終了通知を待つ。サーバーが応答しない場合は第10.6節のheartbeatで通信断を検出する。

### 4.4 接続後の無操作期限

活動の判定は受信側が行う。受信側は、活動とみなす事象の後に活動時刻を更新し、受信側権限の`room.touch`をサーバーへ送る。活動とみなすのは次だけとする。

- Web受信ページでの利用者の実際の操作（言語変更、コピー、開く、内容の消去等）。
- 送信側から届き、復号・schema検証に成功した暗号化メッセージのうち`activity`、`status`、`data`。同じmessageIdの再送を含む（再送は利用者の明示操作でだけ行われる）。

`ready`、`ready_ack`、`ack_seen`、heartbeat、暗号化に失敗したパケット、サーバーの制御通知、カメラのフレーム到着、定期タイマーは活動に数えない。CLIには利用者の操作がないため、送信側からの上記メッセージだけが活動となる。送信側の読み取り開始・停止・再試行などは、内容を含まない暗号化`activity`または`status`で受信側へ伝える。

この活動管理はACTIVE中だけに適用する。ready交換中はtouchを送らず、ACTIVE移行時に鍵確認完了を初期活動として1回touchする。接続前の言語変更で、QRの有効期限を延長してはならない。

`room.touch`は`TOUCH_COALESCE_SECONDS`間隔に集約できるが、最後の活動を反映する末尾送信も行う。サーバーの通知した残り時間が`TOUCH_URGENT_REMAINING_SECONDS`以下なら即時送信する。ネットワーク遅延でサーバー期限を越えた場合、失効したroomを復活させない。

サーバーはcommit時点および受信側の正当な`room.touch`を受けた時刻から無操作期限を管理し、更新後の期限を両端へ通知する。受信側も自己の最終活動から120秒を越えていれば`room.close`（`idle_timeout`）で終了する。送信側は独自の無操作期限を設けず、サーバーの失効・切断通知とheartbeatに従う。

通知された`idleExpiresAt`へのローカル到達だけでは切断せず、サーバーの`room.closed`（`SESSION_EXPIRED`）を待つ。期限直前のtouchに対する`room.touched`が遅れても、延長済みのroomを切断しない。受信側自身の最終活動から120秒の判定は維持し、サーバーが応答しない場合は第10.6節のheartbeatで通信断を検出する。

### 4.5 QR再生成と切断

- Web受信ページは再読み込み・新しいアクセスで新しいroom・capability・PSKを作成する。QR再生成ボタンは設けない。
- CLIは、本文受付前の未使用QRの失効、セッションの終了、通信断の後に、新しいroom・capability・PSKを自動で作成し、新しいQRを追記表示する。本文受付後は、その1件の処理結果に従って終了する（第14.9節）。
- 同じPSKや接続IDでQR画像だけを書き直してはならない。
- 旧roomに接続していた相手は切断する。古いQRから新しいroomへ参加できない。
- 初版では、切断後に同じroomへ復帰するプロトコルを実装しない。新しいQRで接続し直す。
- 未送信の内容は送信側の開いたページのメモリに残してコピーできるが、新しい相手へ自動転送しない。ページを離れた場合は破棄する。

## 5. Web画面仕様と状態

### 5.1 受信画面 `/`

受信画面は単一の接続用QRを中心に構成する。ヘッダーはqrtossロゴ、GitHubへのリンク、言語選択の順とする。状態表示、受信後の動作選択、新規QRボタン、共有禁止の説明、初期状態の受信内容欄は設けない。

初回表示は「スマホのカメラで、このQRコードを読み取ってください」、接続用QR画像、有効期限の順とし、その下にキャッチコピーと7項目の紹介を配置する。各言語の文言・レイアウトは [デザイン設計書](design.md) に定める。QRと有効期限は通常のPC・スマートフォンviewport内に収め、紹介部分の縦スクロールを許可する。

相互認証とready交換が完了した接続では、案内を「スマホのカメラで、QRコードを読み取ってください」に切り替える。QRは元の画像に幅256px換算で5pxのぼかしを焼き込んだ画像へ置き換え、ぼかし前の一時画像は破棄する。元画像へのCSSのblurだけで代用しない。未接続QRの期限切れがサーバーから通知された場合も、同じぼかし処理で置き換え、残り時間を0秒にする。「QRコードの有効期限が切れました。」の右横にリロードアイコンのボタン（アクセシブル名は「QRコードを再生成」）を表示し、押すと新しいroomと接続用QRを生成して60秒の期限を開始する。無操作タイムアウト、サーバーとの切断・再起動、相手端末の切断のメッセージの右横にも同じボタンを表示する。表示領域のサイズと位置は保ち、有効期限を「0 秒」に固定する。切断後も使用済みの画像を復元しない。QRの失効・再参加の拒否は引き続きサーバーが強制する。

Web受信ページの通信モードは`auto_open`固定とし、モード選択・変更UIは提供しない。互換性のため、通信上の`display_only`値と他クライアントの処理は維持する。

受信側で再検証した有効なHTTP(S) URLは、第12章の最終受領確認と前面表示条件を満たした後に同じタブで開く。それ以外の内容は原文のままテキスト表示する。受信内容の欄は、その表示が必要になった時だけ現れる。`external`もテキストとして扱い、アプリを自動起動しない。自動遷移が非表示や確認タイムアウトで取り消された場合は、内容と手動でWebページを開く操作を表示する。本文のコピーと消去を提供する。内容欄は紹介部分より前に配置し、前面で受信が完了した場合は内容欄へスクロールして提示する。

接続用QRは第9.2.1節の条件で生成する。通常は180〜260 CSS px、スマートフォンでは240〜260 CSS px程度とし、白い余白を確保する。320 CSS px幅でも横スクロールを発生させない。残り秒数を毎秒読み上げない。回復が必要なエラーは翻訳済みの文で案内し、再接続にはページを再読み込みして新しいroomを作成する。

### 5.2 送信画面 `/send`

共通ヘッダー（ロゴ・GitHub・言語選択）の下に、読み取り時は「送信するQRコードを読み取ってください」、大きなカメラ枠、対応カメラのズーム、白背景の「写真から読み込む」を配置する。状態バーと受信モード表示は設けない。操作領域の下に受信側と同じキャッチコピー・紹介文を表示する。

フラグメントを直ちに除去し、相互認証後にカメラを自動起動する。読み取り後はカメラを止め、元のURL・テキストを表示し、黒背景の「送信」、白背景の「読み取り直す」「写真から読み込む」「コピー」を順に表示する。本文の送信は明示操作だけで行う。長文は折り返し・スクロールでき、ドメイン別表示、URLの事前アクセスやサムネイル取得は行わない。送信中は二重送信・再読み取り・写真読み込みを無効化する。送信中・送達済みは送信ボタンの文言・無効状態で示し、拒否・送達確認失敗のエラーは必要時に案内する。

`mode`はUIに表示しないが、通信上の`auto_open`・`display_only`・`stdout`を引き続き処理する。`stdout`は1件の結果確定後、追加の読み取り・送信を無効化する。受信が拒否された場合は原文とコピーを残す。状態・暗号化・受領確認・件数制限の契約は維持する。

### 5.3 状態コード

| 画面 | 状態 | 表示と有効操作 |
| --- | --- | --- |
| 受信 | `creating` | QR画像を準備する。通常の状態表示は設けない |
| 受信 | `waiting` | 読み取り案内、QR、残り時間を表示 |
| 両方 | `pairing` | 接続を確認中。相互認証完了までは「接続済み」にしない |
| 両方 | `connected` | 送信側は読み取り開始可能。受信側は案内文・読み取り不能のQR画像・0秒表示へ切り替える |
| 送信 | `scanning` | カメラ映像、読み取りガイド、対応カメラのズーム操作、写真読み込み |
| 送信 | `scanned` | 読み取り完了。プレビューと送信・再読取 |
| 受信 | `peer_scanning` | 相手で読み取り中。停止・起動失敗時は`ready`（プレビューがあれば`scanned`）の通知で状態を戻す。受信済み本文は保持し、受領確認中の表示は優先する |
| 受信 | `peer_scanned` | 内部状態のみ。接続後の案内・画像・0秒表示を保持し、本文はまだ表示しない |
| 送信 | `sending` | 受領確認待ち。二重送信不可 |
| 受信 | `received_waiting_confirm` | 復号・内容検証済み。最終確認を待つ |
| 送信 | `delivered` | 相手の受領を確認。リンク先の表示成功を意味しない |
| 送信 | `rejected` | 受信側が内容を拒否した（出力形式非対応）。プレビュー・コピーを維持し、新しいQRでの接続を案内 |
| 受信 | `displaying` | 内容・コピー・対応する開く操作を表示 |
| 受信 | `navigating` | 同じタブへ遷移するための終了処理中 |
| 両方 | `disconnected` | 接続が切れた。未送信内容の自動送信は禁止 |
| 両方 | `expired` | QR期限または接続期限切れ。再接続を案内 |
| 送信 | `camera_denied` | カメラ許可拒否。設定案内と利用者による再試行 |
| 両方 | `error` | 翻訳済みの具体的なエラーと回復操作 |

送信画面の状態は必要な操作の表示とボタンの文言・無効状態で示し、通常の状態バーは設けない。色だけで区別しない。受信画面の通常状態は、案内文・QR画像・残り秒数の切り替えだけで表す。通常の状態通知は`aria-live="polite"`を使う。エラー時にプレビュー内容を読み上げ領域へ不用意に追加しない。

### 5.4 カメラ・モバイル・ブラウザ履歴

- `getUserMedia()`は映像だけを要求し、マイクを要求しない。背面カメラを優先する。[S05]
- 送信画面は安全な接続成立後にカメラを自動起動する。初回のカメラ使用許可はブラウザが求める。起動失敗時のみ利用者による再試行を提示する。`video`は`muted`、`autoplay`、`playsinline`を使用する。
- 許可拒否・カメラなし・他アプリの使用中・非HTTPSを区別し、許可ダイアログを自動で繰り返さない。
- 読み取り成功・停止・ページ離脱で映像トラックを停止する。
- `visibilitychange`で非表示になった場合はカメラを停止する。復帰後は接続を確認し、未読取かつカメラ起動に失敗していない場合に自動再開する。読取済み内容の自動送信や、許可拒否後の自動再試行は行わない。
- 写真ライブラリの画像は端末内でQR検出し、カメラと同じ内容検証・明示的送信の処理へ渡す。画像自体はサーバーに送信しない。読み取りガイドは検出範囲を制限しない。
- 受信画面が非表示の間に内容が届いた場合、受信と受領確認は行えるが、自動遷移は行わず表示待ちにする。復帰時に手動で開けるようにする。
- 即時の操作・受信を保証する条件は、両端のページを開き、受信側を前面に表示していることとする。
- `pagehide`でカメラとWSSを閉じ、鍵・capability・本文への参照を破棄する。
- `pageshow`でBFcacheから復元された場合は旧セッションを再利用せず、終了状態を表示する。戻る操作で過去の内容を再送・再遷移してはならない。[S06]
- 新しいタブやポップアップを自動生成しない。

## 6. 転送内容の扱い

### 6.1 原文保持（共通）

転送するのはQRデコーダーが返した文字列である。前後空白の除去、改行変換、Unicode正規化、URLデコード、HTMLエンティティ変換を行わず、原文を保持する。

上限は`TextEncoder`で符号化したUTF-8の16,384バイト。超過・空文字は送信前に理由を表示する。JavaScriptの不正な単独サロゲートを含む入力は、勝手に置換して送らず、デコード不能として表示する。バイナリQRの完全なバイト列転送、複数QRの構造的連結、独自文字コードの完全対応は初版の対象外。

QRコードのバイト列から文字列への変換はQRデコーダーが行う。日本で多いShift_JIS（漢字モードを含む）のQRコードやECI指定の扱いは、デコーダーと経路（BarcodeDetector・Worker）に依存し、端末によって結果が異なり得る。初版ではデコーダーが返した文字列を原文とし、代表的なfixtureで経路ごとの結果を記録する（第18.1節T42）。デコーダーが置換文字U+FFFDを含めて返した場合も、そのまま原文として扱う。

分類は原文とは別の変数で行い、送信側の分類結果を受信側が信用して動作してはならない。受信側で原文を再検証する。

### 6.2 Web受信ページの動作分類

| 分類 | 条件・例 | Web受信ページの動作 |
| --- | --- | --- |
| `web` | 明示的な有効なHTTP(S)絶対URL | 最終確認後に同じタブで開く。自動遷移取消時は原文・手動で開く・コピー |
| `external` | mailto、tel、その他アプリのスキーム | 原文表示とコピー。自動起動・実行リンクなし |
| `text` | 通常文、相対URL、裸のドメイン、WIFI、vCard等 | 原文表示とコピー |
| `inert_uri` | javascript、data、file、blob等の不活性URI | 原文表示とコピー。実行リンクなし |
| `ambiguous` | 前後空白、制御文字、不正URL、埋込資格情報等 | 原文表示とコピー。自動では開かない |

`display_only`は通信上の互換値として保持するが、Web受信ページの選択肢としては提供しない。

`web`はschemeを大文字・小文字を区別せず認識し、`new URL(text)`で検証する。前後空白がある、U+0000–U+0020またはU+007Fを含む、バックスラッシュを含む、`username`または`password`が非空の場合は`ambiguous`へ下げる。UTF-8/Unicodeの原文は表示・コピー用に維持し、遷移には検証した`URL.href`を使用する。

非Webのschemeも転送を拒否しない。`external`はschemeの構文`[A-Za-z][A-Za-z0-9+.-]*:`を満たし、上記の不活性扱い・テキスト形式・曖昧な入力に該当しないものを対象とする。Web受信ページでは対応アプリの起動操作を提供せず、原文を表示する。起動したかどうかをWebページから確実に判定できないため、失敗を推測して別URLへ自動誘導しない。[S07]

判定順は、既知のテキスト形式（大文字・小文字を区別しない`WIFI:`、`BEGIN:VCARD`等）、scheme抽出、不活性scheme、HTTP(S)専用判定、その他のschemeの順とする。schemeだけをASCII小文字へ変換して比較し、原文は変更しない。`JaVaScRiPt:`も必ず不活性扱いとし、`http:foo`や`https:/foo`はHTTP(S)として不正なため`ambiguous`とする。汎用の`external`へ流さない。schemeのない通常文は、改行を含んでも`text`として扱う。

`javascript:`をナビゲーション先へ渡すとページ内でコードが動くため、文字列としてだけ扱う。`data:`等もWebページとしての起動にブラウザ制限がある。[S08] [S09]

表示には`textContent`相当を使い、`innerHTML`、Markdown描画、iframe、スクリプト評価へ渡さない。コピーは元の文字列を使用する。クリップボードAPIが使えない場合は、選択可能なテキスト領域を表示して手動コピーを案内する。

### 6.3 自動遷移の終了処理

自動遷移は第12章の受領確認手順が完了し、受信ページが前面にあり、まだ同じmessageIdが現在の対象である場合だけ行う。

同じタブで移動する前にroomの終了を通知し（`navigating`）、カメラ・WSSを終了し、機密値への参照を破棄する。HTTPダウンロード等で元のページに残った場合もセッションは終了状態のままにする。

### 6.4 CLIでの扱い

CLIは内容を分類して動作を変えない。schemeによる許可リストを設けず、URLの解析・アクセス、OSのscheme handler、シェル、クリップボードを呼び出さない。出力形式と、text形式で拒否する条件は第14.7節で定める。

## 7. 多言語仕様

### 7.1 初版と拡張候補

| 区分 | ロケール | 表示名 |
| --- | --- | --- |
| 初版必須（Web） | `ja` | 日本語 |
| 初版必須（Web） | `en` | English |
| 初版必須（Web） | `es` | Español |
| 拡張候補 | `zh-Hans` | 简体中文 |
| 拡張候補 | `zh-Hant` | 繁體中文 |
| 拡張候補 | `ko` | 한국어 |
| 拡張候補 | `fr` | Français |
| 拡張候補 | `de` | Deutsch |
| 拡張候補 | `pt-BR` | Português (Brasil) |

Webは日本語・英語・スペイン語の全状態を完成させる。不完全な辞書を言語選択欄へ公開しない。将来のアラビア語等に備え、CSSのlogical propertiesを優先し、左右方向を固定しすぎない。

### 7.2 Webの言語選択

優先順位は「利用者の手動選択 → `navigator.languages`の順 → 英語」。送信側と受信側は独立して選択する。手動言語設定だけは`localStorage`に保存してよい。本文・鍵・接続ID・capabilityは保存しない。[S10] [S11]

- `ja-* → ja`、`en-* → en`、`es-* → es`、`fr-* → fr`、`de-* → de`、`ko-* → ko`。
- 中国語は明示されたscriptを優先する。`zh-Hans-* → zh-Hans`、`zh-Hant-* → zh-Hant`。
- scriptがない場合、`zh-CN`・`zh-SG → zh-Hans`、`zh-TW`・`zh-HK`・`zh-MO → zh-Hant`。
- `zh`単独の製品上の候補は`zh-Hans`。未収録なら次の希望言語へ進む。
- `pt-BR`は`pt-BR`へ対応。`pt-PT`からブラジル版へ自動的に置換しない。必要に応じて手動選択できる。
- 未対応の候補を飛ばし、最終的に`en`へフォールバックする。

中国語の簡体字・繁体字は`zh-Hans`と`zh-Hant`で区別する。国旗を言語選択の代わりにしない。[S12]

言語切替でroom・PSK・QR・プレビュー・カメラ状態を破棄しない。`lang`属性とUI文言だけを切り替える。原文は翻訳しない。

### 7.3 CLIの表示言語

CLIの案内・ヘルプ・診断は英語に統一する。環境の言語設定で切り替えず、受信内容は翻訳・正規化しない。互換性のため従来の`--lang auto|ja|en|es`は受け付けるが表示言語は常に英語とし、`QRTOSS_LANG`は表示に影響しない。UTF-8判定のための端末ロケール検査は維持する。

### 7.4 翻訳キー例（Web）

| キー | 日本語 | 英語 | スペイン語 |
| --- | --- | --- | --- |
| `receiver.title` | この端末で受信 | Receive on this device | Recibir en este dispositivo |
| `pair.waiting` | 接続を待っています | Waiting for connection | Esperando conexión |
| `pair.verifying` | 接続を確認しています | Verifying connection | Verificando la conexión |
| `pair.connected` | 接続しました | Connected | Conectado |
| `pair.expired` | QRコードの有効期限が切れました | Pairing QR code expired | El código QR de conexión ha caducado |
| `scan.start` | QRコードを読み取る | Scan a QR code | Escanear un código QR |
| `scan.complete` | 読み取り完了。内容を確認してください | Scan complete. Review the content. | Escaneo completado. Revisa el contenido. |
| `scan.again` | 読み取り直す | Scan again | Volver a escanear |
| `scan.resume` | スキャンを再開 | Resume scanning | Reanudar el escaneo |
| `send.action` | 受信端末に送信 | Send to receiver | Enviar al receptor |
| `send.pending` | 送信しています | Sending | Enviando |
| `send.received` | 受信端末に届きました | Received by the other device | Recibido por el otro dispositivo |
| `send.unconfirmed` | 受信を確認できませんでした | Receipt could not be confirmed | No se pudo confirmar la recepción |
| `send.rejected` | 受信側の出力形式ではこの内容を扱えません | The receiver's output format cannot handle this content | El formato de salida del receptor no admite este contenido |
| `peer.mode.auto` | 受信側: Webページを自動で開く | Receiver: opens web pages automatically | Receptor: abre páginas web automáticamente |
| `peer.mode.display` | 受信側: 内容を表示 | Receiver: displays content | Receptor: muestra el contenido |
| `peer.mode.stdout` | 受信側: コマンドライン（標準出力へ書き出し） | Receiver: command line (writes to standard output) | Receptor: línea de comandos (escribe en la salida estándar) |
| `connection.closed` | 接続が切れました | Disconnected | Desconectado |
| `content.open` | 開く | Open | Abrir |
| `content.openExternal` | 対応アプリで開く | Open with an app | Abrir con una aplicación |
| `content.copy` | コピー | Copy | Copiar |
| `content.copied` | コピーしました | Copied | Copiado |

### 7.5 翻訳キー例（CLI）

| キー | 日本語 | English | Español |
| --- | --- | --- | --- |
| `waiting` | 接続用QRコードをスマホで読み取ってください。 | Scan the pairing QR code with your phone. | Escanea el código QR de conexión con tu teléfono. |
| `expires` | このQRコードの接続期限: {time} | This QR code expires at {time}. | Caducidad de este código QR: {time} |
| `connected` | スマホに接続しました。 | Phone connected. | Teléfono conectado. |
| `peer_scanned` | スマホで読み取りが完了しました。送信を待っています。 | The phone scanned a QR code. Waiting for it to be sent. | El teléfono escaneó un código QR. Esperando el envío. |
| `received` | 受信内容を標準出力に書き出しました。 | Received content written to standard output. | Contenido recibido escrito en la salida estándar. |
| `need_jsonl` | この内容にはJSON Lines形式が必要です。`--jsonl` を指定してください。 | This content requires JSON Lines. Use `--jsonl`. | Este contenido requiere JSON Lines. Usa `--jsonl`. |
| `disconnected` | 接続が切れました。 | Connection lost. | Se perdió la conexión. |
| `qr_refreshed` | 新しい接続用QRコードを表示します。以前のQRコードは使用できません。 | A new pairing QR code is shown. Previous QR codes can no longer be used. | Se muestra un nuevo código QR de conexión. Los códigos QR anteriores ya no se pueden usar. |
| `session_expired` | 接続の有効期限が切れました。 | The session has expired. | La sesión ha caducado. |
| `ack_unconfirmed` | 出力は完了しましたが、スマホでの受信を確認できませんでした。 | Output completed, but receipt on the phone could not be confirmed. | La salida se completó, pero no se pudo confirmar la recepción en el teléfono. |
| `terminal_too_short` | QRコード全体を表示するには、端末の高さが{rows}行以上必要です。 | The terminal needs at least {rows} rows to show the whole QR code. | El terminal necesita al menos {rows} filas para mostrar el código QR completo. |
| `terminal_too_narrow` | QRコードを表示するには、端末の幅が{cols}桁以上必要です。`--pairing-url` も利用できます。 | The terminal needs at least {cols} columns to show the QR code. You can also use `--pairing-url`. | El terminal necesita al menos {cols} columnas para mostrar el código QR. También puedes usar `--pairing-url`. |

### 7.6 辞書の共通規則

- Webの辞書キー集合・placeholderの一致と、CLIの英語表示をCIで検証する。
- 残り時間の複数形・数値の埋込みは、文を断片的に連結せず、翻訳ごとのテンプレートで扱う。
- 動的な本文・鍵・接続トークン・接続用URLを翻訳メッセージに埋め込まない。
- Webのエラーコードの表示文言（第13章）も3言語の辞書で定義する。本書の表には日英を示す。

## 8. セキュリティと非保存の境界

### 8.1 保護するもの

- 読み取った本文、URLのクエリ・フラグメント、QR画像、カメラ映像、PSKと派生鍵、capability、接続用URL。
- カメラ映像・画像は送信端末内で処理し、サーバーに送らない。
- 本文は送信操作まで送信端末内に留める。送信後もサーバーには暗号文だけを渡す。
- 中継サーバーに暗号鍵を渡さず、メッセージの改変・方向の偽装・別roomへの流用・リプレイを検出する。

### 8.2 前提と保証しない事項

- ブラウザ、OS、実際に配信されたHTML/JavaScript、利用者が実行したCLIの実行ファイルが正当であることを前提とする。
- 配信元がJavaScriptを改変して、暗号化前の本文・PSKを外部送信させる攻撃まで暗号学的に防げるとは説明しない。改ざんしたCLIを配布する攻撃、端末自体の侵害も同様である。ソース公開と自己ホストは配信元を管理する手段であり、その前提を消すものではない。[S13]
- 中継サーバーはIPアドレス、接続時刻、暗号文長、通信量を観測できる。通信相手の匿名化・通信量の秘匿は初版の対象外。
- QRを撮影・共有できる第三者はそのQRの参加情報を得る。QRは他人へ公開しないことを短く案内する。CLIの端末のスクロール履歴や画面録画に残ったQRも同じ情報を含むが、失効または接続成立（消費）の後は新規接続に使えない。
- PSK漏洩後の過去の暗号文に対する前方秘匿性は、初版の保証対象外。
- サーバーが暗号文を記録する能力を暗号でなくすことはできない。「復号できない」は鍵分離、「保存しない」は実装・運用で保証する。
- JSメモリ・Goのメモリの完全消去、OSのメモリダンプ、ブラウザ自身の履歴・同期、端末のスクロール履歴まで制御できるとは説明しない。参照範囲と保持期間を最小にする。
- 受信先サイトへ移動した後、そのサイトがアクセスURLを処理・記録することは本サービスの非保存保証の対象外。
- CLIの利用者がstdoutをファイルへ向けた場合、その保存は利用者の明示的な操作であり、サーバーの非保存とは区別する。
- 試用ランチャー（`curl | sh`）は配信元を信頼して実行する経路であり、同じ配信元からのチェックサム照合は配信元の侵害への耐性を与えない（第16.8節）。

### 8.3 非保存の必須条件

| 保存先・動作 | 方針 |
| --- | --- |
| DB、ファイル、オブジェクトストレージ | 本文・暗号文・鍵・capabilityを保存しない |
| オフラインキュー、再配信待ち | 作成しない |
| アプリログ、WSログ、例外収集 | 本文・暗号文・PSK・capability・接続用URLを出力しない |
| リバースプロキシのログ | 本文を収集しない。クエリや認証ヘッダーをログへ追加しない |
| カメラ画像、QR生成画像 | ブラウザ・CLIの内部だけで生成・処理する |
| サーバーメモリ | roomの接続管理と上限付き通信バッファだけを保持する |
| ブラウザ永続ストレージ | 言語設定だけを許可。本文・鍵・room等は保存しない |
| CLIの永続ファイル | 設定ファイル・履歴ファイルを作らない。ランチャーのキャッシュは検証済みバイナリだけ |
| CLIのstdout | 利用者が指定した出力先へ受信内容を書き出す。サーバー側の保存ではない |
| URLプレビュー | サーバーアクセス、OGP取得、短縮URL展開を行わない |
| 外部解析 | SDK、広告、追跡用ピクセル、外部エラー収集、利用状況の送信を含めない |

暗号文が中継時にRAMやOSの通信バッファを通ることは許容する。一時バッファに上限を設け、受信者がいない場合や受信が止まった場合に内容をためない。これは永続保存やオフライン配信とは異なる。[S14] [S15]

Web受信ページは、受信済みの最新本文と、最大`MAX_TRANSFERS_PER_ROOM`件のmessageId・本文ハッシュ・受領結果だけをメモリに保持してよい。履歴UIは作らない。鍵・capability・重複防止レコードは接続終了時に破棄する。最新本文は切断後も表示・コピーのためそのページのメモリに残してよいが、「内容を消去」、新規QR生成、ページ離脱で破棄する。残った本文から自動遷移を再開してはならない。

CLIは、出力処理に必要な間だけ本文と出力レコードを保持し、処理結果の確定後は参照を残さない。鍵・capability・重複判定記録はroomの終了時に破棄する。重複防止用ハッシュはどの構成要素からもサーバーへ送らない。

### 8.4 Origin検査の位置付け

中継サーバーのOrigin検査（第10.1節）は、別サイトのページから利用者のブラウザを使ってroom作成やWebSocket接続を行わせる攻撃を防ぐためのものである。クライアントの真正性を認証するものではない。ブラウザ以外のクライアントはOriginヘッダーを任意に設定できるため、CLIは接続先の公開originをOriginヘッダーに設定する（第10.2節）。roomへの参加権限はcapabilityで、通信相手の正当性はPSKによる相互proofで確認する。

### 8.5 診断出力の共通規則

全構成要素の診断出力（ログ、例外、stderr、クラッシュ出力、close reason）に次を含めない。中継サーバーの詳細は第15.5節、CLIの詳細は第14.14節で定める。

- 暗号鍵、PSK、capability、認証に使うメッセージ
- 完全な接続用URL。ただしCLIで利用者が`--pairing-url`を明示した出力を除く
- 受信本文とその断片、本文ハッシュ
- 復号前後のWebSocketメッセージのダンプ

## 9. 識別子・接続用URL・暗号方式

### 9.1 乱数と表現形式

ブラウザは`crypto.getRandomValues()`、サーバーはNode版がNodeの`crypto.randomBytes()`、Cloudflare版がWorkersの`crypto.getRandomValues()`、CLIはGoの`crypto/rand`を使用する。時刻、連番、`Math.random()`、`math/rand`を秘密値の生成に使わない。

| 値 | 生成元 | バイト数 | base64url文字数 | サーバーへの送信 |
| --- | --- | ---: | ---: | --- |
| `roomId` | サーバー | 16 | 22 | 可 |
| `receiverCap` | サーバー | 32 | 43 | 可。受信側認証だけに使用 |
| `senderJoinCap` | サーバー | 32 | 43 | 可。送信側の参加だけに使用 |
| `psk` | **受信側（Web受信ページまたはCLI）** | 32 | 43 | **禁止** |
| `peerId` | サーバー | 16 | 22 | 可。参加候補ごとに生成 |
| `rNonce` | 受信側 | 32 | 43 | 可。参加候補ごとに生成 |
| `sNonce` | 送信ブラウザ | 32 | 43 | 可。参加候補ごとに生成 |
| `messageId` | 送信ブラウザ | 16 | 22 | 暗号化した本文の内側にだけ含む |

base64urlはRFC 4648のURL-safe alphabet、paddingなしの**正規形（canonical encoding）**とする。文字種、デコード後の長さ、再エンコード結果の完全一致を検証する。通常のbase64、末尾`=`、空白、改行、percent-encoding等の別表現を許容しない。[S19]

Goの`encoding/base64`は復号時に改行文字を読み飛ばす。CLIは文字種の事前検査を行ったうえで`base64.RawURLEncoding.Strict()`で復号し、再符号化した文字列が入力と一致することを確認する。

`receiverCap`と`senderJoinCap`は役割ごとに別の値とし、相互に代用しない。サーバーのroomには照合用SHA-256ハッシュだけを保持してよい。照合には長さ検証後の定時間比較を使用する。

### 9.2 接続用URL

```text
https://qrtoss.example/send#v=1&r=<roomId>&j=<senderJoinCap>&k=<psk>
```

- `https://qrtoss.example`は配備先の`PUBLIC_ORIGIN`へ置換する。CLIは`--server`から正規化した公開origin（第14.5節）を使う。
- ブラウザ版をサブパスへ配備する場合は、送信ページにもビルド時のベースパスを付ける。`QRTOSS_BASE_PATH=/qrtoss/` なら `https://qrtoss.example/qrtoss/send#v=1&r=…&j=…&k=…` となる。`PUBLIC_ORIGIN`とOriginヘッダーにはパスを含めない。CLIはこのサブパス配備には対応しない。
- `receiverCap`はURL・QRへ含めない。
- `psk`をパス、クエリ、HTTPヘッダー、WSSメッセージへ含めない。
- 接続用QRは受信側の内部（ブラウザまたはCLI）で生成し、画像生成APIや外部コマンドへ渡さない。
- 送信ページはフラグメントを読み取り、検証に必要な値をメモリへコピーした直後に`history.replaceState`で除去する。置換先は配備先の送信パス（既定値 `/send`、上記例では `/qrtoss/send`）とし、エラー時にも除去する。
- 文字列全体をconsole、エラー例外、画面解析へ渡さない。
- 同じキーの重複、未知のキー、欠落、`v`が`1`以外、長さ・文字種の不一致を拒否する。上記順序で生成し、受信時は順序を問わない。
- 接続用URLの全長は2,048文字以下とする。fragmentの除去は、OSカメラやブラウザがすでに扱ったURLの履歴まで消す保証ではない。

URI fragmentは通常のHTTPリクエストの対象に含まれない。この性質を鍵の受渡しに利用するが、ページのJavaScriptからは読めるため、配信コードの信頼という第8章の前提は残る。[S16]

#### 9.2.1 接続用QRの符号化

接続用URLの長さは`len(PUBLIC_ORIGIN) + 126`文字である。QRはバイトモード、誤り訂正レベルM、四辺に4モジュール以上の余白で符号化し、版は内容が収まる最小のものを自動選択する。Web受信ページとCLIで同じ条件を使い、描画サイズを理由に鍵やトークンを短縮しない。[S25] [S36]

| `PUBLIC_ORIGIN`の長さ | URL長 | QRの版（M） | 余白込みのモジュール数 | CLI compact表示 | CLI full表示 |
| --- | --- | ---: | ---: | --- | --- |
| 26文字以下（例：`https://qrtoss.example`は22文字） | 152以下 | 8 | 57 | 57桁×29行 | 114桁×57行 |
| 27〜54文字 | 153〜180 | 9 | 61 | 61桁×31行 | 122桁×61行 |
| 55〜87文字 | 181〜213 | 10 | 65 | 65桁×33行 | 130桁×65行 |

ターミナルでの表示と読み取りやすさのため、`PUBLIC_ORIGIN`は54文字以下（既定ポートでホスト名46文字以下）を推奨する。

### 9.3 鍵導出と相互proof

以下で`UTF8()`はUTF-8への符号化、`||`はバイト列の連結を表す。`\n`は実際のLF（`0x0a`）であり、末尾にもLFを含める。JSONのキー順序や空白を署名対象の正規化に使用しない。

```text
T = UTF8("qrtoss/1\n" + roomId + "\n" + peerId + "\n"
         + rNonce_base64url + "\n" + sNonce_base64url + "\n")

salt   = SHA-256(T)
Kproof = HKDF-SHA256(psk, salt, UTF8("qrtoss/1/proof"), 32 bytes)
Ks2r   = HKDF-SHA256(psk, salt, UTF8("qrtoss/1/s2r"),   32 bytes)
Kr2s   = HKDF-SHA256(psk, salt, UTF8("qrtoss/1/r2s"),   32 bytes)

senderProof   = HMAC-SHA256(Kproof, UTF8("sender\n")   || T)
receiverProof = HMAC-SHA256(Kproof, UTF8("receiver\n") || T)
```

proofは32バイト全体をbase64urlで送る。ブラウザはWeb CryptoのHKDF、HMAC、AES-GCMを使い、独自の暗号アルゴリズムを実装しない。HMAC検証は`subtle.verify()`で行う。[S17] [S18]

ブラウザではPSKをHKDF用の`CryptoKey`として取り込み、派生するHMAC鍵・AES鍵は`extractable: false`とする。Kproofは相互確認終了後に参照を破棄する。PSKとQRの秘密値は接続確立後に参照を破棄し、通信には方向別の派生鍵を使用する。送信端末は正しいreceiverProofを検証するまで本文を送らない。

CLIは同じ計算をGo標準ライブラリで行う。HKDFは`hkdf.Key(sha256.New, psk, salt, info, 32)`（`info`は文字列）、HMACは`hmac.New(sha256.New, Kproof)`、proofの照合は`hmac.Equal`、AES-GCMは`aes.NewCipher`と`cipher.NewGCM`（12バイトnonce、16バイトタグ）を使う。`Seal`の出力は暗号文とタグの連結であり、Web Cryptoの出力と同じ並びである。派生鍵をログ・診断へ出さず、roomの終了時に参照を破棄する。[S32]

### 9.4 暗号文envelope

```json
{
  "v": 1,
  "type": "cipher",
  "room": "<roomId>",
  "peer": "<peerId>",
  "dir": "s2r",
  "seq": "0",
  "ct": "<ciphertext_and_tag_base64url>"
}
```

`dir`は`s2r`または`r2s`。暗号化は方向に対応するAES-256-GCM鍵を使い、認証タグ長は128 bitとする。

```text
IV  = 0x00000000 || uint64_big_endian(seq)

AAD = UTF8("qrtoss/1/cipher\n" + roomId + "\n" + peerId + "\n"
           + dir + "\n" + seq_decimal + "\n")
```

IVは12バイト。AES-GCMは同じ鍵でIVを再利用してはならない。本仕様では候補ごとの鍵導出、方向別鍵、単調増加するseqによって重複を避ける。[S17]

- `seq`は正規十進文字列`0`または`[1-9][0-9]*`。ブラウザは`BigInt`、CLIは`uint64`で扱い、範囲は`0`から`2^64-1`。JavaScriptのNumberへ変換しない。
- `00`、`+1`、負数、小数、指数表記を拒否する。
- 各方向で0から開始し、次の送信ごとに1増やす。上限を越える前にroomを終了する。
- `ct`は暗号文と末尾16バイトのGCMタグを連結したもの。base64url最大30,059文字、デコード後16バイト以上22,544バイト以下とする。
- 外側の未知のフィールドを拒否する。room・peer・方向が認証済みソケットと期待する接続に一致することを、サーバーと受信側の両方で確認する。
- 暗号化・送信は一つの直列キューで行う。複数の非同期暗号処理の完了順でseqと送信順を入れ替えない。
- 受信も一つの直列キューで復号・schema検証・状態更新を行う。
- 受信seqは`lastSeq = -1`相当から開始し、`seq === lastSeq + 1`だけを受理する。欠番、重複、巻戻しはプロトコルエラー。
- `lastSeq`を更新するのは、GCM検証と内部メッセージのschema検証に成功した後とする。
- 暗号化失敗、seq確保後の送信失敗、復号失敗はroomを終了する。同じ鍵・seqで再開しない。
- 論理的な再送でも毎回新しいseqで再暗号化する。暗号文envelopeそのものを再送してはならない。

### 9.5 本文の符号化と上限の整合

暗号化前の`data`は、第12章のとおり本文を`textB64`に格納する。これにより、制御文字のJSONエスケープで本文が最大6倍に膨張する問題を避ける。base64url自体には秘匿性はなく、JSON全体をAES-GCMで暗号化する。

1. 単独サロゲートを含まない文字列であることを確認する。
2. `TextEncoder`でUTF-8化し、1〜16,384バイトであることを確認する。
3. 正規base64urlへ変換し、`textB64`へ格納する。最大21,846文字。
4. JSON全体をUTF-8化し、22,528バイト以下であることを確認して暗号化する。
5. 受信側は復号後にもschema、正規base64url、復号後バイト数を検証する。
6. ブラウザは`TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`で文字列に戻す。CLIは`utf8.Valid`で検証する（Goのこの検査は、UTF-8で符号化されたサロゲート符号位置も不正とする）。不正UTF-8は拒否し、先頭U+FEFFも元の文字として保持する。
7. 受信側でも空文字・長さ・不正Unicodeの検査を行い、その後に内容を扱う。

`TextEncoder`に渡す前の単独サロゲート検出を省略しない。UTF-8化後には置換済みで判別できなくなる。重複判定用ハッシュは、JSONやbase64url文字列ではなく、**元のUTF-8バイト列のSHA-256**とする。[S20]

## 10. HTTP APIとWebSocket制御プロトコル

### 10.1 HTTPルート

以下はNodeサーバーが受け付けるパスである。Cloudflare版のWorkerも同じパスを同じ契約で受け付ける（第15.6節）。ブラウザ版のサブパス配備では、公開側でベースパスを前置し、プロキシがそれを除去する。例えば公開側の `POST /qrtoss/api/v1/rooms` は内部の `POST /api/v1/rooms` へ、公開側の `/qrtoss/ws` は内部の `/ws` へ転送する。Originの完全一致検査はサブパス配備でも変更しない。

| メソッド・パス | 用途 | 正常時 |
| --- | --- | --- |
| `GET /` | 受信画面 | HTML、200 |
| `GET /send` | 送信画面 | HTML、200 |
| `GET /assets/<content-hash>.*` | 同梱JS・CSS・Worker等 | 200 |
| `POST /api/v1/rooms` | room作成 | JSON、201 |
| `GET /healthz` | プロセス生存確認 | `{"status":"ok"}`、200 |
| `GET /readyz` | 新規接続の受付可否 | `{"status":"ready"}`、200。終了処理中は503 |
| `GET /ws` | WebSocket upgrade | 101、subprotocol `qrtoss.v1` |

初版はcookie、Authorizationヘッダーによる常設ログイン、CORS APIを使用しない。roomを作るPOSTとWebSocket upgradeの`Origin`は、設定された公開originと完全一致するものだけを受け付ける。`null`、欠落、ワイルドカードは許可しない。この検査はクライアントの種類にかかわらず適用する（第10.2節）。CLIの配布物（第16.8節）は中継サーバーのルートに含めない。

`POST /api/v1/rooms`のリクエストは`Content-Type: application/json`、本文は次の形だけを許可する。HTTP本文の上限は2,048バイトとする。

```json
{"v":1}
```

レスポンス例：

```json
{
  "v": 1,
  "room": "<roomId>",
  "receiverCap": "<receiverCap>",
  "senderJoinCap": "<senderJoinCap>",
  "serverTime": 1800000000000,
  "pairingExpiresAt": 1800000060000
}
```

時刻は整数のUnix epochミリ秒。例の値は形式説明用である。受信側はroom作成後にPSKを生成し、受信側のWSS認証が成功してからQRを表示する。作成APIにPSKを渡さない。

HTML・APIレスポンスは`Cache-Control: no-store`。ハッシュ付き静的assetだけは長期キャッシュを許可する。API失敗は`{"v":1,"error":{"code":"CAPACITY"}}`のような固定コードで返し、stack traceやリクエストのエコーを含めない。HTTPの主な分類は400（入力・version）、403（Origin）、404（存在しないパス）、405（method）、413（サイズ）、429（頻度。固定秒数の`Retry-After`を付ける）、503（容量・停止中）とする。

### 10.2 ブラウザ以外のクライアント

CLI等のブラウザ以外のクライアントも、ブラウザと同じAPI・WSS・プロトコルを使い、次を守る。

- `POST /api/v1/rooms`とWebSocket upgradeに、接続先の公開originのASCII直列化（例：`https://qrtoss.example`）を`Origin`ヘッダーとして付ける。サーバーは送信元の種類を区別せず、第10.1節の完全一致検査を適用する。
- `POST /api/v1/rooms`は`Content-Type: application/json`、本文`{"v":1}`で送る。
- CLIはroom作成とWebSocket upgradeの両方に`User-Agent: qrtoss/<CLIの版>`を付ける。個人・端末の識別子や秘密値は含めず、サーバーの認証・権限判断にも用いない。`workers.dev`での利用条件は第16.10.3節に従う。
- HTTPのリダイレクトに従わない。3xxは接続先の設定誤りとして扱う。
- WebSocketのsubprotocol `qrtoss.v1`を要求し、サーバーが選択しなかった場合はその接続を使わない。
- WebSocket圧縮（permessage-deflate）を要求しない。受信メッセージの上限を`MAX_WS_MESSAGE_BYTES`に設定し、再構成後のメッセージで検証する。
- アプリ用heartbeat（`hb.ping`）を送る。WebSocketのping/pongフレームはその代わりにならない。
- 応答とメッセージは本書のschemaで厳密に検証する。

### 10.3 WSS共通規則

- URLは同じoriginの`/ws`を`wss:`にしたもの。ブラウザ版のサブパス配備ではベースパスを前置する（例：`wss://qrtoss.example/qrtoss/ws`）。トークンをクエリやsubprotocolへ入れない。
- `Sec-WebSocket-Protocol`は`qrtoss.v1`の1件だけを受け付ける。前後のHTTPの空白（SP・HTAB）は許可する。未指定・空・異なる値・他のprotocolとの併記・重複指定（複数のヘッダー行を含む）は、Node版・Cloudflare版とも400（`VERSION_UNSUPPORTED`）で拒否し、upgradeしない。
- JSONのテキストメッセージだけを扱う。バイナリメッセージを拒否する。
- `ws`の`perMessageDeflate`を無効化する。
- WebSocket接続後5秒以内の最初のアプリメッセージは`auth`。認証前はauth以外のアプリメッセージを認めない。アプリ用heartbeatも認証後に開始する。
- 全メッセージに`v: 1`と`type`を含める。指定されていないフィールド、型の自動変換、未知のtypeを受け付けない。
- 制御メッセージ内の時刻は0〜9,007,199,254,740,991（JavaScriptの安全な整数上限）の整数値で表すUnix epochミリ秒。JSON数値は、小数・指数表記も解釈した値がフィールドの範囲内の整数であれば受理する。数値文字列は受理しない。
- 制御メッセージは2,048バイト以下、`cipher`を含むメッセージ全体は32,768バイト以下。frame分割で上限を回避できないよう、再構成されたメッセージで検証する。
- 一度認証したソケットのroom・roleを変更しない。2回目のauthを拒否する。
- 制御通知は暗号化されないため、秘密本文、本文ハッシュ、PSKを含めない。

認証例：

```json
{"v":1,"type":"auth","role":"receiver","room":"<roomId>","cap":"<receiverCap>"}
```

```json
{"v":1,"type":"auth","role":"sender","room":"<roomId>","cap":"<senderJoinCap>"}
```

receiver認証成功：

```json
{"v":1,"type":"auth.ok","role":"receiver","room":"<roomId>","serverTime":1800000000000,"pairingExpiresAt":1800000060000}
```

senderはこの時点では候補である。認証成功には`peer`と`candidateExpiresAt`も含める。

```json
{"v":1,"type":"auth.ok","role":"sender","room":"<roomId>","peer":"<peerId>","serverTime":1800000001000,"pairingExpiresAt":1800000060000,"candidateExpiresAt":1800000011000}
```

### 10.4 クライアントからサーバーへの制御メッセージ

各行の追加フィールドに加え、共通の`v`・`type`を必須とする。`peer`は認証済みroom内の対象候補を指す。

| type | 送信権限 | 追加フィールド | 処理 |
| --- | --- | --- | --- |
| `hb.ping` | 認証済み両端 | `id: integer` | 同じidで`hb.pong`を返す。idle延長なし |
| `pair.challenge` | receiver、候補待機中 | `peer`, `rNonce` | 該当candidateへ中継 |
| `pair.proof` | 対象sender候補 | `peer`, `sNonce`, `proof` | receiverへ中継 |
| `pair.commit` | receiver | `peer` | 期限・候補・状態を確認して一度だけ確定 |
| `pair.confirm` | receiver、commit後 | `peer`, `proof` | 選択済みsenderへreceiverProofを中継 |
| `pair.reject` | receiver、commit前 | `peer`, `code: "AUTH_FAILED"` | 候補だけを閉じる。QRは未消費 |
| `pair.active` | receiver、ready検証後 | `peer` | commit済みroomをACTIVEにする |
| `room.touch` | receiver、ACTIVE | `peer` | idle期限を延長。期限後は拒否 |
| `room.close` | 認証済み両端 | `reason` | 要求元の接続を終了する。receiverとcommit後のsenderではroom全体を、commit前のcandidateでは候補だけを終了する（第10.5節・第11.1節） |
| `cipher` | commit済み両端 | 第9.4節のフィールド | 相手がオンラインなら即時中継 |

`hb.ping.id`は0〜2,147,483,647の整数。接続ごとに0から単調増加させる。`reason`は`user_reset`、`user_end`、`navigating`、`client_error`、`idle_timeout`、`transfer_limit`のいずれか。reasonは表示の補助であり、権限判断に使用しない。

### 10.5 サーバーからクライアントへの制御メッセージ

| type | 宛先 | 追加フィールド | 用途 |
| --- | --- | --- | --- |
| `auth.ok` | 認証した端末 | 第10.3節 | 役割の認証完了。E2EE接続完了ではない |
| `hb.pong` | ping送信元 | `id`, `serverTime` | 応答確認 |
| `pair.candidate` | receiver | `peer`, `serverTime`, `candidateExpiresAt` | 新しい候補 |
| `pair.challenge` | 対象sender | `peer`, `rNonce` | 相互proof用のchallenge |
| `pair.proof` | receiver | `peer`, `sNonce`, `proof` | senderProof |
| `pair.committed` | 両端 | `peer`, `serverTime`, `readyExpiresAt`, `idleExpiresAt` | 一回限りのcommit成功 |
| `pair.confirm` | sender | `peer`, `proof` | receiverProof |
| `pair.active` | 両端 | `peer`, `serverTime`, `idleExpiresAt` | サーバー側のACTIVE移行完了 |
| `pair.candidate_closed` | receiver | `peer`, `code` | 候補の失効・拒否・切断 |
| `room.touched` | 両端 | `peer`, `serverTime`, `idleExpiresAt` | idle期限の更新 |
| `room.closed` | 接続中の端末 | `code` | 期限・離脱等でroom終了 |
| `error` | エラー対象端末 | `code`, `scope` | 入力・認証・容量等の固定コード |
| `cipher` | 対向端末 | 第9.4節のフィールド | 内容を解釈せず中継 |

`scope`は`socket`、`candidate`、`room`のいずれか。エラーコードは第13章に限定する。認証前の未知room、不正capability、使用済みQRは一律`PAIR_UNAVAILABLE`とし、部外者に細かい存在情報を返さない。認証済みreceiverには自身の期限切れ等を具体的に通知してよい。

`pair.challenge`、`pair.proof`、`pair.confirm`は1候補につき各1回だけ許可する。中継先はサーバーが認証済みコンテキストから決め、クライアントが任意のroomへ宛先を変更できないようにする。

receiverまたはcommit後のsenderから`room.close`を受けたサーバーは、そのroomを閉じ、相手のソケットへ`room.closed`を送ってから終了する。要求元のソケットはclose code 1000で閉じる。待機中のcommit前のcandidateには、reasonにかかわらず`PAIR_UNAVAILABLE`を送る。commit前のcandidateからの`room.close`ではroomを閉じず、その候補だけを閉じてreceiverへ`pair.candidate_closed`を送る。commit後の相手へ通知する`code`は次のとおりとする。

| reason | 主な送信元 | commit後の相手へ通知するcode |
| --- | --- | --- |
| `user_reset` | 受信側（新しいQRの表示） | `PEER_CLOSED` |
| `user_end` | 両端（利用者の終了、CLIの受信完了・中断） | `PEER_CLOSED` |
| `navigating` | Web受信ページ（同じタブへの遷移） | `PEER_CLOSED` |
| `client_error` | 両端（復号失敗・プロトコル違反の検出） | `PROTOCOL_ERROR` |
| `idle_timeout` | 受信側 | `SESSION_EXPIRED` |
| `transfer_limit` | 受信側（第12.5節） | `TRANSFER_LIMIT` |

### 10.6 heartbeat・終了・時計

全クライアント（Web受信ページ、送信ページ、CLI）は認証後15秒ごとに`hb.ping`を送る。45秒間、対応する`hb.pong`を確認できなければ切断扱いとする。サーバーも45秒間、認証済みソケットから`hb.ping`を受けなければ終了する。OSによるバックグラウンド停止で切れた場合も、接続し直すには新しいQRを使う。CLIの自動再ペアリングは本文受付前だけとし、書き込み中・結果確定後は第14.9.4節・第14.12節に従って終了する。

サーバー内部の期限は単調時計で管理する。公開する`serverTime`と各`expiresAt`は、応答時点のUnix時刻と残り期間から算出する。クライアントはサーバーが通知した残り期間を基に単調時計で減算し、端末の壁時計がずれても期限を延ばさない。復帰時はheartbeatと最新期限で確認する。

正常終了のWS close codeは1000、認証・schema等は1008、過大メッセージは1009、サーバー内部障害は1011、一時過負荷は1013を使用する。close reasonに本文・鍵・capabilityを含めない。`room.closed`等は可能な場合に先に送るが、届くことを終了条件にしない。

## 11. ペアリングとroomの状態遷移

### 11.1 サーバーの状態

| 状態 | 内容 | 次の正常状態 |
| --- | --- | --- |
| `CREATED` | room作成済み。receiverのWSS認証待ち | `WAITING` |
| `WAITING` | receiver接続済み。QR参加受付中 | `CANDIDATE` |
| `CANDIDATE` | sender候補1台のproof確認中 | `WAITING`または`COMMITTED` |
| `COMMITTED` | QRを消費し、暗号化ready交換中 | `ACTIVE` |
| `ACTIVE` | 端末間暗号化の初期化を完了した通信中 | `CLOSED` |
| `CLOSED` | 受付・中継終了。roomをMapから削除 | なし |

`CREATED`、`WAITING`、`CANDIDATE`にはQR期限を適用する。`COMMITTED`にはready期限、`ACTIVE`にはidle期限を適用する。receiver離脱、サーバー終了、重大なプロトコル違反では該当roomを閉じる。

receiverはroomにつき1ソケット。2つ目のreceiver認証は既存接続を置換せず拒否する。同時candidateも1台とする。正しいjoin capabilityを持つ追加candidateには`PEER_BUSY`を返し、既存candidateの接続を維持する。

commit前のcandidate離脱・失効・proof不一致では、そのcandidateだけを閉じる。QR期限が残っていれば`WAITING`へ戻る。commit後のsender離脱・失敗ではroom全体を閉じ、使用済みQRを復活させない。

### 11.2 正常な接続手順

受信側（receiver）はWeb受信ページまたはCLIである。手順は共通とする。

1. receiverが作成APIでroomを得てPSKを生成し、receiverCapでWSSを認証する。
2. receiverが`auth.ok`を確認して接続用QRを表示する（Web受信ページは画面、CLIはstderrの文字QR）。
3. senderがQRを読み、fragmentを除去し、senderJoinCapでWSSを認証する。
4. サーバーがpeerIdと候補期限を生成し、senderへ`auth.ok`、receiverへ`pair.candidate`を送る。**この時点ではQRを消費しない。**
5. receiverが候補固有のrNonceを生成し、`pair.challenge`を送る。
6. senderがsNonce、Kproof、方向別鍵を生成し、senderProofを`pair.proof`で返す。
7. receiverが鍵を導出してsenderProofを検証する。失敗なら`pair.reject`し、候補の鍵を破棄する。
8. receiverは非同期検証終了後にも現在のpeer、QR期限、候補期限、終了フラグを再確認し、`pair.commit`を送る。
9. サーバーがatomicにcommitし、join capabilityを無効化する。両端へ`pair.committed`を返す。
10. receiverがcommit成功を確認し、receiverProofを`pair.confirm`で送る。
11. senderがreceiverProofを検証し、暗号化`ready`をs2rのseq 0で送る。
12. receiverが`ready`を復号・検証し、暗号化`ready_ack`をr2sのseq 0で送る。
13. receiverが`ready_ack`の暗号化を完了し、envelopeを実際に送信関数（ブラウザは`ws.send()`）へ渡した後、`pair.active`を送る。暗号化前のキューへ投入しただけで先へ進まない。
14. サーバーがready期限内であることを確認してACTIVEにし、両端へ`pair.active`を返す。両ソケットへの通知のenqueueを一つの同期処理内で完了し、その後に通常のcipherを中継可能にする。
15. receiverはready検証とサーバーのACTIVE通知の両方を確認して「接続済み」にする。senderはready_ack検証とACTIVE通知の両方を確認して「接続済み」にする。
16. receiverが現在の受信モードを暗号化`mode`で送る（Web受信ページは`auto_open`固定、CLIは`stdout`）。送信側は接続済みになった後に読み取りを開始できる。

サーバーからの`auth.ok`や`pair.active`だけでE2EE接続済みと判定してはならない。鍵を持つ相手のproofと暗号化ready交換を確認する。

### 11.3 atomicなcommit条件

サーバーは以下を一つの同期処理で確認し、条件がすべて成立した場合だけ状態を変更する。確認と変更の間に`await`を挟まない。

- 操作元が、そのroomの認証済みreceiverである。
- 現在の状態が`CANDIDATE`で、まだcommitされていない。
- サーバーの現在時刻がQR期限未満である。
- 指定peerが現在のcandidateと一致し、接続中である。
- 現在時刻が候補期限未満である。

成功した瞬間に`senderJoinCap`の照合情報を破棄し、`readyExpiresAt = commit時点 + 10秒`とする。commitがQR失効直前に成功した場合、ready交換はcommitからの10秒以内に完了すればよい。初回QR期限を再適用しない。

ready期限の判定はサーバーが行う。クライアントは`readyExpiresAt`へのローカル到達だけで切断したり、`pair.confirm`・`ready_ack`・`pair.active`の送信を打ち切ったり、受信した`ready`をプロトコル違反にしたりしない。期限内に成立したACTIVEの通知が遅れる場合も、通知を受けて接続を完了する。失効は`room.closed`（`READY_TIMEOUT`）で確定し、サーバーが応答しない場合は第10.6節のheartbeatで通信断を検出する。

commit後の暗号化ready交換中は、サーバーは各方向のseq 0を1通ずつだけ中継する。通常のアプリメッセージは両端がACTIVEを確認した後に送る。異なるソケット間の通知順序に依存せず、各条件がそろうまで待つ。

候補ごとにタイマー・鍵・非同期処理の世代番号を持ち、旧候補の遅延したproofを新候補へ適用しない。候補待機枠を占有する可用性への妨害を完全に防ぐとは説明しないが、短い期限と第15章の上限で影響を抑える。

### 11.4 全非同期処理の世代確認

ハンドシェイクだけでなく、接続後の復号、本文ハッシュ、暗号化、カメラ起動、CLIの出力処理も開始時の`sessionGeneration`を保持する。各`await`（Goでは各チャネル受信・非同期結果の受領）の後と、画面更新・送信・遷移・stdoutへの書き込み開始の直前に、room・peer・世代番号・終了フラグが現在のセッションと一致することを確認する。旧世代の結果は副作用を起こさず破棄する。

QR再生成、切断、pagehide、致命的エラーでは先に世代番号を進める。遅れて完了したカメラ起動は得られたトラックを止める。遅れて完了した復号・ack_seen処理は、旧本文の表示や自動遷移に使わない。CLIで進行中のstdout書き込みの扱いは第14.9.4節に従う。

暗号化送信関数（ブラウザの`sendEncrypted()`）は、直列化・暗号化・最終世代確認を終え、OPEN状態のソケットへenvelopeを渡し終えた時点で完了とする。これは相手の受領を意味せず、受領の確認には第12章のackを用いる。

## 12. 暗号化アプリメッセージと受領確認

### 12.1 内部メッセージschema

次のJSONをUTF-8にして暗号化し、第9.4節の`ct`へ格納する。内部に`v`を重ねず、envelopeのversionを使用する。表にないキー・type・値を拒否する。

| type | 方向 | JSONの形・追加フィールド | 目的 |
| --- | --- | --- | --- |
| `ready` | s2r | `{"type":"ready"}` | senderの鍵確認。s2r seq 0のみ |
| `ready_ack` | r2s | `{"type":"ready_ack"}` | receiverの鍵確認。r2s seq 0のみ |
| `mode` | r2s | `value: "auto_open" / "display_only" / "stdout"` | 送信側へ受信側の動作を案内。`stdout`はCLI |
| `activity` | s2r | `{"type":"activity"}` | 実際の操作があったことだけを通知 |
| `status` | s2r | `state: "scanning" / "scanned" / "ready"` | 読み取り状態。本文・長さ・ハッシュを含めない |
| `data` | s2r | `id: messageId`, `textB64: string` | 利用者が送信した本文 |
| `ack` | r2s | `id: messageId`, `status: "received" / "rejected"`。`rejected`のときだけ`reason: "unsupported_content"`を必須とする | 受理処理の結果 |
| `ack_seen` | s2r | `id: messageId` | senderがackを検証した確認 |

例：

```json
{"type":"data","id":"<messageId>","textB64":"<original_utf8_base64url>"}
```

```json
{"type":"ack","id":"<messageId>","status":"received"}
```

```json
{"type":"ack","id":"<messageId>","status":"rejected","reason":"unsupported_content"}
```

```json
{"type":"ack_seen","id":"<messageId>"}
```

`activity`は利用者操作時だけ送り、`TOUCH_COALESCE_SECONDS`に1回まで集約する。`status`、`data`等を送った場合は重複するactivityを省く。受信した通知への自動応答からactivityを発生させ、無限にidleを延長する実装は禁止する。

`data`にはURL分類や遷移先、受信モード、実行命令を含めない。受信側が原文と自身の設定から扱い方を決める。新しい`mode`の値や`reason`の値を加える変更は互換性の変更であり、プロトコルversionとテストベクトルを更新する。

### 12.2 読み取りから送信まで

- 接続済みsenderで読み取りを開始したら`status/scanning`を送る。
- 読み取り成功時はカメラを止め、プレビューを表示し、`status/scanned`だけを送る。
- 読み取り失敗・プレビュー中には本文、ドメイン、本文長、本文ハッシュを送らない。
- 利用者の「受信端末に送信」でmessageIdを生成し、本文検証後に`data`を送る。
- 一度に未確定の送信は1件。送信・再スキャンの二重操作を止める。
- 送信前に切断した場合は本文を送らず、プレビューと再接続案内を残す。

### 12.3 受理処理と受領確認

受領確認は「受信側が内容を受け取り、受理処理を完了した」ことを表し、リンク先の表示成功や下流の処理完了を意味しない。受理処理は受信側の種類ごとに次のとおりとする。

| 受信側 | 受理処理の完了条件 | 含まないもの |
| --- | --- | --- |
| Web受信ページ | 復号・schema・UTF-8・サイズ・重複の検証、最新本文・本文ハッシュ・受領レコードのメモリ保持、今回の動作の確定 | 表示・遷移・外部アプリ起動の成功 |
| CLI | 復号・検証、選択された出力形式への変換、stdoutへのレコード全体の書き込みとflush、出力済み記録の更新（第14.11節） | パイプ先の処理完了、ファイルの物理的な永続化、利用者の閲覧 |

1. receiverが`data`を復号し、schema・UTF-8・サイズ・重複を検証する。
2. 新規messageIdなら、本文SHA-256と受領レコードをメモリに保持する。
3. Web受信ページは、固定の`auto_open`・内容分類・画面表示状態を記録して今回の動作を確定する。CLIは出力形式へ変換し、stdoutへ書き出す。
4. 受理処理を完了したら暗号化`ack`（`status: "received"`）を送る。CLIが選択された出力形式で表現できない内容は、stdoutへ1バイトも書かずに`ack`（`status: "rejected"`、`reason: "unsupported_content"`）を送る。Web受信ページは`rejected`を送らない。
5. senderは、未確定の送信に対応する最初の正当な`ack`を復号・検証し、`received`なら「受信端末に届きました」、`rejected`なら`CONTENT_UNSUPPORTED`を表示する。そのmessageIdについて暗号化`ack_seen`を1回だけ送る。
6. receiverは、対応する`ack_seen`をWeb受信ページでは`ACK_SEEN_TIMEOUT_SECONDS`以内、CLIでは第14.12節の2秒の終了猶予以内に検証する。
7. Web受信ページは、今回が`auto_open`かつ`web`で、受信時から前面表示を維持し、自動遷移が取り消されていなければ、同じタブで開く。それ以外は表示に留める。CLIは`ack_seen`の検証で終了処理へ進む（第14.12節）。

Web受信ページは本文を受けた時点で内容とコピー操作を表示してよい。「開く」操作は受領処理の完了または確認タイムアウト後に有効化する。待機中にページが一度でも非表示になった場合、そのmessageIdの自動遷移資格を取り消し、後で前面へ戻っても手動操作にする。

受信側が遷移・終了して接続が閉じても、senderの確定済みの結果をエラーで上書きしない。接続状態と送信結果は別の情報として表示する。

`WebSocket.send()`が正常終了したことや`bufferedAmount === 0`は、相手のアプリが受信した確認ではない。一定ミリ秒待つだけの実装でこの手順を代替しない。[S14]

### 12.4 タイムアウトと再送

| 場所 | 期限 | タイムアウト後 |
| --- | --- | --- |
| sender、data送信後 | 10秒 | 「受信を確認できませんでした」。未配信と断定しない |
| Web受信ページ、最初のack送信後 | 5秒 | 内容表示と手動で開く操作へ移行。自動遷移を取り消す |
| CLI、出力成功または拒否の確定後 | 2秒（ack送信・ack_seen待ち・終了処理を含む） | 出力成功時は`ACK_UNCONFIRMED`を表示してコード0、拒否時はコード6で終了。出力はやり直さない |

senderとWeb受信ページの期限は、最初に該当メッセージをWSS送信キューへ入れた時点から測る。CLIの終了期限は、出力成功または拒否の確定直後から測る（第14.12節）。期限と同時刻はタイムアウトとして扱う。タイマーの実行が遅れても、後着メッセージを処理する直前に期限を再確認する。

- 接続が残っている場合に限り、senderへ「送達を再確認」を表示し、利用者が押したときだけ同じmessageId・同じ本文を新しいseqで再送できる。
- 自動再送、オフラインキュー、再接続先への持越し送信は行わない。
- 未確定の送信を解消せずに別の本文を送らない。終了する場合はroomを閉じる。
- 遅れて正当なackが届いた場合は、そのmessageIdの結果を確定してよい。別の送信の成功として扱わない。
- senderは、同じmessageIdへの2通目以降のackを無視し、ack_seenを再送しない。
- receiverは、処理中に届いた同じmessageIdの再送には、処理の確定後に結果のackを返す。複数の再送を1通のackにまとめてよい。
- Web受信ページで5秒の期限が切れたら、後からack_seenや重複dataが届いても自動遷移を復活させない。
- 切断時にack_seen待ちなら、Web受信ページは受信済み本文を表示に留める。旧roomの終了後は古い確認通知を処理しない。

CLIはstdoutへの書き込みが終わるまでackを送れないため、出力先が遅い場合は送信側の10秒の期限が先に切れることがある。この場合も、遅れて届いた正当なackで受領を確定する。

### 12.5 重複・件数上限

受領レコードは、`messageId`、本文SHA-256、結果（`received`・`rejected`）、最終確認状態（待機・完了・期限切れ）を含む。Web受信ページはさらに自動遷移取消と遷移実行済みを、CLIは出力状態（`writing`・`written`・`rejected`）を含む。

- 新しいseqで既存messageIdと同じ本文が届いたら、重複として記録済みの結果のackだけを返す。内容を再表示・再出力・再遷移せず、最初のack_seen期限を延ばさない。処理中なら確定後に返す。
- 同じmessageIdで異なる本文が届いたらプロトコルエラーとして終了する。
- 古いseqのenvelopeは、messageIdに関係なくリプレイとして拒否する。
- アプリ上の重複を無視する場合でも、正しく復号・検証した新しいseqは消費する。
- 過去の既知messageIdへのack・ack_seenは、現在の本文を変更しない。未知のmessageIdへの確認はプロトコルエラーとする。
- receiverがまだ1件の受理処理中、または最終確認（ack_seen）の期限内の待機中に、異なる新規messageIdのdataが届いた場合はプロトコルエラーとする。CLIは最初の1件を受け付けた後、終了まで別の新規messageIdを受け付けない。出力成功後の違反による終了コードの扱いは第14.12節に従う。

件数はreceiverが受理または拒否を確定した一意のmessageIdを数える。サーバーはcipherの内部typeを読めないため件数判定を行わない。ready・status・ack・再送は加算しない。

Web受信ページは`MAX_TRANSFERS_PER_ROOM`件目の処理を最後まで完了させ、その最終確認の完了または期限切れの後に、`room.close`（`transfer_limit`）でroomを終了する。ただしその内容で自動遷移する場合は、遷移の終了処理を優先する。Web受信ページは新しいQRを案内し、最新本文の表示とコピーは利用できる。sender側は`TRANSFER_LIMIT`の通知で新しいQRを案内する。senderも結果を確定した一意のmessageIdを数え、上限に達したら新規送信を無効化する。CLIは1件の出力または恒久拒否の後に第14.12節に従って終了するため、この件数上限に達するまで受信を続けることはない。

### 12.6 遷移を行う共通処理（Web受信ページ）

自動または手動の「開く」は、現在の内容を再検証し、遷移実行済みフラグを**先に**設定してから行う。タイマー、クリック、確認通知が競合しても1回しか実行しない。

room終了通知をbest effortで送り、WSS・カメラ・タイマーを止め、暗号鍵と接続情報を破棄する。HTTP(S)は検証済み`URL.href`へ`location.assign()`する。独自schemeは受信者のクリックイベント内でだけ起動要求し、ブラウザの確認を回避しない。

アプリ未導入・ダウンロード等でページが残った場合は接続終了状態を維持し、最新内容を表示・コピーできる。手動で外部アプリを再度開くことは許容するが、接続や自動遷移を復活させない。ページ離脱時には最新本文への参照も破棄する。

## 13. エラーコードと表示・回復

サーバーは固定コードだけを返し、UIはローカル辞書で翻訳する。本文、内部例外、stack trace、暗号鍵、接続URLをエラーメッセージへ連結しない。スペイン語を含む全言語の文言は辞書で定義し、本表には日英を示す。CLIでの扱いは第14.14節の対応表に従う。

| コード | 発生元 | 日本語の主表示 | 英語の主表示 | 回復 |
| --- | --- | --- | --- | --- |
| `PAIR_UNAVAILABLE` | サーバー | この接続用QRコードは使用できません | This pairing QR code is unavailable | 受信側で新しいQRを表示 |
| `PAIR_EXPIRED` | サーバー | QRコードの有効期限が切れました | Pairing QR code expired | 新しいQR |
| `PAIR_TIMEOUT` | サーバー | 接続の確認がタイムアウトしました | Pairing verification timed out | 未消費QRなら再読取 |
| `READY_TIMEOUT` | サーバー | 接続を完了できませんでした | Connection could not be completed | 新しいQR |
| `PEER_BUSY` | サーバー | 別の端末が接続を確認しています | Another device is pairing | 少し待ってQRを再読取 |
| `DUPLICATE_ROLE` | サーバー | この接続はすでに使用されています | This connection is already in use | 新しいQR |
| `AUTH_FAILED` | 端末／サーバー | 接続相手を確認できませんでした | The other device could not be verified | 候補だけを終了、再読取 |
| `SESSION_EXPIRED` | サーバー／受信側 | 接続の有効期限が切れました | Session expired | 新しいQR |
| `PEER_CLOSED` | サーバー | 相手との接続が切れました | The other device disconnected | 新しいQR |
| `NETWORK_DISCONNECTED` | 端末 | 接続が切れました | Disconnected | 接続を確認して新しいQR |
| `PROTOCOL_ERROR` | 端末／サーバー | 通信を確認できなかったため終了しました | Connection ended because verification failed | 終了して新しいQR |
| `MESSAGE_TOO_LARGE` | サーバー | データが大きすぎます | Message is too large | 該当接続を終了 |
| `RATE_LIMITED` | サーバー | 操作が多すぎます。少し待ってください | Too many requests. Please wait | 待機後に再試行 |
| `CAPACITY` | サーバー | 現在接続が混み合っています | The service is currently busy | 待機後に再試行 |
| `SLOW_PEER` | サーバー | 相手への送信を続けられませんでした | The other device could not keep up | 終了して再接続 |
| `SERVER_SHUTDOWN` | サーバー | サービスが再起動しています | The service is restarting | 再起動後に新しいQR |
| `SERVER_ERROR` | サーバー | 接続を続けられませんでした | The connection could not continue | 再試行 |
| `ORIGIN_DENIED` | サーバー | 接続先を確認できませんでした | The service origin could not be verified | 正規URLから開き直す。CLIは`--server`を確認 |
| `VERSION_UNSUPPORTED` | サーバー／端末 | ページを更新してください | Please reload the page | 更新後に新しいQR。CLIは対応版へ更新 |
| `PAIR_LINK_INVALID` | sender | 接続情報が正しくありません | Invalid pairing information | QRを再読取 |
| `CRYPTO_UNAVAILABLE` | 端末 | このブラウザでは安全な接続を開始できません | This browser cannot start a secure connection | 対応ブラウザ・HTTPSで開く |
| `CAMERA_INSECURE` | sender | カメラを使うにはHTTPSで開いてください | Open this page over HTTPS to use the camera | HTTPSの正規URL |
| `CAMERA_DENIED` | sender | カメラの利用が許可されていません | Camera permission was not granted | 設定案内、明示的な再試行 |
| `CAMERA_NOT_FOUND` | sender | 利用できるカメラがありません | No camera is available | カメラ付き端末を利用 |
| `CAMERA_BUSY` | sender | カメラを利用できません。他のアプリを確認してください | The camera is unavailable. Check other apps | 他アプリを閉じて再試行 |
| `CAMERA_ERROR` | sender | QRコードの読み取りを開始できませんでした | QR scanning could not be started | 再試行 |
| `CONTENT_EMPTY` | sender | QRコードに転送できる文字列がありません | The QR code contains no transferable text | 別のQRを読む |
| `CONTENT_TOO_LARGE` | sender | 読み取った内容が上限を超えています | The scanned content exceeds the size limit | 別のQR、内容は自動変更しない |
| `CONTENT_INVALID` | 端末 | 読み取った文字列を扱えません | The scanned text could not be processed | 別のQRを読む |
| `CONTENT_UNSUPPORTED` | sender（`ack`の`rejected`） | 受信側の出力形式ではこの内容を扱えません | The receiver's output format cannot handle this content | 内容はコピー可能。受信側のCLIを`--jsonl`で起動し直し、新しい接続用QRを読む |
| `ACK_TIMEOUT` | sender | 受信を確認できませんでした | Receipt could not be confirmed | 接続中なら送達を再確認 |
| `FINAL_ACK_TIMEOUT` | Web受信ページ | 内容を受信しました。開く場合はボタンを押してください | Content received. Use the button to open it | 表示・手動操作 |
| `TRANSFER_LIMIT` | 受信側／サーバー（中継） | 新しいQRコードで接続し直してください | Reconnect using a new QR code | 新しいQR |

`AUTH_FAILED`がcommit前なら候補のみ、commit後のreceiverProof不一致や暗号検証エラーならroom全体を終了する。表の端末専用コードを、そのまま未認証ソケットへ送れる仕様として扱わない。

カメラの`NotAllowedError`、`NotFoundError`、`NotReadableError`等はアダプターで上記コードへ変換する。ブラウザ固有の例外文字列をUIへ直接表示しない。接続断でも確定済みの受領結果は保持する。

## 14. CLI受信クライアント

### 14.1 概要と利用フロー

利用者がターミナルで`qrtoss`を起動すると、接続用QRコードがstderrへ表示される。利用者はスマホでそのQRコードを読み、送信ページで対象のQRコードを読み取って送信する。CLIは1件の受信内容を復号・検証し、stdoutへ書き出した後、受領確認と終了処理を行って終了する。ブラウザを備えない環境、SSH接続先、ファイルへのリダイレクト、シェル変数への代入、他のプログラムへのパイプ接続を利用場面に含める。

1件受信して終了するまでの流れ：

1. 利用者が`qrtoss`を起動する。
2. CLIが引数、出力先、表示環境を検証する。
3. 第11.2節の手順でroomを作成し、PSKを生成し、受信側として認証する。
4. **認証が成功してから**、有効な接続用QRコードと期限をstderrへ表示する。
5. スマホの標準カメラで接続用QRコードを読む。
6. スマホで送信ページが開き、カメラを許可する。送信ページは受信側がコマンドラインであることを表示する。
7. スマホで転送したいQRコードを読み取り、内容を確認して送信する。
8. CLIが復号・検証を行い、受信内容をstdoutへ出力する。
9. CLIが`ack`を返す。スマホは「受信端末に届きました」を表示し、`ack_seen`を返す。
10. CLIは第14.12節の終了処理を経て、コード0で終了する。

スマホのUIにCLI専用の操作手順を増やさない。受領確認の意味は第12.3節の「受理処理の完了」で統一し、CLIではstdoutへの書き出しをその処理とする。

1回の起動で出力するレコードは1件だけとする。別の内容を受信する場合は、利用者が`qrtoss`を改めて起動する。

```sh
# 1件受信し、終了する。
qrtoss

# QRと状態は端末に表示し、受信内容だけをファイルへ保存する。
qrtoss > received-url.txt

# 受信内容をシェル変数に代入する。
url="$(qrtoss)"

# 出力可能なメッセージを受け付けるまで、最大120秒待つ。
qrtoss --timeout 120

# 改行を含む文字列も、1メッセージ1行のJSONで保存する。
qrtoss --jsonl > received.jsonl

# 自己ホストした公開サービスに接続する。
qrtoss --server https://qrtoss.example/

# stderrが端末でない環境で、接続URLの文字表示を明示的に許可する。
qrtoss --qr off --pairing-url 2> pairing.log
```

最後の例の`pairing.log`には接続権限を含むURLが入る。これは利用者が明示したローカル出力であり、通常の診断ログとは区別する。シェルのコマンド置換は末尾の改行を取り除くため、改行を含む文字列の厳密な受け渡しにはJSON Linesを用いる。

### 14.2 対応環境

| 項目 | 初版の方針 |
| --- | --- |
| OS・CPU | macOS arm64 / amd64、Linux arm64 / amd64 |
| 必要な実行環境 | 配布済みCLI本体の実行にGo、Node.js、Pythonの事前導入を要求しない |
| 実行ファイル | CGOを使わない（`CGO_ENABLED=0`）単一の実行ファイル。Linuxではglibc・muslの環境で動作させる |
| シェル | 通常起動はシェル固有機能に依存しない。試用ランチャーはPOSIX `sh` |
| 端末 | UnicodeとANSIの白黒表示を利用できる端末を標準とする。文字QRを表示できない環境には接続URL表示を用意する |
| ネットワーク | CLIとスマホから公開サービスのHTTPS/WSSへ接続できること |
| SSH | SSHの対話端末内での起動を対象に含める |
| Windows | 初版の必須対象には含めない。後続版で同じ出力・通信契約に対応できる構造にする |

OSの最低バージョンとLinuxの実行条件は、採用したGoツールチェーンと実際のCI結果に基づいてリリースごとに明示する。未試験のOSを一律に動作保証しない。

### 14.3 コマンドライン

```text
qrtoss [--timeout SECONDS]
       [--format text|jsonl] [--jsonl]
       [--qr auto|compact|full|off] [--pairing-url]
       [--color auto|always|never]
       [--server URL]
qrtoss --help
qrtoss --version
```

位置引数は受け付けない。`--name=value`と`--name value`は同じ意味とする。オプションは`--`で始まる長い形式だけとし、単一ダッシュの形式（`-timeout`等）を受け付けない。未知のオプション、不正な値、競合する指定は、通信を始める前に終了コード2で拒否する。

| オプション | 既定 | 契約 |
| --- | --- | --- |
| `--timeout SECONDS` | `0` | 出力可能なメッセージの受付までの上限。0〜2,147,483,647の十進整数（先頭0・符号・小数を拒否） |
| `--format text` | 有効 | 制御文字を含まない1行の文字列を出力する |
| `--format jsonl` | 無効 | 第14.7.3節のJSONオブジェクトを1件1行で出力する |
| `--jsonl` | 無効 | `--format jsonl`の別名 |
| `--qr auto` | 有効 | stderrが対応端末ならcompact表示（UTF-8でないロケールではANSIによるfull表示）。表示できなければ第14.8.5節の代替規則に従う |
| `--qr compact` | 無効 | Unicodeの半ブロック文字を使う |
| `--qr full` | 無効 | 1モジュールを横2セル・縦1行として表示する |
| `--qr off` | 無効 | QRの描画を止める。初版では`--pairing-url`との併用が必須 |
| `--pairing-url` | 無効 | 完全な接続URLをstderrへ文字列で出力することを明示的に許可する |
| `--color auto` | 有効 | QRの白黒を、stderrが対応端末でANSIを抑止する指定がなければANSIで明示する |
| `--color always` | 無効 | 対応するTTY上で`NO_COLOR`があってもANSIを使う。非TTYへANSIを流す許可にはしない（非TTYでは無視し、エラーにしない） |
| `--color never` | 無効 | ANSIを出さない。文字QRは端末テーマの影響を受ける |
| `--lang` | 互換用 | 従来値は受け付けるが表示は英語に固定 |
| `--server URL` | リリースに設定した公式の公開origin | 自己ホストの公開サービスを指定する（第14.5節） |
| `--help` | — | ヘルプをstdoutへ表示し、通信せず0で終了する |
| `--version` | — | CLI版、対応プロトコル版（`qrtoss/1`）、ビルド識別子（ソースcommit）をstdoutへ表示し、通信せず0で終了する |

`--jsonl --format jsonl`のような同じ意味の指定は許可する。`--jsonl --format text`のような競合は、指定順に依存させずエラーにする。単一値オプションに異なる値を重複して指定した場合もエラーにする。`--timeout`の意味は第14.10節に定める。

`--help`または`--version`を含む場合は、他の指定の検証より優先して表示し、通信せずにコード0で終了する。両方ある場合は`--help`を優先する。ヘルプには、必要な端末寸法、QRが崩れる場合の`--qr full`、端末テーマと`--color`、`--pairing-url`、`--jsonl`、SSHでの利用、`2>&1`でstdoutとstderrを結合した場合の注意、`localhost`の`--server`がスマホから到達できない場合があることを記載する。

Goの標準`flag`パッケージは、同じオプションの重複を後勝ちで受理し、単一ダッシュの形式も受け付けるため、そのままでは本節の検査を満たさない。専用の解析処理を実装するか、同等の検査を追加する。

### 14.4 環境変数

| 変数 | 用途 |
| --- | --- |
| `QRTOSS_SERVER` | 公開サービスのorigin。コマンドラインの`--server`が優先 |
| `QRTOSS_LANG` | 互換用。表示言語には影響しない |
| `LC_ALL` / `LC_CTYPE` / `LANG` | 端末のUTF-8判定に使用。表示言語は英語固定 |
| `LC_ALL` / `LC_CTYPE` / `LANG` | 文字コードの判定に使用。UTF-8のロケールでだけ半ブロック文字を使う |
| `NO_COLOR` | 非空なら、`--color`の明示指定がない場合にANSIを無効にする |
| `TERM` | 端末機能の判定に使用。`dumb`は自動QR表示の対象外。`256color`を含むかで色の指定方法を選ぶ |
| `COLORTERM` | 設定されていれば256色以上の色指定に対応するとみなす |
| `HTTPS_PROXY` / `NO_PROXY` | Go標準の規則でHTTPSとWSSのプロキシを使う（推奨） |
| `SSL_CERT_FILE` / `SSL_CERT_DIR` | Linuxで、Go標準の規則により信頼するCAの場所を指定できる[S33] |

初版では永続的なCLI設定ファイルを作成しない。接続秘密、暗号鍵、本文を環境変数やコマンドライン引数で受け渡す機能を設けない。

### 14.5 `--server`と接続先

`--server`は、送信ページと共通API/WSSを提供する公開サービスのoriginを指定する。API専用URLや、CLI上のローカル待ち受けアドレスを意味しない。

- 形式は`https://ホスト[:ポート][/]`だけを受け付ける。HTTPSを必須とし、userinfo、`/`以外のパス、query、fragmentを拒否する。CLIのサブパス配備への接続は初版の対象外。
- ホスト名はASCIIで指定する。国際化ドメイン名はpunycode形式で指定する。末尾ドットを含むホスト名を拒否する。
- 公開originへ正規化する。scheme・ホスト名を小文字にし、443番ポートを省略する（RFC 6454のASCII直列化）[S35]。例：`HTTPS://QRTOSS.Example:443/` → `https://qrtoss.example`。
- 正規化したoriginを、`Origin`ヘッダー、`POST {origin}/api/v1/rooms`、`wss://{ホスト[:ポート]}/ws`、接続用URL`{origin}/send#…`に用いる。これ以外のパスを独自に組み立てない。
- CLIとスマホの双方が到達できる名前・証明書で公開されている必要がある。`localhost`やSSH接続先だけから見える内部名では、スマホから到達できない場合がある。
- TLS証明書とホスト名を検証する。`--insecure`等の検証無効化を設けない。私設CAを使う自己ホストでは、OSの信頼ストアへ追加する。LinuxではGoが参照する`SSL_CERT_FILE`・`SSL_CERT_DIR`も使える。
- ローカル試験は、テスト専用の証明書・CAと注入可能なトランスポートで行う（第18.5節）。
- CLIは外部から接続を受ける待受ポートを開かない。
- 既定値はリリース時にビルドへ埋め込む公式の公開origin。自己ホスト向けのビルドでは、リンカー設定（`-ldflags -X`）で既定値を変更できる。

### 14.6 入出力チャネル

| チャネル | 内容 |
| --- | --- |
| stdin / fd 0 | 受信モードでは読み取らない。確認入力を要求しない |
| stdout / fd 1 | 受信レコードだけを出す。ヘルプ・バージョン表示のみ例外 |
| stderr / fd 2 | QR、明示された接続URL、状態、警告、エラー、配布・起動の案内 |

stdoutにバナー、状態、日時、装飾、件数、プロンプトを混ぜない。エラー発生時もstdoutへ説明文を追加しない。出力チャネルの分離は、CLI本体だけでなくランチャーにも適用する。

stdoutがファイルまたはパイプであっても、stderrが端末であればQRを表示する。TTY判定にstdoutだけを使ってはならない。利用者が`2>&1`等で両者を結合した場合は、受信データだけのストリームにはならない。[S22]

書き込みの規則：

- 1件の出力レコードをメモリ上で完成させてから、stdoutに書き込む。
- 受け付けた1件だけを書き込み、再送による並列書き込みや追加レコードの出力を行わない。
- 書き込めたバイト数とエラーを確認する。短い書き込みを成功扱いにしない。[S23]
- ユーザー空間のバッファを使う場合は、レコード全体のflushを完了させる。
- `fsync`相当によるファイルの永続保存確認は成功条件に含めない。
- stdoutの出力に失敗したら、同じプロセスでそのレコードを先頭から自動的に書き直さない。
- 書き込みの途中で失敗した場合、出力済みの一部は残り得る。巻き戻しや削除を試みない。
- stdoutとstderrの両方が端末の場合は、両者への書き込みを一つの排他で直列化し、QRブロックの途中に受信レコードが入らないようにする。OSが複数プロセスによる端末出力全体を原子的にすると仮定しない。

バックプレッシャー：パイプ先の読み取りが遅い場合、stdoutの書き込みが待たされることがある。書き込みを担当する処理とネットワーク処理を別のgoroutineに分け、heartbeat・`room.touch`・切断処理を書き込みの完了に依存させない。新規メッセージは最初の1件だけを受け付け、別の新規メッセージを出力待ちのキューへ積まない。`--timeout`はstdoutへの書き込み時間を制限しない。停止した出力先を含めて厳密にプロセス実行時間を制限したい利用者は、呼び出し元でプロセス全体を管理する。

### 14.7 出力形式

#### 14.7.1 共通規則

- データは有効なUnicode文字列とする。stdoutの符号化はUTF-8とし、BOMを付加しない。本文先頭のU+FEFFは本文の一部として出力する。
- 不正なUTF-8や不正なUnicode表現を置換文字へ変換しない。検出した場合はプロトコル違反として扱う（第9.5節）。
- schemeによる許可リストを設けない。`https:`、`http:`、`mailto:`、`tel:`、独自scheme、通常のテキストを同じ文字列として扱う。
- URLの解析・アクセスによる検証は行わない。本文に含まれるホストへのDNS問い合わせやHTTP要求を発生させない。
- trim、URLデコード、パーセント符号化の変更、Unicode正規化、改行の除去を行わない。
- 空文字列は送信側が送らないため、受信した場合はプロトコル違反として扱う。
- 本文の上限（16,384バイト）を出力形式への変換前に検証する。JSONエスケープによる長さの増加とは区別する。

#### 14.7.2 text形式

出力は次のバイト列とする。

```text
UTF8(受信文字列) + 0x0A
```

次の符号位置（以下「端末で安全でない符号位置」）を含む本文はtext形式では表現しない。

| 文字範囲 | 理由 |
| --- | --- |
| U+0000–U+001F | NUL、TAB、CR、LF、ESC等の制御文字 |
| U+007F–U+009F | DEL、C1制御文字 |
| U+2028、U+2029 | 行・段落の区切り |
| U+061C、U+200E、U+200F、U+202A–U+202E、U+2066–U+2069 | 表示順を変える方向制御文字 |

この制限は端末と1行1件の契約のためのものであり、転送可能な文字列をサービス全体で制限するものではない。同じ内容をJSON Linesでは可逆に表現できる。

textで表現できない場合、stdoutへはそのメッセージの1バイトも出力せず、`ack`（`rejected`、`unsupported_content`）を返す。stderrに`REJECTED`と`--jsonl`の案内を表示し、第14.12節に従いコード6で終了する。

#### 14.7.3 JSON Lines形式

初版の出力オブジェクトは、`text`フィールド1つを持つ次の形に固定する。

```json
{"text":"https://example.com/article"}
{"text":"1行目\n2行目"}
{"text":"mailto:user@example.com"}
```

上のコードブロックは、別々の起動で受信した場合の出力例を3件示す。1回の起動で出力するのは、このうち1件のようなJSONレコード1個とし、配列にはしない。

- 1メッセージにつき1個のJSONオブジェクトと末尾LFを出力する。
- キーはASCIIの`text`に固定する。値は元のUnicode文字列を表す。
- 状態、ACK、エラー等を別種のJSONレコードとして混ぜない。
- 日時、セッションID、メッセージID等の追加フィールドは初版の出力APIに含めない。
- JSONとして解析した`text`が入力文字列と一致することを必須とする。[S24]

fixtureをバイト単位で比較できるよう、文字列のエスケープ規則を次のとおり固定する。

| 文字 | 出力 |
| --- | --- |
| `"`（U+0022） | `\"` |
| `\`（U+005C） | `\\` |
| U+0008、U+0009、U+000A、U+000C、U+000D | `\b`、`\t`、`\n`、`\f`、`\r` |
| 上記以外の、端末で安全でない符号位置（第14.7.2節） | `\u`＋小文字16進4桁（例：`\u001b`、`‮`） |
| その他の文字 | UTF-8のまま。`/`、`<`、`>`、`&`、日本語、絵文字もエスケープしない |

一般的なJSONエンコーダーは、C1制御文字や方向制御文字をエスケープせず、`<`等を独自にエスケープするものもある。この規則を実装した専用の符号化処理を使う。付録A.5のfixtureと一致させる。

#### 14.7.4 出力例と非実行の確認

| 受信内容 | text出力 | JSON Linesの`text` |
| --- | --- | --- |
| `https://example.com/a?x=1` | 原文＋LF | 原文を保持 |
| `tel:+81312345678` | 原文＋LF | 原文を保持 |
| `custom-app:some-action` | 原文＋LF | 原文を保持 |
| 日本語の通常テキスト | 原文＋LF | 原文を保持 |
| 改行を含む名刺情報 | 拒否し、`--jsonl`を案内 | 改行をエスケープして保持 |
| ESCを含む文字列 | 拒否し、`--jsonl`を案内 | ESCをエスケープして保持 |

どの出力形式でも、URLオープナー、OSのscheme handler、シェル、クリップボード操作をCLIが呼び出すことはない。

### 14.8 ターミナル表示

#### 14.8.1 表示方式

MVPは**追記式**とする。QR更新や状態変更に伴う画面全体の消去、カーソル移動、代替画面バッファへの切り替え、スクロール履歴の消去を行わない。利用者の既存の端末表示とスクロール履歴を維持するためである。

残り秒数を毎秒上書きせず、起動案内、有効期限、文字QRの順に表示する。有効期限は`auth.ok`の期限差から求め、利用者端末のローカルタイムゾーンで`YYYY-MM-DD HH:mm:ss (TZ)`形式に整形する。CSTを固定値にせず、実際のタイムゾーン名を表示する。

```text
Scan this QR code with your phone’s camera
[EXPIRES] 2026-11-18 10:28:05 (CST)
（ここに文字QRを表示）
```

これはstderrの表示例であり、受信内容はstdoutに原文だけを出力する。通常の`CONNECTED`、`PEER_SCANNED`、`RECEIVED`、再接続・QR更新・通常の切断のログは表示しない。必要なエラー・警告は英語でstderrへ表示する。`--pairing-url`を指定した場合は接続URLを単独の行に出力する。

#### 14.8.2 QRの描画要件

- QRに符号化する内容は、第9.2節の接続用URLとする。符号化条件は第9.2.1節に従う。
- QR生成はCLI内部で行う。機密情報を外部QR生成コマンドの引数へ渡さない。
- compactは1文字セルを縦2モジュールとし、上半ブロック`▀`（U+2580）、下半ブロック`▄`（U+2584）、全ブロック`█`（U+2588）、空白で描画する。UTF-8のロケールでだけ使う。
- fullは1モジュールを横2セル・縦1行とする。ANSIが使える場合は背景色を付けた空白2文字で、使えない場合は全ブロック2文字と空白2文字で描画する。
- 端末の幅・高さはstderr側の端末から取得する。stdoutや本文の長さで判定しない。
- 幅不足で折り返されたQRを表示しない。
- SIGWINCHを受けた場合は寸法を再確認する。表示中の有効なQRが崩れた可能性があり、幅が足りる場合は、同じ有効QRを追記表示してよい。有効期限は延長しない。
- QRの符号化は既存のライブラリ（例：`rsc.io/qr`）でモジュール行列を得て、描画は本節の規則で実装する。`qrterminal`[S26]等の描画ライブラリを使う場合も、余白・色・出力先・寸法検査が本節と同じ結果になることを試験で確認し、ライブラリのサンプル値を規則として採用しない。

#### 14.8.3 必要な端末寸法

QRの版`V`から余白込みのモジュール数`N = 17 + 4V + 8`を求め、compactは`N`桁×`ceil(N/2)`行、fullは`2N`桁×`N`行を必要とする（第9.2.1節の表）。

- 幅が足りない場合はQRを表示せず、第14.8.5節の代替規則に従う。
- 高さが足りない場合でも、QRは折り返されず正しく出力されるため表示する。ただしQR全体が一度に画面へ入らず読み取れないことがあるため、表示の直前に必要な行数を`WARNING`で示す。端末を広げると、出力済みのQR全体が見えるようになる。
- 標準的な80桁×24行の端末では、版8のcompact表示（57桁×29行）でも高さが足りない。ヘルプとREADMEに推奨寸法（目安：80桁×34行以上）を記載する。

#### 14.8.4 文字幅・色・行間

- compactで使う半ブロック文字は、UnicodeのEast Asian Widthが曖昧（Ambiguous）である[S34]。曖昧幅の文字を全角として扱う端末設定（日本語環境で選ばれることがある）では横幅が2倍になり、QRが崩れる。CLIはこの設定を確実に検出できないため、ヘルプとQR表示時の案内に「QRが崩れる場合は`--qr full`」を示す。ANSIを使うfull表示は空白だけで描画するため、この設定の影響を受けない。
- ANSIを使う場合は、暗モジュールを黒、明モジュールと余白を白として、前景色・背景色を明示する。`TERM`が`256color`を含むか`COLORTERM`が設定されている場合は、端末テーマで置き換えられにくい256色の固定色（黒`16`、白`231`）を使い、それ以外は基本色（黒`30`/`40`、明るい白`97`/`107`）を使う。各行の改行の前に属性を戻し（`ESC[0m`）、背景色が行末へ広がらないようにする。状態行には装飾を要求しない。
- `--color never`ではQRは端末の前景・背景色で描かれ、暗いテーマでは反転して見える場合がある。端末テーマを合わせるか、`--pairing-url`を利用できるようヘルプに記載する。
- 行間を広げた端末設定ではモジュールの間に隙間ができ、読み取れない場合がある。ヘルプに記載し、白背景・黒背景、ANSIの有無と合わせて実機試験で記録する。

#### 14.8.5 TTYと代替表示

| 環境 | `--pairing-url`なし | `--pairing-url`あり |
| --- | --- | --- |
| stderrが対応TTYでQRの幅が収まる | QRを表示 | QRと接続URLを表示 |
| stderrがTTYだが幅不足・非対応（`TERM=dumb`、UTF-8でなくANSIも使えない等） | 必要な桁数を案内し、コード2で終了 | QRを省略し、URLを表示して待つ |
| stderrが非TTY | 秘密を自動出力せず、コード2で終了 | ANSIなしでURLと状態を出力して待つ |
| `--qr off` | 引数エラー、コード2 | URLだけを接続手段として表示 |

`--qr auto`は、UTF-8のロケールならcompactを選ぶ。UTF-8でないロケールでANSIが使える場合は、背景色付きの空白によるfullを選ぶ。選んだ表示の幅が収まらない場合、どちらも使えない場合は、上表の「幅不足・非対応」とする（fullはcompactの2倍の幅を要するため、compactが収まらない端末へfullを選び直さない）。非TTYにおける明示の`--qr compact`・`--qr full`は引数・環境エラーとする。CI等でQR画像を生成する機能は初版に追加しない。

#### 14.8.6 内部イベントと診断

以下の名前は内部の識別子であり、通常状態を端末に表示することは意味しない。`WAITING`はプレフィックスなしの起動案内、`EXPIRES`は整形済み期限を出す。通常の接続・受領・回復イベントは無表示とし、拒否・確認不能・警告・エラーのみ診断を表示する。

| イベント名 | 表示内容の意味 |
| --- | --- |
| `WAITING` | 有効な接続情報を登録し、スマホの接続を待っている |
| `EXPIRES` | 表示したQRの新規接続期限 |
| `CONNECTED` | E2EE接続が成立した（第11.2節の手順15） |
| `PEER_SCANNED` | 送信側で読み取りが完了し、送信を待っている（`status/scanned`） |
| `RECEIVED` | stdoutへの1件の書き出しが成功した |
| `REJECTED` | 当該メッセージを選択した形式で出力できず、拒否した |
| `DISCONNECTED` | 相手の終了や通信断で接続が終わった |
| `RECONNECTING` | 新しいroomを作成するため、サービスへの接続を試みている |
| `QR_REFRESHED` | 旧接続情報を失効させ、新しいQRを発行した |
| `SESSION_EXPIRED` | 無操作期限によりセッションが終了した |
| `ACK_UNCONFIRMED` | 出力は成功したが、受領確認の配送を確認できなかった |
| `WARNING` | 処理を続けられる警告（端末の高さ不足等） |
| `ERROR` | 終了を伴うエラー |

イベント名は翻訳しない。説明文だけを翻訳する。stderrの文面は機械処理用APIとはしない。

### 14.9 接続管理と状態

#### 14.9.1 状態モデル

```mermaid
stateDiagram-v2
    direction TB
    [*] --> Starting
    Starting --> Pairing: roomを作成し受信側の認証に成功
    Starting --> Failed: 設定やTLSのエラー、回復予算の超過
    Pairing --> Connected: E2EE接続の成立
    Pairing --> Renewing: QRの失効、ready期限切れ、通信断
    Connected --> Writing: 新規dataの受付
    Writing --> Draining: 出力成功
    Writing --> Failed: stdoutへの書き込み失敗
    Connected --> Draining: 選択した出力形式で恒久拒否
    Connected --> Renewing: 本文受付前の相手の終了、無操作期限、通信断
    Renewing --> Pairing: 新しいroomで新しいQRを表示
    Renewing --> Failed: 回復予算の超過
    Draining --> Done: ack_seenの受信または猶予の終了
    Pairing --> Done: timeoutの到達
    Connected --> Done: timeoutの到達
    Failed --> [*]
    Done --> [*]
```

図は主要な経路を示す。SIGINT・SIGTERMと内部エラーは全状態で起こり得る。commit後のプロトコル違反は第14.14節のとおりコード4で終了する。ただし出力成功または恒久拒否の確定後は第14.12節の終了コードの規則を優先する。恒久拒否の場合は終了処理後にコード6で終了する。

#### 14.9.2 roomの作成と更新

- 起動時と、本文受付前に新しいQRが必要になったとき（未使用QRの失効、ready期限切れ、相手の終了、無操作期限、通信断）に、CLIは第11.2節の手順1〜2で新しいroomを作成し、受信側として認証してからQRを追記表示する。本文を受け付けた後はroomを作り直さず、出力または恒久拒否の結果に従って終了する。
- room作成と認証には回復予算（30秒）を適用する。1回の試行は`min(15秒, 回復予算の残り, 有効な--timeoutの残り)`で打ち切る。利用者指定の期限がない場合は、その項を除く。再試行前の待ち時間も残り予算で切り詰め、予算が尽きた後に新しい試行を開始しない。試行中も予算を超えて待たない。
- 回復予算を使い切ってサービスに接続できなければ、コード3で終了する。
- 旧roomの鍵・capability・PSK・重複判定記録は、新しいroomへ持ち越さない。旧roomで受信中の本文を新しいroomへ移さない。サーバーに保管された本文の再配送は存在しない。未確認メッセージの再送主体は送信端末である。
- 未使用QRの失効は、サーバーの`room.closed`（`PAIR_EXPIRED`）で知る。失効の最終判定はサーバーが行う。旧QRが端末のスクロール履歴に残っていても、新規接続には使えない。
- 初回ペアリングの成立後、同じQRで別の送信端末を接続させない。
- 接続成立済みのセッションを、接続用QRの期限だけを理由に切断しない。期限境界での成立と失効の競合はサーバーのatomic commitで一意に決まる。CLIの表示だけで成立を判断しない。
- 同一セッションの再開は行わない。旧仕様の「同一セッションを再開」に相当する私有の再接続通信を実装しない。

#### 14.9.3 接続中の処理

CLIは第11.2節の手順15と同じ条件（ready検証とサーバーの`pair.active`の両方）で内部状態を接続済みへ進め、端末へ状態ログを出さず、その後`mode`（`stdout`）を送る。heartbeatは第10.6節に従い、CLIもアプリ用`hb.ping`を15秒ごとに送る。送信側からの`activity`・`status`・`data`を検証したら、第4.4節の規則で`room.touch`を送る。`status/scanned`は内部で扱い、状態ログは表示しない。

無操作期限に達してroomが終了した場合、書き込み中であれば第14.9.4節に従って結果を確定させてから終了する。本文受付前で、利用者指定の待機期限が残っていれば新しいroomの作成へ進む。出力成功または恒久拒否の確定後は、第14.12節に従って終了する。

#### 14.9.4 書き込み中の終了・切断

通信断やroomの終了を検出したときにstdoutへの書き込みが進行中なら、その書き込みの完了（成功または失敗）を待ってから次へ進む。待機中も旧roomの鍵と記録を保持し、新しいroomの作成や新しい出力を開始しない。書き込みの完了待ちに時間の上限は設けない（`--timeout`も適用しない）。SIGINT・SIGTERMはこの待機を中断する。

- 書き込みに失敗したら、コード5で終了する。
- 書き込みに成功し、ackを送れなかった場合は、`ACK_UNCONFIRMED`を表示してコード0で終了する。新しいroomは作成しない。

### 14.10 `--timeout`の厳密な意味

`--timeout N`は、CLIの引数・環境検証後、最初のネットワーク処理を始める直前を起点とする。初回接続、QRの読み取り待ち、QRの再発行、再接続を含む。ランチャーによるCLI取得時間は含めない。

期限は、最初の出力可能なメッセージを検証し、出力処理に受け付けるまで有効である。受付確定時の単調時計が期限以上であれば新規書き込みを開始せず、`room.close`（`user_end`）をbest effortで送り、コード124で終了する。タイマー通知の配送順序だけで期限を判定しない。出力処理を開始したらこのタイマーは解除し、以後は書き込み結果と終了猶予で終了を決める。

QRの更新、通信の再接続、無効なメッセージによってタイマーをリセットしない。経過時間の計測は単調時計を用いる。システム時刻の変更によって利用者指定の待機時間を延長しない。

### 14.11 出力、受領確認、重複排除

#### 14.11.1 成功境界

`ack`（`received`）は、次の全条件を満たした後にのみ送る。

1. 共通プロトコルの認証・復号・整合性確認に成功した。
2. 文字列と上限を検証し、選択された出力形式へ変換できた。
3. stdoutへレコード全体を書き込めた。
4. 使用しているユーザー空間バッファのflushが完了した。
5. room内のメモリ内記録を`written`に更新した。

この成功は、標準出力への書き出しを意味する。パイプ先のアプリケーションによる処理完了、ファイルの物理的な永続保存、利用者の閲覧は意味しない。

#### 14.11.2 処理順序

```mermaid
sequenceDiagram
    participant S as 送信ページ
    participant M as 中継サーバー
    participant C as CLI
    participant O as 標準出力
    S->>M: cipher（data）
    M->>C: cipherを中継
    C->>C: 復号・schema・重複判定・出力形式の検証
    alt 新規idで出力できる
        C->>O: レコード全体を書き込みflush
        alt 書き込みとflushに成功
            O-->>C: 成功
            C->>C: 出力済みを記録
            C->>M: cipher（ack received）
            M->>S: 中継
            S->>M: cipher（ack_seen）
            M->>C: 中継
        else 書き込みに失敗
            O-->>C: エラー
            C->>C: ackを送らずコード5で終了
        end
    else 新規idで選択した出力形式に合わない
        C->>M: cipher（ack rejected）
        M->>S: 中継
    else 既知idで同じ本文
        C->>M: 記録済みの結果でackを再送
        M->>S: 中継
    end
```

本文・ID・形式以外の検証に失敗した場合は、書き込みへ進まず、第14.14節のとおりプロトコル違反として扱う。出力中の同じidは最初の処理結果へ合流する。本文を書き出した後、ackの送信に失敗したという理由で再出力しない。

#### 14.11.3 重複判定記録

重複判定はroom（roomIdとpeerId）ごとに`messageId`で行い、受け付けた最初の1件の記録だけをroomの終了時まで保持する。記録には次だけを保持する。

- messageId
- 本文のUTF-8バイト列のSHA-256ダイジェスト
- `writing`・`written`・`rejected`の状態
- 再送時に返すackの結果

処理結果が確定した本文や出力レコードは、重複判定のために保持し続けない。ダイジェストはメッセージ認証の代替には使わない。

| 受信内容 | 処理 |
| --- | --- |
| 最初の新しいid | 通常の検証・出力処理 |
| 最初の1件を受け付けた後の別の新しいid（本文の同異を問わない） | 追加出力せず、プロトコル違反（第12.5節）としてroomを閉じ、コード4。ただし出力成功または恒久拒否の確定後は第14.12節に従いコード0または6 |
| 同じid・同じ本文・出力中 | 二重出力せず、出力結果の確定後にackを返す |
| 同じid・同じ本文・出力済み | stdoutへ書かず、`received`のackを返す |
| 同じid・同じ本文・拒否済み | 同じ`rejected`のackを返す |
| 同じid・異なる本文 | プロトコル違反。roomを閉じ、コード4。ただし出力成功または恒久拒否の確定後は第14.12節に従いコード0または6 |

終了猶予中も記録を捨てず、同じid・同じ本文の再送にだけ記録済みの結果を返す。別の内容や同じURLを改めて受信するには、CLIを新しく起動し、新しいQRで接続する。

#### 14.11.4 保証の限界

重複抑制の保証範囲は、同一CLIプロセス・同一room内の再送である。stdoutへの書き込みとメモリ内記録の更新を、外部出力を含む原子的トランザクションにはできない。書き込み中の強制終了、書き込み成功直後のクラッシュ、プロセスを再起動しての再送、利用者による新しい送信操作まで含めたexactly-onceは保証しない。

終了コードが0以外であっても、部分出力、または中断前に出力を完了した1件のレコードが存在し得る。利用者側で厳密な業務処理を行う場合は、下流側でも入力の扱いを定める必要がある。

### 14.12 受信後の終了処理

stdoutへの出力成功後は、別の新規メッセージを出力しない。**出力成功と出力済み記録の確定直後に**、単調時計で2秒後の終了期限を設定し、次をこの期限内で行う。ack送信処理が戻ってから2秒を追加してはならない。

1. `ack`（`received`）を送る。
2. 対応する`ack_seen`を待つ。待機中に同じidの再送が届いたら、記録済みの結果でackを返す。
3. `ack_seen`を検証するか期限に達したら、`room.close`（`user_end`）を送り、WSSを閉じる。期限までに完了しない送信・終了処理は打ち切る。
4. コード0で終了する。期限までに`ack_seen`を検証できなかった場合は、stderrに`ACK_UNCONFIRMED`を表示する。

`ack_seen`は送信側がackを検証したことを示すが、利用者が画面を見たことまでは示さない。2秒の猶予は配送保証ではない。出力成功後のack配送の失敗・不確定と、終了猶予中のプロトコル違反は、CLIの終了コードを0以外に変更しない（stderrで警告する）。呼び出し元に出力失敗と誤認させないためである。ただしSIGINT・SIGTERMによる中断は、出力済みであってもシグナルに対応するコードを用いる。

text形式で表現できない内容を受けた場合は、stdoutへ何も書かず、拒否の確定から2秒の終了期限で同じ手順により`ack`（`rejected`）の送信と終了処理を行い、コード6で終了する。拒否通知の配送成否や、拒否確定後のプロトコル違反でこのコードを変更しない。違反はstderrで警告する。SIGINT・SIGTERMによる中断はシグナルに対応するコードを用いる。

### 14.13 プロトコル実装の構成

#### 14.13.1 旧CLI仕様の対応表の確定結果

| 項目 | 確定内容 | 定義箇所 |
| --- | --- | --- |
| 接続APIとWSS | `POST /api/v1/rooms`、`GET /ws`（subprotocol `qrtoss.v1`）、receiverとしての`auth`、Originヘッダー | 10.1〜10.3 |
| スマホ用接続URL | `/send#v=1&r=&j=&k=`。PSKはfragmentだけ。QRは誤り訂正M・余白4 | 9.2 |
| 暗号 | HKDF-SHA256、HMAC-SHA256の相互proof、AES-256-GCM、IV＝0（32 bit）‖seq、AAD | 9.3、9.4 |
| 識別子 | セッションはcommit済みroom（roomIdとpeerId）。メッセージIDは`data.id`（16バイト乱数、base64url 22文字） | 9.1、12.1 |
| ACK | 暗号化`ack`（`received`・`rejected`）と`ack_seen`。senderの待機10秒。再送は利用者操作のみで新しいseq | 12.3、12.4 |
| 恒久拒否 | `ack`の`status:"rejected"`、`reason:"unsupported_content"` | 12.1 |
| 一時拒否・受信側終了中 | 設けない。準拠したsenderでは発生せず、発生した場合はプロトコル違反 | 12.5、14.12 |
| 再接続 | 同一セッションの再開なし。本文受付前に限り、新しいroomで再ペアリング | 4.5、14.9 |
| 期限 | QR 60秒、候補10秒、ready 10秒、無操作120秒（受信側のtouch）。境界はサーバーのatomic commitで解決 | 4、11.3 |
| 中継の制限 | WSメッセージ32,768バイト、制御2,048バイト、圧縮なし、オンラインの相手へ即時中継のみ | 4.1、10.3、15 |

#### 14.13.2 内部の構成

CLIの状態管理・端末描画・stdout出力を、通信形式から切り離す。次の名称はCLI内部の意味上の契約であり、ネットワーク上のAPI名・JSONキーではない。

| 内部操作 | 入出力と意味 |
| --- | --- |
| `CreatePairing` | 公開originを受け、room作成・PSK生成・受信側認証を行い、接続用URL・有効期限・ハンドルを返す |
| `ReceiveEvent` | 候補・接続成立・復号済みメッセージ・送信側の状態・切断・失効・致命的エラーを通知する |
| `SendReceipt` | 出力成功または恒久拒否を`ack`へ対応づけて送る |
| `CloseSession` | `room.close`を送り、WSSを閉じ、鍵・capability・記録の参照を解放する。旧QRの無効化も兼ねる |

```go
type ReceivedMessage struct {
    RoomID    string // 認証済みroomの識別子（peerIdと組でセッションを表す）
    MessageID string // data.id
    Text      string // 検証済みの有効なUnicode文字列
}
```

この構造体をそのままJSON化して新しいwire形式にしない。識別子は診断出力に生の値を含めない。プロトコル実装は、room、peer、方向、seq、メッセージ種別、ID、本文の結び付きが第9章の暗号で認証されていることを確認してからイベントを渡す。

#### 14.13.3 暗号の互換要件

- 第9章の方式、鍵導出、IV、AAD、符号化、タグの扱いをそのまま実装する。付録Aの全値を再現する。
- 同じ鍵でIVを再利用しない。新しいroomでは鍵を導出し直し、カウンターを旧roomから引き継がない。
- データとACKの方向・種別を第9章どおりに認証する。
- 鍵情報を中継サーバーのAPI、URLのクエリ、ログへ追加送信しない。
- TLSに加えて第9章の端末間暗号化を行う。
- 復号・認証に失敗したメッセージはstdoutへ出力せず、ackも返さない。
- 未知のプロトコル版を推測して受理せず、不一致を明確に通知する。
- WebSocket自体のフレーム処理は既存の準拠ライブラリを用いる[S27]。WebSocket圧縮を利用せず、受信サイズの上限は再構成後のメッセージに適用する。

### 14.14 終了コード、エラー対応、シグナル

#### 14.14.1 終了コード

| コード | 意味 | stdoutの扱い |
| --- | --- | --- |
| `0` | 1件の出力成功、またはヘルプ・バージョンの正常表示 | 受信時は1レコード |
| `2` | 引数・設定・表示環境のエラー。接続先が公開originとして応答しない（3xx、404、`ORIGIN_DENIED`） | 起動検証で検出した場合は空 |
| `3` | 本文受付前の接続確立・回復に失敗 | 空 |
| `4` | TLS検証、版の不一致、認証、暗号、プロトコルの致命的エラー | 当該不正メッセージは出力しない |
| `5` | stdout等の必須出力先へのI/O失敗 | 部分出力が存在し得る |
| `6` | 選択形式による恒久拒否 | 空 |
| `70` | 内部実装エラー | 既存・部分出力が存在し得る |
| `124` | `--timeout`による受信待機期限切れ | 出力開始前なので空 |
| `130` | SIGINT / Ctrl+C | 中断時点までの出力が存在し得る |
| `143` | SIGTERM | 中断時点までの出力が存在し得る |

受信後のack配送の不確定だけを、出力成功済みのCLIの失敗終了へ変更しない。利用者が明示的に中断した場合は、出力済みであってもシグナルに対応する終了コードを用いる。

#### 14.14.2 エラーへの対応

新しいroomを作成して回復する処理は、本文受付前だけに適用する。書き込み中の切断は第14.9.4節、出力成功または恒久拒否の確定後の終了処理は第14.12節を優先する。

| 事象 | CLIの動作 | 回復できない場合の終了コード |
| --- | --- | --- |
| 引数・環境変数・`--server`の形式不正、表示環境の不足 | 通信前に終了 | 2 |
| HTTP 3xx、404、`ORIGIN_DENIED`（403） | 再試行しない。`--server`と公開originの不一致を案内 | 2 |
| DNS・TCP・タイムアウト・接続断、`RATE_LIMITED`（429）、`CAPACITY`・`SERVER_SHUTDOWN`（503）、その他の5xx・`SERVER_ERROR`、受信側認証時の`PAIR_UNAVAILABLE` | 回復予算内で新しいroomの作成を再試行 | 3 |
| TLS証明書・ホスト名の検証失敗 | 再試行しない | 4 |
| `VERSION_UNSUPPORTED`、subprotocolの不成立、応答schemaの不一致、`DUPLICATE_ROLE` | 再試行しない | 4 |
| `PAIR_EXPIRED`（未使用QRの失効） | 新しいroomを作成（`QR_REFRESHED`） | 3 |
| 候補の`AUTH_FAILED`・`PAIR_TIMEOUT`、`pair.candidate_closed` | 候補だけを閉じて待機を続ける | — |
| `READY_TIMEOUT`、`PEER_CLOSED`、`SLOW_PEER`、heartbeatの途絶 | 新しいroomを作成（`DISCONNECTED`） | 3 |
| `SESSION_EXPIRED` | 新しいroomを作成（`SESSION_EXPIRED`） | 3 |
| commit後の復号失敗・seq違反・同じidで異なる本文・不正な本文等のプロトコル違反、`PROTOCOL_ERROR`、`MESSAGE_TOO_LARGE`、復号待ち行列の超過 | roomを閉じる（`client_error`） | 4 |
| stdoutへの書き込み失敗 | ackを送らない | 5 |

#### 14.14.3 中断と出力エラー

SIGINT・SIGTERMでは新規受信を停止し、可能な範囲で`room.close`（`user_end`）を送ってセッションを閉じる。書き込み未完了の本文にackを返さない。中断のためにstdoutへ説明文を出さない。stderrでANSIを使っている場合は属性を戻す。後始末の後、シグナルの既定動作に戻して同じシグナルを自身へ送り直して終了することを推奨する。これにより呼び出し元のシェルはコード130・143を得るとともに、シェルのループ等もCtrl+Cで中断できる。送り直せない場合は130・143で終了する。

Goは、SIGPIPEを処理していないプログラムがfd 1・2の閉じたパイプへ書き込むと、そのプロセスを終了させる[S29]。CLIは起動時にSIGPIPEを無視するよう設定し（`signal.Ignore(syscall.SIGPIPE)`）、閉じたパイプへの書き込みをEPIPEのI/Oエラーとして回収して、コード5に統一する。実際のパイプを使った試験を行う。

stderrの出力に失敗した場合も、stdoutへ代わりにエラーを書かない。起動・接続案内ができない段階ではコード5で終了する。出力成功後に案内だけが書けなくなった場合は、成功したデータ出力を失敗へ変更しない。

診断はイベント名、エラー分類、公開サービスのホスト名等、必要最小限とする。第8.5節の項目をstderr、エラー本文、クラッシュ出力に含めない。外部解析、利用状況の送信、自動クラッシュレポート送信は初版に実装しない。

## 15. 中継サーバーの実装要件

中継サーバーは、Web受信ページ・送信ページ・CLIを区別せず、本章の規則で扱う。第15.1〜15.5節はNode版を前提に書いている。Cloudflare版は第15.6節の読み替えと追加要件に従い、それ以外は同じ規則を満たす。

### 15.1 メモリ内データ

`Map<roomId, Room>`に保持してよい情報を次に限定する。

- room状態、作成時点、QR・候補・ready・idleの期限。
- receiverCap・senderJoinCapの照合用ハッシュ。
- receiverとcandidate／senderのソケット参照、peerId。
- ハンドシェイクの段階、seqの形式・順序検査に必要なメタデータ。
- heartbeat、レート制限、送信バッファ制限に必要なカウンター。

PSK、方向別鍵、本文、本文ハッシュ、復号機能、転送履歴をサーバーへ実装しない。cipherはschema・サイズ・所属を検証し、相手のソケットへ即時に送る。後日の配信や再送のためにコピーを保持しない。

receiverが不在、対象peerが不一致、相手のソケットがOPEN以外の場合は中継しない。切断後に届いた遅延メッセージは新しいroomへ振り替えない。

### 15.2 バックプレッシャー

送信前に`target.bufferedAmount + encodedMessageBytes <= 65,536`を確認する。超過ならメッセージをためず`SLOW_PEER`としてroomを終了する。サーバー独自の再送キューは作らない。

クライアント（ブラウザ・CLI）も送信バッファの同じ上限を適用する。復号を直列化するための待ち行列は、`MAX_RECEIVE_QUEUE_MESSAGES`（8件）かつ合計65,536バイト以下とし、超過したら接続を終了する。上限は暗号文のバイト数で判定する。

WebSocketの内部送信バッファ、TCP/TLSバッファ、処理中の一時変数への短時間の滞留は認める。バッファが空になったことを受領確認の代わりにしない。[S14]

### 15.3 初期運用上限

以下は小規模公開向けの初期値であり、本文・暗号方式の互換性を変えずに配備設定で調整できる。IP単位の制限はNAT環境で複数利用者が共有するため、運用状況に応じて調整する。

IP単位のroom作成・認証失敗・同時WS数の制限では同じ正規化キーを使う。IPv4射影IPv6アドレスは表記にかかわらずIPv4へ正規化し、IPv6は既定で/64のプレフィックスごとに集約する。集約長は`IPV6_PREFIX_LENGTH`（1〜128）で変更でき、/56等の設定も可能とする。プロキシの信頼判定は集約前の実アドレスで行う。

| 対象 | 初期値 | 超過時 |
| --- | --- | --- |
| room総数 | 1,000 | 新規作成を503で拒否 |
| WS総数 | 2,200 | 新規接続を拒否 |
| 未認証WS総数 | 100 | 新規接続を拒否 |
| 同一IPの同時WS | 60 | 新規接続を拒否 |
| room作成、同一IP | 10回／分、burst 5 | 429、固定秒数のRetry-After |
| 認証失敗、同一IP | 20回／分 | 一時的に新規認証を拒否 |
| 同一roomのcandidate作成 | 10回／分 | 新しい候補を拒否。既存接続は維持 |
| 認証済みソケットのメッセージ数 | 20通／秒、burst 40 | 違反ソケット／roomを終了 |
| 認証済みソケットの受信量 | 256 KiB／秒、burst 512 KiB | 同上 |
| IP制限用Map | 最大4,096件、無活動60秒で削除 | 最終参照が最も古い項目からLRUで削除。無制限に保持しない |

CLIは未使用QRの失効ごとにroomを作り直すため、1台あたり1分に1回程度のroom作成が継続する。これは上記の制限内に収まる。

上限のためにcipherをディスクへ逃がす設計は禁止する。IPは接続元ソケットから取得し、信頼すると設定したプロキシからの転送ヘッダーだけを採用する。任意の`X-Forwarded-For`を信用しない。[S15]

### 15.4 削除・終了処理

`closeRoom()`は複数回呼ばれても安全な一つの関数に集約する。状態を先にCLOSEDへ変更してから、タイマー解除、参加権限破棄、対向への通知（第10.5節の対応表）、ソケット終了、Mapから削除を行う。

期限確認は定期掃除だけに任せない。auth、commit、pair.active、room.touch、cipherの各処理直前にも期限と状態を確認する。期限後に到着したtouchやproofで復活させない。

SIGTERM時は新規HTTP room作成とWS受付を止め、readyzを503にする。接続中には`SERVER_SHUTDOWN`をbest effortで通知し、全roomを閉じて5秒以内を目安にプロセスを終了する。再起動後の復元データは存在しない。

### 15.5 ログと観測

- 初期設定ではHTTPアクセスログとWSメッセージログを無効にする。
- 稼働開始、停止、固定エラーコード、集計した件数のみ記録してよい。
- req、res、WSメッセージ、Buffer、URL、認証ヘッダー、例外オブジェクト全体をloggerへ渡さない。
- JSON parse等の例外が入力の一部を含むことがあるため、生の`error.message`も自動記録しない。
- roomId、peerId、IPの永続的な利用者別履歴を初版では作らない。
- クラッシュダンプ・heap snapshot・本番のデバッグポートを既定で無効にする。
- 管理用の集計値を作る場合も、本文や接続一覧を含めず、外部解析サービスへ送らない。

### 15.6 Cloudflare Durable Objects版

本節は、第15.1〜15.5節の規則をCloudflare WorkersとDurable Objects（以下DO）の上で満たすための読み替えと追加要件である。クライアントから見たHTTP API、WSS、制御メッセージ、暗号方式、期限、エラーコード、close code、close reasonの対応は変更しない。プロトコル識別子は`qrtoss/1`、subprotocolは`qrtoss.v1`のままとする。

#### 15.6.1 DOを使う理由

Workersは、要求ごとに異なる実行インスタンス（isolate）や異なるデータセンターで処理されることがある。このため、Node版のようにプロセス内の`Map<roomId, Room>`でroomを管理すると、同じroomのreceiver・candidate・senderの接続が別のインスタンスに届き、ペアリングが成立しない。Workerのグローバル変数に置いたroom状態も、要求の間で共有される保証がない。

Cloudflare版は、1つのroomを1つのDOインスタンス（RoomDO）に対応させ、同じroomへの要求をすべてそのDOへ振り分ける。DOはIDごとに1つだけ存在し、1つのインスタンス内の処理は`await`の位置でだけ切り替わる。したがって、第11.3節のatomicなcommitは、確認と変更の間に`await`を挟まない同期処理としてRoomDO内で実装できる。複数クライアントのWebSocket接続を1か所で調整する用途にDOを使うことは、Cloudflareが推奨する構成である。[S37] [S38]

#### 15.6.2 構成要素

| 構成要素 | 数 | 役割 | 保持する状態 |
| --- | --- | --- | --- |
| Worker | 要求ごと | 全HTTP要求の入口、静的assetの配信、Origin検査、room作成、`/ws`の受付と最初の`auth`の検査、RoomDOへの振り分けと中継 | 処理中の一時変数と、WebSocket接続ごとの転送状態だけ |
| RoomDO | roomごとに1つ | 第11章の状態機械、capability照合、期限、候補、commit、cipherの中継、heartbeat、roomごとのレート制限、`closeRoom()` | 第15.1節のroom情報。インスタンスのメモリだけに置く |
| CapacityDO | 配備ごとに1つ（`idFromName("global")`） | room総数・接続数・同一IPの接続数とレートの管理（第15.6.7節） | 件数、リース期限、正規化したIPキーのカウンター、返却済みリースのIDと削除期限。メモリだけに置く |

RoomDOのIDは`env.ROOM.idFromName(roomId)`で導出する。room作成時は、受信側に近いWorkerが最初にRoomDOを呼ぶため、RoomDOは通常、受信側に近い地域に作られる。

#### 15.6.3 room作成

`POST /api/v1/rooms`は次の順で処理する。

1. Workerが、Origin、`Content-Type`、本文`{"v":1}`、本文サイズを第10.1節どおりに検査する。
2. WorkerがCapacityDOに対し、同一IPのroom作成レートの確認とroom枠の取得を一度に要求する。超過時はそれぞれ429（固定秒数の`Retry-After`）、503（`CAPACITY`）を返す。
3. Workerが`crypto.getRandomValues()`で`roomId`、`receiverCap`、`senderJoinCap`を生成し、両capabilityのSHA-256を計算する。
4. Workerが`idFromName(roomId)`のRoomDOの内部RPC `create`を呼び、`roomId`と両capabilityのハッシュだけを渡す。capability自体はRoomDOへ渡さない。
5. RoomDOは未初期化の場合に限り`CREATED`として初期化し、リースの更新を開始して、`serverTime`と`pairingExpiresAt`を返す。初期化済みの場合（roomIdの衝突。実際には起こらない想定）はエラーを返し、Workerは取得した枠を返却して503を返す。
6. Workerが第10.1節の形式でレスポンスを返す。

RoomDOの呼出しが失敗した場合は、取得したroom枠を返却し、503を返す。

#### 15.6.4 `/ws`の振り分け

roomIdは最初の`auth`メッセージの中にあり、upgrade要求のURLとヘッダーには含まれない（第10.3節）。Cloudflare版はこの形式を変えず、Workerがクライアント側のWebSocketを終端し、最初のメッセージを見て振り分け先のRoomDOを決める。roomIdをURLのパスやクエリへ移す方式は、クライアントの通信形式を変え、Cloudflareの要求ログにroomIdを残すため採用しない。

1. Workerが、メソッド`GET`、パス`/ws`、Upgrade要求であること、Originの完全一致、subprotocolが`qrtoss.v1`の1件だけであること（第10.3節）を検査する。満たさない要求はupgradeしない。Originの不一致は403、subprotocolの不一致は400（`VERSION_UNSUPPORTED`）とし、接続枠を取得しない。
2. WorkerがCapacityDOから未認証接続の枠と同一IPの接続枠を取得する（第15.6.7節）。取得できない場合はupgradeしない（503、または同一IPの上限超過では429）。同一IPの上限超過は、Node版では503（`CAPACITY`）、Cloudflare版では429（`RATE_LIMITED`、`Retry-After: 6`）となる。
3. Workerが`WebSocketPair`で接続を受け入れ、`Sec-WebSocket-Protocol: qrtoss.v1`を付けて101を返す。Cloudflareの現行compatibility dateではWebSocket圧縮が既定で有効なため、`no_web_socket_compression`フラグでpermessage-deflateを無効にする。このフラグは内部のWorker–RoomDO接続にも適用する。WorkerとRoomDOの101応答、および内部upgrade要求には`Sec-WebSocket-Extensions`を付けない。空の値も送らず、ランタイムによるヘッダーの除去には依存しない。拡張ヘッダーを手動で指定するコードは静的検査で禁止する。[S46]
4. Workerは、接続から`AUTH_TIMEOUT_SECONDS`以内の最初のメッセージが、テキストで、`MAX_CONTROL_MESSAGE_BYTES`以下で、共通の制御メッセージ検証関数で`auth`として妥当であることを確認する。時間切れ、`auth`以外、schema違反、バイナリは1008、過大なメッセージは1009で閉じ、RoomDOへ接続しない。
5. WorkerはCapacityDOに対し、そのIPが認証失敗の連続で一時拒否中でないことを確認する。拒否中なら第15.3節と同じ扱いで閉じる。
6. Workerは`idFromName(auth.room)`のRoomDOへ内部のWebSocket upgrade要求を送り（`stub.fetch()`）、得られたWebSocketを受け入れ、最初の`auth`メッセージをそのまま転送する。内部要求には第15.6.8節のクライアントIPを内部ヘッダーで付ける。
7. 以後、Workerは両方向のテキストメッセージを内容を解釈せずに転送する。転送前に`MAX_WS_MESSAGE_BYTES`の上限とバイナリの拒否を再確認し、第15.6.5節の累計送信量の上限を各方向に適用する。最初の`auth`もWorkerからRoomDOへの送信量に含める。超過するメッセージは転送せず、`error`（`SLOW_PEER`、`scope: "socket"`）を可能な範囲で送って両方の接続を1008で閉じる。RoomDOへのclose reasonには固定値`SLOW_PEER`だけを付ける。RoomDOはこの固定値と1008の組合せを共有モジュールの`SLOW_PEER`失敗として扱い、対向にも通知して終了する。クライアントが指定したclose reasonをこの内部通知へ転用しない。heartbeat（`hb.ping`）にWorkerは応答せず、RoomDOが応答する。
8. 片方の接続が閉じた、またはエラーになった場合、Workerはもう片方も閉じる。RoomDOから受けたclose codeはそのままクライアントへ伝える。送信できないcode（1005、1006）や、RoomDOへの接続が予期せず切れた場合は、クライアントへ1011を送る。クライアント側の切断は、RoomDOにとってNode版のソケット切断と同じ扱いになる。
9. Workerは、RoomDOから届いた最初のメッセージが`auth.ok`であれば、CapacityDOの未認証接続の枠を認証済みの枠へ切り替える。Workerがメッセージの内容を見るのはこの`type`の確認だけとする。接続の終了時には接続枠を返却する。

形式が正しく存在しないroomIdの`auth`は、未初期化のRoomDOに届く。RoomDOは第10.5節どおり`PAIR_UNAVAILABLE`を返して閉じ、CapacityDOへ認証失敗として記録する。未初期化のRoomDOは状態を作らず、そのまま破棄されてよい。

RoomDOはWorkerの内部呼出しからだけ到達でき、公開のルートを持たない。このため、RoomDOは内部ヘッダーのクライアントIPを信頼してよい。

#### 15.6.5 RoomDOの処理

- 第11章、第15.1節、第15.4節の規則をそのまま適用する。room状態はインスタンスのメモリだけに置く。
- 再接続は新しいroomで行う。同じroomへの復帰は実装しない（第4.5節）。RoomDOが閉じたroomのIDで再び`create`を受けることはない。閉じたroomへの`auth`は`PAIR_UNAVAILABLE`とする。
- 期限は`setTimeout`と、各処理の直前の期限確認（第15.4節）で管理する。DOのAlarm APIは使わない（Alarmの設定は永続ストレージへの書き込みを伴う）。
- Workersの`Date.now()`は、処理の途中でI/Oを待つまで進まない。期限の判定には各イベントの処理開始時の時刻を使う。Workersには単調時計がないため、第10.6節の内部期限もこの時刻で管理する。公開する`serverTime`と各`expiresAt`の形式は変えない。[S43]
- capabilityのハッシュ計算は`crypto.subtle.digest()`で非同期になる。ハッシュ計算と`await`は状態の確認より前に終え、状態の確認と変更の間に`await`を挟まない（第11.3節）。照合には長さを確認したうえで`crypto.subtle.timingSafeEqual()`を使う。
- CapacityDOへのリース更新や返却を待つ`await`を、状態遷移の確認と変更の間に置かない。CapacityDOへの通知は状態変更の後に行い、失敗しても進行中のroomを閉じない。
- WebSocketは標準のAPI（`accept()`）で受け入れる。WebSocket Hibernation API（`ctx.acceptWebSocket()`）は使わない。理由は次のとおり。
  1. 休止するとメモリ上のroom状態が失われ、復帰のために状態の永続化か`serializeAttachment()`による復元が必要になる。
  2. 全クライアントが15秒ごとに`id`付きの`hb.ping`を送り、サーバーは同じ`id`と`serverTime`で応答する。この応答は`setWebSocketAutoResponse()`の固定応答で代替できないため、休止できる時間が短い。
  3. 標準のAPIで受け入れたWebSocketが開いている間、DOはメモリから退去されない。Node版と同じタイマーとメモリ内状態を使える。

  代わりに、接続中はDOの実行時間（duration）が課金される。これは第15.6.7節の上限とレート制限で抑える。[S38] [S39]
- 将来Hibernation APIを採用する場合は、本節と第18.7節を改訂してから実装する。その場合も次を守る。`serializeAttachment()`に保持するのは、role、peerId、認証済みかどうか、ハンドシェイクの段階、期限、seqの検査に必要な値など、休止から復帰するための最小限の接続状態に限る。capability、capabilityのハッシュ以外の認証情報、PSK、鍵、本文、暗号文、本文ハッシュを入れない。room状態をDOのストレージへ書かない。復帰時に状態を矛盾なく復元できない場合は、roomを閉じて再ペアリングを求める。
- `CREATED`状態でreceiverがまだ接続していない間は、RoomDOがメモリから退去されることがある。その後に届いたreceiverの`auth`は`PAIR_UNAVAILABLE`となり、受信側はNode版の再起動時と同じく新しいroomを作り直す。
- 送信量の制限：WorkersのWebSocketは`bufferedAmount`を提供していない。相手が読み取りを止めても`hb.ping`を送り続けられるため、受信レートとheartbeatだけでは送信キューの増加を抑えられない。Cloudflare版では、次の累計送信量の上限を第15.2節の送信前検査の代わりに適用する。
  - ソケットの各送信方向の上限を、`MAX_TRANSFERS_PER_ROOM × MAX_WS_MESSAGE_BYTES + 1 MiB`（4,325,376バイト）とする。最大100件のdata envelopeと、ready・ack・ack_seen・activity・status・heartbeat・touch等の通信の余裕を持たせるための値であり、転送件数そのものをサーバーで判定するものではない。
  - Worker→RoomDO、RoomDO→Worker、Worker→クライアントのそれぞれで、送信する直前にテキスト全体のUTF-8バイト数を加算する。`cipher`に限らず、認証、制御通知、heartbeatの応答、終了通知も含める。Workerは入力の空白等も含む受信文字列をそのまま数え、RoomDOは共有モジュールが直列化した送信文字列を数える。
  - 通常の送信には上限から`2 × MAX_CONTROL_MESSAGE_BYTES`（4,096バイト）を引いた4,321,280バイトまでを使う。残りは`error`と`room.closed`の終了通知用とし、終了通知を含めた総量も4,325,376バイトを超えない。送信可否の確認と加算の間に`await`を置かない。
  - 超過するメッセージは送信しない。RoomDOではroomを`SLOW_PEER`として閉じ、両ソケットを1008で終了する。終了通知は予約した残量に収まる場合だけ送り、通知が届くことを終了条件にしない。Workerでの超過は第15.6.4節の終了処理に従う。
  - カウンターはソケットの接続から終了まで単調増加とし、時間経過、送信成功、heartbeat、touch、候補の交代で回復・初期化しない。正常な相手でも長時間の利用や多数の再送・操作で上限に達することがある。その場合も`SLOW_PEER`として新しいQRで接続し直す。

  この上限は、読み取りを止めた相手に対しても、各経路に投入するペイロードの累計を有限にする。未送信量や配送完了を測る機能ではなく、WebSocketの実装内部のキュー上限や、heartbeatが読み取り停止を検出することには依存しない。同時接続全体の資源制限には第15.6.7節も引き続き適用する。第15.3節の受信レート制限、第10.6節のheartbeat、サーバー独自の再送キューを作らない規則も維持する。Node版は第15.2節の`bufferedAmount`による検査を使う。
- 停止処理：Cloudflare版にはSIGTERMに相当する通知がない。新版の配備、DOの再起動、障害によりRoomDOが終了した場合、`SERVER_SHUTDOWN`を送れないことがある。クライアントは切断またはheartbeatの途絶でこれを検出し、新しいQRで接続し直す（第10.6節）。
- ログ：第15.5節に従う。`console`へ出力してよいのは固定のイベント名とエラーコードだけとする。

#### 15.6.6 非保存の確認

DOは永続ストレージを持つ仕組みだが、Cloudflare版は第8.3節の非保存を次の方法で守る。

- RoomDOとCapacityDOは、ストレージAPI（`ctx.storage`のKey-Value APIとSQL API）、Alarm API、`serializeAttachment()`を使わない。本文、暗号文、capability、capabilityのハッシュ、roomId、peerId、IPアドレスをどこにも永続化しない。
- Workers KV、D1、R2、Queues、Cache API、Analytics Engine、Hyperdriveのbindingを配備設定に含めない。
- Cloudflareの設定でデータベースを作らないことと、実装の内部でデータを永続化しないことは別の条件である。新しいDOクラスは、wranglerの`migrations`で`new_sqlite_classes`として宣言する（SQLiteをストレージに使うDO）。この宣言により各DOにSQLiteの記憶域を割り当てられるが、コードから書き込まなければ内容は空のままである。次の3点で確認する。
  1. ソースコードに、ストレージAPI、Alarm API、`serializeAttachment()`の参照がないことを静的検査で確認する（CIで実行）。
  2. ローカル実行（`wrangler dev`のworkerd）で一連の転送を行った後、ローカルの永続化ディレクトリにDOのデータが作られていないこと、または空であることを確認する。
  3. 本番配備の後、CloudflareのダッシュボードまたはAPIで、DOのストレージ使用量とストレージ操作数が0であることを確認する。
- TLSはCloudflareが終端する。Cloudflareは、Workers・DOの運用者として、接続元IP、時刻、暗号文長、通信量を観測できる。本文は端末間で暗号化されているため、Cloudflareも復号できない。ただし配信するHTML・JavaScriptもCloudflareを経由するため、第8.2節の「配信元」にはCloudflareを含める。この点を公開する非保存方針に記載する。

#### 15.6.7 上限とレート制限

Node版のプロセス内カウンターは、Workers・DOの間では共有できない。Cloudflare版は第15.3節の各上限を次のように実現する。初期値は第15.3節と同じとする。

| 対象 | 実現方法 |
| --- | --- |
| room総数（`MAX_ROOMS`） | CapacityDOがroomごとのリースを持つ。room作成時に取得し、RoomDOが状態が`CLOSED`になるまで60秒ごとに更新し、`closeRoom()`で返却する。リースの期限は120秒とし、更新されなかったものは数えない。超過時は503（`CAPACITY`） |
| WS総数、未認証WS総数、同一IPの同時WS（`MAX_SOCKETS`、`MAX_UNAUTHENTICATED_SOCKETS`、`MAX_SOCKETS_PER_IP`） | CapacityDOが接続ごとのリースを持つ。Workerが接続受付時に取得し、接続中は60秒ごとに更新し、終了時に返却する。リースの期限は120秒 |
| room作成のレート、認証失敗のレート（同一IP） | CapacityDOが第15.3節と同じトークンバケット、同じ正規化キー、同じLRU上限（4,096件、無活動60秒で削除）で管理する |
| 同一roomのcandidate作成、ソケットごとのメッセージ数・受信量 | RoomDOが第15.3節どおりに管理する |

- 更新の要求で対象のリースが見つからない場合、返却済みとして記録されているIDを除き、CapacityDOは上限にかかわらず登録し直す。CapacityDOだけが再起動した場合、件数と返却記録はメモリから失われるが、既存のroomと接続は閉じず、次の更新（最大60秒後）で件数が回復する。
- 返却時は対象のリースを直ちに削除し、返却済みIDと、返却から120秒後の削除期限をメモリに記録する。存在しないリースの返却も記録し、再起動後の再登録より先に返却が届いた場合にも対応する。roomとソケットの返却記録は別々に管理し、記録中のIDへの更新を無視する。同じIDの取得要求も503（`CAPACITY`）で拒否する。room・ソケットのIDは新しく生成し、返却後に再利用しない。
- 返却記録はroom数・WS数・未認証WS数・同一IPの接続数に数えず、IP・capability・本文・暗号文を含めない。保持中の記録への遅延更新や重複返却で削除期限を延ばさない。期限切れの記録は次の受付・更新・返却・掃除・統計参照で削除する。返却記録も永続化・ログ出力しない。
- 新しいroomや接続の受付でCapacityDOを呼べない、または応答がない場合は、受付を拒否する（503）。既存のroomと接続は閉じない。
- CapacityDOは配備に1つであり、全リクエストの上限判定がここを通る。小規模公開ではこれで足りる。1つのDOが処理できる量には上限があるため、処理量が問題になった場合の分割は将来対応とする。[S42]
- Cloudflareの機能（WAFのレート制限ルール等）を追加の防御として使ってよい。ただし、その機能がCLIの通信を妨げないようにする（第16.10.3節）。

#### 15.6.8 クライアントIP

WorkerはクライアントのIPを`CF-Connecting-IP`ヘッダーから得て、第15.3節の規則で正規化する。Cloudflare版は`TRUST_PROXY_CIDRS`と`X-Forwarded-For`を使わない。Workerは、RoomDOへの内部要求とCapacityDOへの呼出しに、このIPを渡す。IPは制限の判定に使うメモリ内の値だけに用い、ログへ出力しない。[S44]

#### 15.6.9 Node版との実装の共有

第11章と第15.1〜15.4節のroom処理（状態機械、制御メッセージの検証、期限、候補、commit、cipherの中継、レート制限、`closeRoom()`）を、実行環境に依存しないモジュールに分離する。Node版とRoomDOはこのモジュールを共有する。環境に依存する部分（ソケットへの送信と切断、タイマー、時刻、乱数、ハッシュ、HTTP、上限管理）は、それぞれのアダプターで実装する。Cloudflare版だけのroom状態遷移を別に実装してはならない。

共有モジュールは`node:*`モジュールと`ws`に依存しない。ハッシュと定時間比較は非同期のインターフェースで受け取り、第15.6.5節の`await`の位置の規則をNode版にも同じく適用する。

## 16. 自己ホスト・配布・公開構成

### 16.1 必要な実行環境

第16.1〜16.3節はNode版の配備を対象とする。Cloudflare版の配備は第16.10節で定める。第16.4節以降はCloudflare版にも適用する。

- 有効なHTTPS証明書を使用できるドメイン。
- Node.js LTS（26 LTSを推奨）の単一プロセス、またはそれを含むコンテナ。
- WSS upgradeを通すHTTPSリバースプロキシ。参照配備はDocker ComposeとCaddyを使用する。
- 初期の配置目安は1 vCPU、512 MiB RAM以上。接続可能数は実際の負荷試験で確認し、この目安を性能保証として使わない。
- DB、Redis、STUN、TURN、クラウドのメッセージ保管機能は不要。

開発用localhostの扱いと、スマホからアクセスするLAN内HTTPは区別する。実機カメラ試験はスマホが信頼するHTTPSで行う。HTTPのLAN IPを本番相当のカメラ動作条件としない。CLIはHTTPSを必須とするため、CLIを含む試験もHTTPSで行う。[S05]

### 16.2 環境変数の契約

| 変数 | 必須／既定 | 内容 |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | 必須 | 例`https://qrtoss.example`。パス・クエリ・fragment・認証情報を含まないorigin。長さは第9.2.1節の推奨に従う |
| `HOST` | `0.0.0.0` | コンテナ内の待受アドレス。直接インターネット公開しない |
| `PORT` | `8080` | バックエンドの内部HTTPポート |
| `NODE_ENV` | `production` | 本番ビルドを使用 |
| `MAX_ROOMS` | `1000` | 同時room上限 |
| `MAX_SOCKETS` | `2200` | WS総数上限 |
| `MAX_UNAUTHENTICATED_SOCKETS` | `100` | 未認証WS上限 |
| `MAX_SOCKETS_PER_IP` | `60` | IPごとの上限 |
| `TRUST_PROXY_CIDRS` | 空 | 信頼する直前プロキシのCIDRだけを列挙 |
| `LOG_LEVEL` | `warn` | 非機密の固定イベントだけを対象とする |

`PUBLIC_ORIGIN`が不正な場合は起動に失敗させる。Hostヘッダーから接続用URLを無条件に生成しない。HTTPを許す開発用設定はloopback限定とし、本番モードではHTTPS originを必須とする。

第4.1節の暗号・サイズ・タイムアウト値は`protocol/`の共通定義として管理し、初版では個別の環境変数で片側だけ変更しない。運用制限を調整する変数は`.env.example`と自己ホスト手順へすべて記載する。

### 16.3 Compose・プロキシの要件

ブラウザ版のサブパス配備では、`QRTOSS_BASE_PATH=/qrtoss/ npm run build` のようにビルド時に配置先を指定し、プロキシでその接頭辞を取り除く。設定値は先頭・末尾が `/` のパスに制限し、各セグメントの文字はASCII英数字と `._~-` だけを許可する。空セグメント、`.`、`..`、外部URL、クエリ、フラグメント、percent-encodingを拒否する。設定は配信アセットへ埋め込まれるため、起動時に変更しても配置先は切り替わらない。Apacheの設定例は[運用手順](self-hosting.md#browser-deployment-under-an-apache-subpath)を参照する。同梱のCompose/Caddy構成は引き続きルートパス配備とする。

実装時に`Dockerfile`、`compose.yaml`、`deploy/Caddyfile`、`.env.example`を同梱し、次の条件を満たす。

1. appとproxyを内部ネットワークで接続し、外部へ公開するのはproxyの80/443だけとする。
2. appは非root、read-only filesystem、不要なLinux capabilityなしで実行する。
3. appへ永続volumeを付けない。TLS証明書のためのproxy volumeは転送データとは別であり、許容する。
4. `/ws`のupgradeを通し、通常のheartbeatより短いプロキシ切断設定を避ける。参照構成では無通信の接続を最低90秒保持できるようにする。
5. appは1プロセス・replica 1とする。共有状態なしにNode clusterや複数コンテナへ増やさない。
6. proxyは外部から来た転送元ヘッダーを適切に上書きし、appは設定済みproxyからのものだけを信用する。
7. proxy、監視、ホスティング側のrequest body保存・WS payload capture・外部エラー収集を無効にする。
8. 本文・暗号文のディスク残留を防ぐため、ホストのswap・core dump・メモリスナップショットの運用を確認する。初期手順ではswapとcore dumpを無効にする。暗号化swapを代替とする場合も「一切の永続書込みなし」と同一の保証として扱わない。
9. アップグレードは新しい固定イメージを配備し、稼働中セッションが終了することを運用手順に記載する。

### 16.4 レスポンスヘッダー

公開originが`https://qrtoss.example`の場合の基本方針を示す。`connect-src`のoriginは配備時に生成する。

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' wss://qrtoss.example; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=()
Cross-Origin-Opener-Policy: same-origin
```

HTMLにinline script、イベントハンドラー属性、`eval()`を使用しない。Workerの`blob:`は同梱ライブラリがローカルに生成するWorkerを許容するものであり、外部scriptの読込みを許可するものではない。実際の本番bundleでネイティブQR検出とWorker経路の両方を検証する。WASM版の読取エンジンへ置き換える場合は、第3.2節のとおり`'wasm-unsafe-eval'`の追加とその影響を記録する。[S03] [S21]

HSTSはHTTPS運用を確認した配備先で設定する。初期値は`max-age=31536000`とし、管理していないサブドメインへの`includeSubDomains`やpreloadを一律に要求しない。

### 16.5 依存関係と配信するコード

- QR生成・読取、Worker、CSS、翻訳辞書、アイコンをビルド成果物に含める。
- 実行時にCDN、Google Fonts等の外部フォント、広告、解析、翻訳、外部エラー報告へ接続しない。
- 暗号処理は標準Web Crypto APIとGo標準ライブラリを利用する。第三者の暗号ライブラリを追加する必要はない。ラッパーとプロトコル実装は本リポジトリで管理する。ブラウザ自身の暗号実装はブラウザの信頼境界に含まれる。
- 本番用の直接依存は正確なバージョンで宣言し、間接依存までlockfile・`go.sum`へ固定する。コンテナのbase imageと公開imageはdigestで固定する。
- 依存更新は差分、ライセンス、既知の脆弱性、生成bundleの外部通信を確認してから取り込む。
- 本番asset一覧・SHA-256・ソースcommit・ビルド手順をrelease manifestに記録する。
- フォントはシステムフォントを使い、不要な実行時ダウンロードを避ける。
- Service Workerは初版では登録しない。古いコードや本文を独自のオフラインキャッシュに保持しない。

自己ホストの受け入れは「新しい環境で同梱手順どおり起動でき、承認済み転送内容に対する第6・12章の遷移（自動を含む）と利用者の外部リンク操作を除き、当該origin以外へ自動通信しないこと」で判定する。これは第三者の実行コードや解析等への通信を除く条件であり、仕様どおりの受信URLへの移動を禁止する条件ではない。

### 16.6 公開時のファイルと方針

プロジェクトのライセンスは**MIT License**（SPDX識別子: `MIT`）とする。Web・中継サーバー・CLIの自作コード、および本仕様書を含むドキュメント・設定例に適用し、ライセンス全文と著作権表示はリポジトリルートの[`LICENSE.md`](../LICENSE.md)に記載する。

商用利用、改変、再配布、非公開の改変版の利用を認め、改変部分のソース公開は要求しない。ソフトウェアの複製または実質的な部分を配布する場合は、MITの著作権表示と許諾文を保持する。ソース、Web配信物、CLIバイナリ、コンテナイメージの各配布物に、ライセンス全文を含める。無保証・責任制限を含む正確な条件は`LICENSE.md`を正とする。

第三者のコード・依存ライブラリは、それぞれのライセンスに従う。第三者のLICENSE・著作権表示は削除せず、各ライセンスで必要な表示・全文を配布物へ含め、`THIRD_PARTY_NOTICES`に整理する。採用バージョンのライセンスは実装時と依存更新時に確認する。[S02] [S03] [S04]

公開物にはREADME（日英西）、自己ホスト、暗号プロトコル、脅威モデル、非保存方針、CLIの利用・配布・検証手順、SECURITY、CONTRIBUTING、第三者通知、lockfile、テスト、配備例を含める。SECURITYの連絡先は公開者の実在する窓口を設定し、架空のアドレスを残さない。

ソース公開とサービス配信コードの一致を確認できるよう、サービスにversionとsource commitを表示する。公開リポジトリを閲覧しただけで、現在配信されているJavaScriptや配布バイナリの同一性が自動保証されるとは説明しない。

### 16.7 CLIの配布

バージョンを固定したOS・CPU別の単体バイナリ（darwin/arm64、darwin/amd64、linux/arm64、linux/amd64）を配布する。macOS向けにHomebrew tapを用意し、Linux向けにはリリースアセットから取得できるようにする。通常起動時は更新確認と自動更新を行わない。更新はパッケージマネージャーまたは利用者の明示操作で行う。

リリースに含めるもの：

- OS・CPU別の実行ファイル（ランチャーが取得する非圧縮のバイナリを含む）
- SHA-256チェックサム一覧
- 配布物の署名、検証手順、信頼する公開鍵の案内
- 対応するソースタグ・コミット、対応プロトコル版（`qrtoss/1`）
- 使用したGo版、対象OSの最低条件、依存モジュールの版とライセンス情報

ビルドは`CGO_ENABLED=0`、`-trimpath`、固定したGoツールチェーンで行い、同じ入力から同じバイナリを再現できるようにする。darwin/arm64のバイナリにはGoのリンカーがアドホック署名を付ける。ブラウザでダウンロードしたファイルにはquarantine属性が付き、Gatekeeperの確認が表示される。Developer ID署名・公証を行うかどうかと、行わない場合の手順をリリース文書に明記する。

### 16.8 試用ランチャー

#### 16.8.1 提供形式

正式な公開originと版の確定後、次の形式を提供する。URLと版は例示である。

```sh
curl --proto '=https' --proto-redir '=https' -fsSL https://qrtoss.example/cli/v0.1.0/run.sh | sh
```

CLIへの引数は、次の形式で渡せるものとする。

```sh
curl --proto '=https' --proto-redir '=https' -fsSL https://qrtoss.example/cli/v0.1.0/run.sh | sh -s -- --timeout 120
```

ランチャー（`run.sh`）と配布物は、リバースプロキシの静的配信またはソースホスティングのリリース機能から配信する。中継サーバー本体のHTTPルートと自己ホストの必須構成には含めない。

ランチャーは公開された特定版を取得する。`run.sh`の版と実行するCLI版を一致させ、実行時に別の最新版へ勝手に切り替えない。

`curl | sh`はHTTPS配信元から得たスクリプト自体を信頼して実行する経路である。同じスクリプト内のチェックサム照合や署名検証だけを根拠に、スクリプト配信元の侵害にも安全であると説明しない。また、curlの取得失敗とパイプ全体の終了状態は同じものではない。正式な自動化用途では導入済みCLIの直接実行を基本とし、ランチャーを使う場合は**取得成功を確認してから保存済みスクリプトを実行する**手順も配布文書に載せる。

#### 16.8.2 処理

1. 起動全体を関数として定義し、必要な定義が完了した後に1回呼び出す構成にする。先頭の途中断片だけで本体起動へ進まない。
2. 引数、OS（`uname -s`）、CPU、必要コマンドを確認する。macOSではRosetta下のシェルで`uname -m`が`x86_64`を返すため、`sysctl -n hw.optional.arm64`が`1`ならarm64を選ぶ。
3. キャッシュルート（macOS：`~/Library/Caches/qrtoss`、Linux：`${XDG_CACHE_HOME:-~/.cache}/qrtoss`）を、利用者だけがアクセスできる権限で用意する。既存の場合は、ディレクトリであること、シンボリックリンクでないこと、利用者が所有し他者が書き込めないことを確認する。版・OS・CPU別に分ける。
4. キャッシュに実行ファイルがあれば、`run.sh`に埋め込んだ期待SHA-256と照合し、一致したものだけを使う。
5. ない場合は、キャッシュルート内に予測困難な名前の一時ディレクトリ（`mktemp -d`）を作る。最終配置先と同じファイルシステムに置くことで、後の`mv`を原子的なrenameにする。
6. 指定版のバイナリをHTTPSで最後まで取得する。接続上限15秒、取得全体の上限120秒（`--connect-timeout 15 --max-time 120`）とし、無制限に再試行しない。
7. 取得コマンドの終了状態と、`run.sh`に埋め込んだ期待SHA-256を検証する。SHA-256の計算には`sha256sum`、`shasum -a 256`、`openssl dgst -sha256`のうち最初に利用できるものを使う。
8. 実行権限を付け、版別キャッシュへ`mv`で原子的に配置する。同時起動で配置が競合した場合は、配置済みのファイルを再度照合して使う。
9. 取得用の一時領域を削除する。
10. `exec`でCLI本体に置き換わり、CLIの終了状態を呼び出し元へ伝える。

`run.sh`はリリース時にテンプレートから生成し、その版の各OS・CPU向けバイナリのSHA-256を埋め込む。チェックサム一覧を実行時に別途取得・解析しない。

`exec`成功後にシェルの終了トラップが一時領域を片付けることに依存しない（`exec`の前に片付ける）。取得失敗、検証失敗、起動前のSIGINT/SIGTERMでは、ランチャー自身が作った一時領域を削除する。SIGKILL、OS停止、電源断では削除できない場合があるため、残り得る一時領域にも接続秘密や本文を置かない。

#### 16.8.3 追加条件

- `sudo`、シェル設定ファイルの変更、PATHの自動変更を要求しない。
- stdinを対話入力として読まない。`curl | sh`ではstdinがスクリプトを送るパイプであり、CLI本体もstdinを読まない。ダウンロード等の子プロセスにもstdinの読み取りを要求しない。
- CLIへ渡す引数の境界を保つ（`"$@"`）。シェルの`eval`や文字列の再評価を使わない。
- 取得したファイルを`source`等でコードとして実行しない。
- HTTPへの降格を許さない。curlのプロトコルとリダイレクト先をHTTPSに制限する。[S28]
- 取得・検証・キャッシュの案内は全てstderrへ出す。
- キャッシュに鍵、接続URL、本文、履歴を保存しない。
- チェックサム照合と発行者の署名検証を区別する。署名検証は、利用者が事前に信頼した公開鍵と検証ツールを持つ経路（手動検証手順、パッケージマネージャー）で行う。同じ配信元から得た公開鍵や検証プログラムによる照合を、独立した信頼の根拠として扱わない。

### 16.9 ランチャーの終了コード

| コード | 意味 |
| --- | --- |
| `80` | CLIバイナリの取得失敗 |
| `81` | チェックサム・署名等の検証失敗 |
| `82` | 一時領域・キャッシュの作成、配置、起動準備の失敗 |
| `126` | 未対応のOS・CPU、または最終execで実行できない |
| `127` | 必要な取得・検証コマンドがない、または最終execで実行ファイルを見つけられない |

ランチャー自身の引数不正は2、中断は130または143とする。最終exec自体に失敗した場合はPOSIXシェルの終了状態に従い、82へ一律に変更しようとしない。本体に置き換わった後は本体のコードをそのまま返す。外側のcurlやシェルがランチャーを開始できなかった場合の終了状態は、この独自コード表の対象外である。

### 16.10 Cloudflare版の配備

#### 16.10.1 必要なもの

- Cloudflareのアカウント。公開originはCloudflareで管理するカスタムドメイン（例：`https://qrtoss.example`）、または`https://<Worker名>.<アカウントのsubdomain>.workers.dev`から1つを選ぶ。`workers.dev`を選ぶ場合、独自ドメインは不要とする。[S47]
- Durable Objectsを使えるWorkersのプラン。無料枠の上限に達すると受付が止まるため、公開運用では有料プランを推奨する。採用するプランの上限と料金は実装時に確認する。[S41]
- `wrangler`。リポジトリのdevDependencyとして正確な版を固定する。
- DB、KV、R2、Redis、STUN、TURNは不要とする。

#### 16.10.2 設定ファイル

Cloudflare版の設定ファイル（`wrangler.jsonc`）は次を満たす。

| 設定 | 値・条件 |
| --- | --- |
| `compatibility_date` | 固定した日付。更新は依存更新と同じ手順で確認してから行う |
| `compatibility_flags` | `["no_web_socket_compression"]`。WebSocket圧縮を明示的に無効化し、本節の条件を変える他のフラグを設定しない[S46] |
| `routes` | カスタムドメインでは公開originのホスト名を`custom_domain: true`で1つだけ指定する。`workers.dev`では省略するか空配列とする。ルートパス配備だけとする |
| `workers_dev` | カスタムドメインでは`false`、`workers.dev`では`true`とする。両方の公開先を同時に有効にしない[S47] |
| `preview_urls` | どちらの配備先でも明示的に`false`。Version URL・alias URLで公開しない[S48] |
| `assets` | ビルド済みのWeb配信物のディレクトリ、`binding: "ASSETS"`、`run_worker_first: true`、`not_found_handling: "none"`[S40] |
| `durable_objects.bindings` | `ROOM`（RoomDO）と`CAPACITY`（CapacityDO） |
| `migrations` | 両クラスを`new_sqlite_classes`で宣言する。ストレージは使わない（第15.6.6節） |
| `vars` | `PUBLIC_ORIGIN`、`MAX_ROOMS`、`MAX_SOCKETS`、`MAX_UNAUTHENTICATED_SOCKETS`、`MAX_SOCKETS_PER_IP`、`IPV6_PREFIX_LENGTH`、`LOG_LEVEL`。意味と既定値は第16.2節と同じ |
| `observability` | `enabled: false`（Workers Logsを無効にする） |
| `tail_consumers`、Logpush | 設定しない |
| 上記以外のbinding | 設定しない（第15.6.6節） |

`PUBLIC_ORIGIN`はポート・パス・末尾の`/`を含まないHTTPS originとする。`workers.dev`では先頭のホスト名ラベルを`name`の小文字表記と一致させる。Worker名は63文字以内の英数字・ハイフンとし、先頭・末尾のハイフンを認めない。[S47] `check:cloudflare`は、配備先と`routes`・`workers_dev`・`PUBLIC_ORIGIN`の不一致を配備前に拒否する。

Workerは、`PUBLIC_ORIGIN`が第16.2節の条件を満たさない場合、全要求に固定のエラーコードで500を返す。要求URLのoriginが`PUBLIC_ORIGIN`と一致しない場合は404を返す。Hostヘッダーから接続用URLを生成しない点はNode版と同じである。

#### 16.10.3 レスポンスヘッダーとゾーンの設定

- `run_worker_first: true`により全要求をWorkerで受け、静的assetも`ASSETS` bindingから取得した後にWorkerがヘッダーを付ける。第16.4節のヘッダーと、第10.1節の`Cache-Control`をNode版と同じ共通モジュールで付ける。`_headers`ファイルは使わない。
- `/`と`/send`はビルド済みの該当HTMLへ明示的に対応付ける。存在しないパスは404とし、SPA向けの代替HTMLを返さない。
- カスタムドメインでは、ゾーンの機能が配信内容を書き換えたりスクリプトを挿入したりしないよう、公開originで次を無効にする：Rocket Loader、Email Address Obfuscation、Cloudflare Web Analyticsの自動挿入、Zaraz、その他HTMLを書き換える機能。これらは第16.4節のCSPと第2.1節のR18に反する。
- カスタムドメインでは、Bot対策のチャレンジ（JavaScriptチャレンジ、Managed Challenge等）を`/api/v1/rooms`と`/ws`に適用しない。CLIはチャレンジを処理できない。
- `workers.dev`にはCloudflareの共有ゾーンのBrowser Integrity Checkが適用され、利用者のゾーン設定では無効にできない。ライブラリ既定のUser-AgentによってはWorker実行前に1010で拒否されるため、CLIは第10.2節のアプリ名と版を送る。[S47] エッジでのCLI・ブラウザ接続と配信内容は検証用配備で確認する。
- HSTSは第16.4節の方針どおりとし、WorkerのヘッダーかCloudflareの設定のどちらか一方で付ける。

#### 16.10.4 ログと観測

- Workers Logs、Logpush、Tail Workerを常時有効にしない。`wrangler tail`は障害調査時に短時間だけ使い、そのときも本文やcapabilityがログに出ないこと（第15.5節）を前提とする。[S45]
- Cloudflareのゾーンの分析・セキュリティイベントは、接続元IP、パス、User-Agent等を自動で記録する。接続用URLの秘密はfragmentにあり、要求のURLに含まれないため（第9.2節）、これらに本文や鍵は含まれない。この記録の存在を公開する非保存方針に記載する。

#### 16.10.5 更新

- `wrangler deploy`で新版へ一括で切り替える。WorkerとDOが新版で再起動し、接続中の全roomが終了する（第3.3節）。運用手順にこのことを記載する。
- Worker・RoomDO・CapacityDOの間の内部呼出しは、版の間の互換性を保証しない。このため、段階的デプロイ（gradual deployments）で新旧の版を並行して動かさない。
- DOクラスの名前を変える、または削除する場合は、wranglerの`migrations`で宣言する。ストレージを使っていないため、移行するデータはない。

## 17. リポジトリとモジュールの分担

### 17.1 構成

ルートのnpm packageと`cli/`のGo moduleを含む一つのリポジトリで管理する。npmの依存関係・コマンドはルートの`package.json`にまとめ、Web・Node版・Cloudflare版・共有モジュールを同じpackageから扱う。以下は現在の実装のパスと責務である。

| パス | 主な責務 |
| --- | --- |
| `package.json`、`package-lock.json` | npmの固定依存と、開発・生成・検査・試験・ビルド・配備のコマンド |
| `web/` | Vite設定、受信・送信ページのHTML、Webのソース |
| `web/src/receiver.ts`、`web/src/sender.ts` | 受信画面・送信画面の状態、利用者操作、表示・送信・遷移、ページの表示・離脱イベント |
| `web/src/session.ts` | ペアリング、WebSocket、状態遷移、ACK、期限 |
| `web/src/scanner.ts` | QR読取アダプター（qr-scanner）、カメラ、Worker、停止処理 |
| `web/src/content.ts` | 本文の分類、URIの検証、遷移可否の判定 |
| `web/src/view.ts`、`web/src/style.css` | 共通の画面構造・描画補助とCSS |
| `web/src/i18n.ts` | Web UIのja/en/es辞書と言語選択 |
| `web/src/paths.ts` | ベースパスの検証とHTTP・WSS・画面URLの組み立て |
| `server/src/` | Node版：HTTP、WSS、静的配信、IP取得、共有room処理へのアダプター |
| `server/cloudflare/src/` | Cloudflare版：Worker、RoomDO、CapacityDO、内部WS中継、実行環境へのアダプター |
| `wrangler.jsonc` | Cloudflare版のエントリーポイント、互換性設定、DO・asset binding、公開origin・ルート、運用上限 |
| `packages/relay-core/src/` | 共有のroom状態機械、認証、期限、即時中継、HTTP・IP・容量・リース・送信量の制限 |
| `packages/protocol/src/` | TSの共有型・実行時schema・正規base64url、HKDF・proof・envelope・方向別seq、生成した定数・検証定義 |
| `protocol/` | 言語非依存の定義（`constants.json`、`error-codes.json`、close reasonの対応）とテストベクトル（`vectors/`） |
| `cli/` | Go module（`go.mod`、`go.sum`） |
| `cli/cmd/qrtoss/` | エントリーポイント、終了コード、シグナル |
| `cli/internal/client/` | 引数・環境変数・公開originの検証、HTTP・WSS、暗号・制御検証、受信状態型、ACK、期限、重複判定、1件受信後の終了 |
| `cli/internal/client/output.go` | text/JSON Linesの検証・符号化、直列書き込み |
| `cli/internal/client/terminal.go` | stderrのTTY・寸法判定、QR描画、英語の案内・診断 |
| `cli/internal/constants/` | 生成したGoの共通定数・エラーコードと`go generate`の入口 |
| `scripts/run.sh.in` | 版固定の試用ランチャーのテンプレート |
| `scripts/release-cli.sh`、`scripts/release-launcher.mjs` | CLIのクロスビルド、配布物・ランチャー・Homebrew formulaの生成 |
| `scripts/generate-protocol.mjs`、`scripts/control-schema.mjs` | 共通定義からTS・Goの定数・制御検証定義を生成 |
| `scripts/` | 開発サーバー、Cloudflareコマンド・静的検査、辞書・ライセンス等の検査・生成補助 |
| `tests/protocol/` | TSの暗号・制御メッセージと共通テストベクトルの検証 |
| `tests/core/` | 共有の認証競合、送信量・容量・リース・IP制限の単体試験 |
| `tests/web/` | 分類、言語、ベースパス、制御通知schemaの単体試験 |
| `tests/relay/` | 実際のrelayを使う認証・中継・期限・制限・障害試験。共通試験は両版で実行 |
| `tests/cloudflare/` | ローカルworkerdのfixture、試験専用エントリーポイントと制御RPC、Cloudflare固有の統合試験 |
| `tests/e2e/` | ブラウザ2コンテキスト、カメラfixture、UI試験 |
| `tests/interop/` | TSの送信peer・relay・実Go CLIを組み合わせた相互運用試験 |
| `tests/helpers/` | 中継アダプターの切り替え、生のHTTP upgrade要求の共通ヘルパー |
| `deploy/` | プロキシ設定、自己ホスト補助設定 |
| `docs/` | 本仕様、脅威モデル、運用、リリース手順、CLIの利用・配布説明 |
| `.github/workflows/ci.yml` | 生成差分・型・整形・静的検査・試験・ビルド・脆弱性検査のCI |
| `Dockerfile`、`compose.yaml`、`.env.example` | 再現可能な配備 |
| `LICENSE.md`、`THIRD_PARTY_NOTICES` | MIT Licenseの全文・著作権表示、および第三者コードの公開・再配布の条件 |

配置を変更する場合はこの表も更新し、`protocol/`を正とする共通定義の仕組みを維持する。試験用の固定値は`protocol/vectors/`と各試験のソースで管理し、QR画像は試験時に生成する。実利用データをfixtureへ含めない。

### 17.2 共通定義の管理

TypeScriptの`packages/protocol`はGoから参照できないため、言語非依存の`protocol/`を正とする。

- `protocol/`に、第4.1節の定数、第13章のエラーコード、第10.5節のclose reasonとcodeの対応、制御メッセージschema（`control-messages.json`）、付録Aのテストベクトル（暗号・CLI出力）と制御検証ベクトル（`vectors/control.json`）を置く。
- TSとGoの定数、および制御メッセージの型・検証定義は生成スクリプトで作成してコミットする（`npm run gen:protocol`、`go generate ./...`）。CIで再生成し、差分がないことを確認する。
- `control-messages.json`は全フィールド必須・追加フィールド禁止を前提に、制御メッセージごとの宛先（`server`・`receiver`・`sender`）とフィールド型を定義する。フィールド型の語彙は正規base64url（バイト長指定）、範囲付き整数、列挙値とする。エラーコードとclose reasonは既存JSONを参照し、値を重複定義しない。
- サーバーとWebは`packages/protocol`の共通制御検証関数を使い、CLIは同じschemaから生成したGoの検証定義を使う。フィールドの型・値域・宛先は共通定義で検証し、認証済みの役割・room/peerとの照合・期限・状態遷移は各セッション実装で検証する。`cipher`は制御schemaとは別のenvelope検証・復号経路で扱う。
- 両言語のテストは`protocol/vectors/`の同じファイルを読み込む。制御ベクトルはschemaから自動生成せず、仕様の具体例と境界値を独立に記述する。
- relayからブラウザのcrypto実装をimportしない。共有パッケージにはPSKや実行時の接続状態を入れない。
- UIは状態機械から描画し、DOMイベントの各所へ接続フラグを重複して持たせない。
- schemaを型宣言だけで代替しない。ネットワーク入力には実行時検証を行い、追加フィールドを拒否する。schema validatorを追加する場合も固定依存・同梱の原則を適用する。

### 17.3 コマンド

| コマンド | 契約 |
| --- | --- |
| `npm ci` | lockfileどおりに依存をインストール |
| `npm run dev` | webとrelayを同一origin相当で起動。実機向けHTTPS手順も提供 |
| `npm run gen:protocol` | `protocol/`からTS・Goの定数と制御メッセージ検証定義を生成 |
| `npm run typecheck` | Node・Web・Cloudflare版のTypeScript型検査 |
| `npm run lint` | 静的検査 |
| `npm test` | 単体・暗号fixture・仮想時計テスト |
| `npm run test:integration` | relay統合テスト |
| `npm run test:e2e` | Chromium・Firefox・WebKitでUI試験 |
| `npm run test:interop` | relay・Web送信ページ・CLIバイナリの相互運用試験 |
| `npm run check:i18n` | Web辞書キー・placeholder整合（CLI英語表示は`go test`で検証） |
| `npm run build` | 固定依存から本番webとrelayを生成 |
| `npm start` | 本番relayと静的assetを起動 |
| `docker compose up -d --build` | `.env`設定済み環境で自己ホストを起動 |
| `npm run dev:cloudflare` | Cloudflare版をローカルのworkerd（`wrangler dev`）で起動 |
| `npm run test:cloudflare` | relay統合試験と相互運用試験の対象をローカルのCloudflare版にして実行し、第18.7節の試験を行う |
| `npm run deploy:cloudflare` | 本番buildの後、固定版の`wrangler`でCloudflare版を配備 |
| `go test -race ./...`（`cli/`） | CLIの単体・状態機械・出力・暗号ベクトル試験 |
| `gofmt -l .`（`cli/`） | Goの整形検査。出力があればCIを失敗させる |
| `staticcheck ./...`（`cli/`） | Goのlint。CIと同じ固定版を使い、指摘があれば失敗させる |
| `go vet ./...`、`govulncheck ./...`（`cli/`） | 静的検査、既知脆弱性の確認 |
| リリーススクリプト | CLIのクロスビルド、SHA-256、署名、`run.sh`の生成 |

### 17.4 CLI実装時の原則

- 暗号プリミティブ、WebSocket、QR符号化を独自に再実装しない。
- 依存ライブラリはGo moduleのファイルで版を固定し、実行時に追加取得しない。
- 出力担当を1つにし、プロトコル実装から利用者向け文字列を直接stdoutへ書かない。
- 時刻・出力先・通信を差し替え可能にし、待ち時間を実時間で消費せず状態遷移を試験できるようにする。
- ネットワーク受信、復号待ち、制御のキューを有界にし、遅い出力先によるメモリ増加を抑える。
- heartbeat・`room.touch`・切断検出はstdoutへの書き込みと別のgoroutineで行い、書き込みの停止でheartbeatが止まらないようにする。

## 18. 受け入れ条件と試験

以下の全項目を初版の受け入れ条件とする。期限の境界は仮想時計で検証し、1分・120秒を実sleepで待つテストにしない。以下は仕様への適合条件であり、本書の作成時点で実装試験が完了したことを意味しない。

### 18.1 Web・共通の必須試験

| 試験ID | 試験 | 合格条件 | 主な要件 |
| --- | --- | --- | --- |
| T01 | 新規ブラウザで一連の操作 | 両端ともアプリ・拡張・会員登録なしで接続、読取、送受信できる | R01・R03 |
| T02 | 受信側をPC、スマホ、タブレットへ変更 | 役割を変えず同じ操作ができ、スマホ同士でも接続する | R02 |
| T03 | 受信画面の配置・初期状態 | QRと有効期限が初期viewportに収まり、モード選択・通常状態・空の内容欄がない | R05 |
| T04 | 読取成功後、送信ボタンを押さない | 本文・ドメイン・本文長・本文ハッシュが送られず、状態だけ伝わる | R04・R10 |
| T05 | Web URL、自動モード | data→ack→ack_seen後、同じタブで1回だけ移動。新規タブなし | R06 |
| T06 | 非URLの文字列 | 初期は隠れた内容欄が現れ、原文表示・コピーができる | R07 |
| T07 | mailto・tel・myapp等 | 転送でき、原文を表示し、自動起動・実行リンクを生成しない | R11 |
| T08 | javascript・data・file・HTML文字列等 | 転送・コピーでき、実行・iframe表示・自動リンク化しない | R11・R12 |
| T09 | 日本語、絵文字、結合文字、改行、空白、先頭BOM、NUL | 元のUTF-8文字列を保ち、無断のtrim・正規化・文字置換をしない | R11 |
| T10 | 0、16,384、16,385バイト、単独サロゲート | 空・超過・不正Unicodeを拒否。上限内の正当な入力は送れる | R11 |
| T11 | QR期限の-1ms、同時刻、+1msでjoinとcommit | 期限未満のみ成功。join成功後もcommit時に再判定する | R08 |
| T12 | 59秒でcommit、QR期限後にreadyと転送 | readyはcommit後10秒以内なら成功し、その後の通信を60秒期限で切らない | R08・R09 |
| T13 | authなし、proof未完了、ready未完了 | それぞれ5秒・最大10秒・10秒で処理を終了し、枠が残留しない | R08・R10 |
| T14 | 接続後、heartbeatだけを120秒継続 | idle期限が延びず、セッションを終了する | R08・R10 |
| T15 | 期限直前の正当操作、touch集約、端末時計の±10分ずれ | 正当活動を通知し、末尾touchを落とさず、端末時計で参加期限を延ばさない | R08 |
| T16 | QR再生成と旧送信が競合 | 全秘密・権限を更新し、旧QR・旧メッセージは新roomに作用しない | R09・R12 |
| T17 | 同じQRに2台が参加、不正proof後に正当参加 | 1対1だけ成立。不正candidateだけでQRを消費しない | R03・R12 |
| T18 | receiverProof不一致、commit後の確認失敗 | senderは本文を送らずroomを終了。旧QRを復活させない | R12 |
| T19 | 不正Origin、null Origin、Origin欠落、権限交換、二重auth | 拒否し、既存の正当な相手を置換しない | R12 |
| T20 | 付録Aの固定テストベクトル（TS） | salt、派生鍵、両proof、5通の暗号文が完全一致する | R12 |
| T21 | tag・AAD・room・peer・方向・nonceを改変 | 復号または所属検査で拒否し、内容を表示・実行しない | R12 |
| T22 | seqの重複・欠番・巻戻し・上限・非正規表記 | strictな順序検証で拒否。鍵とIVの組合せを再利用しない | R12 |
| T23 | data、ack、ack_seenの遅延・欠落・切断 | 正当なackなしで成功表示せず、最終確認なしで自動遷移しない | R06・R10 |
| T24 | 同一idの再送、同id異本文、二重クリック | 再送は新seqで確認だけ返す。異本文は拒否。再表示・再遷移しない | R06・R12 |
| T25 | 復号・ハッシュ・暗号化のawait中に再生成／切断 | 世代確認で旧結果を破棄し、新しい画面やroomに作用しない | R09・R12 |
| T26 | スキャン中やack_seen待機中にタブを非表示 | カメラ停止。未読取のカメラのみ接続確認後に再開し、受信内容を開く操作は復帰後も手動 | R06・R10 |
| T27 | 自動遷移後の戻る・進む・BFcache・リロード | 旧room復帰、旧data再送、自動遷移の再実行がない | R06・R12 |
| T28 | カメラ拒否・なし・占有・非HTTPS | 原因を翻訳表示し、無限の許可要求を出さない | R01・R10 |
| T29 | 全画面・全エラーのJA/EN/ES、端末間で異なる言語 | 未翻訳キーがなく、言語変更でroom・モード・プレビューを失わない | R15 |
| T30 | locale候補・未収録辞書 | 第7章どおりfallback。未収録言語をUIへ出さない | R16 |
| T31 | ブラウザ永続ストレージとページ離脱 | 保存されるのは手動言語設定のみ。本文・鍵・接続権限なし | R12・R13 |
| T32 | ダミー本文・鍵・capabilityを使ったログ／保存検査 | アプリ・proxy・例外ログ・ファイル・DBに該当データがない | R13 |
| T33 | relay再起動、受信者不在、片方向切断 | 内容をためず、復元・後日再配信がない。切断を表示する | R10・R13 |
| T34 | 本番bundleの通信、CSP、QR Worker経路 | CDN等に接続せず、Worker経路を含め読取りが動く | R18 |
| T35 | 新規環境から自己ホスト | 同梱手順のみでHTTPS/WSS起動。QRが実際の公開originを指す | R17 |
| T36 | 接続・レート・サイズ・送信バッファの上限 | 超過を拒否し、メモリを無制限に増やさず、内容をディスクへ逃がさない | R13 |
| T37 | Web受信ページに一意id 100件と再送、101件目 | 再送を件数に含めず、100件目の確認後に`transfer_limit`で終了し、送信側に`TRANSFER_LIMIT`、受信側に新しいQRの案内を表示する | R10・R13 |
| T38 | 320px幅、文字拡大、キーボード、スクリーンリーダー | QR・有効期限・言語選択・確認操作が利用でき、本文がUIを破壊しない | R02・R05 |
| T39 | 遷移先がダウンロード、HTTPエラー、接続不可 | 受領結果とサイト表示結果を混同せず、旧roomを終了したまま保つ | R06・R10 |
| T40 | ソース・配布物・ライセンス・manifest | lockfile、同梱asset、version、commit、第三者通知を追跡できる | R17・R18 |
| T41 | 送信画面の受信側表示と拒否表示 | `mode`の3値を表示し、`ack`の`rejected`で`CONTENT_UNSUPPORTED`を表示してプレビュー・コピーを保持する | R10・C03 |
| T42 | Shift_JIS（漢字モード）・ECI付きのQR fixture | デコーダーが返した文字列を変更せず転送する。iOS（Worker）・Android（BarcodeDetector）の結果をリリース記録に残す | R11 |

T23で意図的に暗号frameを欠落させた後に次のseqが到着した場合は、T22の欠番検出による終了が正しい。再確認機能でseqの欠落を飛び越えて復旧しない。

### 18.2 URI分類の固定fixture（Web受信ページ）

| 入力例 | 分類 | 自動モードでの結果 |
| --- | --- | --- |
| `https://example.org/path?q=1#part` | web | 同じタブへ遷移 |
| `HTTP://example.org/` | web | 検証したURLへ遷移 |
| `https://example.org/日本語` | web | 原文を保持し、検証したURLへ遷移 |
| `https://example.org/`の先頭に空白（U+0020）1文字を付けたもの | ambiguous | 表示・コピー |
| `https://user:pass@example.org/` | ambiguous | 表示・コピー |
| `http:foo`、`https:/foo` | ambiguous | 表示・コピー。externalにしない |
| `https://example.org`に改行・バックスラッシュを加えたもの | ambiguous | 表示・コピー |
| `mailto:someone@example.org` | external | 表示・クリックでだけ起動要求 |
| `tel:+12025550100` | external | 表示・クリックでだけ起動要求 |
| `myapp://item/123` | external | 表示・クリックでだけ起動要求 |
| `javascript:alert(1)`、`JaVaScRiPt:alert(1)` | inert_uri | 表示・コピー |
| `data:text/html,<h1>test</h1>` | inert_uri | 表示・コピー |
| `file:///tmp/example.txt`、`blob:https://example.org/id` | inert_uri | 表示・コピー |
| `WIFI:T:WPA;S:example;P:example;;` | text | 表示・コピー |
| `BEGIN:VCARD`から始まるvCard | text | 表示・コピー |
| `example.org`、`/relative/path`、通常の日本語文 | text | 表示・コピー。schemeを補完しない |
| `<img src=x onerror=alert(1)>` | text | タグを実行せず文字として表示 |

fixtureの電話番号・メール・パス等は試験用であり、試験中に実際の通話やメール送信を行う必要はない。ブラウザ試験のWeb URLはテスト用originまたはネットワークrouteの差替えで検証する。

### 18.3 CLIの試験

テストはCLI単体、相互運用（第18.4節）、実端末・スマホ、配布の層に分ける。

#### 18.3.1 コマンドと出力

| ID | 条件 | 合格条件 | 主な要件 |
| --- | --- | --- | --- |
| TC01 | 通常起動 | QRと状態はstderr、受信までstdoutは空 | C05 |
| TC02 | `qrtoss > file` | fileは受信文字列とLFだけ。QRは端末に表示 | C04・C06 |
| TC03 | コマンド置換 | QR・状態が変数へ混入しない | C05 |
| TC04 | オプションなしで1件受信 | 1レコードだけを出力し、受領確認と終了処理後にコード0で終了する | C06 |
| TC05 | 出力成功後に別idのdataを注入 | 追加出力なし。終了コード0 | C06 |
| TC06 | `mailto:`、`tel:`、独自scheme | 内容を保持して出力。外部アクセスやアプリ起動なし | C04・C07 |
| TC07 | 前後の空白、パーセント符号、結合文字 | 正規化・trim・デコードを行わない | C07 |
| TC08 | textにCR/LF/TAB/ESC/C1/方向制御文字 | stdoutは空。`ack`は`rejected`。終了コード6 | C04・C08 |
| TC09 | JSON Linesに改行、NUL、C1、方向制御文字、日本語、絵文字 | 各行がJSONとして解析でき、`text`が原文と一致し、付録A.5のバイト列と一致 | C08 |
| TC10 | JSON Linesを直接端末へ出力 | 本文由来の端末制御シーケンスを生で出さない | C08 |
| TC11 | 本文上限ちょうど、上限超過・空文字列・不正UTF-8の注入 | 上限ちょうどは処理。注入した不正入力は出力もackもせず、コード4 | C10 |
| TC12 | 閉じたパイプ、容量不足、短いwrite | 全体書き込みの成功と誤認せず、ackなし、コード5 | C11 |
| TC13 | 遅いパイプ | メモリが未処理件数に比例して増えず、heartbeatが続く | C11 |
| TC14 | `--help` / `--version` | stdoutへ情報を出し、通信せず0 | C02 |
| TC15 | 未知オプション、単一ダッシュ形式、位置引数、競合形式、異なる値の重複、不正な`--timeout`値 | 通信せず2。エラーはstderr | C02 |
| TC16 | `--server`の表記揺れ（大文字、`:443`、末尾`/`）とパス・query・userinfo付き | 前者は同じ公開originへ正規化、後者は2 | C13 |

#### 18.3.2 接続・確認・再送

| ID | 条件 | 合格条件 | 主な要件 |
| --- | --- | --- | --- |
| TC17 | 未接続で60秒経過 | 古いQRが失効し、新しいroomの登録後に新QRを表示 | C09 |
| TC18 | 古いQRを再度読み取る | 新規接続できない | C09 |
| TC19 | 接続成立後に元のQR期限到達 | 期限だけを理由に接続を切らない | C09 |
| TC20 | 2台目が同じQRで接続 | 既存の認証済み送信端末を置き換えない | C10 |
| TC21 | 1,800秒、heartbeatだけ受信 | 無操作期限が延長されず、`SESSION_EXPIRED`と新しいQRへ進む | C09 |
| TC22 | timeout中にQR更新・再接続 | timeoutの起点が変わらない | C06 |
| TC23 | 受信待機期限到達 | stdoutを汚さず124。新規書き込みを始めない | C06 |
| TC24 | 出力処理開始後に待機期限到達 | 受信待機タイマーで書き込み途中を切らない | C06 |
| TC25 | 出力中に同じidを再受信 | 1回だけ出力し、書き込み完了後にackを返す | C12 |
| TC26 | 遅いパイプで送信側が10秒の期限を過ぎ、送達を再確認 | 追加出力せず、遅れたackで送信側の受領が確定する | C11・C12 |
| TC27 | 同じid・異なる本文 | 追加出力せず、出力成功前なら4、出力成功後なら警告して0で終了 | C12 |
| TC28 | 最初の1件の処理中に異なるid・同じ本文を注入 | 2件目を出力せず、プロトコル違反としてコード4で終了 | C06・C12 |
| TC29 | 出力成功後、ack前に通信断 | 追加出力なし。`ACK_UNCONFIRMED`をstderrへ。終了コード0 | C11 |
| TC30 | 本文受付前の通信断・相手の終了 | 私有の再開通信を行わず、新しいroomの新しいQRで再ペアリング。旧鍵・旧記録を持ち越さない | C09 |
| TC31 | 最初の1件と同じid・同じ本文を繰り返し再送 | 重複判定記録は1件だけ。出力は1回だけで、新しいroomやQRを作成せず終了する | C06・C12 |
| TC32 | 暗号文・ID・認証タグの改変 | 本文出力とackが発生せず、4で終了 | C10 |
| TC33 | プロセスを強制終了後に再起動 | 古い秘密・本文・判定記録を復元せず、新しいセッション | C10 |
| TC34 | 出力成功後にack_seenを受信 | 2秒を待たずに終了し、`ACK_UNCONFIRMED`を出さない | C06・C11 |
| TC35 | 出力成功後にack_seenが届かない | 出力成功から2秒以内に終了し、`ACK_UNCONFIRMED`を表示。終了コード0 | C06・C11 |
| TC36 | 書き込み中の通信断 | 書き込み完了を待ち、成功なら`ACK_UNCONFIRMED`を表示して0、失敗なら5で終了。新しいroomや追加出力なし | C06・C11 |
| TC37 | 回復予算の超過、429の`Retry-After` | 予算を超えて試行せず3で終了。Retry-Afterより早く再試行しない | C09 |

#### 18.3.3 ターミナル・端末

| ID | 条件 | 合格条件 | 主な要件 |
| --- | --- | --- | --- |
| TC38 | stdoutだけをファイルへ向ける | stderrのQRが正常に表示される | C01・C05 |
| TC39 | stderrを非TTYへ向け、明示許可なし | 接続秘密・ANSIを出さず2 | C05 |
| TC40 | 非TTYで`--pairing-url` | 接続URLと状態をANSIなしで出力 | C05 |
| TC41 | 端末幅不足 | 折り返された不正QRを表示しない。規定の代替またはエラー | C01 |
| TC42 | 端末の高さ不足 | QRを表示し、必要な行数を`WARNING`で示す | C01 |
| TC43 | 本文受付前にQRを更新 | 新しいQRは追記表示し、既存の端末表示を消さない。stdoutは空 | C01・C09 |
| TC44 | compact/full、明色/暗色テーマ、ANSIの有無、主要な端末アプリ | 対応設定でiOS・Androidの標準カメラから読み取れる。結果を記録 | C01 |
| TC45 | 曖昧幅を全角とする端末設定 | compactが崩れ得ることを案内し、`--qr full`（ANSI）では読み取れる | C01 |
| TC46 | SSHの対話端末 | 手元にQRを表示し、SSH先で受信処理が動作 | C01・C04 |
| TC47 | ja/en/esと未対応ロケール | 指定どおりの表示。本文・JSONキー・イベント名は変化しない | R15 |
| TC48 | Ctrl+C / SIGTERM | 130/143。stdoutへの説明追加と未完了ackなし。シェルのループもCtrl+Cで止まる | C06 |

#### 18.3.4 配布・非保存

| ID | 条件 | 合格条件 | 主な要件 |
| --- | --- | --- | --- |
| TC49 | 4つの対象OS・CPU | 対応リリースで起動と基本受信を確認 | C13 |
| TC50 | ランチャーの取得中断・HTTPエラー | 不完全なバイナリを実行せず、80 | C02 |
| TC51 | ハッシュ不一致 | 実行しない。検証失敗をstderrへ出し、81 | C02 |
| TC52 | ランチャーから1件受信 | 起動案内がstdoutへ混入せず、本体の終了コードを伝える | C02・C05 |
| TC53 | 同時起動とキャッシュ配置、他者が書き込めるキャッシュ | 不完全な実行ファイルや他ユーザーの書き込みを利用しない | C02 |
| TC54 | 起動前の捕捉可能なエラー、SIGINT、SIGTERM | 自分が作った一時領域を片付ける。SIGKILL等で残る場合も秘密は含まない | C02 |
| TC55 | Apple SiliconのRosetta下のシェル | ランチャーがarm64版を選ぶ | C02 |
| TC56 | 通常起動の通信監視 | 公開origin以外への通信なし。更新確認・外部解析通信・本文URLへのアクセスなし | C04・C10 |
| TC57 | サーバー・CLIの診断出力 | 本文、鍵、完全な接続URL（`--pairing-url`を除く）、認証ヘッダーを含まない | C10 |

### 18.4 相互運用試験

| ID | 条件 | 合格条件 | 主な要件 |
| --- | --- | --- | --- |
| IX01 | 付録Aのテストベクトル（Go） | GoのCLI実装がsalt、派生鍵、両proof、5通の暗号文を再現し、TSの暗号文を復号でき、TSがGoの暗号文を復号できる | C10 |
| IX02 | Web送信ページ→CLI（text） | URLがstdoutへ1行で出力され、送信ページが「受信端末に届きました」を表示する | C03・C11 |
| IX03 | Web送信ページ→CLI（text）で改行を含む内容 | 送信ページが`CONTENT_UNSUPPORTED`を表示して次の読み取り・送信を無効化し、CLIは`REJECTED`を表示して6で終了。stdoutは空 | C06・C08 |
| IX04 | Web送信ページ→CLI（JSON Lines） | 日本語・絵文字・改行・ESCを含む内容が可逆に出力される | C08 |
| IX05 | 接続後の送信画面と1件の送信成功 | 受信側が1件を書き出して終了するコマンドライン（`stdout`）であることを表示し、結果確定後に次の読み取り・送信を無効化する | C03・C06 |
| IX06 | 自己ホストへの`--server` | 接続用URLのoriginが`PUBLIC_ORIGIN`と一致し、Origin検査を通過する | C13 |
| IX07 | `PUBLIC_ORIGIN`と異なるorigin（例：www付き）を`--server`に指定 | 403を受けて2で終了し、不一致を案内する | C13 |
| IX08 | subprotocol・versionの不一致 | 推測で接続せず4で終了する | C10 |
| IX09 | CLIの本文受付前にrelayを再起動 | CLIは新しいroomで新しいQRを表示し、送信ページは切断を表示する | C09 |
| IX10 | 不正な証明書・ホスト名 | 検証を省略せず、再試行せずに4で終了する | C10 |
| IX11 | 送信側の操作とheartbeatだけの状態 | 送信側の`activity`・`status`はCLIの`room.touch`で無操作期限を延ばし、heartbeatだけでは延ばさない | C09 |
| IX12 | 送信ページの「送達を再確認」とCLIの遅い出力の組合せ | 出力は1回、ackは確定後に返り、送信ページの結果が確定する | C11・C12 |

### 18.5 試験環境

自動試験では、独立した2つのブラウザコンテキスト、実際のrelay、Web Crypto、実際のCLIバイナリを使う。カメラ入力は既知のQR画像・動画へ置き換えてよいが、暗号化・proof・ACKをすべてモックして本体経路を省略しない。

| 環境 | 検証内容 |
| --- | --- |
| Chromium・Firefox・WebKitのCI | 操作、分類、遷移、状態、暗号、言語、履歴イベント |
| WindowsまたはmacOSの主要ブラウザ | 通常の受信操作、コピー、同じタブ遷移 |
| iPhone／iPadのSafari実機 | 標準カメラからの導線、カメラ許可、背面カメラ、Worker経路での読取、アプリ切替、画面ロック、復帰 |
| AndroidのChrome実機 | 同上（BarcodeDetector経路）。独自schemeの明示操作も確認 |
| 異なるネットワーク間 | 同一Wi-Fiや直接到達性を必要としないこと |
| macOS（arm64・amd64）、Linux（arm64・amd64）の端末アプリ | CLIの起動・受信・表示、compact/full表示とスマホからの読取 |
| SSH経由の対話端末 | 手元端末へのQR表示と、接続先でのstdout出力 |
| LinuxのCI | `go test -race`、相互運用試験 |

相互運用の自動試験は、試験用CAで発行した`localhost`の証明書によるHTTPS/WSSでrelayを起動する。CLIは`--qr off --pairing-url`で起動し、stderrの接続用URLを自動試験のブラウザで開く。CLIにはLinux上で`SSL_CERT_FILE`により試験用CAを信頼させる。本番バイナリにTLS検証を無効化・置換する隠しオプションを設けない。macOS上のCLI試験は、Goのテストコード内でトランスポートを注入して行う。

対象はリリース時点の現行安定版と直前の主要版を基本とし、実際に試験したOS・ブラウザ・端末アプリの版をリリース記録へ残す。デスクトップWebKitの結果だけでiOS実機のカメラ動作を合格にしない。アプリ内ブラウザは初版の保証対象外とし、通常のSafari／Chromeで開く案内を用意する。

### 18.6 CIと公開前の合格条件

- 型検査、lint、全必須の単体・統合・E2E・相互運用試験、Web辞書・CLI英語表示の検証、`gofmt`・`staticcheck`・`go vet`・`go test -race`、本番build、共通定義の生成差分なしが成功している。Cloudflare版を公開する場合は、第18.7節の試験も成功している。
- 依存バージョン、Go module、イメージdigest、ライセンス、公開するソースcommitが確定している。`npm audit`等と`govulncheck`で既知脆弱性を確認している。
- 本番CSPを有効にした状態で、QR生成・カメラ・Worker経路を含む読取・WSSが動く。
- ダミー転送内容を使った非保存検査と、外部実行コードへの通信検査（Web・CLI）が成功している。
- 実機試験、CLIの端末試験、自己ホスト試験の結果を保存している。実利用の本文・PSKを試験証跡へ残さない。
- R01〜R18、C01〜C13を満たし、サポートするOS・ブラウザ・端末アプリ・スマホの組合せをリリース文書に記録している。未試験の条件を試験済みとして記載しない。
- 暗号手順と信頼境界を、実装担当とは別のレビュー担当が確認している。独立した外部監査の有無は事実どおりに公表し、未実施なら監査済みと表示しない。

### 18.7 Cloudflare版の試験

Cloudflare版は、第18.1節のうち中継サーバーに関わる試験、第18.4節の相互運用試験、および次の試験に合格しなければならない。自動試験はローカルのworkerd（`wrangler dev`）で行い、TD03・TD08の配備・TD11の一部・TD12・TD13・TD15は本番と同じ設定の検証用配備で行う。検証用には別のWorkerと公開originを用意し、本番と同じ配備先の種類（カスタムドメインまたは`workers.dev`）を使う。期限の境界は共有モジュールの仮想時計で検証し、実時間で待たない。

| ID | 条件 | 合格条件 |
| --- | --- | --- |
| TD01 | `tests/relay`の統合試験を、対象をCloudflare版にして実行 | Node版と同じ結果になる |
| TD02 | 相互運用試験（IX02、IX04、IX09を含む）をCloudflare版で実行 | Node版と同じ結果になる |
| TD03 | receiverとsenderを別のネットワークから接続（検証用配備） | 同じRoomDOへ振り分けられ、ペアリング、送信、ackが成立する |
| TD04 | `auth`以外の最初のメッセージ、5秒の時間切れ、バイナリ、過大なメッセージ、Origin不一致、subprotocolの未指定・空・不一致・複数・重複（複数のヘッダー行を含む）、`permessage-deflate`の提示 | 第10.3節どおりのclose codeまたはHTTPステータスで拒否し、RoomDOへ接続しない。不正なsubprotocolでは接続枠を消費しない。単一の`qrtoss.v1`（前後のSP・HTABを許可）は101と同名の選択ヘッダーを返す。圧縮を提示しても、workerd直結の101応答に`Sec-WebSocket-Extensions`が存在しない（空の値も不可） |
| TD05 | 形式が正しく存在しないroomIdでの`auth`、閉じたroomへの`auth` | `PAIR_UNAVAILABLE`となり、認証失敗として数えられる。RoomDOに状態が残らない |
| TD06 | 同じroomへの複数candidateの同時接続と、commitの競合 | `PEER_BUSY`とatomicなcommitがNode版と同じに動き、commitは1件だけ成立する |
| TD07 | 片側の切断：クライアントの切断、RoomDO側からのclose、RoomDOへの内部接続の異常切断 | 相手側が第10.5節・第10.6節どおりの通知またはclose codeを受ける。1005・1006をクライアントへ送らない |
| TD08 | RoomDOの再起動（ローカルでの強制終了）と新版の配備 | クライアントは切断を検出し、新しいroomで接続し直せる。古いroomは復活しない |
| TD09 | `CREATED`のままreceiverが接続せず、RoomDOが退去した後の`auth` | `PAIR_UNAVAILABLE`となり、受信側が新しいroomを作り直す |
| TD10 | `MAX_ROOMS`、WS数、同一IPの接続数、room作成と認証失敗のレートの超過、CapacityDOの再起動・応答なし、room・ソケットの返却後に別stubから届く遅延更新 | 第15.6.7節どおりに503・429（固定秒数の`Retry-After`）で拒否する。返却済みIDへの更新では件数を復活させず、新しいIDのroom・接続は受け付けられる。返却記録は120秒の境界で削除でき、重複返却で期限を延ばさない。CapacityDOの再起動で既存のroomを閉じず、件数が更新で回復する。応答がない場合は新規受付を拒否する |
| TD11 | 非保存の確認 | 第15.6.6節の3点（ストレージAPI等の参照なし、ローカルの永続化ディレクトリが空、本番のDOストレージ使用量・操作数が0）を満たす。配備設定に禁止したbindingがない |
| TD12 | `/`、`/send`、asset、API、404の各応答と、配信されたHTML | 第16.4節のヘッダーと第10.1節の`Cache-Control`がNode版と同じになる。配信されたHTML・JSがビルド成果物とバイト単位で一致し、ゾーンの機能によるスクリプトの挿入がない |
| TD13 | 配備先として選んだカスタムドメインまたは安定した`workers.dev` URL、別のWorker・アカウント等のホスト、Version URL・alias URLへの要求 | `PUBLIC_ORIGIN`への要求は通常どおり処理し、それ以外は公開されていない、または404で拒否される。配備設定が両方の公開先を有効にせず、`preview_urls: false`である |
| TD14 | ダミー内容による一連の転送の後のWorker・DOの出力 | 本文、暗号文、capability、接続用URL、roomId、IPを含まない |
| TD15 | 検証用配備に対して`--server`を指定したCLIで受信 | IX02と同じ結果になる |
| TD16 | 実際のworkerdへのTCP読み取りを止めた相手が`hb.ping`と`room.touch`を送り続け、両方向に大量の`cipher`を中継する。空白で膨らませた入力、制御通知だけの累計超過、通常の100件転送も試す | WorkerとRoomDOが第15.6.5節の送信前上限を守り、超過メッセージを転送せず`SLOW_PEER`と1008で終了する。終了通知も総量内に収まり、同時接続中の別roomは通信を継続できる。最大本文100件とack・ack_seenは完了できる |

## 19. 実装順序と完了の定義

### 19.1 実装タスク

| 順序 | タスクID | 作るもの | 完了条件 |
| --- | --- | --- | --- |
| 1 | I01 | リポジトリ、`protocol/`の共通定義と生成、共有schema、ja/en/es辞書の枠、Go moduleの枠 | 型検査・build・辞書検証・`go vet`が通り、生成差分がない |
| 2 | I02 | base64url、UTF-8保持、URI分類、暗号モジュール（TS） | 付録Aと分類fixtureに一致（T20） |
| 3 | I03 | room作成、WSS認証、期限、候補、atomic commit、close reasonの対応 | 仮想時計・候補競合・権限の統合試験が通る |
| 4 | I04 | proof、ready、世代管理、接続状態（Web） | 2つの独立ブラウザでE2EE接続が成立 |
| 5 | I05 | 最小受信画面、QRと期限、接続後の画像置換、再読み込み | T02・T03・T11・T16が通る |
| 6 | I06 | カメラ、読取アダプター、プレビュー、送信確認、状態通知、拒否表示 | T04・T28・T41と実機の読取りが通る |
| 7 | I07 | data・ack・ack_seen、重複防止、件数上限、遷移・コピー | T05〜T10・T23〜T27・T37が通る |
| 8 | I08 | 非保存、上限、終了処理、CSP、依存同梱 | T31〜T36が通る |
| 9 | I09 | CLI基盤：引数、`--server`の正規化、help/version、text/JSON Lines、状態機械（偽の通信実装）、終了コード | TC01〜TC16が単体試験で通る |
| 10 | I10 | CLIのプロトコル実装：Go暗号、HTTP・WSS、ペアリング、ack、touch、heartbeat | IX01・IX02が通る |
| 11 | I11 | CLIの端末表示、受信前のroom更新、1件受信後の終了、timeout、シグナル | TC17〜TC48が通る |
| 12 | I12 | Docker・proxy・自己ホスト・公開用文書 | 新規環境で同梱手順による配備が通る（T35） |
| 13 | I13 | CLI配布：クロスビルド、SHA-256、署名、Homebrew tap、ランチャー | TC49〜TC57が通る |
| 14 | I14 | 全端末・3言語・障害・相互運用試験、別担当レビュー | 第18章の必須項目が完了 |
| 15 | I15 | room処理の共有モジュールへの分離（Node版は動作を変えない） | Node版で第18.1節・第18.4節の既存試験がすべて通る |
| 16 | I16 | Cloudflare版：Worker、RoomDO、CapacityDO、`wrangler.jsonc`、配備手順 | TD01〜TD16が通る |

I02の純粋関数・暗号fixtureとI03のrelayは並行して進められる。I09はI01の後、Web側と並行して進められる。画面デザインはI01以後に並行できるが、通信メッセージやACK手順をUI側・CLI側だけで変更しない。互換性を変える場合はプロトコルversionとテストベクトルを更新する。

### 19.2 初版のDefinition of Done

**Web**：利用者が新しい受信ページを開き、別端末の標準カメラで接続用QRを読み、Webページのカメラで対象QRを読み、原文を確認して送信できる。受信側は同じタブで検証済みのWeb URLを開くか、任意の文字列を表示・コピーできる。

**CLI**：利用者がターミナルで`qrtoss`（または試用ランチャー）を起動し、stderrの接続用QRをスマホの標準カメラで読み、送信ページで対象QRを読み、原文を確認して送信すると、stdoutに選択した形式で1件のレコードが書き出され、スマホに「受信端末に届きました」が表示される。CLIは受領確認と終了処理後にコード0で終了する。別の内容を受信するには、CLIを改めて起動する。

どちらの操作も、会員登録・同一Wi-Fi・第三者の実行コードを必要とせず（Webはインストールも不要）、本文を暗号化したまま中継し、サーバーへ保存しないことを検証できる。期限切れ・切断・確認遅延でも状態が分かり、古い内容を自動実行・再出力せずに新しいQRでやり直せる。

実装者が設定を行う箇所は、公開origin、配備環境、CLIの既定の`--server`とランチャーの配信元、公開者の連絡先、署名鍵、採用する正確な依存バージョン・digestである。これらは本書の機能・画面・通信・暗号・非保存方針を再設計する作業ではない。

## 20. 参考資料

S01〜S36の初回確認日：2026-11-15。Cloudflare関連のS37〜S48の確認記録は本節末尾に示す。以下はブラウザAPI・暗号プリミティブ・依存ライブラリ・端末・配布の挙動の根拠となる資料である。1分・120秒等の値、独自ペアリング手順、ACK手順、CLIのオプション・時間・上限・終了コード、言語の導入順は本サービスの設計上の決定であり、外部仕様が一律に要求するものではない。

| ID | 資料 | 主な参照箇所 |
| --- | --- | --- |
| S01 | [Node.js Releases][S01] | サポートされるNode.js系列 |
| S02 | [websockets/ws][S02] | NodeのWSS実装、制限・ライセンス |
| S03 | [nimiq/qr-scanner][S03] | カメラ読取、同梱Worker、ライセンス |
| S04 | [soldair/node-qrcode][S04] | ブラウザ内QR生成、ライセンス |
| S05 | [MDN: MediaDevices.getUserMedia()][S05] | HTTPS、カメラ許可、映像入力 |
| S06 | [MDN: Writing WebSocket client applications][S06] | pagehide、WebSocketとBFcache |
| S07 | [WHATWG HTML: Non-fetch schemes and external software][S07] | ブラウザと外部アプリの起動 |
| S08 | [MDN: javascript: URLs][S08] | javascript schemeの実行性 |
| S09 | [MDN: data: URLs][S09] | data schemeとナビゲーション制約 |
| S10 | [MDN: Navigator.languages][S10] | ブラウザの言語希望順 |
| S11 | [W3C: Choosing a language when multiple languages are available][S11] | 言語選択と明示切替 |
| S12 | [W3C: Language tags in HTML and XML][S12] | BCP 47、scriptとregion |
| S13 | [W3C Web Cryptography API: Security considerations][S13] | 配信コード、鍵へのアクセス、消去保証の限界 |
| S14 | [MDN: WebSocket.send()][S14] | 送信キューとbufferedAmount |
| S15 | [OWASP: WebSocket Security Cheat Sheet][S15] | Origin、入力制限、認証、非機密ログ |
| S16 | [MDN: URI fragment][S16] | fragmentとHTTPリクエストの分離 |
| S17 | [MDN: AesGcmParams][S17] | IVの一意性、AAD、認証タグ |
| S18 | [MDN: SubtleCrypto.deriveKey()][S18] | HKDF、CryptoKeyの導出 |
| S19 | [RFC 4648][S19] | base64urlと正規の符号化形式 |
| S20 | [WHATWG Encoding Standard][S20] | UTF-8、TextEncoder、TextDecoder、BOM |
| S21 | [MDN: Content-Security-Policy][S21] | 配信元・接続先・Worker等の制限 |
| S22 | [GNU Bash: Redirections][S22] | stdout/stderrとリダイレクト |
| S23 | [Go: io.Writer][S23] | 書き込みバイト数、短い書き込みとエラーの契約 |
| S24 | [RFC 8259: JSON][S24] | JSON文字列、エスケープ、符号化 |
| S25 | [DENSO WAVE: Point for determining the code area][S25] | QRの四辺の余白 |
| S26 | [mdp/qrterminal][S26] | Goでの文字QR描画と半ブロック表示の実装例 |
| S27 | [RFC 6455: WebSocket][S27] | WebSocket通信 |
| S28 | [curl: Manual][S28] | HTTPエラー、プロトコル制限、リダイレクト、取得タイムアウト |
| S29 | [Go: os/signal, SIGPIPE][S29] | 閉じたパイプへの書き込みとシグナルの扱い |
| S30 | [Node.js: Evolving the Node.js Release Schedule][S30] | Node.js 26のLTS移行、27以降のリリース周期 |
| S31 | [Can I use: BarcodeDetector API][S31] | ブラウザごとの対応。iOS Safariでは既定で無効 |
| S32 | [Go: crypto/hkdf][S32] | GoのHKDF（Go 1.24以降の標準ライブラリ） |
| S33 | [Go: crypto/x509][S33] | GoのTLS信頼ストアと`SSL_CERT_FILE`・`SSL_CERT_DIR` |
| S34 | [Unicode UAX #11: East Asian Width][S34] | 曖昧幅（Ambiguous）の文字 |
| S35 | [RFC 6454: The Web Origin Concept][S35] | originとそのASCII直列化 |
| S36 | [DENSO WAVE: Information capacity and versions of QR Code][S36] | QRの版と格納容量 |
| S37 | [Cloudflare: Durable Objects overview][S37] | roomごとの調整、IDごとに1つのインスタンス |
| S38 | [Cloudflare: Use WebSockets (Durable Objects)][S38] | DOでのWebSocket、標準APIとHibernation API |
| S39 | [Cloudflare: Lifecycle of a Durable Object][S39] | メモリからの退去、休止の条件 |
| S40 | [Cloudflare: Workers static assets][S40] | `ASSETS` binding、`run_worker_first`、`not_found_handling` |
| S41 | [Cloudflare: Durable Objects pricing][S41] | 実行時間とストレージの課金 |
| S42 | [Cloudflare: Durable Objects limits][S42] | DOごとの処理量、メッセージサイズ |
| S43 | [Cloudflare: Workers performance and timers][S43] | `Date.now()`がI/Oまで進まないこと |
| S44 | [Cloudflare: HTTP request headers][S44] | `CF-Connecting-IP` |
| S45 | [Cloudflare: Workers Logs][S45] | Workers Logsの記録内容と無効化 |
| S46 | [Cloudflare: Compatibility flags — WebSocket Compression][S46] | 現行日付では圧縮が既定で有効、無効化フラグの受信・送信接続への適用 |
| S47 | [Cloudflare: workers.dev][S47] | 安定した公開URL、Worker名の条件、Browser Integrity CheckとアプリのUser-Agent |
| S48 | [Cloudflare: Version URLs][S48] | `preview_urls: false`によるVersion URL・alias URLの無効化 |

S37〜S45は1.1.0で追加し、Cloudflare版の実装時に公式文書のURLと内容を確認した。今回の再確認日：2026-11-17（America/Chicago）。S46を含む次の公式資料のURLと該当する本文を再確認した。

| 参照ID | 確認した事項 |
| --- | --- |
| S37〜S39 | IDによるクライアント間の調整、標準WebSocket APIとHibernation API、休止時のメモリ状態の消失 |
| S40 | `ASSETS` binding、`run_worker_first`、`not_found_handling`による配信・ルーティング |
| S41・S42 | SQLite-backed DOのFree/Paidプラン条件、標準WebSocketのduration課金、WebSocketメッセージ・CPU等の上限 |
| S43・S44 | 本番の時刻APIがI/O後に進むこと、`CF-Connecting-IP`とWorker subrequestでの扱い |
| S45・S46 | Workers Logsの記録内容・有効化設定、受信・送信接続のWebSocket圧縮フラグ |

`workers.dev`配備の追加にあたり、S47・S48のURLと本文も2026-11-17（America/Chicago）に確認した。確認対象は安定したURLとWorker名の対応、Browser Integrity CheckとUser-Agent、Version URL・alias URLの無効化である。

配備先のゾーン設定、別ネットワーク・実機ブラウザでの接続、DOストレージの使用量・操作数の実測は、第18.7節の受入試験で確認する。実施済み・未実施の状況は[`docs/validation.md`](validation.md)に記録しており、上表は公式資料の確認範囲を示す。

[S01]: https://nodejs.org/en/about/previous-releases
[S02]: https://github.com/websockets/ws
[S03]: https://github.com/nimiq/qr-scanner
[S04]: https://github.com/soldair/node-qrcode
[S05]: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
[S06]: https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API/Writing_WebSocket_client_applications
[S07]: https://html.spec.whatwg.org/multipage/browsing-the-web.html#non-fetch-schemes-and-external-software
[S08]: https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/javascript
[S09]: https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/data
[S10]: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/languages
[S11]: https://www.w3.org/International/questions/qa-site-conneg
[S12]: https://www.w3.org/International/articles/language-tags/
[S13]: https://www.w3.org/TR/2017/REC-WebCryptoAPI-20170126/#security-considerations
[S14]: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/send
[S15]: https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html
[S16]: https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment
[S17]: https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams
[S18]: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey
[S19]: https://www.rfc-editor.org/rfc/rfc4648
[S20]: https://encoding.spec.whatwg.org/
[S21]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy
[S22]: https://www.gnu.org/software/bash/manual/html_node/Redirections.html
[S23]: https://pkg.go.dev/io#Writer
[S24]: https://www.rfc-editor.org/rfc/rfc8259
[S25]: https://www.qrcode.com/en/howto/code.html
[S26]: https://github.com/mdp/qrterminal
[S27]: https://www.rfc-editor.org/rfc/rfc6455
[S28]: https://curl.se/docs/manpage.html
[S29]: https://pkg.go.dev/os/signal#hdr-SIGPIPE
[S30]: https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule
[S31]: https://caniuse.com/mdn-api_barcodedetector
[S32]: https://pkg.go.dev/crypto/hkdf
[S33]: https://pkg.go.dev/crypto/x509
[S34]: https://www.unicode.org/reports/tr11/
[S35]: https://www.rfc-editor.org/rfc/rfc6454
[S36]: https://www.qrcode.com/en/about/version.html
[S37]: https://developers.cloudflare.com/durable-objects/
[S38]: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
[S39]: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
[S40]: https://developers.cloudflare.com/workers/static-assets/
[S41]: https://developers.cloudflare.com/durable-objects/platform/pricing/
[S42]: https://developers.cloudflare.com/durable-objects/platform/limits/
[S43]: https://developers.cloudflare.com/workers/runtime-apis/performance/
[S44]: https://developers.cloudflare.com/fundamentals/reference/http-headers/
[S45]: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
[S46]: https://developers.cloudflare.com/workers/configuration/compatibility-flags/#websocket-compression
[S47]: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
[S48]: https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/

## 付録A. 暗号プロトコルとCLI出力の公開テストベクトル

以下は実装の一致を検証するための固定値であり、本番の鍵・nonceとして使ってはならない。本付録の値は、Node.js 26のWeb Crypto実装と、Python標準ライブラリのHMAC/SHA-256に試験専用のAES-GCM実装を組み合わせた計算という、独立した2系統で一致を確認した。同じ2系統で、統合元の付録A（識別子`qrrelay/1`）の全値を再現できることも確認した。サービス全体の実装試験や第三者監査の代わりではない。TS実装はT20、Go実装はIX01で本付録の全値を再現する。

### A.1 入力

バイト範囲は両端を含み、昇順に並べた連続値とする。

```text
psk bytes:       00 01 ... 1f
rNonce bytes:    20 21 ... 3f
sNonce bytes:    40 41 ... 5f
room bytes:      60 61 ... 6f
peer bytes:      70 71 ... 7f
messageId bytes: 80 81 ... 8f

room:      YGFiY2RlZmdoaWprbG1ubw
peer:      cHFyc3R1dnd4eXp7fH1-fw
psk:       AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8
rNonce:    ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8
sNonce:    QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8
messageId: gIGCg4SFhoeIiYqLjI2Ojw
```

`T`は次の文字列のUTF-8である（`\n`はLF）。

```text
qrtoss/1\nYGFiY2RlZmdoaWprbG1ubw\ncHFyc3R1dnd4eXp7fH1-fw\nICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8\nQEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8\n
```

### A.2 鍵導出・proofの期待値

```text
SHA256(T) hex:
1d2e61308b333f272ee4a140076d6e344c8e470a9fac5bc6c231a4c56f79a095

Kproof hex:
b72b013d52b295c6dc523bccc3c2d43d44c5f4ee15624f4720823549da598657

Ks2r hex:
e2a2edc48b145d82f1cb41737a0961059eccddfdba947e669038f3b3b3671fe3

Kr2s hex:
ffd2be59a154add5aef5a7c7b62935c228d28cdbd434c1f05ed3761eaf3a6b40

senderProof base64url:
52ggo6BOi076rjXRvUGLyoNsKGRewDam67G9zJ70OtA

receiverProof base64url:
uv4Bk9sygs1pRgWAp8ipykYnsvK1MjG6EGbr1zOgcwU
```

### A.3 AES-GCMの期待値

AADは第9.4節の規約どおり、room、peer、方向、seqを使用し、末尾LFを含める。例えば1件目のAADは次の文字列のUTF-8である。

```text
qrtoss/1/cipher\nYGFiY2RlZmdoaWprbG1ubw\ncHFyc3R1dnd4eXp7fH1-fw\ns2r\n0\n
```

`data`の本文は「こんにちは😀」、LF、「qrtoss」を連結した文字列である。そのUTF-8（26バイト）は`e38193e38293e381abe381a1e381aff09f98800a7172746f7373`、`textB64`は`44GT44KT44Gr44Gh44Gv8J-YgApxcnRvc3M`である。

| No. | dir | seq | IV hex | 平文（UTF-8、バイト数） |
| ---: | --- | ---: | --- | --- |
| 1 | s2r | 0 | `000000000000000000000000` | `{"type":"ready"}`（16） |
| 2 | r2s | 0 | `000000000000000000000000` | `{"type":"ready_ack"}`（20） |
| 3 | r2s | 1 | `000000000000000000000001` | `{"type":"mode","value":"stdout"}`（32） |
| 4 | s2r | 1 | `000000000000000000000001` | `{"type":"data","id":"gIGCg4SFhoeIiYqLjI2Ojw","textB64":"44GT44KT44Gr44Gh44Gv8J-YgApxcnRvc3M"}`（93） |
| 5 | r2s | 2 | `000000000000000000000002` | `{"type":"ack","id":"gIGCg4SFhoeIiYqLjI2Ojw","status":"received"}`（64） |

ciphertext || tag（base64url）：

```text
1: xWBcdH43z6NuMolTwXUQ8ROkglrcOCm9yXPhC8VHM24
2: lw2kpyv687cuL0j4yUzC1RF5Xum6cakLVcTRdTac0pyC4aLo
3: sFEcgPGJL50d9PyjDsxnfnCdhzC-N0XymK9NVWK8TKrhc9v_7dBQFuJ_DhrnzzaQ
4: LUVev9lT_Aow2OmRQzKmR3atZKelw8OVcZWF9P3Dg-nbKkMj6D3hJ9jxx7M_uy00TIxpkyPJWg3BXmJYYnAEqPlDTBMi7UBDvB_DgYMU8l6lCZ6eVGqAJIOyR-SfFRvmye_RKvUM_8bNXq_4iQ
5: q6t7P7iEUN86FiSrVhFtF-UUq1COy9e1WNb98lXg7kDIkt339-WB9LDx0KwL7Ao220b8C_4PsgbVCbFrNGv5tRk-RG-kuCXc-U7MPTTjBvg
```

5件は1つのroomでの最小のやり取り（ready、ready_ack、mode、data、ack）の順に並べてある。復号で上記の平文に戻ることも確認する。

### A.4 否定試験

次の否定試験を同じfixtureへ追加する。

- TまたはAADの末尾LFを削除すると、期待するproofまたは復号結果と一致しない。
- 方向をr2sへ置換した場合、s2rの暗号文を受理しない。
- 暗号文またはタグの1 bitを変更すると復号に失敗する。
- 同じenvelopeを2回受理しない。
- 単独サロゲートを入力として与えた場合、UTF-8の置換後の別文字列を黙って送らない。
- base64url文字列に改行・空白・`=`を加えたもの、末尾の未使用ビットが0でないものを受理しない。
- 識別子を`qrrelay/1`とした旧ベクトルの値を受理しない（統合元との取り違えの検出）。

### A.5 CLI出力のfixture

第14.7節の規則による出力である。JSON Linesのバイト数は末尾LFを含む。

| No. | 受信文字列 | text形式 | JSON Linesの出力（UTF-8） |
| ---: | --- | --- | --- |
| 1 | A.3の`data`の本文（LFを含む） | 拒否（`unsupported_content`）。stdoutは空 | `{"text":"こんにちは😀\nqrtoss"}`＋LF（39バイト） |
| 2 | `a`、U+001B、`b`、U+202E、`c`、U+0085、`d`、`"`、`e`、`\`、`f` | 拒否。stdoutは空 | `{"text":"a\u001bb‮c\u0085d\"e\\f"}`＋LF（40バイト） |
| 3 | `https://example.org/a?x=1` | `https://example.org/a?x=1`＋LF | `{"text":"https://example.org/a?x=1"}`＋LF（37バイト） |

No.1とNo.2のJSON Linesのバイト列（16進）：

```text
1: 7b2274657874223a22e38193e38293e381abe381a1e381aff09f98805c6e7172746f7373227d0a
2: 7b2274657874223a22615c7530303162625c7532303265635c7530303835645c22655c5c66227d0a
```

### A.6 長さの検証値

16,384バイトをbase64url化すると21,846文字になる。`type`、22文字の`id`、`textB64`だけを、余分な空白なしのJSONで符号化した本文は21,904バイトとなり、平文上限22,528バイト以下に収まる。

平文上限22,528バイトにGCMタグ16バイトを加えた22,544バイトは、base64urlで30,059文字となる。外側の固定フィールドと20桁のseqを加えても約30,195バイトであり、WS上限32,768バイト以下であることをfixtureで確認する。

本番コードでは鍵をexportしない。テストfixtureの比較用に派生鍵のバイト値を得る処理（ブラウザでは`deriveBits`）は、試験コードだけへ隔離する。

## 付録B. 変更履歴

| 版 | 日付 | 内容 |
| --- | --- | --- |
| 1.0.0 | 2026-11-15 | 初版。サービス名をqrtossとする |
| 1.1.0 | 2026-11-18 | Cloudflare WorkersとDurable Objectsで動く中継サーバー（Cloudflare版）を追加（第3.4節、第15.6節、第16.10節、第18.7節、I15・I16）。カスタムドメインまたは`workers.dev`の公開先を選べる。レビュー7.3対応として、送信量の累計上限と終了通知の予約領域、TD16を規定した。クライアントとの通信形式と暗号方式は変更しない |
