// Package clineoauth 实现 Cline Pass（WorkOS 登录态）的 OAuth 刷新策略。
//
// 协议事实与 Node lib/server/cline-token-refresh.js 同源（2026-10-14 实测）：
//
//	POST {base}/auth/refresh
//	Content-Type: application/json
//	{"refreshToken":"...","grantType":"refresh_token"}
//	→ 200 {"data":{"accessToken":"<裸 JWT>","refreshToken":"...","expiresAt":"<ISO>"},"success":true}
//
// 两个必须记住的点：
//  1. 响应带 {success,data} 信封（与 chat/completions 的非流式响应同构）；
//  2. data.accessToken 是裸 JWT，而推理出网要求 workos: 前缀——写回磁盘前必须补前缀。
//
// 凭据文档是 CLI 的 providers.json 收窄结果：
//
//	{version,lastUsedProvider,providers:{cline:{settings:{auth:{...}}}, "cline-pass":{...}}}
//
// Cline Pass 登录会同时写 cline 与 cline-pass 两个槽位，刷新后必须两槽同步：只更新
// 一个会让另一个持有已被消费的 grant。
package clineoauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/tokenrefresh"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

const (
	providerID = "cline"
	// defaultBaseURL 是 Cline REST 面的默认根（与 Node CLINE_DEFAULT_BASE_URL 同值）。
	defaultBaseURL = "https://api.cline.bot/api/v1"
	// refreshPath 是刷新端点相对推理 base 的路径。
	refreshPath = "/auth/refresh"
	// primarySlot / passSlot 是 cline 自己的两个凭据槽位（顺序即同有效期时的优先顺序）。
	primarySlot = "cline"
	passSlot    = "cline-pass"
	// accessTokenPrefix 是 WorkOS 签发标记，属于 wire 格式的一部分：
	// Authorization: Bearer workos:<JWT> → 200，裸 JWT → 401（Node 实测）。
	accessTokenPrefix = "workos:"
	// requestTimeout 对齐 Node DEFAULT_REFRESH_TIMEOUT_MS（20s）。
	requestTimeout = 20 * time.Second
)

// HTTPClient 是刷新策略唯一依赖的传输端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// Options 是可注入的 base URL 与时钟。
//
// BaseURL 只服务测试与自建网关覆盖；生产构造器留空即用官方端点。账号级
// CLINE_API_BASE_URL 目前只存在于 Node 的 env_json，Go 的刷新端口拿不到；自定义
// 上游账号由 Node 侧继续续期（见报告）。
type Options struct {
	BaseURL string
	Clock   func() time.Time
}

// Provider 是无共享可变状态的 cline 刷新策略。
type Provider struct {
	client  HTTPClient
	baseURL string
	clock   func() time.Time
	decoder *nativeaccount.Decoder
}

var _ tokenrefresh.Refresher = (*Provider)(nil)

// New 创建固定调用 Cline 官方端点的策略。
func New(client HTTPClient, options Options) (*Provider, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(options.BaseURL), "/")
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	parsed, err := url.Parse(baseURL)
	if client == nil ||
		err != nil ||
		parsed.Scheme == "" ||
		parsed.Host == "" ||
		parsed.User != nil {
		return nil, accountcredentials.ErrInvalidDependencies
	}
	clock := options.Clock
	if clock == nil {
		clock = time.Now
	}
	return &Provider{
		client:  client,
		baseURL: baseURL,
		clock:   clock,
		decoder: nativeaccount.NewDecoder(),
	}, nil
}

// ProviderID 返回规范 Provider ID。
func (*Provider) ProviderID() string { return providerID }

// ExpiresAt 返回两个槽位中剩余有效期更长那条的 expiresAt。
//
// 有效期未知（0）时返回 false：没有依据就刷新会把 grant 白轮换一次
// （Node shouldRefreshToken 同样不主动续期）。
func (*Provider) ExpiresAt(
	credential accountapp.Credential,
) (time.Time, bool) {
	native, valid := credential.(*accountcore.NativeCredential)
	if !valid || native == nil || native.ProviderID() != providerID {
		return time.Time{}, false
	}
	document, err := tokenrefresh.DecodeDocument(native.Payload())
	if err != nil {
		return time.Time{}, false
	}
	selected, ok := selectCredential(document)
	if !ok || !selected.hasExpiry {
		return time.Time{}, false
	}
	return selected.expiresAt, true
}

// slotCredential 是单个槽位里可供刷新使用的最小凭据投影。
type slotCredential struct {
	slotID       string
	refreshToken string
	expiresAt    time.Time
	hasExpiry    bool
	expiresMS    int64
}

// Refresh 用 refresh_token 换取新令牌，并同步写回所有已存在的 cline 槽位。
func (provider *Provider) Refresh(
	ctx context.Context,
	credential accountapp.Credential,
) (accountapp.Credential, error) {
	if provider == nil ||
		provider.client == nil ||
		provider.decoder == nil ||
		ctx == nil ||
		credential == nil ||
		credential.ProviderID() != providerID {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	native, valid := credential.(*accountcore.NativeCredential)
	if !valid || native == nil {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	document, err := tokenrefresh.DecodeDocument(native.Payload())
	if err != nil {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	selected, ok := selectCredential(document)
	if !ok || selected.refreshToken == "" {
		return nil, accountcredentials.ErrReauthenticationRequired
	}
	now := provider.clock().UTC()
	if now.IsZero() || now.UnixMilli() <= 0 {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}

	requestBody, err := json.Marshal(map[string]string{
		"refreshToken": selected.refreshToken,
		"grantType":    "refresh_token",
	})
	if err != nil {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	defer clearBytes(requestBody)

	requestContext, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(
		requestContext,
		http.MethodPost,
		provider.baseURL+refreshPath,
		bytes.NewReader(requestBody),
	)
	if err != nil {
		return nil, accountcredentials.ErrRefreshUnavailable
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Accept-Encoding", "identity")

	response, err := provider.client.Do(request)
	if err != nil {
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
		return nil, classifyRefreshFailure(response)
	}

	var payload map[string]any
	if err := oauthutil.DecodeJSONResponse(
		response.Body,
		tokenrefresh.MaxDocumentBytes,
		&payload,
	); err != nil {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	data := tokenrefresh.Object(payload["data"])
	if data == nil {
		data = payload
	}
	accessToken := ensureAccessTokenPrefix(
		tokenrefresh.Text(data, "accessToken", "access_token"),
	)
	if !tokenrefresh.ValidSecret(accessToken) {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	nextRefreshToken := tokenrefresh.Text(data, "refreshToken", "refresh_token")
	if nextRefreshToken == "" || !tokenrefresh.ValidSecret(nextRefreshToken) {
		nextRefreshToken = selected.refreshToken
	}
	expiresAt, hasExpiry := tokenrefresh.TimestampMS(data["expiresAt"])
	if !hasExpiry {
		expiresAt, hasExpiry = tokenrefresh.TimestampMS(data["expires_at"])
	}
	if !hasExpiry && selected.hasExpiry {
		expiresAt, hasExpiry = selected.expiresAt, true
	}

	if !applyCredential(document, accessToken, nextRefreshToken, expiresAt, hasExpiry, now) {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	refreshed, err := provider.decoder.DecodeNativeAuth(providerID, encoded)
	if err != nil || refreshed == nil || refreshed.ProviderID() != providerID {
		return nil, accountcredentials.ErrInvalidRefreshResult
	}
	return refreshed, nil
}

// classifyRefreshFailure 把非 2xx 响应映射成共享错误。
//
// 除标准机器码外，还保留 Node 的文案判定：Cline 的 400/401 有时只给
// {"error":"invalid_grant"} 之外的描述文本，这类明确的 grant 失效必须归为
// 「需要重新认证」，否则解析器只会每 30 秒重试一次永远失败的 grant。
func classifyRefreshFailure(response *http.Response) error {
	raw, _ := io.ReadAll(io.LimitReader(response.Body, tokenrefresh.MaxDocumentBytes+1))
	code := oauthutil.DecodeErrorCode(bytes.NewReader(raw), tokenrefresh.MaxDocumentBytes)
	if code == "" &&
		(response.StatusCode == http.StatusBadRequest ||
			response.StatusCode == http.StatusUnauthorized) &&
		mentionsInvalidGrant(raw) {
		return accountcredentials.ErrReauthenticationRequired
	}
	return oauthutil.ClassifyRefreshError(response.StatusCode, code)
}

// mentionsInvalidGrant 只做 Node 同款的关键词判定，不返回正文。
func mentionsInvalidGrant(raw []byte) bool {
	var payload struct {
		Error            any    `json:"error"`
		ErrorDescription string `json:"error_description"`
		Message          string `json:"message"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return false
	}
	text := strings.ToLower(payload.ErrorDescription + " " + payload.Message)
	if direct, ok := payload.Error.(string); ok {
		text += " " + strings.ToLower(direct)
	}
	if nested := tokenrefresh.Object(payload.Error); nested != nil {
		text += " " + strings.ToLower(
			tokenrefresh.Text(nested, "code", "type", "message"),
		)
	}
	for _, marker := range []string{"invalid", "expired", "revoked", "unauthoriz"} {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return strings.Contains(text, "re-authenticate") ||
		strings.Contains(text, "reauthenticate")
}

// rootSection 返回 providers 容器；没有 auth 层或 providers 层时按单槽位形态处理。
func rootSection(document map[string]any) map[string]any {
	root := document
	if auth := tokenrefresh.Object(document["auth"]); auth != nil {
		root = auth
	}
	return root
}

// providersSection 返回 providers 容器；已收窄到单槽位的文档回退成 {cline: root}。
func providersSection(document map[string]any) map[string]any {
	root := rootSection(document)
	if providers := tokenrefresh.Object(root["providers"]); providers != nil {
		return providers
	}
	return map[string]any{providerID: root}
}

// slotAuth 读取一个槽位的 settings.auth（兼容已收窄成 settings 本身的形态）。
func slotAuth(providers map[string]any, slotID string) (map[string]any, map[string]any) {
	slot := tokenrefresh.Object(providers[slotID])
	if slot == nil {
		return nil, nil
	}
	settings := tokenrefresh.Object(slot["settings"])
	if settings == nil {
		settings = slot
	}
	auth := tokenrefresh.Object(settings["auth"])
	if auth == nil {
		return slot, nil
	}
	return slot, auth
}

// selectCredential 选剩余有效期更长的槽位；同有效期按 cline 优先（Node 同序）。
func selectCredential(document map[string]any) (slotCredential, bool) {
	providers := providersSection(document)
	selected := slotCredential{}
	found := false
	for _, slotID := range []string{primarySlot, passSlot} {
		_, auth := slotAuth(providers, slotID)
		if auth == nil {
			continue
		}
		accessToken := tokenrefresh.Text(auth, "accessToken", "access_token")
		refreshToken := tokenrefresh.Secret(auth, "refreshToken", "refresh_token")
		if accessToken == "" && refreshToken == "" {
			continue
		}
		expiresAt, hasExpiry := tokenrefresh.TimestampMS(auth["expiresAt"])
		if !hasExpiry {
			expiresAt, hasExpiry = tokenrefresh.TimestampMS(auth["expires_at"])
		}
		candidate := slotCredential{
			slotID:       slotID,
			refreshToken: refreshToken,
			expiresAt:    expiresAt,
			hasExpiry:    hasExpiry,
		}
		if hasExpiry {
			candidate.expiresMS = expiresAt.UnixMilli()
		}
		if !found || candidate.expiresMS > selected.expiresMS {
			selected = candidate
			found = true
		}
	}
	return selected, found
}

// applyCredential 把新凭据写进**每一个已存在的** cline 槽位。
//
// expiresAt 必须写成毫秒数字：CLI 会按自己的 schema 校验整份文档，字符串会被判成
// 未登录（Node 2026-10-15 单变量实测）。
func applyCredential(
	document map[string]any,
	accessToken string,
	refreshToken string,
	expiresAt time.Time,
	hasExpiry bool,
	now time.Time,
) bool {
	root := rootSection(document)
	if providers := tokenrefresh.Object(root["providers"]); providers != nil {
		touched := false
		for _, slotID := range []string{primarySlot, passSlot} {
			slot := tokenrefresh.Object(providers[slotID])
			if slot == nil {
				continue
			}
			providers[slotID] = refreshedSlot(slot, accessToken, refreshToken, expiresAt, hasExpiry, now)
			touched = true
		}
		return touched
	}
	// 已收窄到单槽位的形态：root 本身就是槽位对象，就地更新。
	next := refreshedSlot(root, accessToken, refreshToken, expiresAt, hasExpiry, now)
	for key := range root {
		delete(root, key)
	}
	for key, value := range next {
		root[key] = value
	}
	return true
}

// refreshedSlot 克隆槽位并只替换 auth 里的令牌字段，保留其它设置。
func refreshedSlot(
	slot map[string]any,
	accessToken string,
	refreshToken string,
	expiresAt time.Time,
	hasExpiry bool,
	now time.Time,
) map[string]any {
	nextSlot := tokenrefresh.CloneObject(slot)
	if settings := tokenrefresh.Object(slot["settings"]); settings != nil {
		auth := tokenrefresh.Object(settings["auth"])
		if auth == nil {
			auth = map[string]any{}
		}
		nextAuth := tokenrefresh.CloneObject(auth)
		nextAuth["accessToken"] = accessToken
		nextAuth["refreshToken"] = refreshToken
		if hasExpiry {
			nextAuth["expiresAt"] = expiresAt.UnixMilli()
		}
		nextSettings := tokenrefresh.CloneObject(settings)
		nextSettings["auth"] = nextAuth
		nextSlot["settings"] = nextSettings
	} else {
		auth := tokenrefresh.Object(slot["auth"])
		if auth == nil {
			auth = map[string]any{}
		}
		nextAuth := tokenrefresh.CloneObject(auth)
		nextAuth["accessToken"] = accessToken
		nextAuth["refreshToken"] = refreshToken
		if hasExpiry {
			nextAuth["expiresAt"] = expiresAt.UnixMilli()
		}
		nextSlot["auth"] = nextAuth
	}
	nextSlot["updatedAt"] = tokenrefresh.ISOString(now)
	return nextSlot
}

// ensureAccessTokenPrefix 补齐 workos: 前缀；刷新接口返回的是裸 JWT。
func ensureAccessTokenPrefix(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	if strings.HasPrefix(trimmed, accessTokenPrefix) {
		return trimmed
	}
	return accessTokenPrefix + trimmed
}

// clearBytes 覆盖含 Refresh Token 的临时请求体。
func clearBytes(data []byte) {
	for index := range data {
		data[index] = 0
	}
}
