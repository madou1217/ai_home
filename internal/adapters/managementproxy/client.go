// Package managementproxy 访问 AIH Server 的受管代理管理面。
//
// 分层边界：
//   - 本包只做管理面 HTTP/Upgrade 与租约生命周期（I/O 适配器）。
//   - 「哪个出口更合适」由 Server 的候选顺序决定，本包不重新打分。
//   - 「失败后换下一个」的状态机在 updateproxy.EgressRotation，本包不内置重试策略。
//   - 管理密钥只留在本进程；交给安装器的只有 loopback 认证入口 URL。
package managementproxy

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/proxyingress"
	"github.com/madou1217/ai_home/internal/runtime/updateproxy"
)

const (
	candidatesPath = "/v1/management/proxy-candidates"
	leasesPath     = "/v1/management/proxy-leases"
	upgradeToken   = "aih-proxy"
	callTimeout    = 10 * time.Second
	maxBodyBytes   = 256 * 1024
	// ProviderProxyUnavailableHint 用于把传输错误翻译成可操作的一句提示。
	ProviderProxyUnavailableHint = "受管代理需要可达的 Server 地址与管理密钥"
)

// ErrNoCandidates 表示服务端没有任何可用出口（不是传输失败）。
var ErrNoCandidates = errors.New("没有可用的受管代理出口")

// Config 描述管理面连接。凭据来源由调用方决定，本包不读环境变量。
type Config struct {
	BaseURL       string
	ManagementKey string
	// HTTPClient 为空时使用带超时的默认客户端；测试可替换。
	HTTPClient interface {
		Do(*http.Request) (*http.Response, error)
	}
}

// Candidate 是代理候选快照项。
type Candidate struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Source    string `json:"source"`
	Available bool   `json:"available"`
	Error     string `json:"error,omitempty"`
}

// Lease 是原始租约：ProxyURL 内含只对 Server 入口有效的凭据。
type Lease struct {
	ID       string
	Name     string
	ProxyURL string
}

// Client 访问一个 Server 的管理面代理接口。
type Client struct {
	baseURL string
	key     string
	api     interface {
		Do(*http.Request) (*http.Response, error)
	}
	streams *http.Client
}

// New 校验管理面地址与密钥；密钥缺失时失败，绝不静默改走直连。
func New(config Config) (*Client, error) {
	base := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	key := strings.TrimSpace(config.ManagementKey)
	parsed, err := url.Parse(base)
	if err != nil || parsed == nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("受管代理需要有效的管理面地址；%s", ProviderProxyUnavailableHint)
	}
	if key == "" {
		return nil, fmt.Errorf("受管代理需要管理密钥；%s", ProviderProxyUnavailableHint)
	}
	api := config.HTTPClient
	if api == nil {
		api = &http.Client{Timeout: callTimeout}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// Upgrade 是 HTTP/1.1；不改变 TLS 校验或信任链。
	transport.ForceAttemptHTTP2 = false
	transport.TLSNextProto = make(map[string]func(string, *tls.Conn) http.RoundTripper)
	if transport.TLSClientConfig == nil {
		transport.TLSClientConfig = &tls.Config{}
	} else {
		transport.TLSClientConfig = transport.TLSClientConfig.Clone()
	}
	transport.TLSClientConfig.NextProtos = []string{"http/1.1"}
	transport.ResponseHeaderTimeout = callTimeout
	return &Client{
		baseURL: base,
		key:     key,
		api:     api,
		streams: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}, nil
}

// Candidates 返回服务端排序后的候选快照。
func (client *Client) Candidates(ctx context.Context) ([]Candidate, error) {
	var snapshot struct {
		OK         bool        `json:"ok"`
		Candidates []Candidate `json:"candidates"`
	}
	if err := client.call(ctx, http.MethodGet, candidatesPath, nil, &snapshot); err != nil {
		return nil, err
	}
	if !snapshot.OK {
		return nil, errors.New("代理候选快照不可用")
	}
	return snapshot.Candidates, nil
}

// AvailableIDs 按服务端顺序返回可用候选的稳定 ID。轮换只走这条顺序。
func (client *Client) AvailableIDs(ctx context.Context) ([]string, error) {
	candidates, err := client.Candidates(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.Available && candidate.ID != "" {
			ids = append(ids, candidate.ID)
		}
	}
	if len(ids) == 0 {
		return nil, ErrNoCandidates
	}
	return ids, nil
}

// Resolve 把一个选择器（auto/pool/稳定 ID/唯一名称）归一成稳定 ID。
// 名称歧义或不可用时明确失败，绝不静默换成另一个出口。
func (client *Client) Resolve(ctx context.Context, selector string) (string, error) {
	selector = strings.TrimSpace(selector)
	if selector == "" || selector == "auto" || selector == "pool" {
		return selector, nil
	}
	candidates, err := client.Candidates(ctx)
	if err != nil {
		return "", err
	}
	var named []Candidate
	for _, candidate := range candidates {
		if candidate.ID == selector {
			if !candidate.Available {
				return "", errors.New("所选代理不可用；不会回落直连")
			}
			return candidate.ID, nil
		}
		if candidate.Name == selector {
			named = append(named, candidate)
		}
	}
	if len(named) != 1 {
		return "", errors.New("代理名称不存在或不唯一；请使用补全给出的稳定 ID")
	}
	if !named[0].Available {
		return "", errors.New("所选代理不可用；不会回落直连")
	}
	return named[0].ID, nil
}

// Lease 申请一个原始租约；调用方负责 Connect/Release。
func (client *Client) Lease(ctx context.Context, selector string) (Lease, error) {
	resolved, err := client.Resolve(ctx, selector)
	if err != nil {
		return Lease{}, err
	}
	var response struct {
		OK       bool   `json:"ok"`
		ID       string `json:"id"`
		Name     string `json:"name"`
		ProxyURL string `json:"proxyUrl"`
	}
	if err := client.call(ctx, http.MethodPost, leasesPath, map[string]string{"selector": resolved}, &response); err != nil {
		return Lease{}, err
	}
	if !response.OK || response.ID == "" || len(response.ID) > 256 || strings.ContainsAny(response.ID, "/\\\r\n\x00") {
		return Lease{}, errors.New("代理 lease 响应无效")
	}
	return Lease{ID: response.ID, Name: response.Name, ProxyURL: response.ProxyURL}, nil
}

// Acquire 申请租约并在本机建立只监听 loopback 的认证 HTTP 入口。
//
// 入口凭据沿用租约令牌；管理密钥不会进入安装器环境或代理数据。
func (client *Client) Acquire(ctx context.Context, selector string) (updateproxy.EgressLease, error) {
	lease, err := client.Lease(ctx, selector)
	if err != nil {
		return updateproxy.EgressLease{}, err
	}
	credentials, err := lease.credentials()
	if err != nil {
		client.Release(lease.ID)
		return updateproxy.EgressLease{}, err
	}
	dial := func(dialCtx context.Context) (io.ReadWriteCloser, error) { return client.Connect(dialCtx, lease.ID) }
	ingress, err := proxyingress.Start(ctx, proxyingress.Config{
		Credentials: credentials,
		HTTP:        true,
		Dial:        dial,
	})
	if err != nil {
		client.Release(lease.ID)
		return updateproxy.EgressLease{}, errors.New("无法建立本机代理入口")
	}
	// 第二个入口：loopback、匿名。给那些把代理 URL 里的 userinfo 丢掉、
	// 又不支持显式凭据的客户端（winget 已实测）。上游仍用租约令牌认证。
	anonymous, err := proxyingress.Start(ctx, proxyingress.Config{
		Credentials:    credentials,
		HTTP:           true,
		AllowAnonymous: true,
		Dial:           dial,
	})
	if err != nil {
		_ = ingress.Close()
		client.Release(lease.ID)
		return updateproxy.EgressLease{}, errors.New("无法建立本机匿名代理入口")
	}
	once := false
	release := func() {
		if once {
			return
		}
		once = true
		_ = ingress.Close()
		_ = anonymous.Close()
		client.Release(lease.ID)
	}
	return updateproxy.EgressLease{
		URL:          ingress.HTTPURL(),
		// 匿名入口必须给**不带 userinfo** 的地址：winget 的 --proxy 会把
		// userinfo 原样塞进请求，代理侧看到 Basic 头后按凭据校验，而它给的是
		// 我们自己的租约令牌——匿名入口不校验凭据，但带着 userinfo 的 URL 会
		// 让客户端误以为需要认证。用裸 host:port 最干净。
		AnonymousURL: "http://" + anonymous.HTTPAddress(),
		Name:         lease.Name,
		Release:      release,
	}, nil
}

// Rotation 把本客户端装成 updateproxy 的轮换状态机。
func (client *Client) Rotation(notify updateproxy.EgressNotifier) *updateproxy.EgressRotation {
	return updateproxy.NewEgressRotation(client.AvailableIDs, client.Acquire, notify)
}

func (lease Lease) credentials() (proxyingress.Credentials, error) {
	endpoint, err := url.Parse(lease.ProxyURL)
	if err != nil || endpoint == nil || endpoint.Scheme != "http" || endpoint.User == nil {
		return proxyingress.Credentials{}, errors.New("代理 lease 未返回有效的认证入口")
	}
	password, hasPassword := endpoint.User.Password()
	if endpoint.User.Username() == "" || !hasPassword || password == "" {
		return proxyingress.Credentials{}, errors.New("代理 lease 未返回有效的认证入口")
	}
	return proxyingress.Credentials{Username: endpoint.User.Username(), Password: password}, nil
}

// Release 释放远端租约；任务上下文已取消时也要能完成。
func (client *Client) Release(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = client.call(ctx, http.MethodDelete, leasesPath+"/"+url.PathEscape(id), nil, nil)
}

// Renew 延长仍然存在的租约。
func (client *Client) Renew(ctx context.Context, id string) error {
	return client.call(ctx, http.MethodPost, leasesPath+"/"+url.PathEscape(id)+"/renew", map[string]any{}, nil)
}

// Connect 建立管理面 Upgrade 原始流；每条流在 Server 上落到租约出口。
func (client *Client) Connect(ctx context.Context, id string) (io.ReadWriteCloser, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, client.baseURL+leasesPath+"/"+url.PathEscape(id)+"/connect", nil)
	if err != nil {
		return nil, errors.New("无法创建代理连接")
	}
	request.Header.Set("Authorization", "Bearer "+client.key)
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", upgradeToken)
	response, err := client.streams.Do(request)
	if err != nil {
		return nil, errors.New("代理管理 Upgrade 连接失败")
	}
	stream, ok := response.Body.(io.ReadWriteCloser)
	if response.StatusCode != http.StatusSwitchingProtocols || !strings.EqualFold(response.Header.Get("Upgrade"), upgradeToken) || !ok {
		response.Body.Close()
		return nil, errors.New("代理管理 Upgrade 被拒绝")
	}
	return stream, nil
}

// call 只返回不含凭据的错误：响应体、URL 与传输错误都可能带入密钥。
func (client *Client) call(ctx context.Context, method, path string, payload, result any) error {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	var body []byte
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return errors.New("无法编码代理管理请求")
		}
		body = encoded
	}
	request, err := http.NewRequestWithContext(ctx, method, client.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return errors.New("无法创建代理管理请求")
	}
	request.Header.Set("Authorization", "Bearer "+client.key)
	request.Header.Set("Accept", "application/json")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.api.Do(request)
	if err != nil {
		return fmt.Errorf("代理管理请求失败；%s", ProviderProxyUnavailableHint)
	}
	if response == nil || response.Body == nil {
		return errors.New("代理管理响应无效")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("代理管理 API 返回 HTTP %d", response.StatusCode)
	}
	if result == nil {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxBodyBytes+1))
	if err != nil || len(data) > maxBodyBytes || json.Unmarshal(data, result) != nil {
		return errors.New("代理管理响应无效或过大")
	}
	return nil
}
