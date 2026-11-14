package codexhooks

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// DesktopHookStateVersion 是 desktop-hook-state.json 的当前数据结构版本。
	DesktopHookStateVersion = 2
	// DesktopStateRelativePath 是相对于 AI_HOME 的桌面端 hook 状态文件路径。
	DesktopStateRelativePath = "run/codex/desktop-hook-state.json"

	desktopProcessAncestorLimit = 12
)

// BundleMetadata 保存桌面端 .app 包内 Info.plist 提取的版本字段。
type BundleMetadata struct {
	AppVersion      string
	AppBuildVersion string
}

// DesktopHookPaths 表示解析出的桌面端 bundle 与包装目标路径。
type DesktopHookPaths struct {
	BundlePath         string `json:"bundlePath"`
	TargetBinaryPath   string `json:"targetBinaryPath"`
	UpstreamBinaryPath string `json:"upstreamBinaryPath"`
	LayoutID           string `json:"layoutId,omitempty"`
	HookStrategy       string `json:"hookStrategy,omitempty"`
	Reason             string `json:"reason,omitempty"`
}

// DesktopHookState 表示持久化的 desktop-hook-state.json（v2）。
type DesktopHookState struct {
	Version                 int              `json:"version"`
	Enabled                 bool             `json:"enabled"`
	UpdatedAt               string           `json:"updatedAt,omitempty"`
	BundlePath              string           `json:"bundlePath,omitempty"`
	TargetBinaryPath        string           `json:"targetBinaryPath,omitempty"`
	UpstreamBinaryPath      string           `json:"upstreamBinaryPath,omitempty"`
	HookStrategy            string           `json:"hookStrategy,omitempty"`
	HelperScriptPath        string           `json:"helperScriptPath,omitempty"`
	HelperScriptMtimeMs     int64            `json:"helperScriptMtimeMs,omitempty"`
	HelperRevision          string           `json:"helperRevision,omitempty"`
	AppVersion              string           `json:"appVersion,omitempty"`
	AppBuildVersion         string           `json:"appBuildVersion,omitempty"`
	CodexVersion            string           `json:"codexVersion,omitempty"`
	WrapperRevision         string           `json:"wrapperRevision,omitempty"`
	UpstreamFingerprint     *FileFingerprint `json:"upstreamFingerprint,omitempty"`
	TraceFile               string           `json:"traceFile,omitempty"`
	TraceResponses          bool             `json:"traceResponses,omitempty"`
	TraceRemoteControl      bool             `json:"traceRemoteControl,omitempty"`
	RemoteControlProxy      bool             `json:"remoteControlProxy,omitempty"`
	ProviderHookReceiverURL string           `json:"providerHookReceiverUrl,omitempty"`
	DesktopAccountRef       string           `json:"desktopAccountRef,omitempty"`
	Reason                  string           `json:"reason,omitempty"`
	ErrorCode               string           `json:"errorCode,omitempty"`
	Retryable               *bool            `json:"retryable,omitempty"`
}

// DesktopTraceConfig 控制桌面端代理日志追踪与 remote-control 代理开关。
type DesktopTraceConfig struct {
	TraceFile          string
	TraceResponses     bool
	TraceRemoteControl bool
	RemoteControlProxy bool
}

// DesktopHookResult 描述 Desktop Hook 激活、校验与停用结果。
type DesktopHookResult struct {
	OK                  bool     `json:"ok"`
	Supported           bool     `json:"supported"`
	Enabled             bool     `json:"enabled"`
	Installed           bool     `json:"installed,omitempty"`
	Updated             bool     `json:"updated,omitempty"`
	Healthy             bool     `json:"healthy,omitempty"`
	Repaired            bool     `json:"repaired,omitempty"`
	HelperScriptChanged bool     `json:"helperScriptChanged,omitempty"`
	RestartRequired     bool     `json:"restartRequired,omitempty"`
	Retryable           *bool    `json:"retryable,omitempty"`
	Reason              string   `json:"reason,omitempty"`
	ErrorCode           string   `json:"errorCode,omitempty"`
	BundlePath          string   `json:"bundlePath,omitempty"`
	TargetBinaryPath    string   `json:"targetBinaryPath,omitempty"`
	UpstreamBinaryPath  string   `json:"upstreamBinaryPath,omitempty"`
	DriftReasons        []string `json:"driftReasons,omitempty"`
	StateFilePath       string   `json:"stateFilePath,omitempty"`
}

// DesktopTraceResult 描述 trace 配置更新结果。
type DesktopTraceResult struct {
	OK                 bool   `json:"ok"`
	StateFilePath      string `json:"stateFilePath,omitempty"`
	TraceFile          string `json:"traceFile,omitempty"`
	TraceResponses     bool   `json:"traceResponses"`
	TraceRemoteControl bool   `json:"traceRemoteControl"`
	RemoteControlProxy bool   `json:"remoteControlProxy"`
	Changed            bool   `json:"changed"`
}

// AccountRefMutationResult 描述 desktopAccountRef 的修改结果。
type AccountRefMutationResult struct {
	OK                bool   `json:"ok"`
	StateFilePath     string `json:"stateFilePath,omitempty"`
	DesktopAccountRef string `json:"desktopAccountRef,omitempty"`
	Changed           bool   `json:"changed"`
	Reason            string `json:"reason,omitempty"`
}

// ProcessInfo 表示本机进程表中的一条记录。
type ProcessInfo struct {
	PID       int    `json:"pid"`
	ParentPID int    `json:"parentPid"`
	Command   string `json:"command"`
}

// RestartAppServersResult 记录已发送 SIGTERM 重启的 app-server 进程列表。
type RestartAppServersResult struct {
	OK    bool  `json:"ok"`
	Count int   `json:"count"`
	PIDs  []int `json:"pids"`
}

// DesktopHookOptions 配置 DesktopHookService 的路径、平台与测试注入钩子。
type DesktopHookOptions struct {
	AIHomeDir               string
	HostHomeDir             string
	Platform                string
	NodeExecPath            string
	HelperScriptPath        string
	ProviderHookReceiverURL string
	RuntimeLayouts          []DesktopLayout
	AllowSystemApplications *bool
	ProcessHomeDir          string
	OSUserHomeDir           string
	SelfPID                 int
	Now                     func() time.Time
	ReadBundleMetadata      func(bundlePath string) BundleMetadata
	ReadCodexVersion        func(upstreamBinaryPath string) string
	ListProcesses           func() ([]ProcessInfo, error)
	KillProcess             func(pid int) error
}

// DesktopHookService 管理 Codex macOS 桌面应用（ChatGPT.app / Codex.app）的 hook 生命周期。
type DesktopHookService struct {
	aiHomeDir               string
	hostHomeDir             string
	platform                string
	nodeExecPath            string
	helperScriptPath        string
	providerHookReceiverURL string
	stateFilePath           string
	runtimeLayouts          []DesktopLayout
	allowSystemApplications *bool
	processHomeDir          string
	osUserHomeDir           string
	selfPID                 int
	now                     func() time.Time
	readBundleMetadataFn    func(bundlePath string) BundleMetadata
	readCodexVersionFn      func(upstreamBinaryPath string) string
	listProcessesFn         func() ([]ProcessInfo, error)
	killProcessFn           func(pid int) error

	mu sync.Mutex
}

// NewDesktopHookService 创建 Codex 桌面端 hook 管理服务。
func NewDesktopHookService(opts DesktopHookOptions) *DesktopHookService {
	aiHome := strings.TrimSpace(opts.AIHomeDir)
	stateFilePath := ""
	if aiHome != "" {
		stateFilePath = filepath.Join(aiHome, "run", "codex", "desktop-hook-state.json")
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	selfPID := opts.SelfPID
	if selfPID == 0 {
		selfPID = os.Getpid()
	}
	return &DesktopHookService{
		aiHomeDir:               aiHome,
		hostHomeDir:             strings.TrimSpace(opts.HostHomeDir),
		platform:                NormalizePlatform(opts.Platform),
		nodeExecPath:            strings.TrimSpace(opts.NodeExecPath),
		helperScriptPath:        strings.TrimSpace(opts.HelperScriptPath),
		providerHookReceiverURL: strings.TrimSpace(opts.ProviderHookReceiverURL),
		stateFilePath:           stateFilePath,
		runtimeLayouts:          opts.RuntimeLayouts,
		allowSystemApplications: opts.AllowSystemApplications,
		processHomeDir:          strings.TrimSpace(opts.ProcessHomeDir),
		osUserHomeDir:           strings.TrimSpace(opts.OSUserHomeDir),
		selfPID:                 selfPID,
		now:                     nowFn,
		readBundleMetadataFn:    opts.ReadBundleMetadata,
		readCodexVersionFn:      opts.ReadCodexVersion,
		listProcessesFn:         opts.ListProcesses,
		killProcessFn:           opts.KillProcess,
	}
}

// StateFilePath 返回 desktop-hook-state.json 的路径。
func (svc *DesktopHookService) StateFilePath() string {
	return svc.stateFilePath
}

// BuildWrapperScript 生成桌面端使用的 POSIX app-server 包装脚本文本。
func (svc *DesktopHookService) BuildWrapperScript(upstreamBinaryPath string) string {
	return BuildCodexAppServerWrapperScript(WrapperMarkerDesktop, WrapperOptions{
		NodeExecPath:       svc.nodeExecPath,
		HelperScriptPath:   svc.helperScriptPath,
		UpstreamBinaryPath: upstreamBinaryPath,
		StateFilePath:      svc.stateFilePath,
	})
}

// IsWrapperInstalled 判断目标路径是否已是桌面端包装器。
func (svc *DesktopHookService) IsWrapperInstalled(targetBinaryPath string) bool {
	if !fileExists(targetBinaryPath) {
		return false
	}
	info, err := os.Stat(targetBinaryPath)
	if err != nil || info.IsDir() || info.Size() > 64*1024 {
		return false
	}
	return readFileMarkerPrefix(targetBinaryPath, WrapperMarkerDesktop)
}

func (svc *DesktopHookService) allowSystemApplicationsScan() bool {
	if svc.allowSystemApplications != nil {
		return *svc.allowSystemApplications
	}
	if svc.hostHomeDir == "" {
		return false
	}
	processHome := svc.processHomeDir
	if processHome == "" {
		processHome = strings.TrimSpace(os.Getenv("AIH_HOST_HOME"))
	}
	if processHome == "" {
		processHome = strings.TrimSpace(os.Getenv("HOME"))
	}
	if processHome == "" {
		processHome = strings.TrimSpace(os.Getenv("USERPROFILE"))
	}
	osHome := svc.osUserHomeDir
	if osHome == "" {
		if detected, err := os.UserHomeDir(); err == nil {
			osHome = strings.TrimSpace(detected)
		}
	}
	if processHome == "" || osHome == "" {
		return false
	}
	absHost, err1 := filepath.Abs(svc.hostHomeDir)
	absProc, err2 := filepath.Abs(processHome)
	absOS, err3 := filepath.Abs(osHome)
	return err1 == nil && err2 == nil && err3 == nil && absProc == absHost && absHost == absOS
}

func readDesktopClientCachedBundle(aiHomeDir string) string {
	if strings.TrimSpace(aiHomeDir) == "" {
		return ""
	}
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	raw, found, err := appstate.ReadKV(ctx, dbPath, "desktop-client-paths")
	if err != nil || !found || strings.TrimSpace(raw) == "" {
		return ""
	}
	var payload struct {
		Codex struct {
			MacOS struct {
				BundlePath string `json:"bundlePath"`
			} `json:"macos"`
		} `json:"codex"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return ""
	}
	return strings.TrimSpace(payload.Codex.MacOS.BundlePath)
}

func isWithinHostBoundary(hostHomeDir string, candidate string) bool {
	absHost, err1 := filepath.Abs(hostHomeDir)
	absCandidate, err2 := filepath.Abs(candidate)
	if err1 != nil || err2 != nil {
		return false
	}
	rel, err := filepath.Rel(absHost, absCandidate)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// ResolvePaths 查找可用的 Codex Desktop .app 包并解析包装目标路径。
func (svc *DesktopHookService) ResolvePaths() DesktopHookPaths {
	if svc.platform != "darwin" {
		return DesktopHookPaths{Reason: "unsupported_platform"}
	}
	if svc.hostHomeDir == "" {
		return DesktopHookPaths{Reason: "host_home_required"}
	}

	allowSystem := svc.allowSystemApplicationsScan()
	var candidates []string
	if learned := readDesktopClientCachedBundle(svc.aiHomeDir); learned != "" {
		candidates = append(candidates, learned)
	}
	for _, bundleName := range CodexDesktopBundleNames {
		candidates = append(candidates, filepath.Join(svc.hostHomeDir, "Applications", bundleName))
	}
	if allowSystem {
		for _, bundleName := range CodexDesktopBundleNames {
			candidates = append(candidates, filepath.Join("/Applications", bundleName))
		}
	}

	for _, candidate := range candidates {
		if strings.TrimSpace(candidate) == "" {
			continue
		}
		if !allowSystem && !isWithinHostBoundary(svc.hostHomeDir, candidate) {
			continue
		}
		if !fileExists(candidate) {
			continue
		}
		layout, executablePath, ok := ResolveDesktopLayout(candidate, "darwin", svc.runtimeLayouts)
		if !ok {
			continue
		}
		if layout.HookStrategy == HookStrategyExternalLauncher && svc.aiHomeDir == "" {
			return DesktopHookPaths{Reason: "state_file_unavailable"}
		}
		if layout.HookStrategy == HookStrategyExternalLauncher {
			return DesktopHookPaths{
				BundlePath:         candidate,
				TargetBinaryPath:   filepath.Join(svc.aiHomeDir, "run", "codex", "desktop-cli"),
				UpstreamBinaryPath: executablePath,
				LayoutID:           layout.ID,
				HookStrategy:       HookStrategyExternalLauncher,
			}
		}
		return DesktopHookPaths{
			BundlePath:         candidate,
			TargetBinaryPath:   executablePath,
			UpstreamBinaryPath: executablePath + ".aih-original",
			LayoutID:           layout.ID,
		}
	}

	return DesktopHookPaths{Reason: "codex_app_not_found"}
}

func readXMLPlistString(content string, key string) string {
	pattern, err := regexp.Compile(`<key>` + regexp.QuoteMeta(key) + `</key>\s*<string>([^<]*)</string>`)
	if err != nil {
		return ""
	}
	matches := pattern.FindStringSubmatch(content)
	if len(matches) < 2 {
		return ""
	}
	return strings.TrimSpace(matches[1])
}

func (svc *DesktopHookService) readBundleMetadata(bundlePath string) BundleMetadata {
	if svc.readBundleMetadataFn != nil {
		return svc.readBundleMetadataFn(bundlePath)
	}
	infoPlist := filepath.Join(bundlePath, "Contents", "Info.plist")
	if !fileExists(infoPlist) {
		return BundleMetadata{}
	}
	if content, err := os.ReadFile(infoPlist); err == nil {
		text := string(content)
		appVer := readXMLPlistString(text, "CFBundleShortVersionString")
		buildVer := readXMLPlistString(text, "CFBundleVersion")
		if appVer != "" || buildVer != "" {
			return BundleMetadata{
				AppVersion:      appVer,
				AppBuildVersion: buildVer,
			}
		}
	}
	extract := func(key string) string {
		if !fileExists("/usr/bin/plutil") {
			return ""
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "/usr/bin/plutil", "-extract", key, "raw", "-o", "-", infoPlist).Output()
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(out))
	}
	return BundleMetadata{
		AppVersion:      extract("CFBundleShortVersionString"),
		AppBuildVersion: extract("CFBundleVersion"),
	}
}

func (svc *DesktopHookService) readCodexVersion(upstreamBinaryPath string, previous DesktopHookState, fp *FileFingerprint) string {
	if svc.readCodexVersionFn != nil {
		return strings.TrimSpace(svc.readCodexVersionFn(upstreamBinaryPath))
	}
	if sameFingerprint(previous.UpstreamFingerprint, fp) && strings.TrimSpace(previous.CodexVersion) != "" {
		return strings.TrimSpace(previous.CodexVersion)
	}
	if strings.TrimSpace(upstreamBinaryPath) == "" || !fileExists(upstreamBinaryPath) {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, upstreamBinaryPath, "--version")
	cmd.Env = append(os.Environ(), CodexAppServerPassthroughEnv+"=1")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return ""
	}
	firstLine := strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0])
	return strings.TrimRight(firstLine, "\r")
}

type expectedDesktopHookState struct {
	AppVersion          string
	AppBuildVersion     string
	CodexVersion        string
	WrapperRevision     string
	HelperRevision      string
	UpstreamFingerprint *FileFingerprint
}

func (svc *DesktopHookService) buildExpectedState(paths DesktopHookPaths, previous DesktopHookState) (expectedDesktopHookState, string) {
	wrapper := svc.BuildWrapperScript(paths.UpstreamBinaryPath)
	meta := svc.readBundleMetadata(paths.BundlePath)
	fp := readFileFingerprint(paths.UpstreamBinaryPath)
	return expectedDesktopHookState{
		AppVersion:          strings.TrimSpace(meta.AppVersion),
		AppBuildVersion:     strings.TrimSpace(meta.AppBuildVersion),
		CodexVersion:        svc.readCodexVersion(paths.UpstreamBinaryPath, previous, fp),
		WrapperRevision:     sha256Hex([]byte(wrapper)),
		HelperRevision:      fileRevision(svc.helperScriptPath),
		UpstreamFingerprint: fp,
	}, wrapper
}

// CollectDriftReasons 检查磁盘包装器、上游二进制与状态文件之间存在的漂移原因。
func (svc *DesktopHookService) CollectDriftReasons(paths DesktopHookPaths, previous DesktopHookState) ([]string, expectedDesktopHookState) {
	expected, wrapper := svc.buildExpectedState(paths, previous)
	reasonSet := make(map[string]struct{})
	var reasons []string
	add := func(r string) {
		if _, exists := reasonSet[r]; !exists {
			reasonSet[r] = struct{}{}
			reasons = append(reasons, r)
		}
	}

	if previous.Version != DesktopHookStateVersion {
		add("state_schema")
	}
	if !svc.IsWrapperInstalled(paths.TargetBinaryPath) {
		add("wrapper_missing")
	} else {
		actual, err := os.ReadFile(paths.TargetBinaryPath)
		if err != nil {
			add("wrapper_unreadable")
		} else if string(actual) != wrapper {
			add("wrapper_content")
		}
	}
	if strings.TrimSpace(paths.UpstreamBinaryPath) == "" || !fileExists(paths.UpstreamBinaryPath) {
		add("upstream_missing")
	}
	if strings.TrimSpace(previous.BundlePath) != strings.TrimSpace(paths.BundlePath) {
		add("bundle_path")
	}
	if strings.TrimSpace(previous.TargetBinaryPath) != strings.TrimSpace(paths.TargetBinaryPath) {
		add("target_path")
	}
	if strings.TrimSpace(previous.UpstreamBinaryPath) != strings.TrimSpace(paths.UpstreamBinaryPath) {
		add("upstream_path")
	}
	if strings.TrimSpace(previous.AppVersion) != expected.AppVersion {
		add("app_version")
	}
	if strings.TrimSpace(previous.AppBuildVersion) != expected.AppBuildVersion {
		add("app_build_version")
	}
	if strings.TrimSpace(previous.CodexVersion) != expected.CodexVersion {
		add("codex_version")
	}
	if strings.TrimSpace(previous.WrapperRevision) != expected.WrapperRevision {
		add("wrapper_revision")
	}
	if strings.TrimSpace(previous.HelperRevision) != expected.HelperRevision {
		add("helper_revision")
	}
	if !sameFingerprint(previous.UpstreamFingerprint, expected.UpstreamFingerprint) {
		add("upstream_fingerprint")
	}
	return reasons, expected
}

// ReadState 读取并解析 desktop-hook-state.json；文件不存在时返回零值结构。
func (svc *DesktopHookService) ReadState() DesktopHookState {
	svc.mu.Lock()
	defer svc.mu.Unlock()
	return svc.readStateLocked()
}

func (svc *DesktopHookService) readStateLocked() DesktopHookState {
	if svc.stateFilePath == "" {
		return DesktopHookState{}
	}
	raw, err := os.ReadFile(svc.stateFilePath)
	if err != nil {
		return DesktopHookState{}
	}
	var state DesktopHookState
	if err := json.Unmarshal(raw, &state); err != nil {
		return DesktopHookState{}
	}
	return state
}

func (svc *DesktopHookService) readRawStateMapLocked() map[string]json.RawMessage {
	if svc.stateFilePath == "" {
		return map[string]json.RawMessage{}
	}
	raw, err := os.ReadFile(svc.stateFilePath)
	if err != nil {
		return map[string]json.RawMessage{}
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return map[string]json.RawMessage{}
	}
	return m
}

func marshalJSONField(v any) json.RawMessage {
	data, _ := json.Marshal(v)
	return data
}

func helperMtimeMs(path string) int64 {
	if strings.TrimSpace(path) == "" {
		return 0
	}
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.ModTime().UnixMilli()
}

type desktopStateWritePatch struct {
	enabled                 bool
	paths                   DesktopHookPaths
	expected                *expectedDesktopHookState
	desktopAccountRef       *string
	traceFile               *string
	traceResponses          *bool
	traceRemoteControl      *bool
	remoteControlProxy      *bool
	providerHookReceiverURL *string
	reason                  *string
	errorCode               *string
	retryable               *bool
	preserveReasonFields    bool
}

func (svc *DesktopHookService) writeStateLocked(patch desktopStateWritePatch) bool {
	if svc.stateFilePath == "" {
		return false
	}
	rawMap := svc.readRawStateMapLocked()
	previous := svc.readStateLocked()

	hasHookTarget := strings.TrimSpace(patch.paths.TargetBinaryPath) != "" &&
		strings.TrimSpace(patch.paths.UpstreamBinaryPath) != ""
	hookStrategy := strings.TrimSpace(patch.paths.HookStrategy)
	if hookStrategy == "" {
		hookStrategy = HookStrategyInPlace
	}

	rawMap["version"] = marshalJSONField(DesktopHookStateVersion)
	rawMap["enabled"] = marshalJSONField(patch.enabled && hasHookTarget)
	rawMap["updatedAt"] = marshalJSONField(svc.now().UTC().Format("2006-01-02T15:04:05.000Z"))
	rawMap["bundlePath"] = marshalJSONField(strings.TrimSpace(patch.paths.BundlePath))
	rawMap["targetBinaryPath"] = marshalJSONField(strings.TrimSpace(patch.paths.TargetBinaryPath))
	rawMap["upstreamBinaryPath"] = marshalJSONField(strings.TrimSpace(patch.paths.UpstreamBinaryPath))
	rawMap["hookStrategy"] = marshalJSONField(hookStrategy)
	rawMap["helperScriptPath"] = marshalJSONField(svc.helperScriptPath)
	rawMap["helperScriptMtimeMs"] = marshalJSONField(helperMtimeMs(svc.helperScriptPath))

	helperRev := previous.HelperRevision
	appVer := previous.AppVersion
	appBuildVer := previous.AppBuildVersion
	codexVer := previous.CodexVersion
	wrapperRev := previous.WrapperRevision
	upstreamFP := previous.UpstreamFingerprint
	if patch.expected != nil {
		helperRev = patch.expected.HelperRevision
		appVer = patch.expected.AppVersion
		appBuildVer = patch.expected.AppBuildVersion
		codexVer = patch.expected.CodexVersion
		wrapperRev = patch.expected.WrapperRevision
		upstreamFP = patch.expected.UpstreamFingerprint
	}
	rawMap["helperRevision"] = marshalJSONField(strings.TrimSpace(helperRev))
	rawMap["appVersion"] = marshalJSONField(strings.TrimSpace(appVer))
	rawMap["appBuildVersion"] = marshalJSONField(strings.TrimSpace(appBuildVer))
	rawMap["codexVersion"] = marshalJSONField(strings.TrimSpace(codexVer))
	rawMap["wrapperRevision"] = marshalJSONField(strings.TrimSpace(wrapperRev))
	if upstreamFP != nil {
		rawMap["upstreamFingerprint"] = marshalJSONField(upstreamFP)
	} else {
		rawMap["upstreamFingerprint"] = marshalJSONField(nil)
	}

	traceFile := previous.TraceFile
	if patch.traceFile != nil {
		traceFile = *patch.traceFile
	}
	rawMap["traceFile"] = marshalJSONField(strings.TrimSpace(traceFile))

	traceResponses := previous.TraceResponses
	if patch.traceResponses != nil {
		traceResponses = *patch.traceResponses
	}
	rawMap["traceResponses"] = marshalJSONField(traceResponses)

	traceRemote := previous.TraceRemoteControl
	if patch.traceRemoteControl != nil {
		traceRemote = *patch.traceRemoteControl
	}
	rawMap["traceRemoteControl"] = marshalJSONField(traceRemote)

	remoteProxy := previous.RemoteControlProxy
	if patch.remoteControlProxy != nil {
		remoteProxy = *patch.remoteControlProxy
	}
	rawMap["remoteControlProxy"] = marshalJSONField(remoteProxy)

	hookURL := previous.ProviderHookReceiverURL
	if hookURL == "" {
		hookURL = svc.providerHookReceiverURL
	}
	if patch.providerHookReceiverURL != nil {
		hookURL = *patch.providerHookReceiverURL
	}
	rawMap["providerHookReceiverUrl"] = marshalJSONField(strings.TrimSpace(hookURL))

	accountRef := strings.TrimSpace(previous.DesktopAccountRef)
	if patch.desktopAccountRef != nil {
		accountRef = strings.TrimSpace(*patch.desktopAccountRef)
	}
	if accountRef != "" {
		rawMap["desktopAccountRef"] = marshalJSONField(accountRef)
	} else {
		delete(rawMap, "desktopAccountRef")
	}

	if !patch.preserveReasonFields {
		delete(rawMap, "reason")
		delete(rawMap, "errorCode")
		delete(rawMap, "retryable")
	}
	if patch.reason != nil && strings.TrimSpace(*patch.reason) != "" {
		rawMap["reason"] = marshalJSONField(strings.TrimSpace(*patch.reason))
	}
	if patch.errorCode != nil && strings.TrimSpace(*patch.errorCode) != "" {
		rawMap["errorCode"] = marshalJSONField(strings.TrimSpace(*patch.errorCode))
	}
	if patch.retryable != nil {
		rawMap["retryable"] = marshalJSONField(*patch.retryable)
	}

	encoded, err := json.MarshalIndent(rawMap, "", "  ")
	if err != nil {
		return false
	}
	return atomicWriteFile(svc.stateFilePath, encoded, 0o600) == nil
}

// GetDesktopAccountRef 读取当前桌面端钉选账号引用。
func (svc *DesktopHookService) GetDesktopAccountRef() string {
	return strings.TrimSpace(svc.ReadState().DesktopAccountRef)
}

// SetDesktopAccountRef 写入 desktopAccountRef 并保留状态的其余字段。
func (svc *DesktopHookService) SetDesktopAccountRef(accountRef string) AccountRefMutationResult {
	cleanRef := strings.TrimSpace(accountRef)
	if cleanRef == "" {
		return AccountRefMutationResult{OK: false, Reason: "invalid_account_ref"}
	}
	if svc.stateFilePath == "" {
		return AccountRefMutationResult{OK: false, Reason: "state_file_unavailable"}
	}
	svc.mu.Lock()
	defer svc.mu.Unlock()
	previous := svc.readStateLocked()
	paths := DesktopHookPaths{
		BundlePath:         previous.BundlePath,
		TargetBinaryPath:   previous.TargetBinaryPath,
		UpstreamBinaryPath: previous.UpstreamBinaryPath,
		HookStrategy:       previous.HookStrategy,
	}
	written := svc.writeStateLocked(desktopStateWritePatch{
		enabled:           previous.Enabled,
		paths:             paths,
		desktopAccountRef: &cleanRef,
	})
	return AccountRefMutationResult{
		OK:                written,
		StateFilePath:     svc.stateFilePath,
		DesktopAccountRef: cleanRef,
		Changed:           strings.TrimSpace(previous.DesktopAccountRef) != cleanRef,
	}
}

// ClearDesktopAccountRef 在匹配 expectedRef（或为空）时清除 desktopAccountRef。
func (svc *DesktopHookService) ClearDesktopAccountRef(expectedRef string) AccountRefMutationResult {
	if svc.stateFilePath == "" {
		return AccountRefMutationResult{OK: false, Reason: "state_file_unavailable"}
	}
	if !fileExists(svc.stateFilePath) {
		return AccountRefMutationResult{OK: true, StateFilePath: svc.stateFilePath}
	}
	svc.mu.Lock()
	defer svc.mu.Unlock()
	previous := svc.readStateLocked()
	current := strings.TrimSpace(previous.DesktopAccountRef)
	expected := strings.TrimSpace(expectedRef)
	if expected != "" && current != "" && current != expected {
		return AccountRefMutationResult{
			OK:                true,
			StateFilePath:     svc.stateFilePath,
			DesktopAccountRef: current,
			Changed:           false,
		}
	}
	paths := DesktopHookPaths{
		BundlePath:         previous.BundlePath,
		TargetBinaryPath:   previous.TargetBinaryPath,
		UpstreamBinaryPath: previous.UpstreamBinaryPath,
		HookStrategy:       previous.HookStrategy,
	}
	empty := ""
	written := svc.writeStateLocked(desktopStateWritePatch{
		enabled:           previous.Enabled,
		paths:             paths,
		desktopAccountRef: &empty,
	})
	return AccountRefMutationResult{
		OK:            written,
		StateFilePath: svc.stateFilePath,
		Changed:       current != "",
	}
}

func (svc *DesktopHookService) installWrapper(paths DesktopHookPaths) (DesktopHookResult, error) {
	if paths.TargetBinaryPath == "" || (paths.HookStrategy != HookStrategyExternalLauncher && !fileExists(paths.TargetBinaryPath)) {
		return DesktopHookResult{
			OK:     false,
			Reason: "target_binary_missing",
		}, nil
	}
	wrapper := svc.BuildWrapperScript(paths.UpstreamBinaryPath)

	if paths.HookStrategy == HookStrategyExternalLauncher {
		res, err := InstallExternalLauncher(ExternalLauncherOptions{
			TargetBinaryPath:   paths.TargetBinaryPath,
			UpstreamBinaryPath: paths.UpstreamBinaryPath,
			Wrapper:            wrapper,
			IsWrapperInstalled: svc.IsWrapperInstalled,
		})
		if err != nil {
			if code, nonRetryable := classifyNonRetryableInstallError(err); nonRetryable {
				retryable := false
				return DesktopHookResult{
					OK:        false,
					Retryable: &retryable,
					Reason:    "hook_target_not_writable",
					ErrorCode: code,
				}, nil
			}
			return DesktopHookResult{}, err
		}
		return DesktopHookResult{
			OK:                 res.OK,
			Installed:          res.Installed,
			Updated:            res.Updated,
			Reason:             res.Reason,
			TargetBinaryPath:   res.TargetBinaryPath,
			UpstreamBinaryPath: res.UpstreamBinaryPath,
		}, nil
	}

	if svc.IsWrapperInstalled(paths.TargetBinaryPath) {
		if paths.UpstreamBinaryPath == "" || !fileExists(paths.UpstreamBinaryPath) {
			return DesktopHookResult{
				OK:     false,
				Reason: "missing_upstream_backup",
			}, nil
		}
		if readTextFileSafe(paths.TargetBinaryPath) == wrapper {
			return DesktopHookResult{
				OK:                 true,
				Installed:          true,
				Updated:            false,
				TargetBinaryPath:   paths.TargetBinaryPath,
				UpstreamBinaryPath: paths.UpstreamBinaryPath,
			}, nil
		}
		if err := writeWrapperFile(paths.TargetBinaryPath, wrapper); err != nil {
			if code, nonRetryable := classifyNonRetryableInstallError(err); nonRetryable {
				retryable := false
				return DesktopHookResult{
					OK:        false,
					Retryable: &retryable,
					Reason:    "hook_target_not_writable",
					ErrorCode: code,
				}, nil
			}
			return DesktopHookResult{}, err
		}
		return DesktopHookResult{
			OK:                 true,
			Installed:          true,
			Updated:            true,
			TargetBinaryPath:   paths.TargetBinaryPath,
			UpstreamBinaryPath: paths.UpstreamBinaryPath,
		}, nil
	}

	if _, err := copyExecutableSnapshot(paths.TargetBinaryPath, paths.UpstreamBinaryPath); err != nil {
		if code, nonRetryable := classifyNonRetryableInstallError(err); nonRetryable {
			retryable := false
			return DesktopHookResult{
				OK:        false,
				Retryable: &retryable,
				Reason:    "hook_target_not_writable",
				ErrorCode: code,
			}, nil
		}
		return DesktopHookResult{}, err
	}
	if err := writeWrapperFile(paths.TargetBinaryPath, wrapper); err != nil {
		if code, nonRetryable := classifyNonRetryableInstallError(err); nonRetryable {
			retryable := false
			return DesktopHookResult{
				OK:        false,
				Retryable: &retryable,
				Reason:    "hook_target_not_writable",
				ErrorCode: code,
			}, nil
		}
		return DesktopHookResult{}, err
	}
	return DesktopHookResult{
		OK:                 true,
		Installed:          true,
		Updated:            false,
		TargetBinaryPath:   paths.TargetBinaryPath,
		UpstreamBinaryPath: paths.UpstreamBinaryPath,
	}, nil
}

// Activate 安装或刷新 Codex Desktop hook 并落盘最新状态。
func (svc *DesktopHookService) Activate() (DesktopHookResult, error) {
	if svc.platform != "darwin" {
		return DesktopHookResult{
			OK:        true,
			Supported: false,
			Enabled:   false,
			Reason:    "unsupported_platform",
		}, nil
	}
	paths := svc.ResolvePaths()
	if paths.BundlePath == "" {
		reason := paths.Reason
		if reason == "" {
			reason = "codex_app_not_found"
		}
		return DesktopHookResult{
			OK:        true,
			Supported: true,
			Enabled:   false,
			Reason:    reason,
		}, nil
	}

	previous := svc.ReadState()
	driftReasons, expected := svc.CollectDriftReasons(paths, previous)

	installRes, err := svc.installWrapper(paths)
	if err != nil {
		return DesktopHookResult{}, err
	}
	if !installRes.OK {
		svc.mu.Lock()
		svc.writeStateLocked(desktopStateWritePatch{
			enabled:   false,
			paths:     paths,
			reason:    &installRes.Reason,
			errorCode: &installRes.ErrorCode,
			retryable: installRes.Retryable,
		})
		svc.mu.Unlock()
		installRes.Supported = true
		installRes.Enabled = false
		return installRes, nil
	}

	nextMtime := helperMtimeMs(svc.helperScriptPath)
	helperChanged := strings.TrimSpace(previous.HelperScriptPath) != strings.TrimSpace(svc.helperScriptPath) ||
		previous.HelperScriptMtimeMs != nextMtime ||
		strings.TrimSpace(previous.HelperRevision) != expected.HelperRevision

	// 首次安装会在 installWrapper 中生成 .aih-original 上游快照，需在安装后重算期望指纹，
	// 避免随后自愈或二次激活误报 upstream_fingerprint 漂移。
	expectedAfterInstall, _ := svc.buildExpectedState(paths, previous)

	svc.mu.Lock()
	svc.writeStateLocked(desktopStateWritePatch{
		enabled:  true,
		paths:    paths,
		expected: &expectedAfterInstall,
	})
	svc.mu.Unlock()

	return DesktopHookResult{
		OK:                  true,
		Supported:           true,
		Enabled:             true,
		Installed:           installRes.Installed,
		Updated:             installRes.Updated,
		HelperScriptChanged: helperChanged,
		DriftReasons:        driftReasons,
		RestartRequired:     len(driftReasons) > 0,
		BundlePath:          paths.BundlePath,
		TargetBinaryPath:    paths.TargetBinaryPath,
		UpstreamBinaryPath:  paths.UpstreamBinaryPath,
		StateFilePath:       svc.stateFilePath,
	}, nil
}

// EnsureInstalled 校验现有 Desktop hook 是否存在漂移，仅在出现漂移时执行修复。
func (svc *DesktopHookService) EnsureInstalled() (DesktopHookResult, error) {
	if svc.platform != "darwin" {
		return DesktopHookResult{
			OK:        true,
			Supported: false,
			Enabled:   false,
			Reason:    "unsupported_platform",
		}, nil
	}
	paths := svc.ResolvePaths()
	if paths.BundlePath == "" {
		reason := paths.Reason
		if reason == "" {
			reason = "codex_app_not_found"
		}
		svc.mu.Lock()
		svc.writeStateLocked(desktopStateWritePatch{
			enabled: false,
			paths:   paths,
			reason:  &reason,
		})
		svc.mu.Unlock()
		return DesktopHookResult{
			OK:        true,
			Supported: true,
			Enabled:   false,
			Reason:    reason,
		}, nil
	}
	previous := svc.ReadState()
	driftReasons, _ := svc.CollectDriftReasons(paths, previous)
	if len(driftReasons) == 0 {
		return DesktopHookResult{
			OK:                 true,
			Supported:          true,
			Enabled:            true,
			Healthy:            true,
			BundlePath:         paths.BundlePath,
			TargetBinaryPath:   paths.TargetBinaryPath,
			UpstreamBinaryPath: paths.UpstreamBinaryPath,
		}, nil
	}
	repaired, err := svc.Activate()
	if err != nil {
		return DesktopHookResult{}, err
	}
	repaired.DriftReasons = driftReasons
	repaired.Repaired = repaired.OK && repaired.Enabled
	repaired.RestartRequired = repaired.Repaired
	return repaired, nil
}

// UpdateTraceConfig 更新 trace 与 remoteControlProxy 配置并返回是否发生变更。
func (svc *DesktopHookService) UpdateTraceConfig(cfg DesktopTraceConfig) DesktopTraceResult {
	defaultTraceFile := ""
	if cfg.TraceRemoteControl && svc.aiHomeDir != "" {
		defaultTraceFile = filepath.Join(svc.aiHomeDir, "logs", "codex", "mobile-trace.jsonl")
	}
	nextTraceFile := strings.TrimSpace(cfg.TraceFile)
	if nextTraceFile == "" {
		nextTraceFile = defaultTraceFile
	}

	paths := svc.ResolvePaths()
	svc.mu.Lock()
	defer svc.mu.Unlock()
	previous := svc.readStateLocked()
	nextHelperRev := fileRevision(svc.helperScriptPath)
	if nextHelperRev == "" {
		nextHelperRev = previous.HelperRevision
	}

	changed := strings.TrimSpace(previous.TraceFile) != nextTraceFile ||
		previous.TraceResponses != cfg.TraceResponses ||
		previous.TraceRemoteControl != cfg.TraceRemoteControl ||
		previous.RemoteControlProxy != cfg.RemoteControlProxy ||
		strings.TrimSpace(previous.ProviderHookReceiverURL) != svc.providerHookReceiverURL ||
		strings.TrimSpace(previous.HelperScriptPath) != svc.helperScriptPath ||
		previous.HelperScriptMtimeMs != helperMtimeMs(svc.helperScriptPath) ||
		strings.TrimSpace(previous.HelperRevision) != nextHelperRev

	usePaths := paths
	if usePaths.BundlePath == "" {
		usePaths = DesktopHookPaths{
			BundlePath:         previous.BundlePath,
			TargetBinaryPath:   previous.TargetBinaryPath,
			UpstreamBinaryPath: previous.UpstreamBinaryPath,
			HookStrategy:       previous.HookStrategy,
		}
	}
	expected := expectedDesktopHookState{
		AppVersion:          previous.AppVersion,
		AppBuildVersion:     previous.AppBuildVersion,
		CodexVersion:        previous.CodexVersion,
		WrapperRevision:     previous.WrapperRevision,
		HelperRevision:      nextHelperRev,
		UpstreamFingerprint: previous.UpstreamFingerprint,
	}
	svc.writeStateLocked(desktopStateWritePatch{
		enabled:                 previous.Enabled,
		paths:                   usePaths,
		expected:                &expected,
		traceFile:               &nextTraceFile,
		traceResponses:          &cfg.TraceResponses,
		traceRemoteControl:      &cfg.TraceRemoteControl,
		remoteControlProxy:      &cfg.RemoteControlProxy,
		providerHookReceiverURL: &svc.providerHookReceiverURL,
		preserveReasonFields:    true,
	})

	return DesktopTraceResult{
		OK:                 true,
		StateFilePath:      svc.stateFilePath,
		TraceFile:          nextTraceFile,
		TraceResponses:     cfg.TraceResponses,
		TraceRemoteControl: cfg.TraceRemoteControl,
		RemoteControlProxy: cfg.RemoteControlProxy,
		Changed:            changed,
	}
}

func commandUsesExecutable(command string, executable string) bool {
	execClean := strings.TrimSpace(executable)
	if execClean == "" {
		return false
	}
	return command == execClean || strings.Contains(command, execClean+" ")
}

func defaultListUnixProcesses() ([]ProcessInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-axo", "pid=,ppid=,command=").Output()
	if err != nil {
		return nil, err
	}
	return ParseUnixPSProcessTable(string(out)), nil
}

// ParseUnixPSProcessTable 解析 `ps -axo pid=,ppid=,command=` 的文本输出。
func ParseUnixPSProcessTable(raw string) []ProcessInfo {
	var out []ProcessInfo
	for _, line := range strings.Split(raw, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		fields := strings.Fields(trimmed)
		if len(fields) < 3 {
			continue
		}
		pid, err1 := strconv.Atoi(fields[0])
		ppid, err2 := strconv.Atoi(fields[1])
		if err1 != nil || err2 != nil || pid <= 0 {
			continue
		}
		// 重新从原行截取第 3 列起的完整命令行，保留多空格。
		rest := strings.TrimSpace(trimmed[len(fields[0]):])
		rest = strings.TrimSpace(rest[len(fields[1]):])
		out = append(out, ProcessInfo{
			PID:       pid,
			ParentPID: ppid,
			Command:   rest,
		})
	}
	return out
}

// ListRunningAppServerProcesses 枚举当前桌面端衍生且仍在运行的 app-server 进程根列表。
func (svc *DesktopHookService) ListRunningAppServerProcesses() []ProcessInfo {
	if svc.stateFilePath == "" {
		return nil
	}
	state := svc.ReadState()
	bundle := strings.TrimSpace(state.BundlePath)
	target := strings.TrimSpace(state.TargetBinaryPath)
	upstream := strings.TrimSpace(state.UpstreamBinaryPath)
	if bundle == "" {
		resolved := svc.ResolvePaths()
		bundle = resolved.BundlePath
		if target == "" {
			target = resolved.TargetBinaryPath
		}
		if upstream == "" {
			upstream = resolved.UpstreamBinaryPath
		}
	}
	if bundle == "" {
		return nil
	}

	listFn := svc.listProcessesFn
	if listFn == nil {
		listFn = defaultListUnixProcesses
	}
	processes, err := listFn()
	if err != nil || len(processes) == 0 {
		return nil
	}

	byPID := make(map[int]ProcessInfo, len(processes))
	for _, proc := range processes {
		byPID[proc.PID] = proc
	}

	desktopMainPrefix := filepath.Join(bundle, "Contents", "MacOS") + string(filepath.Separator)
	hasDesktopAncestor := func(proc ProcessInfo) bool {
		curr := proc
		for depth := 0; depth < desktopProcessAncestorLimit; depth++ {
			parent, ok := byPID[curr.ParentPID]
			if !ok {
				return false
			}
			if strings.HasPrefix(parent.Command, desktopMainPrefix) {
				return true
			}
			curr = parent
		}
		return false
	}
	isDirectDesktopChild := func(proc ProcessInfo) bool {
		parent, ok := byPID[proc.ParentPID]
		return ok && strings.HasPrefix(parent.Command, desktopMainPrefix)
	}

	var candidates []ProcessInfo
	candidatePIDs := make(map[int]struct{})
	for _, proc := range processes {
		if proc.PID <= 0 || proc.PID == svc.selfPID {
			continue
		}
		if !hasDesktopAncestor(proc) {
			continue
		}
		cmd := proc.Command
		matchHelper := svc.helperScriptPath != "" &&
			strings.Contains(cmd, svc.helperScriptPath) &&
			strings.Contains(cmd, svc.stateFilePath) &&
			strings.Contains(cmd, "app-server")
		matchTarget := target != "" &&
			commandUsesExecutable(cmd, target) &&
			strings.Contains(cmd, "app-server")
		matchUpstream := upstream != "" &&
			isDirectDesktopChild(proc) &&
			strings.Contains(cmd, upstream) &&
			strings.Contains(cmd, "app-server")
		if matchHelper || matchTarget || matchUpstream {
			candidates = append(candidates, proc)
			candidatePIDs[proc.PID] = struct{}{}
		}
	}

	var roots []ProcessInfo
	for _, proc := range candidates {
		curr := proc
		nested := false
		for depth := 0; depth < desktopProcessAncestorLimit; depth++ {
			parent, ok := byPID[curr.ParentPID]
			if !ok {
				break
			}
			if _, isCand := candidatePIDs[parent.PID]; isCand {
				nested = true
				break
			}
			curr = parent
		}
		if !nested {
			roots = append(roots, proc)
		}
	}
	return roots
}

func defaultKillUnixProcess(pid int) error {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Signal(syscall.SIGTERM)
}

// RestartRunningAppServers 向受影响桌面端 app-server 根进程发送 SIGTERM，促使其用新 hook 配置重启。
func (svc *DesktopHookService) RestartRunningAppServers() RestartAppServersResult {
	killFn := svc.killProcessFn
	if killFn == nil {
		killFn = defaultKillUnixProcess
	}
	procs := svc.ListRunningAppServerProcesses()
	var signaled []int
	for _, proc := range procs {
		if err := killFn(proc.PID); err == nil || errors.Is(err, os.ErrProcessDone) {
			if err == nil {
				signaled = append(signaled, proc.PID)
			}
		}
	}
	if signaled == nil {
		signaled = []int{}
	}
	return RestartAppServersResult{
		OK:    true,
		Count: len(signaled),
		PIDs:  signaled,
	}
}

// Deactivate 停用桌面端 hook 标记（保留其他配置键与 desktopAccountRef）。
func (svc *DesktopHookService) Deactivate() DesktopHookResult {
	paths := svc.ResolvePaths()
	if svc.stateFilePath != "" {
		svc.mu.Lock()
		svc.writeStateLocked(desktopStateWritePatch{
			enabled: false,
			paths:   paths,
		})
		svc.mu.Unlock()
	}
	return DesktopHookResult{
		OK:            true,
		Supported:     svc.platform == "darwin",
		Enabled:       false,
		StateFilePath: svc.stateFilePath,
	}
}

// Status 返回当前桌面端 hook 诊断视图（不会主动修改磁盘）。
func (svc *DesktopHookService) Status() map[string]any {
	paths := svc.ResolvePaths()
	state := svc.ReadState()
	supported := svc.platform == "darwin"
	healthy := false
	var drift []string
	if supported && paths.BundlePath != "" {
		drift, _ = svc.CollectDriftReasons(paths, state)
		healthy = len(drift) == 0 && state.Enabled
	}
	return map[string]any{
		"supported":     supported,
		"paths":         paths,
		"state":         state,
		"stateFilePath": svc.stateFilePath,
		"healthy":       healthy,
		"driftReasons":  drift,
	}
}
