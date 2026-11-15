package client

import (
	"bytes"
	"errors"
	"fmt"
	"github.com/wistaria/qrtoss/cli/internal/constants"
	"io"
	"unicode/utf8"
)

var ErrUnsupported = errors.New("unsupported_content")

func unsafeRune(r rune) bool {
	return r <= 0x1f || (r >= 0x7f && r <= 0x9f) || r == 0x2028 || r == 0x2029 || r == 0x61c || r == 0x200e || r == 0x200f || (r >= 0x202a && r <= 0x202e) || (r >= 0x2066 && r <= 0x2069)
}

// Record validates the complete input before producing any stdout bytes.
func Record(text, format string) ([]byte, error) {
	if len(text) == 0 || len(text) > constants.MAX_TEXT_UTF8_BYTES || !utf8.ValidString(text) {
		return nil, errors.New("invalid content")
	}
	if format == "text" {
		for _, r := range text {
			if unsafeRune(r) {
				return nil, ErrUnsupported
			}
		}
		return []byte(text + "\n"), nil
	}
	var b bytes.Buffer
	b.WriteString(`{"text":"`)
	for _, r := range text {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\t':
			b.WriteString(`\t`)
		case '\n':
			b.WriteString(`\n`)
		case '\f':
			b.WriteString(`\f`)
		case '\r':
			b.WriteString(`\r`)
		default:
			if unsafeRune(r) {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteString("\"}\n")
	return b.Bytes(), nil
}
func writeRecord(w io.Writer, b []byte) error {
	n, e := w.Write(b)
	if e != nil {
		return e
	}
	if n != len(b) {
		return io.ErrShortWrite
	}
	if f, ok := w.(interface{ Flush() error }); ok {
		return f.Flush()
	}
	return nil
}
