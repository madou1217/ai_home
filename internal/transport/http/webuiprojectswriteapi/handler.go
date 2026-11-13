// Package webuiprojectswriteapi 提供 WebUI 项目的写操作与目录浏览/选择器 HTTP 边界。
//
//	POST /v1/management/webui/projects/browse
//	POST /v1/management/webui/projects/open
//	POST /v1/management/webui/projects/remove
//	POST /v1/management/webui/projects/pick
package webuiprojectswriteapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// BrowsePath 是浏览服务端本地目录的管理契约路径。
	BrowsePath = "/v1/management/webui/projects/browse"
	// OpenPath 是手动打开项目的管理契约路径。
	OpenPath = "/v1/management/webui/projects/open"
	// RemovePath 是移除/隐藏项目的管理契约路径。
	RemovePath = "/v1/management/webui/projects/remove"
	// PickPath 是呼出系统原生目录选择器的管理契约路径。
	PickPath = "/v1/management/webui/projects/pick"

	webuiProjectsKey = "webui-projects"
	maxBodyBytes     = 1 << 20
)

// ErrInvalidDependencies 表示 Handler 缺少必需依赖。
var ErrInvalidDependencies = errors.New("项目写接口依赖无效")

// Authorizer 是管理面请求的鉴权策略。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// PickerFunc 呼出原生目录选择器并返回选中的目录、是否取消以及错误信息。
type PickerFunc func(ctx context.Context, prompt string) (pickedPath string, cancelled bool, err error)

// Dependencies 汇总项目写接口依赖。
type Dependencies struct {
	Authorizer  Authorizer
	HostHomeDir string
	AiHomeDir   string
	Picker      PickerFunc
	OnChanged   func(ctx context.Context)
	Now         func() int64
}

// Handler 处理 browse / open / remove / pick 四个管理契约。
type Handler struct {
	authorizer  Authorizer
	hostHomeDir string
	aiHomeDir   string
	picker      PickerFunc
	onChanged   func(ctx context.Context)
	now         func() int64
}

// NewHandler 校验依赖并创建 Handler。
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
	picker := dependencies.Picker
	if picker == nil {
		picker = defaultPickDirectory
	}
	nowFn := dependencies.Now
	if nowFn == nil {
		nowFn = func() int64 { return time.Now().UnixMilli() }
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		hostHomeDir: hostHome,
		aiHomeDir:   aiHome,
		picker:      picker,
		onChanged:   dependencies.OnChanged,
		now:         nowFn,
	}, nil
}

// ServeHTTP 校验 Bearer 鉴权与 POST 方法后分发请求。
func (handler *Handler) ServeHTTP(responseWriter http.ResponseWriter, request *http.Request) {
	responseWriter.Header().Set("Cache-Control", "no-store")
	if handler == nil || handler.authorizer == nil {
		writeError(responseWriter, http.StatusServiceUnavailable, "webui_projects_unavailable", "项目操作服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		responseWriter.Header().Set("WWW-Authenticate", "Bearer")
		writeError(responseWriter, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPost {
		responseWriter.Header().Set("Allow", http.MethodPost)
		writeError(responseWriter, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 POST")
		return
	}

	switch request.URL.Path {
	case BrowsePath:
		handler.serveBrowse(responseWriter, request)
	case OpenPath:
		handler.serveOpen(responseWriter, request)
	case RemovePath:
		handler.serveRemove(responseWriter, request)
	case PickPath:
		handler.servePick(responseWriter, request)
	default:
		writeError(responseWriter, http.StatusNotFound, "not_found", "未知的项目操作接口")
	}
}

func (handler *Handler) serveBrowse(responseWriter http.ResponseWriter, request *http.Request) {
	var body struct {
		SubDir string `json:"subDir"`
	}
	if err := decodeOptionalJSON(responseWriter, request, &body); err != nil {
		writeError(responseWriter, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}

	homeDir := handler.hostHomeDir
	if homeDir == "" {
		if detected, err := os.UserHomeDir(); err == nil {
			homeDir = detected
		}
	}
	baseDir := homeDir
	if baseDir == "" {
		if cwd, err := os.Getwd(); err == nil {
			baseDir = cwd
		}
	}

	subDir := strings.TrimSpace(body.SubDir)
	var targetDir string
	switch {
	case subDir == "":
		targetDir = baseDir
	case strings.HasPrefix(subDir, "~"):
		rest := strings.TrimLeft(strings.TrimPrefix(subDir, "~"), `/\`)
		if rest == "" {
			targetDir = homeDir
		} else {
			targetDir = filepath.Join(homeDir, rest)
		}
	case filepath.IsAbs(subDir):
		targetDir = filepath.Clean(subDir)
	default:
		targetDir = filepath.Join(baseDir, subDir)
	}
	if abs, err := filepath.Abs(targetDir); err == nil {
		targetDir = abs
	}

	info, err := os.Stat(targetDir)
	if err != nil {
		writeError(responseWriter, http.StatusNotFound, "not_found", "路径不存在: "+targetDir)
		return
	}
	if !info.IsDir() {
		writeError(responseWriter, http.StatusBadRequest, "not_a_directory", "路径不是目录: "+targetDir)
		return
	}
	lowerPath := strings.ToLower(targetDir)
	if strings.Contains(lowerPath, "/.ssh") || strings.Contains(lowerPath, `\.ssh`) {
		writeError(responseWriter, http.StatusForbidden, "permission_denied", "权限不足，无法访问该敏感系统目录")
		return
	}

	entries, err := os.ReadDir(targetDir)
	if err != nil {
		writeError(responseWriter, http.StatusInternalServerError, "browse_failed", err.Error())
		return
	}
	type dirItem struct {
		Name string `json:"name"`
		Path string `json:"path"`
	}
	directories := make([]dirItem, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if name == "." || name == ".." {
			continue
		}
		fullPath := filepath.Join(targetDir, name)
		isDir := entry.IsDir()
		if childInfo, statErr := os.Stat(fullPath); statErr == nil {
			isDir = childInfo.IsDir()
		}
		if isDir {
			directories = append(directories, dirItem{Name: name, Path: fullPath})
		}
	}
	sort.Slice(directories, func(left, right int) bool {
		l := strings.ToLower(directories[left].Name)
		r := strings.ToLower(directories[right].Name)
		if l != r {
			return l < r
		}
		return directories[left].Name < directories[right].Name
	})

	parentDir := filepath.Dir(targetDir)
	if parentDir == targetDir {
		parentDir = targetDir
	}
	writeJSON(responseWriter, http.StatusOK, struct {
		OK          bool      `json:"ok"`
		CurrentDir  string    `json:"currentDir"`
		ParentDir   string    `json:"parentDir"`
		Directories []dirItem `json:"directories"`
	}{
		OK:          true,
		CurrentDir:  targetDir,
		ParentDir:   parentDir,
		Directories: directories,
	})
}

func (handler *Handler) serveOpen(responseWriter http.ResponseWriter, request *http.Request) {
	var body struct {
		ProjectPath string `json:"projectPath"`
		Name        string `json:"name"`
	}
	if err := decodeOptionalJSON(responseWriter, request, &body); err != nil {
		writeError(responseWriter, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	projectPath := normalizeProjectPath(body.ProjectPath)
	if projectPath == "" {
		writeError(responseWriter, http.StatusBadRequest, "missing_project_path", "missing_project_path")
		return
	}
	if !filepath.IsAbs(projectPath) {
		writeError(responseWriter, http.StatusBadRequest, "project_path_must_be_absolute", "project_path_must_be_absolute")
		return
	}
	info, err := os.Stat(projectPath)
	if err != nil {
		writeError(responseWriter, http.StatusBadRequest, "project_path_not_found", "project_path_not_found")
		return
	}
	if !info.IsDir() {
		writeError(responseWriter, http.StatusBadRequest, "project_path_not_directory", "project_path_not_directory")
		return
	}

	projectName := strings.TrimSpace(body.Name)
	if projectName == "" {
		projectName = filepath.Base(projectPath)
	}
	dbPath, err := appstate.DatabasePath(handler.aiHomeDir)
	if err != nil {
		writeError(responseWriter, http.StatusBadRequest, "open_project_failed", err.Error())
		return
	}
	nowMS := handler.now()
	if err := appstate.UpdateKV(request.Context(), dbPath, webuiProjectsKey, func(current string, found bool) (string, error) {
		doc := parseStoredProjectState(current, found)
		doc.HiddenPaths = filterOutPath(doc.HiddenPaths, projectPath)
		updated := false
		for index := range doc.Projects {
			if normalizeProjectPath(doc.Projects[index].Path) == projectPath {
				doc.Projects[index].Path = projectPath
				if projectName != "" {
					doc.Projects[index].Name = projectName
				}
				updated = true
				break
			}
		}
		if !updated {
			doc.Projects = append([]storedProject{{
				Path:    projectPath,
				Name:    projectName,
				AddedAt: nowMS,
			}}, doc.Projects...)
		}
		encoded, marshalErr := json.Marshal(doc)
		if marshalErr != nil {
			return "", marshalErr
		}
		return string(encoded), nil
	}); err != nil {
		writeError(responseWriter, http.StatusBadRequest, "open_project_failed", err.Error())
		return
	}

	if handler.hostHomeDir != "" {
		ensureCodexHooksEnabled(request.Context(), handler.hostHomeDir)
		ensureCodexProjectRegistered(handler.hostHomeDir, projectPath)
	}
	if handler.onChanged != nil {
		handler.onChanged(request.Context())
	}

	writeJSON(responseWriter, http.StatusOK, struct {
		OK      bool `json:"ok"`
		Project struct {
			ID        string   `json:"id"`
			Name      string   `json:"name"`
			Path      string   `json:"path"`
			Providers []string `json:"providers"`
			Sessions  []any    `json:"sessions"`
			Manual    bool     `json:"manual"`
		} `json:"project"`
	}{
		OK: true,
		Project: struct {
			ID        string   `json:"id"`
			Name      string   `json:"name"`
			Path      string   `json:"path"`
			Providers []string `json:"providers"`
			Sessions  []any    `json:"sessions"`
			Manual    bool     `json:"manual"`
		}{
			ID:        base64PathID(projectPath),
			Name:      projectName,
			Path:      projectPath,
			Providers: []string{},
			Sessions:  []any{},
			Manual:    true,
		},
	})
}

func (handler *Handler) serveRemove(responseWriter http.ResponseWriter, request *http.Request) {
	var body struct {
		ProjectPath string `json:"projectPath"`
	}
	if err := decodeOptionalJSON(responseWriter, request, &body); err != nil {
		writeError(responseWriter, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	projectPath := normalizeProjectPath(body.ProjectPath)
	if projectPath == "" {
		writeError(responseWriter, http.StatusBadRequest, "missing_project_path", "missing_project_path")
		return
	}
	dbPath, err := appstate.DatabasePath(handler.aiHomeDir)
	if err != nil {
		writeError(responseWriter, http.StatusBadRequest, "remove_project_failed", err.Error())
		return
	}
	if err := appstate.UpdateKV(request.Context(), dbPath, webuiProjectsKey, func(current string, found bool) (string, error) {
		doc := parseStoredProjectState(current, found)
		filtered := make([]storedProject, 0, len(doc.Projects))
		for _, item := range doc.Projects {
			if normalizeProjectPath(item.Path) != projectPath {
				filtered = append(filtered, item)
			}
		}
		doc.Projects = filtered
		if !containsString(doc.HiddenPaths, projectPath) {
			doc.HiddenPaths = append(doc.HiddenPaths, projectPath)
		}
		encoded, marshalErr := json.Marshal(doc)
		if marshalErr != nil {
			return "", marshalErr
		}
		return string(encoded), nil
	}); err != nil {
		writeError(responseWriter, http.StatusBadRequest, "remove_project_failed", err.Error())
		return
	}

	if handler.hostHomeDir != "" {
		removeCodexProjectRegistration(handler.hostHomeDir, projectPath)
	}
	if handler.onChanged != nil {
		handler.onChanged(request.Context())
	}
	writeJSON(responseWriter, http.StatusOK, struct {
		OK          bool   `json:"ok"`
		Removed     bool   `json:"removed"`
		ProjectPath string `json:"projectPath"`
	}{
		OK:          true,
		Removed:     true,
		ProjectPath: projectPath,
	})
}

func (handler *Handler) servePick(responseWriter http.ResponseWriter, request *http.Request) {
	pickedPath, cancelled, err := handler.picker(request.Context(), "请选择要打开的项目文件夹")
	if err != nil {
		var pickerErr *PickerError
		code := "project_picker_failed"
		message := "无法打开目录选择器，请手动输入路径。"
		if errors.As(err, &pickerErr) && pickerErr != nil {
			if pickerErr.Code != "" {
				code = pickerErr.Code
			}
			if code == "project_picker_unsupported_platform" {
				message = "当前平台暂不支持目录选择器，请手动输入路径。"
			} else if pickerErr.Message != "" {
				message = pickerErr.Message
			}
		}
		writeError(responseWriter, http.StatusInternalServerError, code, message)
		return
	}
	if cancelled || strings.TrimSpace(pickedPath) == "" {
		writeJSON(responseWriter, http.StatusOK, map[string]any{
			"ok":        true,
			"cancelled": true,
		})
		return
	}
	clean := normalizeProjectPath(pickedPath)
	writeJSON(responseWriter, http.StatusOK, map[string]any{
		"ok":        true,
		"cancelled": false,
		"project": map[string]string{
			"path": clean,
			"name": filepath.Base(clean),
		},
	})
}

type storedProject struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	AddedAt int64  `json:"addedAt"`
}

type storedProjectState struct {
	Projects    []storedProject `json:"projects"`
	HiddenPaths []string        `json:"hiddenPaths"`
}

func parseStoredProjectState(raw string, found bool) storedProjectState {
	out := storedProjectState{
		Projects:    []storedProject{},
		HiddenPaths: []string{},
	}
	if !found || strings.TrimSpace(raw) == "" {
		return out
	}
	var decoded storedProjectState
	if json.Unmarshal([]byte(raw), &decoded) != nil {
		return out
	}
	if decoded.Projects != nil {
		out.Projects = decoded.Projects
	}
	seenHidden := make(map[string]bool, len(decoded.HiddenPaths))
	for _, item := range decoded.HiddenPaths {
		norm := normalizeProjectPath(item)
		if norm != "" && !seenHidden[norm] {
			seenHidden[norm] = true
			out.HiddenPaths = append(out.HiddenPaths, norm)
		}
	}
	return out
}

func filterOutPath(paths []string, target string) []string {
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		if normalizeProjectPath(p) != target {
			out = append(out, p)
		}
	}
	return out
}

func containsString(paths []string, target string) bool {
	for _, p := range paths {
		if normalizeProjectPath(p) == target {
			return true
		}
	}
	return false
}

func normalizeProjectPath(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "/" {
		return "/"
	}
	return strings.TrimRight(trimmed, `/\`)
}

func base64PathID(value string) string {
	encoded := base64.StdEncoding.EncodeToString([]byte(value))
	return strings.NewReplacer("/", "_", "+", "_", "=", "_").Replace(encoded)
}

func decodeOptionalJSON(responseWriter http.ResponseWriter, request *http.Request, target any) error {
	if request.Body == nil {
		return nil
	}
	raw, err := io.ReadAll(http.MaxBytesReader(responseWriter, request.Body, maxBodyBytes))
	if err != nil {
		return err
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}
	return json.Unmarshal(trimmed, target)
}

func writeJSON(responseWriter http.ResponseWriter, status int, body any) {
	responseWriter.Header().Set("Content-Type", "application/json; charset=utf-8")
	responseWriter.WriteHeader(status)
	_ = json.NewEncoder(responseWriter).Encode(body)
}

func writeError(responseWriter http.ResponseWriter, status int, code, message string) {
	writeJSON(responseWriter, status, struct {
		OK      bool   `json:"ok"`
		Error   string `json:"error"`
		Message string `json:"message"`
	}{
		OK:      false,
		Error:   code,
		Message: message,
	})
}
