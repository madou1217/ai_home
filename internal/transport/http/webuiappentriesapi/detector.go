package webuiappentriesapi

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/core/providers"
)

const (
	// entriesCacheTTL 与 Node 的 app-entries 检测器一致：30 秒内复用同一份探测结果，
	// 让 WebUI 反复渲染时不必每次都扫盘。
	entriesCacheTTL = 30 * time.Second
	// providerProbeBudget 是单个 Provider 的探测预算。stat / LookPath 正常都在毫秒级，
	// 预算只用于兜住挂起的网络盘或异常 PATH：超时后停止继续探测，把已确认的结果返回，
	// 并在 budgetExceededProviders 里点名，避免整个请求被一个 Provider 拖住。
	providerProbeBudget = 150 * time.Millisecond

	// 平台键使用 Provider 合同里的取值（不是 runtime.GOOS 的 darwin/win32）。
	platformMacOS   = "macos"
	platformWindows = "windows"
	platformLinux   = "linux"
)

// ProviderCatalog 是探测所需的 Provider 合同来源（生产由 providers.Catalog 实现）。
//
// 只依赖 List：探测按合同的展示顺序遍历，不按 ID 反查。
type ProviderCatalog interface {
	List() []providers.Definition
}

// snapshot 是一次完整探测的结果，probedAt 同时是缓存起点。
//
// 存进缓存后不再修改任何 map，因此并发请求可以共享同一份快照直接序列化。
type snapshot struct {
	entries        map[string]entryView
	capabilities   map[string]capabilityView
	probedAt       time.Time
	budgetExceeded []string
}

// detector 是进程级探测单例：持有 30 秒缓存，并负责把合同翻译成宿主机事实。
type detector struct {
	catalog     ProviderCatalog
	hostHomeDir string
	lookPath    func(string) (string, error)
	searchDirs  []string
	now         func() time.Time
	platform    string

	mu     sync.Mutex
	cached *snapshot
}

func newDetector(dependencies Dependencies, catalog ProviderCatalog) *detector {
	lookPath := dependencies.LookPath
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	now := dependencies.Now
	if now == nil {
		now = time.Now
	}
	hostHomeDir := strings.TrimSpace(dependencies.HostHomeDir)
	platform := resolvePlatformKey(runtime.GOOS)
	return &detector{
		catalog:     catalog,
		hostHomeDir: hostHomeDir,
		lookPath:    lookPath,
		searchDirs:  defaultSearchDirs(hostHomeDir, platform),
		now:         now,
		platform:    platform,
	}
}

// detect 返回当前快照；refresh 为 true 时跳过缓存重新探测。
//
// 第二个返回值表示本次是否直接命中了缓存，供响应里的 cached 字段使用。
func (detector *detector) detect(refresh bool) (snapshot, bool) {
	detector.mu.Lock()
	defer detector.mu.Unlock()
	now := detector.now()
	if !refresh && detector.cached != nil && now.Sub(detector.cached.probedAt) < entriesCacheTTL {
		return *detector.cached, true
	}
	entries, capabilities, budgetExceeded := detector.probe()
	detector.cached = &snapshot{
		entries:        entries,
		capabilities:   capabilities,
		probedAt:       detector.now(),
		budgetExceeded: budgetExceeded,
	}
	return *detector.cached, false
}

// probe 遍历 Provider 合同，逐个探测桌面 App 与 CLI 入口。
//
// 只做存在性 / 可执行性判断（LookPath + stat），绝不启动进程或打开 App。
// 没有 CLI 合同的 Provider 与 Node 一致：整体跳过，不产生条目。
func (detector *detector) probe() (map[string]entryView, map[string]capabilityView, []string) {
	entries := make(map[string]entryView)
	capabilities := make(map[string]capabilityView)
	budgetExceeded := make([]string, 0)

	for _, definition := range detector.catalog.List() {
		if definition.CLI == nil {
			continue
		}
		budget := newProbeBudget(detector.now, providerProbeBudget)
		platformConfig := desktopPlatformFor(definition.CLI.DesktopClient, detector.platform)
		desktop := false
		if definition.Clients.Desktop && platformConfig != nil {
			desktop = detector.desktopInstalled(platformConfig, budget)
		}
		binaryName := strings.TrimSpace(definition.CLI.BinaryName)
		if binaryName == "" {
			// 与 Node 一致：没有显式 BinaryName 时按 Provider ID 找同名可执行文件。
			binaryName = definition.ID
		}
		cli := false
		if definition.Clients.CLI && binaryName != "" {
			cli = detector.findExecutable([]string{binaryName}, budget)
		}
		entries[definition.ID] = entryView{Desktop: desktop, CLI: cli}

		label := strings.TrimSpace(definition.Presentation.Label)
		if label == "" {
			label = definition.ID
		}
		capabilities[definition.ID] = capabilityView{
			Desktop:         definition.Clients.Desktop && platformConfig != nil,
			CLI:             definition.Clients.CLI && binaryName != "",
			Label:           label,
			ExternalHarness: false,
		}
		if budget.exhausted {
			budgetExceeded = append(budgetExceeded, definition.ID)
		}
	}
	return entries, capabilities, budgetExceeded
}

// desktopInstalled 按平台解析桌面客户端是否已安装。
//
// macOS 以 manifest 的 installPaths（.app bundle）为准，与 Node 相同：bundle 存在即视为
// 已安装，不再要求内部可执行文件可见。Windows 先查 manifest 安装路径与常见安装根目录，
// 再回落到 PATH。Linux 只有 PATH 一种入口。
func (detector *detector) desktopInstalled(platformConfig *providers.DesktopPlatform, budget *probeBudget) bool {
	switch detector.platform {
	case platformMacOS:
		return detector.macOSBundleExists(platformConfig, budget)
	case platformWindows:
		for _, candidate := range windowsDesktopCandidates(platformConfig) {
			if budget.over() {
				return false
			}
			if pathExists(candidate) {
				return true
			}
		}
	}
	return detector.findExecutable(platformConfig.ExecNames, budget)
}

// macOSBundleExists 展开 {hostHomeDir} 占位符后检查 bundle 是否存在。
func (detector *detector) macOSBundleExists(platformConfig *providers.DesktopPlatform, budget *probeBudget) bool {
	for _, rawPath := range platformConfig.InstallPaths {
		if budget.over() {
			return false
		}
		candidate := strings.TrimSpace(strings.ReplaceAll(rawPath, "{hostHomeDir}", detector.hostHomeDir))
		if candidate == "" {
			continue
		}
		if pathExists(candidate) {
			return true
		}
	}
	return false
}

// findExecutable 依次尝试 PATH（LookPath）与固定安装落点目录。
//
// 固定目录只覆盖安装器写死的落点，不遍历全盘：LookPath 已经负责 PATH 语义
// （含可执行位判断），固定目录补的是后台 Server 继承的最小 PATH 缺失的
// $HOME/.local/bin 与 Homebrew 前缀。
func (detector *detector) findExecutable(names []string, budget *probeBudget) bool {
	for _, rawName := range names {
		name := strings.TrimSpace(rawName)
		if name == "" {
			continue
		}
		if budget.over() {
			return false
		}
		if _, err := detector.lookPath(name); err == nil {
			return true
		}
		for _, directory := range detector.searchDirs {
			if budget.over() {
				return false
			}
			for _, candidateName := range executableNameVariants(name, detector.platform) {
				if isExecutableFile(filepath.Join(directory, candidateName), detector.platform) {
					return true
				}
			}
		}
	}
	return false
}

// probeBudget 是单个 Provider 的探测预算；耗尽后固定为 true，调用方停止继续 stat。
type probeBudget struct {
	now       func() time.Time
	deadline  time.Time
	exhausted bool
}

func newProbeBudget(now func() time.Time, budget time.Duration) *probeBudget {
	return &probeBudget{now: now, deadline: now().Add(budget)}
}

func (budget *probeBudget) over() bool {
	if budget.exhausted {
		return true
	}
	if budget.now().After(budget.deadline) {
		budget.exhausted = true
	}
	return budget.exhausted
}

// resolvePlatformKey 把 runtime.GOOS 归一到 Provider 合同的平台键。
func resolvePlatformKey(goos string) string {
	switch strings.ToLower(strings.TrimSpace(goos)) {
	case "darwin":
		return platformMacOS
	case "windows":
		return platformWindows
	default:
		return platformLinux
	}
}

// defaultSearchDirs 是 LookPath 之外的固定候选目录。
func defaultSearchDirs(hostHomeDir string, platform string) []string {
	directories := make([]string, 0, 3)
	if hostHomeDir != "" {
		directories = append(directories, filepath.Join(hostHomeDir, ".local", "bin"))
	}
	if platform != platformWindows {
		directories = append(directories, "/usr/local/bin", "/opt/homebrew/bin")
	}
	return directories
}

// desktopPlatformFor 取当前平台对应的桌面客户端声明；未声明时返回 nil。
func desktopPlatformFor(client *providers.DesktopClient, platform string) *providers.DesktopPlatform {
	if client == nil {
		return nil
	}
	switch platform {
	case platformMacOS:
		return client.MacOS
	case platformWindows:
		return client.Windows
	case platformLinux:
		return client.Linux
	}
	return nil
}

// windowsDesktopCandidates 组合 manifest installPaths 与常见安装目录。
func windowsDesktopCandidates(platformConfig *providers.DesktopPlatform) []string {
	clientName := strings.TrimSpace(platformConfig.ClientName)
	execNames := trimmedList(platformConfig.ExecNames)
	candidates := append([]string(nil), trimmedList(platformConfig.InstallPaths)...)
	roots := make([]string, 0, 3)
	if clientName != "" {
		if localAppData := readEnvVar("LOCALAPPDATA"); localAppData != "" {
			roots = append(roots, filepath.Join(localAppData, "Programs", clientName))
		}
		if programFiles := readEnvVar("ProgramFiles"); programFiles != "" {
			roots = append(roots, filepath.Join(programFiles, clientName))
		}
		if programFilesX86 := readEnvVar("ProgramFiles(x86)"); programFilesX86 != "" {
			roots = append(roots, filepath.Join(programFilesX86, clientName))
		}
	}
	for _, root := range roots {
		for _, execName := range execNames {
			candidates = append(candidates, filepath.Join(root, execName))
		}
	}
	return candidates
}

// executableNameVariants 在 Windows 上补 .exe 候选；其它平台原样返回。
func executableNameVariants(name string, platform string) []string {
	if platform != platformWindows || strings.Contains(name, ".") {
		return []string{name}
	}
	return []string{name, name + ".exe"}
}

// isExecutableFile 要求候选是文件且具备可执行位（Windows 不区分可执行位）。
func isExecutableFile(candidate string, platform string) bool {
	info, err := os.Stat(candidate)
	if err != nil || info.IsDir() {
		return false
	}
	if platform == platformWindows {
		return true
	}
	return info.Mode().Perm()&0o111 != 0
}

func pathExists(candidate string) bool {
	if candidate == "" {
		return false
	}
	_, err := os.Stat(candidate)
	return err == nil
}

// readEnvVar 按大小写不敏感读取环境变量：Windows 上 os.Environ 保留存储大小写
// （如 PROGRAMFILES），直接精确匹配会漏读安装目录。
func readEnvVar(key string) string {
	if value, found := os.LookupEnv(key); found && value != "" {
		return value
	}
	lower := strings.ToLower(key)
	for _, entry := range os.Environ() {
		name, value, ok := strings.Cut(entry, "=")
		if ok && strings.ToLower(name) == lower {
			return value
		}
	}
	return ""
}

func trimmedList(values []string) []string {
	trimmed := make([]string, 0, len(values))
	for _, value := range values {
		if text := strings.TrimSpace(value); text != "" {
			trimmed = append(trimmed, text)
		}
	}
	return trimmed
}

// isDesktopHost 与 Node 的判定同义：macOS / Windows 恒为桌面宿主；
// Linux 取决于是否有图形会话信号。
func isDesktopHost(platform string) bool {
	switch platform {
	case platformMacOS, platformWindows:
		return true
	case platformLinux:
		return strings.TrimSpace(os.Getenv("DISPLAY")) != "" ||
			strings.TrimSpace(os.Getenv("WAYLAND_DISPLAY")) != ""
	}
	return false
}
