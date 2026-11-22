package proxyingress

import (
	"crypto/subtle"
	"encoding/base64"
	"net/http"
	"strings"
)

func encodeBasic(credentials Credentials) string {
	return base64.StdEncoding.EncodeToString([]byte(credentials.Username + ":" + credentials.Password))
}

// authorizedHeader accepts exactly one well-formed Basic credential that
// matches the configured value. Duplicate or alternative schemes are rejected
// so a client cannot smuggle a second credential past the check.
func authorizedHeader(header http.Header, expectedValue string) bool {
	values := header.Values("Proxy-Authorization")
	if len(values) != 1 {
		return false
	}
	scheme, encoded, ok := strings.Cut(strings.TrimSpace(values[0]), " ")
	if !ok || !strings.EqualFold(scheme, "Basic") {
		return false
	}
	return constantTimeEqual(strings.TrimSpace(encoded), expectedValue)
}

func constantTimeEqual(left, right string) bool {
	if len(left) != len(right) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}
