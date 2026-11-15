package client

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/boombuler/barcode/qr"
	"golang.org/x/term"
)

var messages = map[string]map[string]string{
	"en": {"WAITING": "Scan the pairing QR with your phone.", "CONNECTED": "Encrypted connection established.", "PEER_SCANNED": "QR scanned on the sender. Waiting for send.", "RECEIVED": "Wrote received content to stdout.", "REJECTED": "This content requires --jsonl. Start qrtoss again with --jsonl.", "DISCONNECTED": "Connection closed.", "RECONNECTING": "Connecting to the service again.", "QR_REFRESHED": "New pairing QR. The old QR is no longer valid.", "SESSION_EXPIRED": "The idle session expired.", "ACK_UNCONFIRMED": "Output succeeded; receipt delivery could not be confirmed.", "ERROR": "Could not complete the operation.", "ARGUMENT_ERROR": "Invalid arguments or public HTTPS origin.", "DISPLAY_ERROR": "Use a compatible terminal (80 columns × 34 rows recommended) or --qr off --pairing-url. Try --qr full if the QR is distorted.", "WARNING": "Increase terminal height to show the entire QR. If distorted, try --qr full.", "TIMEOUT": "Receive waiting time expired.", "PROTOCOL_ERROR": "The secure protocol validation failed.", "IO_ERROR": "Could not write to the required output.", "CONNECT_ERROR": "Could not establish a connection within the recovery budget."},
	"ja": {"WAITING": "接続用QRコードをスマホで読み取ってください。", "CONNECTED": "暗号化接続が成立しました。", "PEER_SCANNED": "送信側で読み取りが完了しました。送信を待っています。", "RECEIVED": "受信内容を標準出力に書き出しました。", "REJECTED": "この内容には--jsonlが必要です。--jsonlで起動し直してください。", "DISCONNECTED": "接続が切れました。", "RECONNECTING": "サービスへ再接続しています。", "QR_REFRESHED": "新しい接続用QRです。以前のQRは使用できません。", "SESSION_EXPIRED": "無操作期限に達しました。", "ACK_UNCONFIRMED": "出力は成功しましたが、受領確認の配送を確認できませんでした。", "ERROR": "処理を完了できませんでした。", "ARGUMENT_ERROR": "引数または公開HTTPS originが不正です。", "DISPLAY_ERROR": "対応端末（推奨80桁×34行以上）または--qr off --pairing-urlを使用してください。QRが崩れる場合は--qr fullを試してください。", "WARNING": "QR全体が見えるよう端末を縦に広げてください。崩れる場合は--qr fullを試してください。", "TIMEOUT": "受信待機期限に達しました。", "PROTOCOL_ERROR": "安全な通信の検証に失敗しました。", "IO_ERROR": "必要な出力先へ書き込めませんでした。", "CONNECT_ERROR": "回復期限内に接続できませんでした。"},
	"es": {"WAITING": "Escanee el QR de conexión con su teléfono.", "CONNECTED": "Conexión cifrada establecida.", "PEER_SCANNED": "QR leído. Esperando el envío.", "RECEIVED": "Contenido escrito en la salida estándar.", "REJECTED": "Este contenido requiere --jsonl. Reinicie qrtoss con --jsonl.", "DISCONNECTED": "Conexión cerrada.", "RECONNECTING": "Reconectando al servicio.", "QR_REFRESHED": "Nuevo QR. El anterior ya no es válido.", "SESSION_EXPIRED": "La sesión caducó por inactividad.", "ACK_UNCONFIRMED": "Salida correcta; no se pudo confirmar la entrega del acuse.", "ERROR": "No se pudo completar la operación.", "ARGUMENT_ERROR": "Argumentos u origen HTTPS público no válidos.", "DISPLAY_ERROR": "Use un terminal compatible (80 columnas × 34 filas recomendadas) o --qr off --pairing-url. Pruebe --qr full si el QR se deforma.", "WARNING": "Aumente la altura del terminal para mostrar el QR completo. Pruebe --qr full si se deforma.", "TIMEOUT": "Se agotó el tiempo de espera.", "PROTOCOL_ERROR": "Falló la validación del protocolo seguro.", "IO_ERROR": "No se pudo escribir en la salida requerida.", "CONNECT_ERROR": "No se pudo establecer la conexión dentro del plazo."},
}

type terminal struct {
	out             io.Writer
	env             Env
	options         Options
	tty, ansi, utf8 bool
	width, height   int
}

func newTerminal(w io.Writer, o Options, env Env) (*terminal, error) {
	t := &terminal{out: w, env: env, options: o}
	if f, ok := w.(*os.File); ok {
		t.tty = term.IsTerminal(int(f.Fd()))
		if t.tty {
			t.width, t.height, _ = term.GetSize(int(f.Fd()))
		}
	}
	locale := ""
	for _, k := range []string{"LC_ALL", "LC_CTYPE", "LANG"} {
		if env(k) != "" {
			locale = strings.ToUpper(env(k))
			break
		}
	}
	t.utf8 = strings.Contains(locale, "UTF-8") || strings.Contains(locale, "UTF8")
	t.ansi = t.tty && env("TERM") != "dumb" && env("TERM") != "" && o.Color != "never" && (env("NO_COLOR") == "" || o.Color == "always")
	if !t.tty && oneOf(o.QR, "compact", "full") {
		return t, fmt.Errorf("DISPLAY_ERROR")
	}
	if !t.tty && !o.PairingURL {
		return t, fmt.Errorf("DISPLAY_ERROR")
	}
	if o.QR == "compact" && !t.utf8 {
		return t, fmt.Errorf("DISPLAY_ERROR")
	}
	if o.QR != "off" && env("TERM") == "dumb" && !o.PairingURL {
		return t, fmt.Errorf("DISPLAY_ERROR")
	}
	return t, nil
}
func (t *terminal) event(k string) error {
	m := messages[t.options.Lang]
	if m == nil {
		m = messages["en"]
	}
	s := m[k]
	if s == "" {
		s = m["ERROR"]
	}
	_, e := fmt.Fprintf(t.out, "[%s] %s\n", k, s)
	return e
}
func (t *terminal) pairing(s string) error {
	if f, ok := t.out.(*os.File); ok && t.tty {
		t.width, t.height, _ = term.GetSize(int(f.Fd()))
	}
	if t.options.QR != "off" && t.tty && t.env("TERM") != "dumb" {
		mode := t.options.QR
		if mode == "auto" {
			if t.utf8 {
				mode = "compact"
			} else if t.ansi {
				mode = "full"
			} else {
				mode = "off"
			}
		}
		matrix, e := pairingMatrix(s)
		if e != nil {
			return e
		}
		n := len(matrix)
		width, height := n, (n+1)/2
		if mode == "full" {
			width, height = 2*n, n
		}
		if mode == "off" || t.width < width {
			if !t.options.PairingURL {
				return fmt.Errorf("DISPLAY_ERROR")
			}
		} else {
			if t.height < height {
				if e = t.event("WARNING"); e != nil {
					return e
				}
			}
			if _, e = io.WriteString(t.out, renderQR(matrix, mode, t.ansi, strings.Contains(t.env("TERM"), "256color") || t.env("COLORTERM") != "")); e != nil {
				return e
			}
		}
	}
	if t.options.PairingURL {
		_, e := fmt.Fprintln(t.out, s)
		return e
	}
	return nil
}

// pairingMatrix uses the library's Unicode encoder, whose mode is QR byte mode
// (UTF-8 bytes, without an ECI header), rather than its automatic segmentation.
// The encoder returns only the symbol; the display adapter adds the mandatory
// four light modules on each edge before calculating terminal dimensions.
func pairingMatrix(content string) ([][]bool, error) {
	code, err := qr.Encode(content, qr.M, qr.Unicode)
	if err != nil {
		return nil, err
	}
	bounds := code.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	matrix := make([][]bool, height+8)
	for y := range matrix {
		matrix[y] = make([]bool, width+8)
	}
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			r, g, b, _ := code.At(bounds.Min.X+x, bounds.Min.Y+y).RGBA()
			matrix[y+4][x+4] = r == 0 && g == 0 && b == 0
		}
	}
	return matrix, nil
}
func renderQR(m [][]bool, mode string, ansi, fixed bool) string {
	var b strings.Builder
	n := len(m)
	black, white := "\x1b[30;107m", "\x1b[97;107m"
	if fixed {
		black, white = "\x1b[38;5;16;48;5;231m", "\x1b[38;5;231;48;5;231m"
	}
	if mode == "full" {
		for y := 0; y < n; y++ {
			for x := 0; x < n; x++ {
				if ansi {
					if m[y][x] {
						if fixed {
							b.WriteString("\x1b[48;5;16m")
						} else {
							b.WriteString("\x1b[40m")
						}
					} else {
						if fixed {
							b.WriteString("\x1b[48;5;231m")
						} else {
							b.WriteString("\x1b[107m")
						}
					}
					b.WriteString("  ")
				} else if m[y][x] {
					b.WriteString("██")
				} else {
					b.WriteString("  ")
				}
			}
			if ansi {
				b.WriteString("\x1b[0m")
			}
			b.WriteByte('\n')
		}
	} else {
		for y := 0; y < n; y += 2 {
			if ansi {
				b.WriteString(black)
			}
			for x := 0; x < n; x++ {
				top := m[y][x]
				bottom := y+1 < n && m[y+1][x]
				switch {
				case top && bottom:
					b.WriteRune('█')
				case top:
					b.WriteRune('▀')
				case bottom:
					b.WriteRune('▄')
				default:
					if ansi {
						b.WriteString(white)
					}
					b.WriteByte(' ')
					if ansi {
						b.WriteString(black)
					}
				}
			}
			if ansi {
				b.WriteString("\x1b[0m")
			}
			b.WriteByte('\n')
		}
	}
	return b.String()
}
func help(lang string) string {
	intro := map[string]string{"en": "Receive one QR value, write it to stdout, then exit. QR and status use stderr.", "ja": "QRの内容を1件受信して標準出力へ書き出し、終了します。QRと状態は標準エラー出力です。", "es": "Reciba un valor QR, escríbalo en stdout y termine. El QR y el estado usan stderr."}[lang]
	tips := map[string]string{"en": "Use an 80×34 or larger terminal. Try --qr full for ambiguous-width characters or distorted QR, and adjust terminal line spacing/theme and --color. --pairing-url explicitly exposes the secret URL on stderr; --qr off --pairing-url works without a TTY. --jsonl supports newlines and control characters. SSH is supported. Do not combine streams with 2>&1 when capturing data. localhost may be unreachable from your phone.", "ja": "端末は80桁×34行以上を推奨します。曖昧幅やQRの崩れには--qr fullを使用し、行間・テーマと--colorを調整してください。--pairing-urlは秘密を含むURLを標準エラーへ表示します。非TTYでは--qr off --pairing-urlを指定します。改行・制御文字には--jsonlを使用します。SSHに対応します。受信データを保存するときは2>&1で出力を混ぜないでください。localhostはスマホから到達できない場合があります。", "es": "Use un terminal de al menos 80×34. Pruebe --qr full si el QR se deforma; ajuste el interlineado, el tema y --color. --pairing-url muestra la URL secreta en stderr; --qr off --pairing-url funciona sin TTY. --jsonl admite saltos de línea y caracteres de control. Compatible con SSH. No combine los flujos con 2>&1 al capturar datos. localhost puede no ser accesible desde el teléfono."}[lang]
	return intro + "\n\nqrtoss [--timeout SECONDS] [--format text|jsonl] [--jsonl]\n       [--qr auto|compact|full|off] [--pairing-url]\n       [--color auto|always|never] [--lang auto|ja|en|es] [--server URL]\nqrtoss --help\nqrtoss --version\n\n" + tips + "\n"
}
