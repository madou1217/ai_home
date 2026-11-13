// Package environment 是 WebUI「运行环境」的领域实现：工具目录、探测口径、
// 生命周期计划与入门指南。
//
// 事实来源是 lib/cli/services/toolkit/environment（Node）：
//   - catalog/plugins/*.js      工具清单、平台过滤与任务模板
//   - probe.js                  安装状态 / 版本 / 路径的探测口径
//   - plan-builders + platforms 安装、更新、卸载的回退链
//   - guide-builder.js          入门指南的任务装配
//
// 本包不接触 HTTP，也不直接启动子进程：命令执行通过 Executor 端口注入，
// 文件系统通过 Host 视图注入。这样「本机」与「SSH 远端」只是两套端口实现，
// 目录、计划与探测口径只有一份。
package environment

import "strings"

// 平台标识与 Node 的 PLATFORM_IDS 一致。
const (
	PlatformMacOS   = "macos"
	PlatformWindows = "windows"
	PlatformLinux   = "linux"
)

// Platforms 是 Node PLATFORM_IDS 的顺序（界面枚举顺序）。
var Platforms = []string{PlatformMacOS, PlatformWindows, PlatformLinux}

// PosixPlatforms 是只支持 macOS / Linux 的工具（nvm、pyenv、goenv）。
var PosixPlatforms = []string{PlatformMacOS, PlatformLinux}

// AllPlatforms 是三个平台。
var AllPlatforms = []string{PlatformMacOS, PlatformWindows, PlatformLinux}

// Parameter 是任务模板里的一个可填参数（字段名与 Node PARAMETER_DEFINITIONS 一致）。
type Parameter struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Placeholder string `json:"placeholder"`
}

// Parameters 是 Node PARAMETER_DEFINITIONS 的全量定义。
var Parameters = map[string]Parameter{
	"version":         {Key: "version", Label: "版本号", Placeholder: "例如 22 或 3.12.7"},
	"package":         {Key: "package", Label: "包名", Placeholder: "例如 typescript"},
	"script":          {Key: "script", Label: "脚本路径", Placeholder: "例如 scripts/check.py"},
	"environment":     {Key: "environment", Label: "环境名称", Placeholder: "例如 analytics"},
	"environmentPath": {Key: "environmentPath", Label: "环境目录", Placeholder: "例如 .venv"},
}

// Task 是工具目录里的一个可执行任务模板。
type Task struct {
	ID              string
	Label           string
	Template        string
	WindowsTemplate string
	Category        string
	ParameterKeys   []string
}

// Parameters 返回任务声明的参数定义（顺序即模板占位顺序）。
func (task Task) Parameters() []Parameter {
	result := make([]Parameter, 0, len(task.ParameterKeys))
	for _, key := range task.ParameterKeys {
		if definition, ok := Parameters[key]; ok {
			result = append(result, definition)
		}
	}
	return result
}

// ProbeKind 标识探测方式：普通命令探测，或目录型的版本管理器。
const (
	ProbeKindCommand = ""
	ProbeKindNVM     = "nvm"
	ProbeKindPyenv   = "pyenv"
	ProbeKindConda   = "conda"
)

// ToolSpec 对应 Node 插件里的 tools[] 条目 + probe 声明。
type ToolSpec struct {
	ID          string
	Name        string
	Runtime     string
	Category    string
	Description string
	Platforms   []string
	// ProbeKind 为空表示命令探测；nvm/pyenv/conda 走目录型探测。
	ProbeKind string
	Command   string
	Args      []string
	// KnownPaths 是 PATH 探测失败后的兜底位置（相对家目录或绝对路径）。
	KnownPaths []string
	// ParseVersion 把命令输出解析成版本号；nil 表示取第一行。
	ParseVersion func(string) string
	// ListVersions 返回该工具管理的版本列表（rustup / goenv）。
	ListVersions func(ProbeContext) []string
	Tasks        []Task
}

// tasks 构造任务列表，减少目录字面量的重复。
func tasks(items ...Task) []Task { return items }

// tool 构造工具定义。
func tool(spec ToolSpec) ToolSpec { return spec }

// environmentTools 是 Node listRuntimeTools() 的等价清单，顺序即界面顺序。
var environmentTools = []ToolSpec{
	tool(ToolSpec{
		ID: "nvm", Name: "NVM", Runtime: "node", Category: "version-manager",
		Description: "Node.js 多版本管理", Platforms: PosixPlatforms, ProbeKind: ProbeKindNVM,
		Tasks: tasks(
			Task{ID: "install-version", Label: "安装 Node.js 版本", Template: "nvm install {{version}}", Category: "install", ParameterKeys: []string{"version"}},
			Task{ID: "use-version", Label: "切换当前 Shell 版本", Template: "nvm use {{version}}", Category: "use", ParameterKeys: []string{"version"}},
			Task{ID: "default-version", Label: "设置默认版本", Template: "nvm alias default {{version}}", Category: "configure", ParameterKeys: []string{"version"}},
			Task{ID: "list-versions", Label: "查看已安装版本", Template: "nvm ls", Category: "inspect"},
			Task{ID: "remove-version", Label: "卸载 Node.js 版本", Template: "nvm uninstall {{version}}", Category: "uninstall", ParameterKeys: []string{"version"}},
		),
	}),
	tool(ToolSpec{
		ID: "fnm", Name: "FNM", Runtime: "node", Category: "version-manager",
		Description: "快速 Node.js 多版本管理", Platforms: AllPlatforms,
		Command: "fnm", Args: []string{"--version"},
		Tasks: tasks(
			Task{ID: "install-version", Label: "安装 Node.js 版本", Template: "fnm install {{version}}", Category: "install", ParameterKeys: []string{"version"}},
			Task{ID: "use-version", Label: "切换当前 Shell 版本", Template: "fnm use {{version}}", Category: "use", ParameterKeys: []string{"version"}},
			Task{ID: "default-version", Label: "设置默认版本", Template: "fnm default {{version}}", Category: "configure", ParameterKeys: []string{"version"}},
			Task{ID: "list-versions", Label: "查看已安装版本", Template: "fnm list", Category: "inspect"},
			Task{ID: "remove-version", Label: "卸载 Node.js 版本", Template: "fnm uninstall {{version}}", Category: "uninstall", ParameterKeys: []string{"version"}},
		),
	}),
	tool(ToolSpec{
		ID: "volta", Name: "Volta", Runtime: "node", Category: "version-manager",
		Description: "项目级 Node.js 工具链固定", Platforms: AllPlatforms,
		Command: "volta", Args: []string{"--version"},
		Tasks: tasks(
			Task{ID: "install-node", Label: "安装 Node.js 版本", Template: "volta install node@{{version}}", Category: "install", ParameterKeys: []string{"version"}},
			Task{ID: "pin-node", Label: "固定项目 Node.js 版本", Template: "volta pin node@{{version}}", Category: "configure", ParameterKeys: []string{"version"}},
			Task{ID: "list-tools", Label: "查看已管理工具", Template: "volta list", Category: "inspect"},
		),
	}),
	tool(ToolSpec{
		ID: "pnpm", Name: "pnpm", Runtime: "node", Category: "package-manager",
		Description: "Node.js 包管理", Platforms: AllPlatforms,
		Command: "pnpm", Args: []string{"--version"},
		Tasks: tasks(
			Task{ID: "install-dependencies", Label: "安装项目依赖", Template: "pnpm install", Category: "use"},
			Task{ID: "add-package", Label: "添加依赖", Template: "pnpm add {{package}}", Category: "use", ParameterKeys: []string{"package"}},
			Task{ID: "remove-package", Label: "移除依赖", Template: "pnpm remove {{package}}", Category: "uninstall", ParameterKeys: []string{"package"}},
			Task{ID: "run-script", Label: "运行脚本", Template: "pnpm run {{script}}", Category: "use", ParameterKeys: []string{"script"}},
		),
	}),
	tool(ToolSpec{
		ID: "yarn", Name: "Yarn", Runtime: "node", Category: "package-manager",
		Description: "Node.js 包管理", Platforms: AllPlatforms,
		Command: "yarn", Args: []string{"--version"},
		Tasks: tasks(
			Task{ID: "install-dependencies", Label: "安装项目依赖", Template: "yarn install", Category: "use"},
			Task{ID: "add-package", Label: "添加依赖", Template: "yarn add {{package}}", Category: "use", ParameterKeys: []string{"package"}},
			Task{ID: "remove-package", Label: "移除依赖", Template: "yarn remove {{package}}", Category: "uninstall", ParameterKeys: []string{"package"}},
			Task{ID: "run-script", Label: "运行脚本", Template: "yarn {{script}}", Category: "use", ParameterKeys: []string{"script"}},
		),
	}),
	tool(ToolSpec{
		ID: "bun", Name: "Bun", Runtime: "node", Category: "runtime",
		Description: "JavaScript 运行时与包管理", Platforms: AllPlatforms,
		Command: "bun", Args: []string{"--version"},
		Tasks: tasks(
			Task{ID: "install-dependencies", Label: "安装项目依赖", Template: "bun install", Category: "use"},
			Task{ID: "add-package", Label: "添加依赖", Template: "bun add {{package}}", Category: "use", ParameterKeys: []string{"package"}},
			Task{ID: "remove-package", Label: "移除依赖", Template: "bun remove {{package}}", Category: "uninstall", ParameterKeys: []string{"package"}},
			Task{ID: "run-script", Label: "运行脚本", Template: "bun run {{script}}", Category: "use", ParameterKeys: []string{"script"}},
		),
	}),
	tool(ToolSpec{
		ID: "pyenv", Name: "Pyenv", Runtime: "python", Category: "version-manager",
		Description: "Python 多版本管理", Platforms: PosixPlatforms, ProbeKind: ProbeKindPyenv,
		Command: "pyenv", Args: []string{"--version"},
		Tasks: tasks(
			Task{ID: "install-version", Label: "安装 Python 版本", Template: "pyenv install {{version}}", Category: "install", ParameterKeys: []string{"version"}},
			Task{ID: "global-version", Label: "设置全局版本", Template: "pyenv global {{version}}", Category: "configure", ParameterKeys: []string{"version"}},
			Task{ID: "local-version", Label: "设置当前项目版本", Template: "pyenv local {{version}}", Category: "configure", ParameterKeys: []string{"version"}},
			Task{ID: "list-versions", Label: "查看已安装版本", Template: "pyenv versions", Category: "inspect"},
			Task{ID: "remove-version", Label: "卸载 Python 版本", Template: "pyenv uninstall --force {{version}}", Category: "uninstall", ParameterKeys: []string{"version"}},
		),
	}),
	tool(ToolSpec{
		ID: "conda", Name: "Miniconda", Runtime: "python", Category: "environment-manager",
		Description: "Python 环境与依赖管理", Platforms: AllPlatforms, ProbeKind: ProbeKindConda,
		Command: "conda", Args: []string{"--version"},
		Tasks: tasks(
			Task{ID: "create-environment", Label: "创建环境", Template: "conda create -n {{environment}} python={{version}}", Category: "install", ParameterKeys: []string{"environment", "version"}},
			Task{ID: "activate-environment", Label: "激活环境", Template: "conda activate {{environment}}", Category: "use", ParameterKeys: []string{"environment"}},
			Task{ID: "list-environments", Label: "查看环境", Template: "conda env list", Category: "inspect"},
			Task{ID: "remove-environment", Label: "删除环境", Template: "conda env remove -n {{environment}}", Category: "uninstall", ParameterKeys: []string{"environment"}},
		),
	}),
	tool(ToolSpec{
		ID: "uv", Name: "uv", Runtime: "python", Category: "package-manager",
		Description: "Python 包与虚拟环境管理", Platforms: AllPlatforms,
		Command: "uv", Args: []string{"--version"},
		Tasks: tasks(
			Task{ID: "create-venv", Label: "创建虚拟环境", Template: "uv venv {{environmentPath}}", Category: "install", ParameterKeys: []string{"environmentPath"}},
			Task{ID: "add-package", Label: "安装包", Template: "uv pip install {{package}}", Category: "use", ParameterKeys: []string{"package"}},
			Task{ID: "run-script", Label: "运行脚本", Template: "uv run {{script}}", Category: "use", ParameterKeys: []string{"script"}},
		),
	}),
	tool(ToolSpec{
		ID: "poetry", Name: "Poetry", Runtime: "python", Category: "package-manager",
		Description: "Python 依赖与打包管理", Platforms: AllPlatforms,
		Command: "poetry", Args: []string{"--version"},
		Tasks: tasks(
			Task{ID: "install-dependencies", Label: "安装项目依赖", Template: "poetry install", Category: "use"},
			Task{ID: "add-package", Label: "添加依赖", Template: "poetry add {{package}}", Category: "use", ParameterKeys: []string{"package"}},
			Task{ID: "remove-package", Label: "移除依赖", Template: "poetry remove {{package}}", Category: "uninstall", ParameterKeys: []string{"package"}},
			Task{ID: "run-script", Label: "运行脚本", Template: "poetry run python {{script}}", Category: "use", ParameterKeys: []string{"script"}},
		),
	}),
	tool(ToolSpec{
		ID: "rustup", Name: "rustup", Runtime: "rust", Category: "version-manager",
		Description: "Rust 工具链安装与多版本管理", Platforms: AllPlatforms,
		Command: "rustup", Args: []string{"--version"},
		KnownPaths:   []string{".cargo/bin/rustup"},
		ParseVersion: parseSemver,
		ListVersions: listRustupToolchains,
		Tasks: tasks(
			Task{ID: "install-toolchain", Label: "安装工具链", Template: "rustup toolchain install {{version}}", Category: "install", ParameterKeys: []string{"version"}},
			Task{ID: "default-toolchain", Label: "设置默认工具链", Template: "rustup default {{version}}", Category: "configure", ParameterKeys: []string{"version"}},
			Task{ID: "override-toolchain", Label: "设置当前项目工具链", Template: "rustup override set {{version}}", Category: "configure", ParameterKeys: []string{"version"}},
			Task{ID: "list-toolchains", Label: "查看已安装工具链", Template: "rustup toolchain list", Category: "inspect"},
			Task{ID: "remove-toolchain", Label: "卸载工具链", Template: "rustup toolchain uninstall {{version}}", Category: "uninstall", ParameterKeys: []string{"version"}},
		),
	}),
	tool(ToolSpec{
		ID: "cargo-binstall", Name: "cargo-binstall", Runtime: "rust", Category: "package-manager",
		Description: "直接安装 Rust 预编译二进制", Platforms: AllPlatforms,
		Command: "cargo-binstall", Args: []string{"-V"},
		KnownPaths:   []string{".cargo/bin/cargo-binstall"},
		ParseVersion: parseSemver,
		Tasks: tasks(
			Task{ID: "install-package", Label: "安装二进制包", Template: "cargo binstall -y {{package}}", Category: "install", ParameterKeys: []string{"package"}},
			Task{ID: "add-package", Label: "添加项目依赖", Template: "cargo add {{package}}", Category: "use", ParameterKeys: []string{"package"}},
			Task{ID: "run-project", Label: "运行项目", Template: "cargo run", Category: "use"},
			Task{ID: "remove-package", Label: "卸载二进制包", Template: "cargo uninstall {{package}}", Category: "uninstall", ParameterKeys: []string{"package"}},
		),
	}),
	tool(ToolSpec{
		ID: "go", Name: "Go", Runtime: "go", Category: "runtime",
		Description: "Go 官方工具链", Platforms: AllPlatforms,
		Command: "go", Args: []string{"version"},
		KnownPaths:   []string{".local/go/bin/go", "/usr/local/go/bin/go", "C:\\Program Files\\Go\\bin\\go.exe"},
		ParseVersion: parseGoVersion,
		Tasks: tasks(
			Task{ID: "install-package", Label: "安装命令行工具", Template: "go install {{package}}@latest", Category: "install", ParameterKeys: []string{"package"}},
			Task{ID: "add-package", Label: "添加项目依赖", Template: "go get {{package}}", Category: "use", ParameterKeys: []string{"package"}},
			Task{ID: "tidy", Label: "整理依赖", Template: "go mod tidy", Category: "use"},
			Task{ID: "run-script", Label: "运行程序", Template: "go run {{script}}", Category: "use", ParameterKeys: []string{"script"}},
			Task{ID: "env", Label: "查看 Go 环境", Template: "go env", Category: "inspect"},
		),
	}),
	tool(ToolSpec{
		ID: "goenv", Name: "goenv", Runtime: "go", Category: "version-manager",
		Description: "Go 多版本管理", Platforms: PosixPlatforms,
		Command: "goenv", Args: []string{"--version"},
		KnownPaths:   []string{".goenv/bin/goenv"},
		ListVersions: listGoenvVersions,
		Tasks: tasks(
			Task{ID: "install-version", Label: "安装 Go 版本", Template: "goenv install {{version}}", Category: "install", ParameterKeys: []string{"version"}},
			Task{ID: "global-version", Label: "设置全局版本", Template: "goenv global {{version}}", Category: "configure", ParameterKeys: []string{"version"}},
			Task{ID: "local-version", Label: "设置当前项目版本", Template: "goenv local {{version}}", Category: "configure", ParameterKeys: []string{"version"}},
			Task{ID: "list-versions", Label: "查看已安装版本", Template: "goenv versions", Category: "inspect"},
			Task{ID: "remove-version", Label: "卸载 Go 版本", Template: "goenv uninstall -f {{version}}", Category: "uninstall", ParameterKeys: []string{"version"}},
		),
	}),
	tool(ToolSpec{
		ID: "git", Name: "Git", Runtime: "git", Category: "version-control",
		Description: "版本控制（远程工作区的检查点与撤销依赖它）", Platforms: AllPlatforms,
		Command: "git", Args: []string{"--version"},
		KnownPaths:   []string{"/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "C:\\Program Files\\Git\\cmd\\git.exe"},
		ParseVersion: parseGitVersion,
		Tasks: tasks(
			Task{ID: "status", Label: "查看工作区状态", Template: "git status", Category: "inspect"},
			Task{ID: "log", Label: "查看最近提交", Template: "git log --oneline -20", Category: "inspect"},
		),
	}),
}

// guideOnlyTools 是只出现在入门指南、不参与生命周期管理的条目（Node GUIDE_ONLY_TOOLS）。
var guideOnlyTools = []ToolSpec{
	{
		ID: "venv", Name: "Python venv", Runtime: "python", Category: "virtual-environment",
		Description: "Python 标准库虚拟环境", Platforms: AllPlatforms,
		Tasks: tasks(
			Task{ID: "create", Label: "创建虚拟环境", Template: "python3 -m venv {{environmentPath}}", WindowsTemplate: "python -m venv {{environmentPath}}", Category: "install", ParameterKeys: []string{"environmentPath"}},
			Task{ID: "activate", Label: "激活虚拟环境", Template: "source {{environmentPath}}/bin/activate", WindowsTemplate: ".\\{{environmentPath}}\\Scripts\\Activate.ps1", Category: "use", ParameterKeys: []string{"environmentPath"}},
			Task{ID: "remove", Label: "删除虚拟环境", Template: "rm -rf {{environmentPath}}", WindowsTemplate: "Remove-Item -Recurse -Force {{environmentPath}}", Category: "uninstall", ParameterKeys: []string{"environmentPath"}},
		),
	},
}

// Tools 返回全部可管理工具（拷贝，调用方不能改内部切片）。
func Tools() []ToolSpec {
	return append([]ToolSpec{}, environmentTools...)
}

// ToolsForPlatform 复刻 Node listEnvironmentTools(platform) 的过滤规则。
func ToolsForPlatform(platform string) []ToolSpec {
	normalized := strings.ToLower(strings.TrimSpace(platform))
	if normalized == "" {
		return Tools()
	}
	matched := make([]ToolSpec, 0, len(environmentTools))
	for _, spec := range environmentTools {
		if supportsPlatform(spec, normalized) {
			matched = append(matched, spec)
		}
	}
	return matched
}

// GuideToolsForPlatform 是 Node listGuideTools(platform)：可管理工具 + 指南专用条目。
func GuideToolsForPlatform(platform string) []ToolSpec {
	normalized := strings.ToLower(strings.TrimSpace(platform))
	result := make([]ToolSpec, 0, len(environmentTools)+len(guideOnlyTools))
	for _, spec := range append(append([]ToolSpec{}, environmentTools...), guideOnlyTools...) {
		if normalized == "" || supportsPlatform(spec, normalized) {
			result = append(result, spec)
		}
	}
	return result
}

// ToolByID 按归一化 ID 查工具；未登记返回 false。
func ToolByID(toolID string) (ToolSpec, bool) {
	normalized := strings.ToLower(strings.TrimSpace(toolID))
	for _, spec := range environmentTools {
		if spec.ID == normalized {
			return spec, true
		}
	}
	return ToolSpec{}, false
}

func supportsPlatform(spec ToolSpec, platform string) bool {
	for _, supported := range spec.Platforms {
		if supported == platform {
			return true
		}
	}
	return false
}

// IsKnownPlatform 判断平台标识是否合法（guide 的 platform 查询参数）。
func IsKnownPlatform(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	for _, platform := range Platforms {
		if platform == normalized {
			return true
		}
	}
	return false
}
