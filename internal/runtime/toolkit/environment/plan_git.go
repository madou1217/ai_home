package environment

import "strings"

// git 的 Linux 安装/更新计划：识别发行版包管理器，root 直接装、非 root 用免密 sudo。
var gitLinuxCommands = map[string][][2]string{
	"install": {
		{"apt-get", "$SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -q && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q git"},
		{"dnf", "$SUDO dnf install -y git"},
		{"yum", "$SUDO yum install -y git"},
		{"apk", "$SUDO apk add --no-cache git"},
		{"pacman", "$SUDO pacman -Sy --noconfirm git"},
		{"zypper", "$SUDO zypper --non-interactive install git"},
	},
	"update": {
		{"apt-get", "$SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -q && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --only-upgrade git"},
		{"dnf", "$SUDO dnf upgrade -y git"},
		{"yum", "$SUDO yum update -y git"},
		{"apk", "$SUDO apk upgrade --no-cache git"},
		{"pacman", "$SUDO pacman -Sy --noconfirm git"},
		{"zypper", "$SUDO zypper --non-interactive update git"},
	},
}

func buildGitLinuxPackagePlan(action string) Plan {
	branches := make([]string, 0)
	for index, entry := range gitLinuxCommands[action] {
		prefix := "elif"
		if index == 0 {
			prefix = "if"
		}
		branches = append(branches, prefix+" command -v "+entry[0]+" >/dev/null 2>&1; then echo \"使用 "+entry[0]+"\" >&2; "+entry[1])
	}
	lines := []string{
		"set -eu",
		"if [ \"$(id -u)\" -eq 0 ]; then SUDO=\"\"",
		"elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then SUDO=\"sudo -n\"",
		"else echo \"需要 root 或免密 sudo 才能用系统包管理器安装 Git（可在远端执行：sudo visudo 为该用户开启 NOPASSWD，或手动安装 Git）\" >&2; exit 77",
		"fi",
	}
	lines = append(lines, branches...)
	lines = append(lines, "else echo \"未识别的包管理器（支持 apt-get / dnf / yum / apk / pacman / zypper）\" >&2; exit 78", "fi")
	verb := "安装"
	if action == "update" {
		verb = "更新"
	}
	return CreateLifecyclePlan("git", action, "sh", []string{"-c", strings.Join(lines, "\n")}, PlanOptions{
		ID:     "git_" + action + "_system_package",
		Label:  "系统包管理器" + verb + " Git",
		Method: "系统包管理器（apt / dnf / yum / apk / pacman / zypper）",
		Effect: "用发行版的包管理器" + verb + " Git（需要 root 或免密 sudo）",
	})
}

func buildGitMacCommandLineToolsPlan(action string) Plan {
	lines := []string{
		"set -eu",
		"if [ \"$(id -u)\" -eq 0 ]; then SUDO=\"\"",
		"elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then SUDO=\"sudo -n\"",
		"else echo \"需要 root 或免密 sudo 才能用系统包管理器安装 Git（可在远端执行：sudo visudo 为该用户开启 NOPASSWD，或手动安装 Git）\" >&2; exit 77",
		"fi",
		"marker=/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress",
		"touch \"$marker\"",
		"trap 'rm -f \"$marker\"' EXIT",
		"label=\"$(softwareupdate -l 2>/dev/null | sed -n 's/^[[:space:]]*\\* Label: //p' | grep -i 'Command Line Tools' | sort -V | tail -n 1)\"",
		"[ -n \"$label\" ] || { echo \"softwareupdate 没有提供命令行工具（可能已是最新，或需要在本机图形界面执行 xcode-select --install）\" >&2; exit 79; }",
		"echo \"安装 $label\" >&2",
		"$SUDO softwareupdate -i \"$label\" --verbose",
	}
	verb := "安装"
	if action == "update" {
		verb = "更新"
	}
	return CreateLifecyclePlan("git", action, "sh", []string{"-c", strings.Join(lines, "\n")}, PlanOptions{
		ID:        "git_" + action + "_xcode_clt",
		Label:     verb + " Xcode 命令行工具（含 Git）",
		Method:    "softwareupdate",
		Effect:    "无界面" + verb + " Apple 命令行工具（包含 Git，约 700MB，需要免密 sudo）",
		TimeoutMS: 60 * 60 * 1000,
	})
}

// ResolveGitPlans 复刻 Node plugins/git.js：不提供卸载。
func ResolveGitPlans(toolID string, action string, options BuildOptions) []Plan {
	if toolID != "git" || action == "uninstall" {
		return nil
	}
	switch normalizePlatform(options.Platform) {
	case PlatformWindows:
		return []Plan{BuildWingetPlan("git", action, "Git.Git", "Git")}
	case PlatformMacOS:
		return []Plan{
			BuildBrewPlan("git", action, "git", "Git", false),
			buildGitMacCommandLineToolsPlan(action),
		}
	default:
		return []Plan{buildGitLinuxPackagePlan(action)}
	}
}
