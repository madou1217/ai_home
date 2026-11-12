// Package webuiprojectsapi 是 WebUI 项目管理面的 HTTP 边界。
//
//	GET /v1/management/webui/projects
//	GET /v1/management/webui/projects/sessions?projectPath=...
//
// 契约来源：Node lib/server/webui-project-routes.js 的 handleGetProjectsRequest
// 与 lib/server/webui-project-cache.js 的 buildProjectsSnapshot。响应形状
// {ok, projects:[{id,name,path,providers,sessions,sessionTotal}]}、会话按 updatedAt
// 降序、项目按最近活动降序、每个项目最多下发 40 条会话，全部照抄 Node。
//
// 数据边界：
//   - 覆盖 Node 在项目视图里返回的 Provider：claude、codex、gemini、opencode、
//     CodeBuddy 家族（codebuddy / codebuddycn / workbuddy / workbuddycn）与 cline。
//     目录型 Provider 只扫宿主 HOME；opencode 读宿主共享的 opencode.db，cline 读
//     宿主与账号投影的 sessions.db（全部只读）；不读 app-state。
//   - 目录遍历有预算：条目上限 + 单次请求超时；符号链接一律跳过，并对每个
//     项目目录做 realpath 复核，保证不会逃出白名单根。
//   - 项目路径必须在磁盘上真实存在（与 Node filterHiddenProjects 同口径），
//     解析不出真实路径的项目不下发。
//
// 本切片刻意不含：SSE watch、目录选择器、手动打开/移除项目、远程工作区项目。
// 这些都属于另外的契约。
//
// /projects/sessions 是 /projects 的按项目全量读：同一份扫描与聚合口径，但只下发
// 指定 projectPath 的项目，并且不套 40 条会话截断。扫描被预算或超时截断时返回
// 503，让 Node 用本地项目索引兜底，绝不把不完整会话集冒充成完整结果。
package webuiprojectsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"time"
)

// Path 是项目列表的管理契约路径。
//
//	GET /v1/management/webui/projects
const Path = "/v1/management/webui/projects"

// SessionsPath 是单项目完整会话集合的管理契约路径。
//
//	GET /v1/management/webui/projects/sessions?projectPath=...
const SessionsPath = Path + "/sessions"

// 扫描预算默认值：单次请求最多消费的目录条目数与总时长。
const (
	// DefaultMaxEntries 是单次扫描允许读取的目录条目总数。
	DefaultMaxEntries = 20000
	// DefaultScanTimeout 是单次扫描的时间上限；超时返回已扫描到的部分结果。
	DefaultScanTimeout = 8 * time.Second
	// sessionPayloadCap 与 Node 的 SESSION_PAYLOAD_CAP 一致：单项目最多下发 40 条会话。
	sessionPayloadCap = 40
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权或宿主目录。
var ErrInvalidDependencies = errors.New("项目列表接口依赖无效")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总项目列表的依赖。
type Dependencies struct {
	Authorizer Authorizer
	// HostHomeDir 是宿主用户目录（项目会话存储的根）；必填。
	HostHomeDir string
	// AiHomeDir 是 aih 自己的状态目录；留空时按 <HostHomeDir>/.ai_home 处理。
	// 只用于识别 aih 内部的 chat 工作区（与 Node filterHiddenProjects 同口径）。
	AiHomeDir string
	// MaxEntries 覆盖单次扫描的条目预算；<=0 时用 DefaultMaxEntries。
	MaxEntries int
	// ScanTimeout 覆盖单次扫描的时间上限；<=0 时用 DefaultScanTimeout。
	ScanTimeout time.Duration
}

// Handler 是项目列表的 HTTP 入站适配器。
type Handler struct {
	authorizer  Authorizer
	hostHomeDir string
	aiHomeDir   string
	maxEntries  int
	scanTimeout time.Duration
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	hostHomeDir := trimSpace(dependencies.HostHomeDir)
	if hostHomeDir == "" {
		return nil, ErrInvalidDependencies
	}
	maxEntries := dependencies.MaxEntries
	if maxEntries <= 0 {
		maxEntries = DefaultMaxEntries
	}
	scanTimeout := dependencies.ScanTimeout
	if scanTimeout <= 0 {
		scanTimeout = DefaultScanTimeout
	}
	aiHomeDir := trimSpace(dependencies.AiHomeDir)
	if aiHomeDir == "" {
		aiHomeDir = filepath.Join(hostHomeDir, ".ai_home")
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		hostHomeDir: hostHomeDir,
		aiHomeDir:   aiHomeDir,
		maxEntries:  maxEntries,
		scanTimeout: scanTimeout,
	}, nil
}

// projectView 与 Node 的项目条目同形（manual / addedAt / remote 属于其它切片）。
//
// 键序按 Node 的对象构造顺序：sessions 先于 sessionTotal。
type projectView struct {
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	Path         string        `json:"path"`
	Providers    []string      `json:"providers"`
	Sessions     []sessionView `json:"sessions"`
	SessionTotal int           `json:"sessionTotal"`
}

// sessionView 与 Node 下发到 /projects 的会话条目同形。
type sessionView struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	UpdatedAt      int64  `json:"updatedAt"`
	Provider       string `json:"provider"`
	ProjectDirName string `json:"projectDirName"`
	ProjectPath    string `json:"projectPath"`
}

// response 是成功响应。truncated 只在扫描被预算截断时出现，
// 正常结果的键集合与 Node 完全一致。
type response struct {
	OK        bool          `json:"ok"`
	Projects  []projectView `json:"projects"`
	Truncated bool          `json:"truncated,omitempty"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message"`
}

// projectResponse 是单项目完整会话集合的成功响应。
//
// 键序与 Node 的 {ok, project} 一致；project 复用项目列表的 projectView。
type projectResponse struct {
	OK      bool        `json:"ok"`
	Project projectView `json:"project"`
}

// ServeHTTP 只接受带管理密钥的 GET，并按路径分派列表与单项目全量读。
func (handler *Handler) ServeHTTP(responseWriter http.ResponseWriter, request *http.Request) {
	// 项目列表随会话文件变化，缓存会让人看到过期条目。
	responseWriter.Header().Set("Cache-Control", "no-store")

	if handler == nil || handler.authorizer == nil || handler.hostHomeDir == "" {
		writeError(responseWriter, http.StatusServiceUnavailable, "webui_projects_unavailable", "项目列表服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		responseWriter.Header().Set("WWW-Authenticate", "Bearer")
		writeError(responseWriter, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		responseWriter.Header().Set("Allow", http.MethodGet)
		writeError(responseWriter, http.StatusMethodNotAllowed, "method_not_allowed", "只支持读取项目列表")
		return
	}

	switch request.URL.Path {
	case SessionsPath:
		handler.serveProjectSessions(responseWriter, request)
	case Path:
		handler.serveProjects(responseWriter, request)
	default:
		writeError(responseWriter, http.StatusNotFound, "not_found", "未知的项目接口")
	}
}

// serveProjects 是项目列表：每项目最多 40 条会话，总量用 sessionTotal 表达。
func (handler *Handler) serveProjects(responseWriter http.ResponseWriter, request *http.Request) {
	// Node 的 ?refresh=1 用于跳过快照 TTL；Go 侧每次请求都重新扫描，参数被接受但无额外语义。
	ctx, cancel := context.WithTimeout(request.Context(), handler.scanTimeout)
	defer cancel()

	projects, truncated := handler.collect(ctx, aggregateOptions{})
	writeJSON(responseWriter, http.StatusOK, response{
		OK:        true,
		Projects:  projects,
		Truncated: truncated,
	})
}

// serveProjectSessions 对应 Node 的 handleGetProjectSessionsRequest：
// 按 projectPath 返回单个项目的完整会话集合（不截断到 40 条）。
func (handler *Handler) serveProjectSessions(responseWriter http.ResponseWriter, request *http.Request) {
	projectPath := normalizeProjectPath(request.URL.Query().Get("projectPath"))
	if projectPath == "" {
		writeError(responseWriter, http.StatusBadRequest, "missing_projectPath", "缺少项目路径")
		return
	}

	ctx, cancel := context.WithTimeout(request.Context(), handler.scanTimeout)
	defer cancel()

	projects, truncated := handler.collect(ctx, aggregateOptions{
		projectPath:        projectPath,
		includeAllSessions: true,
	})
	if truncated {
		// 预算/超时意味着这条项目的会话可能不完整。全量读不能返回半份结果，
		// 交给 Node 的项目索引兜底（Node 只认 ok/project，503 会自动回退）。
		writeError(responseWriter, http.StatusServiceUnavailable, "project_sessions_unavailable", "项目会话读取不完整")
		return
	}
	if len(projects) == 0 {
		writeError(responseWriter, http.StatusNotFound, "project_not_found", "未找到项目")
		return
	}
	writeJSON(responseWriter, http.StatusOK, projectResponse{OK: true, Project: projects[0]})
}

// collect 执行一次有界扫描并完成聚合。
//
// 扫描被预算或超时打断时返回已收集到的部分结果（truncated=true），
// 而不是把「读得慢」升级成 5xx：项目列表本来就是最终一致视图。
func (handler *Handler) collect(ctx context.Context, options aggregateOptions) ([]projectView, bool) {
	scan := newScanner(ctx, handler.hostHomeDir, handler.aiHomeDir, handler.maxEntries)
	raw := filterChatWorkspaceProjects(scan.collectProjects(), handler.aiHomeDir)
	return aggregateProjects(raw, isExistingDirectory, options), scan.truncated
}

func writeJSON(responseWriter http.ResponseWriter, status int, body any) {
	responseWriter.Header().Set("Content-Type", "application/json; charset=utf-8")
	responseWriter.WriteHeader(status)
	_ = json.NewEncoder(responseWriter).Encode(body)
}

func writeError(responseWriter http.ResponseWriter, status int, code, message string) {
	writeJSON(responseWriter, status, errorView{OK: false, Error: code, Message: message})
}
