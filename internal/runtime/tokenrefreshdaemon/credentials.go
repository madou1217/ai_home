// Package tokenrefreshdaemon 实现 Go 侧 OAuth 账号令牌的后台主动续期、失效抑制与恢复调度器。
package tokenrefreshdaemon

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/kiro"
)

const missingRefreshTokenDigest = "missing"

type oauthTokenPair interface {
	AccessToken() string
	RefreshToken() string
}

type accessTokenOnly interface {
	AccessToken() string
}

// credentialSignals 只保留判定「是否有 access token」与「refresh token 是否变化」的低敏信号，
// 绝不向外暴露或持久化原始令牌。
type credentialSignals struct {
	hasAccessToken     bool
	refreshTokenDigest string
}

func inspectCredentialSignals(credential accountapp.Credential) credentialSignals {
	if credential == nil {
		return credentialSignals{refreshTokenDigest: missingRefreshTokenDigest}
	}
	if pair, ok := credential.(oauthTokenPair); ok {
		access := strings.TrimSpace(pair.AccessToken())
		refresh := strings.TrimSpace(pair.RefreshToken())
		return credentialSignals{
			hasAccessToken:     access != "",
			refreshTokenDigest: hashRefreshToken(refresh),
		}
	}
	if accessOnly, ok := credential.(accessTokenOnly); ok {
		return credentialSignals{
			hasAccessToken:     strings.TrimSpace(accessOnly.AccessToken()) != "",
			refreshTokenDigest: missingRefreshTokenDigest,
		}
	}
	if native, ok := credential.(*accountcore.NativeCredential); ok && native != nil {
		if native.ProviderID() == kiro.ProviderID {
			if parsed, err := kiro.ParseCredential(native.Payload()); err == nil {
				return credentialSignals{
					hasAccessToken:     strings.TrimSpace(parsed.AccessToken()) != "",
					refreshTokenDigest: hashRefreshToken(strings.TrimSpace(parsed.RefreshToken())),
				}
			}
		}
		hasAccess, refresh := extractNativeJSONTokens(native.Payload())
		return credentialSignals{
			hasAccessToken:     hasAccess,
			refreshTokenDigest: hashRefreshToken(refresh),
		}
	}
	return credentialSignals{refreshTokenDigest: missingRefreshTokenDigest}
}

func hashRefreshToken(refreshToken string) string {
	trimmed := strings.TrimSpace(refreshToken)
	if trimmed == "" {
		return missingRefreshTokenDigest
	}
	sum := sha256.Sum256([]byte(trimmed))
	return fmt.Sprintf("%d:%s", len(trimmed), hex.EncodeToString(sum[:]))
}

func extractNativeJSONTokens(payload []byte) (bool, string) {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) < 2 || trimmed[0] != '{' {
		return false, ""
	}
	var doc map[string]any
	if err := json.Unmarshal(trimmed, &doc); err != nil || doc == nil {
		return false, ""
	}
	var accessFound bool
	refreshSet := make(map[string]struct{})
	collectJSONTokens(doc, 0, &accessFound, refreshSet)
	if len(refreshSet) == 0 {
		return accessFound, ""
	}
	if len(refreshSet) == 1 {
		for token := range refreshSet {
			return accessFound, token
		}
	}
	tokens := make([]string, 0, len(refreshSet))
	for token := range refreshSet {
		tokens = append(tokens, token)
	}
	sort.Strings(tokens)
	return accessFound, strings.Join(tokens, "\x00")
}

func collectJSONTokens(node any, depth int, accessFound *bool, refreshSet map[string]struct{}) {
	if depth > 4 || node == nil {
		return
	}
	switch typed := node.(type) {
	case map[string]any:
		for _, key := range []string{"access_token", "accessToken", "key"} {
			if text, ok := typed[key].(string); ok && strings.TrimSpace(text) != "" {
				*accessFound = true
			}
		}
		for _, key := range []string{"refresh_token", "refreshToken"} {
			if text, ok := typed[key].(string); ok {
				if trimmed := strings.TrimSpace(text); trimmed != "" {
					refreshSet[trimmed] = struct{}{}
				}
			}
		}
		for _, key := range sortedMapKeys(typed) {
			collectJSONTokens(typed[key], depth+1, accessFound, refreshSet)
		}
	case []any:
		for _, item := range typed {
			collectJSONTokens(item, depth+1, accessFound, refreshSet)
		}
	}
}

func sortedMapKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
