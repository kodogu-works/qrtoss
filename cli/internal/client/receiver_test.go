package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type receiverTestSocket struct {
	messages   []map[string]json.RawMessage
	writeErr   error
	writeCalls int
}

func (*receiverTestSocket) Read(context.Context) (websocket.MessageType, []byte, error) {
	return 0, nil, io.EOF
}

func (c *receiverTestSocket) Write(ctx context.Context, _ websocket.MessageType, b []byte) error {
	c.writeCalls++
	if err := ctx.Err(); err != nil {
		return err
	}
	if c.writeErr != nil {
		return c.writeErr
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		return err
	}
	c.messages = append(c.messages, m)
	return nil
}

func (*receiverTestSocket) CloseNow() error { return nil }

func (c *receiverTestSocket) count(kind string) int {
	count := 0
	for _, m := range c.messages {
		if str(m, "type") == kind {
			count++
		}
	}
	return count
}

type receiverFixture struct {
	t           *testing.T
	session     *receiver
	socket      *receiverTestSocket
	diagnostics bytes.Buffer
	psk         []byte
	peer        string
	keys        Keys
	seq         uint64
}

func newReceiverFixture(t *testing.T, out io.Writer) *receiverFixture {
	t.Helper()
	f := &receiverFixture{t: t, socket: &receiverTestSocket{}, psk: make([]byte, 32), peer: Random(16)}
	f.session = &receiver{
		ctx:      context.Background(),
		runner:   &Runner{Out: out},
		options:  Options{Format: "text"},
		terminal: &terminal{out: &f.diagnostics},
		conn:     f.socket,
		room:     Random(16),
		state:    &receiverPairing{url: "https://example.org/send", psk: f.psk, deadline: time.Now().Add(time.Minute)},
		lastPong: time.Now(), lastPongID: -1,
	}
	return f
}

func (f *receiverFixture) server(kind string, fields map[string]any) *receiveResult {
	f.t.Helper()
	fields["v"], fields["type"] = 1, kind
	return f.session.onControl(f.marshal(fields))
}

func (f *receiverFixture) app(message map[string]any) *receiveResult {
	f.t.Helper()
	envelope, err := Seal(f.keys.S2R, f.session.room, f.peer, "s2r", f.seq, f.marshal(message))
	if err != nil {
		f.t.Fatal(err)
	}
	f.seq++
	return f.session.onControl(f.marshal(envelope))
}

func (f *receiverFixture) marshal(v any) []byte {
	f.t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		f.t.Fatal(err)
	}
	return b
}

func (f *receiverFixture) keepReceiving(result *receiveResult) {
	f.t.Helper()
	if result != nil {
		f.t.Fatalf("unexpected receive termination: %+v", result)
	}
}

// Advance using the same control messages, proofs and encrypted ready as a sender.
func (f *receiverFixture) advance(stage string) {
	f.t.Helper()
	f.keepReceiving(f.server("pair.candidate", map[string]any{
		"peer": f.peer, "serverTime": 0, "candidateExpiresAt": 10000,
	}))
	if stage == "candidate" {
		return
	}
	challenge := f.socket.messages[len(f.socket.messages)-1]
	snonce := Random(32)
	var err error
	f.keys, err = Derive(f.psk, f.session.room, f.peer, str(challenge, "rNonce"), snonce)
	if err != nil {
		f.t.Fatal(err)
	}
	f.keepReceiving(f.server("pair.proof", map[string]any{
		"peer": f.peer, "sNonce": snonce, "proof": B64(f.keys.MAC("sender")),
	}))
	if stage == "committing" {
		return
	}
	f.keepReceiving(f.server("pair.committed", map[string]any{
		"peer": f.peer, "serverTime": 0, "readyExpiresAt": 10000, "idleExpiresAt": 1800000,
	}))
	if stage == "confirming" {
		return
	}
	f.keepReceiving(f.app(map[string]any{"type": "ready"}))
	if stage == "activating" {
		return
	}
	f.keepReceiving(f.server("pair.active", map[string]any{
		"peer": f.peer, "serverTime": 0, "idleExpiresAt": 1800000,
	}))
	f.socket.messages = nil
}

func expectReceiveFailure(t *testing.T, result *receiveResult, code int) {
	t.Helper()
	var f failure
	if result == nil || !errors.As(result.err, &f) || f.code != code {
		t.Fatalf("expected failure %d, got %+v", code, result)
	}
}

func TestReceiverHandshakeOrder(t *testing.T) {
	for _, stage := range []string{"candidate", "committing", "confirming", "activating", "connected"} {
		t.Run(stage, func(t *testing.T) {
			f := newReceiverFixture(t, io.Discard)
			f.advance(stage)
			// Before ready, ACTIVE is premature; after ready, data must still wait
			// for the relay's ACTIVE notification. A second ACTIVE is invalid too.
			if stage == "activating" {
				expectReceiveFailure(t, f.app(map[string]any{
					"type": "data", "id": Random(16), "textB64": B64([]byte("early")),
				}), 4)
			} else {
				expectReceiveFailure(t, f.server("pair.active", map[string]any{
					"peer": f.peer, "serverTime": 0, "idleExpiresAt": 1800000,
				}), 4)
			}
			if f.socket.count("room.close") != 1 {
				t.Fatal("protocol violation must close the room")
			}
		})
	}
}

func TestReceiverCandidateCanBeReplacedAfterClosure(t *testing.T) {
	f := newReceiverFixture(t, io.Discard)
	f.advance("candidate")
	f.keepReceiving(f.server("pair.proof", map[string]any{
		"peer": f.peer, "sNonce": Random(32), "proof": B64(make([]byte, 32)),
	}))
	if f.socket.count("pair.reject") != 1 || f.socket.count("pair.commit") != 0 {
		t.Fatal("invalid proof must reject the candidate without committing")
	}
	f.keepReceiving(f.server("pair.candidate_closed", map[string]any{"peer": f.peer, "code": "AUTH_FAILED"}))
	f.peer = Random(16)
	f.advance("connected")
	if f.session.pairing() != nil || f.session.peer().cipher.Keys.Proof != nil {
		t.Fatal("pairing secrets must be released after commit")
	}
}

func TestReceiverCommitRequiresProof(t *testing.T) {
	f := newReceiverFixture(t, io.Discard)
	f.advance("candidate")
	expectReceiveFailure(t, f.server("pair.committed", map[string]any{
		"peer": f.peer, "serverTime": 0, "readyExpiresAt": 10000, "idleExpiresAt": 1800000,
	}), 4)
}

func TestReceiverWaitsForServerDeadlines(t *testing.T) {
	for _, stage := range []string{"confirming", "activating", "connected"} {
		t.Run(stage, func(t *testing.T) {
			f := newReceiverFixture(t, io.Discard)
			f.advance(stage)
			now := time.Now().Add(31 * time.Minute)
			// Pongs and recent activity can arrive while the server's ACTIVE or
			// touch notification is still delayed beyond the advertised deadline.
			f.session.lastPong = now
			if connection := f.session.connection(); connection != nil {
				connection.activity.record(now)
			}
			f.keepReceiving(f.session.onTick(now))
			if f.socket.count("room.close") != 0 {
				t.Fatal("server deadlines must not close the room locally")
			}
		})
	}
}

func TestReceiverReadyExchangeIgnoresAdvertisedDeadline(t *testing.T) {
	f := newReceiverFixture(t, io.Discard)
	f.advance("committing")
	// A delayed notification can carry no remaining ready time. The relay
	// decides whether confirm/ready/ACTIVE still belong to a live room.
	f.keepReceiving(f.server("pair.committed", map[string]any{
		"peer": f.peer, "serverTime": 10000, "readyExpiresAt": 10000, "idleExpiresAt": 1800000,
	}))
	f.keepReceiving(f.session.onTick(time.Now()))
	f.keepReceiving(f.app(map[string]any{"type": "ready"}))
	f.keepReceiving(f.session.onTick(time.Now()))
	if f.socket.count("pair.confirm") != 1 || f.socket.count("pair.active") != 1 || f.socket.count("room.close") != 0 {
		t.Fatal("ready exchange must wait for the server's decision")
	}
}

func TestReceiverServerClosureReason(t *testing.T) {
	for _, test := range []struct {
		stage, code, key string
	}{
		{"confirming", "READY_TIMEOUT", "DISCONNECTED"},
		{"activating", "READY_TIMEOUT", "DISCONNECTED"},
		{"connected", "SESSION_EXPIRED", "SESSION_EXPIRED"},
	} {
		t.Run(test.stage, func(t *testing.T) {
			f := newReceiverFixture(t, io.Discard)
			f.advance(test.stage)
			result := f.server("room.closed", map[string]any{"code": test.code})
			expectReceiveFailure(t, result, 3)
			if result.code != 1 || result.err.Error() != test.key {
				t.Fatalf("server closure must renew the room with %s: %+v", test.key, result)
			}
		})
	}
}

func TestReceiverLocalTimeoutsRemainActive(t *testing.T) {
	for _, stage := range []string{"confirming", "activating", "connected"} {
		for _, cause := range []string{"command timeout", "heartbeat"} {
			t.Run(stage+"/"+cause, func(t *testing.T) {
				f := newReceiverFixture(t, io.Discard)
				f.advance(stage)
				now := time.Now().Add(46 * time.Second)
				want := 3
				if cause == "command timeout" {
					f.session.deadline = now
					f.session.lastPong = now
					want = 124
				}
				expectReceiveFailure(t, f.session.onTick(now), want)
			})
		}
	}
}

func TestReceiverOwnIdleExpiry(t *testing.T) {
	f := newReceiverFixture(t, io.Discard)
	f.advance("connected")
	now := f.session.connection().activity.last.Add(30 * time.Minute)
	f.session.lastPong = now
	result := f.session.onTick(now)
	expectReceiveFailure(t, result, 3)
	if result.code != 1 || result.err.Error() != "SESSION_EXPIRED" {
		t.Fatalf("local inactivity must expire the session: %+v", result)
	}
	if f.socket.count("room.close") != 1 || str(f.socket.messages[len(f.socket.messages)-1], "reason") != "idle_timeout" {
		t.Fatal("local inactivity must close the room with idle_timeout")
	}
}

func TestReceiverCloseRoomDuringCleanup(t *testing.T) {
	for _, ending := range []struct {
		name, reason, key string
		code              int
		end               func(*receiverFixture) *receiveResult
	}{
		{"command timeout", "user_end", "TIMEOUT", 124, func(f *receiverFixture) *receiveResult {
			now := time.Now()
			f.session.deadline = now
			return f.session.onTick(now)
		}},
		{"protocol violation", "client_error", "PROTOCOL_ERROR", 4, func(f *receiverFixture) *receiveResult {
			return f.session.onControl([]byte(`{"v":1,"type":"unexpected"}`))
		}},
		{"idle timeout", "idle_timeout", "SESSION_EXPIRED", 3, func(f *receiverFixture) *receiveResult {
			now := f.session.connection().activity.last.Add(30 * time.Minute)
			f.session.lastPong = now
			return f.session.onTick(now)
		}},
	} {
		for _, writeErr := range []error{nil, io.ErrClosedPipe} {
			name := "write succeeds"
			if writeErr != nil {
				name = "write fails"
			}
			t.Run(ending.name+"/"+name, func(t *testing.T) {
				f := newReceiverFixture(t, io.Discard)
				f.advance("connected")
				f.socket.writeCalls, f.socket.writeErr = 0, writeErr
				result := func() *receiveResult {
					// receive() always performs this cleanup after its event loop exits.
					defer f.session.closeRoom("user_end")
					return ending.end(f)
				}()
				expectReceiveFailure(t, result, ending.code)
				if result.err.Error() != ending.key {
					t.Fatalf("cleanup changed termination reason: %+v", result)
				}
				if f.socket.writeCalls != 1 {
					t.Fatalf("termination and cleanup must attempt one write, got %d", f.socket.writeCalls)
				}
				if writeErr == nil {
					if f.socket.count("room.close") != 1 {
						t.Fatalf("expected one room.close, got %+v", f.socket.messages)
					}
					if reason := str(f.socket.messages[0], "reason"); reason != ending.reason {
						t.Fatalf("cleanup changed room.close reason: got %s, want %s", reason, ending.reason)
					}
				}
			})
		}
	}
}

type receiverBlockedOutput struct {
	started, release, finished chan struct{}
	startOnce                  sync.Once
	writes                     atomic.Int32
	output                     bytes.Buffer
	err                        error
}

func newReceiverBlockedOutput(t *testing.T, err error) (*receiverBlockedOutput, func()) {
	t.Helper()
	w := &receiverBlockedOutput{
		started: make(chan struct{}), release: make(chan struct{}), finished: make(chan struct{}), err: err,
	}
	unblock := sync.OnceFunc(func() { close(w.release) })
	t.Cleanup(func() {
		unblock()
		select {
		case <-w.started:
			<-w.finished
		default:
		}
	})
	return w, unblock
}

func (w *receiverBlockedOutput) Write(b []byte) (int, error) {
	w.writes.Add(1)
	w.startOnce.Do(func() { close(w.started) })
	<-w.release
	defer close(w.finished)
	if w.err != nil {
		return 0, w.err
	}
	return w.output.Write(b)
}

func (f *receiverFixture) completeOutput() *receiveResult {
	f.t.Helper()
	select {
	case err := <-f.session.outputDone():
		return f.session.onOutput(err)
	case <-time.After(2 * time.Second):
		f.t.Fatal("stdout write did not finish")
		return nil
	}
}

func TestReceiverOutputAndDuplicateLifecycle(t *testing.T) {
	out, release := newReceiverBlockedOutput(t, nil)
	f := newReceiverFixture(t, out)
	f.advance("connected")
	id := Random(16)
	data := map[string]any{"type": "data", "id": id, "textB64": B64([]byte("one record"))}
	f.keepReceiving(f.app(data))
	<-out.started
	f.keepReceiving(f.app(data))
	f.keepReceiving(f.session.onHeartbeat())
	f.session.deadline = time.Now().Add(-time.Second)
	f.keepReceiving(f.session.onTick(time.Now()))
	if f.socket.count("cipher") != 0 || f.socket.count("hb.ping") != 1 {
		t.Fatal("heartbeat must continue while ACK waits for stdout")
	}
	release()
	f.keepReceiving(f.completeOutput())
	end := f.session.drainDeadline()
	f.keepReceiving(f.app(data))
	if out.writes.Load() != 1 || out.output.String() != "one record\n" || f.socket.count("cipher") != 2 {
		t.Fatal("duplicate data must resend ACK without writing stdout again")
	}
	if f.session.drainDeadline() != end {
		t.Fatal("duplicate data must not extend the drain deadline")
	}
	result := f.app(map[string]any{"type": "ack_seen", "id": id})
	if result == nil || result.code != 0 || result.err != nil || bytes.Contains(f.diagnostics.Bytes(), []byte("ACK_UNCONFIRMED")) {
		t.Fatalf("ack_seen must complete the successful transfer: %+v", result)
	}
}

func TestReceiverAckSeenRequiresCompletedOutput(t *testing.T) {
	for _, writing := range []bool{false, true} {
		name := "before data"
		if writing {
			name = "before output completion"
		}
		t.Run(name, func(t *testing.T) {
			out, _ := newReceiverBlockedOutput(t, nil)
			f := newReceiverFixture(t, out)
			f.advance("connected")
			id := Random(16)
			if writing {
				f.keepReceiving(f.app(map[string]any{"type": "data", "id": id, "textB64": B64([]byte("one record"))}))
				<-out.started
			}
			expectReceiveFailure(t, f.app(map[string]any{"type": "ack_seen", "id": id}), 4)
			if f.socket.count("cipher") != 0 {
				t.Fatal("premature ack_seen must not produce an ACK")
			}
		})
	}
}

func TestReceiverDisconnectWhileWriting(t *testing.T) {
	disconnects := []struct {
		name string
		run  func(*receiverFixture) *receiveResult
	}{
		{"socket", func(f *receiverFixture) *receiveResult {
			return f.session.onWire(wireRead{e: io.EOF}, true)
		}},
		{"heartbeat write", func(f *receiverFixture) *receiveResult {
			f.socket.writeErr = io.ErrClosedPipe
			return f.session.onHeartbeat()
		}},
		{"heartbeat timeout", func(f *receiverFixture) *receiveResult {
			return f.session.onTick(time.Now().Add(46 * time.Second))
		}},
		{"room closure", func(f *receiverFixture) *receiveResult {
			return f.server("room.closed", map[string]any{"code": "SESSION_EXPIRED"})
		}},
	}
	for _, disconnect := range disconnects {
		for _, writeErr := range []error{nil, io.ErrClosedPipe} {
			name := "success"
			if writeErr != nil {
				name = "output failure"
			}
			t.Run(disconnect.name+"/"+name, func(t *testing.T) {
				out, release := newReceiverBlockedOutput(t, writeErr)
				f := newReceiverFixture(t, out)
				f.advance("connected")
				data := map[string]any{"type": "data", "id": Random(16), "textB64": B64([]byte("one record"))}
				f.keepReceiving(f.app(data))
				<-out.started
				f.keepReceiving(disconnect.run(f))
				f.session.deadline = time.Now().Add(-time.Second)
				f.keepReceiving(f.session.onTick(time.Now().Add(time.Hour)))
				f.keepReceiving(f.app(data))
				release()
				result := f.completeOutput()
				if writeErr != nil {
					expectReceiveFailure(t, result, 5)
				} else if result == nil || result.code != 0 || result.err != nil || out.output.String() != "one record\n" {
					t.Fatalf("disconnected output must still succeed: %+v", result)
				} else if !bytes.Contains(f.diagnostics.Bytes(), []byte("ACK_UNCONFIRMED")) {
					t.Fatal("disconnected output must report unconfirmed ACK")
				}
				if out.writes.Load() != 1 || f.socket.count("cipher") != 0 {
					t.Fatal("disconnect must not duplicate stdout or send an ACK")
				}
			})
		}
	}
}

func TestReceiverDrainingPreservesResult(t *testing.T) {
	for _, rejected := range []bool{false, true} {
		for _, ending := range []string{"timeout", "changed id", "changed body", "disconnect"} {
			name := "received"
			if rejected {
				name = "rejected"
			}
			t.Run(name+"/"+ending, func(t *testing.T) {
				var out bytes.Buffer
				f := newReceiverFixture(t, &out)
				f.advance("connected")
				id, text := Random(16), "one record"
				if rejected {
					text = "line one\nline two"
				}
				f.keepReceiving(f.app(map[string]any{"type": "data", "id": id, "textB64": B64([]byte(text))}))
				if !rejected {
					f.keepReceiving(f.completeOutput())
				}
				var result *receiveResult
				switch ending {
				case "timeout":
					result = f.session.onTick(f.session.drainDeadline())
				case "disconnect":
					result = f.session.onWire(wireRead{}, false)
				default:
					if ending == "changed id" {
						id = Random(16)
					} else {
						text += "changed"
					}
					result = f.app(map[string]any{"type": "data", "id": id, "textB64": B64([]byte(text))})
					if !bytes.Contains(f.diagnostics.Bytes(), []byte("PROTOCOL_ERROR")) {
						t.Fatal("mismatched duplicate must report a protocol violation")
					}
				}
				want := 0
				if rejected {
					want = 6
					if out.Len() != 0 {
						t.Fatal("rejected content must not reach stdout")
					}
				}
				if result == nil || result.err != nil || result.code != want {
					t.Fatalf("draining must preserve exit %d: %+v", want, result)
				}
			})
		}
	}
}
