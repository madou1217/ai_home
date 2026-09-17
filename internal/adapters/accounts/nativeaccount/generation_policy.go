package nativeaccount

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"sort"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// nativeGenerations reads only credential-origin time facts. A request timestamp,
// file mtime, Kiro observation timestamp or changed bytes is not renewal evidence.
// Missing facts permit first enrollment but prohibit an ambiguous replacement.
func nativeGenerations(provider string, native map[string]any) []accountcore.NativeGeneration {
	switch provider {
	case "gemini":
		return expiryGeneration("google.expiry_date", object(native["oauthCreds"])["expiry_date"])
	case "kiro":
		auth := object(native["auth"])
		if value := jwtGeneration("kiro.access.iat", firstText(auth, "access_token", "accessToken")); len(value) != 0 {
			return value
		}
		return expiryGeneration("kiro.expires_at", auth["expires_at"])
	case "opencode":
		return openCodeGenerations(object(native["auth"]))
	case "grok":
		auth := object(native["auth"])
		if hasSecret(auth, "key", "access_token", "accessToken") {
			return jwtGeneration("grok.access.iat", firstText(auth, "key", "access_token", "accessToken"))
		}
		result := []accountcore.NativeGeneration{}
		for key, raw := range auth {
			profile := object(raw)
			values := jwtGeneration("grok-"+hashIdentityScope(key)+".iat", firstText(profile, "key", "access_token", "accessToken"))
			if len(values) == 0 {
				return nil
			}
			result = append(result, values...)
		}
		sort.Slice(result, func(i, j int) bool { return result[i].Scope < result[j].Scope })
		return result
	case "qoder", "qodercn":
		payload := object(native["userInfo"])
		return jwtGeneration("qoder.access.iat", firstText(payload, "security_oauth_token", "access_token", "accessToken", "token"))
	case "codebuddy", "codebuddycn", "workbuddy", "workbuddycn":
		auth := object(object(native["credentials"])["auth"])
		return jwtGeneration("codebuddy.access.iat", firstText(auth, "accessToken", "access_token"))
	case "kimi":
		auth := object(native["credentials"])
		if auth == nil {
			auth = object(native["auth"])
		}
		return jwtGeneration("kimi.access.iat", firstText(auth, "access_token", "accessToken"))
	case "zcode":
		auth := object(native["credentials"])
		return jwtGeneration("zcode.access.iat", firstText(auth, "zcodejwttoken", "oauth:zai:access_token"))
	default:
		return nil
	}
}

func openCodeGenerations(auth map[string]any) []accountcore.NativeGeneration {
	result := []accountcore.NativeGeneration{}
	for key, raw := range auth {
		record := object(raw)
		if firstText(record, "type") != "oauth" {
			continue
		}
		values := jwtGeneration("opencode-"+hashIdentityScope(key)+".iat", firstText(record, "access", "access_token"))
		if len(values) == 0 {
			return nil
		}
		result = append(result, values...)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Scope < result[j].Scope })
	return result
}

func jwtGeneration(scope, token string) []accountcore.NativeGeneration {
	claims := jwtClaims(token)
	issued := positiveInteger(claims["iat"])
	if issued <= 0 || issued > 253_402_300_799 {
		return nil
	}
	return []accountcore.NativeGeneration{{Scope: scope, Value: issued * 1000}}
}

func expiryGeneration(scope string, value any) []accountcore.NativeGeneration {
	var millis int64
	if text, ok := value.(string); ok {
		if parsed, err := time.Parse(time.RFC3339, text); err == nil {
			millis = parsed.UnixMilli()
		}
	} else {
		millis = positiveInteger(value)
	}
	if millis <= 0 || millis > 253_402_300_799_999 {
		return nil
	}
	return []accountcore.NativeGeneration{{Scope: scope, Value: millis}}
}

func positiveInteger(value any) int64 {
	switch number := value.(type) {
	case json.Number:
		result, err := number.Int64()
		if err == nil && result > 0 {
			return result
		}
	case float64:
		if number > 0 && number <= 9_007_199_254_740_991 && math.Trunc(number) == number {
			return int64(number)
		}
	}
	return 0
}

func hashIdentityScope(value string) string {
	hash := sha256.Sum256([]byte(value))
	return hex.EncodeToString(hash[:])[:16]
}
