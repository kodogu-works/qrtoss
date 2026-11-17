package client

import (
	"bytes"
	"encoding/json"
	"errors"
	"github.com/wistaria/qrtoss/cli/internal/constants"
	"io"
	"math"
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

// Match JavaScript's safe integer value domain, including integral JSON exponents.
func integer(m map[string]json.RawMessage, k string) (int64, bool) {
	var n float64
	e := json.Unmarshal(m[k], &n)
	if e != nil || m[k] == nil || bytes.Equal(bytes.TrimSpace(m[k]), []byte("null")) || math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n || n < -9007199254740991 || n > 9007199254740991 {
		return 0, false
	}
	return int64(n), true
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
	if e := validateControl(m, "receiver"); e != nil {
		return nil, e
	}
	return m, nil
}

type controlFieldRule struct {
	kind     string
	bytes    int
	min, max int64
	values   []string
}
type controlSchema struct {
	kind    string
	targets []string
	fields  map[string]string
}

// Generated tables describe wire shape; session.go enforces state and peer binding.
func validateControl(m map[string]json.RawMessage, target string) error {
	v, ok := integer(m, "v")
	if !ok || v != 1 {
		return errors.New("version mismatch")
	}
	for _, schema := range controlSchemas {
		if schema.kind != str(m, "type") || !oneOf(target, schema.targets...) {
			continue
		}
		fields := []string{"v", "type"}
		for field := range schema.fields {
			fields = append(fields, field)
		}
		if fieldsOnly(m, fields...) != nil {
			continue
		}
		valid := true
		for field, name := range schema.fields {
			rule := controlFieldTypes[name]
			switch rule.kind {
			case "integer":
				n, ok := integer(m, field)
				if !ok || n < rule.min || n > rule.max {
					valid = false
				}
			case "base64url":
				if _, err := Decode(str(m, field), rule.bytes); err != nil {
					valid = false
				}
			case "enum":
				if !oneOf(str(m, field), rule.values...) {
					valid = false
				}
			default:
				valid = false
			}
		}
		if valid {
			return nil
		}
	}
	return errors.New("invalid control message")
}
