package accountactivity

// Node 执行桥：Go 负责排队/限速/状态，provider handler 仍在 Node 运行时执行。
//
// 为什么保留 Node 执行：zcode 的领取需要本机 Chrome 过无痕验证码、qoder 需要 CLI
// 设备指纹、workbuddy 的凭据与 UA 处理都在 Node 的 activity-claim 模块里。把这三套
// handler 重写成 Go 之前，先让**数据面与并发控制**迁到 Go，执行走一条窄的内部桥。
//
// 协议：POST <node>/v0/internal/account-activity/claim
//   请求 {provider, accountRef, actionId, params, dryRun}
//   成功 200 {ok:true, result:{...}}；账号不存在 404 {ok:false, error:"account_not_found"}
// Node 侧只接受回环 + Go Core 的管理密钥（见 webui-account-activity-routes.js），
// 浏览器与外部地址都进不来。

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// InternalClaimPath 是 Node 内部执行端点的固定路径。
const InternalClaimPath = "/v0/internal/account-activity/claim"

// NodeBridge 通过回环 HTTP 调用 Node 的领取执行器。
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
	// HTTPClient 可替换（测试/组合根）；为空时用 180s 超时的默认客户端。
	HTTPClient *http.Client
}

// NewNodeBridge 创建执行桥；baseURL 为空时返回 nil（活动执行会明确失败，
// 而不是静默使用另一个执行器）。
func NewNodeBridge(options NodeBridgeOptions) *NodeBridge {
	baseURL := strings.TrimRight(strings.TrimSpace(options.BaseURL), "/")
	if baseURL == "" {
		return nil
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: JobExecutionTimeout}
	}
	return &NodeBridge{baseURL: baseURL, managementKey: options.ManagementKey, client: client}
}

type bridgeRequest struct {
	Provider   string         `json:"provider"`
	AccountRef string         `json:"accountRef"`
	ActionID   string         `json:"actionId"`
	Params     map[string]any `json:"params,omitempty"`
	DryRun     bool           `json:"dryRun"`
}

type bridgeResponse struct {
	OK     bool           `json:"ok"`
	Result map[string]any `json:"result"`
	Error  string         `json:"error"`
}

// Execute 调用 Node 执行单账号动作。
func (bridge *NodeBridge) Execute(ctx context.Context, request ExecutionRequest) (map[string]any, error) {
	if bridge == nil {
		return nil, ErrExecutorUnavailable
	}
	payload, err := json.Marshal(bridgeRequest{
		Provider:   request.Provider,
		AccountRef: request.AccountRef,
		ActionID:   request.ActionID,
		Params:     request.Params,
		DryRun:     request.DryRun,
	})
	if err != nil {
		return nil, fmt.Errorf("activity_bridge_encode_failed: %w", err)
	}
	httpRequest, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		bridge.baseURL+InternalClaimPath,
		bytes.NewReader(payload),
	)
	if err != nil {
		return nil, fmt.Errorf("activity_bridge_request_failed: %w", err)
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	if bridge.managementKey != nil {
		if key := strings.TrimSpace(bridge.managementKey()); key != "" {
			httpRequest.Header.Set("Authorization", "Bearer "+key)
		}
	}
	response, err := bridge.client.Do(httpRequest)
	if err != nil {
		return nil, fmt.Errorf("activity_bridge_unreachable: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	var decoded bridgeResponse
	decodeError := json.NewDecoder(response.Body).Decode(&decoded)
	if response.StatusCode == http.StatusNotFound && decodeError == nil && decoded.Error != "" {
		// 账号在 Node 凭据库里不存在：这是业务结果，按失败结果返回给任务。
		return map[string]any{
			"provider":   request.Provider,
			"accountRef": request.AccountRef,
			"actionId":   request.ActionID,
			"status":     StatusError,
			"error":      decoded.Error,
		}, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if decodeError == nil && decoded.Error != "" {
			return nil, fmt.Errorf("activity_bridge_failed: %s", decoded.Error)
		}
		return nil, fmt.Errorf("activity_bridge_failed: http_%d", response.StatusCode)
	}
	if decodeError != nil {
		return nil, fmt.Errorf("activity_bridge_decode_failed: %w", decodeError)
	}
	if decoded.Result == nil {
		return nil, fmt.Errorf("activity_bridge_empty_result")
	}
	return decoded.Result, nil
}

var _ Executor = (*NodeBridge)(nil)
