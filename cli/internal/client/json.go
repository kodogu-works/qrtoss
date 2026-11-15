package client

import (
	"bytes"
	"encoding/json"
	"errors"
	"github.com/wistaria/qrtoss/cli/internal/constants"
	"io"
	"unicode/utf8"
)

func strict(b []byte, v any) error {
	if !utf8.Valid(b) {
		return errors.New("invalid JSON")
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return e
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("trailing JSON")
	}
	d = json.NewDecoder(bytes.NewReader(b))
	return unique(d)
}
func unique(d *json.Decoder) error {
	t, e := d.Token()
	if e != nil {
		return e
	}
	if del, ok := t.(json.Delim); ok {
		switch del {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				t, e = d.Token()
				if e != nil {
					return e
				}
				k, ok := t.(string)
				if !ok || seen[k] {
					return errors.New("duplicate key")
				}
				seen[k] = true
				if e = unique(d); e != nil {
					return e
				}
			}
			_, e = d.Token()
			return e
		case '[':
			for d.More() {
				if e = unique(d); e != nil {
					return e
				}
			}
			_, e = d.Token()
			return e
		default:
			return errors.New("invalid JSON")
		}
	}
	return nil
}
func str(m map[string]json.RawMessage, k string) string {
	var v string
	_ = json.Unmarshal(m[k], &v)
	return v
}
func integer(m map[string]json.RawMessage, k string) (int64, bool) {
	var v int64
	e := json.Unmarshal(m[k], &v)
	return v, e == nil && m[k] != nil && string(m[k]) != "null"
}
func fieldsOnly(m map[string]json.RawMessage, fields ...string) error {
	if len(m) != len(fields) {
		return errors.New("invalid fields")
	}
	for _, f := range fields {
		if m[f] == nil || bytes.Equal(m[f], []byte("null")) {
			return errors.New("missing field")
		}
	}
	return nil
}
func control(b []byte) (map[string]json.RawMessage, error) {
	var m map[string]json.RawMessage
	if len(b) > constants.MAX_WS_MESSAGE_BYTES {
		return nil, errors.New("message too large")
	}
	if e := strict(b, &m); e != nil {
		return nil, e
	}
	v, ok := integer(m, "v")
	if !ok || v != 1 {
		return nil, errors.New("version mismatch")
	}
	t := str(m, "type")
	if t == "cipher" {
		return m, nil
	}
	if len(b) > constants.MAX_CONTROL_MESSAGE_BYTES {
		return nil, errors.New("control too large")
	}
	f := []string{"v", "type"}
	switch t {
	case "auth.ok":
		f = append(f, "role", "room", "serverTime", "pairingExpiresAt")
		if str(m, "role") != "receiver" {
			return nil, errors.New("invalid role")
		}
	case "hb.pong":
		f = append(f, "id", "serverTime")
	case "pair.candidate":
		f = append(f, "peer", "serverTime", "candidateExpiresAt")
	case "pair.proof":
		f = append(f, "peer", "sNonce", "proof")
	case "pair.committed":
		f = append(f, "peer", "serverTime", "readyExpiresAt", "idleExpiresAt")
	case "pair.active", "room.touched":
		f = append(f, "peer", "serverTime", "idleExpiresAt")
	case "pair.candidate_closed":
		f = append(f, "peer", "code")
	case "room.closed":
		f = append(f, "code")
	case "error":
		f = append(f, "code", "scope")
		if !oneOf(str(m, "scope"), "socket", "candidate", "room") {
			return nil, errors.New("invalid error scope")
		}
	default:
		return nil, errors.New("invalid message type")
	}
	if e := fieldsOnly(m, f...); e != nil {
		return nil, e
	}
	for _, key := range []string{"serverTime", "pairingExpiresAt", "candidateExpiresAt", "readyExpiresAt", "idleExpiresAt", "id"} {
		if m[key] != nil {
			n, ok := integer(m, key)
			if !ok || n < 0 {
				return nil, errors.New("invalid timestamp")
			}
		}
	}
	if m["peer"] != nil {
		if _, e := Decode(str(m, "peer"), 16); e != nil {
			return nil, e
		}
	}
	return m, nil
}
