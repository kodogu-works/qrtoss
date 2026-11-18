package client

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func environment(values map[string]string) Env { return func(k string) string { return values[k] } }
func TestOptions(t *testing.T) {
	env := environment(map[string]string{"LANG": "ja_JP.UTF-8"})
	good := [][]string{{}, {"--timeout", "120"}, {"--timeout=0"}, {"--jsonl", "--format=jsonl"}, {"--qr", "off", "--pairing-url"}, {"--server", "HTTPS://QRTOSS.Example:443/"}, {"--help", "--unknown"}}
	for _, args := range good {
		if _, e := Parse(args, env); e != nil {
			t.Errorf("%v: %v", args, e)
		}
	}
	bad := [][]string{{"--once"}, {"-timeout", "1"}, {"arg"}, {"--timeout", "01"}, {"--timeout", "-1"}, {"--timeout", "2147483648"}, {"--timeout", "1.0"}, {"--timeout", "+1"}, {"--timeout"}, {"--timeout", "1", "--timeout", "2"}, {"--jsonl", "--format", "text"}, {"--format=text", "--jsonl"}, {"--qr=off"}, {"--pairing-url=true"}, {"--server", "http://example.org"}, {"--server", "https://a.example/path"}, {"--server", "https://a.example?"}, {"--server", "https://a.example#"}, {"--server", "https://a.example."}, {"--server", "https://user@a.example"}}
	for _, args := range bad {
		if _, e := Parse(args, env); e == nil {
			t.Errorf("accepted %v", args)
		}
	}
	o, e := Parse([]string{"--server", "HTTPS://QRTOSS.Example:443/"}, env)
	if e != nil || o.Server != "https://qrtoss.example" || o.Lang != "en" {
		t.Fatalf("normalization: %+v %v", o, e)
	}
	for _, locale := range []string{"_", ".", "@", "C", "fr_FR", ""} {
		if got := language("auto", environment(map[string]string{"LANG": locale})); got != "en" {
			t.Errorf("locale %q: %q", locale, got)
		}
	}
}

func TestRecords(t *testing.T) {
	cases := []struct{ text, want string }{{"こんにちは😀\nqrtoss", "7b2274657874223a22e38193e38293e381abe381a1e381aff09f98805c6e7172746f7373227d0a"}, {"a\x1bb\u202ec\u0085d\"e\\f", "7b2274657874223a22615c7530303162625c7532303265635c7530303835645c22655c5c66227d0a"}}
	for _, tt := range cases {
		b, e := Record(tt.text, "jsonl")
		if e != nil || hex.EncodeToString(b) != tt.want {
			t.Errorf("record: %x %v", b, e)
		}
		if _, e = Record(tt.text, "text"); e != ErrUnsupported {
			t.Error("unsafe text accepted")
		}
	}
	for _, text := range []string{" https://example.org/a?x=%20 ", "mailto:a@example.org", "tel:+81312345678", "custom:hello", "\ufeffhello", "e\u0301", "<>&"} {
		b, e := Record(text, "text")
		if e != nil || string(b) != text+"\n" {
			t.Errorf("changed text: %q %v", b, e)
		}
		b, e = Record(text, "jsonl")
		var obj map[string]string
		if e != nil || json.Unmarshal(b, &obj) != nil || obj["text"] != text {
			t.Error("JSONL did not roundtrip")
		}
	}
	for _, text := range []string{"", strings.Repeat("a", 16385), string([]byte{0xff})} {
		if _, e := Record(text, "jsonl"); e == nil {
			t.Error("invalid text accepted")
		}
	}
	if _, e := Record(strings.Repeat("a", 16384), "text"); e != nil {
		t.Fatal(e)
	}
}

type shortWriter struct{}

func (shortWriter) Write(b []byte) (int, error) { return len(b) - 1, nil }

type failingFlusher struct{ bytes.Buffer }

func (*failingFlusher) Flush() error { return errors.New("flush failed") }
func TestWriteBoundary(t *testing.T) {
	if e := writeRecord(shortWriter{}, []byte("abc")); e != io.ErrShortWrite {
		t.Fatal(e)
	}
	if e := writeRecord(&failingFlusher{}, []byte("abc")); e == nil {
		t.Fatal("flush failure accepted")
	}
}

func TestCryptoVectors(t *testing.T) {
	b, e := os.ReadFile("../../../protocol/vectors/crypto.json")
	if e != nil {
		t.Fatal(e)
	}
	var f struct {
		Room, Peer, PSK, RNonce, SNonce, SenderProof, ReceiverProof string
		Messages                                                    []json.RawMessage
		Ciphertexts                                                 []string
	}
	if e = json.Unmarshal(b, &f); e != nil {
		t.Fatal(e)
	}
	psk, _ := Decode(f.PSK, 32)
	k, e := Derive(psk, f.Room, f.Peer, f.RNonce, f.SNonce)
	if e != nil {
		t.Fatal(e)
	}
	for _, tt := range []struct {
		b    []byte
		want string
	}{{k.Proof, "b72b013d52b295c6dc523bccc3c2d43d44c5f4ee15624f4720823549da598657"}, {k.S2R, "e2a2edc48b145d82f1cb41737a0961059eccddfdba947e669038f3b3b3671fe3"}, {k.R2S, "ffd2be59a154add5aef5a7c7b62935c228d28cdbd434c1f05ed3761eaf3a6b40"}} {
		if hex.EncodeToString(tt.b) != tt.want {
			t.Errorf("key mismatch %x", tt.b)
		}
	}
	hash := sha256.Sum256(k.Transcript)
	if hex.EncodeToString(hash[:]) != "1d2e61308b333f272ee4a140076d6e344c8e470a9fac5bc6c231a4c56f79a095" {
		t.Fatal("transcript mismatch")
	}
	if B64(k.MAC("sender")) != f.SenderProof || B64(k.MAC("receiver")) != f.ReceiverProof {
		t.Fatal("proof mismatch")
	}
	dirs := []string{"s2r", "r2s", "r2s", "s2r", "r2s"}
	seqs := []uint64{0, 0, 1, 1, 2}
	for i, raw := range f.Messages {
		var compact bytes.Buffer
		if e = json.Compact(&compact, raw); e != nil {
			t.Fatal(e)
		}
		key := k.S2R
		if dirs[i] == "r2s" {
			key = k.R2S
		}
		env, e := Seal(key, f.Room, f.Peer, dirs[i], seqs[i], compact.Bytes())
		if e != nil || env.CT != f.Ciphertexts[i] {
			t.Errorf("vector %d mismatch %v\n%s", i, e, env.CT)
		}
	}
	c := Cipher{Room: f.Room, Peer: f.Peer, Keys: k}
	env, e := Seal(k.S2R, f.Room, f.Peer, "s2r", 0, []byte(`{"type":"ready"}`))
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(env)
	if _, e = c.Decrypt(raw); e != nil {
		t.Fatal(e)
	}
	if _, e = c.Decrypt(raw); e == nil {
		t.Fatal("replay accepted")
	}
	env, e = Seal(k.S2R, f.Room, f.Peer, "s2r", 1, []byte(`{"type":"activity","type":"activity"}`))
	if e != nil {
		t.Fatal(e)
	}
	raw, _ = json.Marshal(env)
	if _, e = c.Decrypt(raw); e == nil {
		t.Fatal("duplicate inner key accepted")
	}
	if c.Recv != 1 {
		t.Fatal("invalid payload consumed sequence")
	}
	env, e = Seal(k.S2R, f.Room, f.Peer, "s2r", 1, []byte(`{"type":"ready_ack"}`))
	if e != nil {
		t.Fatal(e)
	}
	raw, _ = json.Marshal(env)
	if _, e = c.Decrypt(raw); e == nil {
		t.Fatal("wrong direction message accepted")
	}
	env, e = Seal(k.S2R, f.Room, f.Peer, "s2r", 1, []byte(`{"type":"activity"}`))
	if e != nil {
		t.Fatal(e)
	}
	env.CT = "A" + env.CT[1:]
	raw, _ = json.Marshal(env)
	if _, e = c.Decrypt(raw); e == nil {
		t.Fatal("tampered ciphertext accepted")
	}
}
func TestCanonicalBase64(t *testing.T) {
	for _, s := range []string{"YQ=", "YQ\n", "YQ ", "YR", "+A", ""} {
		if _, e := Decode(s, -1); e == nil {
			t.Errorf("accepted %q", s)
		}
	}
	if b, e := Decode("YQ", 1); e != nil || string(b) != "a" {
		t.Fatal(e)
	}
}
func TestStrictControl(t *testing.T) {
	for _, raw := range []string{`{"v":1,"v":1,"type":"room.closed","code":"PEER_CLOSED"}`, `{"v":1,"type":"room.closed","code":"PEER_CLOSED","extra":0}`, `{"v":1,"type":"hb.pong","id":1.1,"serverTime":1}`, `{"v":1,"type":"hb.pong","id":null,"serverTime":1}`, `{"v":1,"type":"room.closed","code":"PEER_CLOSED"}null`} {
		if _, e := control([]byte(raw)); e == nil {
			t.Errorf("accepted %s", raw)
		}
	}
}
func TestNoTTYDoesNotContactServer(t *testing.T) {
	var out, err bytes.Buffer
	r := Runner{Out: &out, Err: &err, Env: environment(nil)}
	if code := r.Run(context.Background(), nil); code != 2 {
		t.Fatalf("got %d", code)
	}
	if out.Len() != 0 || strings.Contains(err.String(), "/send#") {
		t.Fatal("secret/output leaked")
	}
	out.Reset()
	if code := r.Run(context.Background(), []string{"--help", "--unknown"}); code != 0 || !strings.Contains(out.String(), "--pairing-url") {
		t.Fatalf("help: %d", code)
	}
}
func TestQRDimensions(t *testing.T) {
	m := [][]bool{{false, false, false, false}, {false, true, false, false}, {false, false, false, false}, {false, false, false, false}}
	for _, mode := range []string{"compact", "full"} {
		s := renderQR(m, mode, false, false)
		lines := strings.Split(strings.TrimSuffix(s, "\n"), "\n")
		want := 2
		if mode == "full" {
			want = 4
		}
		if len(lines) != want {
			t.Fatalf("%s rows %d", mode, len(lines))
		}
	}
	if strings.Contains(renderQR(m, "compact", false, false), "\x1b") {
		t.Fatal("ANSI in no-color QR")
	}
}

func TestPairingQRByteModeAndQuietZone(t *testing.T) {
	for _, tt := range []struct{ length, modules int }{{152, 57}, {153, 61}, {180, 61}, {181, 65}, {213, 65}} {
		// Numeric-only data is deliberately chosen: an automatic encoder would
		// select numeric mode and violate these byte-mode capacity boundaries.
		m, err := pairingMatrix(strings.Repeat("1", tt.length))
		if err != nil {
			t.Fatal(err)
		}
		if len(m) != tt.modules {
			t.Fatalf("%d bytes: modules=%d want=%d", tt.length, len(m), tt.modules)
		}
		for y, row := range m {
			if len(row) != tt.modules {
				t.Fatal("nonsquare QR")
			}
			for x, dark := range row {
				if (x < 4 || y < 4 || x >= len(row)-4 || y >= len(m)-4) && dark {
					t.Fatalf("dark quiet zone at %d,%d", x, y)
				}
			}
		}
		if !m[4][4] || !m[4][len(m)-5] || !m[len(m)-5][4] {
			t.Fatal("finder corners missing")
		}
	}
	url := "https://qrtoss.example/send#v=1&r=" + strings.Repeat("A", 22) + "&j=" + strings.Repeat("A", 43) + "&k=" + strings.Repeat("A", 43)
	m, err := pairingMatrix(url)
	if err != nil || len(m) != 57 {
		t.Fatalf("standard pairing URL: %v modules=%d", err, len(m))
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestHTTPBoundary(t *testing.T) {
	for _, status := range []int{http.StatusTemporaryRedirect, http.StatusNotFound, http.StatusForbidden} {
		var out, diagnostics bytes.Buffer
		calls := 0
		transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
			calls++
			if req.Header.Get("Origin") != "https://example.org" || req.Header.Get("Content-Type") != "application/json" {
				t.Error("missing request contract")
			}
			if req.Header.Get("User-Agent") != "qrtoss/"+Version {
				t.Error("missing application User-Agent")
			}
			body, _ := io.ReadAll(req.Body)
			if string(body) != `{"v":1}` {
				t.Error("unexpected body")
			}
			return &http.Response{StatusCode: status, Header: http.Header{"Location": []string{"https://elsewhere.example"}}, Body: io.NopCloser(strings.NewReader("")), Request: req}, nil
		})
		runner := Runner{Out: &out, Err: &diagnostics, Env: environment(nil), HTTPClient: &http.Client{Transport: transport}}
		if code := runner.Run(context.Background(), []string{"--server", "https://example.org", "--qr", "off", "--pairing-url"}); code != 2 {
			t.Fatalf("status %d gave %d", status, code)
		}
		if calls != 1 || out.Len() != 0 {
			t.Fatal("redirect followed or stdout polluted")
		}
	}
}
func TestWaitingDeadlineIncludesConnect(t *testing.T) {
	var out, diagnostics bytes.Buffer
	calls := 0
	transport := roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		<-req.Context().Done()
		return nil, req.Context().Err()
	})
	runner := Runner{Out: &out, Err: &diagnostics, Env: environment(nil), HTTPClient: &http.Client{Transport: transport}}
	start := time.Now()
	code := runner.Run(context.Background(), []string{"--server", "https://example.org", "--qr", "off", "--pairing-url", "--timeout", "1"})
	if code != 124 || calls != 1 || time.Since(start) > 2*time.Second || out.Len() != 0 {
		t.Fatalf("deadline: code=%d calls=%d time=%v output=%q", code, calls, time.Since(start), out.String())
	}
}

func TestReceiverActivity(t *testing.T) {
	now := time.Now()
	a := receiverActivity{}
	deadline := now.Add(30 * time.Minute)
	a.record(now)
	if !a.due(now, deadline) {
		t.Fatal("first activity must send")
	}
	a.sent, a.pending = now, false
	a.record(now.Add(time.Second))
	if a.due(now.Add(time.Second), deadline) {
		t.Fatal("activity must coalesce")
	}
	if !a.due(now.Add(15*time.Second), deadline) {
		t.Fatal("last activity must be sent later")
	}
	a.sent, a.pending = now.Add(15*time.Second), false
	if a.expired(now.Add(30 * time.Minute)) {
		t.Fatal("expiry must follow activity, not initial touch")
	}
	if !a.expired(now.Add(30*time.Minute + time.Second)) {
		t.Fatal("local idle boundary must expire")
	}
	if a.due(now.Add(30*time.Second), deadline) {
		t.Fatal("no activity must not send")
	}
	a.record(now.Add(16 * time.Second))
	if !a.due(now.Add(16*time.Second), now.Add(17*time.Second)) {
		t.Fatal("urgent activity must bypass coalescing")
	}
}

func TestEnvelopeFieldCase(t *testing.T) {
	key := make([]byte, 32)
	env, err := Seal(key, "room", "peer", "s2r", 0, []byte(`{"type":"ready"}`))
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(env)
	for _, field := range []string{"v", "type", "room", "peer", "dir", "seq", "ct"} {
		bad := bytes.Replace(raw, []byte(`"`+field+`":`), []byte(`"`+strings.ToUpper(field)+`":`), 1)
		c := Cipher{Room: "room", Peer: "peer", Keys: Keys{S2R: key}}
		if _, err := c.Decrypt(bad); err == nil {
			t.Fatalf("accepted uppercase %s", field)
		}
		bad = append([]byte(`{"`+strings.ToUpper(field)+`":null,`), raw[1:]...)
		if _, err := c.Decrypt(bad); err == nil {
			t.Fatalf("accepted additional alias %s", field)
		}
		if _, err := c.Decrypt(raw); err != nil {
			t.Fatalf("valid envelope rejected after invalid input: %v", err)
		}
	}
}

func TestEnglishOnlyPresentation(t *testing.T) {
	env := environment(map[string]string{"LANG": "ja_JP.UTF-8", "QRTOSS_LANG": "es"})
	for _, args := range [][]string{nil, {"--lang", "ja"}, {"--lang", "es"}, {"--help"}} {
		options, err := Parse(args, env)
		if err != nil || options.Lang != "en" {
			t.Fatalf("%v: %+v %v", args, options, err)
		}
	}
	if help("ja") != help("en") || !strings.Contains(help("es"), "All CLI messages are in English") {
		t.Fatal("help is not English")
	}
	var out bytes.Buffer
	terminal := &terminal{out: &out, options: Options{Lang: "ja"}}
	for _, event := range []string{"CONNECTED", "PEER_SCANNED", "RECEIVED", "RECONNECTING", "QR_REFRESHED", "DISCONNECTED", "SESSION_EXPIRED"} {
		if err := terminal.event(event); err != nil {
			t.Fatal(err)
		}
	}
	if out.Len() != 0 {
		t.Fatalf("routine output: %q", out.String())
	}
	if err := terminal.event("ARGUMENT_ERROR"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Invalid arguments") {
		t.Fatalf("diagnostic is not English: %q", out.String())
	}
}

func TestReadablePairingExpiry(t *testing.T) {
	fixture := newReceiverFixture(t, io.Discard)
	fixture.session.pairing().deadline = time.Date(2026, 11, 18, 10, 28, 5, 0, time.FixedZone("CST", -6*60*60))
	previous := time.Local
	time.Local = time.FixedZone("CST", -6*60*60)
	t.Cleanup(func() { time.Local = previous })
	fixture.session.terminal.options = Options{QR: "off", PairingURL: true, Lang: "es"}
	if err := fixture.session.showPairing(); err != nil {
		t.Fatal(err)
	}
	expected := "Scan this QR code with your phone’s camera\n[EXPIRES] 2026-11-18 10:28:05 (CST)\nhttps://example.org/send\n"
	if fixture.diagnostics.String() != expected {
		t.Fatalf("pairing display: %q", fixture.diagnostics.String())
	}
}
