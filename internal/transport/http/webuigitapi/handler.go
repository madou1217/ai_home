// Package webuigitapi 是宿主 Git 只读查询的 HTTP 边界。
//
//	GET /v1/management/webui/git/summary?projectPath=...
//	GET /v1/management/webui/git/diff?projectPath=...&path=...&staged=1
//
// 对应 Node lib/server/webui-git-routes.js 的 handleGitSummaryRequest /
// handleGitDiffRequest，以及 lib/server/webui-git-service.js 的子进程口径。
// 响应键名、类型与缺省值逐字照抄（summary 的 branch/upstream/ahead/behind/files，
// files 的 path/oldPath/staged/unstaged/untracked/status，diff 的 path/content/truncated），
// 前端不需要按端分支。
//
// 与 Node 的差异，都是有意为之：
//   - 项目根授权：Node 用「已登记项目快照」判定 projectPath；本包没有项目登记读端口，
//     改为 realpath 包含校验 —— projectPath 必须是绝对路径，字面路径与解析符号链接后的
//     真实路径都要落在 HostHomeDir 之内，否则按 403 unknown_project_root 拒绝。
//   - 只读：只执行 status / branch / rev-parse / rev-list / diff，不接受任何写操作。
//   - 不复制 Node 的 5s summary 缓存（stale-while-revalidate）：每次请求都重新取状态，
//     避免同一份工作区状态在两处缓存里各说各话。
//   - status 输出超过 2MB 时 Node 会静默丢弃多余记录并返回不完整 files；本包改为
//     400 git_output_too_large，不把截断后的清单冒充成完整工作区状态。
package webuigitapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/webuifile"
)

const (
	// Path 是宿主 Git 只读接口的契约前缀，由共享 wiring 挂载。
	Path = "/v1/management/webui/git"
	// SummarySuffix 是工作区状态子路由。
	SummarySuffix = "/summary"
	// DiffSuffix 是单文件只读 diff 子路由。
	DiffSuffix = "/diff"
)

// 与 Node 写进 error 字段的错误码保持一致。
const (
	codeUnknownProjectRoot = "unknown_project_root"
	codeInvalidFilePath    = "invalid_file_path"
	codeGitSummaryFailed   = "git_summary_failed"
	codeGitDiffFailed      = "git_diff_failed"
	codeGitOutputTooLarge  = "git_output_too_large"
	codeMethodNotAllowed   = "method_not_allowed"
	codeUnauthorized       = "unauthorized"
	codeNotFound           = "not_found"
	codeUnavailable        = "webui_git_unavailable"
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权策略或宿主目录。
var ErrInvalidDependencies = errors.New("WebUI Git 只读接口依赖无效")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总 Git 只读接口的依赖。
type Dependencies struct {
	Authorizer Authorizer
	// HostHomeDir 是允许查询的宿主目录边界；projectPath 必须落在它之内。
	HostHomeDir string
}

// Handler 是宿主 Git 只读接口的 HTTP 入站适配器。
type Handler struct {
	authorizer  Authorizer
	hostHomeDir string
	// runner 是 git 子进程执行端口；生产实现在 NewHandler 里绑定，测试直接替换。
	runner gitRunner
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	hostHomeDir := strings.TrimSpace(dependencies.HostHomeDir)
	if dependencies.Authorizer == nil || hostHomeDir == "" {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		hostHomeDir: hostHomeDir,
		runner:      runGit,
	}, nil
}

// summaryResponse 是 /summary 的成功响应：{ok, ...summary}。
type summaryResponse struct {
	OK       bool       `json:"ok"`
	Branch   string     `json:"branch"`
	Upstream string     `json:"upstream"`
	Ahead    int        `json:"ahead"`
	Behind   int        `json:"behind"`
	Files    []fileView `json:"files"`
}

// fileView 是一条工作区变更记录。
//
// oldPath 用 omitempty：Node 里该键的值是 undefined，JSON.stringify 会整个丢掉，
// 只有重命名/复制记录才出现。
type fileView struct {
	Path      string `json:"path"`
	OldPath   string `json:"oldPath,omitempty"`
	Staged    bool   `json:"staged"`
	Unstaged  bool   `json:"unstaged"`
	Untracked bool   `json:"untracked"`
	Status    string `json:"status"`
}

// diffResponse 是 /diff 的成功响应：{ok, path, ...diff}。
type diffResponse struct {
	OK        bool   `json:"ok"`
	Path      string `json:"path"`
	Content   string `json:"content"`
	Truncated bool   `json:"truncated"`
}

// errorResponse 与 Node 的 {ok:false, error, message} 一致：
// 这里的 error 是错误码字符串，不是对象，别按其它 WebUI 契约的形状改。
type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message"`
}

// apiError 是已经映射好的响应：status 与 code 直接写回客户端。
type apiError struct {
	status  int
	code    string
	message string
}

func (failure *apiError) Error() string { return failure.code + ": " + failure.message }

// ServeHTTP 只接受 GET，并按子路由分派 summary / diff。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	// 工作区状态是秒级变化的实时事实，不允许被缓存。
	response.Header().Set("Cache-Control", "no-store")

	if handler == nil || handler.authorizer == nil || handler.runner == nil {
		writeError(response, &apiError{status: http.StatusServiceUnavailable, code: codeUnavailable, message: "Git 只读接口不可用"})
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, &apiError{status: http.StatusUnauthorized, code: codeUnauthorized, message: "需要管理密钥"})
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, &apiError{status: http.StatusMethodNotAllowed, code: codeMethodNotAllowed, message: "仅支持 GET"})
		return
	}

	switch strings.TrimPrefix(request.URL.Path, Path) {
	case SummarySuffix:
		handler.serveSummary(response, request)
	case DiffSuffix:
		handler.serveDiff(response, request)
	default:
		writeError(response, &apiError{status: http.StatusNotFound, code: codeNotFound, message: "未知的 Git 只读接口"})
	}
}

// serveSummary 对应 Node 的 handleGitSummaryRequest。
func (handler *Handler) serveSummary(response http.ResponseWriter, request *http.Request) {
	root, failure := handler.resolveProjectRoot(request)
	if failure != nil {
		writeError(response, failure)
		return
	}
	summary, err := getSummary(request.Context(), handler.runner, root)
	if err != nil {
		writeGitError(response, err, codeGitSummaryFailed)
		return
	}
	writeJSON(response, http.StatusOK, summary)
}

// serveDiff 对应 Node 的 handleGitDiffRequest。
func (handler *Handler) serveDiff(response http.ResponseWriter, request *http.Request) {
	root, failure := handler.resolveProjectRoot(request)
	if failure != nil {
		writeError(response, failure)
		return
	}
	query := request.URL.Query()
	filePath := validRelativePath(query.Get("path"))
	if filePath == "" {
		writeError(response, &apiError{status: http.StatusBadRequest, code: codeInvalidFilePath, message: "必须提供项目内的相对文件路径"})
		return
	}
	diff, err := getDiff(request.Context(), handler.runner, root, filePath, query.Get("staged") == "1")
	if err != nil {
		writeGitError(response, err, codeGitDiffFailed)
		return
	}
	writeJSON(response, http.StatusOK, diff)
}

// resolveProjectRoot 校验 projectPath 并返回可交给 git -C 的真实路径。
//
// 两道包含校验：字面路径要落在 HostHomeDir 内，解析符号链接后的真实路径也要落在
// HostHomeDir 的真实路径内。只查其中一道都会放过「目录内软链指向外部」这种情况。
func (handler *Handler) resolveProjectRoot(request *http.Request) (string, *apiError) {
	requested := strings.TrimSpace(request.URL.Query().Get("projectPath"))
	if requested == "" || !filepath.IsAbs(requested) {
		return "", unknownProjectRootError()
	}
	candidate := filepath.Clean(requested)
	realHome, err := filepath.EvalSymlinks(handler.hostHomeDir)
	if err != nil {
		return "", &apiError{status: http.StatusServiceUnavailable, code: codeUnavailable, message: "宿主目录不可用"}
	}
	if !webuifile.WithinRoot(handler.hostHomeDir, candidate) {
		return "", unknownProjectRootError()
	}
	realRoot, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		// 路径不存在时 Node 同样拿不到已登记项目，按未授权根处理。
		return "", unknownProjectRootError()
	}
	if !webuifile.WithinRoot(realHome, realRoot) {
		return "", unknownProjectRootError()
	}
	return realRoot, nil
}

func unknownProjectRootError() *apiError {
	return &apiError{status: http.StatusForbidden, code: codeUnknownProjectRoot, message: "只允许查看已登记项目的 Git 变更"}
}

// validRelativePath 对应 Node 的 validRelativePath：
// 空串、绝对路径、逃逸出仓库根的路径一律返回空串。
func validRelativePath(raw string) string {
	candidate := strings.TrimSpace(raw)
	if candidate == "" || filepath.IsAbs(candidate) {
		return ""
	}
	normalized := filepath.Clean(candidate)
	if normalized == ".." || strings.HasPrefix(normalized, ".."+string(filepath.Separator)) {
		return ""
	}
	// "." 与 Node 的 path.normalize('.') 一致，交给 git 按仓库根解释。
	return normalized
}

// writeGitError 把子进程失败映射成 400：错误码沿用 git_timeout / git_failed，
// 其它错误（例如 git 不存在）落到调用方给的兜底码上。
func writeGitError(response http.ResponseWriter, err error, fallbackCode string) {
	code := fallbackCode
	message := err.Error()
	var failure *gitFailure
	if errors.As(err, &failure) {
		code = failure.code
		message = failure.message
	}
	writeError(response, &apiError{status: http.StatusBadRequest, code: code, message: message})
}

func writeError(response http.ResponseWriter, failure *apiError) {
	writeJSON(response, failure.status, errorResponse{OK: false, Error: failure.code, Message: failure.message})
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}
