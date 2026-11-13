package webuiopenappapi

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

// InternalLaunchPath 是 Node 宿主的内部执行端点。
//
// 为什么启动执行仍由 Node 托管：桌面 App 的 provider 策略（zcode 影子 App、kimi 托管
// 登录、codex API-key profile、agy keychain、窗口/单实例身份）依赖厂商 Electron 运行时
// 与宿主进程句柄，Go 没有等价实现；账号出口（egress）与自动安装器也只在 Node 侧有
// 事实源。Go 承接管理路由、鉴权与启动计划，执行通过回环 + Go Core 引导密钥完成
// （与账号扫描 hostdetect 同一形态）。
const InternalLaunchPath = "/v0/internal/accounts/launch-app"

const maxLaunchResponseBytes = 1 << 20

// HostLauncher 是 webuiopenappapi.Launcher 的生产实现：调用 Node 宿主执行启动计划。
type HostLauncher struct {
	baseURL       string
	managementKey func() string
	client        *http.Client
}

// HostLauncherOptions 是宿主执行器的装配参数。
type HostLauncherOptions struct {
	// BaseURL 是 Node 宿主回环地址；为空时返回 nil（Handler 会按未接入 Launcher 处理）。
	BaseURL string
	// ManagementKey 返回 Go Core 引导密钥；Node 用它对内部回调鉴权。
	ManagementKey func() string
	// HTTPClient 可替换（测试/组合根）；空值时用 120s 超时（桌面冷启动可能较慢）。
	HTTPClient *http.Client
}

// NewHostLauncher 创建宿主执行器。
func NewHostLauncher(options HostLauncherOptions) *HostLauncher {
	baseURL := strings.TrimRight(strings.TrimSpace(options.BaseURL), "/")
	if baseURL == "" {
		return nil
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 120 * time.Second}
	}
	return &HostLauncher{baseURL: baseURL, managementKey: options.ManagementKey, client: client}
}

type launchPayload struct {
	Provider   string `json:"provider"`
	AccountRef string `json:"accountRef"`
	Kind       string `json:"kind"`
	Action     string `json:"action"`
	Harness    string `json:"harness"`
	Model      string `json:"model,omitempty"`
	TerminalID string `json:"terminalId,omitempty"`
	Workdir    string `json:"workdir,omitempty"`
	Transport  string `json:"transport,omitempty"`
	SessionKey string `json:"sessionKey,omitempty"`
}

type launchTargetPayload struct {
	Provider string `json:"provider"`
	Kind     string `json:"kind"`
	AppID    string `json:"appId"`
}

type launchResultPayload struct {
	OK               bool                 `json:"ok"`
	Status           string               `json:"status"`
	PID              *int                 `json:"pid"`
	TerminalID       string               `json:"terminalId"`
	SessionKey       string               `json:"sessionKey"`
	LaunchMode       string               `json:"launchMode"`
	Executable       string               `json:"executable"`
	PIDs             []int                `json:"pids"`
	Error            string               `json:"error"`
	Message          string               `json:"message"`
	Reason           string               `json:"reason"`
	RequiredAction   string               `json:"requiredAction"`
	EgressError      string               `json:"egressError"`
	EgressWarning    string               `json:"egressWarning"`
	InstallRequired  bool                 `json:"installRequired"`
	InstallTarget    *launchTargetPayload `json:"installTarget"`
	InstallAvailable *bool                `json:"installAvailable"`
}

type launchEnvelope struct {
	OK      bool                 `json:"ok"`
	Result  *launchResultPayload `json:"result"`
	Error   string               `json:"error"`
	Message string               `json:"message"`
}

// Launch 把启动计划交给 Node 宿主执行，并把结果还原成 Handler 的 Result。
//
// 任何「宿主不可达 / 拒绝鉴权 / 响应形状不符」都归成 launch_host_unavailable，
// 由 Handler 回 503：调用方应重试，而不是把它当成账号或 Provider 的业务错误。
func (launcher *HostLauncher) Launch(ctx context.Context, request Request) (Result, error) {
	if launcher == nil {
		return Result{}, fmt.Errorf("launch_host_unavailable")
	}
	body, err := json.Marshal(launchPayload{
		Provider:   request.Provider,
		AccountRef: request.AccountRef,
		Kind:       request.Kind,
		Action:     request.Action,
		Harness:    request.Harness,
		Model:      request.Model,
		TerminalID: request.TerminalID,
		Workdir:    request.Workdir,
		Transport:  request.Transport,
		SessionKey: request.SessionKey,
	})
	if err != nil {
		return Result{}, fmt.Errorf("launch_host_request_failed: %w", err)
	}
	httpRequest, err := http.NewRequestWithContext(
		ctx, http.MethodPost, launcher.baseURL+InternalLaunchPath, bytes.NewReader(body),
	)
	if err != nil {
		return Result{}, fmt.Errorf("launch_host_request_failed: %w", err)
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	if launcher.managementKey != nil {
		if key := strings.TrimSpace(launcher.managementKey()); key != "" {
			httpRequest.Header.Set("Authorization", "Bearer "+key)
		}
	}
	response, err := launcher.client.Do(httpRequest)
	if err != nil {
		return unavailableResult("启动宿主不可达: " + err.Error()), nil
	}
	defer func() { _ = response.Body.Close() }()
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxLaunchResponseBytes))
	if err != nil {
		return unavailableResult("读取启动结果失败: " + err.Error()), nil
	}
	if response.StatusCode != http.StatusOK {
		return unavailableResult(launchHostErrorMessage(response.StatusCode, payload)), nil
	}
	var envelope launchEnvelope
	if err := json.Unmarshal(payload, &envelope); err != nil || !envelope.OK || envelope.Result == nil {
		return unavailableResult("启动宿主返回了无法识别的响应"), nil
	}
	return convertLaunchResult(*envelope.Result), nil
}

func unavailableResult(message string) Result {
	return Result{OK: false, Error: "launch_host_unavailable", Message: message}
}

func launchHostErrorMessage(status int, payload []byte) string {
	var envelope launchEnvelope
	if err := json.Unmarshal(payload, &envelope); err == nil {
		if message := strings.TrimSpace(envelope.Message); message != "" {
			return message
		}
		if code := strings.TrimSpace(envelope.Error); code != "" {
			return "启动宿主拒绝执行: " + code
		}
	}
	return fmt.Sprintf("启动宿主返回 HTTP %d", status)
}

func convertLaunchResult(payload launchResultPayload) Result {
	result := Result{
		OK:               payload.OK,
		Status:           payload.Status,
		PID:              payload.PID,
		TerminalID:       payload.TerminalID,
		SessionKey:       payload.SessionKey,
		LaunchMode:       payload.LaunchMode,
		Executable:       payload.Executable,
		PIDs:             payload.PIDs,
		Error:            payload.Error,
		Message:          payload.Message,
		Reason:           payload.Reason,
		RequiredAction:   payload.RequiredAction,
		EgressError:      payload.EgressError,
		EgressWarning:    payload.EgressWarning,
		InstallRequired:  payload.InstallRequired,
		InstallAvailable: payload.InstallAvailable,
	}
	if payload.InstallTarget != nil {
		result.InstallTarget = &InstallTarget{
			Provider: payload.InstallTarget.Provider,
			Kind:     payload.InstallTarget.Kind,
			AppID:    payload.InstallTarget.AppID,
		}
	}
	return result
}
