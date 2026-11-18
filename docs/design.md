# qrtoss UI/UXデザイン設計書

## 1. 目的とデザイン原則

カメラを利用できない端末でも、別のスマートフォンを使ってQRコードの内容を受け取れるWebアプリケーションを設計する。接続用QRを読み取る操作を中心に据え、設定なしで利用できる構成とする。

完全モノクロ・フラット・読みやすさを基本とする。背景は白 `#FFFFFF`、主要文字は `#171717`、補助文字は `#525252`、境界線は `#D4D4D4`、補助背景は淡いグレーとする。色相のあるアクセント、グラデーション、影、不要な図形やアニメーションは用いない。ぼかしは使用済みQRを読み取れない画像で示す目的に限る。

UDフォントを優先し、システムのサンセリフ体へフォールバックする。操作・本文は16〜18px、補助文字・期限は14〜16px、読み取り案内は20〜22px。宣伝部分は十分な余白と大きな見出しで構成し、通常の操作案内と区別する。カードの境界線は1px、角丸は8〜12px、アイコンは単色の線画とする。

## 2. 共通ヘッダー

高さ56〜64pxの1行構成とする。左に矢印シンボルと`qrtoss.`ロゴ、右にGitHubリンクと言語選択を置く。

GitHubリンク先は https://github.com/kodogu-works/qrtoss 。アイコンとGitHubの文字を表示し、モバイルではアイコンだけでもよい。背景・装飾枠は設けず、`target="_blank"`、`rel="noopener noreferrer"`、新しいタブで開くことを伝えるARIAラベルを設定する。

言語は日本語・英語・スペイン語。手動設定を優先し、切り替えで接続・QR・本文・カメラ状態を失わない。

## 3. 受信画面

単一カラムで、中央の接続用QRを主役とする。受信後の動作選択、通常の接続状態表示、共有禁止の説明、新規QRボタン、独立した「この端末で受信」タイトルは置かない。

| 要素 | 初回アクセス | 接続成立後 |
| --- | --- | --- |
| ヘッダー | 共通ヘッダー | 同じ位置・寸法を保持 |
| 読み取り案内 | スマホのカメラで、このQRコードを読み取ってください | スマホのカメラで、QRコードを読み取ってください |
| QR画像 | 白地に黒の接続用QR | 元の画素を破棄し、秘密情報を含まない読み取り不能のぼかし画像に置換 |
| 有効期限 | 残り秒数 | 0 秒に固定 |
| キャッチコピー・紹介 | QRの下に配置 | 内容・レイアウトを保持 |
| 受信した内容 | 非表示。見出し・空表示もなし | テキスト表示が必要な場合にのみ表示 |

案内文は同じ高さの領域で切り替え、QR・期限・宣伝部分の位置を動かさない。案内文に中央揃えを用いる。QRは180〜260px、モバイルでは240〜260pxを目安にし、読み取りに必要な白い余白を確保する。

QRと有効期限は、通常の初期viewportでスクロールせず確認できる。宣伝部分はその下に続き、縦スクロールを許可する。コンテンツを`overflow: hidden`で隠して収めない。極端に低い画面や文字拡大時は可読性を優先してスクロールを許可する。

接続成立後のぼかし画像は元のQRへのCSS blurだけでは実装しない。元画像と秘密情報を含まないダミー画像の画素を入れ替える。使用済みQRは切断後も復元せず、期限は0のままにする。再接続は再読み込みで新しいroomを作成する。接続QRの期限切れ処理自体は通信仕様に従う。

## 4. 受信後の動作

Web受信ページは`auto_open`固定で、設定操作を要求しない。

- 受信側で有効なHTTP(S) URLと判定した内容は、最終受領確認後、前面表示を維持した場合に同じタブで開く。
- URLとして自動で開けない内容は、その原文をテキストとして表示する。HTMLやMarkdownとして解釈しない。
- 非Webスキームや不正・曖昧なURLからアプリやコードを自動起動しない。
- 自動遷移が非表示や確認タイムアウトで取り消されたWeb URLは、原文と手動で開く操作を表示する。画面復帰だけでは遷移しない。
- 内容欄は紹介文より前に配置し、表示が必要になった時にだけ見出しとともに現れる。前面で受信が完了した場合は内容欄へスクロールして提示する。コピーと内容の消去を提供し、長文・長いURLは折り返す。内容領域内のスクロールとキーボード操作に対応する。
- エラーは必要な時だけ具体的な文で案内する。通常状態を示すバーは置かない。

安全なURL判定、暗号化、ack/ack_seen、有効期限、セッション管理は [spec.md](spec.md) に従う。通信上の`display_only`互換値は残すが、Web受信ページでは選択できない。

## 5. キャッチコピーと紹介

Appleの製品紹介のように、大きなタイポグラフィ、余白、明暗差で情報を整理する。写真や装飾は追加せず、先頭にキャッチコピーと副題、その下に7項目の見出し・本文を順番に配置する。PCでは読みやすい複数列、スマートフォンでは1列とする。以下の文言を使用する。

### 日本語

**カメラがなくても、QRコードを。**

QRコードを、もっと自由に。もっと手軽に。

- **カメラがなくても、大丈夫。** PCでも、スマートフォンでも、タブレットでも。カメラがなくても、使えなくても、QRコードを利用できます。
- **スマホで読み取る。それだけ。** 別のスマートフォンでQRコードをスキャンするだけ。複雑な設定は必要ありません。
- **インストールも、登録も、いらない。** 必要なのはWebブラウザだけ。アプリのインストールも、アカウント登録も不要です。
- **端末を選ばない。** Windows、macOS、Linux、スマートフォン、タブレット。OSの違いを気にせず使えます。
- **安全に送る。中身は見せない。** エンドツーエンド暗号化で、転送内容を保護。中継サーバーでも復号できません。
- **送るだけ。残さない。** データはサーバーに保存せず、そのまま中継。転送内容を残しません。
- **オープンソース。だから、透明。** ソースコードはGitHubで公開。誰でも仕組みを確認し、改善に参加できます。

### 英語

**No camera? No problem.**

QR codes. More freedom. Less effort.

- **No camera. No limits.** On your computer, phone, or tablet. Even without a working camera, QR codes are within reach.
- **Just scan. That's it.** Use another phone to scan the QR code. No complicated setup. No extra steps.
- **No downloads. No sign-ups.** All you need is a web browser. Nothing to install. No account to create.
- **Works across devices.** Windows, macOS, Linux, smartphones, and tablets. Different devices. One seamless experience.
- **Secure by design.** End-to-end encryption keeps your data private. Not even our servers can read it.
- **Sent. Not stored.** Your transferred data is never stored on our servers.
- **Open source. Open to everyone.** The code is on GitHub. Explore it, verify it, or help make it better.

### スペイン語

**¿Sin cámara? No hay problema.**

Códigos QR. Más libertad. Menos complicaciones.

- **Sin cámara. Sin límites.** En tu computadora, teléfono o tableta. Aunque no tengas cámara o no funcione, puedes seguir utilizando códigos QR.
- **Escanea. Y listo.** Usa otro teléfono para escanear el código QR. Sin configuraciones complicadas. Sin pasos innecesarios.
- **Sin instalaciones. Sin registros.** Solo necesitas un navegador web. Nada que instalar. Ninguna cuenta que crear.
- **Funciona en todos tus dispositivos.** Windows, macOS, Linux, teléfonos y tabletas. Diferentes dispositivos. Una experiencia sencilla.
- **Seguro desde el principio.** El cifrado de extremo a extremo protege tus datos. Ni siquiera nuestros servidores pueden leerlos.
- **Se envía. No se guarda.** Tus datos pasan por nuestros servidores, pero nunca se almacenan en ellos.
- **Código abierto. Para todos.** El código está disponible en GitHub. Explóralo, compruébalo o ayuda a mejorarlo.

## 6. 送信画面

送信画面は共通ヘッダーと1カラムのカードで構成する。ページタイトルは「スマホから送信」とし、以下の順で情報を配置する。

1. 接続状態と受信側の動作モード
2. カメラ利用の説明、読み取り中のカメラ映像、または読み取り済み内容のプレビュー
3. 対応カメラのズーム操作と「写真から読み込む」操作
4. 状態に応じたカメラ再試行、送信、再読み取り、送達再確認、コピーの操作

カメラは接続成立後、読み取り画面で自動起動し、背面カメラを優先する。起動できない場合のみ「カメラを再試行」を表示する。映像上部に「送信したいQRコードをスキャン」を重ね、中央のガイドは四隅の白い線で示す。検出は映像全体を対象とし、ガイド内に限定しない。ズーム非対応時は操作を表示しない。写真は端末内で解析し、サーバーへ送信しない。読み取り完了、切断、画面非表示・離脱時にはカメラを停止する。読み取り後は内容を確認でき、送信操作によって転送する。操作の可否は接続・読み取り・送達の状態に従い、利用できない操作は無効化または非表示にする。接続エラーとカメラ権限エラーは、理由を文字で案内する。

## 7. 共通コンポーネントとアクセシビリティ

色、文字サイズ、余白、角丸、境界線をCSS変数で管理する。ボタン・入力・セレクトは共通スタイルとし、タッチ領域は44×44px以上。キーボードのフォーカスを黒いアウトラインで示す。状態を色だけで伝えない。必要なARIAラベルと見出し構造を設け、エラーとコピー結果は読み上げに対応する。期限の毎秒更新はライブ通知しない。`prefers-reduced-motion`を尊重する。

## 8. 検証と受け入れ基準

Playwrightなどの実ブラウザで、日本語・英語・スペイン語を検証する。

| viewport | 基準 |
| --- | --- |
| 1440×900 / 1280×720 / 1024×768 | QRと期限が初期viewport内。紹介はスクロール可 |
| 390×844 / 375×667 | QRと期限が初期viewport内。単一カラム・横スクロールなし |
| 320px幅・文字拡大 | 横にはみ出さず、必要な縦スクロールで操作可能 |

初期画面にモード選択・通常状態・内容の空欄・QR再生成ボタンがないことを確認する。接続前後のQR・期限の位置が変わらず、接続後の画像は復号できず、再スキャンしても参加できないことを確認する。受信URLの安全な自動遷移、非URLの原文表示、長文・コピー・消去、非表示時とタイムアウト時の手動操作を確認する。言語切替は接続や原文を失わないこと。宣伝文句が全言語で表示されること。送信側・CLI・ルートとサブパス配備の回帰テストも実行する。
