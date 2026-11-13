package tools

import (
	"context"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/configedit"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

// ToolCategory 描述托管工具分组，字段与 Node TOOLKIT_TOOL_CATEGORIES 对齐。
type ToolCategory struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

// ToolkitToolCategories 返回受管工具分类清单。
func ToolkitToolCategories() []ToolCategory {
	return []ToolCategory{
		{ID: "session-runtimes", Label: "持久化工具", Description: "管理 AIH 使用的终端复用器和持久会话后端。"},
		{ID: "network-access", Label: "网络接入与隧道", Description: "管理 AIH 使用的 frpc 客户端反向隧道配置。"},
		{ID: "edge-entry", Label: "入口与转发", Description: "管理 AIH 入口层：nginx / caddy 的安装、配置与服务。"},
	}
}

type configValidationOutcome struct {
	OK      bool
	Message string
}

type toolConfigDef struct {
	Name        string
	Format      string
	HasTemplate bool
	Template    string
	Note        string
	ResolvePath func(Options) string
	Validate    func(ctx context.Context, content string, executablePath string, targetPath string, o Options) configValidationOutcome
}

type toolServiceDef struct {
	ProcessRole       string
	HomebrewFormula   string
	LaunchArgs        func(configPath string) []string
	DefaultConfigPath func(Options) string
	ConfigTemplate    string
}

type packageLifecycleDescriptor struct {
	Homebrew       string
	AptPackages    []string
	Winget         string
	WindowsArchive *windowsArchiveSpec
}

type windowsArchiveSpec struct {
	URL            string
	BinaryRelative string
}

type toolPlugin struct {
	ID                        string
	Category                  string
	Name                      string
	Role                      string
	Platforms                 []string
	Commands                  []string
	VersionArgs               [][]string
	Capabilities              []string
	RuntimeInspectable        bool
	Config                    *toolConfigDef
	Service                   *toolServiceDef
	PreferredExecutable       func(Options) string
	ResolveExecutableFallback func(Options) string
	UseFrpcLifecycle          bool
	UseHerdrLifecycle         bool
	PackageLifecycle          *packageLifecycleDescriptor
}

const (
	frpcConfigTemplate = `# frpc 配置（由 AIH 创建）。文档：https://gofrp.org/zh-cn/docs/
serverAddr = "frps.example.com"
serverPort = 7000

# auth.method = "token"
# auth.token = "请替换为 frps 的 token"

# 登录失败时持续重试而不是直接退出，配合 AIH 自动重启
loginFailExit = false

[[proxies]]
name = "ssh"
type = "tcp"
localIP = "127.0.0.1"
localPort = 22
remotePort = 6000
`
	nginxConfigTemplate = `# nginx 配置（由 AIH 创建）
worker_processes auto;
events { worker_connections 1024; }
http {
  default_type application/octet-stream;
  server {
    listen 8080;
    location / { return 200 'aih nginx ok\n'; }
  }
}
`
	caddyConfigTemplate = `# Caddyfile（由 AIH 创建）
:8080 {
	respond "aih caddy ok" 200
}
`
)

var (
	versionParseRx = regexp.MustCompile(`(?i)(?:^|[^0-9])v?(\d+(?:\.\d+){1,3}[A-Za-z][\w.-]*|\d+(?:\.\d+){1,3})(?:$|[^0-9A-Za-z])`)
	nginxConfArgRx = regexp.MustCompile(`--conf-path=([^\s]+)`)
	brewCandidates = []string{"/opt/homebrew/bin/brew", "/usr/local/bin/brew", "/home/linuxbrew/.linuxbrew/bin/brew"}
)

var allToolPlugins = []toolPlugin{
	{
		ID:                 "tmux",
		Category:           "session-runtimes",
		Name:               "tmux",
		Role:               "POSIX 会话复用器",
		Platforms:          []string{"darwin", "linux"},
		Commands:           []string{"tmux"},
		VersionArgs:        [][]string{{"-V"}, {"--version"}},
		Capabilities:       []string{"detect", "version", "sessions", "config-edit"},
		RuntimeInspectable: false,
		Config: &toolConfigDef{
			Name:        ".tmux.conf",
			Format:      "text",
			HasTemplate: true,
			Template:    "# tmux user configuration\n",
			Note:        "宿主 tmux 配置。新建原生 tmux server 时读取；AIH 交互会话使用独立的透明配置。",
			ResolvePath: tmuxConfigPath,
		},
		PackageLifecycle: &packageLifecycleDescriptor{
			Homebrew:    "tmux",
			AptPackages: []string{"tmux"},
		},
	},
	{
		ID:                 "psmux",
		Category:           "session-runtimes",
		Name:               "psmux",
		Role:               "Windows 原生 tmux 兼容运行时",
		Platforms:          []string{"win32"},
		Commands:           []string{"psmux"},
		VersionArgs:        [][]string{{"-V"}, {"--version"}},
		Capabilities:       []string{"detect", "version", "sessions", "config-edit"},
		RuntimeInspectable: false,
		Config: &toolConfigDef{
			Name:        ".tmux.conf",
			Format:      "text",
			HasTemplate: true,
			Template:    "# psmux user configuration\n",
			Note:        "宿主 psmux 配置。AIH 交互会话使用独立的透明配置。",
			ResolvePath: tmuxConfigPath,
		},
		ResolveExecutableFallback: resolvePsmuxWingetLink,
		PackageLifecycle: &packageLifecycleDescriptor{
			Winget: "marlocarlo.psmux",
		},
	},
	{
		ID:                 "herdr",
		Category:           "session-runtimes",
		Name:               "herdr",
		Role:               "后台会话运行时",
		Platforms:          []string{"darwin", "linux", "win32"},
		Commands:           []string{"herdr"},
		VersionArgs:        [][]string{{"--version"}, {"-V"}},
		Capabilities:       []string{"detect", "version", "sessions", "config-edit", "config-validate"},
		RuntimeInspectable: false,
		Config: &toolConfigDef{
			Name:        "config.toml",
			Format:      "toml",
			HasTemplate: true,
			Template:    "# Herdr user configuration\n",
			Note:        "Herdr 原生配置；保存后运行 herdr server reload-config。AIH 交互 CLI 当前使用 tmux / psmux；不兼容的 Herdr 版本不会被后台运行自动选中。",
			ResolvePath: herdrConfigPath,
			Validate: func(_ context.Context, content string, _ string, _ string, _ Options) configValidationOutcome {
				res := configedit.ValidateTOML(content)
				return configValidationOutcome{OK: res.OK, Message: res.Message}
			},
		},
		ResolveExecutableFallback: preferredHerdrExecutable,
		UseHerdrLifecycle:         true,
	},
	{
		ID:                 "frpc",
		Category:           "network-access",
		Name:               "frpc",
		Role:               "FRP 客户端反向隧道",
		Platforms:          []string{"darwin", "linux", "win32"},
		Commands:           []string{"frpc"},
		VersionArgs:        [][]string{{"--version"}, {"-v"}},
		Capabilities:       []string{"detect", "version", "config-edit", "service"},
		RuntimeInspectable: true,
		Config: &toolConfigDef{
			Name:   "frpc.toml",
			Format: "toml",
			Validate: func(ctx context.Context, content string, executablePath string, targetPath string, o Options) configValidationOutcome {
				res := configedit.VerifyWithBinary(ctx, o.Exec, executablePath, targetPath, content, envPlatformBase(o.nodePlatform(), firstNonEmpty(targetPath, "frpc.toml")), true, func(tmp string) []string {
					return []string{"verify", "-c", tmp}
				})
				return configValidationOutcome{OK: res.OK, Message: res.Message}
			},
		},
		Service: &toolServiceDef{
			ProcessRole:       "frpc",
			HomebrewFormula:   "frpc",
			LaunchArgs:        func(configPath string) []string { return []string{"-c", configPath} },
			DefaultConfigPath: defaultFrpcConfigPath,
			ConfigTemplate:    frpcConfigTemplate,
		},
		PreferredExecutable: preferredFrpcExecutable,
		UseFrpcLifecycle:    true,
	},
	{
		ID:                 "nginx",
		Category:           "edge-entry",
		Name:               "nginx",
		Role:               "本机入口：一个端口同时装 HTTPS(WebUI) 与 SOCKS5 中转",
		Platforms:          []string{"darwin", "linux", "win32"},
		Commands:           []string{"nginx"},
		VersionArgs:        [][]string{{"-v"}},
		Capabilities:       []string{"detect", "version", "config-edit", "service"},
		RuntimeInspectable: true,
		Config: &toolConfigDef{
			Name:   "nginx.conf",
			Format: "text",
		},
		Service: &toolServiceDef{
			ProcessRole:       "nginx",
			HomebrewFormula:   "nginx",
			LaunchArgs:        func(configPath string) []string { return []string{"-c", configPath} },
			DefaultConfigPath: defaultNginxConfigPath,
			ConfigTemplate:    nginxConfigTemplate,
		},
		PreferredExecutable: func(o Options) string {
			return preferredArchiveBinary("nginx", "nginx-1.28.3/nginx.exe", o)
		},
		PackageLifecycle: &packageLifecycleDescriptor{
			Homebrew:    "nginx",
			AptPackages: []string{"nginx", "libnginx-mod-stream"},
			WindowsArchive: &windowsArchiveSpec{
				URL:            "https://nginx.org/download/nginx-1.28.3.zip",
				BinaryRelative: "nginx-1.28.3/nginx.exe",
			},
		},
	},
	{
		ID:                 "caddy",
		Category:           "edge-entry",
		Name:               "caddy",
		Role:               "给 WebUI 上 HTTPS（证书自动申请）",
		Platforms:          []string{"darwin", "linux", "win32"},
		Commands:           []string{"caddy"},
		VersionArgs:        [][]string{{"version"}},
		Capabilities:       []string{"detect", "version", "config-edit", "config-validate", "service"},
		RuntimeInspectable: true,
		Config: &toolConfigDef{
			Name:   "Caddyfile",
			Format: "text",
			Validate: func(ctx context.Context, content string, executablePath string, targetPath string, o Options) configValidationOutcome {
				res := configedit.VerifyWithBinary(ctx, o.Exec, executablePath, targetPath, content, "Caddyfile", false, func(tmp string) []string {
					return []string{"validate", "--config", tmp}
				})
				return configValidationOutcome{OK: res.OK, Message: res.Message}
			},
		},
		Service: &toolServiceDef{
			ProcessRole:       "caddy",
			HomebrewFormula:   "caddy",
			LaunchArgs:        func(configPath string) []string { return []string{"run", "--config", configPath} },
			DefaultConfigPath: defaultCaddyConfigPath,
			ConfigTemplate:    caddyConfigTemplate,
		},
		PreferredExecutable: func(o Options) string {
			return preferredArchiveBinary("caddy", "caddy.exe", o)
		},
		PackageLifecycle: &packageLifecycleDescriptor{
			Homebrew:    "caddy",
			AptPackages: []string{"caddy"},
			WindowsArchive: &windowsArchiveSpec{
				URL:            "https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_windows_amd64.zip",
				BinaryRelative: "caddy.exe",
			},
		},
	},
}

func getToolPlugin(toolID string) (toolPlugin, bool) {
	wanted := strings.ToLower(strings.TrimSpace(toolID))
	for _, p := range allToolPlugins {
		if p.ID == wanted {
			return p, true
		}
	}
	return toolPlugin{}, false
}

func listToolPlugins(nodePlatform string) []toolPlugin {
	var out []toolPlugin
	for _, p := range allToolPlugins {
		if nodePlatform == "" || pluginSupportsPlatform(p, nodePlatform) {
			out = append(out, p)
		}
	}
	return out
}

func pluginSupportsPlatform(p toolPlugin, nodePlatform string) bool {
	for _, plat := range p.Platforms {
		if plat == nodePlatform {
			return true
		}
	}
	return false
}

// ResolveCommandPath 解析命令在当前宿主中的绝对路径（对齐 command-path.js：PATH + 用户常用目录 + probe）。
func ResolveCommandPath(ctx context.Context, cmdName string, opts Options) string {
	o := opts.withDefaults()
	trimmed := strings.TrimSpace(cmdName)
	if trimmed == "" {
		return ""
	}
	if o.LookPathOverride != nil {
		if p, err := o.LookPathOverride(trimmed); err == nil && strings.TrimSpace(p) != "" {
			return strings.TrimSpace(p)
		}
		return ""
	}
	platform := o.nodePlatform()
	if found := resolveInDirs(o, parsePathEntries(o), trimmed); found != "" {
		return found
	}
	if found := resolveInDirs(o, userCandidateDirs(o), trimmed); found != "" {
		return found
	}
	if platform != "win32" {
		if found, err := exec.LookPath(trimmed); err == nil && strings.TrimSpace(found) != "" {
			return strings.TrimSpace(found)
		}
		return ""
	}
	res := o.Exec.Run(ctx, "where.exe", []string{trimmed}, environment.ExecOptions{Timeout: defaultDiscoveryTimeout})
	if !res.OK {
		return ""
	}
	for _, line := range strings.Split(res.Stdout, "\n") {
		if candidate := strings.TrimSpace(line); candidate != "" {
			return candidate
		}
	}
	return ""
}

func parsePathEntries(o Options) []string {
	platform := o.nodePlatform()
	raw := o.envValue("PATH")
	if platform == "win32" {
		raw = firstNonEmpty(o.envValue("Path"), o.envValue("PATH"))
	}
	if raw == "" {
		return nil
	}
	sep := ":"
	if platform == "win32" {
		sep = ";"
	}
	var out []string
	for _, part := range strings.Split(raw, sep) {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func userCandidateDirs(o Options) []string {
	if o.nodePlatform() == "win32" {
		return nil
	}
	home := o.hostHome()
	if home == "" {
		return nil
	}
	return []string{
		filepath.Join(home, ".local", "bin"),
		filepath.Join(home, ".codex", "packages", "standalone", "current", "bin"),
		filepath.Join(home, ".npm-global", "bin"),
		filepath.Join(home, ".volta", "bin"),
		filepath.Join(home, ".local", "share", "pnpm"),
	}
}

func resolveInDirs(o Options, dirs []string, cmdName string) string {
	platform := o.nodePlatform()
	names := []string{cmdName}
	if platform == "win32" && envPlatformExt(platform, cmdName) == "" {
		pathext := firstNonEmpty(o.envValue("PATHEXT"), ".EXE;.CMD;.BAT;.COM")
		var expanded []string
		for _, ext := range strings.Split(pathext, ";") {
			if t := strings.TrimSpace(ext); t != "" {
				expanded = append(expanded, cmdName+strings.ToLower(t))
			}
		}
		if len(expanded) > 0 {
			names = expanded
		}
	}
	for _, dir := range dirs {
		for _, name := range names {
			candidate := envPlatformPathJoin(platform, dir, name)
			if o.FileExistsOverride != nil {
				if o.FileExistsOverride(candidate) {
					return candidate
				}
				continue
			}
			info, err := os.Stat(candidate)
			if err != nil || info.IsDir() {
				continue
			}
			if platform != "win32" && info.Mode()&0o111 == 0 {
				continue
			}
			return candidate
		}
	}
	return ""
}

// ResolveManagedToolDir 返回 AIH 自管工具目录（win32: %LOCALAPPDATA%\AIHome\bin\<id>, posix: ~/.ai_home/bin/<id>）。
func ResolveManagedToolDir(toolID string, opts Options) string {
	o := opts.withDefaults()
	id := strings.ToLower(strings.TrimSpace(toolID))
	if id == "" {
		return ""
	}
	platform := o.nodePlatform()
	home := o.hostHome()
	if platform == "win32" {
		localAppData := strings.TrimSpace(o.envValue("LOCALAPPDATA"))
		if localAppData == "" && home != "" {
			localAppData = envPlatformPathJoin(platform, home, "AppData", "Local")
		}
		if localAppData == "" {
			return ""
		}
		return envPlatformPathJoin(platform, localAppData, "AIHome", "bin", id)
	}
	if home == "" {
		return ""
	}
	return envPlatformPathJoin(platform, home, ".ai_home", "bin", id)
}

// ResolveManagedFrpcPath 返回 AIH 自管 frpc 安装路径。
func ResolveManagedFrpcPath(opts Options) string {
	o := opts.withDefaults()
	platform := o.nodePlatform()
	home := o.hostHome()
	if platform == "win32" {
		localAppData := strings.TrimSpace(o.envValue("LOCALAPPDATA"))
		if localAppData == "" && home != "" {
			localAppData = envPlatformPathJoin(platform, home, "AppData", "Local")
		}
		if localAppData == "" {
			return ""
		}
		return envPlatformPathJoin(platform, localAppData, "AIHome", "bin", "frpc.exe")
	}
	if home == "" {
		return ""
	}
	return envPlatformPathJoin(platform, home, ".local", "bin", "frpc")
}

// ResolveHerdrPath 返回 AIH 自管 herdr 安装路径。
func ResolveHerdrPath(opts Options) string {
	o := opts.withDefaults()
	platform := o.nodePlatform()
	home := o.hostHome()
	if home == "" {
		return ""
	}
	if platform == "win32" {
		localAppData := firstNonEmpty(o.envValue("LOCALAPPDATA"), envPlatformPathJoin(platform, home, "AppData", "Local"))
		return envPlatformPathJoin(platform, localAppData, "Programs", "Herdr", "bin", "herdr.exe")
	}
	return envPlatformPathJoin(platform, home, ".local", "bin", "herdr")
}

func preferredFrpcExecutable(o Options) string {
	candidate := ResolveManagedFrpcPath(o)
	if envBoolExists(o, candidate) {
		return candidate
	}
	return ""
}

func preferredHerdrExecutable(o Options) string {
	candidate := ResolveHerdrPath(o)
	if envBoolExists(o, candidate) {
		return candidate
	}
	return ""
}

func preferredArchiveBinary(toolID string, rel string, o Options) string {
	dir := ResolveManagedToolDir(toolID, o)
	if dir == "" {
		return ""
	}
	candidate := envPlatformPathJoin(o.nodePlatform(), dir, rel)
	if envBoolExists(o, candidate) {
		return candidate
	}
	return ""
}

func resolvePsmuxWingetLink(o Options) string {
	platform := o.nodePlatform()
	localAppData := o.envValue("LOCALAPPDATA")
	userProfile := o.envValue("USERPROFILE")
	var candidates []string
	if localAppData != "" {
		candidates = append(candidates, envPlatformPathJoin(platform, localAppData, "Microsoft", "WinGet", "Links", "psmux.exe"))
	}
	if userProfile != "" {
		candidates = append(candidates, envPlatformPathJoin(platform, userProfile, "AppData", "Local", "Microsoft", "WinGet", "Links", "psmux.exe"))
	}
	for _, c := range uniqueStrings(candidates) {
		if envBoolExists(o, c) {
			return c
		}
	}
	return ""
}

func tmuxConfigPath(o Options) string {
	platform := o.nodePlatform()
	home := o.hostHome()
	if home == "" {
		return ""
	}
	xdg := firstNonEmpty(o.LookupEnv("XDG_CONFIG_HOME"), envPlatformPathJoin(platform, home, ".config"))
	candidates := []string{
		envPlatformPathJoin(platform, home, ".tmux.conf"),
		envPlatformPathJoin(platform, xdg, "tmux", "tmux.conf"),
	}
	for _, c := range candidates {
		if pathExistsAny(o, c) {
			return c
		}
	}
	return candidates[0]
}

func herdrConfigPath(o Options) string {
	platform := o.nodePlatform()
	home := o.hostHome()
	if home == "" {
		return ""
	}
	if override := strings.TrimSpace(o.LookupEnv("HERDR_CONFIG_PATH")); override != "" {
		if envPlatformIsAbs(platform, override) {
			return override
		}
		if abs, err := filepath.Abs(override); err == nil {
			return abs
		}
		return override
	}
	var root string
	if platform == "win32" {
		root = firstNonEmpty(o.envValue("APPDATA"), envPlatformPathJoin(platform, home, "AppData", "Roaming"))
	} else {
		root = firstNonEmpty(o.LookupEnv("XDG_CONFIG_HOME"), envPlatformPathJoin(platform, home, ".config"))
	}
	return envPlatformPathJoin(platform, root, "herdr", "config.toml")
}

func defaultFrpcConfigPath(o Options) string {
	home := o.hostHome()
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	return envPlatformPathJoin(o.nodePlatform(), home, ".config", "frp", "frpc.toml")
}

func defaultCaddyConfigPath(o Options) string {
	if explicit := strings.TrimSpace(ReadEdgeContextField(o.LookupEnv, "caddyfile")); explicit != "" {
		return explicit
	}
	for _, c := range []string{"/opt/homebrew/etc/Caddyfile", "/usr/local/etc/Caddyfile", "/etc/caddy/Caddyfile"} {
		if pathExistsAny(o, c) {
			return c
		}
	}
	return ""
}

func defaultNginxConfigPath(o Options) string {
	if explicit := strings.TrimSpace(ReadEdgeContextField(o.LookupEnv, "nginxConfDir")); explicit != "" {
		return path.Join(explicit, "nginx.conf")
	}
	for _, c := range []string{"/opt/homebrew/etc/nginx", "/usr/local/etc/nginx", "/etc/nginx"} {
		if pathExistsAny(o, c) {
			return path.Join(c, "nginx.conf")
		}
	}
	return ""
}

// ParseVersionOutput 从 CLI 输出中提取版本号。
func ParseVersionOutput(output string) string {
	m := versionParseRx.FindStringSubmatch(strings.TrimSpace(output))
	if len(m) == 2 {
		return m[1]
	}
	return ""
}
