// Package plugincontrolclient 是 Node 插件内部发布协议（prepare/activate/discard）的 HTTP 适配器。
//
// 这些端点只存在于 Node 的回环管理面：BaseURL 必须是 loopback，调用必须带管理密钥。
// Go 只做传输与错误码映射；候选语义（configSchema、权限、默认值）仍由 Node 计算。
package plugincontrolclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/plugincontrol"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

const (
	preparePath  = "/v0/plugins/internal/prepare"
	activatePath = "/v0/plugins/internal/activate"
	discardPath  = "/v0/plugins/internal/discard"
	// maxResponseBytes 覆盖 4MB 候选文档与 JSON 包装。
	maxResponseBytes = 8 << 20
	defaultTimeout   = 60 * time.Second
)

// Options 是内部客户端的最小配置。
type Options struct {
	BaseURL       string
	ManagementKey func() string
	HTTPClient    *http.Client
	Timeout       time.Duration
}

// Client 调用 Node 的内部发布协议。
type Client struct {
	baseURL       string
	managementKey func() string
	httpClient    *http.Client
	timeout       time.Duration
}

// New 创建客户端；BaseURL 必须是 loopback，避免把管理密钥发到远端。
func New(options Options) (*Client, error) {
	baseURL := strings.TrimSpace(options.BaseURL)
	if baseURL == "" || options.ManagementKey == nil {
		return nil, errors.New("插件内部客户端缺少 Node 地址或管理密钥")
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" {
		return nil, errors.New("插件内部客户端只接受 http loopback 地址")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("插件内部客户端地址不得包含凭据、查询或片段")
	}
	host := parsed.Hostname()
	if !isLoopbackHost(host) {
		return nil, errors.New("插件内部客户端只接受 loopback 地址")
	}
	// 不跟随重定向：管理密钥只允许发给 supervisor 注入的 loopback 地址，而 New 阶段
	// 校验的只是初始地址。重定向会把 Authorization 带到另一个端点，因此无论是否注入
	// 客户端都必须关闭跳转。复用注入客户端的 Transport 以保留其连接池配置，但不复制
	// 它的自动跳转策略，也不修改调用方传入的实例。
	httpClient := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	if options.HTTPClient != nil {
		httpClient.Transport = options.HTTPClient.Transport
		httpClient.Timeout = options.HTTPClient.Timeout
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	return &Client{
		baseURL:       strings.TrimRight(parsed.Scheme+"://"+parsed.Host+parsed.Path, "/"),
		managementKey: options.ManagementKey,
		httpClient:    httpClient,
		timeout:       timeout,
	}, nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

type preparePayload struct {
	Operation        string          `json:"operation"`
	ExpectedRevision int64           `json:"expectedRevision"`
	Input            json.RawMessage `json:"input"`
}

type activatePayload struct {
	Ticket   string `json:"ticket"`
	Revision int64  `json:"revision"`
}

type discardPayload struct {
	Ticket string `json:"ticket"`
	Reason string `json:"reason"`
}

type envelope struct {
	OK            bool              `json:"ok"`
	Ticket        string            `json:"ticket"`
	Generation    int64             `json:"generation"`
	Candidate     json.RawMessage   `json:"candidate"`
	Contributions []json.RawMessage `json:"contributions"`
	Revision      int64             `json:"revision"`
	State         string            `json:"state"`
	Error         string            `json:"error"`
	Message       string            `json:"message"`
	Diagnostics   []any             `json:"diagnostics"`
}

// Prepare 让 Node 校验配置/权限并准备候选代次；不会提交状态。
func (client *Client) Prepare(ctx context.Context, request plugincontrol.PrepareRequest) (plugincontrol.PreparedCandidate, error) {
	var response envelope
	if err := client.post(ctx, preparePath, preparePayload{
		Operation:        string(request.Operation),
		ExpectedRevision: request.ExpectedRevision,
		Input:            request.Input,
	}, &response); err != nil {
		return plugincontrol.PreparedCandidate{}, err
	}
	if !response.OK {
		return plugincontrol.PreparedCandidate{}, responseError(response, "Node 插件 prepare 失败")
	}
	if strings.TrimSpace(response.Ticket) == "" || len(response.Candidate) == 0 || !json.Valid(response.Candidate) {
		return plugincontrol.PreparedCandidate{}, pluginerr.New(plugincontrol.CodeStateUnavailable, "Node 返回的发布票据或候选无效")
	}
	return plugincontrol.PreparedCandidate{
		Ticket:        response.Ticket,
		Generation:    response.Generation,
		Candidate:     response.Candidate,
		Contributions: response.Contributions,
	}, nil
}

// Activate 让 Node 激活已提交的候选代次。
func (client *Client) Activate(ctx context.Context, ticket string, revision int64) (plugincontrol.ActivationResult, error) {
	var response envelope
	if err := client.post(ctx, activatePath, activatePayload{Ticket: ticket, Revision: revision}, &response); err != nil {
		return plugincontrol.ActivationResult{}, err
	}
	if !response.OK {
		return plugincontrol.ActivationResult{}, responseError(response, "Node 插件 activate 失败")
	}
	return plugincontrol.ActivationResult{Generation: response.Generation, State: response.State}, nil
}

// Discard 丢弃候选并释放发布锁；失败由 TTL 兜底。
func (client *Client) Discard(ctx context.Context, ticket string, reason string) error {
	var response envelope
	if err := client.post(ctx, discardPath, discardPayload{Ticket: ticket, Reason: reason}, &response); err != nil {
		return err
	}
	if !response.OK {
		return responseError(response, "Node 插件 discard 失败")
	}
	return nil
}

func (client *Client) post(ctx context.Context, path string, payload any, target *envelope) error {
	if client == nil {
		return pluginerr.New(plugincontrol.CodeRuntimeUnavailable, "插件内部客户端未装配")
	}
	key := strings.TrimSpace(client.managementKey())
	if key == "" {
		return pluginerr.New(plugincontrol.CodeRuntimeUnavailable, "管理密钥不可用")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return pluginerr.New(plugincontrol.CodeRuntimeUnavailable, err.Error())
	}
	requestCtx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, client.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return pluginerr.New(plugincontrol.CodeRuntimeUnavailable, err.Error())
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+key)
	response, err := client.httpClient.Do(request)
	if err != nil {
		return pluginerr.New(plugincontrol.CodeRuntimeUnavailable, err.Error())
	}
	defer func() { _ = response.Body.Close() }()
	document, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return pluginerr.New(plugincontrol.CodeRuntimeUnavailable, err.Error())
	}
	if len(document) > maxResponseBytes {
		return pluginerr.New(plugincontrol.CodeRuntimeUnavailable, "Node 插件内部响应过大")
	}
	if len(document) == 0 {
		return pluginerr.New(plugincontrol.CodeRuntimeUnavailable, fmt.Sprintf("Node 插件内部接口返回 HTTP %d", response.StatusCode))
	}
	if err := json.Unmarshal(document, target); err != nil {
		return pluginerr.New(plugincontrol.CodeRuntimeUnavailable, "Node 插件内部响应不是合法 JSON")
	}
	if response.StatusCode == http.StatusOK {
		return nil
	}
	if strings.TrimSpace(target.Error) == "" {
		target.Error = plugincontrol.CodeRuntimeUnavailable
		target.Message = fmt.Sprintf("Node 插件内部接口返回 HTTP %d", response.StatusCode)
	}
	return nil
}

func responseError(response envelope, fallback string) error {
	code := strings.TrimSpace(response.Error)
	if code == "" {
		code = plugincontrol.CodeRuntimeUnavailable
	}
	message := strings.TrimSpace(response.Message)
	if message == "" {
		message = fallback
	}
	coded := pluginerr.New(code, message)
	coded.Diagnostics = response.Diagnostics
	return coded
}
