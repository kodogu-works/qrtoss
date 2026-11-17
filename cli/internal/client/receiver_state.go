package client

import (
	"time"

	"github.com/wistaria/qrtoss/cli/internal/constants"
)

// Each phase owns only the data that remains valid in that phase. Starting and
// Renewing belong to Runner; a terminal receiveResult represents Done or Failed.
type receiverState interface{ receiverState() }

type receiverPairing struct {
	url      string
	psk      []byte
	deadline time.Time
}

type receiverCandidate struct {
	*receiverPairing
	peer, nonce string
	expires     time.Time
}

type receiverCommitting struct {
	*receiverCandidate
	keys Keys
}

type receiverPeer struct {
	id     string
	cipher Cipher
}

type receiverConfirming struct {
	*receiverPeer
	deadline time.Time
}

type receiverActivating struct {
	*receiverPeer
	deadline time.Time
}

type receiverConnected struct {
	*receiverPeer
	idleDeadline time.Time
	activity     receiverActivity
}

type receiverMessage struct {
	id     string
	digest [32]byte
}

type receiverWriting struct {
	*receiverConnected
	message receiverMessage
	done    <-chan error
}

// A lost connection must not discard or restart an in-progress stdout write.
type receiverWritingDisconnected struct{ *receiverWriting }

type receiptStatus uint8

const (
	receiptReceived receiptStatus = iota
	receiptRejected
)

type receiverDraining struct {
	*receiverConnected
	message  receiverMessage
	status   receiptStatus
	deadline time.Time
}

func (*receiverPairing) receiverState()             {}
func (*receiverCandidate) receiverState()           {}
func (*receiverCommitting) receiverState()          {}
func (*receiverConfirming) receiverState()          {}
func (*receiverActivating) receiverState()          {}
func (*receiverConnected) receiverState()           {}
func (*receiverWriting) receiverState()             {}
func (*receiverWritingDisconnected) receiverState() {}
func (*receiverDraining) receiverState()            {}

// Embedding carries shared pairing/connection data through its valid phases.
func (p *receiverPairing) pairingInfo() *receiverPairing          { return p }
func (c *receiverCandidate) pairingCandidate() *receiverCandidate { return c }
func (p *receiverPeer) sessionPeer() *receiverPeer                { return p }
func (c *receiverConnected) connection() *receiverConnected       { return c }

func (s *receiver) pairing() *receiverPairing {
	if state, ok := s.state.(interface{ pairingInfo() *receiverPairing }); ok {
		return state.pairingInfo()
	}
	return nil
}

func (s *receiver) candidate() *receiverCandidate {
	if state, ok := s.state.(interface{ pairingCandidate() *receiverCandidate }); ok {
		return state.pairingCandidate()
	}
	return nil
}

func (s *receiver) peer() *receiverPeer {
	if state, ok := s.state.(interface{ sessionPeer() *receiverPeer }); ok {
		return state.sessionPeer()
	}
	return nil
}

func (s *receiver) connection() *receiverConnected {
	if state, ok := s.state.(interface{ connection() *receiverConnected }); ok {
		return state.connection()
	}
	return nil
}

func (s *receiver) message() *receiverMessage {
	switch state := s.state.(type) {
	case *receiverWriting:
		return &state.message
	case *receiverWritingDisconnected:
		return &state.message
	case *receiverDraining:
		return &state.message
	default:
		return nil
	}
}

func (s *receiver) outputDone() <-chan error {
	switch state := s.state.(type) {
	case *receiverWriting:
		return state.done
	case *receiverWritingDisconnected:
		return state.done
	default:
		return nil
	}
}

func (s *receiver) drainDeadline() time.Time {
	if state, ok := s.state.(*receiverDraining); ok {
		return state.deadline
	}
	return time.Time{}
}

// receiverActivity keeps local activity independent of delayed touch delivery.
type receiverActivity struct {
	last, sent time.Time
	pending    bool
}

func (a *receiverActivity) record(now time.Time) { a.last = now; a.pending = true }

func (a *receiverActivity) due(now, serverDeadline time.Time) bool {
	if !a.pending {
		return false
	}
	return a.sent.IsZero() ||
		now.Sub(a.sent) >= constants.TOUCH_COALESCE_SECONDS*time.Second ||
		serverDeadline.Sub(now) <= constants.TOUCH_URGENT_REMAINING_SECONDS*time.Second
}

func (a *receiverActivity) expired(now time.Time) bool {
	return !a.last.IsZero() && now.Sub(a.last) >= constants.SESSION_IDLE_SECONDS*time.Second
}
