# qrtoss

[English](README.md) · [Español](README.es.md)

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-26%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Go](https://img.shields.io/badge/Go-1.24%2B-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![Author](https://img.shields.io/badge/author-Synge%20Todo-blue)](https://github.com/wistaria)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE.md)

スマホで読み取ったQRコードの内容を、別の端末のブラウザやターミナルへ転送します。一時的な接続用QRコードをスマホの標準カメラで読み、送信ページで対象QRを読み取って内容を確認し、送信します。アカウント、スマホへのアプリ導入、同じWi-Fiへの接続は不要です。

ブラウザの受信側は原文を表示するか、HTTP(S) URLを同じタブで開きます。Go製CLIは**1件だけ受信して標準出力へ書き出し、終了**します。接続用QRコードと状態表示は標準エラー出力へ分離します。画面・CLIは日本語・英語・スペイン語に対応します。

## ローカルで起動

必要なものはNode.js 26（確認版26.13.0）、npm、CLIをビルドする場合はGo 1.24以上（確認版1.27.4）です。

```sh
npm ci
npm run dev
```

**http://127.0.0.1:8080** を開きます。この開発用loopbackサーバーでは、同じPCのブラウザ同士で動作を確認できます。スマホでカメラを使用するには、スマホから到達でき、証明書が信頼されるHTTPS originが必要です。開発コマンドは起動時にWebをビルドするため、Webの変更後は再起動してください。

## HTTPSで自己ホスト

ドメインをホストへ向け、80番と443番ポートへの接続を許可します。Docker EngineとComposeを用意し、次を実行します。

```sh
cp .env.example .env
# .envのPUBLIC_ORIGINを実際のhttps:// originへ変更（末尾スラッシュなし）。
docker compose up -d --build
```

受信端末でHTTPSの受信ページを開き、接続用QRをスマホの標準カメラで読み取ります。送信ページの「QRコードを読み取る」で対象QRを読み、原文を確認して「受信端末に送信」を押します。Webページを開くと接続は終了します。「内容を表示」を選ぶと、表示したまま次の送信を受け取れます。

アプリは非root・読み取り専用ファイルシステムで1プロセスとして動き、roomをメモリ内だけで管理します。公開ポートはCaddyだけが使用し、永続volumeはCaddyのTLS証明書用だけです。設定、プロキシの信頼範囲、ホストのメモリ設定、更新方法は[運用手順](docs/self-hosting.md)を参照してください。

Dockerを使用しない場合：

```sh
npm run build
PUBLIC_ORIGIN=https://qr.your-domain.example NODE_ENV=production npm start
```

内部HTTPポートを、信頼するHTTPS/WSSリバースプロキシ経由で公開してください。本番ではHTTPSを必須とします。DB・Redis・STUN・TURNは不要です。

既存サイトの `/qrtoss/` 配下でブラウザ版を公開する場合は、配置先を指定してビルドします。

```sh
QRTOSS_BASE_PATH=/qrtoss/ npm run build
```

`PUBLIC_ORIGIN` は `https://myserver.example` のように origin だけを指定します。Apache は HTTP・WebSocket の転送時に `/qrtoss` を取り除きます。設定例は [Apache のサブパス配信手順](docs/self-hosting.md#browser-deployment-under-an-apache-subpath)を参照してください。ベースパスはビルド時に確定し、既定値は `/` です。CLI と同梱の Docker Compose／Caddy 構成は引き続きドメイン直下を使用します。

## CLI

単体の実行ファイルをビルドします。

```sh
cd cli
go build -trimpath -o qrtoss ./cmd/qrtoss
./qrtoss --server https://qr.your-domain.example
```

組み込みの例示originは稼働中の公開サービスではありません。自己ホストしたoriginを`--server`または`QRTOSS_SERVER`に指定してください。CLIとスマホの両方から到達できる必要があります。

```sh
./qrtoss --server https://qr.your-domain.example > received.txt
url="$(./qrtoss --server https://qr.your-domain.example --timeout 120)"
./qrtoss --server https://qr.your-domain.example --jsonl > received.jsonl
./qrtoss --help
```

text形式では受信文字列を変更せず、末尾にLFを付けます。制御文字を含む本文は終了コード6で拒否します。改行や制御文字を含む有効なUnicode文字列には`--jsonl`を使ってください。JSON Linesは`{"text":"…"}`という1個のオブジェクトと末尾LFを出力します。CLIがURLを開いたり、本文をシェルで評価したりすることはありません。

接続用QRの有効期限は5分です。受信前の期限切れではQRを更新し、通信断では再ペアリングできます。`--timeout`は出力可能な1件を受け付けるまでの待機期限で、遅い標準出力への書き込み時間は制限しません。出力成功後の受領確認・終了処理は最大2秒です。確認の配送が不確定なだけでは、出力成功を失敗へ変更しません。厳密なオプションと終了コードは[仕様書](docs/spec.md#14-cli受信クライアント)に記載しています。

端末には十分な横幅を確保してください。compact表示が崩れる場合は`--qr full`を試せます。`--pairing-url`は秘密を含む接続用URLの表示を明示的に許可します。標準エラーが非TTYの場合は`--qr off --pairing-url`を指定します。接続用URLは他人に渡さず、受信内容を取得するときは標準出力と標準エラーを結合しないでください。

## 開発と検証

```sh
npm run gen:protocol
npm run check:generated
npm run typecheck
npm run lint
npm run check:i18n
npm test
npm run build
npx playwright install chromium firefox webkit
npm run test:e2e
cd cli
go test -race ./...
go vet ./...
```

`protocol/`が共通定数・エラーコード・終了理由・公開テストベクトルの正本です。生成したTypeScript/Goの定数に差分がないことを検査します。暗号ベクトル、不正入力、実際のrelay通信、QR画像を使うカメラ入力、言語間の相互運用を試験します。自動検証と公開前の実機確認の違いは[検証状況](docs/validation.md)を参照してください。

macOS/Linuxのarm64/amd64向けビルド、チェックサム、版固定ランチャーの生成方法は[リリース手順](docs/releasing.md)にまとめています。このリポジトリには、稼働中のダウンロード配信先や署名済み公開リリースは含まれません。

## セキュリティとプライバシー

端末間で相互認証した後、HKDF-SHA256で導出した方向別鍵とAES-256-GCMで暗号化します。中継サーバーは接続のメタデータと暗号文を扱いますが、接続用の秘密鍵や本文を受け取りません。room・鍵・重複防止記録は一時的なメモリ内情報です。転送DB・オフラインキュー・外部解析・実行時の外部CDNは使用しません。

接続用QRには接続権限があるため共有しないでください。暗号化は端末と配信コードが信頼できることを前提とし、ソース公開だけで実際の配信コードの一致が保証されるわけではありません。独立した外部セキュリティ監査は未実施です。[SECURITY.md](SECURITY.md)と[仕様書](docs/spec.md)を参照してください。

## ライセンス

[MIT License](LICENSE.md)。Copyright © 2026 Synge Todo。依存ライブラリはそれぞれのライセンスに従います。[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)に収録しています。
