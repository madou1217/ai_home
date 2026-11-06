package codexoauth

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"unicode/utf8"

	"github.com/madou1217/ai_home/application/accountauth"
)

const (
	// maxIDTokenBytes 限制参与解析的 ID Token 长度。官方值通常只有几 KB，
	// 上限定在 64 KiB 既能覆盖合法 token，又避免畸形响应让解码分配无界内存。
	maxIDTokenBytes = 64 * 1024
	// 展示字段与 core/accounts/codex 的公开资料约束保持同一量级。
	maxAccountEmailLength = 320
	maxAccountNameLength  = 256
	maxAccountPlanLength  = 128
)

const (
	codexAuthClaimNamespace    = "https://api.openai.com/auth"
	codexProfileClaimNamespace = "https://api.openai.com/profile"
)

// decodeIDTokenAccount 从 ID Token payload 读取登录结果需要的公开账号字段。
//
// 这里只解码、不验签：Token 来自官方 token endpoint，调用边界已经保证来源；
// 展示字段不是授权凭据，不能也不应作为身份证明。任何畸形输入都返回零值而
// 不是错误——身份校验由 codex.NewOAuthAuth 负责，展示字段缺失不阻断登录。
func decodeIDTokenAccount(idToken string) accountauth.Account {
	payload, ok := decodeIDTokenPayload(idToken)
	if !ok {
		return accountauth.Account{}
	}
	var claims struct {
		Email      string `json:"email"`
		Name       string `json:"name"`
		GivenName  string `json:"given_name"`
		FamilyName string `json:"family_name"`
		Auth       struct {
			ChatGPTPlanType string `json:"chatgpt_plan_type"`
		} `json:"https://api.openai.com/auth"`
		Profile struct {
			Email string `json:"email"`
			Name  string `json:"name"`
		} `json:"https://api.openai.com/profile"`
	}
	// 任一已知 claim 类型错误都整份放弃：宁可留空，也不把半份字段当结果。
	if err := json.Unmarshal(payload, &claims); err != nil {
		return accountauth.Account{}
	}
	email := firstAccountClaim(
		claims.Profile.Email,
		claims.Email,
	)
	displayName := firstAccountClaim(
		claims.Name,
		claims.Profile.Name,
		joinAccountName(claims.GivenName, claims.FamilyName),
		// Node 的 Codex 登录 Job 在没有名称 claim 时把 email 当作 displayName，
		// 这里在解码层保持同一取值链，服务层再做资料覆盖。
		email,
	)
	return accountauth.Account{
		Email:       normalizeAccountClaim(email, maxAccountEmailLength),
		DisplayName: normalizeAccountClaim(displayName, maxAccountNameLength),
		PlanType:    normalizeAccountClaim(claims.Auth.ChatGPTPlanType, maxAccountPlanLength),
	}
}

// decodeIDTokenPayload 只取 JWT 第二段并做 base64url + UTF-8 校验。
//
// 不检查 header/payload 的算法或签名，也不接受段数不是 3 的输入：这里只处理
// 官方签发的 JWT 形状，畸形值直接返回 false。
func decodeIDTokenPayload(idToken string) ([]byte, bool) {
	token := strings.TrimSpace(idToken)
	if token == "" || len(token) > maxIDTokenBytes {
		return nil, false
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[1] == "" {
		return nil, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		// 官方使用无 padding 的 base64url；这里容忍少数实现带 padding 的写法。
		payload, err = base64.URLEncoding.DecodeString(parts[1])
	}
	if err != nil || !utf8.Valid(payload) {
		return nil, false
	}
	return payload, true
}

// firstAccountClaim 返回第一个去除首尾空白后仍非空的文本。
func firstAccountClaim(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// joinAccountName 把可选的 given_name / family_name 拼成展示名称。
func joinAccountName(givenName string, familyName string) string {
	given := strings.TrimSpace(givenName)
	family := strings.TrimSpace(familyName)
	if given == "" {
		return family
	}
	if family == "" {
		return given
	}
	return given + " " + family
}

// normalizeAccountClaim 统一 trim、长度和控制字符规则。
//
// 超长或含控制字符的取值直接判空：截断会把不同账号显示成同一个名字，
// 而控制字符可能破坏日志与前端展示。
func normalizeAccountClaim(value string, limit int) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || len(trimmed) > limit || !utf8.ValidString(trimmed) {
		return ""
	}
	if strings.ContainsRune(trimmed, utf8.RuneError) {
		return ""
	}
	if strings.IndexFunc(trimmed, func(character rune) bool {
		return character < 0x20 || character == 0x7f
	}) >= 0 {
		return ""
	}
	return trimmed
}
