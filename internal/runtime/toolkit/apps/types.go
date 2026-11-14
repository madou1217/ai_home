// Package apps 实现 WebUI 工具箱的应用清单发现、版本探测与更新检查、官方 Hook 管理、
// 非绑定账号桌面拉起（含 Claude-3p 本地网关配置）以及 CLI/Desktop/IDE 安装生命周期作业。
package apps

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/hostexec"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

const (
	// NPMRegistry 是官方 npm 查询/安装隔离使用的注册表。
	NPMRegistry = "https://registry.npmjs.org"

	inventoryCacheTTL      = 30 * time.Second
	inventoryCacheMaxStale = 10 * time.Minute
	versionCacheTTL        = 5 * time.Minute
	latestVersionCacheTTL  = 5 * time.Minute
	jobRetention           = 30 * time.Minute
	installedPathMarker    = "AIH_DESKTOP_INSTALLED_PATH="
	defaultVerifyRetries   = 6
	defaultVerifyDelay     = time.Second
)

// Options 描述 apps 包所有操作的运行时依赖与测试替身。
type Options struct {
	Catalog           *providers.Catalog
	AIHomeDir         string
	HostHomeDir       string
	Platform          string
	Arch              string
	NodeVersion       string
	NodeExecPath      string
	Env               map[string]string
	Executor          environment.Executor
	LookPath          func(string) (string, error)
	HTTPClient        *http.Client
	SpawnDetached     func(command string, args []string, env map[string]string) error
	Now               func() time.Time
	Sleep             func(context.Context, time.Duration) error
	CacheInventory    *bool
	RefreshInventory  bool
	ProbeVersions     string
	InventoryCacheKey string
	Timeout           time.Duration
	InstalledPath     string
	VerifyRetries     int
	VerifyRetryDelay  time.Duration

	// NPMRegistry 返回当前 npm registry（工具箱镜像设置）；nil 或空串用官方源。
	NPMRegistry func() string

	// SenderExecPath 覆盖原生 Hook 发送器；为空时定位当前、同目录或 PATH 上的 aih-server。
	SenderExecPath string
	// SenderScriptPath 仅保留旧调用方源码兼容；Hook 不再执行 Node 脚本。
	SenderScriptPath     string
	ReceiverURL          string
	ServerHost           string
	ServerPort           int
	CredentialHelperPath string
}

func (opts *Options) nowTime() time.Time {
	if opts != nil && opts.Now != nil {
		return opts.Now()
	}
	return time.Now()
}

func (opts *Options) exec() environment.Executor {
	if opts != nil && opts.Executor != nil {
		return opts.Executor
	}
	return hostexec.Executor{}
}

// Manager 持有应用清单、版本探测与远程最新版本的短期缓存及安装作业管理器。
type Manager struct {
	mu              sync.Mutex
	inventoryCache  map[string]inventoryEntry
	inventoryFlight map[string]*inventoryCall
	versionCache    map[string]versionEntry
	versionFlight   map[string]struct{}
	latestCache     map[string]latestEntry
	latestFlight    map[string]*latestCall
}

// NewManager 创建一个独立的 apps 管理器（含缓存）。
func NewManager() *Manager {
	return &Manager{
		inventoryCache:  make(map[string]inventoryEntry),
		inventoryFlight: make(map[string]*inventoryCall),
		versionCache:    make(map[string]versionEntry),
		versionFlight:   make(map[string]struct{}),
		latestCache:     make(map[string]latestEntry),
		latestFlight:    make(map[string]*latestCall),
	}
}

type inventoryEntry struct {
	at    time.Time
	value ListResult
}

type inventoryCall struct {
	done  chan struct{}
	value ListResult
	err   error
}

type versionEntry struct {
	at    time.Time
	value string
}

type latestEntry struct {
	at    time.Time
	value latestQueryResult
}

type latestCall struct {
	done  chan struct{}
	value latestQueryResult
}

type latestQueryResult struct {
	OK            bool   `json:"ok"`
	LatestVersion string `json:"latestVersion,omitempty"`
	Error         string `json:"error,omitempty"`
}

// VersionSource 描述远程最新版本查询源，形状与前端及 Node 对齐。
type VersionSource struct {
	Type        string `json:"type"`
	PackageName string `json:"packageName,omitempty"`
	Cask        string `json:"cask,omitempty"`
	ID          string `json:"id,omitempty"`
}

// AppView 表示工具箱应用卡片的单条状态视图。
type AppView struct {
	ID                   string         `json:"id"`
	Name                 string         `json:"name"`
	Provider             string         `json:"provider"`
	ClientID             string         `json:"clientId"`
	ClientName           string         `json:"clientName"`
	ConfigProvider       string         `json:"configProvider,omitempty"`
	Type                 string         `json:"type"`
	Categories           []string       `json:"categories"`
	BinaryName           string         `json:"binaryName"`
	CLIPath              string         `json:"cliPath"`
	ConfigExists         bool           `json:"configExists"`
	ConfigFileCount      int            `json:"configFileCount"`
	ConfigName           string         `json:"configName"`
	ConfigFormat         string         `json:"configFormat"`
	Installed            bool           `json:"installed"`
	Version              string         `json:"version"`
	VersionSource        *VersionSource `json:"versionSource,omitempty"`
	Pkg                  string         `json:"pkg"`
	DefaultModel         string         `json:"defaultModel"`
	SupportedModels      []string       `json:"supportedModels"`
	HookSupported        bool           `json:"hookSupported"`
	HookInstalled        bool           `json:"hookInstalled"`
	SyncMode             string         `json:"syncMode"`
	HookReason           string         `json:"hookReason"`
	HookMissingEvents    []string       `json:"hookMissingEvents"`
	InstallAvailable     bool           `json:"installAvailable"`
	CanUpdate            bool           `json:"canUpdate"`
	CanUninstall         bool           `json:"canUninstall"`
	HostLaunchLabel      string         `json:"hostLaunchLabel,omitempty"`
	IntegrationProviders []string       `json:"integrationProviders,omitempty"`
}

// ListResult 是 GET /toolkit/apps 的返回结构。
type ListResult struct {
	OK             bool      `json:"ok"`
	Total          int       `json:"total"`
	InstalledCount int       `json:"installedCount"`
	Apps           []AppView `json:"apps"`
}

// RefreshVersionResult 是针对单个 appId 刷新同步本地版本的结果。
type RefreshVersionResult struct {
	OK             bool     `json:"ok"`
	Error          string   `json:"error,omitempty"`
	AppID          string   `json:"appId,omitempty"`
	App            *AppView `json:"app,omitempty"`
	CurrentVersion *string  `json:"currentVersion,omitempty"`
}

// UpdateCheckResult 是 POST /toolkit/apps/:appId/check-update 的返回结构。
type UpdateCheckResult struct {
	OK              bool    `json:"ok"`
	AppID           string  `json:"appId"`
	Provider        string  `json:"provider"`
	CurrentVersion  *string `json:"currentVersion"`
	LatestVersion   *string `json:"latestVersion"`
	UpdateAvailable bool    `json:"updateAvailable"`
	Status          string  `json:"status"`
	Error           string  `json:"error,omitempty"`
	Message         string  `json:"message,omitempty"`
}

// OpenResult 是无账号桌面应用拉起结果。
type OpenResult struct {
	OK         bool   `json:"ok"`
	Status     string `json:"status,omitempty"`
	AppID      string `json:"appId,omitempty"`
	Provider   string `json:"provider,omitempty"`
	Executable string `json:"executable,omitempty"`
	Error      string `json:"error,omitempty"`
	Message    string `json:"message,omitempty"`
}

// DesktopRecord 表示宿主上已发现的桌面客户端 / IDE 安装位置。
type DesktopRecord struct {
	Provider       string
	ClientName     string
	ExecutablePath string
	BundlePath     string
	DisplayPath    string
	Version        string
}

// CodexFeaturesView 是 codex config.toml [features] 诊断/修改结果。
type CodexFeaturesView struct {
	Path           string `json:"path"`
	Changed        bool   `json:"changed,omitempty"`
	FlagName       string `json:"flagName"`
	CodexVersion   string `json:"codexVersion"`
	DisabledBefore bool   `json:"disabledBefore,omitempty"`
	Explicit       bool   `json:"explicit,omitempty"`
	Enabled        bool   `json:"enabled,omitempty"`
	Disabled       bool   `json:"disabled,omitempty"`
	ActiveFlagName string `json:"activeFlagName,omitempty"`
}

// HookDiagnosis 表示单个 Provider 官方会话 Hook 的诊断状态。
type HookDiagnosis struct {
	Supported     bool               `json:"supported"`
	Provider      string             `json:"provider"`
	TargetPath    string             `json:"targetPath,omitempty"`
	TargetKind    string             `json:"targetKind,omitempty"`
	HookName      string             `json:"hookName,omitempty"`
	SyncMode      string             `json:"syncMode"`
	Installed     bool               `json:"installed"`
	Disabled      bool               `json:"disabled,omitempty"`
	MissingEvents []string           `json:"missingEvents"`
	Events        []string           `json:"events"`
	Reason        string             `json:"reason,omitempty"`
	CodexFeatures *CodexFeaturesView `json:"codexFeatures,omitempty"`
}

// HookOperationOutcome 是单步安装/卸载的底层写盘结果。
type HookOperationOutcome struct {
	OK            bool               `json:"ok"`
	Provider      string             `json:"provider"`
	Error         string             `json:"error,omitempty"`
	TargetPath    string             `json:"targetPath,omitempty"`
	TargetKind    string             `json:"targetKind,omitempty"`
	Changed       bool               `json:"changed"`
	DryRun        bool               `json:"dryRun"`
	Events        []string           `json:"events,omitempty"`
	ReceiverURL   string             `json:"receiverUrl,omitempty"`
	CodexFeatures *CodexFeaturesView `json:"codexFeatures,omitempty"`
}

// HookActionResult 是 POST /toolkit/apps/hooks 返回数组中的单项。
type HookActionResult struct {
	Provider      string                `json:"provider"`
	OK            bool                  `json:"ok"`
	Verified      bool                  `json:"verified"`
	Installed     bool                  `json:"installed,omitempty"`
	Changed       bool                  `json:"changed,omitempty"`
	MissingEvents []string              `json:"missingEvents,omitempty"`
	Reason        string                `json:"reason,omitempty"`
	Error         string                `json:"error,omitempty"`
	Result        *HookOperationOutcome `json:"result,omitempty"`
}

// HooksActionResponse 是 POST /toolkit/apps/hooks 的响应。
type HooksActionResponse struct {
	OK      bool               `json:"ok"`
	Results []HookActionResult `json:"results"`
}

// InstallInput 表示安装/更新/卸载目标或计划请求入参。
type InstallInput struct {
	AppID         string `json:"appId"`
	Provider      string `json:"provider"`
	Kind          string `json:"kind"`
	Action        string `json:"action"`
	InstalledPath string `json:"installedPath,omitempty"`
}

// InstallTarget 是归一化后的安装目标。
type InstallTarget struct {
	AppID    string `json:"appId"`
	Provider string `json:"provider"`
	Kind     string `json:"kind"`
	Action   string `json:"action"`
	Key      string `json:"key"`
}

// LifecyclePlan 描述一条可执行或可预览的生命周期命令。
type LifecyclePlan struct {
	ID            string            `json:"id"`
	Label         string            `json:"label"`
	Command       string            `json:"command"`
	Args          []string          `json:"args"`
	Timeout       time.Duration     `json:"-"`
	Env           map[string]string `json:"-"`
	SkipOnMissing bool              `json:"-"`
}

// PlanResponse 是 POST /toolkit/apps/plan 的响应。
type PlanResponse struct {
	OK       bool            `json:"ok"`
	AppID    string          `json:"appId,omitempty"`
	Provider string          `json:"provider,omitempty"`
	Kind     string          `json:"kind,omitempty"`
	Action   string          `json:"action,omitempty"`
	Key      string          `json:"key,omitempty"`
	Label    string          `json:"label,omitempty"`
	Plans    []LifecyclePlan `json:"plans,omitempty"`
	Error    string          `json:"error,omitempty"`
}

// AttemptView 记录单步生命周期执行结果。
type AttemptView struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

// JobProgress 表示安装作业进度。
type JobProgress struct {
	Percent int    `json:"percent"`
	Label   string `json:"label"`
}

// JobResultView 表示安装作业完成结果。
type JobResultView struct {
	Installed      bool   `json:"installed"`
	CLIPath        string `json:"cliPath"`
	ExecutablePath string `json:"executablePath"`
}

// JobView 是 app-install 作业对外序列化快照，字段与 Node 完全一致。
type JobView struct {
	ID         string         `json:"id"`
	Source     string         `json:"source"`
	TaskName   string         `json:"taskName"`
	AppID      string         `json:"appId"`
	Provider   string         `json:"provider"`
	Kind       string         `json:"kind"`
	Action     string         `json:"action"`
	Status     string         `json:"status"`
	Phase      string         `json:"phase"`
	Progress   JobProgress    `json:"progress"`
	Attempts   []AttemptView  `json:"attempts"`
	Result     *JobResultView `json:"result"`
	Error      string         `json:"error"`
	CreatedAt  int64          `json:"createdAt"`
	UpdatedAt  int64          `json:"updatedAt"`
	FinishedAt *int64         `json:"finishedAt"`
}

// JobStartResult 是发起安装作业的返回值。
type JobStartResult struct {
	OK             bool     `json:"ok"`
	Accepted       bool     `json:"accepted,omitempty"`
	AlreadyRunning bool     `json:"alreadyRunning,omitempty"`
	Job            *JobView `json:"job,omitempty"`
	Error          string   `json:"error,omitempty"`
}

// JobCancelResult 是取消安装作业的返回值。
type JobCancelResult struct {
	OK    bool     `json:"ok"`
	Error string   `json:"error,omitempty"`
	Job   *JobView `json:"job"`
}

// JobEvent 是安装作业 SSE 推送事件。
type JobEvent struct {
	Type string   `json:"type"`
	Job  *JobView `json:"job,omitempty"`
}
