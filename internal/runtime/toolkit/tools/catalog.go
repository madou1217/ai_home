package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/configedit"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

// LifecycleFlags 表示安装/更新/卸载三项操作许可。
type LifecycleFlags struct {
	Install   bool `json:"install"`
	Update    bool `json:"update"`
	Uninstall bool `json:"uninstall"`
}

// ToolView 表示单个受管工具的完整视图（字段与 Node listManagedTools 对齐）。
type ToolView struct {
	ID                 string         `json:"id"`
	Category           string         `json:"category"`
	Name               string         `json:"name"`
	Role               string         `json:"role"`
	Supported          bool           `json:"supported"`
	Installed          bool           `json:"installed"`
	ExecutablePath     string         `json:"executablePath"`
	BinaryName         string         `json:"binaryName"`
	Version            string         `json:"version"`
	ServiceManager     string         `json:"serviceManager"`
	Capabilities       []string       `json:"capabilities"`
	RuntimeInspectable bool           `json:"runtimeInspectable"`
	Running            bool           `json:"running"`
	RunningCount       int            `json:"runningCount"`
	StartupManaged     bool           `json:"startupManaged"`
	StartupSources     []string       `json:"startupSources"`
	ConfigSource       string         `json:"configSource"`
	ConfigName         string         `json:"configName"`
	ConfigFormat       string         `json:"configFormat"`
	ConfigExists       bool           `json:"configExists"`
	ConfigWritable     bool           `json:"configWritable"`
	RequiresElevation  bool           `json:"requiresElevation"`
	ConfigEditable     bool           `json:"configEditable"`
	ConfigNote         string         `json:"configNote,omitempty"`
	ConfigCount        int            `json:"configCount"`
	ConfigAmbiguous    bool           `json:"configAmbiguous"`
	ConfigState        string         `json:"configState"`
	ManagedDir         string         `json:"managedDir,omitempty"`
	ManagedPath        string         `json:"managedPath,omitempty"`
	ManagedBy          string         `json:"managedBy"`
	Method             string         `json:"method,omitempty"`
	CanInstall         bool           `json:"canInstall"`
	CanUpdate          bool           `json:"canUpdate"`
	CanUninstall       bool           `json:"canUninstall"`
	Lifecycle          LifecycleFlags `json:"lifecycle"`
	Service            *ServiceStatus `json:"service,omitempty"`
}

// ListResult 是 GET /toolkit/tools 的响应结构。
type ListResult struct {
	OK             bool           `json:"ok"`
	Platform       string         `json:"platform"`
	Categories     []ToolCategory `json:"categories"`
	Total          int            `json:"total"`
	InstalledCount int            `json:"installedCount"`
	Tools          []ToolView     `json:"tools"`
}

// ReadConfigResult 是 GET /toolkit/tools/:id/config 的响应结构。
type ReadConfigResult struct {
	configedit.ReadResult
	ToolID         string `json:"toolId"`
	TargetRevision string `json:"targetRevision"`
}

// SaveConfigResult 是 PUT /toolkit/tools/:id/config 的响应结构。
type SaveConfigResult struct {
	configedit.SaveResult
	ToolID         string `json:"toolId"`
	TargetRevision string `json:"targetRevision"`
}

// ListManagedTools 探测当前平台上所有受管工具的二进制、版本、配置及服务状态。
func ListManagedTools(ctx context.Context, opts Options, services *ServiceManager) ListResult {
	o := opts.withDefaults()
	platform := o.nodePlatform()
	includeService := true
	if o.IncludeService != nil {
		includeService = *o.IncludeService
	}
	if o.ProcessEntriesOverride == nil {
		o.ProcessEntriesOverride = ReadProcessEntries(ctx, o, networkToolIDs)
	}
	networkRuntime := DiscoverNetworkTools(ctx, o)
	plugins := listToolPlugins(platform)
	tools := make([]ToolView, 0, len(plugins))
	installedCount := 0

	for _, plugin := range plugins {
		rt := networkRuntime[plugin.ID]
		resolvedCmd := resolvePluginCommand(ctx, plugin, o)
		preferred := ""
		if plugin.PreferredExecutable != nil {
			preferred = strings.TrimSpace(plugin.PreferredExecutable(o))
		}
		exePath := preferred
		if exePath == "" {
			exePath = resolvedCmd
		}
		if exePath == "" && (rt.ExecutableExists || rt.Running) {
			exePath = strings.TrimSpace(rt.ExecutablePath)
		}

		binaryName := ""
		if len(plugin.Commands) > 0 {
			binaryName = plugin.Commands[0]
		}
		if exePath != "" {
			binaryName = envPlatformBase(platform, exePath)
		}

		installed := exePath != "" || (plugin.RuntimeInspectable && rt.Running)
		if installed {
			installedCount++
		}
		version := "-"
		if exePath != "" {
			if probed := probeToolVersion(ctx, plugin, exePath, o); probed != "" {
				version = probed
			} else {
				version = "未探测到"
			}
		}

		cfgMeta := inspectToolConfig(o, plugin, rt)
		view := ToolView{
			ID:                 plugin.ID,
			Category:           plugin.Category,
			Name:               plugin.Name,
			Role:               plugin.Role,
			Supported:          true,
			Installed:          installed,
			ExecutablePath:     exePath,
			BinaryName:         binaryName,
			Version:            version,
			ServiceManager:     serviceManagerForPlatform(platform),
			Capabilities:       append([]string{}, plugin.Capabilities...),
			RuntimeInspectable: plugin.RuntimeInspectable,
			Running:            plugin.RuntimeInspectable && rt.Running,
			RunningCount:       condInt(plugin.RuntimeInspectable, rt.RunningCount),
			StartupManaged:     plugin.RuntimeInspectable && rt.StartupManaged,
			StartupSources:     condSlice(plugin.RuntimeInspectable, rt.StartupSources),
			ConfigSource:       firstNonEmpty(cfgMeta.ConfigSource, condStr(plugin.RuntimeInspectable, rt.ConfigSource)),
			ConfigName:         cfgMeta.ConfigName,
			ConfigFormat:       cfgMeta.ConfigFormat,
			ConfigExists:       cfgMeta.ConfigExists,
			ConfigWritable:     cfgMeta.ConfigWritable,
			RequiresElevation:  cfgMeta.RequiresElevation,
			ConfigEditable:     cfgMeta.ConfigEditable,
			ConfigNote:         cfgMeta.ConfigNote,
			ConfigCount:        cfgMeta.ConfigCount,
			ConfigAmbiguous:    cfgMeta.ConfigAmbiguous,
			ConfigState:        cfgMeta.ConfigState,
		}
		if view.StartupSources == nil {
			view.StartupSources = []string{}
		}
		describePluginLifecycle(ctx, plugin, &view, o)
		if plugin.Service != nil && includeService {
			if services == nil {
				services = NewServiceManager(o)
			}
			svc := services.describeWithRuntime(ctx, plugin, view, rt.ConfigPath, o)
			view.Service = &svc
		}
		tools = append(tools, view)
	}

	return ListResult{
		OK:             true,
		Platform:       toClientPlatform(platform),
		Categories:     ToolkitToolCategories(),
		Total:          len(tools),
		InstalledCount: installedCount,
		Tools:          tools,
	}
}

func resolvePluginCommand(ctx context.Context, plugin toolPlugin, o Options) string {
	if !pluginSupportsPlatform(plugin, o.nodePlatform()) {
		return ""
	}
	for _, cmd := range plugin.Commands {
		if resolved := ResolveCommandPath(ctx, cmd, o); resolved != "" {
			return resolved
		}
	}
	if plugin.ResolveExecutableFallback != nil {
		return strings.TrimSpace(plugin.ResolveExecutableFallback(o))
	}
	return ""
}

func probeToolVersion(ctx context.Context, plugin toolPlugin, executablePath string, o Options) string {
	if executablePath == "" {
		return ""
	}
	for _, args := range plugin.VersionArgs {
		res := o.Exec.Run(ctx, executablePath, args, environment.ExecOptions{Timeout: defaultDiscoveryTimeout})
		if !res.OK {
			continue
		}
		combined := res.Stdout + "\n" + res.Stderr
		if parsed := ParseVersionOutput(combined); parsed != "" {
			return parsed
		}
		for _, line := range strings.Split(strings.TrimSpace(combined), "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed != "" {
				if len(trimmed) > 64 {
					return trimmed[:64]
				}
				return trimmed
			}
		}
	}
	return ""
}

type configInspectResult struct {
	ConfigName        string
	ConfigFormat      string
	ConfigExists      bool
	ConfigWritable    bool
	RequiresElevation bool
	ConfigEditable    bool
	ConfigNote        string
	ConfigSource      string
	ConfigCount       int
	ConfigAmbiguous   bool
	ConfigState       string
}

func inspectToolConfig(o Options, plugin toolPlugin, rt NetworkToolRuntime) configInspectResult {
	if plugin.Config == nil {
		return configInspectResult{ConfigState: "none"}
	}
	platform := o.nodePlatform()
	resolved := resolveConfigTargetFromRuntime(o, plugin, rt)
	targetPath := strings.TrimSpace(resolved.ConfigPath)
	exists := targetPath != "" && envBoolExists(o, targetPath)
	writable := false
	if targetPath != "" {
		if platform == "win32" {
			writable = canWritePathSimple(targetPath)
		} else {
			writable = configedit.CanWriteTarget(targetPath)
		}
	}
	format := plugin.Config.Format
	if format == "" && targetPath != "" {
		format = configedit.ConfigFormat(targetPath)
	}
	state := resolved.ConfigState
	if state == "" {
		if exists {
			state = "single"
		} else {
			state = "none"
		}
	}
	count := resolved.ConfigCount
	if count == 0 && exists {
		count = 1
	}
	configName := ""
	if targetPath != "" {
		configName = envPlatformBase(platform, targetPath)
	}
	return configInspectResult{
		ConfigName:        configName,
		ConfigFormat:      format,
		ConfigExists:      exists,
		ConfigWritable:    writable,
		RequiresElevation: targetPath != "" && !writable,
		ConfigEditable:    targetPath != "" && !resolved.ConfigAmbiguous && (exists || plugin.Config.HasTemplate),
		ConfigNote:        plugin.Config.Note,
		ConfigSource:      resolved.ConfigSource,
		ConfigCount:       count,
		ConfigAmbiguous:   resolved.ConfigAmbiguous,
		ConfigState:       state,
	}
}

func canWritePathSimple(targetPath string) bool {
	cur := filepath.Clean(targetPath)
	for cur != "" {
		info, err := os.Stat(cur)
		if err == nil {
			if info.IsDir() {
				f, err := os.CreateTemp(cur, ".aih-wtest-*")
				if err != nil {
					return false
				}
				name := f.Name()
				_ = f.Close()
				_ = os.Remove(name)
				return true
			}
			f, err := os.OpenFile(cur, os.O_WRONLY|os.O_APPEND, 0)
			if err != nil {
				return false
			}
			_ = f.Close()
			return true
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	return false
}

func resolveConfigTargetFromRuntime(o Options, plugin toolPlugin, rt NetworkToolRuntime) NetworkToolRuntime {
	if plugin.Config == nil {
		return rt
	}
	if plugin.Config.ResolvePath == nil {
		return rt
	}
	cfgPath := strings.TrimSpace(plugin.Config.ResolvePath(o))
	exists := cfgPath != "" && envBoolExists(o, cfgPath)
	state := "none"
	count := 0
	if exists {
		state = "single"
		count = 1
	}
	out := rt
	out.ConfigPath = cfgPath
	out.ConfigCount = count
	out.ConfigAmbiguous = false
	out.ConfigState = state
	out.ConfigSource = "standard-path"
	return out
}

func buildToolConfigTarget(ctx context.Context, toolID string, o Options) (toolPlugin, configedit.Target, configedit.Options, error) {
	normalized := strings.ToLower(strings.TrimSpace(toolID))
	plugin, ok := getToolPlugin(normalized)
	if !ok {
		return toolPlugin{}, configedit.Target{}, configedit.Options{}, configedit.NewError("unsupported_tool", "不支持管理工具 "+firstNonEmpty(normalized, "unknown"))
	}
	if plugin.Config == nil {
		return toolPlugin{}, configedit.Target{}, configedit.Options{}, configedit.NewError("tool_config_unsupported", plugin.Name+" 没有可直接编辑的本地配置文件")
	}
	var rt NetworkToolRuntime
	if plugin.Config.ResolvePath == nil {
		rt = DiscoverNetworkTools(ctx, o)[plugin.ID]
	} else {
		rt = resolveConfigTargetFromRuntime(o, plugin, NetworkToolRuntime{})
	}
	if rt.ConfigState == "unresolved" {
		return toolPlugin{}, configedit.Target{}, configedit.Options{}, configedit.NewError("config_target_unresolved", plugin.Name+" 运行或启动参数指向的配置当前无法安全读取")
	}
	if rt.ConfigAmbiguous {
		return toolPlugin{}, configedit.Target{}, configedit.Options{}, configedit.NewError("config_target_ambiguous", "发现多个 "+plugin.Name+" 配置文件，无法在隐藏路径的前提下安全确定编辑目标")
	}
	targetPath := strings.TrimSpace(rt.ConfigPath)
	if targetPath == "" {
		return toolPlugin{}, configedit.Target{}, configedit.Options{}, configedit.NewError("config_target_unavailable", "当前平台没有可解析的配置目标")
	}
	platform := o.nodePlatform()
	format := plugin.Config.Format
	if detected := configedit.ConfigFormat(targetPath); detected != "" && plugin.Config.ResolvePath == nil {
		format = detected
	}
	target := configedit.Target{
		AppID:        normalized,
		Provider:     normalized,
		Platform:     toClientPlatform(platform),
		HostHomeDir:  o.hostHome(),
		TargetPath:   targetPath,
		ConfigName:   envPlatformBase(platform, targetPath),
		ConfigFormat: format,
	}
	editOpts := configedit.Options{
		Exec:           o.Exec,
		AllowCreate:    plugin.Config.HasTemplate,
		DefaultContent: plugin.Config.Template,
	}
	return plugin, target, editOpts, nil
}

// ReadToolConfig 读取指定受管工具的配置文件内容与目标令牌。
func ReadToolConfig(ctx context.Context, toolID string, opts Options) (ReadConfigResult, error) {
	o := opts.withDefaults()
	_, target, editOpts, err := buildToolConfigTarget(ctx, toolID, o)
	if err != nil {
		return ReadConfigResult{}, err
	}
	readRes, err := configedit.ReadTarget(ctx, target, editOpts)
	if err != nil {
		return ReadConfigResult{}, err
	}
	return ReadConfigResult{
		ReadResult:     readRes,
		ToolID:         target.AppID,
		TargetRevision: configedit.ComputeTargetRevision(target.TargetPath, o.nodePlatform()),
	}, nil
}

// SaveToolConfig 核对目标令牌并执行格式/二进制校验后原子保存工具配置。
func SaveToolConfig(ctx context.Context, toolID string, content string, expectedRevision string, expectedTargetRevision string, opts Options) (SaveConfigResult, error) {
	o := opts.withDefaults()
	plugin, target, editOpts, err := buildToolConfigTarget(ctx, toolID, o)
	if err != nil {
		return SaveConfigResult{}, err
	}
	currentTargetRevision := configedit.ComputeTargetRevision(target.TargetPath, o.nodePlatform())
	if expectedTargetRevision == "" || expectedTargetRevision != currentTargetRevision {
		return SaveConfigResult{}, configedit.NewError("config_target_changed", "配置目标在编辑期间发生变化，请重新读取后再保存")
	}
	if plugin.Config != nil && plugin.Config.Validate != nil {
		noSvc := false
		listOpts := o
		listOpts.IncludeService = &noSvc
		var exePath string
		for _, t := range ListManagedTools(ctx, listOpts, nil).Tools {
			if t.ID == plugin.ID {
				exePath = t.ExecutablePath
				break
			}
		}
		verdict := plugin.Config.Validate(ctx, content, exePath, target.TargetPath, o)
		if !verdict.OK {
			return SaveConfigResult{}, configedit.NewError("config_validation_failed", "配置校验未通过："+verdict.Message)
		}
	}
	editOpts.ExpectedRevision = expectedRevision
	saveRes, err := configedit.SaveTarget(ctx, target, content, editOpts)
	if err != nil {
		return SaveConfigResult{}, err
	}
	return SaveConfigResult{
		SaveResult:     saveRes,
		ToolID:         target.AppID,
		TargetRevision: currentTargetRevision,
	}, nil
}

func serviceManagerForPlatform(platform string) string {
	switch platform {
	case "win32":
		return "windows-service"
	case "darwin":
		return "launchd-or-homebrew"
	case "linux":
		return "systemd"
	default:
		return "unknown"
	}
}

func condInt(cond bool, v int) int {
	if cond {
		return v
	}
	return 0
}

func condSlice(cond bool, v []string) []string {
	if !cond || v == nil {
		return []string{}
	}
	return append([]string{}, v...)
}

func condStr(cond bool, v string) string {
	if cond {
		return v
	}
	return ""
}
