package webuitoolkitruntimeapi

import (
	"regexp"
	"strings"
)

// 探测方式：命令探测（默认）与三种目录型版本管理器。
const (
	kindCommand = ""
	kindNVM     = "nvm"
	kindPyenv   = "pyenv"
	kindConda   = "conda"
)

// 平台标识与 Node 的 PLATFORM_IDS 一致（macos / windows / linux）。
var allPlatforms = []string{"macos", "windows", "linux"}
var posixPlatforms = []string{"macos", "linux"}

// toolSpec 对应 Node 插件里的 tools[] 条目 + probe 声明。
// 清单顺序即 Node plugins/index.js 的注册顺序（node → python → rust → go → git），
// 也是界面展示顺序，不得按字母重排。
type toolSpec struct {
	ID           string
	Name         string
	Runtime      string
	Category     string
	Description  string
	Platforms    []string
	Kind         string
	Command      string
	Args         []string
	KnownPaths   []string
	ParseVersion func(string) string
}

var (
	// semverPattern 与 rust.js 的 SEMVER_PATTERN 一致（rustup / cargo-binstall 用）。
	semverPattern = regexp.MustCompile(`(\d+\.\d+\.\d+[\w.-]*)`)
	// goVersionPattern 与 go.js 的 parseGoVersion 一致：`go version go1.22.1 darwin/arm64`。
	goVersionPattern = regexp.MustCompile(`\bgo(\d+\.\d+(?:\.\d+)?[\w.-]*)`)
	// gitVersionPattern 与 git.js 的 parseGitVersion 一致：`git version 2.39.3 (Apple Git-145)`。
	gitVersionPattern = regexp.MustCompile(`git version (\d+\.\d+(?:\.\d+)?)`)
)

// environmentTools 是 Node listRuntimeTools() 的等价清单，共 15 项。
var environmentTools = []toolSpec{
	{
		ID: "nvm", Name: "NVM", Runtime: "node", Category: "version-manager",
		Description: "Node.js 多版本管理", Platforms: posixPlatforms, Kind: kindNVM,
	},
	{
		ID: "fnm", Name: "FNM", Runtime: "node", Category: "version-manager",
		Description: "快速 Node.js 多版本管理", Platforms: allPlatforms,
		Command: "fnm", Args: []string{"--version"},
	},
	{
		ID: "volta", Name: "Volta", Runtime: "node", Category: "version-manager",
		Description: "项目级 Node.js 工具链固定", Platforms: allPlatforms,
		Command: "volta", Args: []string{"--version"},
	},
	{
		ID: "pnpm", Name: "pnpm", Runtime: "node", Category: "package-manager",
		Description: "Node.js 包管理", Platforms: allPlatforms,
		Command: "pnpm", Args: []string{"--version"},
	},
	{
		ID: "yarn", Name: "Yarn", Runtime: "node", Category: "package-manager",
		Description: "Node.js 包管理", Platforms: allPlatforms,
		Command: "yarn", Args: []string{"--version"},
	},
	{
		ID: "bun", Name: "Bun", Runtime: "node", Category: "runtime",
		Description: "JavaScript 运行时与包管理", Platforms: allPlatforms,
		Command: "bun", Args: []string{"--version"},
	},
	{
		ID: "pyenv", Name: "Pyenv", Runtime: "python", Category: "version-manager",
		Description: "Python 多版本管理", Platforms: posixPlatforms, Kind: kindPyenv,
		Command: "pyenv", Args: []string{"--version"},
	},
	{
		ID: "conda", Name: "Miniconda", Runtime: "python", Category: "environment-manager",
		Description: "Python 环境与依赖管理", Platforms: allPlatforms, Kind: kindConda,
		Command: "conda", Args: []string{"--version"},
	},
	{
		ID: "uv", Name: "uv", Runtime: "python", Category: "package-manager",
		Description: "Python 包与虚拟环境管理", Platforms: allPlatforms,
		Command: "uv", Args: []string{"--version"},
	},
	{
		ID: "poetry", Name: "Poetry", Runtime: "python", Category: "package-manager",
		Description: "Python 依赖与打包管理", Platforms: allPlatforms,
		Command: "poetry", Args: []string{"--version"},
	},
	{
		ID: "rustup", Name: "rustup", Runtime: "rust", Category: "version-manager",
		Description: "Rust 工具链安装与多版本管理", Platforms: allPlatforms,
		Command: "rustup", Args: []string{"--version"},
		KnownPaths: []string{".cargo/bin/rustup"}, ParseVersion: parseSemver,
	},
	{
		ID: "cargo-binstall", Name: "cargo-binstall", Runtime: "rust", Category: "package-manager",
		Description: "直接安装 Rust 预编译二进制", Platforms: allPlatforms,
		Command: "cargo-binstall", Args: []string{"-V"},
		KnownPaths: []string{".cargo/bin/cargo-binstall"}, ParseVersion: parseSemver,
	},
	{
		ID: "go", Name: "Go", Runtime: "go", Category: "runtime",
		Description: "Go 官方工具链", Platforms: allPlatforms,
		Command: "go", Args: []string{"version"},
		KnownPaths:   []string{".local/go/bin/go", "/usr/local/go/bin/go", "C:\\Program Files\\Go\\bin\\go.exe"},
		ParseVersion: parseGoVersion,
	},
	{
		ID: "goenv", Name: "goenv", Runtime: "go", Category: "version-manager",
		Description: "Go 多版本管理", Platforms: posixPlatforms,
		Command: "goenv", Args: []string{"--version"},
		KnownPaths: []string{".goenv/bin/goenv"},
	},
	{
		ID: "git", Name: "Git", Runtime: "git", Category: "version-control",
		Description: "版本控制（远程工作区的检查点与撤销依赖它）", Platforms: allPlatforms,
		Command: "git", Args: []string{"--version"},
		KnownPaths:   []string{"/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "C:\\Program Files\\Git\\cmd\\git.exe"},
		ParseVersion: parseGitVersion,
	},
}

// toolsForPlatform 复刻 Node listEnvironmentTools(platform) 的过滤规则。
func toolsForPlatform(platform string) []toolSpec {
	normalized := strings.ToLower(strings.TrimSpace(platform))
	if normalized == "" {
		return environmentTools
	}
	matched := make([]toolSpec, 0, len(environmentTools))
	for _, tool := range environmentTools {
		for _, supported := range tool.Platforms {
			if supported == normalized {
				matched = append(matched, tool)
				break
			}
		}
	}
	return matched
}

func firstLine(output string) string {
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func parseSemver(output string) string {
	if match := semverPattern.FindStringSubmatch(output); match != nil {
		return match[1]
	}
	return firstLine(output)
}

func parseGoVersion(output string) string {
	if match := goVersionPattern.FindStringSubmatch(output); match != nil {
		return match[1]
	}
	return firstLine(output)
}

func parseGitVersion(output string) string {
	if match := gitVersionPattern.FindStringSubmatch(output); match != nil {
		return match[1]
	}
	return firstLine(output)
}
