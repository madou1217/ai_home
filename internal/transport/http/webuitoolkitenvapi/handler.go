// Package webuitoolkitenvapi 是 WebUI「运行环境」的管理面：入门指南、生命周期计划、
// 执行作业与作业事件流。
//
// 契约来源是 Node lib/server/webui-environment-routes.js：
//
//	GET  /v1/management/webui/toolkit/environments/guide
//	POST /v1/management/webui/toolkit/environments/plan
//	POST /v1/management/webui/toolkit/environments/execute
//	GET  /v1/management/webui/toolkit/environments/jobs
//	GET  /v1/management/webui/toolkit/environments/jobs/{jobID}
//	GET  /v1/management/webui/toolkit/environments/jobs/{jobID}/watch
//	POST /v1/management/webui/toolkit/environments/jobs/{jobID}/cancel
//	GET  /v1/management/webui/toolkit/environments/jobs-watch（全局事件流，供 Node 任务队列桥）
//
// 本机与 SSH 远端共用同一套目录 / 计划 / 作业状态机（internal/runtime/toolkit/environment），
// 只在执行目标端口上分叉。Node 不再保留这些路由的本地实现。
package webuitoolkitenvapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/hostexec"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

const (
	// Path 是运行环境管理契约前缀（与只读探测器同一路径前缀）。
	Path = "/v1/management/webui/toolkit/environments"
	// GuidePath 是入门指南。
	GuidePath = Path + "/guide"
	// PlanPath 是生命周期计划预览。
	PlanPath = Path + "/plan"
	// ExecutePath 是生命周期执行入口。
	ExecutePath = Path + "/execute"
	// JobsPath 是活动作业列表。
	JobsPath = Path + "/jobs"
	// JobPath 是单个作业。
	JobPath = Path + "/jobs/{jobID}"
	// JobWatchPath 是单个作业的 SSE。
	JobWatchPath = JobPath + "/watch"
	// JobCancelPath 是取消作业。
	JobCancelPath = JobPath + "/cancel"
	// JobsWatchPath 是全局作业事件流（Node 任务队列桥）。
	JobsWatchPath = Path + "/jobs-watch"

	// maxBodyBytes 与 Node environment readJsonBody 的上限一致（64KB）。
	maxBodyBytes = 64 * 1024
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权策略。
var ErrInvalidDependencies = errors.New("运行环境管理接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总运行环境管理依赖。
type Dependencies struct {
	Authorizer Authorizer
	// HostHomeDir 是宿主家目录；空值时用进程 HOME。
	HostHomeDir string
	// Executor 是命令执行端口；空值时用本机实现。
	Executor environment.Executor
	// Connections 读取 ssh_connections；为空且 AIHomeDir 可用时自动打开。
	Connections ConnectionSource
	// AIHomeDir 是 app-state 数据根目录。
	AIHomeDir string
	// Now 可注入（测试 / 对拍）；空值用 time.Now。
	Now func() time.Time
}

// Handler 处理运行环境管理请求。
type Handler struct {
	authorizer  Authorizer
	hostHomeDir string
	executor    environment.Executor
	connections ConnectionSource
	jobs        *environment.JobManager
	summaries   *summaryCache
	now         func() time.Time
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	executor := dependencies.Executor
	if executor == nil {
		executor = hostexec.Executor{}
	}
	connections := dependencies.Connections
	if connections == nil && strings.TrimSpace(dependencies.AIHomeDir) != "" {
		source, err := openConnectionSource(dependencies.AIHomeDir)
		if err == nil {
			connections = source
		}
	}
	now := dependencies.Now
	if now == nil {
		now = time.Now
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		hostHomeDir: strings.TrimSpace(dependencies.HostHomeDir),
		executor:    executor,
		connections: connections,
		jobs:        environment.NewJobManager(),
		summaries:   &summaryCache{entries: map[string]remoteSummaryEntry{}},
		now:         now,
	}, nil
}

// Jobs 返回作业管理器（组合根在真机上用作任务队列桥的数据源）。
func (handler *Handler) Jobs() *environment.JobManager { return handler.jobs }

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 按方法分派；鉴权对所有路由一致。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.jobs == nil {
		writeError(response, http.StatusServiceUnavailable, "environment_api_unavailable", "运行环境服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	path := request.URL.Path
	switch {
	case path == Path:
		handler.handleEnvironments(response, request)
	case path == GuidePath:
		handler.handleGuide(response, request)
	case path == PlanPath:
		handler.handlePlan(response, request)
	case path == ExecutePath:
		handler.handleExecute(response, request)
	case path == JobsPath:
		handler.handleJobs(response, request)
	case path == JobsWatchPath:
		handler.handleJobsWatch(response, request)
	case path == JobPath:
		handler.handleJob(response, request)
	case path == JobWatchPath:
		handler.handleJobWatch(response, request)
	case path == JobCancelPath:
		handler.handleJobCancel(response, request)
	default:
		writeError(response, http.StatusNotFound, "not_found", "")
	}
}

func (handler *Handler) handleGuide(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	guide := environment.BuildGuide(environment.GuideOptions{
		CurrentPlatform: currentPlatform(),
		Platform:        request.URL.Query().Get("platform"),
		HomeDir:         handler.homeDir(),
	})
	writeJSON(response, http.StatusOK, guide)
}

// requestPayload 是 plan / execute 的请求体。
type requestPayload struct {
	ToolID        string
	Action        string
	Target        string
	Manager       string
	Version       string
	Name          string
	PythonVersion string
	Path          string
	Cwd           string
	Confirmed     bool
}

func decodeRequestPayload(response http.ResponseWriter, request *http.Request) (requestPayload, bool) {
	decoder := json.NewDecoder(io.LimitReader(request.Body, maxBodyBytes))
	decoder.UseNumber()
	var payload map[string]any
	if err := decoder.Decode(&payload); err != nil && !errors.Is(err, io.EOF) {
		return requestPayload{}, false
	}
	if payload == nil {
		payload = map[string]any{}
	}
	return requestPayload{
		ToolID:        textField(payload, "toolId"),
		Action:        textField(payload, "action"),
		Target:        textField(payload, "target"),
		Manager:       textField(payload, "manager"),
		Version:       textField(payload, "version"),
		Name:          textField(payload, "name"),
		PythonVersion: textField(payload, "pythonVersion"),
		Path:          textField(payload, "path"),
		Cwd:           textField(payload, "cwd"),
		Confirmed:     payload["confirmed"] == true,
	}, true
}

func textField(payload map[string]any, key string) string {
	value, ok := payload[key].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(value)
}

func (handler *Handler) handlePlan(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
		return
	}
	payload, ok := decodeRequestPayload(response, request)
	if !ok {
		writeResult(response, http.StatusInternalServerError, map[string]any{
			"ok": false, "error": "invalid_environment_payload", "message": "运行环境参数无效。",
		})
		return
	}
	rawTarget := payload.Target
	if rawTarget == "" {
		rawTarget = request.URL.Query().Get("target")
	}
	target, err := handler.resolveTarget(request.Context(), rawTarget)
	if err != nil {
		writeTargetError(response, err)
		return
	}
	defer target.Close()

	if payload.ToolID != "" {
		host, err := target.Host(request.Context())
		if err != nil {
			writeTargetError(response, classifyRemoteError(err))
			return
		}
		result := environment.PlanToolAction(request.Context(), environment.ToolInput{
			ToolID: payload.ToolID, Action: payload.Action,
		}, host, environment.BuildOptions{Platform: host.Platform, HomeDir: host.HomeDir})
		status := http.StatusOK
		if !result.OK {
			status = resultStatus(result.Error)
		}
		writeJSON(response, status, result)
		return
	}
	if target.Kind != "local" {
		writeJSON(response, http.StatusBadRequest, map[string]any{
			"ok": false, "error": "unsupported_environment_tool_action", "message": "远端只支持按工具安装 / 更新 / 卸载。",
		})
		return
	}
	host, _ := target.Host(request.Context())
	actionOptions := environment.ActionOptions{Platform: host.Platform, HomeDir: host.HomeDir, Cwd: payload.Cwd}
	result := environment.PlanAction(environment.ActionInput{
		Manager: payload.Manager, Action: payload.Action, Version: payload.Version,
		Name: payload.Name, PythonVersion: payload.PythonVersion, Path: payload.Path,
	}, actionOptions)
	status := http.StatusOK
	if !result.OK {
		status = resultStatus(result.Error)
	}
	writeJSON(response, status, result)
}

func (handler *Handler) handleExecute(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
		return
	}
	payload, ok := decodeRequestPayload(response, request)
	if !ok {
		writeResult(response, http.StatusInternalServerError, map[string]any{
			"ok": false, "error": "invalid_environment_payload", "message": "运行环境参数无效。",
		})
		return
	}
	rawTarget := payload.Target
	if rawTarget == "" {
		rawTarget = request.URL.Query().Get("target")
	}
	target, err := handler.resolveTarget(request.Context(), rawTarget)
	if err != nil {
		writeTargetError(response, err)
		return
	}
	defer target.Close()

	if payload.ToolID != "" {
		jobEnvironment := environment.JobEnvironment{
			Key:   target.Key,
			Kind:  target.Kind,
			Label: target.Label,
			Host:  target.Host,
			Run:   target.Run,
		}
		result, err := handler.jobs.Start(request.Context(), jobEnvironment, environment.ToolInput{
			ToolID: payload.ToolID, Action: payload.Action,
		}, payload.Confirmed)
		if err != nil {
			writeTargetError(response, classifyRemoteError(err))
			return
		}
		status := http.StatusAccepted
		if !result.OK {
			status = resultStatus(result.Error)
		}
		writeJSON(response, status, result)
		return
	}
	if target.Kind != "local" {
		writeJSON(response, http.StatusBadRequest, map[string]any{
			"ok": false, "error": "unsupported_environment_tool_action", "message": "远端只支持按工具安装 / 更新 / 卸载。",
		})
		return
	}
	host, _ := target.Host(request.Context())
	result := environment.ExecuteAction(request.Context(), environment.ActionInput{
		Manager: payload.Manager, Action: payload.Action, Version: payload.Version,
		Name: payload.Name, PythonVersion: payload.PythonVersion, Path: payload.Path,
	}, payload.Confirmed, host, environment.ActionOptions{Platform: host.Platform, HomeDir: host.HomeDir, Cwd: payload.Cwd})
	status := http.StatusOK
	if !result.OK {
		status = resultStatus(result.Error)
	}
	writeJSON(response, status, result)
}

func (handler *Handler) handleJobs(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "jobs": handler.jobs.ListActive()})
}

func (handler *Handler) handleJob(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	job, ok := handler.jobs.Get(request.PathValue("jobID"))
	if !ok {
		writeJSON(response, http.StatusNotFound, map[string]any{
			"ok": false, "error": "job_not_found", "message": "运行环境任务不存在或已清理。",
		})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "job": job})
}

func (handler *Handler) handleJobCancel(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
		return
	}
	result := handler.jobs.Cancel(request.PathValue("jobID"))
	status := http.StatusOK
	if !result.OK {
		status = resultStatus(result.Error)
	}
	writeJSON(response, status, result)
}

// resultStatus 复刻 Node environment-routes 的 resultStatus。
func resultStatus(code string) int {
	switch {
	case code == "":
		return http.StatusInternalServerError
	case code == "confirmation_required":
		return http.StatusPreconditionRequired
	case code == "environment_tool_not_found" || code == "job_not_found" || code == "connection_not_found":
		return http.StatusNotFound
	case code == "remote_unreachable" || code == "auth_failed" || code == "host_key_mismatch":
		return http.StatusBadGateway
	case code == "environment_tool_already_installed" || code == "environment_tool_not_installed" || code == "job_not_cancellable":
		return http.StatusConflict
	case code == "environment_action_timeout":
		return http.StatusGatewayTimeout
	case code == "environment_action_failed" || code == "environment_action_spawn_failed":
		return http.StatusBadGateway
	case strings.HasPrefix(code, "invalid_") || strings.HasPrefix(code, "unsupported_") || code == "environment_tool_action_unavailable":
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}

func writeTargetError(response http.ResponseWriter, err error) {
	var targetErr *targetError
	if errors.As(err, &targetErr) {
		writeJSON(response, targetErr.status, errorView{OK: false, Error: targetErr.code, Message: targetErr.message})
		return
	}
	writeJSON(response, http.StatusBadGateway, errorView{OK: false, Error: "remote_unreachable", Message: err.Error()})
}

func writeResult(response http.ResponseWriter, status int, payload any) {
	writeJSON(response, status, payload)
}

// decodeJSONMap 把一个 JSON 对象解到 map（用于在领域结构上追加字段）。
func decodeJSONMap(encoded string, target *map[string]any) error {
	return json.Unmarshal([]byte(encoded), target)
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
