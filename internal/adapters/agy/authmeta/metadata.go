// Package authmeta 复刻 Node 的 lib/account/agy-auth-metadata.js。
//
// 它把 Antigravity 原生凭据（账号库里的 nativeAuth）解析成账号视图与运行态恢复
// 判定需要的认证元数据，并按 Node 的口径生成 Gemini 兼容投影文档。
//
// Node 侧的消费方与必须保持一致的行为：
//   - lib/server/account-view-hints.js 的 readAuthMetadata：取 email / configured /
//     accountName / authMode / tokenFresh；
//   - lib/server/accounts.js 的 loadAgyServerAccounts：把 authMetadata 挂到运行池账号，
//     用 hasRefreshToken 判断账号是否可调度；
//   - lib/account/native-auth-projection.js 的 resolveProjectionSource：用
//     buildAgyGeminiOAuthCredentials / buildAgyGoogleAccounts 生成
//     .gemini/oauth_creds.json 与 .gemini/google_accounts.json 两份兼容文件。
//
// 这里刻意保留 Node 的两套 token 字段读法：
//   - 快照（readAgyAuthMetadata 用）只读 snake_case 的 access_token / refresh_token 与
//     expiry，因为账本里的原生 artifact 就是 CLI 落盘形态；
//   - 兼容投影（buildAgyGeminiOAuthCredentials 用）同时读 snake_case 与 camelCase，
//     并接受 direct-token 形态，因为外部导入的凭据可能是另一种写法。
//
// 把两者合并会悄悄改变「账号是否显示为已配置」的结论，所以分开实现。
package authmeta

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/accounts/agy"
)

const (
	// AuthMethodConsumer 是 antigravity CLI 唯一接受的 auth_method。
	// 与领域枚举 core/accounts/agy.AuthMethodConsumer 同值；这里导出字符串是为了
	// 与 Node 的 AGY_CLI_AUTH_METHOD 同名同形，写进兼容文件时不需要再转换。
	AuthMethodConsumer = string(agy.AuthMethodConsumer)

	// GeminiOAuthScope 与 Node 的 AGY_GEMINI_OAUTH_SCOPE 逐字一致。
	// Antigravity Desktop 2.x 读的是通用 Gemini OAuth 文件，scope 缺失会被判成
	// 授权不完整，所以这里不是「可选装饰」。
	GeminiOAuthScope = "https://www.googleapis.com/auth/userinfo.email openid " +
		"https://www.googleapis.com/auth/cloud-platform " +
		"https://www.googleapis.com/auth/userinfo.profile"

	// SourceAppStateDB 是 Node 固定使用的来源标签（凭据账本就在 app-state.db 里）。
	SourceAppStateDB = "app-state.db"

	// EnvAccessTokenKey / EnvGoogleAccessTokenKey 是账号环境里的两个兜底 token 键，
	// 顺序即优先级，与 Node 的 readAgyEnvToken 一致。
	EnvAccessTokenKey       = "AGY_ACCESS_TOKEN"
	EnvGoogleAccessTokenKey = "GOOGLE_OAUTH_ACCESS_TOKEN"

	// 未配置 / 无邮箱时的占位文案，账号页直接展示这些字面量。
	UnknownAccountName     = "Unknown"
	OAuthAccountName       = "OAuth Configured"
	AccessTokenAccountName = "Token Configured"

	// AuthModeAccessToken 是「环境变量 token」分支的认证模式。
	// OAuth 分支不写死，取原生凭据里的 auth_method（缺省 consumer）。
	AuthModeAccessToken = "access-token"
)

// Metadata 是 readAgyAuthMetadata 的返回值。
//
// TokenExpiresAtMS 为 0 表示 Node 的 null：原生凭据只用 ISO 字符串表达过期时间，
// 数字时间戳（Go 账号导出的 expires_at_ms）不会被 Node 的 Date.parse 接受，
// 这一点必须保持——否则「Go 账号一律算 token 新鲜」会让旧 auth_invalid 块被错误清除。
type Metadata struct {
	Configured       bool
	AccountName      string
	Email            string
	AuthMode         string
	Source           string
	HasAccessToken   bool
	HasRefreshToken  bool
	TokenExpiresAtMS int64
	TokenExpiry      string
	TokenFresh       bool
}

// CredentialRecord 是 readAgyAuthMetadata 需要的两项账号事实。
//
// NativeAuth 对应 Node 的 credentialRecord.nativeAuth（原始 JSON），Env 对应
// credentialRecord.env。没有凭据记录的账号两项都为空。
type CredentialRecord struct {
	NativeAuth []byte
	Env        map[string]string
}

// GeminiOAuthCredentials 是 .gemini/oauth_creds.json 的文档形状（字段与 Node 相同）。
// IdToken 为空时按 Node 的展开语法省略该键。
type GeminiOAuthCredentials struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiryDate   int64  `json:"expiry_date"`
	IDToken      string `json:"id_token,omitempty"`
	Scope        string `json:"scope"`
}

// GoogleAccounts 是 .gemini/google_accounts.json 的文档形状。
// Old 固定为空数组：兼容文件只描述当前登录的账号，历史账号列表由 CLI 自己维护。
type GoogleAccounts struct {
	Active string   `json:"active"`
	Old    []string `json:"old"`
}

// ReadMetadata 复刻 readAgyAuthMetadata。
//
// 优先级与 Node 相同：原生 oauthToken 能解析出 token → OAuth 分支；否则看账号环境变量
// 里的 access token；两者都没有 → 未配置（accountName=Unknown）。
func ReadMetadata(record CredentialRecord, now time.Time) Metadata {
	nativeAuth := decodeObject(record.NativeAuth)
	email := strings.TrimSpace(nodeField(nativeAuth, "email"))
	if snapshot, ok := buildOAuthSnapshot(nativeAuth["oauthToken"], SourceAppStateDB); ok {
		accountName := email
		if accountName == "" {
			accountName = OAuthAccountName
		}
		metadata := Metadata{
			Configured:       true,
			AccountName:      accountName,
			Email:            email,
			AuthMode:         snapshot.authMode,
			Source:           snapshot.source,
			HasAccessToken:   snapshot.hasAccessToken,
			HasRefreshToken:  snapshot.hasRefreshToken,
			TokenExpiresAtMS: snapshot.tokenExpiresAtMS,
			TokenExpiry:      snapshot.tokenExpiry,
		}
		// Node 的 tokenFresh 只用快照自己的两个字段判定，不依赖账号其它状态。
		metadata.TokenFresh = IsAccessTokenFresh(metadata, now, 0)
		return metadata
	}

	if token, source := ReadEnvToken(record.Env); token != "" {
		accountName := email
		if accountName == "" {
			accountName = AccessTokenAccountName
		}
		// 环境变量 token 没有过期时间，也没有 refresh 能力：Node 同分支不写
		// hasAccessToken / hasRefreshToken / tokenFresh，Go 保持零值。
		return Metadata{
			Configured:  true,
			AccountName: accountName,
			Email:       email,
			AuthMode:    AuthModeAccessToken,
			Source:      source,
		}
	}

	return Metadata{
		Configured:  false,
		AccountName: UnknownAccountName,
	}
}

// ReadEnvToken 复刻 readAgyEnvToken。
//
// 注意 || 的短路语义：AGY_ACCESS_TOKEN 只要是**非空字符串**就当选，哪怕只有空白，
// 结果 trim 后为空也不会回落到 GOOGLE_OAUTH_ACCESS_TOKEN。反过来，AGY 为空串/缺失时
// 才轮到 GOOGLE。这个细节决定了「配置了空白变量」与「没配置」的不同结论。
func ReadEnvToken(env map[string]string) (string, string) {
	raw := ""
	for _, key := range []string{EnvAccessTokenKey, EnvGoogleAccessTokenKey} {
		if value, ok := env[key]; ok && value != "" {
			raw = value
			break
		}
	}
	token := strings.TrimSpace(raw)
	if token == "" {
		return "", ""
	}
	return token, SourceAppStateDB
}

// BuildGeminiOAuthCredentials 复刻 buildAgyGeminiOAuthCredentials。
//
// 返回的文档用于覆盖 .gemini/oauth_creds.json：Antigravity Desktop 在 HOME 投影后
// 仍读这份通用 Gemini 文件。access/refresh 都为空时返回 false，调用方应删除旧文件
// （Node 的 resolveProjectionSource 就是 delete projection.oauthCreds）。
func BuildGeminiOAuthCredentials(oauthToken json.RawMessage) (GeminiOAuthCredentials, bool) {
	fields := readOAuthTokenFields(decodeObject(oauthToken))
	if fields.accessToken == "" && fields.refreshToken == "" {
		return GeminiOAuthCredentials{}, false
	}
	credentials := GeminiOAuthCredentials{
		AccessToken:  fields.accessToken,
		RefreshToken: fields.refreshToken,
		TokenType:    fields.tokenType,
		ExpiryDate:   fields.expiresAtMS,
		IDToken:      fields.idToken,
		Scope:        GeminiOAuthScope,
	}
	return credentials, true
}

// BuildGoogleAccounts 复刻 buildAgyGoogleAccounts：邮箱为空时返回 false。
// Node 返回的是新文档（不是合并），所以 active 用 trim 后的邮箱。
func BuildGoogleAccounts(email string) (GoogleAccounts, bool) {
	active := strings.TrimSpace(email)
	if active == "" {
		return GoogleAccounts{}, false
	}
	return GoogleAccounts{Active: active, Old: []string{}}, true
}

// IsAccessTokenFresh 复刻 isAgyAccessTokenFresh。
//
// 必须同时有 access token 与可解析的过期时间，且过期时间严格晚于 now+skew；
// skewMS 为负按 0 处理（Node 的 Math.max(0, ...)）。TokenExpiresAtMS 为 0 时
// 结果恒为 false——这正是「数字时间戳不被 Date.parse 接受」的等价行为。
func IsAccessTokenFresh(metadata Metadata, now time.Time, skewMS int64) bool {
	if !metadata.HasAccessToken || metadata.TokenExpiresAtMS <= 0 {
		return false
	}
	if skewMS < 0 {
		skewMS = 0
	}
	return metadata.TokenExpiresAtMS > now.UnixMilli()+skewMS
}

// HasRecoverableCredentials 复刻 hasRecoverableAgyOAuthCredentials：
// access token 仍新鲜，或者手里还有 refresh token（可刷新）。
func HasRecoverableCredentials(metadata Metadata, now time.Time) bool {
	return IsAccessTokenFresh(metadata, now, 0) || metadata.HasRefreshToken
}

// oauthSnapshot 是 buildAgyOAuthTokenSnapshot 的输出。
type oauthSnapshot struct {
	source           string
	authMode         string
	hasAccessToken   bool
	hasRefreshToken  bool
	tokenExpiresAtMS int64
	tokenExpiry      string
}

// buildOAuthSnapshot 复刻 buildAgyOAuthTokenSnapshot。
//
// 与兼容投影不同，这里只认 oauthToken.token 对象里的 snake_case 字段与 expiry：
// 账本里的原生 artifact 由 CLI 写入，camelCase 只可能出现在外部导入的兼容文件里。
func buildOAuthSnapshot(oauthToken any, source string) (oauthSnapshot, bool) {
	token := nestedToken(oauthToken)
	accessToken := strings.TrimSpace(nodeField(token, "access_token"))
	refreshToken := strings.TrimSpace(nodeField(token, "refresh_token"))
	if accessToken == "" && refreshToken == "" {
		return oauthSnapshot{}, false
	}
	authMode := strings.TrimSpace(nodeField(nestedObject(oauthToken), "auth_method"))
	if authMode == "" {
		authMode = AuthMethodConsumer
	}
	// Node 读的是 token.expiry（内层），不是 oauthToken.expiry；缺失时为 nil。
	var expiry any
	if token != nil {
		expiry = token["expiry"]
	}
	return oauthSnapshot{
		source:           source,
		authMode:         authMode,
		hasAccessToken:   accessToken != "",
		hasRefreshToken:  refreshToken != "",
		tokenExpiresAtMS: parseTimestampMS(expiry),
		tokenExpiry:      strings.TrimSpace(nodeString(expiry)),
	}, true
}

// oauthTokenFields 是 readAgyOAuthTokenFields 的输出。
type oauthTokenFields struct {
	accessToken  string
	refreshToken string
	tokenType    string
	expiresAtMS  int64
	idToken      string
}

// readOAuthTokenFields 复刻 readAgyOAuthTokenFields：
// 兼容 oauthToken.token 与 direct-token 两种形态，以及 snake_case / camelCase 两套键名。
func readOAuthTokenFields(oauthToken map[string]any) oauthTokenFields {
	token := oauthTokenFieldsContainer(oauthToken)
	tokenType := strings.TrimSpace(firstNodeField(token, "token_type", "tokenType"))
	if tokenType == "" {
		tokenType = "Bearer"
	}
	return oauthTokenFields{
		accessToken:  strings.TrimSpace(firstNodeField(token, "access_token", "accessToken")),
		refreshToken: strings.TrimSpace(firstNodeField(token, "refresh_token", "refreshToken")),
		tokenType:    tokenType,
		expiresAtMS:  parseTimestampMS(firstNodeValue(token, "expiry", "expires_at", "expiresAt")),
		idToken:      strings.TrimSpace(firstNodeField(token, "id_token", "idToken")),
	}
}

// oauthTokenFieldsContainer 复刻 readAgyOAuthTokenFields 的容器选择：
//   - oauthToken.token 是**真值对象** → 用 token；
//   - token 是真值数组（JS 里 typeof [] === 'object'）→ 读不到任何字段；
//   - token 是真值非对象（字符串等）→ 回落到整个 oauthToken；
//   - token 为假值/缺失 → 用整个 oauthToken。
func oauthTokenFieldsContainer(oauthToken map[string]any) map[string]any {
	if oauthToken == nil {
		return nil
	}
	if token, exists := oauthToken["token"]; exists && nodeTruthy(token) {
		if object, ok := token.(map[string]any); ok {
			return object
		}
		if _, isArray := token.([]any); isArray {
			return nil
		}
	}
	return oauthToken
}

// nestedToken 复刻 buildAgyOAuthTokenSnapshot 的取值：只认 oauthToken.token 对象。
func nestedToken(oauthToken any) map[string]any {
	object, _ := oauthToken.(map[string]any)
	if object == nil {
		return nil
	}
	token, _ := object["token"].(map[string]any)
	return token
}

// nestedObject 返回 oauthToken 对象本身（读取 auth_method 用）。
func nestedObject(oauthToken any) map[string]any {
	object, _ := oauthToken.(map[string]any)
	return object
}

// decodeObject 把原始 JSON 解析成对象；空载荷、非对象、坏 JSON 都按空对象处理。
// Node 在凭据记录层拿到的已经是对象，这里补上「原始字节 → 对象」的容错边界。
func decodeObject(payload []byte) map[string]any {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.UseNumber()
	var document map[string]any
	if err := decoder.Decode(&document); err != nil {
		return nil
	}
	return document
}

// nodeField 用 Node 的 || 语义读取单个字段：假值（空串/0/false/null）视为没有值。
func nodeField(object map[string]any, key string) string {
	if object == nil {
		return ""
	}
	value := object[key]
	if !nodeTruthy(value) {
		return ""
	}
	return nodeString(value)
}

// firstNodeField 复刻 a || b || c 的字符串取法：先取第一个真值字段，再 String()。
func firstNodeField(object map[string]any, keys ...string) string {
	if value := firstNodeValue(object, keys...); value != nil {
		return nodeString(value)
	}
	return ""
}

// firstNodeValue 返回第一个真值字段原值（保留下游对数字/布尔的解析能力）。
func firstNodeValue(object map[string]any, keys ...string) any {
	if object == nil {
		return nil
	}
	for _, key := range keys {
		value, exists := object[key]
		if exists && nodeTruthy(value) {
			return value
		}
	}
	return nil
}

// nodeTruthy 复刻 JS 的真值判定：空串、0、false、null 为假；其余（含空白串）为真。
func nodeTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case string:
		return typed != ""
	case bool:
		return typed
	case json.Number:
		number, err := typed.Float64()
		return err == nil && number != 0
	case float64:
		return typed != 0
	case int64:
		return typed != 0
	case int:
		return typed != 0
	case []any, map[string]any:
		// JS 里数组和对象恒为真（空数组/空对象也是）。
		return true
	default:
		return true
	}
}

// nodeString 复刻 String(value)；对象/数组没有可用的凭据文本，返回空串。
func nodeString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case json.Number:
		return typed.String()
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(typed, 10)
	case int:
		return strconv.Itoa(typed)
	default:
		return ""
	}
}

// parseTimestampMS 复刻 parseIsoTimestampMs：空文本与非 ISO 文本都返回 0（Node 的 null）。
// 早于 1970 的时间同样返回 0（Node 要求 epochMs > 0）。
func parseTimestampMS(value any) int64 {
	text := strings.TrimSpace(nodeString(value))
	if text == "" {
		return 0
	}
	return parseISOTimestampMS(text)
}

// isoLayouts 覆盖 Date.parse 常见的 ISO-8601 形态。
// 带时区的按原偏移解析；不带时区的按本地时区（与 Node 对
// "2026-01-02T03:04:05" 的解释一致）；纯日期按 UTC（Node 对 date-only 也是 UTC）。
var isoLayouts = []struct {
	layout string
	local  bool
}{
	{time.RFC3339Nano, false},
	{"2006-01-02T15:04:05.999999999Z0700", false},
	{"2006-01-02T15:04:05Z0700", false},
	{"2006-01-02T15:04:05.999999999", true},
	{"2006-01-02T15:04:05", true},
	{"2006-01-02T15:04", true},
	{"2006-01-02", false},
}

func parseISOTimestampMS(text string) int64 {
	for _, candidate := range isoLayouts {
		var (
			parsed time.Time
			err    error
		)
		if candidate.local {
			parsed, err = time.ParseInLocation(candidate.layout, text, time.Local)
		} else {
			parsed, err = time.Parse(candidate.layout, text)
		}
		if err != nil {
			continue
		}
		if millis := parsed.UnixMilli(); millis > 0 {
			return millis
		}
		return 0
	}
	// 纯数字时间戳与其它非 ISO 文本：Node 的 Date.parse 返回 NaN → null。
	return 0
}
