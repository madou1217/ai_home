// Package kimioauth 实现 kimi (kimi-code) OAuth Refresh Token 的刷新策略。
//
// 协议事实与 Node lib/server/kimi-token-refresh.js、@moonshot-ai/kimi-code 的
// refreshAccessToken 完全同源：
//
//	POST {host}/api/oauth/token
//	Content-Type: application/x-www-form-urlencoded
//	client_id=...&grant_type=refresh_token&refresh_token=...
//	→ {access_token, refresh_token?, expires_in, token_type?, scope?}
//
// 为什么必须刷新：kimi 的 access_token 只有 15 分钟有效期（expires_in=900），
// 不续期的话运行池加载、配额探测等所有依赖 access_token 的链路会在登录一刻钟后集体失败。
// 为什么必须整份写回：kimi 每次刷新都会轮换 refresh_token，只替换 access_token 会让
// 下一次刷新拿着已作废的 grant 去吃 invalid_grant。
package kimioauth

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/kimiidentity"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

const (
	providerID = "kimi"
	// defaultTokenEndpoint 与 kimi-code CLI 使用的端点同值（Node KIMI_OAUTH_HOST + /api/oauth/token）。
	defaultTokenEndpoint = "https://auth.kimi.com/api/oauth/token"
	// clientID 是 kimi-code CLI 的公开 OAuth Client ID（与 Node KIMI_OAUTH_CLIENT_ID 同值）。
	clientID = "17e5f671-d194-4dfb-9706-5516cb48c098" // gitleaks:allow -- kimi 官方公开 OAuth Client ID。
	// maxTokenBodyBytes 同时约束上游响应、凭据文档与单个令牌的长度。
	maxTokenBodyBytes = 256 * 1024
	// maxCredentialBytes 覆盖完整 native_auth_json（比令牌响应宽松，仍拒绝异常大文档）。
	maxCredentialBytes = 1024 * 1024
	// requestTimeout 对齐 Node DEFAULT_REFRESH_TIMEOUT_MS（15s）。
	requestTimeout = 15 * time.Second
	// maxUnixSeconds 是 time.Unix 能稳定表示的上界，避免 expires_in 溢出。
	maxUnixSeconds = 253_402_300_799
	// defaultClientVersion 与 Node DEFAULT_KIMI_CODE_VERSION 同值；真实版本由组合根注入。
	defaultClientVersion = "0.36.0"
	kimiCodePlatform     = "kimi_code_cli"
	userAgentProduct     = "kimi-code-cli"
)

var (
	// errInvalidCredential 表示原生凭据文档不是可合并的 JSON 对象。
	errInvalidCredential = errors.New("kimi 原生凭据文档无效")
)

// HTTPClient 是刷新策略唯一依赖的传输端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// Options 是可注入的客户端身份参数。
//
// ClientVersion 会进入 User-Agent / X-Msh-Version：Node 侧这两项自报 kimi-code CLI
// 的版本，缺了上游会按「非官方客户端」对待，因此组合根应按本机 CLI 解析后注入。
type Options struct {
	ClientVersion string
}

// Provider 是无共享可变状态（除只读解码器注册表）的 kimi 刷新策略。
// 并发合并与凭据版本 CAS 由 accountcredentials.Resolver 统一负责。
type Provider struct {
	client        HTTPClient
	tokenEndpoint string
	version       string
	decoder       *nativeaccount.Decoder
}

var _ accountcredentials.RefreshStrategy = (*Provider)(nil)

// New 创建固定调用 kimi 官方生产 Token Endpoint 的策略。
func New(client HTTPClient, options Options) (*Provider, error) {
	return newProvider(client, defaultTokenEndpoint, options)
}

// newProvider 允许包内测试替换端点；生产构造器不暴露端点覆盖能力。
func newProvider(client HTTPClient, endpoint string, options Options) (*Provider, error) {
	version := strings.TrimSpace(options.ClientVersion)
	if version == "" {
		version = defaultClientVersion
	}
	parsed, err := url.Parse(endpoint)
	if client == nil ||
		err != nil ||
		parsed.Scheme == "" ||
		parsed.Host == "" ||
		parsed.User != nil ||
		!validHeaderValue(version) {
		return nil, accountcredentials.ErrInvalidDependencies
	}
	return &Provider{
		client:        client,
		tokenEndpoint: endpoint,
		version:       version,
		decoder:       nativeaccount.NewDecoder(),
	}, nil
}

// ProviderID 返回规范 kimi Provider ID。
func (*Provider) ProviderID() string { return providerID }

// ExpiresAt 读 $.credentials.expires_at（kimi-code 落盘为秒级 epoch）。
//
// 不可判定时返回 false：解析器据此认为「没有明确过期时间」，不会主动刷新。
// expires_at 缺失时回退 access_token 的 JWT exp（与 Node readKimiTokenExpiry 一致）：
// 早期快照只有令牌没有 expires_at，少了这层回退就会放任 15 分钟有效期的 token 过期。
func (*Provider) ExpiresAt(
	credential accountapp.Credential,
) (time.Time, bool) {
	native, valid := credential.(*accountcore.NativeCredential)
	if !valid || native == nil || native.ProviderID() != providerID {
		return time.Time{}, false
	}
	document, err := decodeDocument(native.Payload())
	if err != nil {
		return time.Time{}, false
	}
	section := oauthSection(document)
	if seconds := expiresAtSeconds(section); seconds > 0 {
		return time.Unix(seconds, 0).UTC(), true
	}
	if seconds, ok := jwtExpirySeconds(firstText(section, "access_token", "accessToken")); ok {
		return time.Unix(seconds, 0).UTC(), true
	}
	return time.Time{}, false
}

// refreshResponse 是 kimi OAuth refresh 成功响应的允许字段。
type refreshResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int64  `json:"expires_in"`
	TokenType    string `json:"token_type"`
	Scope        string `json:"scope"`
}

// Refresh 用 refresh_token 换取新 Access Token，并把结果合并回原凭据文档。
func (provider *Provider) Refresh(
	ctx context.Context,
	credential accountapp.Credential,
	refreshedAt time.Time,
) (accountapp.Credential, error) {
	native, valid := credential.(*accountcore.NativeCredential)
	if provider == nil ||
		provider.client == nil ||
		provider.decoder == nil ||
		ctx == nil ||
		!valid ||
		native == nil ||
		native.ProviderID() != providerID ||
		refreshedAt.IsZero() ||
		refreshedAt.Unix() <= 0 ||
		refreshedAt.Unix() >= maxUnixSeconds {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	document, err := decodeDocument(native.Payload())
	if err != nil {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	section := oauthSection(document)
	refreshToken := firstText(section, "refresh_token", "refreshToken")
	// 没有 refresh_token 说明只剩已过期的 access_token（kimi 的 access_token 只有
	// 15 分钟），任何重放都换不到新 grant，只能让用户重新登录。
	if !validSecret(refreshToken) {
		return nil, accountcredentials.ErrReauthenticationRequired
	}

	form := url.Values{
		"client_id":     {clientID},
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
	}
	requestBody := []byte(form.Encode())
	defer clear(requestBody)

	requestContext, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(
		requestContext,
		http.MethodPost,
		provider.tokenEndpoint,
		bytes.NewReader(requestBody),
	)
	if err != nil {
		return nil, accountcredentials.ErrRefreshUnavailable
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Accept-Encoding", "identity")
	provider.setClientHeaders(request.Header, document, section)

	response, err := provider.client.Do(request)
	if err != nil {
		// 错误文本只保留上下文原因，绝不拼接请求体或令牌。
		if contextErr := ctx.Err(); contextErr != nil {
			return nil, errors.Join(accountcredentials.ErrRefreshUnavailable, contextErr)
		}
		return nil, accountcredentials.ErrRefreshUnavailable
	}
	if response == nil || response.Body == nil {
		return nil, accountcredentials.ErrRefreshUnavailable
	}
	defer func() {
		_ = response.Body.Close()
	}()
	if response.StatusCode < http.StatusOK ||
		response.StatusCode >= http.StatusMultipleChoices {
		// 共享分类器：401/403 或 invalid_grant → 需要重新认证；其它 4xx → 被拒绝；
		// 5xx/429/408 → 暂时不可用。错误码只取机器码，不含 response 正文。
		return nil, oauthutil.ClassifyRefreshError(
			response.StatusCode,
			oauthutil.DecodeErrorCode(response.Body, maxTokenBodyBytes),
		)
	}

	var tokens refreshResponse
	if err := oauthutil.DecodeJSONResponse(
		response.Body,
		maxTokenBodyBytes,
		&tokens,
	); err != nil ||
		!validSecret(tokens.AccessToken) ||
		(tokens.RefreshToken != "" && !validSecret(tokens.RefreshToken)) ||
		(tokens.TokenType != "" && !validSecret(tokens.TokenType)) ||
		tokens.ExpiresIn <= 0 ||
		tokens.ExpiresIn > maxUnixSeconds-refreshedAt.Unix() {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}

	// 轮换后的 refresh_token 缺失时保留旧值：kimi 的响应理论上总是轮换，但旧 grant
	// 仍可复用时就该继续用，不能把账号刷成没有 refresh_token 的死快照。
	nextRefreshToken := refreshToken
	if tokens.RefreshToken != "" {
		nextRefreshToken = tokens.RefreshToken
	}
	nextSection := cloneObject(section)
	nextSection["access_token"] = tokens.AccessToken
	nextSection["refresh_token"] = nextRefreshToken
	// expires_at 必须写回秒级 epoch：kimi-code 的落盘格式，Node 与本策略的过期判断都读它。
	nextSection["expires_at"] = refreshedAt.Unix() + tokens.ExpiresIn
	nextSection["expires_in"] = tokens.ExpiresIn
	if tokens.TokenType != "" {
		nextSection["token_type"] = tokens.TokenType
	} else if existing := firstText(section, "token_type", "tokenType"); existing != "" {
		nextSection["token_type"] = existing
	} else {
		nextSection["token_type"] = "Bearer"
	}
	if tokens.Scope != "" {
		nextSection["scope"] = tokens.Scope
	} else {
		nextSection["scope"] = firstText(section, "scope")
	}

	nextDocument := cloneObject(document)
	nextDocument["credentials"] = nextSection
	// 与 Node buildRefreshedNativeAuth 一致：legacy auth 快照已并入 credentials，
	// 删除它避免同一账号留下两份分叉的 grant。
	delete(nextDocument, "auth")
	encoded, err := json.Marshal(nextDocument)
	if err != nil {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	refreshed, err := provider.decoder.DecodeNativeAuth(providerID, encoded)
	if err != nil ||
		refreshed == nil ||
		refreshed.ProviderID() != providerID ||
		refreshed.IdentitySeed() != native.IdentitySeed() {
		// 身份种子变了说明上游把这次刷新发给了另一个账号，绝不能落库。
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	return refreshed, nil
}

// setClientHeaders 复刻 Node buildKimiRequestHeaders 中可确定的部分。
//
// 为什么不生成随机 device id：Node 在完全取不到 id 时会临时 randomUUID，那会让同一
// 账号每次刷新都报「换了一台设备」；RefreshStrategy 拿不到 accountRef，无法做
// stable-derived 派生，因此这里只使用凭据自带的官方 device id，取不到就省略设备头。
func (provider *Provider) setClientHeaders(
	headers http.Header,
	document map[string]any,
	section map[string]any,
) {
	headers.Set("User-Agent", userAgentProduct+"/"+provider.version)
	headers.Set("X-Msh-Platform", kimiCodePlatform)
	headers.Set("X-Msh-Version", provider.version)
	deviceID := firstNonEmpty(
		firstText(section, "device_id", "deviceId"),
		firstText(document, "deviceId", "device_id"),
		jwtStringClaim(firstText(section, "access_token", "accessToken"), "device_id"),
		jwtStringClaim(firstText(section, "refresh_token", "refreshToken"), "device_id"),
	)
	if !validHeaderValue(deviceID) {
		return
	}
	device := kimiidentity.ResolveDeviceHeaders(
		"",
		kimiidentity.DefaultProfile(),
		deviceID,
		kimiidentity.HostFacts{},
	)
	for name, value := range map[string]string{
		"X-Msh-Device-Id":    device.DeviceID,
		"X-Msh-Device-Name":  device.DeviceName,
		"X-Msh-Device-Model": device.DeviceModel,
		"X-Msh-Os-Version":   device.OSVersion,
	} {
		if validHeaderValue(value) {
			headers.Set(name, value)
		}
	}
}

// oauthSection 按 Node readKimiOAuthCredentials 的优先级选登录快照：
// 优先能恢复的 canonical credentials，其次完整回退 legacy auth，最后才用顶层扁平形态。
func oauthSection(document map[string]any) map[string]any {
	credentials := objectOf(document["credentials"])
	legacy := objectOf(document["auth"])
	if credentials != nil && firstText(credentials, "refresh_token", "refreshToken") != "" {
		return credentials
	}
	if legacy != nil && firstText(legacy, "refresh_token", "refreshToken") != "" {
		return legacy
	}
	if credentials != nil {
		return credentials
	}
	if legacy != nil {
		return legacy
	}
	return document
}

// expiresAtSeconds 把 expires_at 归一成秒级 epoch。
//
// 历史上的快照混用过秒与毫秒，按 Node readKimiTokenExpiry 的 1e12 阈值区分；
// 直接按秒解读毫秒会把过期时间推到几万年以后，账号再也不会被刷新。
func expiresAtSeconds(section map[string]any) int64 {
	for _, key := range []string{"expires_at", "expiresAt"} {
		value := positiveInteger(section[key])
		if value <= 0 {
			continue
		}
		if value > 1_000_000_000_000 {
			value /= 1000
		}
		if value >= maxUnixSeconds {
			return 0
		}
		return value
	}
	return 0
}

// jwtExpirySeconds 从 access_token 的 JWT payload 读 exp（不校验签名，仅作过期判断）。
func jwtExpirySeconds(token string) (int64, bool) {
	value := positiveInteger(jwtClaims(token)["exp"])
	if value <= 0 || value >= maxUnixSeconds {
		return 0, false
	}
	return value, true
}

// jwtStringClaim 读 JWT payload 的字符串声明（用于 device_id 这类客户端元数据）。
func jwtStringClaim(token string, claim string) string {
	value, ok := jwtClaims(token)[claim].(string)
	if !ok {
		return ""
	}
	value = strings.TrimSpace(value)
	if !validHeaderValue(value) {
		return ""
	}
	return value
}

// jwtClaims 只解析 JWT 的未签名 payload；签名无法在客户端验证，因此这些声明
// 只用于请求元数据，绝不参与身份判定。
func jwtClaims(token string) map[string]any {
	if token == "" || len(token) > maxTokenBodyBytes {
		return nil
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[1] == "" {
		return nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || len(decoded) == 0 {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(decoded))
	decoder.UseNumber()
	var claims map[string]any
	if decoder.Decode(&claims) != nil || claims == nil {
		return nil
	}
	return claims
}

// decodeDocument 有界解析 kimi 原生凭据文档（必须是 JSON 对象）。
func decodeDocument(payload []byte) (map[string]any, error) {
	if len(payload) == 0 || len(payload) > maxCredentialBytes {
		return nil, errInvalidCredential
	}
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil || document == nil {
		return nil, errInvalidCredential
	}
	return document, nil
}

func objectOf(value any) map[string]any {
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	return object
}

func cloneObject(source map[string]any) map[string]any {
	cloned := make(map[string]any, len(source)+8)
	for key, value := range source {
		cloned[key] = value
	}
	return cloned
}

func firstText(record map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := record[key].(string); ok {
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// positiveInteger 接受 JSON 数字与十进制字符串（Node 的 Number(candidate) 语义）。
func positiveInteger(value any) int64 {
	switch number := value.(type) {
	case json.Number:
		if result, err := number.Int64(); err == nil && result > 0 {
			return result
		}
	case float64:
		if number > 0 && number <= 9_007_199_254_740_991 && math.Trunc(number) == number {
			return int64(number)
		}
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(number), 64)
		if err == nil && parsed > 0 && parsed <= 9_007_199_254_740_991 && math.Trunc(parsed) == parsed {
			return int64(parsed)
		}
	}
	return 0
}

// validSecret 拒绝空白包裹与换行的令牌值：它们不是合法 OAuth 令牌，
// 却可能把响应头或请求体拆成两段。
func validSecret(value string) bool {
	return value != "" &&
		len(value) <= maxTokenBodyBytes &&
		value == strings.TrimSpace(value) &&
		!strings.ContainsAny(value, "\r\n\x00")
}

func validHeaderValue(value string) bool {
	if value == "" || len(value) > 512 || value != strings.TrimSpace(value) {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}
