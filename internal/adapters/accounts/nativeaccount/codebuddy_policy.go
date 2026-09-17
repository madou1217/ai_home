package nativeaccount

import (
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var codebuddyIssuers = map[string]map[string]bool{
	"https://www.codebuddy.ai/auth/realms/copilot":    {"codebuddy": true},
	"https://www.workbuddy.ai/auth/realms/copilot":    {"workbuddy": true},
	"https://www.workbuddy.cn/auth/realms/copilot":    {"codebuddycn": true, "workbuddycn": true},
	"https://www.codebuddy.cn/auth/realms/copilot":    {"codebuddycn": true, "workbuddycn": true},
	"https://copilot.tencent.com/auth/realms/copilot": {"codebuddycn": true, "workbuddycn": true},
}

func codebuddyIdentity(providerID string, native map[string]any) (accountcore.NativeIdentity, error) {
	value := object(native["credentials"])
	if value == nil {
		value = native
	}
	auth, account := object(value["auth"]), object(value["account"])
	if auth == nil || account == nil {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	accessToken, accessOK := consistentSecretAlias(auth, "accessToken", "access_token")
	refreshToken, refreshOK := consistentSecretAlias(auth, "refreshToken", "refresh_token")
	if !accessOK || !refreshOK || accessToken == "" || refreshToken == "" {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	access := jwtClaims(accessToken)
	refresh := jwtClaims(refreshToken)
	if access == nil || refresh == nil {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	issuer := firstText(access, "iss")
	accessSubject := firstText(access, "sub")
	refreshSubject := firstText(refresh, "sub")
	uid := firstText(account, "uid")
	domain := firstText(auth, "domain")
	if !codebuddyIssuers[issuer][providerID] || accessSubject == "" || uid == "" ||
		accessSubject != uid || refreshSubject != uid || firstText(refresh, "iss") != issuer || domain == "" ||
		domain != issuerDomain(issuer) {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	return accountcore.NewNativeSubjectIdentity(providerID, uid)
}

func issuerDomain(issuer string) string {
	const prefix = "https://"
	if len(issuer) <= len(prefix) || issuer[:len(prefix)] != prefix {
		return ""
	}
	remaining := issuer[len(prefix):]
	for index, character := range remaining {
		if character == '/' {
			return remaining[:index]
		}
	}
	return remaining
}
