package aihcli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/providerlaunch"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
	"github.com/madou1217/ai_home/internal/runtime/providercliupgrade"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/apps"
	"github.com/madou1217/ai_home/internal/runtime/updateproxy"
)

// providerCLIUpdateRefreshTimeout 是后台版本刷新（不阻断启动）的硬上限。
const providerCLIUpdateRefreshTimeout = 20 * time.Second

// providerCLIUpdateFirstCheckTimeout 是首次（无缓存）版本检查的硬上限：
// 这一处是唯一可能等待官方版本源的启动路径，缓存建立后不再阻塞。
const providerCLIUpdateFirstCheckTimeout = 4 * time.Second

// providerCLIVersionInfo 是可比较的 CLI 版本事实。
type providerCLIVersionInfo struct {
	Current         string
	Latest          string
	UpdateAvailable bool
}

// providerCLILifecycle 是组合根对工具箱 CLI 安装/版本能力的窄端口。
// 「官方 CLI 装在哪里、怎么装、有没有新版本」只由工具箱回答，Host 不复制这些事实。
type providerCLILifecycle interface {
	// Resolve 用安装器认可的位置解析可执行文件；空表示未找到。
	Resolve(providerID, binary string) string
	// InstalledPath 返回工具箱认定的已安装 CLI 路径。
	InstalledPath(providerID string) string
	// InstallPlanLabel 返回官方安装器名称；空表示没有 CLI 安装计划。
	InstallPlanLabel(providerID string) string
	// Install 运行官方安装器，返回验证过的可执行路径。
	Install(ctx context.Context, providerID string, progress func(string)) (string, error)
	// CachedUpdateStatus 只读本地版本缓存；ok=false 表示缓存缺失或已过期。
	CachedUpdateStatus(providerID string) (providerCLIVersionInfo, bool)
	// CheckUpdate 有界查询版本事实；调用方负责超时。
	CheckUpdate(ctx context.Context, providerID string) (providerCLIVersionInfo, bool)
	// RefreshUpdateStatus 在后台刷新版本缓存（不输出、不阻断启动）。
	RefreshUpdateStatus(ctx context.Context, providerID string)
}

// providerCLIPlanTarget 描述一次启动真正要执行的官方 CLI。
type providerCLIPlanTarget struct {
	ProviderID string
	Binary     string
}

// providerCLIPlanTargetFromPlan 从规划结果提取 CLI 目标；两种模式共用同一套闭环。
func providerCLIPlanTargetFromPlan(plan providerlaunch.LaunchPlan) (providerCLIPlanTarget, bool) {
	if native, ok := plan.Native(); ok {
		return providerCLIPlanTarget{ProviderID: native.ProviderID(), Binary: native.Binary()}, true
	}
	if gateway, ok := plan.Gateway(); ok {
		return providerCLIPlanTarget{ProviderID: gateway.ClientProviderID(), Binary: gateway.Binary()}, true
	}
	return providerCLIPlanTarget{}, false
}

// appsCLILifecycle 把工具箱的安装/版本实现适配成上面的窄端口。
type appsCLILifecycle struct {
	options apps.Options
	// egress 在留空时按需装配：缺失 CLI 的自动安装也要能走自动代理。
	// 由 newAppsCLILifecycle 注入，保持「谁可以换出口」这一决定的唯一来源。
	egress egressProvider
}

// egressProvider 提供「自动代理轮换」与面向用户的告知端口。
// 返回 nil 表示当前没有可用管理面，安装保持直连语义。
type egressProvider func(notify func(string)) *updateproxy.EgressRotation

func newAppsCLILifecycle(aiHomeDir, hostHomeDir string, egress egressProvider) appsCLILifecycle {
	environment := make(map[string]string)
	for _, entry := range os.Environ() {
		name, value, found := strings.Cut(entry, "=")
		if found && name != "" {
			environment[name] = value
		}
	}
	return appsCLILifecycle{options: apps.Options{
		AIHomeDir:   aiHomeDir,
		HostHomeDir: hostHomeDir,
		Platform:    runtime.GOOS,
		Env:         environment,
	}, egress: egress}
}

func (lifecycle appsCLILifecycle) Resolve(providerID, binary string) string {
	return apps.ResolveBinaryPath(providerID, binary, lifecycle.options)
}

func (lifecycle appsCLILifecycle) InstalledPath(providerID string) string {
	return apps.ResolveProviderCLIPath(providerID, lifecycle.options)
}

func (lifecycle appsCLILifecycle) InstallPlanLabel(providerID string) string {
	plans := apps.ResolveLifecyclePlans(
		providerID,
		"cli",
		"install",
		lifecycle.options,
		lifecycle.InstalledPath(providerID),
		nil,
	)
	for _, plan := range plans {
		if label := strings.TrimSpace(plan.Label); label != "" {
			return label
		}
	}
	return ""
}

func (lifecycle appsCLILifecycle) Install(
	ctx context.Context,
	providerID string,
	progress func(string),
) (string, error) {
	var rotation *updateproxy.EgressRotation
	if lifecycle.egress != nil {
		rotation = lifecycle.egress(func(message string) {
			_, _ = fmt.Fprintln(os.Stderr, message)
		})
	}
	// 与 aih <provider> install 共用同一个循环：直连失败于网络层才启用代理，
	// 出口不可用则按服务端候选顺序换下一个。
	lastProxyURL := ""
	result, _, err := updateproxy.RetryWithEgress(
		ctx, rotation, installEgressMaxAttempts,
		func(err error) (string, bool) { return providercliupgrade.EgressFailureReason(err.Error()) },
		func(proxyURL string) (apps.CLIUpdateResult, error) {
			lastProxyURL = proxyURL
			options := lifecycle.options
			if proxyURL != "" {
				env, envErr := updateproxy.Environment(options.Env, proxyURL)
				if envErr != nil {
					return apps.CLIUpdateResult{}, envErr
				}
				options.Env = env
			}
			// explicitProxy 必须跟随本轮是否真的配了代理：Windows 上它决定
			// 「官方安装器能否保证所有下载都走代理」，漏掉就会静默直连。
			return apps.InstallCLI(ctx, providerID, options, proxyURL != "", progress)
		},
	)
	if err != nil {
		return "", errors.New(updateproxy.Redact(err.Error(), lastProxyURL))
	}
	return result.CLIPath, nil
}

// installEgressMaxAttempts 是自动代理在自动安装路径上最多尝试的出口数。
const installEgressMaxAttempts = 4

func (lifecycle appsCLILifecycle) CachedUpdateStatus(providerID string) (providerCLIVersionInfo, bool) {
	return cliLifecycleVersionInfo(apps.CachedCLIUpdateStatus(providerID, lifecycle.options))
}

func (lifecycle appsCLILifecycle) CheckUpdate(
	ctx context.Context,
	providerID string,
) (providerCLIVersionInfo, bool) {
	return cliLifecycleVersionInfo(apps.CheckCLIUpdate(ctx, providerID, lifecycle.options))
}

func cliLifecycleVersionInfo(status apps.CLIUpdateStatus, ok bool) (providerCLIVersionInfo, bool) {
	if !ok {
		return providerCLIVersionInfo{}, false
	}
	return providerCLIVersionInfo{
		Current:         status.CurrentVersion,
		Latest:          status.LatestVersion,
		UpdateAvailable: status.UpdateAvailable,
	}, true
}

func (lifecycle appsCLILifecycle) RefreshUpdateStatus(ctx context.Context, providerID string) {
	// 后台刷新允许慢查询：它在 TUI 运行期间完成，下一次启动即可零延迟提示。
	checkCtx, cancel := context.WithTimeout(ctx, providerCLIUpdateRefreshTimeout)
	defer cancel()
	_, _ = apps.CheckCLIUpdate(checkCtx, providerID, lifecycle.options)
}

// providerCLIRemediationEligible 判断缺失的 CLI 是否由组合根闭环处理。
//
// Codex 有受管运行时与专用修复入口，WorkBuddy 运行时只随桌面 App 分发；
// 两者保留原有失败语义，避免闭环安装出与运行时不匹配的二进制。
func (app *App) providerCLIRemediationEligible(providerID string) bool {
	if app == nil || app.cliLifecycle == nil {
		return false
	}
	normalized := strings.ToLower(strings.TrimSpace(providerID))
	if normalized == "" || normalized == "codex" {
		return false
	}
	if providercli.UsesDesktopBundledRuntime(normalized) {
		return false
	}
	return strings.TrimSpace(app.cliLifecycle.InstallPlanLabel(normalized)) != ""
}

// providerCLILabel 返回面向用户的 Provider 名称；未知时回落 ID。
func (app *App) providerCLILabel(providerID string) string {
	if app != nil && app.catalog != nil {
		if definition, found := app.catalog.Get(strings.ToLower(strings.TrimSpace(providerID))); found {
			if label := strings.TrimSpace(definition.Presentation.Label); label != "" {
				return label
			}
		}
	}
	return providerID
}

// providerCLIUpdateNotice 在交互式启动前给出可操作的新版本提示。
// 有新鲜缓存时零网络等待；没有缓存时只做一次有界查询（首次启动），
// 之后由后台刷新维持。启动永远继续，用户决定是否 update。
func (app *App) providerCLIUpdateNotice(ctx context.Context, providerID string) string {
	if app == nil || app.cliLifecycle == nil || !app.interactive || app.stderr == nil {
		return ""
	}
	info, ok := app.cliLifecycle.CachedUpdateStatus(providerID)
	if !ok && app.cliLifecycle != nil && ctx != nil {
		checkCtx, cancel := context.WithTimeout(ctx, providerCLIUpdateFirstCheckTimeout)
		info, ok = app.cliLifecycle.CheckUpdate(checkCtx, providerID)
		cancel()
	}
	if !ok || !info.UpdateAvailable || info.Current == "" || info.Latest == "" {
		return ""
	}
	normalized := strings.ToLower(strings.TrimSpace(providerID))
	return fmt.Sprintf(
		"[aih] %s CLI 有新版本可用：%s → %s；更新后重试：aih %s update",
		app.providerCLILabel(normalized),
		info.Current,
		info.Latest,
		normalized,
	)
}

// refreshProviderCLIVersion 在 TUI 运行期间后台刷新版本缓存；不打印、不阻断，
// 下一次启动的提示因此是零延迟的。非交互/无安装计划时不做网络副作用。
func (app *App) refreshProviderCLIVersion(providerID string) {
	if app == nil || app.cliLifecycle == nil || !app.interactive {
		return
	}
	go app.cliLifecycle.RefreshUpdateStatus(context.Background(), providerID)
}

// providerCLIMissingExit 表示已完成安装引导并取消启动，命令入口不再重复打印。
type providerCLIMissingExit struct{}

func (providerCLIMissingExit) Error() string { return "provider_cli_missing" }
func (providerCLIMissingExit) ExitCode() int { return 1 }
func (providerCLIMissingExit) SilentExit()   {}

// remediateProviderCLI 在官方 CLI 缺失时完成闭环：
//   - 非交互/无安装计划：给出安装入口后安静失败；
//   - 交互式终端：说明原因并询问 [Y/n]，同意后直接运行官方安装器；
//   - 安装成功返回 installed=true，调用方重试一次启动。
func (app *App) remediateProviderCLI(
	ctx context.Context,
	target providerCLIPlanTarget,
) (bool, error) {
	if !app.providerCLIRemediationEligible(target.ProviderID) {
		return false, nil
	}
	providerID := strings.ToLower(strings.TrimSpace(target.ProviderID))
	label := app.providerCLILabel(providerID)
	planLabel := app.cliLifecycle.InstallPlanLabel(providerID)
	stderr := app.stderr
	if stderr == nil {
		stderr = io.Discard
	}
	_, _ = fmt.Fprintf(stderr, "[aih] 未找到 %s 官方 CLI（%s）。\n", label, target.Binary)
	_, _ = fmt.Fprintf(stderr, "[aih] 官方安装器：%s\n", planLabel)
	if !app.interactive {
		_, _ = fmt.Fprintf(
			stderr,
			"[aih] 安装后重试：aih %s install；也可以直接重新运行 aih %s。\n",
			providerID,
			providerID,
		)
		return false, providerCLIMissingExit{}
	}
	_, _ = fmt.Fprint(stderr, "[aih] 现在运行官方安装器吗？[Y/n] ")
	answer, readErr := readConfirmation(app.stdin)
	if errors.Is(readErr, io.EOF) && strings.TrimSpace(answer) == "" {
		_, _ = fmt.Fprintln(stderr)
		_, _ = fmt.Fprintf(stderr, "[aih] 未读取到确认，已跳过安装。安装入口：aih %s install\n", providerID)
		return false, providerCLIMissingExit{}
	}
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		return false, fmt.Errorf("%s CLI 安装确认读取失败: %w", label, readErr)
	}
	if !confirmedInstall(answer) {
		_, _ = fmt.Fprintf(stderr, "[aih] 已跳过安装。之后可运行 aih %s install 安装。\n", providerID)
		return false, providerCLIMissingExit{}
	}
	_, _ = fmt.Fprintln(stderr, "[aih] 正在运行官方安装器…")
	installedPath, installErr := app.cliLifecycle.Install(ctx, providerID, func(step string) {
		if step = strings.TrimSpace(step); step != "" {
			_, _ = fmt.Fprintf(stderr, "[aih] 安装步骤：%s\n", step)
		}
	})
	if installErr != nil {
		_, _ = fmt.Fprintf(stderr, "[aih] 安装失败：%s\n", redactProxyEnvValues(installErr.Error()))
		_, _ = fmt.Fprintf(
			stderr,
			"[aih] 可稍后重试：aih %s install --proxy auto（或指定可用代理）。\n",
			providerID,
		)
		return false, fmt.Errorf("%s CLI 安装失败", label)
	}
	if strings.TrimSpace(installedPath) == "" {
		installedPath = app.cliLifecycle.Resolve(providerID, target.Binary)
	}
	if strings.TrimSpace(installedPath) == "" {
		_, _ = fmt.Fprintf(
			stderr,
			"[aih] 安装器已结束，但未能确认 %s CLI 路径；请运行 aih %s version 检查后重试。\n",
			label,
			providerID,
		)
		return false, providerCLIMissingExit{}
	}
	_, _ = fmt.Fprintf(stderr, "[aih] 已安装 %s CLI：%s\n", label, installedPath)
	return true, nil
}

// confirmedInstall 把常见肯定回答视为同意；空回车默认安装（[Y/n]）。
func confirmedInstall(answer string) bool {
	switch strings.ToLower(strings.TrimSpace(answer)) {
	case "", "y", "yes", "是", "好", "安装":
		return true
	default:
		return false
	}
}

// readConfirmation 逐字节读取一行，避免缓冲过多输入抢走即将交给 TUI 的按键。
func readConfirmation(reader io.Reader) (string, error) {
	if reader == nil {
		return "", io.EOF
	}
	var builder strings.Builder
	buffer := make([]byte, 1)
	for {
		count, err := reader.Read(buffer)
		if count > 0 {
			switch buffer[0] {
			case '\n':
				return builder.String(), nil
			case '\r':
			default:
				builder.WriteByte(buffer[0])
				if builder.Len() > 32 {
					return builder.String(), nil
				}
			}
		}
		if err != nil {
			return builder.String(), err
		}
	}
}

// redactProxyEnvValues 防止安装器错误信息把代理凭据带回终端或日志。
func redactProxyEnvValues(message string) string {
	for _, entry := range os.Environ() {
		name, value, found := strings.Cut(entry, "=")
		if !found || len(value) < 8 {
			continue
		}
		upper := strings.ToUpper(name)
		if upper != "ALL_PROXY" && !strings.HasSuffix(upper, "_PROXY") {
			continue
		}
		message = strings.ReplaceAll(message, value, "<proxy>")
	}
	return message
}
