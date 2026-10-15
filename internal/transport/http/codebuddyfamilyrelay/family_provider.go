package codebuddyfamilyrelay

import (
	"encoding/json"
	"errors"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// ChatCompletionsPath 是家族上游**唯一**接受的路径（约束 1）：
	// `/v1/chat/completions` 实测 404 Route Not Found。
	ChatCompletionsPath = "/v2/chat/completions"
	// UserAgent 是上游网关要求的真实客户端标识。脚本默认 UA 会被 WAF 403
	// `{"code":10085,"msg":"请求不合法"}`；版本号本身不参与鉴权，只用于通过检查。
	UserAgent = "CLI/2.63.2 CodeBuddy/2.63.2"
)

// ErrUnsupportedCredential 表示账号凭据不是家族原生登录态（无 access token 可取）。
//
// 调用方应据此把请求交回 Canonical：那边尊重账号自带的 Base URL 等差异，
// 透传只承诺承载「家族官方端点 + 原生凭据」这一种形态。
var ErrUnsupportedCredential = errors.New("家族透传凭据不受支持")

// FamilyProviders 是家族四支，与 Node 侧 codebuddy-family-layouts 的
// FAMILY_PROVIDERS 同集合（守卫测试会盯住两侧一致）。
var FamilyProviders = []string{"codebuddy", "codebuddycn", "workbuddy", "workbuddycn"}

// inferenceBaseURLs 是发行版级推理 endpoint：国内站两支共用 copilot.tencent.com，
// 国际站两支各用自己站点域名。与 Node 侧 CODEBUDDY_FAMILY_INFERENCE_BASE_URLS 同源，
// 但刻意与计费端点分开声明——计费端点变化与推理端点变化是两件独立的事。
var inferenceBaseURLs = map[string]string{
	"codebuddy":   "https://www.codebuddy.ai",
	"workbuddy":   "https://www.workbuddy.ai",
	"codebuddycn": "https://copilot.tencent.com",
	"workbuddycn": "https://copilot.tencent.com",
}

// IsFamilyProvider 判断 Provider 是否属于家族（大小写与空白归一）。
func IsFamilyProvider(provider string) bool {
	_, found := inferenceBaseURLs[normalizeProvider(provider)]
	return found
}

// InferenceBaseURL 返回该 Provider 的推理站点根；非家族 Provider 返回 false。
func InferenceBaseURL(provider string) (string, bool) {
	base, found := inferenceBaseURLs[normalizeProvider(provider)]
	return base, found
}

// InferenceEndpoint 返回完整上游 URL（站点根 + `/v2/chat/completions`）。
func InferenceEndpoint(provider string) (string, bool) {
	base, found := InferenceBaseURL(provider)
	if !found {
		return "", false
	}
	return base + ChatCompletionsPath, true
}

// normalizeProvider 归一化 Provider 名（与 Node 的 normalizeProvider 同口径）。
func normalizeProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}

// AccessTokenFromCredential 从家族原生凭据里取共享 access token。
//
// 取法与 Go 侧账号策略一致（internal/adapters/accounts/nativeaccount 的
// generation_policy 读同一路径）：`credentials.auth.accessToken`（兼容
// `access_token` 写法）。取不到就是确定性属性，调用方交回 Canonical，
// 不要在这里猜别的字段。
func AccessTokenFromCredential(credential accountapp.Credential) (string, error) {
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		return "", ErrUnsupportedCredential
	}
	return accessTokenFromPayload(native.Payload())
}

// accessTokenFromPayload 从原生凭据载荷里取 access token（纯函数，便于独立测试）。
func accessTokenFromPayload(payload []byte) (string, error) {
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(payload, &fields); err != nil {
		return "", ErrUnsupportedCredential
	}
	credentials, ok := decodeRawObject(fields["credentials"])
	if !ok {
		return "", ErrUnsupportedCredential
	}
	auth, ok := decodeRawObject(credentials["auth"])
	if !ok {
		return "", ErrUnsupportedCredential
	}
	for _, key := range []string{"accessToken", "access_token"} {
		if token, ok := rawString(auth[key]); ok && strings.TrimSpace(token) != "" {
			return strings.TrimSpace(token), nil
		}
	}
	return "", ErrUnsupportedCredential
}
