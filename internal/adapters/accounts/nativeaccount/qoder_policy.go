package nativeaccount

import (
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func qoderIdentity(providerID string, native map[string]any) (accountcore.NativeIdentity, error) {
	payload := object(native["userInfo"])
	if payload == nil {
		payload = native
	}
	if pat := firstText(payload, "personal_access_token", "pat"); pat != "" {
		return accountcore.NewNativeQoderPATIdentity(providerID, pat)
	}
	if !hasSecret(payload, "security_oauth_token", "access_token", "accessToken", "token") {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	uid, ok := consistentAlias(payload, "uid", "user_id", "userId", "account_id", "accountId", "id")
	if !ok || uid == "" {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	return accountcore.NewNativeQoderIdentity(providerID, uid)
}
