// Package webuiworkspacegitapi 统一承接 WebUI 的本机与远程工作区 Git 只读接口。
//
//	GET /v1/management/webui/workspace/git/summary?projectPath=...
//	GET /v1/management/webui/workspace/git/diff?projectPath=...&path=...&staged=...
//
// 本机项目按已登记项目列表校权（支持宿主 HOME 之外的手动打开项目），远端影子目录经
// webuiremoteworkspace 在目标机执行；无 Node 回落。
package webuiworkspacegitapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/webuiprojectsapi"
	"github.com/madou1217/ai_home/internal/webuifile"
	"github.com/madou1217/ai_home/internal/webuiremoteworkspace"
)

const (
	// BasePath 是工作区 Git 管理契约根路径。
	BasePath    = "/v1/management/webui/workspace/git"
	SummaryPath = BasePath + "/summary"
	DiffPath    = BasePath + "/diff"

	localGitTimeout   = 8 * time.Second
	remoteGitTimeout  = 30 * time.Second
	maxLocalGitBytes  = 2 * 1024 * 1024
	maxRemoteGitBytes = 4 * 1024 * 1024
)

// ErrInvalidDependencies 表示 Handler 缺少必需依赖。
var ErrInvalidDependencies = errors.New("工作区 Git 服务依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总工作区 Git 接口依赖。
type Dependencies struct {
	Authorizer   Authorizer
	HostHomeDir  string
	AiHomeDir    string
	ProjectPaths func(ctx context.Context) []string
	Remote       *webuiremoteworkspace.Service
}

// Handler 处理本机与远程工作区的 Git 只读接口。
type Handler struct {
	authorizer   Authorizer
	hostHomeDir  string
	aiHomeDir    string
	projectPaths func(ctx context.Context) []string
	remote       *webuiremoteworkspace.Service
}

// NewHandler 创建工作区 Git Handler。
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
	projectPaths := dependencies.ProjectPaths
	if projectPaths == nil {
		projectPaths = func(ctx context.Context) []string {
			paths, _ := webuiprojectsapi.ListAuthorizedProjectPaths(ctx, hostHome, aiHome)
			return paths
		}
	}
	remoteSvc := dependencies.Remote
	if remoteSvc == nil {
		remoteSvc = webuiremoteworkspace.NewService(aiHome, hostHome, nil)
	}
	return &Handler{
		authorizer:   dependencies.Authorizer,
		hostHomeDir:  hostHome,
		aiHomeDir:    aiHome,
		projectPaths: projectPaths,
		remote:       remoteSvc,
	}, nil
}

// FileChange 是 porcelain=v1 -z 归一化后的单文件变更条目。
type FileChange struct {
	Path      string `json:"path"`
	OldPath   string `json:"oldPath,omitempty"`
	Staged    bool   `json:"staged"`
	Unstaged  bool   `json:"unstaged"`
	Untracked bool   `json:"untracked"`
	Status    string `json:"status"`
}

// ServeHTTP 鉴权并分派 summary / diff 请求。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", webuifile.CacheControlNoStore)
	if handler == nil || handler.authorizer == nil {
		writeError(response, http.StatusServiceUnavailable, "git_unavailable", "Git 服务不可用")
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
	projectPath := strings.TrimSpace(query.Get("projectPath"))
	if projectPath == "" {
		writeError(response, http.StatusBadRequest, "project_path_required", "必须提供项目路径")
		return
	}
	workspaceID := webuiremoteworkspace.WorkspaceIDFromProjectPath(handler.aiHomeDir, projectPath)

	switch request.URL.Path {
	case SummaryPath:
		if workspaceID != "" {
			handler.serveRemoteSummary(response, request, workspaceID)
			return
		}
		handler.serveLocalSummary(response, request, projectPath)
	case DiffPath:
		filePath, ok := validRelativePath(query.Get("path"))
		if !ok {
			writeError(response, http.StatusBadRequest, "invalid_file_path", "必须提供项目内的相对文件路径")
			return
		}
		staged := query.Get("staged") == "1"
		if workspaceID != "" {
			handler.serveRemoteDiff(response, request, workspaceID, filePath, staged)
			return
		}
		handler.serveLocalDiff(response, request, projectPath, filePath, staged)
	default:
		writeError(response, http.StatusNotFound, "not_found", "未知的 Git 接口")
	}
}

func (handler *Handler) authorizeLocalRoot(ctx context.Context, projectPath string) (string, bool, error) {
	registry := webuifile.NewProjectRoots(handler.projectPaths(ctx))
	authorized, ok := registry.Authorize(projectPath)
	if !ok {
		return "", false, &gitErr{status: http.StatusForbidden, code: "unknown_project_root", message: "只允许查看已登记项目的 Git 状态"}
	}
	info, err := os.Stat(authorized)
	if err != nil {
		return "", false, &gitErr{status: http.StatusNotFound, code: "not_found", message: "项目路径不存在"}
	}
	if !info.IsDir() {
		return "", false, &gitErr{status: http.StatusBadRequest, code: "not_a_directory", message: "项目路径不是目录"}
	}
	realRoot, err := filepath.EvalSymlinks(authorized)
	if err != nil {
		return "", false, &gitErr{status: http.StatusForbidden, code: "path_escape", message: "项目路径无法解析"}
	}
	return realRoot, true, nil
}

func (handler *Handler) serveLocalSummary(response http.ResponseWriter, request *http.Request, projectPath string) {
	root, ok, authErr := handler.authorizeLocalRoot(request.Context(), projectPath)
	if !ok {
		writeGitErr(response, authErr)
		return
	}
	type cmdRes struct {
		stdout, stderr string
		code           int
		truncated      bool
		err            error
	}
	var statusRes, branchRes, upstreamRes cmdRes
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		statusRes.stdout, statusRes.stderr, statusRes.code, statusRes.truncated, statusRes.err = runLocalGit(request.Context(), root, []string{"status", "--porcelain=v1", "-z"}, false)
	}()
	go func() {
		defer wg.Done()
		branchRes.stdout, branchRes.stderr, branchRes.code, branchRes.truncated, branchRes.err = runLocalGit(request.Context(), root, []string{"branch", "--show-current"}, false)
	}()
	go func() {
		defer wg.Done()
		upstreamRes.stdout, upstreamRes.stderr, upstreamRes.code, upstreamRes.truncated, upstreamRes.err = runLocalGit(request.Context(), root, []string{"rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"}, true)
	}()
	wg.Wait()

	for _, r := range []cmdRes{statusRes, branchRes, upstreamRes} {
		if r.err != nil {
			writeGitErr(response, r.err)
			return
		}
	}
	if statusRes.truncated {
		writeError(response, http.StatusBadRequest, "git_output_too_large", "Git 工作区状态超过 2MB，无法给出完整变更清单")
		return
	}
	branch := strings.TrimSpace(branchRes.stdout)
	if branch == "" {
		branch = "HEAD"
	}
	upstream := ""
	ahead, behind := 0, 0
	if upstreamRes.code == 0 {
		upstream = strings.TrimSpace(upstreamRes.stdout)
	}
	if upstream != "" {
		stdout, _, code, _, err := runLocalGit(request.Context(), root, []string{"rev-list", "--left-right", "--count", "HEAD...@{upstream}"}, true)
		if err != nil {
			writeGitErr(response, err)
			return
		}
		if code == 0 {
			ahead, behind = parseAheadBehind(stdout)
		}
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":       true,
		"branch":   branch,
		"upstream": upstream,
		"ahead":    ahead,
		"behind":   behind,
		"files":    ParsePorcelain(statusRes.stdout),
	})
}

func (handler *Handler) serveLocalDiff(response http.ResponseWriter, request *http.Request, projectPath, filePath string, staged bool) {
	root, ok, authErr := handler.authorizeLocalRoot(request.Context(), projectPath)
	if !ok {
		writeGitErr(response, authErr)
		return
	}
	args := []string{"diff", "--no-ext-diff", "--no-color", "--unified=3"}
	if staged {
		args = append(args, "--cached")
	}
	args = append(args, "--", filePath)
	stdout, _, _, truncated, err := runLocalGit(request.Context(), root, args, false)
	if err != nil {
		writeGitErr(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":        true,
		"path":      filePath,
		"content":   stdout,
		"truncated": truncated,
	})
}

func (handler *Handler) serveRemoteSummary(response http.ResponseWriter, request *http.Request, workspaceID string) {
	ctx, cancel := context.WithTimeout(request.Context(), remoteGitTimeout)
	defer cancel()
	session, err := handler.remote.OpenSession(ctx, workspaceID)
	if err != nil {
		writeRemoteError(response, err)
		return
	}
	defer func() { _ = session.Close() }()

	if _, err := session.Dialect(ctx); err != nil {
		writeRemoteError(response, err)
		return
	}

	type remoteRes struct {
		stdout    string
		stderr    string
		code      int
		truncated bool
		err       error
	}
	run := func(args []string) remoteRes {
		res, execErr := session.RunGit(ctx, args, maxRemoteGitBytes)
		return remoteRes{stdout: string(res.Stdout), stderr: string(res.Stderr), code: res.Code, truncated: res.Truncated, err: execErr}
	}

	var statusRes, branchRes, upstreamRes remoteRes
	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); statusRes = run([]string{"status", "--porcelain=v1", "-z"}) }()
	go func() { defer wg.Done(); branchRes = run([]string{"branch", "--show-current"}) }()
	go func() { defer wg.Done(); upstreamRes = run([]string{"rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"}) }()
	wg.Wait()

	for _, r := range []remoteRes{statusRes, branchRes} {
		if r.err != nil {
			writeRemoteError(response, r.err)
			return
		}
	}
	if statusRes.code != 0 {
		writeGitErr(response, classifyRemoteGitFailure(statusRes.code, statusRes.stdout, statusRes.stderr))
		return
	}
	branch := strings.TrimSpace(branchRes.stdout)
	if branch == "" {
		branch = "HEAD"
	}
	upstream := ""
	ahead, behind := 0, 0
	if upstreamRes.err == nil && upstreamRes.code == 0 {
		upstream = strings.TrimSpace(upstreamRes.stdout)
	}
	if upstream != "" {
		counts := run([]string{"rev-list", "--left-right", "--count", "HEAD...@{upstream}"})
		if counts.err == nil && counts.code == 0 {
			ahead, behind = parseAheadBehind(counts.stdout)
		}
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":       true,
		"branch":   branch,
		"upstream": upstream,
		"ahead":    ahead,
		"behind":   behind,
		"files":    ParsePorcelain(statusRes.stdout),
		"remote":   true,
	})
}

func (handler *Handler) serveRemoteDiff(response http.ResponseWriter, request *http.Request, workspaceID, filePath string, staged bool) {
	ctx, cancel := context.WithTimeout(request.Context(), remoteGitTimeout)
	defer cancel()
	session, err := handler.remote.OpenSession(ctx, workspaceID)
	if err != nil {
		writeRemoteError(response, err)
		return
	}
	defer func() { _ = session.Close() }()

	args := []string{"diff", "--no-ext-diff", "--no-color", "--unified=3"}
	if staged {
		args = append(args, "--cached")
	}
	args = append(args, "--", filePath)
	res, err := session.RunGit(ctx, args, maxRemoteGitBytes)
	if err != nil {
		writeRemoteError(response, err)
		return
	}
	if res.Code != 0 {
		writeGitErr(response, classifyRemoteGitFailure(res.Code, string(res.Stdout), string(res.Stderr)))
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":        true,
		"path":      filePath,
		"content":   string(res.Stdout),
		"truncated": res.Truncated,
	})
}

type gitErr struct {
	status  int
	code    string
	message string
}

func (e *gitErr) Error() string { return e.code + ": " + e.message }

func classifyRemoteGitFailure(code int, stdout, stderr string) error {
	text := strings.TrimSpace(stderr)
	if text == "" {
		text = strings.TrimSpace(stdout)
	}
	if code == 127 || strings.Contains(text, "git: not found") || strings.Contains(text, "git: command not found") {
		return &gitErr{
			status:  http.StatusBadRequest,
			code:    "git_not_installed",
			message: "远端未安装 git，可在「Toolkit → 运行环境」选择该机器安装",
		}
	}
	if strings.Contains(strings.ToLower(text), "not a git repository") {
		return &gitErr{status: http.StatusBadRequest, code: "not_a_git_repository", message: "远程工作区不是 Git 仓库"}
	}
	if text == "" {
		text = fmt.Sprintf("git 退出码 %d", code)
	}
	return &gitErr{status: http.StatusBadRequest, code: "git_failed", message: text}
}

func runLocalGit(ctx context.Context, root string, args []string, allowFailure bool) (string, string, int, bool, error) {
	cmdCtx, cancel := context.WithTimeout(ctx, localGitTimeout)
	defer cancel()
	fullArgs := append([]string{"-C", root, "--no-optional-locks"}, args...)
	cmd := exec.CommandContext(cmdCtx, "git", fullArgs...)
	cmd.Env = append(os.Environ(), "GIT_PAGER=cat", "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	out := &limitedGitBuffer{remaining: maxLocalGitBytes}
	cmd.Stdout = &limitedGitWriter{buf: out, isStderr: false}
	cmd.Stderr = &limitedGitWriter{buf: out, isStderr: true}

	runErr := cmd.Run()
	stdout, stderr, truncated := out.snapshot()
	if runErr == nil {
		return stdout, stderr, 0, truncated, nil
	}
	var exitErr *exec.ExitError
	if !errors.As(runErr, &exitErr) {
		return stdout, stderr, 1, truncated, &gitErr{status: http.StatusBadRequest, code: "git_not_found", message: runErr.Error()}
	}
	code := exitErr.ExitCode()
	if errors.Is(cmdCtx.Err(), context.DeadlineExceeded) {
		return stdout, stderr, code, truncated, &gitErr{status: http.StatusBadRequest, code: "git_timeout", message: "git 命令超时"}
	}
	if allowFailure {
		return stdout, stderr, code, truncated, nil
	}
	msg := strings.TrimSpace(stderr)
	if msg == "" {
		msg = fmt.Sprintf("git 退出码 %d", code)
	}
	return stdout, stderr, code, truncated, &gitErr{status: http.StatusBadRequest, code: "git_failed", message: msg}
}

type limitedGitBuffer struct {
	mu        sync.Mutex
	remaining int
	truncated bool
	stdout    bytes.Buffer
	stderr    bytes.Buffer
}

func (b *limitedGitBuffer) snapshot() (string, string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.stdout.String(), b.stderr.String(), b.truncated
}

type limitedGitWriter struct {
	buf      *limitedGitBuffer
	isStderr bool
}

func (w *limitedGitWriter) Write(p []byte) (int, error) {
	w.buf.mu.Lock()
	defer w.buf.mu.Unlock()
	if w.buf.remaining <= 0 {
		w.buf.truncated = true
		return len(p), nil
	}
	accept := p
	if len(accept) > w.buf.remaining {
		accept = accept[:w.buf.remaining]
		w.buf.truncated = true
	}
	w.buf.remaining -= len(accept)
	if w.isStderr {
		w.buf.stderr.Write(accept)
	} else {
		w.buf.stdout.Write(accept)
	}
	return len(p), nil
}

// ParsePorcelain 解析 git status --porcelain=v1 -z 输出。
func ParsePorcelain(output string) []FileChange {
	raw := strings.Split(output, "\x00")
	records := make([]string, 0, len(raw))
	for _, r := range raw {
		if r != "" {
			records = append(records, r)
		}
	}
	files := make([]FileChange, 0, len(records))
	for i := 0; i < len(records); i++ {
		rec := records[i]
		x, y := byte(' '), byte(' ')
		if len(rec) > 0 {
			x = rec[0]
		}
		if len(rec) > 1 {
			y = rec[1]
		}
		filePath := ""
		if len(rec) > 3 {
			filePath = rec[3:]
		}
		oldPath := ""
		if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
			i++
			if i < len(records) {
				oldPath = records[i]
			}
		}
		files = append(files, FileChange{
			Path:      filePath,
			OldPath:   oldPath,
			Staged:    x != ' ' && x != '?',
			Unstaged:  y != ' ',
			Untracked: x == '?' && y == '?',
			Status:    string([]byte{x, y}),
		})
	}
	return files
}

func parseAheadBehind(output string) (int, int) {
	fields := strings.Fields(strings.TrimSpace(output))
	ahead, behind := 0, 0
	if len(fields) > 0 {
		ahead, _ = strconv.Atoi(fields[0])
	}
	if len(fields) > 1 {
		behind, _ = strconv.Atoi(fields[1])
	}
	return ahead, behind
}

func validRelativePath(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || strings.ContainsRune(trimmed, 0) {
		return "", false
	}
	slashed := strings.ReplaceAll(trimmed, `\`, `/`)
	if strings.HasPrefix(slashed, "/") {
		return "", false
	}
	cleaned := path.Clean(slashed)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") || strings.HasPrefix(cleaned, "/") {
		return "", false
	}
	return cleaned, true
}

func writeGitErr(response http.ResponseWriter, err error) {
	var ge *gitErr
	if errors.As(err, &ge) && ge != nil {
		writeError(response, ge.status, ge.code, ge.message)
		return
	}
	writeError(response, http.StatusBadRequest, "git_failed", err.Error())
}

func writeRemoteError(response http.ResponseWriter, err error) {
	var re *webuiremoteworkspace.RemoteError
	if errors.As(err, &re) && re != nil {
		status := re.Status
		if status <= 0 {
			status = http.StatusBadGateway
		}
		writeError(response, status, re.Code, re.Message)
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
