package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const providerProxyUpgrade = "aih-proxy"
const providerProxyAPI = "/v1/management/proxy-leases"

type providerProxyClient struct {
	baseURL string
	key     string
	http    interface {
		Do(*http.Request) (*http.Response, error)
	}
	streams *http.Client
}

type providerProxyCandidate struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Available bool   `json:"available"`
}

func newProviderProxyClient(runtime commandRuntime) (*providerProxyClient, error) {
	// Reuse the existing management factory's URL/key validation and env contract.
	if _, err := newAccountManagementClient(runtime); err != nil {
		return nil, fmt.Errorf("命名代理需要有效的 AIH_SERVER_BASE_URL 和 AIH_SERVER_MANAGEMENT_KEY")
	}
	key, _ := runtime.lookupEnv("AIH_SERVER_MANAGEMENT_KEY")
	transport := http.DefaultTransport.(*http.Transport).Clone()
	api := runtime.managementAPI
	if client, ok := api.(*http.Client); ok {
		clone := *client
		clone.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
		api = &clone
		if existing, ok := client.Transport.(*http.Transport); ok {
			transport = existing.Clone()
		}
	}
	// HTTP Upgrade is HTTP/1.1. Keep standard TLS verification/trust unchanged.
	transport.ForceAttemptHTTP2 = false
	transport.TLSNextProto = make(map[string]func(string, *tls.Conn) http.RoundTripper)
	if transport.TLSClientConfig == nil {
		transport.TLSClientConfig = &tls.Config{}
	} else {
		transport.TLSClientConfig = transport.TLSClientConfig.Clone()
	}
	transport.TLSClientConfig.NextProtos = []string{"http/1.1"}
	transport.ResponseHeaderTimeout = 10 * time.Second
	return &providerProxyClient{
		baseURL: strings.TrimRight(resolveManagementBaseURL(runtime), "/"), key: key, http: api,
		streams: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}, nil
}

// Never echo API bodies, URLs or transport errors: these can contain credentials.
func (client *providerProxyClient) call(ctx context.Context, method, path string, payload, result any) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var body []byte
	if payload != nil {
		var err error
		body, err = json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("无法编码代理管理请求")
		}
	}
	request, err := http.NewRequestWithContext(ctx, method, client.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("无法创建代理管理请求")
	}
	request.Header.Set("Authorization", "Bearer "+client.key)
	request.Header.Set("Accept", "application/json")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.http.Do(request)
	if err != nil {
		return fmt.Errorf("代理管理请求失败；请检查 Server 连接和管理认证")
	}
	if response == nil || response.Body == nil {
		return fmt.Errorf("代理管理响应无效")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("代理管理 API 返回 HTTP %d；不会回落直连", response.StatusCode)
	}
	if result == nil {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 256*1024+1))
	if err != nil || len(data) > 256*1024 || json.Unmarshal(data, result) != nil {
		return fmt.Errorf("代理管理响应无效或过大")
	}
	return nil
}

// Names resolve to a stable ID from the read-only catalog. Ambiguous or
// unavailable labels fail explicitly rather than silently choosing another node.
func (client *providerProxyClient) selector(ctx context.Context, value string) (string, error) {
	if value == "auto" || value == "pool" {
		return value, nil
	}
	var snapshot struct {
		OK         bool                     `json:"ok"`
		Candidates []providerProxyCandidate `json:"candidates"`
	}
	if err := client.call(ctx, http.MethodGet, "/v1/management/proxy-candidates", nil, &snapshot); err != nil {
		return "", err
	}
	if !snapshot.OK {
		return "", fmt.Errorf("代理候选快照不可用")
	}
	for _, candidate := range snapshot.Candidates {
		if candidate.ID == value {
			if !candidate.Available {
				return "", fmt.Errorf("所选代理不可用；不会回落直连")
			}
			return candidate.ID, nil
		}
	}
	var matches []providerProxyCandidate
	for _, candidate := range snapshot.Candidates {
		if candidate.Name == value {
			matches = append(matches, candidate)
		}
	}
	if len(matches) != 1 {
		return "", fmt.Errorf("代理名称不存在或不唯一；请使用补全给出的稳定 ID")
	}
	if !matches[0].Available {
		return "", fmt.Errorf("所选代理不可用；不会回落直连")
	}
	return matches[0].ID, nil
}

func (client *providerProxyClient) connect(ctx context.Context, id string) (io.ReadWriteCloser, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, client.baseURL+providerProxyAPI+"/"+url.PathEscape(id)+"/connect", nil)
	if err != nil {
		return nil, fmt.Errorf("无法创建代理连接")
	}
	request.Header.Set("Authorization", "Bearer "+client.key)
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", providerProxyUpgrade)
	response, err := client.streams.Do(request)
	if err != nil {
		return nil, fmt.Errorf("代理管理 Upgrade 连接失败")
	}
	stream, ok := response.Body.(io.ReadWriteCloser)
	if response.StatusCode != http.StatusSwitchingProtocols || !strings.EqualFold(response.Header.Get("Upgrade"), providerProxyUpgrade) || !ok {
		response.Body.Close()
		return nil, fmt.Errorf("代理管理 Upgrade 被拒绝")
	}
	return stream, nil
}

type providerProxyLease struct {
	URL     string
	Name    string
	id      string
	client  *providerProxyClient
	ingress *providerProxyIngress
}

func acquireProviderProxy(ctx context.Context, runtime commandRuntime, value string) (*providerProxyLease, error) {
	client, err := newProviderProxyClient(runtime)
	if err != nil {
		return nil, err
	}
	selector, err := client.selector(ctx, value)
	if err != nil {
		return nil, err
	}
	var response struct {
		OK       bool   `json:"ok"`
		ID       string `json:"id"`
		Name     string `json:"name"`
		ProxyURL string `json:"proxyUrl"`
	}
	if err := client.call(ctx, http.MethodPost, providerProxyAPI, map[string]string{"selector": selector}, &response); err != nil {
		return nil, err
	}
	if !response.OK || response.ID == "" || len(response.ID) > 256 || strings.ContainsAny(response.ID, "/\\\r\n\x00") {
		return nil, fmt.Errorf("代理 lease 响应无效")
	}
	lease := &providerProxyLease{id: response.ID, Name: response.Name, client: client}
	// Keep the lease credentials, never its server-local host/port. The server
	// proxy authenticates Proxy-Authorization inside the raw Upgrade stream.
	proxy, parseErr := url.Parse(response.ProxyURL)
	if parseErr != nil || proxy == nil || proxy.Scheme != "http" || proxy.User == nil || proxy.User.Username() == "" {
		return nil, lease.abort("代理 lease 未返回有效的认证入口")
	}
	if password, ok := proxy.User.Password(); !ok || password == "" {
		return nil, lease.abort("代理 lease 未返回有效的认证入口")
	}
	lease.ingress, err = newProviderProxyIngress(ctx, proxy.User, func(ctx context.Context) (io.ReadWriteCloser, error) { return client.connect(ctx, lease.id) })
	if err != nil {
		return nil, lease.abort("无法建立本机任务代理入口")
	}
	lease.URL = lease.ingress.URL
	return lease, nil
}

func (lease *providerProxyLease) Close() error {
	if lease.ingress != nil {
		lease.ingress.Close()
	}
	defer lease.client.streams.CloseIdleConnections()
	// A canceled install context must not cancel lease release.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := lease.client.call(ctx, http.MethodDelete, providerProxyAPI+"/"+url.PathEscape(lease.id), nil, nil); err != nil {
		return fmt.Errorf("任务代理已关闭，但 lease 释放失败；Server 将在 3 小时到期时清理")
	}
	return nil
}

func (lease *providerProxyLease) abort(message string) error {
	if err := lease.Close(); err != nil {
		return fmt.Errorf("%s；%s", message, err)
	}
	return fmt.Errorf("%s", message)
}
