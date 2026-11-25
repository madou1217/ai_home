package acpclient

import (
	"os"
	"strings"
)

// agentEnvironment gives the agent only the host variables it legitimately
// needs. In particular, AIH management keys and unrelated cloud credentials
// must not leak into an agent process. Callers that need more can pass Env
// explicitly in Config.
func agentEnvironment(extra []string) []string {
	allowed := map[string]bool{
		"PATH": true, "HOME": true, "USER": true, "LOGNAME": true, "SHELL": true,
		"TERM": true, "TMPDIR": true, "TMP": true, "TEMP": true,
		"SystemRoot": true, "ComSpec": true, "PATHEXT": true, "WINDIR": true,
		"APPDATA": true, "LOCALAPPDATA": true, "USERPROFILE": true,
		"SSL_CERT_FILE": true, "SSL_CERT_DIR": true,
		"HTTP_PROXY": true, "HTTPS_PROXY": true, "NO_PROXY": true, "ALL_PROXY": true,
		"http_proxy": true, "https_proxy": true, "no_proxy": true, "all_proxy": true,
	}
	allowedPrefixes := []string{"LC_", "XDG_", "ANTIGRAVITY_", "GOOGLE_", "GEMINI_"}
	result := make([]string, 0, len(extra)+16)
	for _, item := range os.Environ() {
		key, _, found := strings.Cut(item, "=")
		if !found {
			continue
		}
		if allowed[key] || hasAnyPrefix(key, allowedPrefixes) {
			result = append(result, item)
		}
	}
	return append(result, extra...)
}

func hasAnyPrefix(value string, prefixes []string) bool {
	for _, prefix := range prefixes {
		if strings.HasPrefix(value, prefix) {
			return true
		}
	}
	return false
}
