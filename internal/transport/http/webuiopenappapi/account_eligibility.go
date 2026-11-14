package webuiopenappapi

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
)

func evaluateAccountEligibility(snapshot AccountSnapshot, now time.Time) *Result {
	authInvalid := snapshot.AuthInvalid
	if snapshot.Provider == "zcode" && isZcodeDesktopSessionExpired(snapshot.NativeAuthJSON, now) {
		authInvalid = true
	}
	if isCodebuddyFamily(snapshot.Provider) {
		if invalid := isCodebuddyAuthInvalid(snapshot.Provider, snapshot.NativeAuthJSON, now); invalid {
			authInvalid = true
		}
	}
	configured := snapshot.Configured
	if authInvalid {
		configured = false
	}

	if authInvalid {
		return &Result{
			OK:      false,
			Error:   "account_auth_invalid",
			Message: launchErrorMessage("account_auth_invalid"),
		}
	}
	if !configured {
		return &Result{
			OK:      false,
			Error:   "account_unconfigured",
			Message: launchErrorMessage("account_unconfigured"),
		}
	}
	return nil
}

func isCodebuddyFamily(provider string) bool {
	p := strings.ToLower(strings.TrimSpace(provider))
	for _, member := range storagepolicy.FamilyProviders {
		if p == member {
			return true
		}
	}
	return false
}

// isZcodeDesktopSessionExpired 对标 Node isZcodeDesktopSessionExpired：
// 当 access_token 是带 exp 的 JWT、已经过期、且没有 refresh_token 时，桌面端必弹过期窗，提前拦截。
func isZcodeDesktopSessionExpired(nativeAuthJSON json.RawMessage, now time.Time) bool {
	if len(nativeAuthJSON) == 0 {
		return false
	}
	var root map[string]any
	if err := json.Unmarshal(nativeAuthJSON, &root); err != nil || root == nil {
		return false
	}
	creds, ok := root["credentials"].(map[string]any)
	if !ok || creds == nil {
		return false
	}
	activeProvider := strings.ToLower(strings.TrimSpace(stringField(creds, "oauth:active_provider")))
	accessKey := "oauth:zai:access_token"
	refreshKey := "oauth:zai:refresh_token"
	if activeProvider == "bigmodel" {
		accessKey = "oauth:bigmodel:access_token"
		refreshKey = "oauth:bigmodel:refresh_token"
	}
	accessToken := stringField(creds, accessKey)
	if accessToken == "" {
		accessToken = stringField(creds, "oauth:zai:access_token")
	}
	refreshToken := stringField(creds, refreshKey)
	if refreshToken == "" {
		refreshToken = stringField(creds, "oauth:zai:refresh_token")
	}
	if accessToken == "" || refreshToken != "" {
		return false
	}
	expMS := parseJWTExpMS(accessToken)
	if expMS <= 0 {
		return false
	}
	return expMS <= now.UnixMilli()
}

func isCodebuddyAuthInvalid(provider string, nativeAuthJSON json.RawMessage, now time.Time) bool {
	if len(nativeAuthJSON) == 0 {
		return false
	}
	if _, err := nativeaccount.NewDecoder().DecodeNativeAuth(provider, nativeAuthJSON); err != nil {
		// 仅检查明确存在的 OAuth 凭据是否结构损坏或 refreshExpiresAt 过期；api_key 账号不按此判失效。
		var root map[string]any
		if json.Unmarshal(nativeAuthJSON, &root) == nil && root != nil {
			if creds, ok := root["credentials"].(map[string]any); ok && creds != nil {
				return true
			}
		}
		return false
	}
	var root map[string]any
	if err := json.Unmarshal(nativeAuthJSON, &root); err != nil || root == nil {
		return false
	}
	creds, _ := root["credentials"].(map[string]any)
	if creds == nil {
		creds = root
	}
	auth, _ := creds["auth"].(map[string]any)
	if auth == nil {
		return false
	}
	refreshExpiresAt := int64Field(auth, "refreshExpiresAt", "refresh_expires_at")
	return refreshExpiresAt > 0 && refreshExpiresAt <= now.UnixMilli()
}

func parseJWTExpMS(token string) int64 {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) < 2 {
		return 0
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return 0
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil || claims == nil {
		return 0
	}
	switch v := claims["exp"].(type) {
	case float64:
		if v > 0 {
			return int64(v * 1000)
		}
	case int64:
		if v > 0 {
			return v * 1000
		}
	}
	return 0
}

func stringField(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if m == nil {
			continue
		}
		if raw, ok := m[key].(string); ok {
			if trimmed := strings.TrimSpace(raw); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}

func int64Field(m map[string]any, keys ...string) int64 {
	for _, key := range keys {
		if m == nil {
			continue
		}
		switch v := m[key].(type) {
		case float64:
			return int64(v)
		case int64:
			return v
		case json.Number:
			if parsed, err := v.Int64(); err == nil {
				return parsed
			}
		}
	}
	return 0
}
