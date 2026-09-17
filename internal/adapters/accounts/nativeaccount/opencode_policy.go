package nativeaccount

import (
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func openCodeIdentity(providerID string, native map[string]any) (accountcore.NativeIdentity, error) {
	auth := object(native["auth"])
	if auth == nil {
		auth = native
	}
	if len(auth) == 0 || len(auth) > 256 {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	grants := make([]accountcore.NativeOpenCodeGrant, 0, len(auth))
	names := make(map[string]struct{}, len(auth))
	for rawName, rawRecord := range auth {
		name := strings.ToLower(strings.TrimSpace(rawName))
		if !validSubjectText(name) {
			return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
		}
		if _, exists := names[name]; exists {
			return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
		}
		names[name] = struct{}{}
		record := object(rawRecord)
		if record == nil {
			return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
		}
		if len(record) == 0 {
			continue
		}
		typ, ok := consistentAlias(record, "type")
		if !ok {
			return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
		}
		keys, keyOK := consistentSecretAlias(record, "key", "apiKey", "api_key", "access_key")
		access, accessOK := consistentSecretAlias(record, "access", "access_token")
		refresh, refreshOK := consistentSecretAlias(record, "refresh", "refresh_token")
		if !keyOK || !accessOK || !refreshOK {
			return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
		}
		typ = strings.ToLower(typ)
		switch {
		case typ == "api" || typ == "api-key" || (typ == "" && keys != ""):
			if keys == "" || access != "" || refresh != "" {
				return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
			}
			grants = append(grants, accountcore.NativeOpenCodeGrant{Upstream: name, Type: typ, Secret: keys})
		case typ == "oauth":
			if keys != "" || (access == "" && refresh == "") {
				return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
			}
			subject, subjectOK := consistentAlias(record, "account_id", "accountId", "user_id", "userId", "id", "uuid")
			if !subjectOK || subject == "" {
				return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
			}
			for _, token := range []string{access, refresh} {
				tokenSubject, valid := tokenSubjectFromString(token)
				if !valid || (tokenSubject != "" && tokenSubject != subject) {
					return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
				}
			}
			grants = append(grants, accountcore.NativeOpenCodeGrant{Upstream: name, Type: typ, Subject: subject})
		default:
			return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
		}
	}
	if len(grants) == 0 {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	return accountcore.NewNativeOpenCodeIdentity(grants)
}
