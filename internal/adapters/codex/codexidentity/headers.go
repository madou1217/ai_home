package codexidentity

import (
	"net/http"
	"strings"
)

func ClientHeaders(source http.Header) (http.Header, bool) {
	originator, ok := SingleSafeHeader(source, "Originator")
	if !ok || !codexOriginatorPattern.MatchString(originator) {
		return nil, false
	}
	userAgent, ok := SingleSafeHeader(source, "User-Agent")
	if !ok || !strings.HasPrefix(userAgent, originator+"/") {
		return nil, false
	}
	identity := make(http.Header)
	identity.Set("Originator", originator)
	identity.Set("User-Agent", userAgent)
	for _, name := range []string{"Version", "X-Codex-Turn-Metadata", "X-Codex-Beta-Features", "X-Codex-Window-Id", "X-OpenAI-Internal-Codex-Responses-Lite"} {
		if value, found := SingleSafeHeader(source, name); found {
			identity.Set(name, value)
		}
	}
	return identity, true
}

func SingleSafeHeader(source http.Header, name string) (string, bool) {
	values := source.Values(name)
	if len(values) != 1 || values[0] == "" || len(values[0]) > 4096 {
		return "", false
	}
	for _, char := range values[0] {
		if char < 0x20 || char == 0x7f {
			return "", false
		}
	}
	return values[0], true
}
