package environment

import (
	"strings"
)

// macOS 官方安装器地址（与 Node platforms/macos.js 的 INSTALLERS 一致）。
var macInstallers = map[string]struct {
	URL   string
	Hosts []string
}{
	"nvm":   {"https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh", []string{"raw.githubusercontent.com"}},
	"fnm":   {"https://fnm.vercel.app/install", []string{"fnm.vercel.app"}},
	"volta": {"https://get.volta.sh", []string{"get.volta.sh"}},
	"bun":   {"https://bun.sh/install", []string{"bun.sh"}},
	"pyenv": {"https://pyenv.run", []string{"pyenv.run"}},
	"uv":    {"https://astral.sh/uv/install.sh", []string{"astral.sh"}},
}

func macOfficialScript(toolID string, action string, name string, options BuildOptions) (Plan, error) {
	installer := macInstallers[toolID]
	verb := "安装"
	if action == "update" {
		verb = "更新"
	}
	return BuildShellScriptPlan(toolID, action, installer.URL, installer.Hosts,
		verb+" "+name, "官方安装器", nil, PlanOptions{})
}

func buildMinicondaInstallPlan(action string, options BuildOptions) Plan {
	home := options.HomeDir
	verb := "安装"
	if action == "update" {
		verb = "更新"
	}
	script := strings.Join([]string{
		"set -euo pipefail",
		"arch=\"$(uname -m)\"",
		"case \"$arch\" in arm64) asset=\"Miniconda3-latest-MacOSX-arm64.sh\" ;; x86_64) asset=\"Miniconda3-latest-MacOSX-x86_64.sh\" ;; *) echo \"不支持的 macOS 架构: $arch\" >&2; exit 64 ;; esac",
		"url=\"https://repo.anaconda.com/miniconda/$asset\"",
		"tmp=\"$(mktemp -t aih-miniconda.XXXXXX)\"",
		"trap 'rm -f \"$tmp\"' EXIT",
		"curl --compressed -fsSL \"$url\" -o \"$tmp\"",
		"bash \"$tmp\" -b -u -p " + ShellQuote(JoinPath(options.Platform, home, "miniconda3")),
	}, "\n")
	effect := "安装 Miniconda 到用户目录"
	if action == "update" {
		effect = "覆盖更新 Miniconda 到用户目录"
	}
	return CreateLifecyclePlan("conda", action, "bash", []string{"-c", script}, PlanOptions{
		ID:     "conda_" + action + "_official_installer",
		Label:  verb + " Miniconda",
		Method: "Miniconda 官方安装器",
		Effect: effect,
	})
}

func buildMacCondaUpdatePlan(options BuildOptions) Plan {
	home := options.HomeDir
	script := strings.Join([]string{
		"set -e",
		"conda_bin=" + ShellQuote(JoinPath(options.Platform, home, "miniconda3", "bin", "conda")),
		"if [ ! -x \"$conda_bin\" ]; then conda_bin=\"$(command -v conda)\"; fi",
		"\"$conda_bin\" update --name base --yes conda",
	}, "\n")
	return CreateLifecyclePlan("conda", "update", "bash", []string{"-c", script}, PlanOptions{
		ID:     "conda_update_base",
		Label:  "更新 Miniconda",
		Method: "conda",
		Effect: "更新 base 环境中的 conda",
	})
}

// ResolveMacosPlans 复刻 Node resolveMacosEnvironmentPlans 的回退链。
func ResolveMacosPlans(toolID string, action string, options BuildOptions) []Plan {
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
	case "nvm":
		if action == "uninstall" {
			appendPlan(BuildProfileAwareCleanupPlan("nvm", "NVM", []string{"NVM_DIR", "nvm\\.sh", "bash_completion"}, nil, []string{".nvm"}, options))
			return plans
		}
		plan, err := macOfficialScript("nvm", action, "NVM", options)
		if err == nil {
			plans = append(plans, plan)
		}
	case "fnm":
		if action == "uninstall" {
			plans = append(plans, BuildBrewPlan("fnm", action, "fnm", "FNM", false))
			appendPlan(BuildProfileAwareCleanupPlan("fnm", "FNM", []string{"fnm env", "FNM_DIR"}, []string{".local/bin/fnm"}, []string{".local/share/fnm", ".fnm"}, options))
			return plans
		}
		plans = append(plans, BuildBrewPlan("fnm", action, "fnm", "FNM", false))
		if plan, err := macOfficialScript("fnm", action, "FNM", options); err == nil {
			plans = append(plans, plan)
		}
	case "volta":
		if action == "uninstall" {
			plans = append(plans, BuildBrewPlan("volta", action, "volta", "Volta", false))
			appendPlan(BuildProfileAwareCleanupPlan("volta", "Volta", []string{"VOLTA_HOME", "\\.volta/bin"}, nil, []string{".volta"}, options))
			return plans
		}
		plans = append(plans, BuildBrewPlan("volta", action, "volta", "Volta", false))
		if plan, err := macOfficialScript("volta", action, "Volta", options); err == nil {
			plans = append(plans, plan)
		}
	case "pnpm", "yarn":
		plans = append(plans,
			BuildBrewPlan(toolID, action, toolID, name, false),
			BuildNpmGlobalPlan(toolID, action, toolID, PlatformMacOS, name),
		)
	case "bun":
		if action == "update" {
			plans = append(plans,
				BuildSelfUpdatePlan("bun", "Bun", "bun", []string{"upgrade"}),
				BuildBrewPlan("bun", action, "oven-sh/bun/bun", "Bun", false),
			)
			if plan, err := macOfficialScript("bun", action, "Bun", options); err == nil {
				plans = append(plans, plan)
			}
			return plans
		}
		if action == "uninstall" {
			plans = append(plans, BuildBrewPlan("bun", action, "oven-sh/bun/bun", "Bun", false))
			appendPlan(BuildProfileAwareCleanupPlan("bun", "Bun", []string{"BUN_INSTALL", "\\.bun/bin"}, nil, []string{".bun"}, options))
			return plans
		}
		plans = append(plans, BuildBrewPlan("bun", action, "oven-sh/bun/bun", "Bun", false))
		if plan, err := macOfficialScript("bun", action, "Bun", options); err == nil {
			plans = append(plans, plan)
		}
	case "pyenv":
		if action == "uninstall" {
			plans = append(plans, BuildBrewPlan("pyenv", action, "pyenv", "Pyenv", false))
			appendPlan(BuildProfileAwareCleanupPlan("pyenv", "Pyenv", []string{"PYENV_ROOT", "pyenv init"}, nil, []string{".pyenv"}, options))
			return plans
		}
		plans = append(plans, BuildBrewPlan("pyenv", action, "pyenv", "Pyenv", false))
		if plan, err := macOfficialScript("pyenv", action, "Pyenv", options); err == nil {
			plans = append(plans, plan)
		}
	case "conda":
		if action == "update" {
			plans = append(plans,
				buildMacCondaUpdatePlan(options),
				BuildBrewPlan("conda", action, "miniconda", "Miniconda", true),
				buildMinicondaInstallPlan(action, options),
			)
			return plans
		}
		if action == "uninstall" {
			plans = append(plans,
				BuildBrewPlan("conda", action, "miniconda", "Miniconda", true),
				BuildCondaCleanupPlan(options),
			)
			return plans
		}
		plans = append(plans, BuildBrewPlan("conda", action, "miniconda", "Miniconda", true), buildMinicondaInstallPlan(action, options))
	case "uv":
		if action == "update" {
			plans = append(plans,
				BuildSelfUpdatePlan("uv", "uv", "uv", []string{"self", "update"}),
				BuildBrewPlan("uv", action, "uv", "uv", false),
			)
			if plan, err := macOfficialScript("uv", action, "uv", options); err == nil {
				plans = append(plans, plan)
			}
			return plans
		}
		if action == "uninstall" {
			plans = append(plans,
				BuildBrewPlan("uv", action, "uv", "uv", false),
				BuildCommandPlan("uv", "uninstall", "uv", []string{"self", "uninstall"}, PlanOptions{
					ID: "uv_self_uninstall", Label: "uv 自卸载", Method: "内置卸载器", Effect: "卸载 uv",
				}),
			)
			appendPlan(BuildHomeCleanupPlan("uv", "uv", options, []string{".local/bin/uv", ".local/bin/uvx"}, []string{".local/share/uv"}))
			return plans
		}
		plans = append(plans, BuildBrewPlan("uv", action, "uv", "uv", false))
		if plan, err := macOfficialScript("uv", action, "uv", options); err == nil {
			plans = append(plans, plan)
		}
	case "poetry":
		if action == "update" {
			plans = append(plans,
				BuildSelfUpdatePlan("poetry", "Poetry", "poetry", []string{"self", "update"}),
				BuildBrewPlan("poetry", action, "poetry", "Poetry", false),
				BuildPoetryInstallerPlan("install", options),
			)
			return plans
		}
		if action == "uninstall" {
			plans = append(plans,
				BuildBrewPlan("poetry", action, "poetry", "Poetry", false),
				BuildPoetryInstallerPlan("uninstall", options),
			)
			return plans
		}
		plans = append(plans, BuildBrewPlan("poetry", action, "poetry", "Poetry", false), BuildPoetryInstallerPlan("install", options))
	}
	return plans
}
