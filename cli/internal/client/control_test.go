package client

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestSharedControlVectors(t *testing.T) {
	b, err := os.ReadFile("../../../protocol/vectors/control.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Cases []struct {
			Name    string
			Targets []string
			JSON    string
		}
	}
	if err := json.Unmarshal(b, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors.Cases {
		t.Run(vector.Name, func(t *testing.T) {
			var message map[string]json.RawMessage
			parseErr := strict([]byte(vector.JSON), &message)
			for _, target := range []string{"server", "receiver", "sender"} {
				want := oneOf(target, vector.Targets...)
				valid := parseErr == nil && validateControl(message, target) == nil
				if valid != want {
					t.Fatalf("%s: valid=%v want=%v", target, valid, want)
				}
				// Cipher routing deliberately defers validation to Cipher.Decrypt.
				if target == "receiver" && str(message, "type") != "cipher" {
					_, err := control([]byte(vector.JSON))
					if (err == nil) != want {
						t.Fatalf("CLI control valid=%v want=%v", err == nil, want)
					}
				}
				if !want {
					continue
				}
				message["extra"] = json.RawMessage(`true`)
				if validateControl(message, target) == nil {
					t.Fatal("accepted extra field")
				}
				delete(message, "extra")
				fields := make([]string, 0, len(message))
				for key := range message {
					fields = append(fields, key)
				}
				for _, key := range fields {
					value := message[key]
					delete(message, key)
					if validateControl(message, target) == nil {
						t.Fatalf("accepted missing %s", key)
					}
					message[key] = json.RawMessage(`null`)
					if validateControl(message, target) == nil {
						t.Fatalf("accepted null %s", key)
					}
					delete(message, key)
					message[strings.ToUpper(key)] = value
					if validateControl(message, target) == nil {
						t.Fatalf("accepted case alias %s", key)
					}
					delete(message, strings.ToUpper(key))
					message[key] = value
				}
			}
		})
	}
}
