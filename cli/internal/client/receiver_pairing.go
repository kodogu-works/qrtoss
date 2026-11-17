package client

import (
	"crypto/hmac"
	"encoding/json"
	"time"
)

func (s *receiver) onCandidate(m map[string]json.RawMessage) *receiveResult {
	pairing, ok := s.state.(*receiverPairing)
	if !ok {
		return s.violation()
	}
	candidate := &receiverCandidate{
		receiverPairing: pairing,
		peer:            str(m, "peer"),
		nonce:           Random(32),
		expires:         controlDeadline(m, "candidateExpiresAt"),
	}
	s.state = candidate
	if err := s.control("pair.challenge", map[string]any{"peer": candidate.peer, "rNonce": candidate.nonce}, time.Time{}); err != nil {
		return receiveEnd(1, fail(3, "DISCONNECTED"))
	}
	return nil
}

func (s *receiver) onProof(m map[string]json.RawMessage) *receiveResult {
	candidate := s.candidate()
	if candidate == nil || str(m, "peer") != candidate.peer {
		return s.violation()
	}
	if candidate.expired() {
		return nil
	}
	keys, err := Derive(candidate.psk, s.room, candidate.peer, candidate.nonce, str(m, "sNonce"))
	proof, proofErr := Decode(str(m, "proof"), 32)
	valid := err == nil && proofErr == nil && hmac.Equal(keys.MAC("sender"), proof)
	// Verification can cross a deadline too. An in-flight commit is governed by
	// the server, while a proof not yet committed after expiry is simply ignored.
	if candidate.expired() {
		return nil
	}
	if !valid {
		_ = s.control("pair.reject", map[string]any{"peer": candidate.peer, "code": "AUTH_FAILED"}, time.Time{})
		s.state = candidate
		return nil
	}
	if err = s.control("pair.commit", map[string]any{"peer": candidate.peer}, time.Time{}); err != nil {
		return receiveEnd(1, fail(3, "DISCONNECTED"))
	}
	s.state = &receiverCommitting{receiverCandidate: candidate, keys: keys}
	return nil
}

func (c *receiverCandidate) expired() bool {
	now := time.Now()
	return !now.Before(c.expires) || !now.Before(c.receiverPairing.deadline)
}

func (s *receiver) onCandidateClosed(m map[string]json.RawMessage) *receiveResult {
	candidate := s.candidate()
	if candidate == nil || str(m, "peer") != candidate.peer {
		return s.violation()
	}
	s.state = candidate.receiverPairing
	return nil
}

func (s *receiver) onCommitted(m map[string]json.RawMessage) *receiveResult {
	committing, ok := s.state.(*receiverCommitting)
	if !ok || str(m, "peer") != committing.peer {
		return s.violation()
	}
	peer := &receiverPeer{
		id:     committing.peer,
		cipher: Cipher{Room: s.room, Peer: committing.peer, Keys: committing.keys},
	}
	s.state = &receiverConfirming{receiverPeer: peer}
	if err := s.control("pair.confirm", map[string]any{"peer": peer.id, "proof": B64(committing.keys.MAC("receiver"))}, time.Time{}); err != nil {
		return receiveEnd(1, fail(3, "DISCONNECTED"))
	}
	// Pairing secrets are absent from all subsequent states.
	peer.cipher.Keys.Proof = nil
	return nil
}

func (s *receiver) onActive(m map[string]json.RawMessage) *receiveResult {
	activating, ok := s.state.(*receiverActivating)
	if !ok || str(m, "peer") != activating.id {
		return s.violation()
	}
	connection := &receiverConnected{
		receiverPeer: activating.receiverPeer,
		idleDeadline: controlDeadline(m, "idleExpiresAt"),
		activity:     receiverActivity{last: time.Now()},
	}
	s.state = connection
	if err := s.terminal.event("CONNECTED"); err != nil {
		return receiveEnd(0, fail(5, "IO_ERROR"))
	}
	_ = s.touch()
	if err := s.sendCipher(map[string]any{"type": "mode", "value": "stdout"}); err != nil {
		return receiveEnd(1, fail(3, "DISCONNECTED"))
	}
	return nil
}

func controlDeadline(m map[string]json.RawMessage, field string) time.Time {
	expires, _ := integer(m, field)
	serverTime, _ := integer(m, "serverTime")
	return time.Now().Add(time.Duration(expires-serverTime) * time.Millisecond)
}
