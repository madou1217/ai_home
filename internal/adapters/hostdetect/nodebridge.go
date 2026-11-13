// Package hostdetect 是「本机账号扫描」的 Node 宿主能力桥。
//
// 为什么扫描仍走 Node：CodeBuddy 家族的 .info 是 sym-v1 加密信封，解密密钥在厂商
// Electron 运行时里；桌面端凭据还要扫 state.vscdb 与登录 shell 环境。这些是宿主
// 能力而不是 HTTP 协议层，Go 侧没有等价实现。Go 承接管理路由、鉴权与响应契约，
// 执行通过回环内部端点完成（与账号活动的 provider 执行桥同一形态）。
//
// 协议：POST <node>/v0/internal/accounts/detect
//
//	Node 只接受回环 + Go Core 引导密钥；成功 200/整体不可用 500，响应体原样透传。
package hostdetect

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// InternalDetectPath 是 Node 内部扫描端点的固定路径。
const InternalDetectPath = "/v0/internal/accounts/detect"

// maxResponseBytes 限制内部响应体，避免异常扫描结果把内存打满。
const maxResponseBytes = 1 << 20

// NodeBridge 通过回环 HTTP 调用 Node 的宿主扫描器。
type NodeBridge struct {
	baseURL       string
	managementKey func() string
	client        *http.Client
}

// NodeBridgeOptions 是桥的装配参数。
type NodeBridgeOptions struct {
	// BaseURL 是 Node 宿主回环地址（由 Go Core 监督器注入）。
	BaseURL string
	// ManagementKey 返回 Go Core 自己的引导密钥；Node 用它对内部回调鉴权。
	ManagementKey func() string
	// HTTPClient 可替换（测试/组合根）；空值时用 120s 超时的默认客户端。
	HTTPClient *http.Client
}

// NewNodeBridge 创建执行桥；baseURL 为空时返回 nil（路由会明确 503）。
func NewNodeBridge(options NodeBridgeOptions) *NodeBridge {
	baseURL := strings.TrimRight(strings.TrimSpace(options.BaseURL), "/")
	if baseURL == "" {
		return nil
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 120 * time.Second}
	}
	return &NodeBridge{baseURL: baseURL, managementKey: options.ManagementKey, client: client}
}

// Detect 调用 Node 执行一次完整扫描。
func (bridge *NodeBridge) Detect(ctx context.Context) (int, []byte, error) {
	if bridge == nil {
		return 0, nil, fmt.Errorf("account_detect_bridge_unavailable")
	}
	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost, bridge.baseURL+InternalDetectPath, bytes.NewReader([]byte("{}")),
	)
	if err != nil {
		return 0, nil, fmt.Errorf("account_detect_bridge_request_failed: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	if bridge.managementKey != nil {
		if key := strings.TrimSpace(bridge.managementKey()); key != "" {
			request.Header.Set("Authorization", "Bearer "+key)
		}
	}
	response, err := bridge.client.Do(request)
	if err != nil {
		return 0, nil, fmt.Errorf("account_detect_bridge_unreachable: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes))
	if err != nil {
		return 0, nil, fmt.Errorf("account_detect_bridge_read_failed: %w", err)
	}
	if !json.Valid(body) {
		return 0, nil, fmt.Errorf("account_detect_bridge_invalid_json")
	}
	return response.StatusCode, body, nil
}
