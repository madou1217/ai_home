package environment

import "strings"

const (
	rustupInstallerURL   = "https://sh.rustup.rs"
	binstallPosixURL     = "https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh"
	binstallWindowsURL   = "https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.ps1"
	rawGitHubContentHost = "raw.githubusercontent.com"
)

var rustupUpdateMeta = PlanOptions{
	ID:     "rustup_update_toolchains",
	Label:  "更新 rustup 与工具链",
	Method: "rustup",
	Effect: "更新 rustup 自身及已安装的 Rust 工具链",
}

var rustupUninstallMeta = PlanOptions{
	ID:     "rustup_self_uninstall",
	Label:  "卸载 rustup",
	Method: "内置卸载器",
	Effect: "移除 ~/.rustup 与 ~/.cargo（含 cargo install 安装的程序）并撤销 PATH 配置",
}

func rustupPosixScriptPlan(action string, commandLine string, meta PlanOptions, options BuildOptions) Plan {
	home := options.HomeDir
	lines := []string{"set -euo pipefail"}
	lines = append(lines, resolveBinarySnippet("rustup_bin", JoinPath(options.Platform, home, ".cargo", "bin", "rustup"), "rustup")...)
	lines = append(lines, "\"$rustup_bin\" "+commandLine)
	return CreateLifecyclePlan("rustup", action, "bash", []string{"-c", strings.Join(lines, "\n")}, meta)
}

func resolveRustupPlans(action string, options BuildOptions) []Plan {
	if normalizePlatform(options.Platform) == PlatformWindows {
		rustupExe := JoinPath(PlatformWindows, options.HomeDir, ".cargo", "bin", "rustup.exe")
		switch action {
		case "install":
			return []Plan{BuildWingetPlan("rustup", action, "Rustlang.Rustup", "rustup")}
		case "update":
			return []Plan{
				BuildCommandPlan("rustup", "update", rustupExe, []string{"update"}, rustupUpdateMeta),
				BuildWingetPlan("rustup", action, "Rustlang.Rustup", "rustup"),
			}
		default:
			return []Plan{
				BuildCommandPlan("rustup", "uninstall", rustupExe, []string{"self", "uninstall", "-y"}, rustupUninstallMeta),
				BuildWingetPlan("rustup", action, "Rustlang.Rustup", "rustup"),
			}
		}
	}
	switch action {
	case "install":
		effect := "安装 rustup 与 stable 工具链到 ~/.cargo"
		if normalizePlatform(options.Platform) == PlatformMacOS {
			effect = "安装 rustup 与 stable 工具链到 ~/.cargo；若已有 Homebrew rust，两套工具链并存，由 PATH 顺序决定生效版本"
		}
		plan, err := BuildShellScriptPlan("rustup", action, rustupInstallerURL, []string{"sh.rustup.rs"},
			"安装 rustup", "rustup 官方安装器", []string{"-y"}, PlanOptions{Effect: effect})
		if err != nil {
			return nil
		}
		return []Plan{plan}
	case "update":
		return []Plan{rustupPosixScriptPlan("update", "update", rustupUpdateMeta, options)}
	default:
		return []Plan{rustupPosixScriptPlan("uninstall", "self uninstall -y", rustupUninstallMeta, options)}
	}
}

func binstallScriptPlan(action string, options BuildOptions) (Plan, error) {
	verb := "安装"
	if action == "update" {
		verb = "更新"
	}
	label := verb + " cargo-binstall"
	if normalizePlatform(options.Platform) == PlatformWindows {
		return BuildPowerShellScriptPlan("cargo-binstall", action, binstallWindowsURL, []string{rawGitHubContentHost},
			label, "官方安装器", options, PlanOptions{})
	}
	return BuildShellScriptPlan("cargo-binstall", action, binstallPosixURL, []string{rawGitHubContentHost},
		label, "官方安装器", nil, PlanOptions{})
}

func resolveBinstallPlans(action string, options BuildOptions) []Plan {
	plans := []Plan{}
	if normalizePlatform(options.Platform) == PlatformMacOS {
		plans = append(plans, BuildBrewPlan("cargo-binstall", action, "cargo-binstall", "cargo-binstall", false))
	}
	if action == "uninstall" {
		cargoBinary := "cargo"
		if normalizePlatform(options.Platform) == PlatformWindows {
			cargoBinary = "cargo.exe"
		}
		plans = append(plans, BuildCommandPlan("cargo-binstall", "uninstall", cargoBinary, []string{"uninstall", "cargo-binstall"}, PlanOptions{
			ID:     "cargo-binstall_uninstall_cargo",
			Label:  "cargo 卸载 cargo-binstall",
			Method: "cargo",
			Effect: "通过 cargo 安装记录移除 cargo-binstall",
		}))
		if cleanup, ok := BuildHomeCleanupPlan("cargo-binstall", "cargo-binstall", options,
			[]string{".cargo/bin/cargo-binstall" + windowsExeSuffix(options)}, nil); ok {
			plans = append(plans, cleanup)
		}
		return plans
	}
	plan, err := binstallScriptPlan(action, options)
	if err == nil {
		plans = append(plans, plan)
	}
	return plans
}

func windowsExeSuffix(options BuildOptions) string {
	if normalizePlatform(options.Platform) == PlatformWindows {
		return ".exe"
	}
	return ""
}

// ResolveRustPlans 复刻 Node plugins/rust.js 的 resolvePlans。
func ResolveRustPlans(toolID string, action string, options BuildOptions) []Plan {
	switch toolID {
	case "rustup":
		return resolveRustupPlans(action, options)
	case "cargo-binstall":
		return resolveBinstallPlans(action, options)
	}
	return nil
}
