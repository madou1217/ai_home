package tools

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

// PlanToolRef 表示计划关联的工具摘要。
type PlanToolRef struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Category string `json:"category"`
}

// PlanResponse 是 POST /toolkit/tools/plan 与内部规划接口的返回格式。
type PlanResponse struct {
	OK       bool               `json:"ok"`
	Error    string             `json:"error,omitempty"`
	Message  string             `json:"message,omitempty"`
	Platform string             `json:"platform,omitempty"`
	Tool     *PlanToolRef       `json:"tool,omitempty"`
	Action   string             `json:"action,omitempty"`
	Label    string             `json:"label,omitempty"`
	Plans    []environment.Plan `json:"plans,omitempty"`
	Current  *ToolView          `json:"current,omitempty"`
}

var actionLabels = map[string]string{
	"install":   "安装",
	"update":    "更新",
	"uninstall": "卸载",
}

func normalizeToolAction(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "install", "update", "uninstall":
		return strings.ToLower(strings.TrimSpace(v))
	default:
		return ""
	}
}

func sameToolPath(left string, right string, platform string) bool {
	if strings.TrimSpace(left) == "" || strings.TrimSpace(right) == "" {
		return false
	}
	l := envPlatformNormalize(platform, left)
	r := envPlatformNormalize(platform, right)
	if platform == "win32" {
		return strings.EqualFold(l, r)
	}
	return l == r
}

type frpcOwnership struct {
	ExecutablePath string
	Managed        bool
	Homebrew       bool
	External       bool
}

func inspectFrpcOwnership(ctx context.Context, exePath string, o Options) frpcOwnership {
	platform := o.nodePlatform()
	managed := sameToolPath(exePath, ResolveManagedFrpcPath(o), platform)
	homebrew := !managed && isHomebrewFrpc(ctx, exePath, o)
	external := !managed && !homebrew && NormalizeExternalFrpcPath(exePath, o) != ""
	return frpcOwnership{
		ExecutablePath: strings.TrimSpace(exePath),
		Managed:        managed,
		Homebrew:       homebrew,
		External:       external,
	}
}

func isHomebrewFrpc(ctx context.Context, exePath string, o Options) bool {
	if o.nodePlatform() != "darwin" {
		return false
	}
	norm := strings.ReplaceAll(strings.TrimSpace(exePath), `\`, `/`)
	lower := strings.ToLower(norm)
	if strings.Contains(lower, "/homebrew/bin/frpc") || strings.Contains(lower, "/homebrew/cellar/frpc") ||
		strings.Contains(lower, "/linuxbrew/bin/frpc") || strings.Contains(lower, "/linuxbrew/cellar/frpc") ||
		strings.HasPrefix(norm, "/opt/homebrew/bin/frpc") || strings.HasPrefix(norm, "/opt/homebrew/Cellar/frpc") ||
		strings.HasPrefix(norm, "/usr/local/bin/frpc") || strings.HasPrefix(norm, "/usr/local/Cellar/frpc") {
		return true
	}
	brewPath := ResolveCommandPath(ctx, "brew", o)
	if brewPath == "" {
		return false
	}
	res := o.Exec.Run(ctx, brewPath, []string{"list", "--formula", "frpc"}, environment.ExecOptions{Timeout: defaultDiscoveryTimeout})
	return res.OK
}

type pkgMethod struct {
	Kind           string
	Formula        string
	AptPackages    []string
	ArchiveURL     string
	BinaryRelative string
	WingetID       string
}

func methodForPackage(desc *packageLifecycleDescriptor, platform string) *pkgMethod {
	if desc == nil {
		return nil
	}
	if platform == "darwin" && desc.Homebrew != "" {
		return &pkgMethod{Kind: "homebrew", Formula: desc.Homebrew}
	}
	if platform == "linux" && len(desc.AptPackages) > 0 {
		return &pkgMethod{Kind: "apt", AptPackages: desc.AptPackages}
	}
	if platform == "win32" && desc.WindowsArchive != nil && strings.TrimSpace(desc.WindowsArchive.URL) != "" {
		return &pkgMethod{Kind: "archive", ArchiveURL: strings.TrimSpace(desc.WindowsArchive.URL), BinaryRelative: strings.TrimSpace(desc.WindowsArchive.BinaryRelative)}
	}
	if platform == "win32" && desc.Winget != "" {
		return &pkgMethod{Kind: "winget", WingetID: desc.Winget}
	}
	return nil
}

func isHomebrewFormulaPath(targetPath string, formula string) bool {
	if strings.TrimSpace(targetPath) == "" || strings.TrimSpace(formula) == "" {
		return false
	}
	resolved, err := filepath.EvalSymlinks(targetPath)
	if err != nil {
		resolved = targetPath
	}
	parts := strings.Split(filepath.ToSlash(resolved), "/")
	shortFormula := formula
	if idx := strings.LastIndex(formula, "/"); idx >= 0 {
		shortFormula = formula[idx+1:]
	}
	for i := 0; i+1 < len(parts); i++ {
		if parts[i] == "Cellar" && parts[i+1] == shortFormula {
			return true
		}
	}
	return false
}

func isUnderDirectory(targetPath string, dir string) bool {
	if strings.TrimSpace(targetPath) == "" || strings.TrimSpace(dir) == "" {
		return false
	}
	t := strings.ToLower(strings.TrimRight(targetPath, `/\`))
	d := strings.ToLower(strings.TrimRight(dir, `/\`))
	return strings.HasPrefix(t, d+"/") || strings.HasPrefix(t, d+`\`)
}

func packageOwnsExecutable(ctx context.Context, m *pkgMethod, exePath string, o Options) bool {
	if m == nil || strings.TrimSpace(exePath) == "" {
		return false
	}
	if m.Kind == "apt" {
		res := o.Exec.Run(ctx, "dpkg-query", []string{"-S", exePath}, environment.ExecOptions{Timeout: defaultDiscoveryTimeout})
		if !res.OK {
			return false
		}
		for _, pkg := range m.AptPackages {
			for _, line := range strings.Split(res.Stdout, "\n") {
				if strings.HasPrefix(line, pkg+":") {
					return true
				}
			}
		}
	}
	if m.Kind == "winget" {
		local := o.envValue("LOCALAPPDATA")
		if local == "" {
			return false
		}
		wingetRoot := envPlatformPathJoin("win32", local, "Microsoft", "WinGet")
		if !isUnderDirectory(envPlatformNormalize("win32", exePath), wingetRoot) {
			return false
		}
		res := o.Exec.Run(ctx, "winget.exe", []string{"list", "--id", m.WingetID, "--exact", "--disable-interactivity"}, environment.ExecOptions{Timeout: 5 * defaultDiscoveryTimeout / 3})
		return res.OK && strings.Contains(strings.ToLower(res.Stdout), strings.ToLower(m.WingetID))
	}
	return false
}

func describePluginLifecycle(ctx context.Context, plugin toolPlugin, view *ToolView, o Options) {
	platform := o.nodePlatform()
	if plugin.UseFrpcLifecycle {
		releaseSupported := toGoArch(o.Arch) != ""
		own := frpcOwnership{ExecutablePath: view.ExecutablePath}
		if view.Installed {
			own = inspectFrpcOwnership(ctx, view.ExecutablePath, o)
		}
		owned := own.Managed || own.Homebrew || own.External
		canInstall := !view.Installed && releaseSupported
		canUpdate := view.Installed && owned && releaseSupported
		canUninstall := view.Installed && owned
		managedBy := ""
		switch {
		case own.Homebrew:
			managedBy = "homebrew"
		case own.Managed:
			managedBy = "aih"
		case own.External:
			managedBy = "external"
		}
		view.ManagedPath = ResolveManagedFrpcPath(o)
		view.ManagedBy = managedBy
		view.CanInstall = canInstall
		view.CanUpdate = canUpdate
		view.CanUninstall = canUninstall
		view.Lifecycle = LifecycleFlags{Install: canInstall, Update: canUpdate, Uninstall: canUninstall}
		return
	}

	if plugin.UseHerdrLifecycle {
		if brewView, ok := tryDescribeHomebrewLifecycle(ctx, "herdr", view.Installed, view.ExecutablePath, o); ok {
			view.ManagedDir = brewView.ManagedDir
			view.ManagedBy = brewView.ManagedBy
			view.Method = brewView.Method
			view.CanInstall = brewView.CanInstall
			view.CanUpdate = brewView.CanUpdate
			view.CanUninstall = brewView.CanUninstall
			view.Lifecycle = brewView.Lifecycle
			return
		}
		target := ResolveHerdrPath(o)
		supported := (platform == "darwin" || platform == "linux" || platform == "win32") && toGoArch(o.Arch) != "" && target != ""
		owned := sameToolPath(view.ExecutablePath, target, platform)
		managedBy := ""
		if view.Installed {
			if owned {
				managedBy = "aih"
			} else {
				managedBy = "external"
			}
		}
		view.ManagedBy = managedBy
		view.CanInstall = !view.Installed && supported
		view.CanUpdate = view.Installed && owned && supported
		view.CanUninstall = view.Installed && owned
		view.Lifecycle = LifecycleFlags{Install: view.CanInstall, Update: view.CanUpdate, Uninstall: view.CanUninstall}
		return
	}

	if plugin.PackageLifecycle != nil {
		m := methodForPackage(plugin.PackageLifecycle, platform)
		managedDir := ResolveManagedToolDir(plugin.ID, o)
		managedBy := ""
		if view.Installed {
			switch {
			case m != nil && m.Kind == "homebrew" && isHomebrewFormulaPath(view.ExecutablePath, m.Formula):
				managedBy = "homebrew"
			case isUnderDirectory(view.ExecutablePath, managedDir):
				managedBy = "aih"
			case packageOwnsExecutable(ctx, m, view.ExecutablePath, o):
				managedBy = m.Kind
			default:
				managedBy = "external"
			}
		}
		owned := managedBy == "aih" || managedBy == "homebrew" || managedBy == "apt" || managedBy == "winget"
		methodKind := ""
		if m != nil {
			methodKind = m.Kind
		}
		view.ManagedDir = managedDir
		view.ManagedBy = managedBy
		view.Method = methodKind
		view.CanInstall = !view.Installed && m != nil
		view.CanUpdate = view.Installed && m != nil && owned
		view.CanUninstall = view.Installed && m != nil && owned
		view.Lifecycle = LifecycleFlags{Install: view.CanInstall, Update: view.CanUpdate, Uninstall: view.CanUninstall}
	}
}

func tryDescribeHomebrewLifecycle(ctx context.Context, formula string, installed bool, exePath string, o Options) (ToolView, bool) {
	if o.nodePlatform() != "darwin" {
		return ToolView{}, false
	}
	if !isHomebrewFormulaPath(exePath, formula) {
		return ToolView{}, false
	}
	return ToolView{
		ManagedBy:    "homebrew",
		Method:       "homebrew",
		CanInstall:   false,
		CanUpdate:    installed,
		CanUninstall: installed,
		Lifecycle:    LifecycleFlags{Install: false, Update: installed, Uninstall: installed},
	}, true
}

// PlanManagedToolAction 构建受管工具安装/更新/卸载的执行计划。
func PlanManagedToolAction(ctx context.Context, toolID string, action string, opts Options) PlanResponse {
	o := opts.withDefaults()
	normalizedID := strings.ToLower(strings.TrimSpace(toolID))
	noSvc := false
	listOpts := o
	listOpts.IncludeService = &noSvc
	toolsList := ListManagedTools(ctx, listOpts, nil)
	var found *ToolView
	for i := range toolsList.Tools {
		if toolsList.Tools[i].ID == normalizedID {
			copyView := toolsList.Tools[i]
			found = &copyView
			break
		}
	}
	if found == nil {
		return PlanResponse{OK: false, Error: "managed_tool_not_found", Message: "工具不存在或不适用于当前系统。"}
	}
	plugin, _ := getToolPlugin(normalizedID)
	if !plugin.UseFrpcLifecycle && !plugin.UseHerdrLifecycle && plugin.PackageLifecycle == nil {
		return PlanResponse{OK: false, Error: "managed_tool_action_unavailable", Message: found.Name + " 不提供自动安装管理。"}
	}
	verb := normalizeToolAction(action)
	if verb == "" {
		return PlanResponse{OK: false, Error: "unsupported_managed_tool_action", Message: "仅支持安装、更新和卸载。"}
	}
	if !found.Supported {
		return PlanResponse{OK: false, Error: "unsupported_platform", Message: found.Name + " 不支持当前系统。"}
	}

	if plugin.UseFrpcLifecycle {
		return resolveFrpcPlans(ctx, *found, verb, o)
	}
	if plugin.UseHerdrLifecycle {
		return resolveHerdrPlans(*found, verb, o)
	}
	return resolvePackagePlans(plugin, *found, verb, o)
}

func resolveFrpcPlans(ctx context.Context, tool ToolView, action string, o Options) PlanResponse {
	if action != "uninstall" && toGoArch(o.Arch) == "" {
		return PlanResponse{OK: false, Error: "unsupported_architecture", Message: "当前 CPU 架构没有可用的 frpc 官方发布包。"}
	}
	allowed := (action == "install" && tool.CanInstall) ||
		(action == "update" && tool.CanUpdate) ||
		(action == "uninstall" && tool.CanUninstall)
	if !allowed {
		if action == "install" && tool.Installed {
			return PlanResponse{OK: false, Error: "managed_tool_already_installed", Message: tool.Name + " 已安装。"}
		}
		if action != "install" && !tool.Installed {
			return PlanResponse{OK: false, Error: "managed_tool_not_installed", Message: tool.Name + " 尚未安装。"}
		}
		return PlanResponse{OK: false, Error: "managed_tool_lifecycle_contract_violation", Message: "工具状态与生命周期计划不一致，请重新探测后重试。"}
	}

	platform := o.nodePlatform()
	own := inspectFrpcOwnership(ctx, tool.ExecutablePath, o)
	var plans []environment.Plan
	brewPath := ResolveCommandPath(ctx, "brew", o)
	switch {
	case platform == "darwin" && (action == "install" || action == "update"):
		if brewPath != "" {
			plans = append(plans, buildFrpcHomebrewPlan(action, brewPath, o))
		}
		plans = append(plans, buildFrpcOfficialPlan(action, o))
	case platform == "darwin" && action == "uninstall":
		if own.Homebrew && brewPath != "" {
			plans = append(plans, buildFrpcHomebrewPlan(action, brewPath, o))
		}
		if own.Managed {
			plans = append(plans, buildFrpcOfficialPlan(action, o))
		}
		if own.Homebrew || own.External {
			if p, ok := buildFrpcExternalRemovalPlan(own.ExecutablePath, o); ok {
				plans = append(plans, p)
			}
		}
	default:
		if action == "install" || action == "update" || (action == "uninstall" && own.Managed) {
			plans = append(plans, buildFrpcOfficialPlan(action, o))
		} else if action == "uninstall" && own.External {
			if p, ok := buildFrpcExternalRemovalPlan(own.ExecutablePath, o); ok {
				plans = append(plans, p)
			}
		}
	}
	if len(plans) == 0 {
		return PlanResponse{OK: false, Error: "managed_tool_lifecycle_contract_violation", Message: "工具生命周期配置异常，请刷新后重试。"}
	}
	return PlanResponse{
		OK:       true,
		Platform: toClientPlatform(platform),
		Tool:     &PlanToolRef{ID: tool.ID, Name: tool.Name, Category: tool.Category},
		Action:   action,
		Label:    actionLabels[action] + " " + tool.Name,
		Plans:    plans,
		Current:  &tool,
	}
}

func buildFrpcOfficialPlan(action string, o Options) environment.Plan {
	target := ResolveManagedFrpcPath(o)
	verbLabel := actionLabels[action]
	method := "frp 官方发布包 + SHA256"
	effect := verbLabel + " frpc 到用户级可执行目录"
	args := []string{"release", action}
	if target != "" {
		args = append(args, "--target", target)
	}
	if action == "uninstall" {
		method = "AIH 受管文件清理"
		effect = "仅移除 AIH 管理的 frpc 可执行文件"
	}
	plan := environment.CreateLifecyclePlan("frpc", action, "aih-builtin", args, environment.PlanOptions{
		ID:        "frpc_" + action + "_official_release",
		Label:     verbLabel + " frpc",
		Method:    method,
		Effect:    effect,
		TimeoutMS: 10 * 60 * 1000,
	})
	plan.Preview = "aih frpc " + action + " -> " + target
	return plan
}

func buildFrpcExternalRemovalPlan(exePath string, o Options) (environment.Plan, bool) {
	target := NormalizeExternalFrpcPath(exePath, o)
	if target == "" {
		return environment.Plan{}, false
	}
	plan := environment.CreateLifecyclePlan("frpc", "uninstall", "aih-builtin", []string{"release", "uninstall", "--target", target}, environment.PlanOptions{
		ID:        "frpc_uninstall_external_path",
		Label:     "卸载外部 frpc",
		Method:    "精确路径清理",
		Effect:    "移除当前探测到的 frpc 可执行文件：" + target,
		TimeoutMS: 5 * 60 * 1000,
	})
	plan.Preview = "rm -f " + target
	return plan, true
}

func buildFrpcHomebrewPlan(action string, brewPath string, o Options) environment.Plan {
	brewVerb := map[string]string{"install": "install", "update": "upgrade", "uninstall": "uninstall"}[action]
	plan := environment.CreateLifecyclePlan("frpc", action, firstNonEmpty(brewPath, "brew"), []string{brewVerb, "frpc"}, environment.PlanOptions{
		ID:        "frpc_" + action + "_homebrew",
		Label:     "Homebrew " + actionLabels[action] + " frpc",
		Method:    "Homebrew",
		Effect:    actionLabels[action] + " Homebrew 管理的 frpc",
		TimeoutMS: 10 * 60 * 1000,
	})
	plan.Preview = planPreview(plan, o.nodePlatform())
	return plan
}

func resolveHerdrPlans(tool ToolView, action string, o Options) PlanResponse {
	if tool.ManagedBy == "homebrew" {
		return resolvePackagePlans(toolPlugin{
			ID: "herdr", Category: tool.Category, Name: tool.Name,
			PackageLifecycle: &packageLifecycleDescriptor{Homebrew: "herdr"},
		}, tool, action, o)
	}
	allowed := (action == "install" && tool.CanInstall) ||
		(action == "update" && tool.CanUpdate) ||
		(action == "uninstall" && tool.CanUninstall)
	if !allowed {
		return PlanResponse{OK: false, Error: "managed_tool_action_unavailable", Message: "当前安装来源不支持此操作，请使用原安装方式管理。"}
	}
	target := ResolveHerdrPath(o)
	platform := o.nodePlatform()
	var plan environment.Plan
	if action == "uninstall" {
		args := []string{"cleanup", "--file", target}
		if platform == "win32" {
			args = append(args, "--tree", envPlatformDir(platform, target))
		}
		plan = environment.CreateLifecyclePlan("herdr", "uninstall", "aih-builtin", args, environment.PlanOptions{
			ID:        "herdr_uninstall_managed_cleanup",
			Label:     "移除 herdr 程序文件",
			Method:    "AIH 清理器",
			Effect:    "移除 Herdr 程序与 Windows 运行时 sidecar，保留配置与会话数据",
			TimeoutMS: 5 * 60 * 1000,
		})
		plan.Preview = "cleanup " + target
	} else {
		plan = environment.CreateLifecyclePlan("herdr", action, "aih-builtin", []string{"release", action, "--target", target}, environment.PlanOptions{
			ID:        "herdr_" + action + "_official_release",
			Label:     actionLabels[action] + " Herdr",
			Method:    "official-release",
			Effect:    "下载 Herdr 官方稳定版并核验 SHA256，原子替换程序文件",
			TimeoutMS: 10 * 60 * 1000,
		})
		plan.Preview = "aih herdr " + action + " -> " + target
	}
	return PlanResponse{
		OK:       true,
		Platform: toClientPlatform(platform),
		Tool:     &PlanToolRef{ID: tool.ID, Name: tool.Name, Category: tool.Category},
		Action:   action,
		Label:    actionLabels[action] + " " + tool.Name,
		Plans:    []environment.Plan{plan},
		Current:  &tool,
	}
}

func resolvePackagePlans(plugin toolPlugin, tool ToolView, action string, o Options) PlanResponse {
	platform := o.nodePlatform()
	m := methodForPackage(plugin.PackageLifecycle, platform)
	allowed := (action == "install" && tool.CanInstall) ||
		(action == "update" && tool.CanUpdate) ||
		(action == "uninstall" && tool.CanUninstall)
	if !allowed {
		if action == "install" && tool.Installed {
			return PlanResponse{OK: false, Error: "managed_tool_already_installed", Message: tool.Name + " 已安装。"}
		}
		if action != "install" && !tool.Installed {
			return PlanResponse{OK: false, Error: "managed_tool_not_installed", Message: tool.Name + " 尚未安装。"}
		}
		if m == nil {
			platName := map[string]string{"darwin": "macOS", "win32": "Windows"}[platform]
			if platName == "" {
				platName = "Linux"
			}
			return PlanResponse{
				OK:      false,
				Error:   "managed_tool_lifecycle_unavailable",
				Message: platName + " 上没有可自动执行的" + actionLabels[action] + "方式，请手动安装后再回来管理配置与服务。",
			}
		}
		return PlanResponse{
			OK:      false,
			Error:   "managed_tool_lifecycle_contract_violation",
			Message: tool.Name + " 不是 AIH 或包管理器安装的，AIH 不动它；需要时请用原安装方式处理。",
		}
	}

	var plans []environment.Plan
	switch m.Kind {
	case "homebrew":
		brewPath := firstNonEmpty(ResolveCommandPath(context.Background(), "brew", o), "brew")
		verb := map[string]string{"install": "install", "update": "upgrade", "uninstall": "uninstall"}[action]
		effect := actionLabels[action] + " Homebrew formula " + m.Formula
		if action == "uninstall" {
			effect = "卸载 Homebrew 管理的 " + m.Formula
		}
		p := environment.CreateLifecyclePlan(tool.ID, action, brewPath, []string{verb, m.Formula}, environment.PlanOptions{
			ID:        tool.ID + "_" + action + "_homebrew",
			Label:     actionLabels[action] + " " + tool.Name + "（Homebrew）",
			Method:    "homebrew",
			Effect:    effect,
			TimeoutMS: 10 * 60 * 1000,
		})
		p.Preview = planPreview(p, platform)
		plans = append(plans, p)
	case "apt":
		asRoot := os.Geteuid() == 0
		var args []string
		if action == "uninstall" {
			args = append([]string{"remove", "-y"}, m.AptPackages...)
		} else if action == "update" {
			args = append([]string{"install", "--only-upgrade", "-y"}, m.AptPackages...)
		} else {
			args = append([]string{"install", "-y"}, m.AptPackages...)
		}
		cmd := "apt-get"
		cmdArgs := args
		labelTag := "apt"
		if !asRoot {
			cmd = "sudo"
			cmdArgs = append([]string{"-n", "apt-get"}, args...)
			labelTag = "sudo -n apt"
		}
		suffix := ""
		if !asRoot {
			suffix = "（需要免密 sudo，否则会失败并回显原因）"
		}
		effect := actionLabels[action] + "系统包 " + strings.Join(m.AptPackages, "、") + suffix
		if action == "uninstall" {
			effect = "卸载系统包 " + strings.Join(m.AptPackages, "、")
		}
		p := environment.CreateLifecyclePlan(tool.ID, action, cmd, cmdArgs, environment.PlanOptions{
			ID:        tool.ID + "_" + action + "_apt",
			Label:     actionLabels[action] + " " + tool.Name + "（" + labelTag + "）",
			Method:    "apt",
			Effect:    effect,
			TimeoutMS: 10 * 60 * 1000,
		})
		p.Preview = planPreview(p, platform)
		plans = append(plans, p)
	case "winget":
		verb := map[string]string{"install": "install", "update": "upgrade", "uninstall": "uninstall"}[action]
		p := environment.CreateLifecyclePlan(tool.ID, action, "winget.exe", []string{verb, "--id", m.WingetID, "--exact", "--disable-interactivity"}, environment.PlanOptions{
			ID:        tool.ID + "_" + action + "_winget",
			Label:     actionLabels[action] + " " + tool.Name + "（WinGet）",
			Method:    "winget",
			Effect:    actionLabels[action] + " WinGet 管理的 " + m.WingetID,
			TimeoutMS: 10 * 60 * 1000,
		})
		p.Preview = planPreview(p, platform)
		plans = append(plans, p)
	case "archive":
		dir := ResolveManagedToolDir(tool.ID, o)
		psQuote := func(v string) string { return environment.PowershellQuote(v) }
		if action == "uninstall" {
			p := environment.CreateLifecyclePlan(tool.ID, action, "powershell", []string{"-NoProfile", "-Command", "Remove-Item -Recurse -Force " + psQuote(dir) + " -ErrorAction SilentlyContinue"}, environment.PlanOptions{
				ID:        tool.ID + "_uninstall_archive",
				Label:     "卸载 " + tool.Name + "（删除 AIH 自管目录）",
				Method:    "archive",
				Effect:    "删除 " + dir + "（只删 AIH 自己装的那份）",
				TimeoutMS: 10 * 60 * 1000,
			})
			p.Preview = planPreview(p, platform)
			plans = append(plans, p)
		} else {
			zipPath := filepath.Join(os.TempDir(), tool.ID+"-aih-install.zip")
			script := strings.Join([]string{
				"$ErrorActionPreference='Stop'",
				"$dir=" + psQuote(dir),
				"New-Item -ItemType Directory -Force -Path $dir | Out-Null",
				"$zip=" + psQuote(zipPath),
				"$curl = Get-Command curl.exe -ErrorAction SilentlyContinue; if ($curl) { & $curl.Source -fL --retry 3 --retry-delay 2 --connect-timeout 30 --speed-limit 1024 --speed-time 60 -o $zip " + psQuote(m.ArchiveURL) + "; if ($LASTEXITCODE -ne 0) { throw ('" + tool.Name + " 安装包下载失败: curl 退出码 ' + $LASTEXITCODE) } } else { Invoke-WebRequest -Uri " + psQuote(m.ArchiveURL) + " -OutFile $zip -UseBasicParsing }",
				"Expand-Archive -Force $zip $dir",
				"Remove-Item $zip -Force",
			}, "; ")
			p := environment.CreateLifecyclePlan(tool.ID, action, "powershell", []string{"-NoProfile", "-Command", script}, environment.PlanOptions{
				ID:        tool.ID + "_" + action + "_archive",
				Label:     actionLabels[action] + " " + tool.Name + "（官方压缩包）",
				Method:    "archive",
				Effect:    "下载官方包并解压到 " + dir,
				TimeoutMS: 10 * 60 * 1000,
			})
			p.Preview = planPreview(p, platform)
			plans = append(plans, p)
		}
	}

	if len(plans) == 0 {
		return PlanResponse{OK: false, Error: "managed_tool_lifecycle_contract_violation", Message: "工具生命周期配置异常，请刷新后重试。"}
	}
	return PlanResponse{
		OK:       true,
		Platform: platform,
		Tool:     &PlanToolRef{ID: tool.ID, Name: tool.Name, Category: tool.Category},
		Action:   action,
		Label:    actionLabels[action] + " " + tool.Name,
		Plans:    plans,
		Current:  &tool,
	}
}

func planPreview(p environment.Plan, platform string) string {
	parts := append([]string{p.Command}, p.Args...)
	quoted := make([]string, len(parts))
	for i, part := range parts {
		if platform == "win32" {
			quoted[i] = `"` + strings.ReplaceAll(part, `"`, `\"`) + `"`
		} else {
			quoted[i] = environment.ShellQuote(part)
		}
	}
	return strings.Join(quoted, " ")
}

// RunToolPlan 执行单条受管工具生命周期计划（包管理器走 HostExecutor，官方包走 Go 内置安装器）。
func RunToolPlan(ctx context.Context, plan environment.Plan, opts Options) environment.RunResult {
	o := opts.withDefaults()
	if strings.HasPrefix(plan.ID, "frpc_") && (strings.HasSuffix(plan.ID, "_official_release") || plan.ID == "frpc_uninstall_external_path") {
		target := flagArgValue(plan.Args, "--target")
		if plan.Action == "uninstall" {
			if target == "" {
				target = ResolveManagedFrpcPath(o)
			}
			if target == "" {
				return environment.RunResult{Message: "frpc_managed_target_unavailable"}
			}
			err := RemoveManagedPaths([]string{target}, nil)
			return builtinOutcome(err)
		}
		err := InstallFrpcRelease(ctx, target, o)
		return builtinOutcome(err)
	}
	if strings.HasPrefix(plan.ID, "herdr_") && (strings.HasSuffix(plan.ID, "_official_release") || plan.ID == "herdr_uninstall_managed_cleanup") {
		if plan.Action == "uninstall" {
			var files, trees []string
			for i := 0; i+1 < len(plan.Args); i++ {
				if plan.Args[i] == "--file" {
					files = append(files, plan.Args[i+1])
				} else if plan.Args[i] == "--tree" {
					trees = append(trees, plan.Args[i+1])
				}
			}
			return builtinOutcome(RemoveManagedPaths(files, trees))
		}
		target := flagArgValue(plan.Args, "--target")
		return builtinOutcome(InstallHerdrRelease(ctx, target, o))
	}

	execOpts := environment.ExecOptions{
		Env:     plan.Env,
		Timeout: environment.DefaultProbeTimeout,
	}
	if plan.TimeoutMS > 0 {
		execOpts.Timeout = time.Duration(plan.TimeoutMS) * time.Millisecond
	}
	if plan.Cwd != nil {
		execOpts.Dir = *plan.Cwd
	}
	return o.Exec.Run(ctx, plan.Command, plan.Args, execOpts)
}

func flagArgValue(args []string, flag string) string {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag {
			return args[i+1]
		}
	}
	return ""
}

func builtinOutcome(err error) environment.RunResult {
	if err == nil {
		return environment.RunResult{OK: true}
	}
	var re *releaseError
	if errors.As(err, &re) {
		msg, _ := json.Marshal(map[string]string{"error": re.Code, "message": re.Message})
		return environment.RunResult{OK: false, Message: firstNonEmpty(re.Message, re.Code), Stderr: string(msg)}
	}
	return environment.RunResult{OK: false, Message: err.Error(), Stderr: err.Error()}
}

