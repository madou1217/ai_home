// Package webuiworkspacefsapi 统一承接 WebUI 的本机与远程工作区文件接口。
//
//	GET  /v1/management/webui/workspace/fs/access
//	GET  /v1/management/webui/workspace/fs/read
//	GET  /v1/management/webui/workspace/fs/tree
//	GET  /v1/management/webui/workspace/fs/media
//	POST /v1/management/webui/workspace/fs/trust
//
// 本机路径复用 internal/webuifile 与既有的 access/read/media/trust 传输处理器，并注入
// 实时的项目路径清单、Chat 图片根目录及 Provider 投影改写；当 projectPath 为远程工作区
// 影子目录时直接经 webuiremoteworkspace 在远端执行，无 Node 回落。
package webuiworkspacefsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
	"github.com/madou1217/ai_home/internal/transport/http/webuifsaccessapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuifsmediaapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuifsreadapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuifstrustapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiprojectsapi"
	"github.com/madou1217/ai_home/internal/webuifile"
	"github.com/madou1217/ai_home/internal/webuiremoteworkspace"
)

const (
	// BasePath 是聚合文件系统契约根路径。
	BasePath   = "/v1/management/webui/workspace/fs"
	AccessPath = BasePath + "/access"
	ReadPath   = BasePath + "/read"
	TreePath   = BasePath + "/tree"
	MediaPath  = BasePath + "/media"
	TrustPath  = BasePath + "/trust"

	defaultTreeDepth = 1
	maxTreeDepth     = 4
	maxTreeNodes     = 2000
	remoteTimeout    = 30 * time.Second
)

// ErrInvalidDependencies 表示 Handler 缺少必需依赖。
var ErrInvalidDependencies = errors.New("工作区文件服务依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总工作区文件接口依赖。
type Dependencies struct {
	Authorizer       Authorizer
	HostHomeDir      string
	AiHomeDir        string
	ChatImageRootDir string
	FS               webuifile.FS
	ProjectPaths     func(ctx context.Context) []string
	TrustSource      *webuifstrustapi.Source
	Remote           *webuiremoteworkspace.Service
}

// Handler 统一处理本机与远程工作区的文件接口。
type Handler struct {
	authorizer  Authorizer
	hostHomeDir string
	aiHomeDir   string
	fs          webuifile.FS
	remote      *webuiremoteworkspace.Service

	localAccess http.Handler
	localRead   http.Handler
	localMedia  http.Handler
	localTrust  http.Handler

	projectPaths func(ctx context.Context) []string
	trustSource  *webuifstrustapi.Source
}

// NewHandler 创建工作区文件统一 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	hostHome := strings.TrimSpace(dependencies.HostHomeDir)
	aiHome := strings.TrimSpace(dependencies.AiHomeDir)
	if aiHome == "" && hostHome != "" {
		aiHome = filepath.Join(hostHome, ".ai_home")
	}
	if aiHome == "" {
		return nil, ErrInvalidDependencies
	}
	chatImgRoot := strings.TrimSpace(dependencies.ChatImageRootDir)
	if chatImgRoot == "" {
		chatImgRoot = filepath.Join(os.TempDir(), "aih-web-chat-images")
	}
	fs := dependencies.FS
	if fs == nil {
		fs = webuifile.OSFS{}
	}
	projectPaths := dependencies.ProjectPaths
	if projectPaths == nil {
		projectPaths = func(ctx context.Context) []string {
			paths, _ := webuiprojectsapi.ListAuthorizedProjectPaths(ctx, hostHome, aiHome)
			return paths
		}
	}
	trustSource := dependencies.TrustSource
	if trustSource == nil {
		opened, err := webuifstrustapi.OpenSource(aiHome)
		if err != nil {
			return nil, err
		}
		trustSource = opened
	}
	remoteSvc := dependencies.Remote
	if remoteSvc == nil {
		remoteSvc = webuiremoteworkspace.NewService(aiHome, hostHome, nil)
	}

	canonicalize := makeCanonicalizer(aiHome, hostHome)
	env := webuifile.Env{
		AIHomeDir:                aiHome,
		HostHomeDir:              hostHome,
		ChatImageRootDir:         chatImgRoot,
		CanonicalizeProviderPath: canonicalize,
	}
	getPaths := func() []string {
		return projectPaths(context.Background())
	}
	getTrusted := func() []webuifile.TrustedRoot {
		roots, _ := trustSource.ReadTrustedRoots(context.Background())
		return roots
	}

	localAccess, err := webuifsaccessapi.NewHandler(webuifsaccessapi.Dependencies{
		Authorizer: dependencies.Authorizer, Env: env, FS: fs,
		ProjectPaths: getPaths, TrustedRoots: getTrusted,
	})
	if err != nil {
		return nil, err
	}
	localRead, err := webuifsreadapi.NewHandler(webuifsreadapi.Dependencies{
		Authorizer: dependencies.Authorizer, Env: env, FS: fs,
		ProjectPaths: getPaths, TrustedRoots: getTrusted,
	})
	if err != nil {
		return nil, err
	}
	localMedia, err := webuifsmediaapi.NewHandler(webuifsmediaapi.Dependencies{
		Authorizer: dependencies.Authorizer, Env: env, FS: fs,
		ProjectPaths: getPaths, TrustedRoots: getTrusted,
	})
	if err != nil {
		return nil, err
	}
	localTrust, err := webuifstrustapi.NewHandler(webuifstrustapi.Dependencies{
		Authorizer: dependencies.Authorizer, Store: trustSource,
		AIHomeDir: aiHome, HostHomeDir: hostHome, FS: fs,
		CanonicalizeProviderPath: canonicalize,
	})
	if err != nil {
		return nil, err
	}

	return &Handler{
		authorizer:   dependencies.Authorizer,
		hostHomeDir:  hostHome,
		aiHomeDir:    aiHome,
		fs:           fs,
		remote:       remoteSvc,
		localAccess:  localAccess,
		localRead:    localRead,
		localMedia:   localMedia,
		localTrust:   localTrust,
		projectPaths: projectPaths,
		trustSource:  trustSource,
	}, nil
}

// ServeHTTP 鉴权并分派本机或远程工作区的文件请求。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", webuifile.CacheControlNoStore)
	response.Header().Set("Pragma", webuifile.PragmaNoCache)

	if handler == nil || handler.authorizer == nil {
		writeError(response, http.StatusServiceUnavailable, "fs_unavailable", "工作区文件服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}

	if request.URL.Path == TrustPath {
		handler.localTrust.ServeHTTP(response, request)
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}

	projectPath := strings.TrimSpace(request.URL.Query().Get("projectPath"))
	workspaceID := webuiremoteworkspace.WorkspaceIDFromProjectPath(handler.aiHomeDir, projectPath)

	switch request.URL.Path {
	case AccessPath:
		if workspaceID != "" {
			handler.serveRemoteRead(response, request, projectPath, workspaceID, true)
			return
		}
		handler.localAccess.ServeHTTP(response, normalizeLocalPathQuery(request, projectPath))
	case ReadPath:
		if workspaceID != "" {
			handler.serveRemoteRead(response, request, projectPath, workspaceID, false)
			return
		}
		handler.localRead.ServeHTTP(response, normalizeLocalPathQuery(request, projectPath))
	case MediaPath:
		if workspaceID != "" {
			handler.serveRemoteMedia(response, request, projectPath, workspaceID)
			return
		}
		handler.localMedia.ServeHTTP(response, normalizeLocalPathQuery(request, projectPath))
	case TreePath:
		if workspaceID != "" {
			handler.serveRemoteTree(response, request, projectPath, workspaceID)
			return
		}
		handler.serveLocalTree(response, request)
	default:
		writeError(response, http.StatusNotFound, "not_found", "未知的文件接口")
	}
}

func (handler *Handler) serveRemoteRead(response http.ResponseWriter, request *http.Request, projectPath, workspaceID string, checkOnly bool) {
	rel, err := webuiremoteworkspace.RelativePathFromShadow(projectPath, request.URL.Query().Get("path"))
	if err != nil {
		writeRemoteError(response, err)
		return
	}
	if rel == "" {
		writeError(response, http.StatusBadRequest, "missing_path", "缺少文件路径")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), remoteTimeout)
	defer cancel()
	session, err := handler.remote.OpenSession(ctx, workspaceID)
	if err != nil {
		writeRemoteError(response, err)
		return
	}
	defer func() { _ = session.Close() }()

	targetPath := filepath.Join(projectPath, filepath.FromSlash(rel))
	if checkOnly {
		info, err := session.Stat(ctx, rel)
		if err != nil {
			writeRemoteError(response, err)
			return
		}
		if info.Type == "d" {
			writeError(response, http.StatusBadRequest, "not_a_file", "目标不是文件")
			return
		}
		writeJSON(response, http.StatusOK, map[string]any{
			"ok":    true,
			"path":  targetPath,
			"size":  info.Size,
			"mtime": info.Mtime * 1000,
		})
		return
	}

	raw, size, mtime, err := session.ReadFile(ctx, rel, webuifile.TextFileSizeLimit)
	if err != nil {
		writeRemoteError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":      true,
		"path":    targetPath,
		"content": string(raw),
		"size":    size,
		"mtime":   mtime * 1000,
	})
}

func (handler *Handler) serveRemoteMedia(response http.ResponseWriter, request *http.Request, projectPath, workspaceID string) {
	rel, err := webuiremoteworkspace.RelativePathFromShadow(projectPath, request.URL.Query().Get("path"))
	if err != nil {
		writeRemoteError(response, err)
		return
	}
	if rel == "" {
		writeError(response, http.StatusBadRequest, "missing_path", "缺少文件路径")
		return
	}
	if webuifile.ImageContentType(rel) == "" {
		writeError(response, http.StatusUnsupportedMediaType, "unsupported_media_type", "暂不支持预览该媒体文件类型")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), remoteTimeout)
	defer cancel()
	session, err := handler.remote.OpenSession(ctx, workspaceID)
	if err != nil {
		writeRemoteError(response, err)
		return
	}
	defer func() { _ = session.Close() }()

	raw, _, _, err := session.ReadFile(ctx, rel, webuifile.MediaFileSizeLimit)
	if err != nil {
		writeRemoteError(response, err)
		return
	}
	headers, ok := webuifile.NewMediaHeaders(rel, int64(len(raw)))
	if !ok {
		writeError(response, http.StatusUnsupportedMediaType, "unsupported_media_type", "暂不支持预览该媒体文件类型")
		return
	}
	response.Header().Set("Content-Type", headers.ContentType)
	response.Header().Set("Content-Length", strconv.Itoa(len(raw)))
	response.Header().Set("Cache-Control", headers.CacheControl)
	response.Header().Set("Pragma", headers.Pragma)
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(raw)
}

type treeEntryView struct {
	Name        string          `json:"name"`
	Type        string          `json:"type"`
	Size        *int64          `json:"size,omitempty"`
	MTime       int64           `json:"mtime"`
	HasChildren bool            `json:"hasChildren"`
	Children    []treeEntryView `json:"children,omitempty"`
}

func (handler *Handler) serveRemoteTree(response http.ResponseWriter, request *http.Request, projectPath, workspaceID string) {
	query := request.URL.Query()
	rawRel := strings.TrimSpace(query.Get("path"))
	showHidden := query.Get("showHidden") == "1"

	rel, err := webuiremoteworkspace.NormalizeRelativePath(rawRel)
	if err != nil {
		writeRemoteError(response, err)
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), remoteTimeout)
	defer cancel()
	session, err := handler.remote.OpenSession(ctx, workspaceID)
	if err != nil {
		writeRemoteError(response, err)
		return
	}
	defer func() { _ = session.Close() }()

	rawEntries, err := session.ListDir(ctx, rel)
	if err != nil {
		writeRemoteError(response, err)
		return
	}
	visible := make([]webuiremoteworkspace.Entry, 0, len(rawEntries))
	for _, entry := range rawEntries {
		if !showHidden {
			if _, hidden := webuifile.HiddenTreeNames[entry.Name]; hidden || strings.HasPrefix(entry.Name, ".") {
				continue
			}
		}
		visible = append(visible, entry)
	}
	sort.Slice(visible, func(left, right int) bool {
		lDir := visible[left].Type == "d"
		rDir := visible[right].Type == "d"
		if lDir != rDir {
			return lDir
		}
		lName := strings.ToLower(visible[left].Name)
		rName := strings.ToLower(visible[right].Name)
		if lName != rName {
			return lName < rName
		}
		return visible[left].Name < visible[right].Name
	})

	truncated := len(visible) > webuifile.MaxTreeEntries
	if truncated {
		visible = visible[:webuifile.MaxTreeEntries]
	}
	entries := make([]treeEntryView, 0, len(visible))
	for _, item := range visible {
		isDir := item.Type == "d"
		entryType := webuifile.TreeEntryFile
		var sizePtr *int64
		if isDir {
			entryType = webuifile.TreeEntryDirectory
		} else {
			sizeCopy := item.Size
			sizePtr = &sizeCopy
		}
		entries = append(entries, treeEntryView{
			Name:        item.Name,
			Type:        entryType,
			Size:        sizePtr,
			MTime:       item.Mtime * 1000,
			HasChildren: isDir,
		})
	}
	displayPath := rel
	if displayPath == "" {
		displayPath = "."
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":          true,
		"path":        displayPath,
		"projectPath": projectPath,
		"entries":     entries,
		"truncated":   truncated,
		"remote":      true,
	})
}

func (handler *Handler) serveLocalTree(response http.ResponseWriter, request *http.Request) {
	query := request.URL.Query()
	depth := defaultTreeDepth
	if rawDepth := strings.TrimSpace(query.Get("depth")); rawDepth != "" {
		parsed, err := strconv.Atoi(rawDepth)
		if err != nil || parsed < 1 {
			writeError(response, http.StatusBadRequest, "invalid_depth", "depth 必须是正整数")
			return
		}
		if parsed > maxTreeDepth {
			parsed = maxTreeDepth
		}
		depth = parsed
	}
	showHidden := query.Get("showHidden") == "1"

	roots := make([]string, 0)
	if handler.projectPaths != nil {
		roots = append(roots, handler.projectPaths(request.Context())...)
	}
	if handler.trustSource != nil {
		trusted, _ := handler.trustSource.ReadTrustedRoots(request.Context())
		for _, item := range webuifile.NormalizeTrustedRoots(trusted) {
			roots = append(roots, item.Path)
		}
	}
	registry := webuifile.NewProjectRoots(roots)

	budget := maxTreeNodes
	entries, truncated, failure := expandLocalTree(handler.fs, registry, query.Get("projectPath"), query.Get("path"), depth, showHidden, &budget)
	if failure != nil {
		writeFileError(response, failure)
		return
	}

	projectPath := strings.TrimSpace(query.Get("projectPath"))
	if authorized, ok := registry.Authorize(projectPath); ok {
		projectPath = authorized
	}
	relPath := strings.TrimSpace(query.Get("path"))
	if relPath == "" {
		relPath = "."
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":          true,
		"path":        relPath,
		"projectPath": projectPath,
		"depth":       depth,
		"entries":     entries,
		"truncated":   truncated,
	})
}

func expandLocalTree(fs webuifile.FS, registry *webuifile.ProjectRoots, projectPath, relativePath string, depth int, showHidden bool, budget *int) ([]treeEntryView, bool, *webuifile.FileError) {
	tree, failure := webuifile.Tree(fs, registry, projectPath, relativePath, showHidden)
	if failure != nil {
		return nil, false, failure
	}
	entries := make([]treeEntryView, 0, len(tree.Entries))
	truncated := tree.Truncated
	for _, entry := range tree.Entries {
		if *budget <= 0 {
			return entries, true, nil
		}
		*budget--
		view := treeEntryView{
			Name:        entry.Name,
			Type:        entry.Type,
			Size:        entry.Size,
			MTime:       entry.MTime,
			HasChildren: entry.HasChildren,
		}
		if entry.Type == webuifile.TreeEntryDirectory && depth > defaultTreeDepth {
			childPath := entry.Name
			if trimmed := strings.TrimSpace(relativePath); trimmed != "" && trimmed != "." {
				childPath = filepath.Join(trimmed, entry.Name)
			}
			children, childTruncated, childFailure := expandLocalTree(fs, registry, projectPath, childPath, depth-1, showHidden, budget)
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

func makeCanonicalizer(aiHomeDir, hostHomeDir string) func(string) webuifile.ProviderPath {
	cleanAIHome := filepath.Clean(strings.TrimSpace(aiHomeDir))
	return func(rawPath string) webuifile.ProviderPath {
		resolved := sessionevents.CanonicalizePath(rawPath, aiHomeDir, hostHomeDir, "")
		if resolved != rawPath {
			return webuifile.ProviderPath{Path: resolved, Blocked: false}
		}
		rel, err := filepath.Rel(cleanAIHome, filepath.Clean(strings.TrimSpace(rawPath)))
		if err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
			slashed := strings.ToLower(filepath.ToSlash(rel))
			if strings.HasPrefix(slashed, "run/auth-projections/") || strings.HasPrefix(slashed, "profiles/") {
				for _, suffix := range []string{
					"/.claude/.credentials.json",
					"/.codex/auth.json",
					"/.gemini/oauth_creds.json",
					"/electron-user-data",
					"/.codebuddy/diagnostics",
				} {
					if strings.Contains(slashed, suffix) {
						return webuifile.ProviderPath{Path: rawPath, Blocked: true}
					}
				}
			}
		}
		return webuifile.ProviderPath{Path: rawPath, Blocked: false}
	}
}

func writeFileError(response http.ResponseWriter, failure *webuifile.FileError) {
	status := failure.Status
	code := failure.Code
	if status >= http.StatusInternalServerError {
		status = http.StatusInternalServerError
	}
	writeError(response, status, code, failure.Message)
}

func writeRemoteError(response http.ResponseWriter, err error) {
	var remoteErr *webuiremoteworkspace.RemoteError
	if errors.As(err, &remoteErr) && remoteErr != nil {
		status := remoteErr.Status
		if status <= 0 {
			status = http.StatusBadGateway
		}
		code := remoteErr.Code
		if code == "" {
			code = "remote_workspace_failed"
		}
		writeError(response, status, code, remoteErr.Message)
		return
	}
	writeError(response, http.StatusBadGateway, "remote_workspace_failed", err.Error())
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, map[string]any{
		"ok":      false,
		"error":   code,
		"message": message,
	})
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}

func normalizeLocalPathQuery(request *http.Request, projectPath string) *http.Request {
	if projectPath == "" || request == nil || request.URL == nil {
		return request
	}
	query := request.URL.Query()
	rawPath := strings.TrimSpace(query.Get("path"))
	source := strings.TrimSpace(query.Get("source"))
	if rawPath == "" || source == webuifile.SourceCodexMemory || strings.HasPrefix(rawPath, "~") || filepath.IsAbs(rawPath) {
		return request
	}
	cloned := request.Clone(request.Context())
	query.Set("path", filepath.Join(projectPath, filepath.FromSlash(rawPath)))
	cloned.URL.RawQuery = query.Encode()
	return cloned
}
