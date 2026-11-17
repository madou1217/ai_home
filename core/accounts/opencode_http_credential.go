package accounts

import (
	"encoding/json"
	"strings"
)

// These are the existing official HTTP endpoints, not an account URL override.
const (
	OpenCodeGoHTTPBaseURL  = "https://opencode.ai/zen/go/v1"
	OpenCodeZenHTTPBaseURL = "https://opencode.ai/zen/v1"
)

// OpenCodeHTTPAPIKey is the single native credential/HTTP transport boundary.
// AuthKind alone is not evidence that a usable key exists in an official slot.
// The caller must not log the returned key. OAuth (including mixed grants) and
// arbitrary upstream slots retain their unsupported HTTP meaning.
func OpenCodeHTTPAPIKey(credential *NativeCredential, zenFirst bool) (string, bool) {
	if credential == nil || credential.ProviderID() != "opencode" || credential.AuthKind() != "api-key" {
		return "", false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(credential.payload, &fields) != nil || fields == nil {
		return "", false
	}
	auth := fields
	var nested map[string]json.RawMessage
	if json.Unmarshal(fields["auth"], &nested) == nil && nested != nil {
		auth = nested
	}
	preferred := [2]string{"opencode-go", "opencode"}
	if zenFirst {
		preferred = [2]string{"opencode", "opencode-go"}
	}
	for _, name := range preferred {
		var record map[string]json.RawMessage
		if json.Unmarshal(auth[name], &record) != nil || record == nil {
			continue
		}
		// Preserve the pre-existing relay's type and key parsing contract exactly.
		var typ string
		if len(record["type"]) > 0 && json.Unmarshal(record["type"], &typ) == nil && typ != "" && !strings.EqualFold(strings.TrimSpace(typ), "api") && !strings.EqualFold(strings.TrimSpace(typ), "api-key") {
			continue
		}
		var key string
		if json.Unmarshal(record["key"], &key) == nil && strings.TrimSpace(key) != "" {
			return strings.TrimSpace(key), true
		}
	}
	return "", false
}
