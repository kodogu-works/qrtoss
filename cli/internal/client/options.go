package client

import (
	"errors"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// DefaultServer may be set with -ldflags -X when building a release.
var DefaultServer = "https://qrtoss.example"
var Version = "0.1.0-dev"
var Commit = "unknown"

type Options struct {
	Server, Format, QR, Color, Lang string
	Timeout                         time.Duration
	PairingURL, Help, Version       bool
}
type Env func(string) string

var decimal = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)

func Parse(args []string, env Env) (Options, error) {
	o := Options{Server: DefaultServer, Format: "text", QR: "auto", Color: "auto", Lang: "auto"}
	for _, a := range args {
		if a == "--help" {
			o.Help = true
		}
		if a == "--version" {
			o.Version = true
		}
	}
	if o.Help || o.Version {
		o.Lang = language("auto", env)
		return o, nil
	}
	if s := env("QRTOSS_SERVER"); s != "" {
		o.Server = s
	}
	seen := map[string]string{}
	booleans := map[string]bool{"jsonl": true, "pairing-url": true}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "--") || len(a) == 2 {
			return o, errors.New("invalid option")
		}
		k, v, eq := strings.Cut(a[2:], "=")
		if booleans[k] {
			if eq {
				return o, errors.New("boolean option has value")
			}
			v = "true"
		} else {
			switch k {
			case "timeout", "format", "qr", "color", "lang", "server":
			default:
				return o, errors.New("unknown option")
			}
			if !eq {
				i++
				if i >= len(args) {
					return o, errors.New("missing option value")
				}
				v = args[i]
			}
		}
		if p, ok := seen[k]; ok && p != v {
			return o, errors.New("conflicting option")
		}
		seen[k] = v
		switch k {
		case "jsonl":
			o.Format = "jsonl"
		case "pairing-url":
			o.PairingURL = true
		case "format":
			o.Format = v
		case "qr":
			o.QR = v
		case "color":
			o.Color = v
		case "lang":
			o.Lang = v
		case "server":
			o.Server = v
		case "timeout":
			n, e := strconv.ParseUint(v, 10, 31)
			if e != nil || !decimal.MatchString(v) {
				return o, errors.New("invalid timeout")
			}
			o.Timeout = time.Duration(n) * time.Second
		}
	}
	if _, ok := seen["jsonl"]; ok {
		if f, ok := seen["format"]; ok && f != "jsonl" {
			return o, errors.New("conflicting format")
		}
		o.Format = "jsonl"
	}
	if !oneOf(o.Format, "text", "jsonl") || !oneOf(o.QR, "auto", "compact", "full", "off") || !oneOf(o.Color, "auto", "always", "never") || !oneOf(o.Lang, "auto", "ja", "en", "es") {
		return o, errors.New("invalid option value")
	}
	if o.QR == "off" && !o.PairingURL {
		return o, errors.New("--qr off requires --pairing-url")
	}
	var e error
	o.Server, e = Origin(o.Server)
	o.Lang = language(o.Lang, env)
	return o, e
}
func oneOf(s string, vs ...string) bool {
	for _, v := range vs {
		if s == v {
			return true
		}
	}
	return false
}
func Origin(s string) (string, error) {
	for _, c := range s {
		if c > 127 || c < 33 {
			return "", errors.New("invalid origin")
		}
	}
	u, e := url.Parse(s)
	if e != nil || !strings.EqualFold(u.Scheme, "https") || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(s, "#") || u.Opaque != "" || !oneOf(u.Path, "", "/") || strings.HasSuffix(u.Hostname(), ".") {
		return "", errors.New("HTTPS public origin required")
	}
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if strings.Contains(host, "%") || strings.HasSuffix(u.Host, ":") {
		return "", errors.New("invalid host")
	}
	if port != "" {
		p, e := strconv.Atoi(port)
		if e != nil || p < 1 || p > 65535 {
			return "", errors.New("invalid port")
		}
		port = strconv.Itoa(p)
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != "" && port != "443" {
		host = net.JoinHostPort(u.Hostname(), port)
	}
	return "https://" + strings.ToLower(host), nil
}

// Legacy --lang values remain accepted, but CLI presentation is always English.
func language(_ string, _ Env) string { return "en" }
