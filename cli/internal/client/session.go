package client

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/wistaria/qrtoss/cli/internal/constants"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

type failure struct {
	code       int
	key        string
	retryAfter time.Duration
}

func (f failure) Error() string       { return f.key }
func fail(code int, key string) error { return failure{code, key, 0} }

// Runner's HTTPClient hook is for embedding/tests. TLS verification is always
// enabled by the executable; no insecure CLI option is provided.
type Runner struct {
	Out, Err   io.Writer
	Env        Env
	HTTPClient *http.Client
	Resize     <-chan os.Signal
}

func (r *Runner) Run(ctx context.Context, args []string) int {
	o, e := Parse(args, r.Env)
	if e != nil {
		o.Lang = language("auto", r.Env)
		t := terminal{out: r.Err, options: o}
		_ = t.event("ARGUMENT_ERROR")
		return 2
	}
	if o.Help {
		if e = writeRecord(r.Out, []byte(help(o.Lang))); e != nil {
			return 5
		}
		return 0
	}
	if o.Version {
		if _, e = fmt.Fprintf(r.Out, "qrtoss %s (qrtoss/1, %s)\n", Version, Commit); e != nil {
			return 5
		}
		return 0
	}
	t, e := newTerminal(r.Err, o, r.Env)
	if e != nil {
		_ = t.event("DISPLAY_ERROR")
		return 2
	}
	h := r.HTTPClient
	if h == nil {
		h = &http.Client{Transport: http.DefaultTransport}
	}
	hc := *h
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	var deadline time.Time
	if o.Timeout > 0 {
		deadline = time.Now().Add(o.Timeout)
	}
	recovery := time.Now().Add(30 * time.Second)
	attempt := 0
	for {
		if ctx.Err() != nil {
			return 130
		}
		if !time.Now().Before(recovery) {
			_ = t.event("CONNECT_ERROR")
			return 3
		}
		if !deadline.IsZero() && !time.Now().Before(deadline) {
			_ = t.event("TIMEOUT")
			return 124
		}
		code, err := r.receive(ctx, o, t, &hc, deadline, recovery)
		if err == nil {
			return code
		}
		var f failure
		if !errors.As(err, &f) {
			f = failure{4, "PROTOCOL_ERROR", 0}
		}
		if ctx.Err() != nil {
			return 130
		}
		if f.code != 3 {
			_ = t.event(f.key)
			return f.code
		}
		// A normal room expiry/disconnect starts a fresh bounded recovery period.
		if code == 1 {
			_ = t.event(f.key)
			recovery = time.Now().Add(30 * time.Second)
			attempt = 0
			if e = t.event("QR_REFRESHED"); e != nil {
				return 5
			}
		}
		if !time.Now().Before(recovery) {
			_ = t.event("CONNECT_ERROR")
			return 3
		}
		if e = t.event("RECONNECTING"); e != nil {
			return 5
		}
		wait := time.Duration(1<<min(attempt, 3)) * time.Second
		attempt++
		// Cryptographic randomness is also used for retry jitter, never math/rand.
		jitter, _ := Decode(Random(1), 1)
		wait = time.Duration(float64(wait) * (0.8 + float64(jitter[0])/255*0.4))
		if f.retryAfter > wait {
			wait = f.retryAfter
		}
		until := recovery
		if !deadline.IsZero() && deadline.Before(until) {
			until = deadline
		}
		if remaining := time.Until(until); wait > remaining {
			wait = remaining
		}
		if wait < 0 {
			wait = 0
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return 130
		case <-timer.C:
		}
	}
}

type wireRead struct {
	b []byte
	e error
}

func (r *Runner) receive(ctx context.Context, o Options, t *terminal, h *http.Client, deadline, recovery time.Time) (int, error) {
	attemptEnd := time.Now().Add(15 * time.Second)
	if recovery.Before(attemptEnd) {
		attemptEnd = recovery
	}
	if !deadline.IsZero() && deadline.Before(attemptEnd) {
		attemptEnd = deadline
	}
	attempt, cancel := context.WithDeadline(ctx, attemptEnd)
	defer cancel()
	req, e := http.NewRequestWithContext(attempt, "POST", o.Server+"/api/v1/rooms", strings.NewReader(`{"v":1}`))
	if e != nil {
		return 0, fail(2, "ARGUMENT_ERROR")
	}
	req.Header.Set("Origin", o.Server)
	req.Header.Set("Content-Type", "application/json")
	res, e := h.Do(req)
	if e != nil {
		return 0, networkFailure(e)
	}
	b, e := io.ReadAll(io.LimitReader(res.Body, constants.MAX_CONTROL_MESSAGE_BYTES+1))
	res.Body.Close()
	if e != nil {
		return 0, fail(3, "CONNECT_ERROR")
	}
	if res.StatusCode != 201 {
		if res.StatusCode >= 300 && res.StatusCode < 400 || res.StatusCode == 404 || res.StatusCode == 403 {
			return 0, fail(2, "ARGUMENT_ERROR")
		}
		if res.StatusCode == 429 || res.StatusCode >= 500 {
			f := failure{3, "CONNECT_ERROR", 0}
			if v, e := strconv.ParseUint(res.Header.Get("Retry-After"), 10, 31); e == nil {
				f.retryAfter = time.Duration(v) * time.Second
			}
			return 0, f
		}
		return 0, fail(4, "PROTOCOL_ERROR")
	}
	var room struct {
		V                int    `json:"v"`
		Room             string `json:"room"`
		ReceiverCap      string `json:"receiverCap"`
		SenderJoinCap    string `json:"senderJoinCap"`
		ServerTime       int64  `json:"serverTime"`
		PairingExpiresAt int64  `json:"pairingExpiresAt"`
	}
	if len(b) > constants.MAX_CONTROL_MESSAGE_BYTES || strict(b, &room) != nil || room.V != 1 || room.PairingExpiresAt <= room.ServerTime {
		return 0, fail(4, "PROTOCOL_ERROR")
	}
	var roomFields map[string]json.RawMessage
	if strict(b, &roomFields) != nil || fieldsOnly(roomFields, "v", "room", "receiverCap", "senderJoinCap", "serverTime", "pairingExpiresAt") != nil || room.ServerTime < 0 || room.PairingExpiresAt-room.ServerTime > constants.PAIRING_TTL_SECONDS*1000 {
		return 0, fail(4, "PROTOCOL_ERROR")
	}
	for _, v := range []struct {
		s string
		n int
	}{{room.Room, 16}, {room.ReceiverCap, 32}, {room.SenderJoinCap, 32}} {
		if _, e = Decode(v.s, v.n); e != nil {
			return 0, fail(4, "PROTOCOL_ERROR")
		}
	}
	wsurl := "wss" + strings.TrimPrefix(o.Server, "https") + "/ws"
	conn, resp, e := websocket.Dial(attempt, wsurl, &websocket.DialOptions{HTTPClient: h, HTTPHeader: http.Header{"Origin": []string{o.Server}}, Subprotocols: []string{"qrtoss.v1"}, CompressionMode: websocket.CompressionDisabled})
	if e != nil {
		if resp != nil && (resp.StatusCode == 403 || resp.StatusCode == 404 || resp.StatusCode >= 300 && resp.StatusCode < 400) {
			return 0, fail(2, "ARGUMENT_ERROR")
		}
		return 0, networkFailure(e)
	}
	defer conn.CloseNow()
	if conn.Subprotocol() != "qrtoss.v1" {
		return 0, fail(4, "PROTOCOL_ERROR")
	}
	conn.SetReadLimit(constants.MAX_WS_MESSAGE_BYTES)
	write := func(v any, until time.Time) error {
		d := time.Now().Add(15 * time.Second)
		if !until.IsZero() && until.Before(d) {
			d = until
		}
		c, done := context.WithDeadline(ctx, d)
		defer done()
		data, e := json.Marshal(v)
		if e != nil {
			return e
		}
		return conn.Write(c, websocket.MessageText, data)
	}
	ctl := func(kind string, fields map[string]any, until time.Time) error {
		if fields == nil {
			fields = map[string]any{}
		}
		fields["v"] = 1
		fields["type"] = kind
		return write(fields, until)
	}
	if e = ctl("auth", map[string]any{"role": "receiver", "room": room.Room, "cap": room.ReceiverCap}, attemptEnd); e != nil {
		return 0, fail(3, "CONNECT_ERROR")
	}
	authDeadline := time.Now().Add(constants.AUTH_TIMEOUT_SECONDS * time.Second)
	if attemptEnd.Before(authDeadline) {
		authDeadline = attemptEnd
	}
	authctx, authCancel := context.WithDeadline(ctx, authDeadline)
	defer authCancel()
	mt, raw, e := conn.Read(authctx)
	if e != nil {
		return 0, networkFailure(e)
	}
	if mt != websocket.MessageText {
		return 0, fail(4, "PROTOCOL_ERROR")
	}
	auth, e := control(raw)
	if e != nil {
		return 0, fail(4, "PROTOCOL_ERROR")
	}
	if str(auth, "type") == "error" {
		return 0, codeFailure(str(auth, "code"))
	}
	if str(auth, "type") != "auth.ok" || str(auth, "room") != room.Room {
		return 0, fail(4, "PROTOCOL_ERROR")
	}
	// A fresh session's long-lived reads use a separate context, not connect timeout.
	readctx, stopRead := context.WithCancel(ctx)
	defer stopRead()
	incoming := make(chan wireRead, constants.MAX_RECEIVE_QUEUE_MESSAGES)
	var queuedBytes atomic.Int64
	go func() {
		defer close(incoming)
		for {
			mt, b, e := conn.Read(readctx)
			if e == nil && mt != websocket.MessageText {
				e = fail(4, "PROTOCOL_ERROR")
			}
			if e != nil {
				select {
				case incoming <- wireRead{nil, e}:
				case <-readctx.Done():
				}
				return
			}
			size := int64(len(b))
			if queuedBytes.Add(size) > constants.MAX_SOCKET_BUFFER_BYTES {
				queuedBytes.Add(-size)
				conn.CloseNow()
				select {
				case incoming <- wireRead{nil, fail(4, "PROTOCOL_ERROR")}:
				case <-readctx.Done():
				}
				return
			}
			select {
			case incoming <- wireRead{b, nil}:
			default:
				queuedBytes.Add(-size)
				conn.CloseNow()
				select {
				case incoming <- wireRead{nil, fail(4, "PROTOCOL_ERROR")}:
				case <-readctx.Done():
				}
				return
			}
		}
	}()
	psk, _ := Decode(Random(32), 32)
	pairing := o.Server + "/send#v=1&r=" + room.Room + "&j=" + room.SenderJoinCap + "&k=" + B64(psk)
	if e = t.event("WAITING"); e != nil {
		return 0, fail(5, "IO_ERROR")
	}
	serverTime, _ := integer(auth, "serverTime")
	expires, _ := integer(auth, "pairingExpiresAt")
	pairDeadline := time.Now().Add(time.Duration(expires-serverTime) * time.Millisecond)
	if _, e = fmt.Fprintf(t.out, "[EXPIRES] %s\n", pairDeadline.Format(time.RFC3339)); e != nil {
		return 0, fail(5, "IO_ERROR")
	}
	if e = t.pairing(pairing); e != nil {
		if e.Error() == "DISPLAY_ERROR" {
			return 0, fail(2, "DISPLAY_ERROR")
		}
		return 0, fail(5, "IO_ERROR")
	}
	room.ReceiverCap = ""
	room.SenderJoinCap = ""
	heartbeat := time.NewTicker(constants.HEARTBEAT_INTERVAL_SECONDS * time.Second)
	defer heartbeat.Stop()
	lastPong := time.Now()
	pingID := int64(0)
	lastPongID := int64(-1)
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	var peer, rnonce string
	var keys Keys
	var crypt *Cipher
	var candidateDeadline, readyDeadline, idleDeadline, lastTouch time.Time
	committed, ready, active := false, false, false
	var acceptedID string
	var digest [32]byte
	var outputDone <-chan error
	writing, written, rejected, disconnected := false, false, false, false
	var drain time.Time
	sendCipher := func(v any) error {
		if crypt == nil {
			return errors.New("no keys")
		}
		en, e := crypt.Encrypt(v)
		if e != nil {
			return e
		}
		return write(en, drain)
	}
	sendAck := func() error {
		m := map[string]any{"type": "ack", "id": acceptedID, "status": "received"}
		if rejected {
			m["status"] = "rejected"
			m["reason"] = "unsupported_content"
		}
		return sendCipher(m)
	}
	touch := func() error {
		now := time.Now()
		if !lastTouch.IsZero() && now.Sub(lastTouch) < constants.TOUCH_COALESCE_SECONDS*time.Second && time.Until(idleDeadline) > constants.TOUCH_URGENT_REMAINING_SECONDS*time.Second {
			return nil
		}
		if err := ctl("room.touch", map[string]any{"peer": peer}, drain); err != nil {
			return err
		}
		lastTouch = now
		return nil
	}
	closeRoom := func(reason string) {
		end := time.Now().Add(100 * time.Millisecond)
		if !drain.IsZero() && drain.Before(end) {
			end = drain
		}
		_ = ctl("room.close", map[string]any{"reason": reason}, end)
	}
	defer func() { closeRoom("user_end") }()
	finish := func(unconfirmed bool) (int, error) {
		if written && unconfirmed {
			_ = t.event("ACK_UNCONFIRMED")
		}
		if rejected {
			return 6, nil
		}
		return 0, nil
	}
	violation := func() (int, error) {
		closeRoom("client_error")
		if written {
			_ = t.event("PROTOCOL_ERROR")
			return finish(!drain.IsZero())
		}
		return 0, fail(4, "PROTOCOL_ERROR")
	}
	for {
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-r.Resize:
			if acceptedID == "" && !committed && pairing != "" {
				if err := t.pairing(pairing); err != nil {
					if err.Error() == "DISPLAY_ERROR" {
						return 0, fail(2, "DISPLAY_ERROR")
					}
					return 0, fail(5, "IO_ERROR")
				}
			}
		case <-heartbeat.C:
			if disconnected {
				continue
			}
			if e = ctl("hb.ping", map[string]any{"id": pingID}, drain); e != nil {
				disconnected = true
				if !writing {
					if written || rejected {
						return finish(true)
					}
					return 1, networkFailure(e)
				}
			}
			pingID++
		case <-tick.C:
			now := time.Now()
			if !drain.IsZero() && !now.Before(drain) {
				return finish(true)
			}
			if acceptedID == "" && !deadline.IsZero() && !now.Before(deadline) {
				return 0, fail(124, "TIMEOUT")
			}
			if acceptedID == "" && (!committed && !now.Before(pairDeadline) || committed && !active && !readyDeadline.IsZero() && !now.Before(readyDeadline) || active && !idleDeadline.IsZero() && !now.Before(idleDeadline)) {
				return 1, fail(3, "DISCONNECTED")
			}
			if !disconnected && now.Sub(lastPong) >= constants.HEARTBEAT_TIMEOUT_SECONDS*time.Second {
				disconnected = true
				conn.CloseNow()
				if writing {
					continue
				}
				if written || rejected {
					return finish(true)
				}
				return 1, fail(3, "DISCONNECTED")
			}
		case e := <-outputDone:
			outputDone = nil
			writing = false
			if e != nil {
				return 0, fail(5, "IO_ERROR")
			}
			written = true
			drain = time.Now().Add(2 * time.Second)
			_ = t.event("RECEIVED")
			if disconnected {
				return finish(true)
			}
			if e = sendAck(); e != nil {
				return finish(true)
			}
		case item, ok := <-incoming:
			if !ok || item.e != nil {
				incoming = nil
				disconnected = true
				var fatal failure
				if errors.As(item.e, &fatal) && fatal.code == 4 {
					return violation()
				}
				if writing {
					continue
				}
				if written || rejected {
					return finish(true)
				}
				return 1, fail(3, "DISCONNECTED")
			}
			queuedBytes.Add(-int64(len(item.b)))
			m, err := control(item.b)
			if err != nil {
				return violation()
			}
			kind := str(m, "type")
			if !drain.IsZero() && !time.Now().Before(drain) {
				return finish(true)
			}
			switch kind {
			case "hb.pong":
				id, _ := integer(m, "id")
				if id <= lastPongID || id >= pingID {
					return violation()
				}
				lastPong = time.Now()
				lastPongID = id
			case "pair.candidate":
				if committed || peer != "" {
					return violation()
				}
				peer = str(m, "peer")
				rnonce = Random(32)
				candidateTime, _ := integer(m, "candidateExpiresAt")
				serverTime, _ = integer(m, "serverTime")
				candidateDeadline = time.Now().Add(time.Duration(candidateTime-serverTime) * time.Millisecond)
				if e = ctl("pair.challenge", map[string]any{"peer": peer, "rNonce": rnonce}, time.Time{}); e != nil {
					return 1, fail(3, "DISCONNECTED")
				}
			case "pair.proof":
				if committed || peer == "" || str(m, "peer") != peer || !time.Now().Before(candidateDeadline) || !time.Now().Before(pairDeadline) {
					return violation()
				}
				keys, e = Derive(psk, room.Room, peer, rnonce, str(m, "sNonce"))
				proof, pe := Decode(str(m, "proof"), 32)
				if e != nil || pe != nil || !hmac.Equal(keys.MAC("sender"), proof) {
					_ = ctl("pair.reject", map[string]any{"peer": peer, "code": "AUTH_FAILED"}, time.Time{})
					keys = Keys{}
					continue
				}
				if e = ctl("pair.commit", map[string]any{"peer": peer}, candidateDeadline); e != nil {
					return 1, fail(3, "DISCONNECTED")
				}
			case "pair.candidate_closed":
				if committed || str(m, "peer") != peer {
					return violation()
				}
				peer = ""
				keys = Keys{}
				rnonce = ""
			case "pair.committed":
				if committed || peer == "" || str(m, "peer") != peer || keys.Proof == nil {
					return violation()
				}
				committed = true
				crypt = &Cipher{Room: room.Room, Peer: peer, Keys: keys}
				end, _ := integer(m, "readyExpiresAt")
				st, _ := integer(m, "serverTime")
				readyDeadline = time.Now().Add(time.Duration(end-st) * time.Millisecond)
				if e = ctl("pair.confirm", map[string]any{"peer": peer, "proof": B64(keys.MAC("receiver"))}, readyDeadline); e != nil {
					return 1, fail(3, "DISCONNECTED")
				}
				keys.Proof = nil
				crypt.Keys.Proof = nil
				psk = nil
				pairing = ""
			case "pair.active":
				if !committed || !ready || active || str(m, "peer") != peer {
					return violation()
				}
				active = true
				end, _ := integer(m, "idleExpiresAt")
				st, _ := integer(m, "serverTime")
				idleDeadline = time.Now().Add(time.Duration(end-st) * time.Millisecond)
				if e = t.event("CONNECTED"); e != nil {
					return 0, fail(5, "IO_ERROR")
				}
				if e = sendCipher(map[string]any{"type": "mode", "value": "stdout"}); e != nil {
					return 1, fail(3, "DISCONNECTED")
				}
			case "room.touched":
				if !active || str(m, "peer") != peer {
					return violation()
				}
				end, _ := integer(m, "idleExpiresAt")
				st, _ := integer(m, "serverTime")
				idleDeadline = time.Now().Add(time.Duration(end-st) * time.Millisecond)
			case "room.closed", "error":
				code := str(m, "code")
				if kind == "error" && str(m, "scope") == "candidate" && !committed {
					continue
				}
				f := codeFailure(code)
				if writing {
					disconnected = true
					continue
				}
				if written || rejected {
					return finish(true)
				}
				var ff failure
				errors.As(f, &ff)
				if ff.code == 3 {
					return 1, f
				}
				return 0, f
			case "cipher":
				if crypt == nil || !committed {
					return violation()
				}
				inner, e := crypt.Decrypt(item.b)
				if e != nil {
					return violation()
				}
				it := str(inner, "type")
				if !ready {
					if it != "ready" || crypt.Recv != 1 || !time.Now().Before(readyDeadline) {
						return violation()
					}
					ready = true
					if e = sendCipher(map[string]any{"type": "ready_ack"}); e != nil {
						return 1, fail(3, "DISCONNECTED")
					}
					if e = ctl("pair.active", map[string]any{"peer": peer}, readyDeadline); e != nil {
						return 1, fail(3, "DISCONNECTED")
					}
					continue
				}
				if !active {
					return violation()
				}
				switch it {
				case "activity", "status":
					if it == "status" && str(inner, "state") == "scanned" && acceptedID == "" {
						if e = t.event("PEER_SCANNED"); e != nil {
							return 0, fail(5, "IO_ERROR")
						}
					}
					if acceptedID == "" {
						_ = touch()
					}
				case "data":
					id := str(inner, "id")
					text, _ := Decode(str(inner, "textB64"), -1)
					hash := sha256.Sum256(text)
					if acceptedID != "" {
						if id != acceptedID || hash != digest {
							return violation()
						}
						if writing {
							continue
						}
						if e = sendAck(); e != nil {
							return finish(true)
						}
						continue
					}
					if !deadline.IsZero() && !time.Now().Before(deadline) {
						return 0, fail(124, "TIMEOUT")
					}
					acceptedID = id
					digest = hash
					record, e := Record(string(text), o.Format)
					text = nil
					if e == ErrUnsupported {
						rejected = true
						drain = time.Now().Add(2 * time.Second)
						_ = t.event("REJECTED")
						if e = sendAck(); e != nil {
							return finish(false)
						}
						continue
					}
					if e != nil {
						return violation()
					}
					_ = touch()
					writing = true
					done := make(chan error, 1)
					outputDone = done
					go func() { done <- writeRecord(r.Out, record) }()
				case "ack_seen":
					if acceptedID == "" || writing || str(inner, "id") != acceptedID {
						return violation()
					}
					return finish(false)
				default:
					return violation()
				}
			default:
				return violation()
			}
		}
	}
}
func networkFailure(e error) error {
	var unknown x509.UnknownAuthorityError
	var host x509.HostnameError
	var invalid x509.CertificateInvalidError
	if errors.As(e, &unknown) || errors.As(e, &host) || errors.As(e, &invalid) {
		return fail(4, "PROTOCOL_ERROR")
	}
	return fail(3, "CONNECT_ERROR")
}
func codeFailure(code string) error {
	switch code {
	case "SESSION_EXPIRED":
		return fail(3, "SESSION_EXPIRED")
	case "PAIR_UNAVAILABLE", "PAIR_EXPIRED", "PAIR_TIMEOUT", "READY_TIMEOUT", "PEER_CLOSED", "SLOW_PEER", "CAPACITY", "SERVER_SHUTDOWN", "SERVER_ERROR", "RATE_LIMITED":
		return fail(3, "DISCONNECTED")
	case "ORIGIN_DENIED":
		return fail(2, "ARGUMENT_ERROR")
	default:
		return fail(4, "PROTOCOL_ERROR")
	}
}
