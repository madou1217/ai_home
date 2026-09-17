package nativeaccount

import (
	"encoding/base64"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func subjectIdentity(providerID string, native map[string]any) (accountcore.NativeIdentity, error) {
	credentials := object(native["credentials"])
	if credentials == nil {
		credentials = object(native["auth"])
	}
	if credentials == nil {
		credentials = native
	}
	if !hasSecret(credentials, "access_token", "accessToken", "refresh_token", "refreshToken") {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	subject, ok := consistentSubjects(credentials)
	if !ok || subject == "" {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	return accountcore.NewNativeSubjectIdentity(providerID, subject)
}

func zcodeIdentity(providerID string, native map[string]any) (accountcore.NativeIdentity, error) {
	credentials := object(native["credentials"])
	if credentials == nil {
		credentials = native
	}
	if hasEncryptedValue(credentials) {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	userInfoRaw := firstText(credentials, "oauth:zai:user_info")
	var userInfo map[string]any
	if userInfoRaw != "" {
		if err := decodeStrictJSON([]byte(userInfoRaw), &userInfo); err != nil {
			return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
		}
	}
	direct, ok := consistentAlias(userInfo, "user_id", "userId")
	if !ok {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	values := []string{direct}
	for _, key := range []string{"zcodejwttoken", "oauth:zai:access_token"} {
		value, valid := tokenSubjectFromString(text(credentials[key]))
		if !valid {
			return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
		}
		if value != "" {
			values = append(values, value)
		}
	}
	filtered := []string{}
	for _, value := range values {
		if value != "" {
			filtered = append(filtered, value)
		}
	}
	tokenSubject, tokenOK := consistentStrings(filtered)
	if !tokenOK {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	subject := firstNonEmpty(direct, tokenSubject)
	if subject == "" || !hasSecret(credentials, "zcodejwttoken", "oauth:zai:access_token") {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	return accountcore.NewNativeSubjectIdentity(providerID, subject)
}

func consistentSubjects(record map[string]any) (string, bool) {
	if record == nil {
		return "", false
	}
	values := []string{}
	aliases, ok := consistentAlias(record, "user_id", "userId", "uid", "sub", "subject")
	if !ok {
		return "", false
	}
	if aliases != "" {
		values = append(values, aliases)
	}
	for _, key := range []string{"access_token", "accessToken", "refresh_token", "refreshToken"} {
		if value := text(record[key]); value != "" {
			subject, valid := tokenSubjectFromString(value)
			if !valid {
				return "", false
			}
			if subject != "" {
				values = append(values, subject)
			}
		}
	}
	return consistentStrings(values)
}

func consistentAlias(record map[string]any, keys ...string) (string, bool) {
	var subject string
	for _, key := range keys {
		raw, exists := record[key]
		if !exists || raw == nil || raw == "" {
			continue
		}
		candidate, isString := raw.(string)
		if !isString {
			return "", false
		}
		if !validSubjectText(candidate) || (subject != "" && subject != candidate) {
			return "", false
		}
		subject = candidate
	}
	return subject, true
}

func consistentStrings(values []string) (string, bool) {
	selected := ""
	for _, value := range values {
		if selected != "" && selected != value {
			return "", false
		}
		selected = value
	}
	return selected, true
}

func tokenSubjectFromString(token string) (string, bool) {
	if token == "" || !strings.Contains(token, ".") {
		return "", true
	}
	claims := jwtClaims(token)
	if claims == nil {
		return "", false
	}
	return consistentAlias(claims, "user_id", "userId", "uid", "sub", "subject")
}

func jwtClaims(token string) map[string]any {
	if len(token) > maxArtifactBytes {
		return nil
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return nil
	}
	for _, part := range parts {
		if strings.Trim(part, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") != "" {
			return nil
		}
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(decoded) == 0 || base64.RawURLEncoding.EncodeToString(decoded) != parts[1] {
		return nil
	}
	var claims map[string]any
	if err := decodeStrictJSON(decoded, &claims); err != nil || claims == nil {
		return nil
	}
	return claims
}

func validSubjectText(value string) bool { return accountcore.ValidNativeSubject(value) }

func hasSecret(record map[string]any, keys ...string) bool {
	for _, key := range keys {
		value := text(record[key])
		if value != "" && len(value) <= maxArtifactBytes {
			return true
		}
	}
	return false
}

func hasEncryptedValue(record map[string]any) bool {
	for _, value := range record {
		if strings.HasPrefix(text(value), "enc:v1:") {
			return true
		}
	}
	return false
}
