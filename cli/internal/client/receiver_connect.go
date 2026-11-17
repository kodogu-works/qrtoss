package client

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/wistaria/qrtoss/cli/internal/constants"
)

type receiverRoom struct {
	V                int    `json:"v"`
	Room             string `json:"room"`
	ReceiverCap      string `json:"receiverCap"`
	SenderJoinCap    string `json:"senderJoinCap"`
	ServerTime       int64  `json:"serverTime"`
	PairingExpiresAt int64  `json:"pairingExpiresAt"`
}

func (r *Runner) connectReceiver(ctx context.Context, o Options, t *terminal, h *http.Client, deadline, recovery time.Time) (*receiver, error) {
	attemptEnd := time.Now().Add(15 * time.Second)
	if recovery.Before(attemptEnd) {
		attemptEnd = recovery
	}
	if !deadline.IsZero() && deadline.Before(attemptEnd) {
		attemptEnd = deadline
	}
	attempt, cancel := context.WithDeadline(ctx, attemptEnd)
	defer cancel()
	room, err := createReceiverRoom(attempt, o.Server, h)
	if err != nil {
		return nil, err
	}
	wsurl := "wss" + strings.TrimPrefix(o.Server, "https") + "/ws"
	conn, resp, err := websocket.Dial(attempt, wsurl, &websocket.DialOptions{
		HTTPClient:      h,
		HTTPHeader:      http.Header{"Origin": []string{o.Server}, "User-Agent": []string{"qrtoss/" + Version}},
		Subprotocols:    []string{"qrtoss.v1"},
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		if resp != nil && (resp.StatusCode == 403 || resp.StatusCode == 404 || isRedirect(resp.StatusCode)) {
			return nil, fail(2, "ARGUMENT_ERROR")
		}
		return nil, networkFailure(err)
	}
	if conn.Subprotocol() != "qrtoss.v1" {
		_ = conn.CloseNow()
		return nil, fail(4, "PROTOCOL_ERROR")
	}
	conn.SetReadLimit(constants.MAX_WS_MESSAGE_BYTES)
	session := &receiver{
		ctx: ctx, runner: r, options: o, terminal: t, conn: conn,
		room: room.Room, deadline: deadline,
	}
	pairDeadline, err := session.authenticate(room.ReceiverCap, attemptEnd)
	if err != nil {
		_ = conn.CloseNow()
		return nil, err
	}
	psk, _ := Decode(Random(32), 32)
	session.state = &receiverPairing{
		url:      o.Server + "/send#v=1&r=" + room.Room + "&j=" + room.SenderJoinCap + "&k=" + B64(psk),
		psk:      psk,
		deadline: pairDeadline,
	}
	return session, nil
}

func createReceiverRoom(ctx context.Context, server string, h *http.Client) (receiverRoom, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", server+"/api/v1/rooms", strings.NewReader(`{"v":1}`))
	if err != nil {
		return receiverRoom{}, fail(2, "ARGUMENT_ERROR")
	}
	req.Header.Set("Origin", server)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "qrtoss/"+Version)
	res, err := h.Do(req)
	if err != nil {
		return receiverRoom{}, networkFailure(err)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, constants.MAX_CONTROL_MESSAGE_BYTES+1))
	res.Body.Close()
	if err != nil {
		return receiverRoom{}, fail(3, "CONNECT_ERROR")
	}
	if res.StatusCode != 201 {
		if isRedirect(res.StatusCode) || res.StatusCode == 404 || res.StatusCode == 403 {
			return receiverRoom{}, fail(2, "ARGUMENT_ERROR")
		}
		if res.StatusCode == 429 || res.StatusCode >= 500 {
			f := failure{3, "CONNECT_ERROR", 0}
			if v, err := strconv.ParseUint(res.Header.Get("Retry-After"), 10, 31); err == nil {
				f.retryAfter = time.Duration(v) * time.Second
			}
			return receiverRoom{}, f
		}
		return receiverRoom{}, fail(4, "PROTOCOL_ERROR")
	}
	return parseReceiverRoom(b)
}

func isRedirect(status int) bool { return status >= 300 && status < 400 }

func parseReceiverRoom(b []byte) (receiverRoom, error) {
	var room receiverRoom
	if len(b) > constants.MAX_CONTROL_MESSAGE_BYTES || strict(b, &room) != nil {
		return receiverRoom{}, fail(4, "PROTOCOL_ERROR")
	}
	if room.V != 1 || room.ServerTime < 0 || room.PairingExpiresAt <= room.ServerTime {
		return receiverRoom{}, fail(4, "PROTOCOL_ERROR")
	}
	if room.PairingExpiresAt-room.ServerTime > constants.PAIRING_TTL_SECONDS*1000 {
		return receiverRoom{}, fail(4, "PROTOCOL_ERROR")
	}
	var fields map[string]json.RawMessage
	if strict(b, &fields) != nil || fieldsOnly(fields, "v", "room", "receiverCap", "senderJoinCap", "serverTime", "pairingExpiresAt") != nil {
		return receiverRoom{}, fail(4, "PROTOCOL_ERROR")
	}
	for _, value := range []struct {
		s string
		n int
	}{{room.Room, 16}, {room.ReceiverCap, 32}, {room.SenderJoinCap, 32}} {
		if _, err := Decode(value.s, value.n); err != nil {
			return receiverRoom{}, fail(4, "PROTOCOL_ERROR")
		}
	}
	return room, nil
}

func (s *receiver) authenticate(cap string, attemptEnd time.Time) (time.Time, error) {
	if err := s.control("auth", map[string]any{"role": "receiver", "room": s.room, "cap": cap}, attemptEnd); err != nil {
		return time.Time{}, fail(3, "CONNECT_ERROR")
	}
	end := time.Now().Add(constants.AUTH_TIMEOUT_SECONDS * time.Second)
	if attemptEnd.Before(end) {
		end = attemptEnd
	}
	ctx, cancel := context.WithDeadline(s.ctx, end)
	defer cancel()
	mt, raw, err := s.conn.Read(ctx)
	if err != nil {
		return time.Time{}, networkFailure(err)
	}
	if mt != websocket.MessageText {
		return time.Time{}, fail(4, "PROTOCOL_ERROR")
	}
	auth, err := control(raw)
	if err != nil {
		return time.Time{}, fail(4, "PROTOCOL_ERROR")
	}
	if str(auth, "type") == "error" {
		return time.Time{}, codeFailure(str(auth, "code"))
	}
	if str(auth, "type") != "auth.ok" || str(auth, "room") != s.room {
		return time.Time{}, fail(4, "PROTOCOL_ERROR")
	}
	return controlDeadline(auth, "pairingExpiresAt"), nil
}
