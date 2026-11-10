// Package webuifstreeapi 是 WebUI 目录树浏览的管理 HTTP 边界。
//
//	GET /v1/management/webui/fs/tree?projectPath=...&path=...&depth=...
//
// 目录枚举、隐藏名过滤、越界与符号链接检查全部委托 internal/webuifile.Tree；
// 本包只负责鉴权、查询参数、depth 递归展开与响应形状。
//
// 授权来源有两条：服务端登记的项目根（ProjectPaths）与 app-state 里已信任的
// 目录（TrustedRoots）。两者都作为 ProjectRoots 的登记项交给 Tree，因此每个
// 子目录的读取都会重新做一次字面与 realpath 两层越界检查。
//
// 项目快照属于宿主存储职责，由 Dependencies.ProjectPaths 注入；Node 侧快照
// 未迁移前该端口为空，此时只有已信任目录可浏览。
package webuifstreeapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/webuifile"
)

// Path 是 WebUI 目录树的管理契约。
const Path = "/v1/management/webui/fs/tree"

const (
	// DefaultTreeDepth 是未传 depth 时的层数：只列当前目录。
	DefaultTreeDepth = 1
	// MaxTreeDepth 是 depth 上限；再深会放大单次请求的磁盘扫描量。
	MaxTreeDepth = 4
	// MaxTreeNodes 是单次请求展开的条目总预算，防止深目录把事件循环拖住。
	MaxTreeNodes = 2000
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权依赖。
var ErrInvalidDependencies = errors.New("WebUI 目录树接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总目录树依赖。
type Dependencies struct {
	Authorizer Authorizer
	// ProjectPaths 返回服务端当前已登记项目的绝对路径；为 nil 时没有项目根。
	ProjectPaths func() []string
	// TrustedRoots 返回 app-state 中已信任的目录；为 nil 时视为没有信任项。
	TrustedRoots func() []webuifile.TrustedRoot
	// FS 为 nil 时使用本地文件系统；注入点用于确定性测试符号链接越界。
	FS webuifile.FS
}

// Handler 处理目录树读取。
type Handler struct {
	authorizer   Authorizer
	fs           webuifile.FS
	projectPaths func() []string
	trustedRoots func() []webuifile.TrustedRoot
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	fs := dependencies.FS
	if fs == nil {
		fs = webuifile.OSFS{}
	}
	return &Handler{
		authorizer:   dependencies.Authorizer,
		fs:           fs,
		projectPaths: dependencies.ProjectPaths,
		trustedRoots: dependencies.TrustedRoots,
	}, nil
}

type treeResponse struct {
	OK          bool        `json:"ok"`
	Path        string      `json:"path"`
	ProjectPath string      `json:"projectPath"`
	Depth       int         `json:"depth"`
	Entries     []entryView `json:"entries"`
	Truncated   bool        `json:"truncated"`
}

type entryView struct {
	Name        string      `json:"name"`
	Type        string      `json:"type"`
	Size        *int64      `json:"size,omitempty"`
	MTime       int64       `json:"mtime"`
	HasChildren bool        `json:"hasChildren"`
	Children    []entryView `json:"children,omitempty"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message"`
}

// ServeHTTP 只接受带管理密钥的 GET。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	// 目录内容随文件系统变化，缓存会让人看到过期条目。
	response.Header().Set("Cache-Control", webuifile.CacheControlNoStore)
	response.Header().Set("Pragma", webuifile.PragmaNoCache)

	if handler == nil || handler.authorizer == nil || handler.fs == nil {
		writeError(response, http.StatusServiceUnavailable, "fs_tree_unavailable", "目录树服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}

	query := request.URL.Query()
	depth, depthErr := parseDepth(query.Get("depth"))
	if depthErr != nil {
		writeError(response, http.StatusBadRequest, "invalid_depth", "depth 必须是正整数")
		return
	}

	registry := webuifile.NewProjectRoots(handler.authorizedRoots())
	budget := MaxTreeNodes
	entries, truncated, failure := expandEntries(handler.fs, registry, query.Get("projectPath"), query.Get("path"), depth, &budget)
	if failure != nil {
		writeFileError(response, failure)
		return
	}

	projectPath := strings.TrimSpace(query.Get("projectPath"))
	authorized, ok := registry.Authorize(projectPath)
	if !ok {
		// Tree 已通过同样的登记表授权，这里只用来输出规范化的根路径。
		authorized = projectPath
	}
	relativePath := strings.TrimSpace(query.Get("path"))
	if relativePath == "" {
		relativePath = "."
	}
	writeJSON(response, http.StatusOK, treeResponse{
		OK:          true,
		Path:        relativePath,
		ProjectPath: authorized,
		Depth:       depth,
		Entries:     entries,
		Truncated:   truncated,
	})
}

// authorizedRoots 合并项目快照与已信任目录；规范化与去重交给 NewProjectRoots。
func (handler *Handler) authorizedRoots() []string {
	paths := []string{}
	if handler.projectPaths != nil {
		paths = append(paths, handler.projectPaths()...)
	}
	if handler.trustedRoots != nil {
		for _, entry := range webuifile.NormalizeTrustedRoots(handler.trustedRoots()) {
			paths = append(paths, entry.Path)
		}
	}
	return paths
}

// expandEntries 递归展开目录树。子目录读取失败（权限、竞态）不拖垮整次请求：
// 保留该目录条目并标记 hasChildren，同时把 truncated 置真表示结果不完整。
func expandEntries(fs webuifile.FS, registry *webuifile.ProjectRoots, projectPath, relativePath string, depth int, budget *int) ([]entryView, bool, *webuifile.FileError) {
	tree, failure := webuifile.Tree(fs, registry, projectPath, relativePath, false)
	if failure != nil {
		return nil, false, failure
	}
	entries := make([]entryView, 0, len(tree.Entries))
	truncated := tree.Truncated
	for _, entry := range tree.Entries {
		if *budget <= 0 {
			return entries, true, nil
		}
		*budget--
		view := entryView{
			Name:        entry.Name,
			Type:        entry.Type,
			Size:        entry.Size,
			MTime:       entry.MTime,
			HasChildren: entry.HasChildren,
		}
		if entry.Type == webuifile.TreeEntryDirectory && depth > DefaultTreeDepth {
			childPath := entry.Name
			if trimmed := strings.TrimSpace(relativePath); trimmed != "" && trimmed != "." {
				childPath = filepath.Join(trimmed, entry.Name)
			}
			children, childTruncated, childFailure := expandEntries(fs, registry, projectPath, childPath, depth-1, budget)
			if childFailure != nil {
				truncated = true
			} else {
				view.Children = children
				truncated = truncated || childTruncated
			}
		}
		entries = append(entries, view)
	}
	return entries, truncated, nil
}

// parseDepth 缺省为 1；非正整数报错，超过上限按上限截断。
func parseDepth(raw string) (int, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return DefaultTreeDepth, nil
	}
	value, err := strconv.Atoi(trimmed)
	if err != nil || value < 1 {
		return 0, errors.New("invalid_depth")
	}
	if value > MaxTreeDepth {
		value = MaxTreeDepth
	}
	return value, nil
}

// writeFileError 把策略错误映射成 {ok:false,error,message}；5xx 收敛成路由级错误码。
func writeFileError(response http.ResponseWriter, failure *webuifile.FileError) {
	status := failure.Status
	code := failure.Code
	if status >= http.StatusInternalServerError {
		status = http.StatusInternalServerError
		code = "fs_tree_failed"
	}
	writeError(response, status, code, failure.Message)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}
