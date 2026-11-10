// Package webuitoolkitruntimeapi 提供 toolkit 运行环境的只读探测投影。
//
// 契约来源是 Node 的 GET /v0/webui/toolkit/environments（lib/server/webui-environment-routes.js
// 的 handleWebUiEnvironmentRoutes 分支）：工具清单、平台过滤、版本解析口径都以
// lib/cli/services/toolkit/environment/{catalog,plugins,probe}.js 为准。
//
// 边界：这里只做「本机运行时探测读」，不复制 Node 的安装 / 更新 / 卸载计划
// （plan/execute/jobs），也不产出 Node 的 runtimes / environments 旧形状。
// 字段映射：
//   - Node resources[].installed      → available
//   - Node resources[].executablePath → path
//   - Node resources[].version        → version
//   - versionStatus 是 Go 侧新增标注：Node 取不到版本时只留空，Go 必须说明原因
//     （ok / empty / timeout / error / missing）。
//
// 探测成本：每个工具一次子进程，全部并发，单个工具上限 1s；版本取不到只降级为空串，
// 不阻塞也不拖慢整个响应。
package webuitoolkitruntimeapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// Path 是运行环境探测的只读管理契约。
	Path = "/v1/management/webui/toolkit/environments"

	// derivedByGoPartial 标注响应只包含 Go 能证明的字段，调用方不得把它当成 Node 全量形状。
	derivedByGoPartial = "go_partial"
)

// versionProbeTimeout 是单个工具取版本的上限；超时只降级版本字段。
const versionProbeTimeout = time.Second

// 版本探测结果标注。
const (
	versionStatusOK      = "ok"
	versionStatusEmpty   = "empty"
	versionStatusTimeout = "timeout"
	versionStatusError   = "error"
	versionStatusMissing = "missing"
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权策略。
var ErrInvalidDependencies = errors.New("运行环境探测接口依赖无效")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总只读探测依赖。
//
// LookPath 与 RunVersion 可注入：前者定位可执行文件，后者执行 `<可执行文件> args` 并返回
// 原始输出（stdout+stderr 合并）。两者都为 nil 时使用真实子进程；RunVersion 自带 1s 超时。
type Dependencies struct {
	Authorizer  Authorizer
	HostHomeDir string
	LookPath    func(string) (string, error)
	RunVersion  func(ctx context.Context, executable string, args []string) (string, error)
}

// Handler 处理运行环境探测读取。
type Handler struct {
	authorizer Authorizer
	homeDir    string
	lookPath   func(string) (string, error)
	runVersion func(ctx context.Context, executable string, args []string) (string, error)
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (http.Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	handler := &Handler{
		authorizer: dependencies.Authorizer,
		homeDir:    strings.TrimSpace(dependencies.HostHomeDir),
		lookPath:   dependencies.LookPath,
		runVersion: dependencies.RunVersion,
	}
	if handler.homeDir == "" {
		// Node 的 resolveHostHome 在 hostHomeDir 缺失时回落到进程 HOME。
		if home, err := os.UserHomeDir(); err == nil {
			handler.homeDir = strings.TrimSpace(home)
		}
	}
	if handler.lookPath == nil {
		handler.lookPath = exec.LookPath
	}
	if handler.runVersion == nil {
		handler.runVersion = runCommandVersion
	}
	return handler, nil
}

// ToolView 是单个运行时 / 包管理器 / 工具链的探测结果。
type ToolView struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	Runtime       string `json:"runtime"`
	Category      string `json:"category"`
	Description   string `json:"description"`
	Available     bool   `json:"available"`
	Version       string `json:"version"`
	Path          string `json:"path"`
	VersionStatus string `json:"versionStatus"`
}

type responseView struct {
	OK             bool       `json:"ok"`
	Platform       string     `json:"platform"`
	ProbedAt       int64      `json:"probedAt"`
	DerivedBy      string     `json:"derivedBy"`
	Tools          []ToolView `json:"tools"`
	AvailableCount int        `json:"availableCount"`
	Total          int        `json:"total"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只接受 GET。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.lookPath == nil || handler.runVersion == nil {
		writeError(response, http.StatusServiceUnavailable, "runtime_probe_unavailable", "运行环境探测服务不可用")
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
	platform := currentPlatform()
	tools := handler.probeAll(request.Context(), platform)
	available := 0
	for _, tool := range tools {
		if tool.Available {
			available++
		}
	}
	writeJSON(response, http.StatusOK, responseView{
		OK:             true,
		Platform:       platform,
		ProbedAt:       time.Now().UnixMilli(),
		DerivedBy:      derivedByGoPartial,
		Tools:          tools,
		AvailableCount: available,
		Total:          len(tools),
	})
}

// probeAll 并发探测，保证总耗时接近单个工具上限而不是工具数乘上限。
func (handler *Handler) probeAll(ctx context.Context, platform string) []ToolView {
	specs := toolsForPlatform(platform)
	views := make([]ToolView, len(specs))
	var group sync.WaitGroup
	for index, spec := range specs {
		group.Add(1)
		go func(index int, spec toolSpec) {
			defer group.Done()
			views[index] = handler.probeTool(ctx, spec)
		}(index, spec)
	}
	group.Wait()
	return views
}

func (handler *Handler) probeTool(ctx context.Context, spec toolSpec) ToolView {
	view := ToolView{
		ID:            spec.ID,
		Name:          spec.Name,
		Runtime:       spec.Runtime,
		Category:      spec.Category,
		Description:   spec.Description,
		VersionStatus: versionStatusMissing,
	}
	switch spec.Kind {
	case kindNVM:
		return handler.probeNVM(view)
	case kindPyenv:
		return handler.probePyenv(ctx, view, spec)
	case kindConda:
		return handler.probeConda(ctx, view, spec)
	default:
		return handler.probeCommandTool(ctx, view, spec)
	}
}

// probeCommandTool 复刻 Node 的 probeCommand：先按 PATH 找，再按插件声明的已知安装位置兜底
// （launchd / systemd 的 PATH 通常不含 ~/.cargo/bin、~/.local/go/bin）。
func (handler *Handler) probeCommandTool(ctx context.Context, view ToolView, spec toolSpec) ToolView {
	executable, found := handler.resolveExecutable(spec)
	view.Path = executable
	if !found {
		return view
	}
	view.Available = true
	output, status := handler.versionOutput(ctx, executable, spec.Args)
	if status != versionStatusOK {
		view.VersionStatus = status
		return view
	}
	view.Version, view.VersionStatus = parseVersion(spec, output)
	return view
}

// probeNVM：nvm 不是可执行命令，只认 ~/.nvm 目录与 versions/node 下的版本目录。
func (handler *Handler) probeNVM(view ToolView) ToolView {
	root := filepath.Join(handler.homeDir, ".nvm")
	view.Path = root
	if !isDirectory(root) {
		return view
	}
	view.Available = true
	versions := listDirectories(filepath.Join(root, "versions", "node"))
	if len(versions) == 0 {
		view.VersionStatus = versionStatusEmpty
		return view
	}
	view.Version = countLabel(len(versions), "个 Node.js 版本")
	view.VersionStatus = versionStatusOK
	return view
}

// probePyenv：命令探测成功即可用；命令缺失时 ~/.pyenv 存在也算已安装。
func (handler *Handler) probePyenv(ctx context.Context, view ToolView, spec toolSpec) ToolView {
	root := filepath.Join(handler.homeDir, ".pyenv")
	versions := listDirectories(filepath.Join(root, "versions"))
	executable := handler.which(spec.Command)
	view.Path = executable
	if view.Path == "" {
		view.Path = root
	}
	// 命令没定位到时不要盲跑（否则「找不到」会被误判成「版本为空」）。
	if executable != "" {
		if output, status := handler.versionOutput(ctx, executable, spec.Args); status == versionStatusOK {
			view.Available = true
			view.Version, view.VersionStatus = parseVersion(spec, output)
			return view
		}
	}
	if !isDirectory(root) {
		return view
	}
	view.Available = true
	if len(versions) == 0 {
		view.VersionStatus = versionStatusEmpty
		return view
	}
	view.Version = countLabel(len(versions), "个 Python 版本")
	view.VersionStatus = versionStatusOK
	return view
}

// probeConda：命令探测成功即可用；命令缺失时 ~/miniconda3、~/anaconda3 存在也算已安装。
func (handler *Handler) probeConda(ctx context.Context, view ToolView, spec toolSpec) ToolView {
	root := ""
	for _, candidate := range []string{
		filepath.Join(handler.homeDir, "miniconda3"),
		filepath.Join(handler.homeDir, "anaconda3"),
	} {
		if isDirectory(candidate) {
			root = candidate
			break
		}
	}
	executable := handler.which(spec.Command)
	view.Path = executable
	if view.Path == "" {
		view.Path = root
	}
	if executable != "" {
		if output, status := handler.versionOutput(ctx, executable, spec.Args); status == versionStatusOK {
			view.Available = true
			view.Version, view.VersionStatus = parseVersion(spec, output)
			return view
		}
	}
	if root == "" {
		return view
	}
	view.Available = true
	// Node 在这里给的是「已安装」占位串而不是版本号，照抄。
	view.Version = "已安装"
	view.VersionStatus = versionStatusOK
	return view
}

func (handler *Handler) which(command string) string {
	if command == "" {
		return ""
	}
	path, err := handler.lookPath(command)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(path)
}

// resolveExecutable 先查 PATH，再按已知安装位置兜底；相对路径以宿主 HOME 为基准。
// 兜底同样走 LookPath（对绝对路径即「该文件存在且可执行」），这样探测行为可被完整注入。
func (handler *Handler) resolveExecutable(spec toolSpec) (string, bool) {
	if path := handler.which(spec.Command); path != "" {
		return path, true
	}
	for _, raw := range spec.KnownPaths {
		base := strings.TrimSpace(raw)
		if base == "" {
			continue
		}
		if !filepath.IsAbs(base) {
			if handler.homeDir == "" {
				continue
			}
			base = filepath.Join(handler.homeDir, base)
		}
		candidates := []string{base}
		if isWindowsPlatform() && !strings.HasSuffix(strings.ToLower(base), ".exe") {
			candidates = []string{base + ".exe", base}
		}
		for _, candidate := range candidates {
			if path := handler.which(candidate); path != "" {
				return path, true
			}
		}
	}
	return "", false
}

// versionOutput 执行一次取版本命令；失败只返回标注，不影响「可执行文件是否存在」的判定。
func (handler *Handler) versionOutput(ctx context.Context, executable string, args []string) (string, string) {
	if executable == "" {
		return "", versionStatusMissing
	}
	output, err := handler.runVersion(ctx, executable, args)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", versionStatusTimeout
		}
		return "", versionStatusError
	}
	return output, versionStatusOK
}

// runCommandVersion 是默认取版本实现：合并输出、1s 超时、超时即杀掉子进程。
func runCommandVersion(ctx context.Context, executable string, args []string) (string, error) {
	runCtx, cancel := context.WithTimeout(ctx, versionProbeTimeout)
	defer cancel()
	command := exec.CommandContext(runCtx, executable, args...)
	output, err := command.CombinedOutput()
	if runCtx.Err() != nil {
		return "", runCtx.Err()
	}
	if err != nil {
		return "", err
	}
	return string(output), nil
}

// parseVersion 按工具的解析口径取版本；解析不到就是空串 + empty。
func parseVersion(spec toolSpec, output string) (string, string) {
	parse := spec.ParseVersion
	if parse == nil {
		parse = firstLine
	}
	version := strings.TrimSpace(parse(output))
	if version == "" {
		return "", versionStatusEmpty
	}
	return version, versionStatusOK
}

func currentPlatform() string {
	switch runtime.GOOS {
	case "darwin":
		return "macos"
	case "windows":
		return "windows"
	default:
		return "linux"
	}
}

func isWindowsPlatform() bool { return currentPlatform() == "windows" }

func isDirectory(target string) bool {
	if target == "" {
		return false
	}
	info, err := os.Stat(target)
	return err == nil && info.IsDir()
}

func listDirectories(directory string) []string {
	if directory == "" {
		return nil
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		names = append(names, entry.Name())
	}
	return names
}

func countLabel(count int, unit string) string {
	return strconv.Itoa(count) + " " + unit
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
