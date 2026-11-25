// Package appinstall 定义插件式应用安装（app.install）的中性数据模型与宿主端口。
//
// 插件宿主（pluginhost）负责与插件 RPC、校验与脱敏；Toolkit 与账号入口只依赖这里
// 的类型，不反向依赖 pluginhost，避免运行时包互相导入。
package appinstall

import (
	"context"
	"runtime"
	"strings"
)

// Kind 是插件声明的应用类型。
type Kind string

const (
	KindDesktop Kind = "desktop"
	KindIDE     Kind = "ide"
	KindCLI     Kind = "cli"
)

// Capabilities 是插件对单个应用声明的生命周期能力。
type Capabilities struct {
	Install   bool `json:"install"`
	Update    bool `json:"update"`
	Uninstall bool `json:"uninstall"`
	Open      bool `json:"open"`
	// AccountScope 表示插件能接受宿主准备好的账号投影（v1 尚未接线）。
	AccountScope bool `json:"accountScope,omitempty"`
	// OpenMode 是 plugin（默认）或 host；host 由宿主按 Executable 拉起。
	OpenMode string `json:"openMode,omitempty"`
}

// InstallHint 是安装确认页展示的非敏感事实。
type InstallHint struct {
	RequiresConfirmation bool  `json:"requiresConfirmation"`
	RequiresAdmin        bool  `json:"requiresAdmin"`
	DownloadBytes        int64 `json:"downloadBytes,omitempty"`
}

// App 是一个插件贡献的应用。
type App struct {
	AppID     string   `json:"appId"`
	Provider  string   `json:"provider,omitempty"`
	Name      string   `json:"name"`
	Kind      Kind     `json:"kind"`
	Platforms []string `json:"platforms,omitempty"`
	Order     int      `json:"order,omitempty"`
	// AccountKind 显式指定账号入口的 desktop / cli / none；空值按 Kind 推导。
	// ide 默认 none：IDE 是独立产品，不能把它的安装状态算到 Provider 的 Desktop 入口。
	AccountKindValue string       `json:"accountKind,omitempty"`
	Capabilities     Capabilities `json:"capabilities"`
	Install          InstallHint  `json:"install,omitempty"`
	// UninstallRemovesUserData 表示卸载会删除用户数据，UI 需要额外确认。
	UninstallRemovesUserData bool `json:"uninstallRemovesUserData,omitempty"`
	// PluginID / ContributionID / Generation 由宿主填充，插件不返回。
	PluginID       string `json:"pluginId,omitempty"`
	ContributionID string `json:"contributionId,omitempty"`
	Generation     int64  `json:"generation,omitempty"`
}

// Status 是插件报告的应用状态。Executable 是宿主机上的绝对路径，HTTP 出口负责脱敏。
type Status struct {
	AppID           string `json:"appId"`
	Installed       bool   `json:"installed"`
	State           string `json:"state,omitempty"`
	Version         string `json:"version,omitempty"`
	Executable      string `json:"executable,omitempty"`
	Running         bool   `json:"running,omitempty"`
	UpdateAvailable bool   `json:"updateAvailable,omitempty"`
}

// Step 是安装/卸载过程中的一步，映射到 Toolkit 作业的 Attempts。
type Step struct {
	ID    string `json:"id"`
	Label string `json:"label,omitempty"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// Progress 是插件返回的最终进度（v1 仅在结束时给出）。
type Progress struct {
	Percent int    `json:"percent"`
	Label   string `json:"label,omitempty"`
}

// OperateRequest 是宿主发给插件的生命周期请求。
type OperateRequest struct {
	AppID    string
	Action   string
	Platform string
	Arch     string
	// ProxyURL 只允许无认证的 loopback HTTP 代理；空表示直连。
	ProxyURL string
	// JobID 仅用于插件日志关联，不参与鉴权。
	JobID string
	// Confirmed 是宿主的授权事实；install/update/uninstall 必须为 true。
	Confirmed bool
}

// OperateResult 是插件返回的生命周期结果。
type OperateResult struct {
	OK       bool
	Changed  bool
	Status   *Status
	Steps    []Step
	Output   []string
	Message  string
	Progress *Progress
	// PID 仅用于 open/close 的进程关联，可为 0。
	PID int
}

// Source 是 Toolkit / 账号入口消费的完整端口。
type Source interface {
	// Apps 返回当前代次的应用声明；不触发 RPC。
	Apps() []App
	// Snapshot 返回最近一次状态缓存的副本；不触发 RPC。
	Snapshot() map[string]Status
	// Refresh 刷新声明与状态（单飞、带超时）。
	Refresh(ctx context.Context) error
	// Operate 执行生命周期动作。
	Operate(ctx context.Context, request OperateRequest) (OperateResult, error)
}

// Reader 是只读端口（app-entries 用），不包含操作能力。
type Reader interface {
	Apps() []App
	Snapshot() map[string]Status
}

// RefreshingReader 在只读端口上额外提供异步刷新入口。
type RefreshingReader interface {
	Reader
	Refresh(ctx context.Context) error
}

// SupportsPlatform 判断应用是否声明支持当前平台；空列表表示全平台。
func (app App) SupportsPlatform(platform string) bool {
	if len(app.Platforms) == 0 {
		return true
	}
	platform = strings.ToLower(strings.TrimSpace(platform))
	for _, item := range app.Platforms {
		if strings.ToLower(strings.TrimSpace(item)) == platform {
			return true
		}
	}
	return false
}

// AccountKind 返回应用对应的账号入口类型（desktop / cli / none）。
//
// 显式 accountKind 优先；空值时 desktop→desktop、cli→cli、ide→none。
// IDE 默认不进入账号入口：它与 Desktop 是不同产品，安装状态不能互相冒充。
func (app App) AccountKind() string {
	switch value := strings.ToLower(strings.TrimSpace(app.AccountKindValue)); value {
	case "desktop", "cli", "none":
		return value
	}
	switch app.Kind {
	case KindCLI:
		return "cli"
	case KindDesktop:
		return "desktop"
	default:
		return "none"
	}
}

// SupportsAction 判断插件是否声明了某个生命周期动作。
func (app App) SupportsAction(action string) bool {
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "install":
		return app.Capabilities.Install
	case "update":
		return app.Capabilities.Update
	case "uninstall":
		return app.Capabilities.Uninstall
	case "open", "close":
		return app.Capabilities.Open
	default:
		return false
	}
}

// RequiresConfirmation 表示该动作必须由用户显式确认。
func RequiresConfirmation(action string) bool {
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "install", "update", "uninstall":
		return true
	default:
		return false
	}
}

// CurrentPlatform 返回合同使用的平台键（macos / windows / linux）。
func CurrentPlatform() string {
	switch runtime.GOOS {
	case "darwin":
		return "macos"
	case "windows":
		return "windows"
	default:
		return "linux"
	}
}

// CurrentArch 返回合同使用的架构名。
func CurrentArch() string {
	switch runtime.GOARCH {
	case "amd64":
		return "x64"
	case "386":
		return "ia32"
	default:
		return runtime.GOARCH
	}
}
