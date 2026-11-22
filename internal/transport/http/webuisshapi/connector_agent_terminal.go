package webuisshapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/remoteconnector"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
	"github.com/madou1217/ai_home/internal/runtime/workspaceconnector"
)

const (
	ConnectorAgentTerminalPath = remoteconnector.AgentTerminalPath
	connectorToolTokenTTL      = 12 * time.Hour
	maxConnectorBodyBytes      = 16 * 1024
)

type ConnectorWorkspaceReader interface {
	Find(context.Context, string) (workspaceconnector.Workspace, bool, error)
}

type ConnectorAgentTerminalDependencies struct {
	Authorizer     Authorizer
	Workspaces     ConnectorWorkspaceReader
	Online         func(string) bool
	IssueToolToken func(context.Context, string, time.Duration) (string, int64, error)
	AIHomeDir      string
	SelfBaseURL    string
	Launcher       TerminalLauncher
	// Preparer supplies the Server gateway environment (base URL and key).
	// Connector agent terminals intentionally use gateway execution: account
	// projection requires a session-close hook that the terminal launcher does
	// not expose yet, and gateway mode keeps refreshed credentials on the Server.
	Preparer chatruntime.NativeLaunchPreparer
}

// ConnectorAgentTerminalHandler launches Codex or Claude on the AIH Server with
// an MCP bridge that forwards tool calls to one local Workspace Connector.
// AGY is rejected explicitly: PTY-only agents have no structured tool channel.
type ConnectorAgentTerminalHandler struct {
	authorizer     Authorizer
	workspaces     ConnectorWorkspaceReader
	online         func(string) bool
	issueToolToken func(context.Context, string, time.Duration) (string, int64, error)
	aiHomeDir      string
	selfBaseURL    string
	launcher       TerminalLauncher
	preparer       chatruntime.NativeLaunchPreparer
}

func NewConnectorAgentTerminalHandler(dependencies ConnectorAgentTerminalDependencies) (*ConnectorAgentTerminalHandler, error) {
	if dependencies.Authorizer == nil || dependencies.Workspaces == nil || dependencies.IssueToolToken == nil {
		return nil, ErrInvalidDependencies
	}
	return &ConnectorAgentTerminalHandler{
		authorizer:     dependencies.Authorizer,
		workspaces:     dependencies.Workspaces,
		online:         dependencies.Online,
		issueToolToken: dependencies.IssueToolToken,
		aiHomeDir:      strings.TrimSpace(dependencies.AIHomeDir),
		selfBaseURL:    strings.TrimRight(strings.TrimSpace(dependencies.SelfBaseURL), "/"),
		launcher:       dependencies.Launcher,
		preparer:       dependencies.Preparer,
	}, nil
}

func hasEnvKey(env []string, key string) bool {
	for _, item := range env {
		if strings.HasPrefix(item, key+"=") {
			return true
		}
	}
	return false
}

func (handler *ConnectorAgentTerminalHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.workspaces == nil {
		writeError(response, http.StatusServiceUnavailable, "connector_agent_unavailable", "工作区 Connector 服务不可用。")
		return
	}
	if !handler.authorizer.Authorized(request) {
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
		return
	}
	workspaceID := strings.TrimSpace(request.PathValue("workspaceId"))
	if workspaceID == "" {
		writeError(response, http.StatusBadRequest, "workspace_not_found", "workspace id is required")
		return
	}
	var body struct {
		Agent string `json:"agent"`
		Model string `json:"model"`
		Fresh bool   `json:"fresh"`
		Cols  any    `json:"cols"`
		Rows  any    `json:"rows"`
	}
	if request.Body != nil {
		raw, err := io.ReadAll(io.LimitReader(request.Body, maxConnectorBodyBytes+1))
		if err != nil {
			writeError(response, http.StatusBadRequest, "invalid_request", "无法读取请求")
			return
		}
		if len(raw) > maxConnectorBodyBytes {
			writeError(response, http.StatusRequestEntityTooLarge, "invalid_request", "请求过大")
			return
		}
		if len(strings.TrimSpace(string(raw))) > 0 {
			if err := json.Unmarshal(raw, &body); err != nil {
				writeError(response, http.StatusBadRequest, "invalid_request", "请求必须是 JSON")
				return
			}
		}
	}
	agent := strings.ToLower(strings.TrimSpace(body.Agent))
	if agent == "" {
		agent = "codex"
	}
	switch agent {
	case "codex", "claude":
	case "agy":
		writeError(response, http.StatusConflict, "agy_remote_workspace_unsupported", "AGY 当前只有 PTY，没有结构化工具/审批通道；请先用 codex 或 claude。")
		return
	default:
		writeError(response, http.StatusBadRequest, "unsupported_agent", "仅支持 codex 或 claude")
		return
	}
	workspace, found, err := handler.workspaces.Find(request.Context(), workspaceID)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "workspace_read_failed", "读取工作区失败")
		return
	}
	if !found {
		writeError(response, http.StatusNotFound, "workspace_not_found", "工作区不存在")
		return
	}
	if workspace.Revoked() {
		writeError(response, http.StatusConflict, "workspace_revoked", "工作区登记已撤销")
		return
	}
	if handler.online != nil && !handler.online(workspaceID) {
		writeError(response, http.StatusConflict, "workspace_offline", "本地 Connector 不在线")
		return
	}
	if handler.launcher == nil {
		writeError(response, http.StatusServiceUnavailable, "terminal_launcher_unavailable", "终端管理器未接线")
		return
	}
	if handler.selfBaseURL == "" {
		writeError(response, http.StatusServiceUnavailable, "tool_bridge_unavailable", "Server 回环地址未配置")
		return
	}
	toolToken, expiresAt, err := handler.issueToolToken(request.Context(), workspaceID, connectorToolTokenTTL)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "tool_token_failed", "无法签发工具令牌")
		return
	}
	shadowDir := filepath.Join(handler.aiHomeDir, "run", "connector-workspaces", workspaceID)
	if err := os.MkdirAll(shadowDir, 0o700); err != nil {
		writeError(response, http.StatusInternalServerError, "workspace_anchor_failed", "无法创建工作区锚点目录")
		return
	}
	toolsURL := handler.selfBaseURL + remoteconnector.ToolPathFor(workspaceID)
	providerPath, providerArgs, providerEnv, buildErr := buildConnectorAgentLaunch(
		handler.aiHomeDir, workspaceID, agent, toolsURL, toolToken, workspaceconnector.ToolDefinitions(),
	)
	if buildErr != nil {
		if errors.Is(buildErr, ErrAGYRemoteUnsupported) {
			writeError(response, http.StatusConflict, "agy_remote_workspace_unsupported", "AGY 当前没有结构化工具通道")
			return
		}
		writeError(response, http.StatusServiceUnavailable, "provider_cli_unavailable", buildErr.Error())
		return
	}
	if handler.preparer != nil {
		target, targetErr := handler.preparer.GetTarget(request.Context(), agent, chatruntime.GatewayRuntimeScope)
		if targetErr != nil {
			writeError(response, http.StatusServiceUnavailable, "native_target_unavailable", "无法解析 Server 网关执行目标")
			return
		}
		plan, planErr := handler.preparer.Prepare(request.Context(), chatruntime.NativeLaunchRequest{
			Target: target, CommandName: agent, Args: providerArgs,
		})
		if planErr != nil {
			writeError(response, http.StatusServiceUnavailable, "native_launch_prepare_failed", "无法准备 Provider 启动环境")
			return
		}
		if plan.Release != nil {
			writeError(response, http.StatusConflict, "connector_agent_projection_unsupported", "账号投影终端缺少会话关闭钩子；请使用网关模式")
			return
		}
		if resolved, lookErr := exec.LookPath(plan.BinaryName); lookErr == nil {
			providerPath = resolved
		} else {
			providerPath = plan.BinaryName
		}
		providerArgs = append([]string(nil), plan.Args...)
		providerEnv = append([]string(nil), plan.Env...)
		if !hasEnvKey(providerEnv, "AIH_HOME_DIR") {
			providerEnv = append(providerEnv, "AIH_HOME_DIR="+handler.aiHomeDir)
		}
		if model := strings.TrimSpace(body.Model); model != "" {
			if agent == "codex" {
				providerArgs = append(providerArgs, "-m", model)
			} else {
				providerArgs = append(providerArgs, "--model", model)
			}
		}
	}
	suffix := ""
	if body.Fresh {
		suffix = ":" + randomHex(4)
	}
	sessionKey := "connector-ai:" + workspaceID + ":" + agent + suffix
	result, launchErr := handler.launcher.LaunchTerminal(request.Context(), TerminalLaunchRequest{
		SessionKey: sessionKey,
		File:       providerPath,
		Args:       providerArgs,
		Env:        providerEnv,
		Cwd:        shadowDir,
		Cols:       intValue(body.Cols),
		Rows:       intValue(body.Rows),
		Persistent: true,
	})
	if launchErr != nil {
		code := strings.TrimSpace(launchErr.Code)
		if code == "" {
			code = "connector_terminal_open_failed"
		}
		writeError(response, http.StatusServiceUnavailable, code, launchErr.Message)
		return
	}
	if result.SessionKey != "" {
		sessionKey = result.SessionKey
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":            true,
		"sessionKey":    sessionKey,
		"termId":        result.TermID,
		"reused":        result.Reused,
		"durable":       result.Durable,
		"workspaceId":   workspaceID,
		"agent":         agent,
		"label":         workspace.Label + " · " + agent,
		"rootLabel":     workspace.RootLabel,
		"toolExpiresAt": expiresAt,
	})
}
