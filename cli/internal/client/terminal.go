package client

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/boombuler/barcode/qr"
	"golang.org/x/term"
)

var messages = map[string]string{
	"REJECTED":        "This content requires --jsonl. Start qrtoss again with --jsonl.",
	"ACK_UNCONFIRMED": "Output succeeded; receipt delivery could not be confirmed.",
	"ERROR":           "Could not complete the operation.",
	"ARGUMENT_ERROR":  "Invalid arguments or public HTTPS origin.",
	"DISPLAY_ERROR":   "Use a compatible terminal (80 columns × 34 rows recommended) or --qr off --pairing-url. Try --qr full if the QR is distorted.",
	"WARNING":         "Increase terminal height to show the entire QR. If distorted, try --qr full.",
	"TIMEOUT":         "Receive waiting time expired.",
	"PROTOCOL_ERROR":  "The secure protocol validation failed.",
	"IO_ERROR":        "Could not write to the required output.",
	"CONNECT_ERROR":   "Could not establish a connection within the recovery budget.",
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
	// Routine lifecycle events are intentionally silent; keep actionable diagnostics.
	if oneOf(k, "CONNECTED", "PEER_SCANNED", "RECEIVED", "RECONNECTING", "QR_REFRESHED", "DISCONNECTED", "SESSION_EXPIRED") {
		return nil
	}
	if k == "WAITING" {
		_, err := fmt.Fprintln(t.out, "Scan this QR code with your phone’s camera")
		return err
	}
	m := messages
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
func help(_ string) string {
	return "Receive one QR value, write it to stdout, then exit. Pairing instructions and errors use stderr.\n\n" +
		"qrtoss [--timeout SECONDS] [--format text|jsonl] [--jsonl]\n       [--qr auto|compact|full|off] [--pairing-url]\n       [--color auto|always|never] [--server URL]\nqrtoss --help\nqrtoss --version\n\n" +
		"Use an 80×34 or larger terminal. Try --qr full if the QR is distorted. --pairing-url explicitly exposes the secret URL on stderr; --qr off --pairing-url works without a TTY. --jsonl supports newlines and control characters. Do not combine streams with 2>&1 when capturing data. All CLI messages are in English.\n"
}
