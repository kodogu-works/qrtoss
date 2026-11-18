package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/wistaria/qrtoss/cli/internal/constants"
)

type receiverSocket interface {
	Read(context.Context) (websocket.MessageType, []byte, error)
	Write(context.Context, websocket.MessageType, []byte) error
	CloseNow() error
}

type receiver struct {
	ctx      context.Context
	runner   *Runner
	options  Options
	terminal *terminal
	conn     receiverSocket
	room     string
	deadline time.Time
	state    receiverState

	incoming    <-chan wireRead
	queuedBytes atomic.Int64
	lastPong    time.Time
	pingID      int64
	lastPongID  int64

	closeAttempted bool
}

type wireRead struct {
	b []byte
	e error
}

// A nil result means that the event loop should keep receiving events.
type receiveResult struct {
	code int
	err  error
}

func receiveEnd(code int, err error) *receiveResult { return &receiveResult{code, err} }

func (s *receiver) run() (int, error) {
	heartbeat := time.NewTicker(constants.HEARTBEAT_INTERVAL_SECONDS * time.Second)
	defer heartbeat.Stop()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	s.lastPong, s.lastPongID = time.Now(), -1
	for {
		var result *receiveResult
		select {
		case <-s.ctx.Done():
			return 0, s.ctx.Err()
		case <-s.runner.Resize:
			if pairing := s.pairing(); pairing != nil {
				if err := s.displayPairing(pairing.url); err != nil {
					return 0, err
				}
			}
		case <-heartbeat.C:
			result = s.onHeartbeat()
		case <-tick.C:
			result = s.onTick(time.Now())
		case err := <-s.outputDone():
			result = s.onOutput(err)
		case item, ok := <-s.incoming:
			result = s.onWire(item, ok)
		}
		if result != nil {
			return result.code, result.err
		}
	}
}

func (s *receiver) startReading() context.CancelFunc {
	ctx, stop := context.WithCancel(s.ctx)
	incoming := make(chan wireRead, constants.MAX_RECEIVE_QUEUE_MESSAGES)
	s.incoming = incoming
	go s.readLoop(ctx, incoming)
	return stop
}

func (s *receiver) readLoop(ctx context.Context, incoming chan<- wireRead) {
	defer close(incoming)
	for {
		mt, b, err := s.conn.Read(ctx)
		if err == nil && mt != websocket.MessageText {
			err = fail(4, "PROTOCOL_ERROR")
		}
		if err == nil {
			size := int64(len(b))
			if s.queuedBytes.Add(size) <= constants.MAX_SOCKET_BUFFER_BYTES {
				select {
				case incoming <- wireRead{b: b}:
					continue
				default:
				}
			}
			s.queuedBytes.Add(-size)
			_ = s.conn.CloseNow()
			err = fail(4, "PROTOCOL_ERROR")
		}
		select {
		case incoming <- wireRead{e: err}:
		case <-ctx.Done():
		}
		return
	}
}

func (s *receiver) onWire(item wireRead, ok bool) *receiveResult {
	if !ok || item.e != nil {
		s.incoming = nil
		var fatal failure
		if errors.As(item.e, &fatal) && fatal.code == 4 {
			return s.violation()
		}
		return s.disconnect(fail(3, "DISCONNECTED"))
	}
	s.queuedBytes.Add(-int64(len(item.b)))
	return s.onControl(item.b)
}

func (s *receiver) onHeartbeat() *receiveResult {
	if _, offline := s.state.(*receiverWritingDisconnected); offline {
		return nil
	}
	if err := s.control("hb.ping", map[string]any{"id": s.pingID}, s.drainDeadline()); err != nil {
		if result := s.disconnect(networkFailure(err)); result != nil {
			return result
		}
	}
	s.pingID++
	if _, ok := s.state.(*receiverConnected); ok {
		_ = s.flushTouch(true)
	}
	return nil
}

func (s *receiver) onTick(now time.Time) *receiveResult {
	if state, ok := s.state.(*receiverDraining); ok && deadlineReached(now, state.deadline) {
		return s.finish(state, true)
	}
	// Only the command timeout and our own activity clock expire locally.
	// Server ready/idle expiry is announced by room.closed; heartbeat detects loss.
	if s.message() == nil {
		if deadlineReached(now, s.deadline) {
			return receiveEnd(0, fail(124, "TIMEOUT"))
		}
		if connection := s.connection(); connection != nil && connection.activity.expired(now) {
			s.closeRoom("idle_timeout")
			return receiveEnd(1, fail(3, "SESSION_EXPIRED"))
		}
	}
	if _, offline := s.state.(*receiverWritingDisconnected); !offline && now.Sub(s.lastPong) >= constants.HEARTBEAT_TIMEOUT_SECONDS*time.Second {
		_ = s.conn.CloseNow()
		return s.disconnect(fail(3, "DISCONNECTED"))
	}
	return nil
}

func deadlineReached(now, deadline time.Time) bool {
	return !deadline.IsZero() && !now.Before(deadline)
}

func (s *receiver) disconnect(err error) *receiveResult {
	switch state := s.state.(type) {
	case *receiverWriting:
		s.state = &receiverWritingDisconnected{state}
		return nil
	case *receiverWritingDisconnected:
		return nil
	case *receiverDraining:
		return s.finish(state, true)
	default:
		return receiveEnd(1, err)
	}
}

func (s *receiver) onOutput(err error) *receiveResult {
	switch state := s.state.(type) {
	case *receiverWriting:
		return s.outputWritten(state, err, true)
	case *receiverWritingDisconnected:
		return s.outputWritten(state.receiverWriting, err, false)
	default:
		return s.violation()
	}
}

func (s *receiver) outputWritten(writing *receiverWriting, err error, connected bool) *receiveResult {
	if err != nil {
		return receiveEnd(0, fail(5, "IO_ERROR"))
	}
	draining := &receiverDraining{
		receiverConnected: writing.receiverConnected,
		message:           writing.message,
		status:            receiptReceived,
		deadline:          time.Now().Add(2 * time.Second),
	}
	s.state = draining
	_ = s.terminal.event("RECEIVED")
	if !connected {
		return s.finish(draining, true)
	}
	if err := s.sendAck(draining); err != nil {
		return s.finish(draining, true)
	}
	return nil
}

func (s *receiver) finish(state *receiverDraining, unconfirmed bool) *receiveResult {
	if state.status == receiptReceived && unconfirmed {
		_ = s.terminal.event("ACK_UNCONFIRMED")
	}
	if state.status == receiptRejected {
		return receiveEnd(6, nil)
	}
	return receiveEnd(0, nil)
}

func (s *receiver) violation() *receiveResult {
	s.closeRoom("client_error")
	if state, ok := s.state.(*receiverDraining); ok {
		_ = s.terminal.event("PROTOCOL_ERROR")
		return s.finish(state, true)
	}
	return receiveEnd(0, fail(4, "PROTOCOL_ERROR"))
}

func (s *receiver) displayPairing(url string) error {
	if err := s.terminal.pairing(url); err != nil {
		if err.Error() == "DISPLAY_ERROR" {
			return fail(2, "DISPLAY_ERROR")
		}
		return fail(5, "IO_ERROR")
	}
	return nil
}

func (s *receiver) showPairing() error {
	pairing := s.pairing()
	if err := s.terminal.event("WAITING"); err != nil {
		return fail(5, "IO_ERROR")
	}
	if _, err := fmt.Fprintf(s.terminal.out, "[EXPIRES] %s\n", pairing.deadline.Local().Format("2006-01-02 15:04:05 (MST)")); err != nil {
		return fail(5, "IO_ERROR")
	}
	return s.displayPairing(pairing.url)
}

func (s *receiver) touch() error {
	s.connection().activity.record(time.Now())
	return s.flushTouch(false)
}

func (s *receiver) flushTouch(force bool) error {
	connection := s.connection()
	now := time.Now()
	if !connection.activity.pending || !force && !connection.activity.due(now, connection.idleDeadline) {
		return nil
	}
	if err := s.control("room.touch", map[string]any{"peer": connection.id}, s.drainDeadline()); err != nil {
		return err
	}
	connection.activity.sent, connection.activity.pending = now, false
	return nil
}

func (s *receiver) sendAck(state *receiverDraining) error {
	m := map[string]any{"type": "ack", "id": state.message.id, "status": "received"}
	if state.status == receiptRejected {
		m["status"] = "rejected"
		m["reason"] = "unsupported_content"
	}
	return s.sendCipher(m)
}

func (s *receiver) sendCipher(v any) error {
	peer := s.peer()
	if peer == nil {
		return errors.New("no keys")
	}
	envelope, err := peer.cipher.Encrypt(v)
	if err != nil {
		return err
	}
	return s.write(envelope, s.drainDeadline())
}

func (s *receiver) control(kind string, fields map[string]any, until time.Time) error {
	if fields == nil {
		fields = map[string]any{}
	}
	fields["v"], fields["type"] = 1, kind
	return s.write(fields, until)
}

func (s *receiver) write(v any, until time.Time) error {
	end := time.Now().Add(15 * time.Second)
	if !until.IsZero() && until.Before(end) {
		end = until
	}
	ctx, cancel := context.WithDeadline(s.ctx, end)
	defer cancel()
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return s.conn.Write(ctx, websocket.MessageText, data)
}

func (s *receiver) closeRoom(reason string) {
	// The event loop and its deferred cleanup share one best-effort attempt,
	// even when writing fails, so cleanup cannot replace the original reason.
	if s.closeAttempted {
		return
	}
	s.closeAttempted = true
	end := time.Now().Add(100 * time.Millisecond)
	if drain := s.drainDeadline(); !drain.IsZero() && drain.Before(end) {
		end = drain
	}
	_ = s.control("room.close", map[string]any{"reason": reason}, end)
}
