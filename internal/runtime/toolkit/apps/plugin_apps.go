package apps

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/appinstall"
)

const pluginAppRefreshTimeout = 15 * time.Second

// triggerPluginAppRefresh 在缓存未就绪时异步刷新，绝不阻塞页面请求。
func triggerPluginAppRefresh(source appinstall.Source) {
	if source == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), pluginAppRefreshTimeout)
		defer cancel()
		_ = source.Refresh(ctx)
	}()
}

// pluginAppViews 把插件声明映射为 Toolkit 应用卡。
//
// appId 与内置应用冲突时跳过插件项：v1 不做覆盖，避免同一张卡出现两个来源。
func (m *Manager) pluginAppViews(opts Options, existing []AppView) []AppView {
	source := opts.PluginApps
	if source == nil {
		return nil
	}
	// 总是触发一次后台刷新：Refresh 内部有 30 秒 TTL 与单飞，代次切换也能在这里
	// 被发现；页面只读当前缓存，不等插件 RPC。
	triggerPluginAppRefresh(source)
	apps := source.Apps()
	statuses := source.Snapshot()
	if len(apps) == 0 {
		return nil
	}
	platform := appinstall.CurrentPlatform()
	seen := make(map[string]bool, len(existing)+len(apps))
	for _, item := range existing {
		seen[item.ID] = true
	}
	views := make([]AppView, 0, len(apps))
	for _, app := range apps {
		if seen[app.AppID] || !app.SupportsPlatform(platform) {
			continue
		}
		seen[app.AppID] = true
		status := statuses[app.AppID]
		displayPath := pluginAppDisplayPath(status.Executable)
		binaryName := strings.TrimSpace(app.Name)
		if displayPath != "" {
			binaryName = filepath.Base(displayPath)
		}
		version := status.Version
		if version == "" {
			version = "-"
			if status.Installed {
				version = "未探测到"
			}
		}
		views = append(views, AppView{
			ID:                app.AppID,
			Name:              app.Name,
			Provider:          app.Provider,
			ClientID:          app.AppID,
			ClientName:        app.Name,
			Type:              string(app.Kind),
			Categories:        pluginAppCategories(app.Kind),
			BinaryName:        binaryName,
			CLIPath:           displayPath,
			Installed:         status.Installed,
			Version:           version,
			DefaultModel:      "-",
			SupportedModels:   []string{},
			SyncMode:          "unavailable",
			HookMissingEvents: []string{},
			InstallAvailable:  app.Capabilities.Install && app.SupportsPlatform(platform),
			CanUpdate:         app.Capabilities.Update && app.SupportsPlatform(platform),
			CanUninstall:      app.Capabilities.Uninstall && app.SupportsPlatform(platform),
			Source:            "plugin",
			PluginID:          app.PluginID,
		})
	}
	return views
}

func pluginAppCategories(kind appinstall.Kind) []string {
	switch kind {
	case appinstall.KindIDE:
		return []string{"ALL", "IDE"}
	case appinstall.KindCLI:
		return []string{"ALL", "CLI Code"}
	default:
		return []string{"ALL", "Desktop"}
	}
}

func pluginAppDisplayPath(path string) string {
	value := strings.TrimSpace(path)
	if value == "" {
		return ""
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		return strings.ReplaceAll(value, home, "~")
	}
	return value
}

func findPluginApp(opts Options, appID string) *appinstall.App {
	source := opts.PluginApps
	norm := strings.ToLower(strings.TrimSpace(appID))
	if source == nil || norm == "" {
		return nil
	}
	for _, app := range source.Apps() {
		if app.AppID == norm {
			copy := app
			return &copy
		}
	}
	return nil
}

// resolveTarget 优先解析插件应用；未命中时回到内置的 appId/provider 规则。
func (m *JobManager) resolveTarget(input InstallInput) *InstallTarget {
	if app := findPluginApp(m.effectiveOpts(input), input.AppID); app != nil {
		action := normalizeLifecycleAction(input.Action, input.Action != "")
		if action == "" {
			return nil
		}
		kind := string(app.Kind)
		if kind == "ide" {
			kind = "desktop"
		}
		provider := app.Provider
		if provider == "" {
			provider = app.AppID
		}
		return &InstallTarget{
			AppID:    app.AppID,
			Provider: provider,
			Kind:     kind,
			Action:   action,
			Key:      "plugin:" + app.AppID,
		}
	}
	return ResolveInstallTarget(input)
}

func (m *JobManager) runPluginJob(ctx context.Context, jobID string, target *InstallTarget, opts Options) (bool, *JobResultView, string) {
	if opts.PluginApps == nil {
		return false, nil, "app_install_plugin_unavailable"
	}
	app := findPluginApp(opts, target.AppID)
	if app == nil {
		return false, nil, "app_install_plugin_unavailable"
	}
	m.updateProgress(jobID, 5, "插件执行"+lifecycleActionLabel(target.Action)+"："+app.Name)
	result, err := opts.PluginApps.Operate(ctx, appinstall.OperateRequest{
		AppID:    app.AppID,
		Action:   target.Action,
		Platform: appinstall.CurrentPlatform(),
		Arch:     appinstall.CurrentArch(),
		// 只传无认证的 loopback 入口：契约明确禁止带凭据，插件自身的校验也会
		// 拒绝 userinfo。带认证的 input.ProxyURL 绝不能交给第三方插件——
		// 那是租约令牌，插件把它写进日志或配置就等于泄露。
		ProxyURL: opts.AnonymousProxyURL,
		JobID:    jobID,
		// 确认是宿主事实：作业只有在用户通过 UI/命令显式提交后才会跑到这里
		// （StartRequest 的确认由调用方把关）。插件因此不再重复询问。
		Confirmed: RequiresHostConfirmation(target.Action),
	})
	if err != nil {
		return false, nil, strings.TrimSpace(err.Error())
	}
	steps := result.Steps
	for index, step := range steps {
		percent := 10
		if len(steps) > 0 {
			percent = 10 + (index+1)*80/len(steps)
		}
		label := step.Label
		if label == "" {
			label = step.ID
		}
		m.appendAttempt(jobID, AttemptView{
			ID:    firstNonEmpty(step.ID, "plugin_step"),
			Label: label,
			OK:    step.OK,
			Error: step.Error,
		}, percent, label)
	}
	if result.Progress != nil {
		m.updateProgress(jobID, result.Progress.Percent, result.Progress.Label)
	}
	installed := result.OK
	if target.Action == "uninstall" {
		installed = false
	}
	if result.Status != nil {
		installed = result.Status.Installed
	}
	executable := ""
	if result.Status != nil {
		executable = pluginAppDisplayPath(result.Status.Executable)
	}
	finalResult := &JobResultView{Installed: installed, CLIPath: executable, ExecutablePath: executable}
	if !result.OK {
		return false, finalResult, firstNonEmpty(result.Message, "插件执行失败")
	}
	return true, finalResult, ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// RequiresHostConfirmation 表示该动作在宿主侧必须已获得用户确认。
//
// 与 appinstall.RequiresConfirmation 同义，单独导出是为了让作业层不直接依赖
// 数据模型包：哪一类动作需要确认属于作业语义，不是插件的字段。
func RequiresHostConfirmation(action string) bool {
	return appinstall.RequiresConfirmation(action)
}
