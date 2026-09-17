package nativeaccount

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func kiroIdentity(providerID string, native map[string]any) (accountcore.NativeIdentity, error) {
	if providerID != "kiro" {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	auth := object(native["auth"])
	evidence := object(native["identityEvidence"])
	if auth == nil || evidence == nil {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	access, accessOK := consistentSecretAlias(auth, "access_token", "accessToken")
	refresh, refreshOK := consistentSecretAlias(auth, "refresh_token", "refreshToken")
	if !accessOK || !refreshOK || access == "" {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	region := "us-east-1"
	if value, present := auth["region"]; present {
		var valid bool
		region, valid = value.(string)
		if !valid || region == "" {
			return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
		}
	}
	endpoint := "https://codewhisperer." + region + ".amazonaws.com"
	subject := firstText(evidence, "subject")
	if intValue(evidence["version"]) != 1 || firstText(evidence, "source") != "aws-codewhisperer:GetUsageLimits" ||
		firstText(evidence, "endpoint") != endpoint || subject == "" || firstText(evidence, "tokenBinding") != kiroTokenBinding(endpoint, access, refresh) ||
		intValue(evidence["observedAtMs"]) <= 0 {
		return accountcore.NativeIdentity{}, ErrInvalidNativeArtifacts
	}
	return accountcore.NewNativeKiroIdentity(endpoint, subject)
}

func kiroTokenBinding(endpoint, access, refresh string) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode([]string{endpoint, access, refresh}); err != nil {
		return ""
	}
	// JSON.stringify has no trailing newline and does not HTML-escape token bytes.
	encoded := bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func intValue(value any) int64 { return positiveInteger(value) }
