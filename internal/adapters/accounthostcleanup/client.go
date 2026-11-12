// Package accounthostcleanup 是 Node 宿主清理契约（账号删除前后回调）的 HTTP 适配器。
//
// Go 的删除事务只掌握 aih.db 与账号投影；tmux 持久会话、账号 socket 这些宿主
// 资源只有 Node 有完整语义（matrix §5.3 的明确缺口）。本适配器只做传输与错误
// 分类，真正的清理语义仍在 Node 的 account-host-cleanup.js。
//
// 边界：BaseURL 必须是回环、请求必须带管理密钥；清理是账号私有资源上的破坏性
// 动作，管理密钥绝不能发到远端。
package accounthostcleanup

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

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// cleanupPath 与 Node 的 account-host-cleanup-routes.js 保持同一落点。
	cleanupPath = "/v0/management/internal/account-host-cleanup"
	// maxResponseBytes 覆盖 409 时的占用者清单；清理结果只有 sockets/sessions。
	maxResponseBytes = 256 * 1024
	defaultTimeout   = 10 * time.Second
)

// hostCleanupProviders 是「删除必须回调 Node 清理宿主」的 Provider 注册表。
//
// 表驱动而不是按 Provider 名分支：新增一家只加一行，删除主流程不需要再被打开。
// 当前只登记 CodeBuddy 家族四支（codebuddy / codebuddycn / workbuddy /
// workbuddycn）：其余已接入 Go 删除的 Provider 还有各自的宿主清理缺口，
// 在补完之前保持原语义，不扩大这次改动的爆炸半径。
var hostCleanupProviders = map[string]struct{}{
	"codebuddy":   {},
	"codebuddycn": {},
	"workbuddy":   {},
	"workbuddycn": {},
}

// CoversProvider 判断某个 Provider 是否已接入宿主清理回调。
func CoversProvider(providerID string) bool {
	_, found := hostCleanupProviders[strings.ToLower(strings.TrimSpace(providerID))]
	return found
}

// Options 是内部客户端的最小配置。
type Options struct {
	BaseURL       string
	ManagementKey func() string
	// NodeAccountRef 把 Go 账号引用翻成 Node 账号引用。
	//
	// 两侧引用不是同一个值：Node 是账号写入口，经 go-account-sync 推给 Go 后
	// Go 会派生自己的 account_ref（静态账号的身份是密钥 + base_url）。Node 的
	// 持久会话登记按 Node 引用落盘，传错引用会让 verify 查不到会话、cleanup
	// 删不到 socket——表面上成功，实际留下攥着已删凭据的 tmux 服务端。
	NodeAccountRef func(ctx context.Context, goRef string) (string, error)
	HTTPClient     *http.Client
	Timeout        time.Duration
}

// Client 调用 Node 的账号宿主清理契约。
type Client struct {
	baseURL        string
	managementKey  func() string
	nodeAccountRef func(ctx context.Context, goRef string) (string, error)
	httpClient     *http.Client
	timeout        time.Duration
}

// New 创建客户端；BaseURL 必须是 loopback，避免把管理密钥发到远端。
func New(options Options) (*Client, error) {
	baseURL := strings.TrimSpace(options.BaseURL)
	if baseURL == "" || options.ManagementKey == nil || options.NodeAccountRef == nil {
		return nil, errors.New("宿主清理客户端缺少 Node 地址、管理密钥或账号引用翻译")
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" {
		return nil, errors.New("宿主清理客户端只接受 http loopback 地址")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("宿主清理客户端地址不得包含凭据、查询或片段")
	}
	if !isLoopbackHost(parsed.Hostname()) {
		return nil, errors.New("宿主清理客户端只接受 loopback 地址")
	}
	httpClient := options.HTTPClient
	if httpClient == nil {
		// 不跟随重定向：管理密钥只允许发给 supervisor 注入的 loopback 地址。
		httpClient = &http.Client{
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	return &Client{
		baseURL:        strings.TrimRight(parsed.Scheme+"://"+parsed.Host+parsed.Path, "/"),
		managementKey:  options.ManagementKey,
		nodeAccountRef: options.NodeAccountRef,
		httpClient:     httpClient,
		timeout:        timeout,
	}, nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

type cleanupPayload struct {
	Provider   string `json:"provider"`
	AccountRef string `json:"accountRef"`
	Phase      string `json:"phase"`
}

type blockerView struct {
	Session string `json:"session"`
	Socket  string `json:"socket"`
}

type resultView struct {
	Socket   string   `json:"socket"`
	Action   string   `json:"action"`
	Sessions []string `json:"sessions"`
}

type envelope struct {
	OK       bool          `json:"ok"`
	Error    string        `json:"error"`
	Message  string        `json:"message"`
	Reaped   int           `json:"reaped"`
	Degraded bool          `json:"degraded"`
	Blockers []blockerView `json:"blockers"`
	Results  []resultView  `json:"results"`
}

// BeforeDelete 在提交删除前确认宿主没有仍持有凭据的写入者。
//
// 未登记的 Provider 直接放行（不产生任何网络调用）；登记了但通道不可用时
// 返回错误，让删除失败关闭——否则会留下攥着已删凭据的进程。
func (client *Client) BeforeDelete(
	ctx context.Context,
	account accountcore.Account,
) error {
	if client == nil || ctx == nil || !account.IsValid() {
		return fmt.Errorf("%w: 请求无效", accountapp.ErrAccountHostCleanupFailed)
	}
	if !CoversProvider(account.ProviderID()) {
		return nil
	}
	payload, err := client.payloadFor(ctx, account, "verify")
	if err != nil {
		return err
	}
	var response envelope
	status, err := client.post(ctx, payload, &response)
	if err != nil {
		return err
	}
	if status == http.StatusOK && response.OK {
		return nil
	}
	return classifyFailure(status, response)
}

// AfterDelete 在账号事实提交后回收宿主残留。
//
// 返回错误只用于诊断：调用方（Deleter）不会把它变成删除失败。实现必须幂等，
// 同一请求可以原样重试。
func (client *Client) AfterDelete(
	ctx context.Context,
	account accountcore.Account,
) error {
	if client == nil || ctx == nil || !account.IsValid() {
		return fmt.Errorf("%w: 请求无效", accountapp.ErrAccountHostCleanupFailed)
	}
	if !CoversProvider(account.ProviderID()) {
		return nil
	}
	payload, err := client.payloadFor(ctx, account, "cleanup")
	if err != nil {
		return err
	}
	var response envelope
	status, err := client.post(ctx, payload, &response)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return classifyFailure(status, response)
	}
	if response.Degraded {
		return fmt.Errorf(
			"%w: %s",
			accountapp.ErrAccountHostCleanupFailed,
			describeFailures(response.Results),
		)
	}
	return nil
}

// payloadFor 把 Go 账号快照翻成 Node 侧的清理请求。
//
// 翻译失败必须失败关闭：用 Go 引用直接去 Node 查，会查不到任何会话与登记，
// 让「有写入者」被误判成「可以删」。
func (client *Client) payloadFor(
	ctx context.Context,
	account accountcore.Account,
	phase string,
) (cleanupPayload, error) {
	nodeRef, err := client.nodeAccountRef(ctx, account.Ref().String())
	if err != nil {
		return cleanupPayload{}, fmt.Errorf(
			"%w: 账号引用翻译失败: %v",
			accountapp.ErrAccountHostCleanupFailed,
			err,
		)
	}
	nodeRef = strings.TrimSpace(nodeRef)
	if nodeRef == "" {
		return cleanupPayload{}, fmt.Errorf(
			"%w: 账号引用翻译为空",
			accountapp.ErrAccountHostCleanupFailed,
		)
	}
	return cleanupPayload{
		Provider:   strings.ToLower(strings.TrimSpace(account.ProviderID())),
		AccountRef: nodeRef,
		Phase:      phase,
	}, nil
}

// classifyFailure 把 Node 的稳定错误收敛成删除用例认识的错误种类。
func classifyFailure(status int, response envelope) error {
	message := strings.TrimSpace(response.Message)
	if message == "" {
		message = strings.TrimSpace(response.Error)
	}
	switch {
	case status == http.StatusConflict:
		return fmt.Errorf("%w: persistent_session", accountapp.ErrAccountRuntimeActive)
	case status == http.StatusServiceUnavailable && response.Error == "account_host_state_unknown":
		return fmt.Errorf("%w: %s", accountapp.ErrAccountRuntimeUnverifiable, message)
	default:
		return fmt.Errorf(
			"%w: HTTP %d %s %s",
			accountapp.ErrAccountHostCleanupFailed,
			status,
			strings.TrimSpace(response.Error),
			message,
		)
	}
}

func describeFailures(results []resultView) string {
	parts := make([]string, 0, len(results))
	for _, row := range results {
		if row.Action != "kill_failed" && row.Action != "skipped_unknown" {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s=%s", row.Socket, row.Action))
	}
	if len(parts) == 0 {
		return "host_residue"
	}
	return strings.Join(parts, ",")
}

func (client *Client) post(
	ctx context.Context,
	payload cleanupPayload,
	target *envelope,
) (int, error) {
	key := strings.TrimSpace(client.managementKey())
	if key == "" {
		return 0, fmt.Errorf("%w: 管理密钥不可用", accountapp.ErrAccountHostCleanupFailed)
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, fmt.Errorf("%w: %v", accountapp.ErrAccountHostCleanupFailed, err)
	}
	requestCtx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(
		requestCtx,
		http.MethodPost,
		client.baseURL+cleanupPath,
		bytes.NewReader(body),
	)
	if err != nil {
		return 0, fmt.Errorf("%w: %v", accountapp.ErrAccountHostCleanupFailed, err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+key)
	response, err := client.httpClient.Do(request)
	if err != nil {
		return 0, fmt.Errorf("%w: %v", accountapp.ErrAccountHostCleanupFailed, err)
	}
	defer func() { _ = response.Body.Close() }()
	document, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return 0, fmt.Errorf("%w: %v", accountapp.ErrAccountHostCleanupFailed, err)
	}
	if len(document) > maxResponseBytes {
		return 0, fmt.Errorf("%w: Node 响应过大", accountapp.ErrAccountHostCleanupFailed)
	}
	if len(document) == 0 {
		return 0, fmt.Errorf(
			"%w: Node 宿主清理接口返回 HTTP %d 且无响应体",
			accountapp.ErrAccountHostCleanupFailed,
			response.StatusCode,
		)
	}
	if err := json.Unmarshal(document, target); err != nil {
		return 0, fmt.Errorf(
			"%w: Node 宿主清理响应不是合法 JSON",
			accountapp.ErrAccountHostCleanupFailed,
		)
	}
	return response.StatusCode, nil
}

var _ accountapp.DeletionHostCleanup = (*Client)(nil)
