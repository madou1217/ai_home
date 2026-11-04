package kiro

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

// RebindIdentityEvidence 把 identityEvidence.tokenBinding 重新绑定到当前令牌。
//
// kiro 的身份种子来自 evidence 的 endpoint + subject，而 tokenBinding 是
// sha256(JSON.stringify([endpoint, access, refresh])) —— 刷新令牌后必须重算，
// 否则凭据会被原生 decoder 判成「artifact 与身份不一致」。
func RebindIdentityEvidence(document map[string]json.RawMessage, auth map[string]json.RawMessage) bool {
	raw, exists := document["identityEvidence"]
	if !exists {
		return true
	}
	var evidence map[string]json.RawMessage
	if json.Unmarshal(raw, &evidence) != nil || evidence == nil {
		return false
	}
	endpoint := readString(evidence["endpoint"])
	access := readString(auth["access_token"])
	refresh := readString(auth["refresh_token"])
	if endpoint == "" || access == "" || refresh == "" {
		return false
	}
	binding := tokenBinding(endpoint, access, refresh)
	if binding == "" {
		return false
	}
	evidence["tokenBinding"] = mustJSON(binding)
	document["identityEvidence"] = mustJSONMap(evidence)
	return true
}

// tokenBinding 复刻 Node 的 kiroTokenBinding：JSON.stringify 无空格、不转义 HTML。
func tokenBinding(endpoint, access, refresh string) string {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode([]string{endpoint, access, refresh}); err != nil {
		return ""
	}
	encoded := bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'})
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}
