package environment

import "strings"

const (
	goProfileMarker = "# aih-go"
	goenvRepository = "https://github.com/go-nv/goenv.git"
)

func buildGoTarballPlan(action string, options BuildOptions) Plan {
	home := options.HomeDir
	goOS := "linux"
	if normalizePlatform(options.Platform) == PlatformMacOS {
		goOS = "darwin"
	}
	tempTemplate := "$" + "{TMPDIR:-/tmp}/aih-go.XXXXXX"
	lines := []string{
		"set -euo pipefail",
		"arch=\"$(uname -m)\"",
		"case \"$arch\" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) echo \"不支持的 CPU 架构: $arch\" >&2; exit 64 ;; esac",
		"raw=\"$(curl -fsSL 'https://go.dev/VERSION?m=text')\"",
		"version=\"$(printf '%s\\n' \"$raw\" | sed -n 1p)\"",
		"case \"$version\" in go[0-9]*) ;; *) echo \"无法解析 Go 最新版本\" >&2; exit 65 ;; esac",
		"file=\"$version." + goOS + "-$arch.tar.gz\"",
		"tmp=\"$(mktemp -d \"" + tempTemplate + "\")\"",
		"trap 'rm -rf \"$tmp\"' EXIT",
		"curl -fsSL \"https://dl.google.com/go/$file\" -o \"$tmp/$file\"",
		"expected=\"$(curl -fsSL \"https://dl.google.com/go/$file.sha256\" | tr -d '[:space:]')\"",
		"if command -v sha256sum >/dev/null 2>&1; then actual=\"$(sha256sum \"$tmp/$file\" | cut -d' ' -f1)\"; else actual=\"$(shasum -a 256 \"$tmp/$file\" | cut -d' ' -f1)\"; fi",
		"[ -n \"$expected\" ] && [ \"$expected\" = \"$actual\" ] || { echo \"Go 安装包 SHA-256 校验失败\" >&2; exit 66; }",
		"mkdir -p " + ShellQuote(JoinPath(options.Platform, home, ".local")),
		"rm -rf " + ShellQuote(JoinPath(options.Platform, home, ".local", "go")),
		"tar -C " + ShellQuote(JoinPath(options.Platform, home, ".local")) + " -xzf \"$tmp/$file\"",
	}
	lines = append(lines, appendProfileLinesSnippet(home, goProfileMarker, []string{
		"export PATH=\"$HOME/.local/go/bin:$HOME/go/bin:$PATH\" " + goProfileMarker,
	})...)
	verb := "安装"
	if action == "update" {
		verb = "更新"
	}
	effect := "安装 Go 到 ~/.local/go，并在 Shell 配置追加 PATH"
	if action == "update" {
		effect = "覆盖更新 Go 到 ~/.local/go，并在 Shell 配置追加 PATH"
	}
	return CreateLifecyclePlan("go", action, "bash", []string{"-c", strings.Join(lines, "\n")}, PlanOptions{
		ID:     "go_" + action + "_official_tarball",
		Label:  verb + " Go（官方发布包）",
		Method: "go.dev 官方发布包",
		Effect: effect,
	})
}

func buildGoCleanupPlan(options BuildOptions) (Plan, bool) {
	return BuildProfileAwareCleanupPlan("go", "Go", []string{goProfileMarker}, nil, []string{".local/go"}, options)
}

func resolveGoCorePlans(action string, options BuildOptions) []Plan {
	if normalizePlatform(options.Platform) == PlatformWindows {
		return []Plan{BuildWingetPlan("go", action, "GoLang.Go", "Go")}
	}
	plans := []Plan{}
	if normalizePlatform(options.Platform) == PlatformMacOS {
		plans = append(plans, BuildBrewPlan("go", action, "go", "Go", false))
	}
	if action == "uninstall" {
		if cleanup, ok := buildGoCleanupPlan(options); ok {
			plans = append(plans, cleanup)
		}
		return plans
	}
	return append(plans, buildGoTarballPlan(action, options))
}

func buildGoenvGitPlan(action string, options BuildOptions) Plan {
	home := options.HomeDir
	root := JoinPath(options.Platform, home, ".goenv")
	lines := []string{
		"set -euo pipefail",
		"root=" + ShellQuote(root),
		"if [ -d \"$root/.git\" ]; then git -C \"$root\" pull --ff-only; else git clone --depth 1 " + ShellQuote(goenvRepository) + " \"$root\"; fi",
	}
	lines = append(lines, appendProfileLinesSnippet(home, "GOENV_ROOT", []string{
		"export GOENV_ROOT=\"$HOME/.goenv\"",
		"export PATH=\"$GOENV_ROOT/bin:$PATH\"",
		"eval \"$(goenv init -)\"",
	})...)
	verb := "安装"
	if action == "update" {
		verb = "更新"
	}
	effect := "克隆 goenv 到 ~/.goenv，并写入 Shell 初始化"
	if action == "update" {
		effect = "拉取 goenv 到 ~/.goenv，并写入 Shell 初始化"
	}
	return CreateLifecyclePlan("goenv", action, "bash", []string{"-c", strings.Join(lines, "\n")}, PlanOptions{
		ID:     "goenv_" + action + "_git",
		Label:  verb + " goenv",
		Method: "Git",
		Effect: effect,
	})
}

func resolveGoenvPlans(action string, options BuildOptions) []Plan {
	plans := []Plan{}
	if normalizePlatform(options.Platform) == PlatformMacOS {
		plans = append(plans, BuildBrewPlan("goenv", action, "goenv", "goenv", false))
	}
	if action == "uninstall" {
		if cleanup, ok := BuildProfileAwareCleanupPlan("goenv", "goenv", []string{"GOENV_ROOT", "goenv init"}, nil, []string{".goenv"}, options); ok {
			plans = append(plans, cleanup)
		}
		return plans
	}
	return append(plans, buildGoenvGitPlan(action, options))
}

// ResolveGoPlans 复刻 Node plugins/go.js 的 resolvePlans。
func ResolveGoPlans(toolID string, action string, options BuildOptions) []Plan {
	switch toolID {
	case "go":
		return resolveGoCorePlans(action, options)
	case "goenv":
		return resolveGoenvPlans(action, options)
	}
	return nil
}
