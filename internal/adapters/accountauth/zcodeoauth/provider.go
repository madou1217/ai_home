// Package zcodeoauth 实现 ZCode 桌面端自定义协议（zcode://oauth/callback）登录流程。
//
// 与 Node 的 custom-scheme 分支同源（lib/server/oauth-strategies/zcode.js）：
// 用户在授权页（chat.z.ai / bigmodel.cn）完成授权后，浏览器跳到
// zcode://oauth/callback，本机没有任何服务监听，所以要把地址栏整段回调地址粘回界面。
//
//  1. Begin：生成 state，按区域拼出官方授权入口；
//  2. Exchange：从回调里取 code，POST 到 zcode.z.ai 换 token，再产出可注册的
//     native_auth_json（形状与 zcode-credential-writer 落盘的 plaintext credentials 一致）。
//
// loopback 不是选项：Z.ai 对该 client（client_P8X5CMWmlaRO9gyO-KSqtg）的
// redirect_uri 白名单只有 zcode://oauth/callback 与它自己的 HTTPS 回调，
// 任何 http://localhost:… 都会被拒。
package zcodeoauth

import (
	"context"
	"crypto/rand"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
)

const (
	providerID = "zcode"
	// clientID 是 ZCode 桌面端注册的公开 OAuth Client ID（与 Node 的 ZCODE_OAUTH_CLIENT_ID 同值）。
	clientID = "client_P8X5CMWmlaRO9gyO-KSqtg" // gitleaks:allow -- 桌面端公开 Client ID。
	// redirectURI 是该 client 白名单里唯一的自定义协议地址。
	redirectURI = "zcode://oauth/callback"
	// tokenEndpoint 是两条 ZCode 登录路径（cli-flow / custom-scheme）共用的交换入口。
	tokenEndpoint = "https://zcode.z.ai/api/v1/oauth/token"

	authorizeEndpointZai      = "https://chat.z.ai/api/oauth/authorize"
	authorizeEndpointBigmodel = "https://bigmodel.cn/login"
	// bigmodel 的授权入口不认 response_type/client_id，改用 appId + redirect。
	bigmodelAppID = "zcode"
)

// region 描述一个上游区域：授权入口与凭据键前缀（见 lib/server/zcode-region.js）。
//
// 区域是**上游 provider 维度**，不是域名维度：zchat.z.ai 只是 chat.z.ai 的镜像，
// 不属于另一个区域。
type region struct {
	id                string
	authorizeEndpoint string
	accessTokenKey    string
	refreshTokenKey   string
	userInfoKey       string
}

var regions = map[string]region{
	"zai": {
		id:                "zai",
		authorizeEndpoint: authorizeEndpointZai,
		accessTokenKey:    "oauth:zai:access_token",
		refreshTokenKey:   "oauth:zai:refresh_token",
		userInfoKey:       "oauth:zai:user_info",
	},
	"bigmodel": {
		id:                "bigmodel",
		authorizeEndpoint: authorizeEndpointBigmodel,
		accessTokenKey:    "oauth:bigmodel:access_token",
		refreshTokenKey:   "oauth:bigmodel:refresh_token",
		userInfoKey:       "oauth:bigmodel:user_info",
	},
}

// resolveRegion 把任意输入归一成区域描述符；未知值回落到 zai（与上游默认一致）。
//
// 与 Node 的 resolveZcodeRegion 同语义：区域只是入口选择，不该让一次登录整体失败。
func resolveRegion(value string) region {
	if resolved, found := regions[strings.ToLower(strings.TrimSpace(value))]; found {
		return resolved
	}
	return regions["zai"]
}

// 编译期断言：策略端口与一次性 Flow 端口都对齐现有 Job 框架。
var (
	_ accountauth.OAuthProvider         = (*Provider)(nil)
	_ accountauth.OAuthFlow             = (*flow)(nil)
	_ accountauth.AccountClaimsProvider = (*flow)(nil)
)

// Provider 是无可变会话状态的 ZCode 自定义协议策略。
type Provider struct {
	client        *http.Client
	random        io.Reader
	region        region
	tokenEndpoint string
}

// providerOptions 仅供包内测试替换网络端点与随机源。
type providerOptions struct {
	client        *http.Client
	random        io.Reader
	region        region
	tokenEndpoint string
}

// New 创建使用默认区域（zai）的生产策略。
func New(client *http.Client) (*Provider, error) {
	return NewForRegion(client, "zai")
}

// NewForRegion 创建指定区域（zai / bigmodel）的生产策略。
//
// 区域决定授权入口与凭据键前缀，未知值按 zai 处理。它由装配处固定：Job 框架的
// StartRequest 只带 ProviderID，不携带区域。
func NewForRegion(client *http.Client, value string) (*Provider, error) {
	return newProvider(providerOptions{
		client:        client,
		random:        rand.Reader,
		region:        resolveRegion(value),
		tokenEndpoint: tokenEndpoint,
	})
}

// newProvider 校验可注入依赖，生产构造器不暴露端点覆盖能力。
func newProvider(options providerOptions) (*Provider, error) {
	if options.client == nil ||
		options.random == nil ||
		!validAbsoluteURL(options.region.authorizeEndpoint) ||
		!validAbsoluteURL(options.tokenEndpoint) {
		return nil, accountauth.ErrInvalidDependencies
	}
	return &Provider{
		client:        options.client,
		random:        options.random,
		region:        options.region,
		tokenEndpoint: options.tokenEndpoint,
	}, nil
}

// ProviderID 返回规范 ZCode Provider ID。
func (*Provider) ProviderID() string {
	return providerID
}

// Begin 生成 32 字节 state 与官方授权 URL。
func (provider *Provider) Begin(ctx context.Context) (accountauth.OAuthFlow, error) {
	if err := ctx.Err(); err != nil {
		return nil, errors.Join(accountauth.ErrProviderUnavailable, err)
	}
	state, err := oauthutil.GenerateState(provider.random, 32)
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	authorization, err := buildAuthorizationURL(provider.region, redirectURI, state)
	if err != nil {
		return nil, accountauth.ErrProviderUnavailable
	}
	return &flow{
		client:        provider.client,
		region:        provider.region,
		tokenEndpoint: provider.tokenEndpoint,
		authorization: authorization,
		state:         state,
	}, nil
}

// buildAuthorizationURL 按区域拼装授权入口。
//
// zai 用标准 Authorization Code 四参数（无 PKCE、无 scope —— 桌面端就发这四个）；
// bigmodel 只认 appId + redirect。两者都带 state。
func buildAuthorizationURL(selected region, redirect string, state string) (string, error) {
	parsed, err := url.Parse(selected.authorizeEndpoint)
	if err != nil {
		return "", err
	}
	query := parsed.Query()
	if selected.id == "bigmodel" {
		query.Set("appId", bigmodelAppID)
		query.Set("redirect", redirect)
	} else {
		query.Set("response_type", "code")
		query.Set("client_id", clientID)
		query.Set("redirect_uri", redirect)
	}
	query.Set("state", state)
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

// validAbsoluteURL 校验内部端点是无凭据的绝对 HTTP(S) URL。
func validAbsoluteURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil &&
		(parsed.Scheme == "http" || parsed.Scheme == "https") &&
		parsed.Host != "" &&
		parsed.User == nil
}
