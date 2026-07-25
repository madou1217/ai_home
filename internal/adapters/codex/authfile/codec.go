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
	authModeChatGPT = "chatgpt"
	authModeAPIKey  = "apikey"
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
	AuthMode     string
	OpenAIAPIKey json.RawMessage
	Tokens       json.RawMessage
	LastRefresh  json.RawMessage
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
	LastRefresh  string           `json:"last_refresh"`
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

	switch document.AuthMode {
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
	// 旧 token-exchange 会留下 OAuth + API Key 混合文件；本轮 canonical 有意拒绝该历史形态。
	if len(document.OpenAIAPIKey) == 0 || !isJSONNull(document.OpenAIAPIKey) {
		return nil, invalidAuthFile("OAuth OPENAI_API_KEY 必须为 null")
	}
	if len(document.Tokens) == 0 || isJSONNull(document.Tokens) {
		return nil, invalidAuthFile("OAuth tokens 缺失")
	}
	if len(document.LastRefresh) == 0 || isJSONNull(document.LastRefresh) {
		return nil, invalidAuthFile("OAuth last_refresh 缺失")
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
	if len(document.Tokens) != 0 || len(document.LastRefresh) != 0 {
		return nil, invalidAuthFile("API Key 模式不能包含 OAuth 字段")
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

// decodeAccountID 要求 account_id 字段存在；null 表示未显式声明，空字符串无业务含义。
func decodeAccountID(raw json.RawMessage) (string, error) {
	if len(raw) == 0 {
		return "", invalidAuthFile("OAuth account_id 缺失")
	}
	if isJSONNull(raw) {
		return "", nil
	}
	accountID, err := decodeRequiredString(raw)
	if err != nil || strings.TrimSpace(accountID) == "" {
		return "", invalidAuthFile("OAuth account_id 无效")
	}
	return strings.TrimSpace(accountID), nil
}

// decodeRefreshTime 把 RFC3339 last_refresh 转成领域统一使用的毫秒时间戳。
func decodeRefreshTime(raw json.RawMessage) (int64, error) {
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
	lastRefresh, err := encodeRefreshTime(validated.RefreshedAtMS())
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

// decodeAuthDocument 精确解析顶层键，不接受 encoding/json 的大小写宽松匹配。
func decodeAuthDocument(data []byte) (authDocument, error) {
	fields, err := decodeExactObject(data, "auth_mode", "OPENAI_API_KEY", "tokens", "last_refresh")
	if err != nil {
		return authDocument{}, err
	}
	authMode, err := decodeRequiredString(fields["auth_mode"])
	if err != nil {
		return authDocument{}, err
	}
	return authDocument{
		AuthMode:     authMode,
		OpenAIAPIKey: fields["OPENAI_API_KEY"],
		Tokens:       fields["tokens"],
		LastRefresh:  fields["last_refresh"],
	}, nil
}

// decodeTokenDocument 精确解析 OAuth token 键，并保留 account_id 的存在状态。
func decodeTokenDocument(data []byte) (tokenDocument, error) {
	fields, err := decodeExactObject(data, "id_token", "access_token", "refresh_token", "account_id")
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

// decodeExactObject 以 token 流解析对象，拒绝未知键、大小写变体、重复键和尾随值。
func decodeExactObject(data []byte, allowedKeys ...string) (map[string]json.RawMessage, error) {
	allowed := make(map[string]struct{}, len(allowedKeys))
	for _, key := range allowedKeys {
		allowed[key] = struct{}{}
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return nil, errors.New("JSON 值不是对象")
	}
	fields := make(map[string]json.RawMessage, len(allowedKeys))
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, errors.New("JSON 对象键无效")
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, errors.New("JSON 对象键类型无效")
		}
		if _, ok := allowed[key]; !ok {
			return nil, errors.New("JSON 对象包含未知键")
		}
		if _, duplicated := fields[key]; duplicated {
			return nil, errors.New("JSON 对象包含重复键")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, errors.New("JSON 对象值无效")
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

// invalidAuthFile 只接受代码内常量原因，禁止拼接外部输入和底层错误文本。
func invalidAuthFile(reason string) error {
	return fmt.Errorf("%w: %s", ErrInvalidAuthFile, reason)
}
