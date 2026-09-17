package nativeaccount

import (
	"encoding/json"
	"net/mail"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func geminiIdentity(providerID string, native map[string]any) (accountcore.NativeIdentity, error) {
	accounts := object(native["googleAccounts"])
	oauth := object(native["oauthCreds"])
	email := normalizedEmail(text(accounts["active"]))
	if email == "" || !hasSecret(oauth, "access_token", "accessToken", "refresh_token", "refreshToken") {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	return accountcore.NewNativeEmailIdentity(providerID, email)
}

func normalizedEmail(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	parsed, err := mail.ParseAddress(normalized)
	if err != nil || parsed.Address != normalized || strings.Count(normalized, "@") != 1 {
		return ""
	}
	return normalized
}

// agyNativeIdentity validates only the email-based identity; token parsing and
// timestamp validation remain in the AGY core credential constructor.
func agyNativeIdentity(native map[string]any) (accountcore.NativeIdentity, error) {
	email := normalizedEmail(text(native["email"]))
	if email == "" {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	return accountcore.NewNativeEmailIdentity("agy", email)
}

func parseAGYTime(value any) int64 {
	switch typed := value.(type) {
	case float64:
		if typed > 0 && typed < 1e13 {
			return int64(typed)
		}
		if typed > 0 {
			return int64(typed)
		}
	case json.Number:
		if number, err := typed.Int64(); err == nil {
			if number > 0 && number < 1e13 {
				return number
			}
			return number
		}
	case string:
		if parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(typed)); err == nil {
			return parsed.UnixMilli()
		}
	}
	return 0
}
