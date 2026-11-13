package environment

import "strings"

// Windows 官方安装器（与 Node platforms/windows.js 的 INSTALLERS 一致）。
var windowsInstallers = map[string]struct {
	URL   string
	Hosts []string
}{
	"bun": {"https://bun.sh/install.ps1", []string{"bun.sh"}},
	"uv":  {"https://astral.sh/uv/install.ps1", []string{"astral.sh"}},
}

func windowsOfficialScript(toolID string, action string, name string, options BuildOptions) (Plan, error) {
	installer := windowsInstallers[toolID]
	verb := "安装"
	if action == "update" {
		verb = "更新"
	}
	return BuildPowerShellScriptPlan(toolID, action, installer.URL, installer.Hosts,
		verb+" "+name, "官方安装器", options, PlanOptions{})
}

func buildWindowsCondaUpdatePlan(options BuildOptions) Plan {
	home := options.HomeDir
	path := JoinPath(PlatformWindows, home, "miniconda3", "Scripts", "conda.exe")
	powershell := powershellCommand(options)
	script := strings.Join([]string{
		"$ErrorActionPreference = 'Stop'",
		"$conda = " + PowershellQuote(path),
		"if (-not (Test-Path $conda)) { $conda = (Get-Command conda.exe -ErrorAction Stop).Source }",
		"& $conda update --name base --yes conda",
		"if ($LASTEXITCODE -ne 0) { throw ('conda update exit ' + $LASTEXITCODE) }",
	}, "; ")
	return CreateLifecyclePlan("conda", "update", powershell, []string{
		"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
	}, PlanOptions{
		ID:     "conda_update_base",
		Label:  "更新 Miniconda",
		Method: "conda",
		Effect: "更新 base 环境中的 conda",
	})
}

func buildWindowsCondaCleanupPlan(options BuildOptions) Plan {
	home := options.HomeDir
	condaPath := JoinPath(PlatformWindows, home, "miniconda3", "Scripts", "conda.exe")
	roots := []string{
		JoinPath(PlatformWindows, home, "miniconda3"),
		JoinPath(PlatformWindows, home, "anaconda3"),
		JoinPath(PlatformWindows, home, ".conda"),
	}
	powershell := powershellCommand(options)
	statements := []string{
		"$ErrorActionPreference = 'Stop'",
		"$conda = " + PowershellQuote(condaPath),
		"if (Test-Path $conda) { & $conda init --reverse --all | Out-Null }",
	}
	for _, target := range roots {
		statements = append(statements, "Remove-Item -LiteralPath "+PowershellQuote(target)+" -Recurse -Force -ErrorAction SilentlyContinue")
	}
	return CreateLifecyclePlan("conda", "uninstall", powershell, []string{
		"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", strings.Join(statements, "; "),
	}, PlanOptions{
		ID:     "conda_uninstall_managed_cleanup",
		Label:  "卸载 Miniconda",
		Method: "AIH 清理器",
		Effect: "撤销 Conda Shell 初始化并移除用户目录下的 Miniconda/Conda 程序目录",
	})
}

// ResolveWindowsPlans 复刻 Node resolveWindowsEnvironmentPlans 的回退链。
func ResolveWindowsPlans(toolID string, action string, options BuildOptions) []Plan {
	name := options.Name
	if name == "" {
		name = toolID
	}
	plans := []Plan{}
	appendPlan := func(plan Plan, ok bool) {
		if ok {
			plans = append(plans, plan)
		}
	}
	switch toolID {
	case "fnm":
		if action == "uninstall" {
			plans = append(plans, BuildWingetPlan("fnm", action, "Schniz.fnm", "FNM"))
			appendPlan(BuildWindowsCleanupPlan("fnm", "FNM", options, []string{".local/bin/fnm.exe"}, []string{".local/share/fnm", ".fnm"}))
			return plans
		}
		plans = append(plans, BuildWingetPlan("fnm", action, "Schniz.fnm", "FNM"))
	case "volta":
		if action == "uninstall" {
			plans = append(plans, BuildWingetPlan("volta", action, "Volta.Volta", "Volta"))
			appendPlan(BuildWindowsCleanupPlan("volta", "Volta", options, nil, []string{".volta"}))
			return plans
		}
		plans = append(plans, BuildWingetPlan("volta", action, "Volta.Volta", "Volta"))
	case "pnpm", "yarn":
		plans = append(plans, BuildNpmGlobalPlan(toolID, action, toolID, PlatformWindows, name))
	case "bun":
		if action == "update" {
			plans = append(plans,
				BuildSelfUpdatePlan("bun", "Bun", "bun.exe", []string{"upgrade"}),
				BuildWingetPlan("bun", action, "Oven-sh.Bun", "Bun"),
			)
			if plan, err := windowsOfficialScript("bun", action, "Bun", options); err == nil {
				plans = append(plans, plan)
			}
			return plans
		}
		if action == "uninstall" {
			plans = append(plans, BuildWingetPlan("bun", action, "Oven-sh.Bun", "Bun"))
			appendPlan(BuildWindowsCleanupPlan("bun", "Bun", options, nil, []string{".bun"}))
			return plans
		}
		plans = append(plans, BuildWingetPlan("bun", action, "Oven-sh.Bun", "Bun"))
		if plan, err := windowsOfficialScript("bun", action, "Bun", options); err == nil {
			plans = append(plans, plan)
		}
	case "conda":
		if action == "update" {
			return append(plans, buildWindowsCondaUpdatePlan(options), BuildWingetPlan("conda", action, "Anaconda.Miniconda3", "Miniconda"))
		}
		if action == "uninstall" {
			return append(plans, BuildWingetPlan("conda", action, "Anaconda.Miniconda3", "Miniconda"), buildWindowsCondaCleanupPlan(options))
		}
		plans = append(plans, BuildWingetPlan("conda", action, "Anaconda.Miniconda3", "Miniconda"))
	case "uv":
		if action == "update" {
			plans = append(plans,
				BuildSelfUpdatePlan("uv", "uv", "uv.exe", []string{"self", "update"}),
				BuildWingetPlan("uv", action, "astral-sh.uv", "uv"),
			)
			if plan, err := windowsOfficialScript("uv", action, "uv", options); err == nil {
				plans = append(plans, plan)
			}
			return plans
		}
		if action == "uninstall" {
			plans = append(plans,
				BuildWingetPlan("uv", action, "astral-sh.uv", "uv"),
				BuildCommandPlan("uv", "uninstall", "uv.exe", []string{"self", "uninstall"}, PlanOptions{
					ID: "uv_self_uninstall", Label: "uv 自卸载", Method: "内置卸载器", Effect: "卸载 uv",
				}),
			)
			appendPlan(BuildWindowsCleanupPlan("uv", "uv", options, []string{".local/bin/uv.exe", ".local/bin/uvx.exe"}, []string{".local/share/uv"}))
			return plans
		}
		plans = append(plans, BuildWingetPlan("uv", action, "astral-sh.uv", "uv"))
		if plan, err := windowsOfficialScript("uv", action, "uv", options); err == nil {
			plans = append(plans, plan)
		}
	case "poetry":
		if action == "update" {
			return append(plans,
				BuildSelfUpdatePlan("poetry", "Poetry", "poetry.exe", []string{"self", "update"}),
				BuildPoetryInstallerPlan("install", options),
			)
		}
		if action == "uninstall" {
			return append(plans, BuildPoetryInstallerPlan("uninstall", options))
		}
		plans = append(plans, BuildPoetryInstallerPlan("install", options))
	}
	return plans
}
