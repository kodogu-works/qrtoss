package client

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
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

func (r *Runner) receive(ctx context.Context, o Options, t *terminal, h *http.Client, deadline, recovery time.Time) (int, error) {
	session, err := r.connectReceiver(ctx, o, t, h, deadline, recovery)
	if err != nil {
		return 0, err
	}
	defer session.conn.CloseNow()
	// Long-lived reads are independent of the room creation/authentication timeout.
	stopRead := session.startReading()
	defer stopRead()
	if err := session.showPairing(); err != nil {
		return 0, err
	}
	defer session.closeRoom("user_end")
	return session.run()
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
