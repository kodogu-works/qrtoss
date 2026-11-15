package client

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/wistaria/qrtoss/cli/internal/constants"
	"math"
	"regexp"
	"strconv"
	"unicode/utf8"
)

var alphabet = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func B64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
func Decode(s string, n int) ([]byte, error) {
	if !alphabet.MatchString(s) {
		return nil, errors.New("invalid encoding")
	}
	b, e := base64.RawURLEncoding.Strict().DecodeString(s)
	if e != nil || B64(b) != s || (n >= 0 && len(b) != n) {
		return nil, errors.New("invalid encoding")
	}
	return b, nil
}
func Random(n int) string {
	b := make([]byte, n)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return B64(b)
}

type Keys struct {
	Proof, S2R, R2S []byte
	Transcript      []byte
}

func Derive(psk []byte, room, peer, rnonce, snonce string) (Keys, error) {
	var k Keys
	if len(psk) != 32 {
		return k, errors.New("invalid key")
	}
	for _, v := range []struct {
		s string
		n int
	}{{room, 16}, {peer, 16}, {rnonce, 32}, {snonce, 32}} {
		if _, e := Decode(v.s, v.n); e != nil {
			return k, e
		}
	}
	k.Transcript = []byte("qrtoss/1\n" + room + "\n" + peer + "\n" + rnonce + "\n" + snonce + "\n")
	salt := sha256.Sum256(k.Transcript)
	var e error
	k.Proof, e = hkdf.Key(sha256.New, psk, salt[:], "qrtoss/1/proof", 32)
	if e != nil {
		return k, e
	}
	k.S2R, e = hkdf.Key(sha256.New, psk, salt[:], "qrtoss/1/s2r", 32)
	if e != nil {
		return k, e
	}
	k.R2S, e = hkdf.Key(sha256.New, psk, salt[:], "qrtoss/1/r2s", 32)
	return k, e
}
func (k Keys) MAC(role string) []byte {
	h := hmac.New(sha256.New, k.Proof)
	h.Write([]byte(role + "\n"))
	h.Write(k.Transcript)
	return h.Sum(nil)
}

type Envelope struct {
	V    int    `json:"v"`
	Type string `json:"type"`
	Room string `json:"room"`
	Peer string `json:"peer"`
	Dir  string `json:"dir"`
	Seq  string `json:"seq"`
	CT   string `json:"ct"`
}
type Cipher struct {
	Room, Peer                   string
	Keys                         Keys
	Send, Recv                   uint64
	sendExhausted, recvExhausted bool
}

func gcm(key []byte) (cipher.AEAD, error) {
	b, e := aes.NewCipher(key)
	if e != nil {
		return nil, e
	}
	return cipher.NewGCM(b)
}
func aad(room, peer, dir, seq string) []byte {
	return []byte("qrtoss/1/cipher\n" + room + "\n" + peer + "\n" + dir + "\n" + seq + "\n")
}
func Seal(key []byte, room, peer, dir string, seq uint64, plain []byte) (Envelope, error) {
	e := Envelope{1, "cipher", room, peer, dir, strconv.FormatUint(seq, 10), ""}
	g, err := gcm(key)
	if err != nil {
		return e, err
	}
	iv := make([]byte, 12)
	binary.BigEndian.PutUint64(iv[4:], seq)
	e.CT = B64(g.Seal(nil, iv, plain, aad(room, peer, dir, e.Seq)))
	return e, nil
}
func (c *Cipher) Encrypt(v any) (Envelope, error) {
	if c.sendExhausted {
		return Envelope{}, errors.New("sequence exhausted")
	}
	b, e := json.Marshal(v)
	if e != nil || len(b) > constants.MAX_PLAINTEXT_BYTES {
		return Envelope{}, errors.New("invalid plaintext")
	}
	out, e := Seal(c.Keys.R2S, c.Room, c.Peer, "r2s", c.Send, b)
	if e == nil {
		if c.Send == math.MaxUint64 {
			c.sendExhausted = true
		} else {
			c.Send++
		}
	}
	return out, e
}
func (c *Cipher) Decrypt(raw []byte) (map[string]json.RawMessage, error) {
	var out map[string]json.RawMessage
	var env Envelope
	if e := strict(raw, &env); e != nil {
		return nil, e
	}
	if env.V != 1 || env.Type != "cipher" || env.Room != c.Room || env.Peer != c.Peer || env.Dir != "s2r" || !decimal.MatchString(env.Seq) || c.recvExhausted {
		return nil, errors.New("invalid envelope")
	}
	seq, e := strconv.ParseUint(env.Seq, 10, 64)
	if e != nil || seq != c.Recv {
		return nil, errors.New("invalid sequence")
	}
	if len(env.CT) > 30059 {
		return nil, errors.New("ciphertext too large")
	}
	ct, e := Decode(env.CT, -1)
	if e != nil || len(ct) < 16 || len(ct) > 22544 {
		return nil, errors.New("invalid ciphertext")
	}
	g, e := gcm(c.Keys.S2R)
	if e != nil {
		return nil, e
	}
	iv := make([]byte, 12)
	binary.BigEndian.PutUint64(iv[4:], seq)
	b, e := g.Open(nil, iv, ct, aad(c.Room, c.Peer, env.Dir, env.Seq))
	if e != nil || !utf8.Valid(b) {
		return nil, errors.New("authentication failed")
	}
	if e = strict(b, &out); e != nil {
		return nil, e
	}
	if e = validateInner(out); e != nil {
		return nil, e
	}
	if c.Recv == math.MaxUint64 {
		c.recvExhausted = true
	} else {
		c.Recv++
	}
	return out, nil
}
func validateInner(m map[string]json.RawMessage) error {
	t := str(m, "type")
	var fields []string
	switch t {
	case "ready":
		fields = []string{"type"}
	case "activity":
		fields = []string{"type"}
	case "status":
		fields = []string{"type", "state"}
		if !oneOf(str(m, "state"), "scanning", "scanned", "ready") {
			return errors.New("invalid status")
		}
	case "data":
		fields = []string{"type", "id", "textB64"}
		if _, e := Decode(str(m, "id"), 16); e != nil {
			return e
		}
		b, e := Decode(str(m, "textB64"), -1)
		if e != nil || len(b) < 1 || len(b) > constants.MAX_TEXT_UTF8_BYTES || !utf8.Valid(b) {
			return errors.New("invalid text")
		}
	case "ack_seen":
		fields = []string{"type", "id"}
		if _, e := Decode(str(m, "id"), 16); e != nil {
			return e
		}
	default:
		return fmt.Errorf("invalid message type")
	}
	return fieldsOnly(m, fields...)
}
