package codexappconfig

import (
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const DesktopAuthTypeChatGPT = "chatgpt"

var desktopAccountRefPattern = regexp.MustCompile("^acct_[A-Za-z0-9]+$")

// DesktopArtifacts 是账号库中与 Codex Desktop 身份相关的部分。
type DesktopArtifacts struct {
	AccountRef string
	AuthJSON   map[string]any
}

// ChatGPTAccount 对应 Node buildChatGptAccount 的输出。
type ChatGPTAccount struct {
	Type     string
	Email    string
	PlanType string
}

// DesktopIdentity 是 runtime home 需要的账号身份。
type DesktopIdentity struct {
	AccountRef        string
	AuthType          string
	Account           *ChatGPTAccount
	AccessToken       string
	UpstreamAccountID string
	AuthJSON          map[string]any
}

// IdentityOptions 控制 JWT 时效与账号信息要求。
type IdentityOptions struct {
	RequireAccessToken bool
	RequireAccount     bool
	NowSeconds         int64
	SkewSeconds        int64
}

// BuildDesktopIdentity 从账号凭据构造 chatgpt 身份；API-key 凭据返回 nil。
func BuildDesktopIdentity(artifacts DesktopArtifacts, options IdentityOptions) *DesktopIdentity {
	if !hasCodexOAuthTokens(artifacts.AuthJSON) {
		return nil
	}
	tokens := objectField(artifacts.AuthJSON, "tokens")
	accessToken := stringField(tokens, "access_token")
	if options.RequireAccessToken && !IsJWTUsableNow(accessToken, options) {
		return nil
	}
	snapshot := buildSnapshotAccount(artifacts.AuthJSON)
	account := buildChatGPTAccount(snapshot)
	if account == nil && options.RequireAccount {
		return nil
	}
	return &DesktopIdentity{
		AccountRef: artifacts.AccountRef, AuthType: DesktopAuthTypeChatGPT,
		Account: account, AccessToken: accessToken,
		UpstreamAccountID: stringField(snapshot, "upstreamAccountId"),
		AuthJSON:          artifacts.AuthJSON,
	}
}

// BuildDesktopRuntimeAuth 生成 runtime home 的 auth.json；非 chatgpt 身份返回 nil。
func BuildDesktopRuntimeAuth(identity *DesktopIdentity) map[string]any {
	if identity == nil || identity.AuthType != DesktopAuthTypeChatGPT {
		return nil
	}
	auth := make(map[string]any, len(identity.AuthJSON)+1)
	for key, value := range identity.AuthJSON {
		auth[key] = value
	}
	auth["auth_mode"] = "chatgpt"
	delete(auth, "OPENAI_API_KEY")
	return auth
}

// ResolveDesktopIdentity 按候选顺序读取 artifacts，返回第一个可用身份。
func ResolveDesktopIdentity(candidateRefs []string, read func(string) (DesktopArtifacts, bool), options IdentityOptions) *DesktopIdentity {
	seen := map[string]struct{}{}
	for _, candidate := range candidateRefs {
		accountRef := strings.TrimSpace(candidate)
		if !desktopAccountRefPattern.MatchString(accountRef) {
			continue
		}
		if _, duplicate := seen[accountRef]; duplicate {
			continue
		}
		seen[accountRef] = struct{}{}
		artifacts, ok := read(accountRef)
		if !ok {
			continue
		}
		artifacts.AccountRef = accountRef
		if identity := BuildDesktopIdentity(artifacts, options); identity != nil {
			return identity
		}
	}
	return nil
}

// IsJWTUsableNow 判断 access token 的 exp 是否仍早于当前时间加偏移。
func IsJWTUsableNow(token string, options IdentityOptions) bool {
	payload := decodeJWTPayload(token)
	if payload == nil {
		return false
	}
	rawExp, exists := payload["exp"]
	if !exists {
		return true
	}
	exp := numberFloat(rawExp, 0)
	now := options.NowSeconds
	if now == 0 {
		now = time.Now().Unix()
	}
	skew := options.SkewSeconds
	if skew == 0 {
		skew = 60
	}
	return int64(exp) > now+skew
}

func hasCodexOAuthTokens(authJSON map[string]any) bool {
	if authJSON == nil {
		return false
	}
	if strings.TrimSpace(stringField(authJSON, "OPENAI_API_KEY")) != "" {
		return false
	}
	tokens := objectField(authJSON, "tokens")
	if tokens == nil {
		return false
	}
	return strings.TrimSpace(stringField(tokens, "access_token")) != "" ||
		strings.TrimSpace(stringField(tokens, "id_token")) != "" ||
		strings.TrimSpace(stringField(tokens, "refresh_token")) != ""
}

func buildSnapshotAccount(authJSON map[string]any) map[string]any {
	tokens := objectField(authJSON, "tokens")
	accessPayload := decodeJWTPayload(stringField(tokens, "access_token"))
	idPayload := decodeJWTPayload(stringField(tokens, "id_token"))
	authClaim := objectField(accessPayload, "https://api.openai.com/auth")
	if authClaim == nil {
		authClaim = objectField(idPayload, "https://api.openai.com/auth")
	}
	profileClaim := objectField(accessPayload, "https://api.openai.com/profile")
	email := firstNonEmptyString(stringField(profileClaim, "email"), stringField(idPayload, "email"))
	planType := stringField(authClaim, "chatgpt_plan_type")
	upstreamAccountID := firstNonEmptyString(
		stringField(authClaim, "chatgpt_account_id"),
		stringField(authJSON, "chatgpt_account_id"),
		stringField(tokens, "account_id"),
	)
	if email == "" && planType == "" && upstreamAccountID == "" {
		return nil
	}
	return map[string]any{"email": email, "planType": planType, "upstreamAccountId": upstreamAccountID}
}

func buildChatGPTAccount(snapshot map[string]any) *ChatGPTAccount {
	if snapshot == nil {
		return nil
	}
	email := strings.TrimSpace(stringField(snapshot, "email"))
	if email == "" {
		return nil
	}
	planType := strings.TrimSpace(stringField(snapshot, "planType"))
	if planType == "" {
		planType = "unknown"
	}
	return &ChatGPTAccount{Type: "chatgpt", Email: email, PlanType: planType}
}

func decodeJWTPayload(token string) map[string]any {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) < 2 {
		return nil
	}
	payload := strings.TrimSpace(parts[1])
	if payload == "" {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return nil
	}
	var decoded map[string]any
	if json.Unmarshal(raw, &decoded) != nil {
		return nil
	}
	return decoded
}

func objectField(object map[string]any, key string) map[string]any {
	if object == nil {
		return nil
	}
	value, _ := object[key].(map[string]any)
	return value
}

func stringField(object map[string]any, key string) string {
	if object == nil {
		return ""
	}
	value := object[key]
	switch typed := value.(type) {
	case string:
		return typed
	case json.Number:
		return typed.String()
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		return ""
	}
}

func numberFloat(value any, fallback float64) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case json.Number:
		parsed, err := typed.Float64()
		if err == nil {
			return parsed
		}
	}
	return fallback
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
