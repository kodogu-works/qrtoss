package client

import (
	"crypto/sha256"
	"encoding/json"
	"time"
)

func (s *receiver) onControl(raw []byte) *receiveResult {
	m, err := control(raw)
	if err != nil {
		return s.violation()
	}
	if deadlineReached(time.Now(), s.drainDeadline()) {
		return s.finish(s.state.(*receiverDraining), true)
	}
	switch str(m, "type") {
	case "hb.pong":
		id, _ := integer(m, "id")
		if id <= s.lastPongID || id >= s.pingID {
			return s.violation()
		}
		s.lastPong, s.lastPongID = time.Now(), id
	case "pair.candidate":
		return s.onCandidate(m)
	case "pair.proof":
		return s.onProof(m)
	case "pair.candidate_closed":
		return s.onCandidateClosed(m)
	case "pair.committed":
		return s.onCommitted(m)
	case "pair.active":
		return s.onActive(m)
	case "room.touched":
		connection := s.connection()
		if connection == nil || str(m, "peer") != connection.id {
			return s.violation()
		}
		connection.idleDeadline = controlDeadline(m, "idleExpiresAt")
	case "room.closed", "error":
		return s.onRoomClosed(m)
	case "cipher":
		return s.onCipher(raw)
	default:
		return s.violation()
	}
	return nil
}

func (s *receiver) onRoomClosed(m map[string]json.RawMessage) *receiveResult {
	if str(m, "type") == "error" && str(m, "scope") == "candidate" && s.pairing() != nil {
		return nil
	}
	err := codeFailure(str(m, "code"))
	switch s.state.(type) {
	case *receiverWriting, *receiverWritingDisconnected, *receiverDraining:
		return s.disconnect(err)
	default:
		if f, ok := err.(failure); ok && f.code == 3 {
			return receiveEnd(1, err)
		}
		return receiveEnd(0, err)
	}
}

func (s *receiver) onCipher(raw []byte) *receiveResult {
	peer := s.peer()
	if peer == nil {
		return s.violation()
	}
	inner, err := peer.cipher.Decrypt(raw)
	if err != nil {
		return s.violation()
	}
	if confirming, ok := s.state.(*receiverConfirming); ok {
		return s.onReady(confirming, inner)
	}
	if s.connection() == nil {
		return s.violation()
	}
	switch str(inner, "type") {
	case "activity", "status":
		if _, ok := s.state.(*receiverConnected); ok {
			if str(inner, "type") == "status" && str(inner, "state") == "scanned" {
				if err := s.terminal.event("PEER_SCANNED"); err != nil {
					return receiveEnd(0, fail(5, "IO_ERROR"))
				}
			}
			_ = s.touch()
		}
	case "data":
		return s.onData(inner)
	case "ack_seen":
		draining, ok := s.state.(*receiverDraining)
		if !ok || str(inner, "id") != draining.message.id {
			return s.violation()
		}
		return s.finish(draining, false)
	default:
		return s.violation()
	}
	return nil
}

func (s *receiver) onReady(state *receiverConfirming, inner map[string]json.RawMessage) *receiveResult {
	if str(inner, "type") != "ready" || state.cipher.Recv != 1 {
		return s.violation()
	}
	s.state = &receiverActivating{receiverPeer: state.receiverPeer}
	if err := s.sendCipher(map[string]any{"type": "ready_ack"}); err != nil {
		return receiveEnd(1, fail(3, "DISCONNECTED"))
	}
	if err := s.control("pair.active", map[string]any{"peer": state.id}, time.Time{}); err != nil {
		return receiveEnd(1, fail(3, "DISCONNECTED"))
	}
	return nil
}

func (s *receiver) onData(inner map[string]json.RawMessage) *receiveResult {
	text, _ := Decode(str(inner, "textB64"), -1)
	message := receiverMessage{id: str(inner, "id"), digest: sha256.Sum256(text)}
	if accepted := s.message(); accepted != nil {
		if message != *accepted {
			return s.violation()
		}
		if draining, ok := s.state.(*receiverDraining); ok {
			if err := s.sendAck(draining); err != nil {
				return s.finish(draining, true)
			}
		}
		return nil
	}
	if deadlineReached(time.Now(), s.deadline) {
		return receiveEnd(0, fail(124, "TIMEOUT"))
	}
	connection := s.state.(*receiverConnected)
	record, err := Record(string(text), s.options.Format)
	if err == ErrUnsupported {
		draining := &receiverDraining{
			receiverConnected: connection,
			message:           message,
			status:            receiptRejected,
			deadline:          time.Now().Add(2 * time.Second),
		}
		s.state = draining
		_ = s.terminal.event("REJECTED")
		if err := s.sendAck(draining); err != nil {
			return s.finish(draining, false)
		}
		return nil
	}
	if err != nil {
		return s.violation()
	}
	_ = s.touch()
	done := make(chan error, 1)
	s.state = &receiverWriting{receiverConnected: connection, message: message, done: done}
	go func() { done <- writeRecord(s.runner.Out, record) }()
	return nil
}
