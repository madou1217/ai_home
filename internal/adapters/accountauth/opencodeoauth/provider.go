// Package opencodeoauth 实现 OpenCode Console 的设备码（RFC 8628）登录流程。
//
// 与 Node 的差别：Node 只能拉起官方 CLI（`opencode auth login opencode --method device
// --standalone`）在 PTY 里读验证码；Go 直接走 CLI 用的同一组 HTTP 端点
// （opencode.ai/console/auth/device/{code,token}），因此不需要本机装 CLI、
// 也不需要解析终端输出。
//
// 协议（2026-11-08 从本机 @opencode/cli 二进制取证）：
//
//	POST {server}/auth/device/code   {"client_id":"opencode-cli","supports_org_scope":true}
//	  → {device_code, user_code, verification_uri_complete, expires_in, interval}
//	POST {server}/auth/device/token  {"grant_type":"urn:ietf:params:oauth:grant-type:device_code",
//	                                  "device_code":…, "client_id":"opencode-cli"}
//	  → {access_token, refresh_token, expires_in, org_id?} | {error:"authorization_pending"|"slow_down"|…}
//	GET  {server}/api/user  GET {server}/api/orgs   （Bearer access_token，成功后补身份）
//
// 设备码流程没有回调：Job 框架用 Begin 拿验证地址、用 Poll 推进，不使用 Exchange。
package opencodeoauth

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

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
)

const (
	providerID = "opencode"
	// clientID 是官方 CLI 的设备码 client_id（`opencode-cli`），不是 Console 的 OAuth 应用。
	clientID = "opencode-cli"
	// defaultServer 是官方 CLI 的默认 Console 地址（方法表单里的 default，未读环境变量）。
	defaultServer = "https://opencode.ai/console"

	deviceCodePath  = "/auth/device/code"
	deviceTokenPath = "/auth/device/token"
	userPath        = "/api/user"
	orgsPath        = "/api/orgs"

	deviceGrantType = "urn:ietf:params:oauth:grant-type:device_code"

	// slowDownStep 是上游返回 slow_down 时官方 CLI 的退避步长（+5s）。
	slowDownStep = 5 * time.Second
	// minInterval 与 defaultInterval 兜住上游给出的异常轮询间隔。
	minInterval     = time.Second
	defaultInterval = 5 * time.Second

	maxBodyBytes = 64 * 1024
)

// Clock 返回判断设备码是否过期所需的当前时间。
type Clock func() time.Time

// 编译期断言：策略端口与一次性 Flow 端口都对齐现有 Job 框架。
var (
	_ accountauth.OAuthProvider = (*Provider)(nil)
	_ accountauth.OAuthFlow     = (*flow)(nil)
)

// Provider 是无可变会话状态的 OpenCode 设备码策略。
type Provider struct {
	client *http.Client
	clock  Clock
	server string
}

// providerOptions 仅供包内测试替换端点、时钟与随机源。
type providerOptions struct {
	client *http.Client
	clock  Clock
	server string
}

// New 创建固定使用官方 Console 地址的生产策略。
func New(client *http.Client, clock Clock) (*Provider, error) {
	return newProvider(providerOptions{client: client, clock: clock, server: defaultServer})
}

// newProvider 校验可注入依赖，生产构造器不暴露服务端覆盖能力。
func newProvider(options providerOptions) (*Provider, error) {
	if options.client == nil || options.clock == nil || !validServer(options.server) {
		return nil, accountauth.ErrInvalidDependencies
	}
	return &Provider{
		client: options.client,
		clock:  options.clock,
		server: strings.TrimSuffix(options.server, "/"),
	}, nil
}

// ProviderID 返回规范 OpenCode Provider ID。
func (*Provider) ProviderID() string {
	return providerID
}

// Begin 申请设备码，并把 verification_uri_complete 作为授权地址交付。
func (provider *Provider) Begin(ctx context.Context) (accountauth.OAuthFlow, error) {
	if err := ctx.Err(); err != nil {
		return nil, errors.Join(accountauth.ErrProviderUnavailable, err)
	}
	now := provider.clock().UTC()
	response, err := postJSON(ctx, provider.client, provider.server+deviceCodePath, map[string]any{
		"client_id":          clientID,
		"supports_org_scope": true,
	})
	if err != nil {
		return nil, err
	}
	defer response.close()
	var payload struct {
		DeviceCode              string `json:"device_code"`
		UserCode                string `json:"user_code"`
		VerificationURIComplete string `json:"verification_uri_complete"`
		ExpiresIn               int64  `json:"expires_in"`
		Interval                int64  `json:"interval"`
	}
	if err := decodePayload(response, &payload); err != nil {
		return nil, err
	}
	// 设备码、用户码、验证地址三者缺一即无法完成登录；短周期直接拒绝，
	// 不要让界面显示一个永远轮询不动的任务。
	if !validSecret(payload.DeviceCode) ||
		!validSecret(payload.UserCode) ||
		!validVerificationURL(payload.VerificationURIComplete) ||
		payload.ExpiresIn <= 0 {
		return nil, accountauth.ErrProviderRejected
	}
	return &flow{
		client:        provider.client,
		clock:         provider.clock,
		server:        provider.server,
		deviceCode:    payload.DeviceCode,
		userCode:      payload.UserCode,
		authorization: payload.VerificationURIComplete,
		expiresAt:     now.Add(time.Duration(payload.ExpiresIn) * time.Second),
		interval:      normalizeInterval(payload.Interval),
	}, nil
}

// httpResponse 包装一次上游响应，便于统一关闭与解码。
type httpResponse struct {
	status int
	body   io.ReadCloser
}

// close 关闭响应体。
func (response *httpResponse) close() {
	if response != nil && response.body != nil {
		_ = response.body.Close()
	}
}

// postJSON 发送 JSON 请求并返回未解码的响应；4xx 也交给调用方判断（设备码轮询的
// pending / slow_down 都是 4xx 业务错误）。
func postJSON(
	ctx context.Context,
	client *http.Client,
	endpoint string,
	payload any,
) (*httpResponse, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		endpoint,
		bytes.NewReader(encoded),
	)
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	if response.StatusCode >= http.StatusInternalServerError {
		_ = response.Body.Close()
		return nil, accountauth.ErrProviderUnavailable
	}
	return &httpResponse{status: response.StatusCode, body: response.Body}, nil
}

// decodePayload 解码成功响应；非 2xx 交给调用方按错误体处理。
func decodePayload(response *httpResponse, target any) error {
	if response == nil {
		return accountauth.ErrProviderUnavailable
	}
	if response.status < 200 || response.status >= 300 {
		if response.status >= 400 && response.status < 500 {
			return accountauth.ErrProviderRejected
		}
		return accountauth.ErrProviderUnavailable
	}
	if err := oauthutil.DecodeJSONResponse(response.body, maxBodyBytes, target); err != nil {
		return accountauth.ErrProviderUnavailable
	}
	return nil
}

// normalizeInterval 把上游的秒级间隔收敛到 [1s, 30s]，缺省 5s。
func normalizeInterval(seconds int64) time.Duration {
	if seconds <= 0 {
		return defaultInterval
	}
	interval := time.Duration(seconds) * time.Second
	if interval < minInterval {
		return minInterval
	}
	if interval > 30*time.Second {
		return 30 * time.Second
	}
	return interval
}

// validServer 校验 Console 地址是绝对的 HTTP(S) 来源（允许带路径前缀）。
func validServer(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil &&
		(parsed.Scheme == "http" || parsed.Scheme == "https") &&
		parsed.Host != "" &&
		parsed.User == nil &&
		parsed.RawQuery == "" &&
		parsed.Fragment == ""
}

// validVerificationURL 校验验证地址是浏览器可直接打开的绝对地址。
func validVerificationURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil &&
		(parsed.Scheme == "http" || parsed.Scheme == "https") &&
		parsed.Host != "" &&
		parsed.User == nil
}

// validSecret 拒绝空白和控制字符，但从不把原值写入错误。
func validSecret(value string) bool {
	return value != "" &&
		value == strings.TrimSpace(value) &&
		!strings.ContainsAny(value, "\x00\r\n")
}
