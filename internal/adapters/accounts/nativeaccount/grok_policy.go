package nativeaccount

import (
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func grokIdentity(providerID string, native map[string]any) (accountcore.NativeIdentity, error) {
	if providerID != "grok" {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	auth := object(native["auth"])
	if auth == nil {
		auth = native
	}
	profiles := make([]map[string]any, 0)
	if hasSecret(auth, "access_token", "accessToken", "key", "refresh_token", "refreshToken") {
		profiles = append(profiles, auth)
	} else {
		for _, raw := range auth {
			profile := object(raw)
			if profile != nil {
				profiles = append(profiles, profile)
			}
		}
	}
	ids := make([]string, 0, len(profiles))
	for _, profile := range profiles {
		user, userOK := consistentAlias(profile, "user_id", "userId")
		principal, principalOK := consistentAlias(profile, "principal_id", "principalId")
		if !userOK || !principalOK || (user == "" && principal == "") ||
			!hasSecret(profile, "access_token", "accessToken", "key", "refresh_token", "refreshToken") {
			return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
		}
		if user != "" && principal != "" && user != principal {
			return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
		}
		ids = append(ids, firstNonEmpty(user, principal))
	}
	return accountcore.NewNativeGrokIdentity(ids)
}
