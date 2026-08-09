// Package authfile 在 Codex auth.json 的 chatgpt/apikey 子集与 AI Home 认证领域模型之间做严格转换。
//
// 该适配器不处理其他上游认证模式，也不读取旧 AIH 字段、环境变量 JSON 或数据库结构。
// Decode 仅面向当前用户受保护的本地 Codex 登录产物，不是面向上传或网络输入的 JWT 验证器。
package authfile

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/madou1217/ai_home/core/accounts/codex"
)

const (
	authModeChatGPT             = "chatgpt"
	authModeAPIKey              = "apikey"
	authModePersonalAccessToken = "personalAccessToken"
	authModeBedrockAPIKey       = "bedrockApiKey"
)

// ErrInvalidAuthFile 表示输入不是受支持的 Codex 官方认证文件。
//
// 具体错误只使用代码内固定原因，避免把 Token、Key 或攻击者输入回显到日志。
var ErrInvalidAuthFile = errors.New("Codex auth.json 无效")

// DecodeOptions 保存官方文件之外、创建领域对象所必需的显式上下文。
type DecodeOptions struct {
	// APIKeyBaseURL 是 API Key 账号绑定的 OpenAI-compatible endpoint；空值使用官方默认地址。
	APIKeyBaseURL string
}

// authDocument 保留顶层模式字段，并用 RawMessage 区分缺失、null 和实际值。
type authDocument struct {
	AuthMode            json.RawMessage
	OpenAIAPIKey        json.RawMessage
	Tokens              json.RawMessage
	LastRefresh         json.RawMessage
	AgentIdentity       json.RawMessage
	PersonalAccessToken json.RawMessage
	BedrockAPIKey       json.RawMessage
}

// tokenDocument 描述 OAuth 模式下官方 tokens 对象的唯一允许字段。
type tokenDocument struct {
	IDToken      string
	AccessToken  string
	RefreshToken string
	AccountID    json.RawMessage
}

// oauthOutput 是写回官方 OAuth auth.json 的精确线格式。
type oauthOutput struct {
	AuthMode     string           `json:"auth_mode"`
	OpenAIAPIKey *string          `json:"OPENAI_API_KEY"`
	Tokens       oauthTokenOutput `json:"tokens"`
	LastRefresh  *string          `json:"last_refresh,omitempty"`
}

// oauthTokenOutput 保留 account_id=null 的“未显式声明工作区”语义。
type oauthTokenOutput struct {
	IDToken      string  `json:"id_token"`
	AccessToken  string  `json:"access_token"`
	RefreshToken string  `json:"refresh_token"`
	AccountID    *string `json:"account_id"`
}

// apiKeyOutput 是写回官方 API Key auth.json 的精确线格式。
type apiKeyOutput struct {
	AuthMode     string `json:"auth_mode"`
	OpenAIAPIKey string `json:"OPENAI_API_KEY"`
}

// Decode 严格解析一份可信本地 Codex 官方 auth.json，并返回封闭的领域认证对象。
// 不可信导入必须先在外层校验来源及 OAuth Token 的签名、issuer 和 audience。
func Decode(data []byte, options DecodeOptions) (codex.Auth, error) {
	if !utf8.Valid(data) {
		return nil, invalidAuthFile("JSON 必须使用有效 UTF-8")
	}
	document, err := decodeAuthDocument(data)
	if err != nil {
		return nil, invalidAuthFile("JSON 结构错误")
	}

	authMode, err := resolveAuthMode(document)
	if err != nil {
		return nil, err
	}

	switch authMode {
	case authModeChatGPT:
		return decodeOAuth(document)
	case authModeAPIKey:
		return decodeAPIKey(document, options)
	default:
		return nil, invalidAuthFile("auth_mode 不受支持")
	}
}

// Encode 把已校验的领域认证对象写成 Codex 官方 auth.json。
func Encode(auth codex.Auth) ([]byte, error) {
	switch value := auth.(type) {
	case *codex.OAuthAuth:
		if value == nil {
			return nil, invalidAuthFile("认证对象为空")
		}
		return encodeOAuth(value)
	case *codex.APIKeyAuth:
		if value == nil {
			return nil, invalidAuthFile("认证对象为空")
		}
		return encodeAPIKey(value)
	default:
		return nil, invalidAuthFile("认证对象类型不受支持")
	}
}

// decodeOAuth 校验 OAuth 专属字段并交由领域构造器建立不变量。
func decodeOAuth(document authDocument) (codex.Auth, error) {
	// Codex 原生 AuthDotJson 允许 OAuth 省略可选 API Key；非 null 值仍属于混合凭据。
	if len(document.OpenAIAPIKey) != 0 && !isJSONNull(document.OpenAIAPIKey) {
		return nil, invalidAuthFile("OAuth OPENAI_API_KEY 必须缺失或为 null")
	}
	if hasAlternativeAuthMaterial(document) {
		return nil, invalidAuthFile("OAuth 不能包含其他认证材料")
	}
	if len(document.Tokens) == 0 || isJSONNull(document.Tokens) {
		return nil, invalidAuthFile("OAuth tokens 缺失")
	}
	tokens, err := decodeTokenDocument(document.Tokens)
	if err != nil {
		return nil, invalidAuthFile("OAuth tokens 结构错误")
	}
	if strings.TrimSpace(tokens.IDToken) == "" ||
		strings.TrimSpace(tokens.AccessToken) == "" ||
		strings.TrimSpace(tokens.RefreshToken) == "" {
		return nil, invalidAuthFile("OAuth Token 不能为空")
	}
	workspaceID, err := decodeAccountID(tokens.AccountID)
	if err != nil {
		return nil, err
	}
	refreshedAtMS, err := decodeRefreshTime(document.LastRefresh)
	if err != nil {
		return nil, err
	}

	auth, domainErr := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:       tokens.AccessToken,
		RefreshToken:      tokens.RefreshToken,
		IDToken:           tokens.IDToken,
		RefreshedAtMS:     refreshedAtMS,
		ExplicitAccountID: workspaceID,
	})
	if domainErr != nil {
		return nil, invalidAuthFile("OAuth 凭证不满足领域约束")
	}
	return auth, nil
}

// decodeAPIKey 拒绝任何 OAuth 字段，并显式注入文件外的 endpoint。
func decodeAPIKey(document authDocument, options DecodeOptions) (codex.Auth, error) {
	if hasJSONValue(document.Tokens) || hasAlternativeAuthMaterial(document) {
		return nil, invalidAuthFile("API Key 模式不能包含其他认证材料")
	}
	if _, err := decodeRefreshTime(document.LastRefresh); err != nil {
		return nil, err
	}
	apiKey, err := decodeRequiredString(document.OpenAIAPIKey)
	if err != nil || strings.TrimSpace(apiKey) == "" {
		return nil, invalidAuthFile("OPENAI_API_KEY 不能为空")
	}

	auth, domainErr := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey:  apiKey,
		BaseURL: options.APIKeyBaseURL,
	})
	if domainErr != nil {
		return nil, invalidAuthFile("API Key 凭证不满足领域约束")
	}
	return auth, nil
}

// decodeAccountID 把缺失或 null 解释为未显式声明；空字符串没有业务含义。
func decodeAccountID(raw json.RawMessage) (string, error) {
	if len(raw) == 0 || isJSONNull(raw) {
		return "", nil
	}
	accountID, err := decodeRequiredString(raw)
	if err != nil || strings.TrimSpace(accountID) == "" {
		return "", invalidAuthFile("OAuth account_id 无效")
	}
	return strings.TrimSpace(accountID), nil
}

// decodeRefreshTime 把可选 RFC3339 last_refresh 转成毫秒时间戳；零表示未知。
func decodeRefreshTime(raw json.RawMessage) (int64, error) {
	if len(raw) == 0 || isJSONNull(raw) {
		return 0, nil
	}
	value, err := decodeRequiredString(raw)
	if err != nil {
		return 0, invalidAuthFile("last_refresh 必须是 RFC3339 字符串")
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || parsed.UnixMilli() <= 0 {
		return 0, invalidAuthFile("last_refresh 必须是有效正时间")
	}
	return parsed.UnixMilli(), nil
}

// encodeOAuth 重新通过领域构造器校验对象，避免零值实例绕过不变量。
func encodeOAuth(auth *codex.OAuthAuth) ([]byte, error) {
	validated, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:       auth.AccessToken(),
		RefreshToken:      auth.RefreshToken(),
		IDToken:           auth.IDToken(),
		RefreshedAtMS:     auth.RefreshedAtMS(),
		ExplicitAccountID: auth.UpstreamAccountID(),
	})
	if err != nil {
		return nil, invalidAuthFile("OAuth 认证对象无效")
	}
	lastRefresh, err := encodeOptionalRefreshTime(validated.RefreshedAtMS())
	if err != nil {
		return nil, err
	}

	var accountID *string
	if validated.UpstreamAccountID() != "" {
		value := validated.UpstreamAccountID()
		accountID = &value
	}
	document := oauthOutput{
		AuthMode:     authModeChatGPT,
		OpenAIAPIKey: nil,
		Tokens: oauthTokenOutput{
			IDToken:      validated.IDToken(),
			AccessToken:  validated.AccessToken(),
			RefreshToken: validated.RefreshToken(),
			AccountID:    accountID,
		},
		LastRefresh: lastRefresh,
	}
	return marshalOfficial(document)
}

// encodeOptionalRefreshTime 保留官方 last_refresh 的可选语义，不用当前时间填空。
func encodeOptionalRefreshTime(milliseconds int64) (*string, error) {
	if milliseconds == 0 {
		return nil, nil
	}
	value, err := encodeRefreshTime(milliseconds)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

// encodeRefreshTime 只输出 RFC3339 能表示的时间范围，拒绝极端领域零值。
func encodeRefreshTime(milliseconds int64) (string, error) {
	text, err := time.UnixMilli(milliseconds).UTC().MarshalText()
	if err != nil {
		return "", invalidAuthFile("OAuth 刷新时间无法写成 RFC3339")
	}
	return string(text), nil
}

// encodeAPIKey 重新校验领域对象，并刻意不把 BaseURL 写入官方文件。
func encodeAPIKey(auth *codex.APIKeyAuth) ([]byte, error) {
	validated, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey:  auth.APIKey(),
		BaseURL: auth.BaseURL(),
	})
	if err != nil {
		return nil, invalidAuthFile("API Key 认证对象无效")
	}
	document := apiKeyOutput{
		AuthMode:     authModeAPIKey,
		OpenAIAPIKey: validated.APIKey(),
	}
	return marshalOfficial(document)
}

// decodeRequiredString 只接受存在且非 null 的 JSON 字符串。
func decodeRequiredString(raw json.RawMessage) (string, error) {
	if len(raw) == 0 || isJSONNull(raw) {
		return "", invalidAuthFile("必需字符串缺失")
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", invalidAuthFile("必需字段类型错误")
	}
	if strings.ContainsRune(value, utf8.RuneError) {
		return "", invalidAuthFile("必需字符串包含禁止的 Unicode 替代字符")
	}
	return value, nil
}

// decodeAuthDocument 解析当前官方字段，同时允许未来新增互不冲突的扩展字段。
func decodeAuthDocument(data []byte) (authDocument, error) {
	fields, err := decodeKnownObject(
		data,
		"auth_mode",
		"OPENAI_API_KEY",
		"tokens",
		"last_refresh",
		"agent_identity",
		"personal_access_token",
		"bedrock_api_key",
	)
	if err != nil {
		return authDocument{}, err
	}
	return authDocument{
		AuthMode:            fields["auth_mode"],
		OpenAIAPIKey:        fields["OPENAI_API_KEY"],
		Tokens:              fields["tokens"],
		LastRefresh:         fields["last_refresh"],
		AgentIdentity:       fields["agent_identity"],
		PersonalAccessToken: fields["personal_access_token"],
		BedrockAPIKey:       fields["bedrock_api_key"],
	}, nil
}

// hasAlternativeAuthMaterial 检查 AIH 尚未实现的互斥认证材料。
func hasAlternativeAuthMaterial(document authDocument) bool {
	return hasJSONValue(document.AgentIdentity) ||
		hasJSONValue(document.PersonalAccessToken) ||
		hasJSONValue(document.BedrockAPIKey)
}

// resolveAuthMode 对齐 Codex 官方缺省模式推导，并显式保留不支持模式。
func resolveAuthMode(document authDocument) (string, error) {
	if hasJSONValue(document.AuthMode) {
		authMode, err := decodeRequiredString(document.AuthMode)
		if err != nil {
			return "", invalidAuthFile("auth_mode 无效")
		}
		return authMode, nil
	}
	if hasJSONValue(document.PersonalAccessToken) {
		return authModePersonalAccessToken, nil
	}
	if hasJSONValue(document.BedrockAPIKey) {
		return authModeBedrockAPIKey, nil
	}
	if hasJSONValue(document.OpenAIAPIKey) {
		return authModeAPIKey, nil
	}
	return authModeChatGPT, nil
}

// decodeTokenDocument 精确解析 OAuth token 键，并保留 account_id 的存在状态。
func decodeTokenDocument(data []byte) (tokenDocument, error) {
	fields, err := decodeKnownObject(data, "id_token", "access_token", "refresh_token", "account_id")
	if err != nil {
		return tokenDocument{}, err
	}
	idToken, err := decodeRequiredString(fields["id_token"])
	if err != nil {
		return tokenDocument{}, err
	}
	accessToken, err := decodeRequiredString(fields["access_token"])
	if err != nil {
		return tokenDocument{}, err
	}
	refreshToken, err := decodeRequiredString(fields["refresh_token"])
	if err != nil {
		return tokenDocument{}, err
	}
	return tokenDocument{
		IDToken:      idToken,
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		AccountID:    fields["account_id"],
	}, nil
}

// decodeKnownObject 以 token 流解析对象：保留已知键，忽略未来扩展键，
// 同时拒绝已知键的大小写变体、重复定义和尾随值。
func decodeKnownObject(data []byte, knownKeys ...string) (map[string]json.RawMessage, error) {
	known := make(map[string]struct{}, len(knownKeys))
	for _, key := range knownKeys {
		known[key] = struct{}{}
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return nil, errors.New("JSON 值不是对象")
	}
	fields := make(map[string]json.RawMessage, len(knownKeys))
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, errors.New("JSON 对象键无效")
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, errors.New("JSON 对象键类型无效")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, errors.New("JSON 对象值无效")
		}
		if _, ok := known[key]; !ok {
			if matchesKnownKeyIgnoringCase(key, knownKeys) {
				return nil, errors.New("JSON 已知键大小写错误")
			}
			continue
		}
		if _, duplicated := fields[key]; duplicated {
			return nil, errors.New("JSON 对象包含重复键")
		}
		fields[key] = value
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return nil, errors.New("JSON 对象未正确结束")
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, errors.New("JSON 对象后存在额外内容")
	}
	return fields, nil
}

// matchesKnownKeyIgnoringCase 识别会被 encoding/json 宽松匹配的危险拼写变体。
func matchesKnownKeyIgnoringCase(key string, knownKeys []string) bool {
	for _, knownKey := range knownKeys {
		if strings.EqualFold(key, knownKey) {
			return true
		}
	}
	return false
}

// marshalOfficial 使用与官方文件一致的两空格缩进，不在错误中包含待编码内容。
func marshalOfficial(document any) ([]byte, error) {
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return nil, invalidAuthFile("官方认证文件编码失败")
	}
	return data, nil
}

// isJSONNull 判断字段是否显式写成 JSON null。
func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// hasJSONValue 判断 Option 形态字段是否包含非 null 值。
func hasJSONValue(raw json.RawMessage) bool {
	return len(raw) != 0 && !isJSONNull(raw)
}

// invalidAuthFile 只接受代码内常量原因，禁止拼接外部输入和底层错误文本。
func invalidAuthFile(reason string) error {
	return fmt.Errorf("%w: %s", ErrInvalidAuthFile, reason)
}
