package terminals

import (
	"context"
	"strings"
)

const (
	weztermReleaseAPI         = "https://api.github.com/repos/wezterm/wezterm/releases/latest"
	windowsTerminalReleaseAPI = "https://api.github.com/repos/microsoft/terminal/releases/latest"
	itermDownloadsPage        = "https://iterm2.com/downloads.html"
	warpPackageName           = "warp-terminal"
	warpKeyURL                = "https://releases.warp.dev/linux/keys/warp.asc"
	warpAptKeyPath            = "/usr/share/keyrings/warpdotdev.gpg"
	warpAptRepoPath           = "/etc/apt/sources.list.d/warpdotdev.list"
	warpRpmRepoPath           = "/etc/yum.repos.d/warpdotdev.repo"
)

// ActionPlan 是 POST /toolkit/terminals/plan 返回的结构与异步执行器的直接输入。
type ActionPlan struct {
	OK             bool     `json:"ok"`
	Error          string   `json:"error,omitempty"`
	TerminalID     string   `json:"terminalId,omitempty"`
	Action         string   `json:"action,omitempty"`
	Label          string   `json:"label,omitempty"`
	File           string   `json:"file,omitempty"`
	Args           []string `json:"args,omitempty"`
	PackageManager string   `json:"packageManager,omitempty"`
	Command        string   `json:"command,omitempty"`
}

func actionLabelPrefix(action string) string {
	switch action {
	case "install":
		return "安装"
	case "update":
		return "更新"
	case "uninstall":
		return "卸载"
	default:
		return action
	}
}

func psQuote(value string) string {
	return `'` + strings.ReplaceAll(value, `'`, `''`) + `'`
}

func shQuote(value string) string {
	return `'` + strings.ReplaceAll(value, `'`, `'\''`) + `'`
}

func buildPackageManagerPlans(pm string, executable string, pkgID string, label string) []rawLifecyclePlan {
	if executable == "" {
		return nil
	}
	switch pm {
	case "homebrew":
		return []rawLifecyclePlan{
			{Action: "install", Label: "安装 " + label, PackageManager: "homebrew", File: executable, Args: []string{"install", "--cask", pkgID}},
			{Action: "update", Label: "更新 " + label, PackageManager: "homebrew", File: executable, Args: []string{"upgrade", "--cask", pkgID}},
			{Action: "uninstall", Label: "卸载 " + label, PackageManager: "homebrew", File: executable, Args: []string{"uninstall", "--cask", pkgID}},
		}
	case "winget":
		return []rawLifecyclePlan{
			{Action: "install", Label: "安装 " + label, PackageManager: "winget", File: executable, Args: []string{"install", "--id", pkgID, "--exact", "--source", "winget"}},
			{Action: "update", Label: "更新 " + label, PackageManager: "winget", File: executable, Args: []string{"upgrade", "--id", pkgID, "--exact", "--source", "winget"}},
			{Action: "uninstall", Label: "卸载 " + label, PackageManager: "winget", File: executable, Args: []string{"uninstall", "--id", pkgID, "--exact"}},
		}
	case "flatpak":
		return []rawLifecyclePlan{
			{Action: "install", Label: "安装 " + label, PackageManager: "flatpak", File: executable, Args: []string{"install", "--user", "-y", "flathub", pkgID}},
			{Action: "update", Label: "更新 " + label, PackageManager: "flatpak", File: executable, Args: []string{"update", "--user", "-y", pkgID}},
			{Action: "uninstall", Label: "卸载 " + label, PackageManager: "flatpak", File: executable, Args: []string{"uninstall", "--user", "-y", pkgID}},
		}
	default:
		return nil
	}
}

func buildShellPlans(label string, scripts map[string]string) []rawLifecyclePlan {
	actions := []string{"install", "update", "uninstall"}
	out := make([]rawLifecyclePlan, 0, len(actions))
	for _, action := range actions {
		body := strings.TrimSpace(scripts[action])
		out = append(out, rawLifecyclePlan{
			Action:         action,
			Label:          actionLabelPrefix(action) + " " + label,
			PackageManager: "official",
			File:           "/bin/sh",
			Args:           []string{"-c", "set -eu\n" + body},
		})
	}
	return out
}

func resolvePowerShellExe(o Options) string {
	sysRoot := strings.TrimSpace(firstNonEmpty(o.lookupEnv("SystemRoot"), o.lookupEnv("SYSTEMROOT")))
	if sysRoot != "" {
		return joinPlatformPath(PlatformWindows, sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	}
	return "powershell.exe"
}

func buildPowerShellPlans(label string, scripts map[string]string, o Options) []rawLifecyclePlan {
	psExe := resolvePowerShellExe(o)
	actions := []string{"install", "update", "uninstall"}
	out := make([]rawLifecyclePlan, 0, len(actions))
	for _, action := range actions {
		body := strings.Join([]string{
			"$ErrorActionPreference = 'Stop'",
			"$ProgressPreference = 'SilentlyContinue'",
			strings.TrimSpace(scripts[action]),
		}, "\n")
		out = append(out, rawLifecyclePlan{
			Action:         action,
			Label:          actionLabelPrefix(action) + " " + label,
			PackageManager: "official",
			File:           psExe,
			Args:           []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", body},
		})
	}
	return out
}

func windowsDownloadStatements(urlExpr string, destExpr string, label string) string {
	return strings.Join([]string{
		`try {`,
		`  Invoke-WebRequest -UseBasicParsing -Uri ` + urlExpr + ` -OutFile ` + destExpr,
		`} catch {`,
		`  throw ('下载 ` + label + ` 失败: ' + $_.Exception.Message)`,
		`}`,
	}, "\n  ")
}

func macosAppTarget(appName string, o Options, installedPath string) string {
	home := o.hostHome()
	sysTarget := joinPlatformPath(PlatformMacOS, "/Applications", appName)
	userTarget := sysTarget
	if home != "" {
		userTarget = joinPlatformPath(PlatformMacOS, home, "Applications", appName)
	}
	normInstalled := normalizePlatformPath(PlatformMacOS, strings.TrimSpace(installedPath))
	for _, target := range []string{userTarget, sysTarget} {
		normTarget := normalizePlatformPath(PlatformMacOS, target)
		if normInstalled == normTarget || strings.HasPrefix(normInstalled, normTarget+"/") {
			return target
		}
	}
	return userTarget
}

func installAppBundleScript(target string, appName string) string {
	return strings.Join([]string{
		`app="$(find "$source_root" -type d -name ` + shQuote(appName) + ` -print -quit)"`,
		`if [ -z "$app" ]; then echo "官方安装包中未找到应用" >&2; exit 1; fi`,
		`target=` + shQuote(target),
		`parent="$(dirname "$target")"`,
		`mkdir -p "$parent" 2>/dev/null || true`,
		`if [ -w "$parent" ] && { [ ! -e "$target" ] || [ -w "$target" ]; }; then`,
		`  rm -rf "$target"`,
		`  /usr/bin/ditto "$app" "$target"`,
		`else`,
		`  /usr/bin/osascript - "$target" "$app" <<'APPLESCRIPT'`,
		`on run argv`,
		`  set targetPath to item 1 of argv`,
		`  set sourcePath to item 2 of argv`,
		`  set commandText to "/bin/rm -rf " & quoted form of targetPath & " && /usr/bin/ditto " & quoted form of sourcePath & " " & quoted form of targetPath`,
		`  do shell script commandText with administrator privileges`,
		`end run`,
		`APPLESCRIPT`,
		`fi`,
	}, "\n")
}

func uninstallAppBundleScript(target string) string {
	return strings.Join([]string{
		`target=` + shQuote(target),
		`if [ ! -e "$target" ]; then exit 0; fi`,
		`parent="$(dirname "$target")"`,
		`if [ -w "$parent" ] && [ -w "$target" ]; then`,
		`  rm -rf "$target"`,
		`else`,
		`  /usr/bin/osascript - "$target" <<'APPLESCRIPT'`,
		`on run argv`,
		`  set targetPath to item 1 of argv`,
		`  do shell script "/bin/rm -rf " & quoted form of targetPath with administrator privileges`,
		`end run`,
		`APPLESCRIPT`,
		`fi`,
	}, "\n")
}

func zipInstallScript(resolveURLScript string, target string, appName string) string {
	return strings.Join([]string{
		`tmp_dir="$(mktemp -d -t aih-terminal.XXXXXX)"`,
		`trap 'rm -rf "$tmp_dir"' EXIT`,
		resolveURLScript,
		`archive="$tmp_dir/app.zip"`,
		`source_root="$tmp_dir/unpack"`,
		`mkdir -p "$source_root"`,
		`curl -fsSL "$url" -o "$archive"`,
		`/usr/bin/ditto -x -k "$archive" "$source_root"`,
		installAppBundleScript(target, appName),
	}, "\n")
}

func dmgInstallScript(url string, target string, appName string) string {
	return strings.Join([]string{
		`tmp_dir="$(mktemp -d -t aih-terminal.XXXXXX)"`,
		`mount="$tmp_dir/mount"`,
		`mkdir -p "$mount"`,
		`cleanup() { /usr/bin/hdiutil detach "$mount" -force >/dev/null 2>&1 || true; rm -rf "$tmp_dir"; }`,
		`trap cleanup EXIT`,
		`url=` + shQuote(url),
		`archive="$tmp_dir/app.dmg"`,
		`source_root="$mount"`,
		`curl -fsSL "$url" -o "$archive"`,
		`/usr/bin/hdiutil attach "$archive" -nobrowse -readonly -mountpoint "$mount" >/dev/null`,
		installAppBundleScript(target, appName),
	}, "\n")
}

func resolveBrew(o Options) string {
	home := o.hostHome()
	fallbacks := []string{"/opt/homebrew/bin/brew", "/usr/local/bin/brew"}
	if home != "" {
		fallbacks = append(fallbacks, joinPlatformPath(PlatformMacOS, home, ".homebrew", "bin", "brew"))
	}
	return resolveLifecycleExecutable([]string{"brew"}, fallbacks, o)
}

func resolveWinget(o Options) string {
	home := o.hostHome()
	localApp := strings.TrimSpace(o.lookupEnv("LOCALAPPDATA"))
	if localApp == "" && home != "" {
		localApp = joinPlatformPath(PlatformWindows, home, "AppData", "Local")
	}
	progFiles := firstNonEmpty(strings.TrimSpace(o.lookupEnv("ProgramFiles")), `C:\Program Files`)
	fallbacks := make([]string, 0, 2)
	if localApp != "" {
		fallbacks = append(fallbacks, joinPlatformPath(PlatformWindows, localApp, "Microsoft", "WindowsApps", "winget.exe"))
	}
	fallbacks = append(fallbacks, joinPlatformPath(PlatformWindows, progFiles, "WindowsApps", "winget.exe"))
	return resolveLifecycleExecutable([]string{"winget"}, fallbacks, o)
}

func resolveFlatpak(o Options) string {
	home := o.hostHome()
	fallbacks := []string{"/usr/bin/flatpak", "/usr/local/bin/flatpak"}
	if home != "" {
		fallbacks = append(fallbacks, joinPlatformPath(PlatformLinux, home, ".local", "bin", "flatpak"))
	}
	return resolveLifecycleExecutable([]string{"flatpak"}, fallbacks, o)
}

func registeredAppUninstallScript(displayNames []string, fallbackTargets []string) string {
	quotedNames := make([]string, 0, len(displayNames))
	for _, n := range displayNames {
		quotedNames = append(quotedNames, psQuote(n))
	}
	quotedTargets := make([]string, 0, len(fallbackTargets))
	for _, t := range fallbackTargets {
		if strings.TrimSpace(t) != "" {
			quotedTargets = append(quotedTargets, psQuote(t))
		}
	}
	return strings.Join([]string{
		`$names = @(` + strings.Join(quotedNames, ", ") + `)`,
		`$roots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')`,
		`$entry = Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $display = [string]$_.DisplayName; $names | Where-Object { $display -eq $_ -or $display -like ('*' + $_ + '*') } } | Select-Object -First 1`,
		`$uninstalled = $false`,
		`if ($entry) {`,
		`  $command = [string]$(if ($entry.QuietUninstallString) { $entry.QuietUninstallString } else { $entry.UninstallString })`,
		`  if (-not $command) { throw '卸载注册项没有可执行命令' }`,
		`  $process = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', $command) -PassThru`,
		`  if (-not $process.WaitForExit(600000)) { throw '卸载器运行超时（10 分钟未退出）' }`,
		`  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) { throw ('卸载器退出码: ' + $process.ExitCode) }`,
		`  $uninstalled = $true`,
		`}`,
		`$targets = @(` + strings.Join(quotedTargets, ", ") + `)`,
		`$removed = $false`,
		`foreach ($target in $targets) {`,
		`  if (-not $target -or -not (Test-Path -LiteralPath $target)) { continue }`,
		`  Remove-Item -LiteralPath $target -Recurse -Force`,
		`  $removed = $true`,
		`}`,
		`if (-not $uninstalled -and -not $removed) { throw '未找到可卸载的终端程序' }`,
	}, "\n")
}

func buildLinuxAppImagePlans(label string, executableName string, packageNames []string, resolveURLScript string, o Options) []rawLifecyclePlan {
	home := o.hostHome()
	targetAssignment := `target="$HOME/.local/bin/` + executableName + `"`
	managedPath := ""
	if home != "" {
		managedPath = joinPlatformPath(PlatformLinux, home, ".local", "bin", executableName)
		targetAssignment = `target=` + shQuote(managedPath)
	}
	install := strings.Join([]string{
		`tmp="$(mktemp -t aih-terminal.XXXXXX)"`,
		`trap 'rm -f "$tmp"' EXIT`,
		resolveURLScript,
		`curl -fsSL "$url" -o "$tmp"`,
		`chmod 0755 "$tmp"`,
		targetAssignment,
		`mkdir -p "$(dirname "$target")"`,
		`install -m 0755 "$tmp" "$target"`,
	}, "\n")

	quotedPkgs := make([]string, 0, len(packageNames))
	for _, p := range packageNames {
		quotedPkgs = append(quotedPkgs, shQuote(p))
	}
	pkgList := "''"
	if len(quotedPkgs) > 0 {
		pkgList = strings.Join(quotedPkgs, " ")
	}
	targets := ""
	if managedPath != "" {
		targets = shQuote(managedPath)
	} else {
		targets = "''"
	}
	uninstall := strings.Join([]string{
		`export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"`,
		`run_root() {`,
		`  if [ "$(id -u)" -eq 0 ]; then "$@"; return; fi`,
		`  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then sudo -n "$@"; return; fi`,
		`  if command -v pkexec >/dev/null 2>&1; then pkexec "$@"; return; fi`,
		`  echo "需要管理员权限才能移除系统终端" >&2`,
		`  exit 77`,
		`}`,
		`for package_name in ` + pkgList + `; do`,
		`  if command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f="${Status}" "$package_name" 2>/dev/null | grep -q "install ok installed"; then`,
		`    if command -v apt-get >/dev/null 2>&1; then run_root apt-get remove -y "$package_name"; else run_root dpkg --remove "$package_name"; fi`,
		`  fi`,
		`  if command -v rpm >/dev/null 2>&1 && rpm -q "$package_name" >/dev/null 2>&1; then`,
		`    if command -v dnf >/dev/null 2>&1; then run_root dnf remove -y "$package_name";`,
		`    elif command -v yum >/dev/null 2>&1; then run_root yum remove -y "$package_name";`,
		`    else run_root rpm -e "$package_name"; fi`,
		`  fi`,
		`done`,
		`for target in ` + targets + `; do`,
		`  if [ -z "$target" ] || [ ! -e "$target" ] && [ ! -L "$target" ]; then continue; fi`,
		`  case "$target" in`,
		`    */.local/bin/` + executableName + `) rm -f "$target" ;;`,
		`    /usr/bin/` + executableName + `|/usr/local/bin/` + executableName + `) run_root rm -f "$target" ;;`,
		`    *) echo "拒绝移除非受管终端路径: $target" >&2; exit 64 ;;`,
		`  esac`,
		`done`,
	}, "\n")

	return buildShellPlans(label, map[string]string{
		"install":   install,
		"update":    install,
		"uninstall": uninstall,
	})
}

func resolveLocalAppData(o Options) string {
	home := o.hostHome()
	localApp := strings.TrimSpace(o.lookupEnv("LOCALAPPDATA"))
	if localApp != "" {
		return localApp
	}
	if home != "" {
		return joinPlatformPath(PlatformWindows, home, "AppData", "Local")
	}
	return `C:\Users\Public\AppData\Local`
}

func resolveWindowsTerminalPackageExecutable(o Options) string {
	if o.clientPlatform() != PlatformWindows {
		return ""
	}
	// 当测试注入了 PathExists 但没有注入 Exec 时，不触碰真实宿主 PowerShell。
	if o.PathExists != nil && o.Exec == nil {
		return ""
	}
	out, err := runSyncCommand(context.Background(), o,
		"powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
		"$ProgressPreference='SilentlyContinue'; (Get-AppxPackage -Name Microsoft.WindowsTerminal -ErrorAction SilentlyContinue | Select-Object -ExpandProperty InstallLocation)",
	)
	if err != nil {
		return ""
	}
	for _, rawLine := range strings.Split(out, "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(rawLine, "\r"))
		if line == "" {
			continue
		}
		candidate := line
		if !winTerminalExe.MatchString(line) {
			candidate = joinPlatformPath(PlatformWindows, line, "WindowsTerminal.exe")
		}
		if o.exists(candidate) {
			return candidate
		}
	}
	return ""
}

func allTerminalPlugins() []terminalPlugin {
	return []terminalPlugin{
		pluginSystemDefault(),
		pluginWezTerm(),
		pluginWarp(),
		pluginITerm2(),
		pluginWindowsTerminal(),
		pluginCMD(),
	}
}

func getTerminalPlugin(id string) (terminalPlugin, bool) {
	normalized := strings.ToLower(strings.TrimSpace(id))
	if normalized == "" {
		normalized = DefaultTerminalID
	}
	for _, p := range allTerminalPlugins() {
		if p.ID == normalized {
			return p, true
		}
	}
	return terminalPlugin{}, false
}

func pluginSystemDefault() terminalPlugin {
	return terminalPlugin{
		ID:                DefaultTerminalID,
		Name:              "系统默认终端",
		Description:       "使用当前操作系统配置的默认终端。",
		Default:           true,
		Platforms:         []string{PlatformMacOS, PlatformWindows, PlatformLinux},
		HiddenOnPlatforms: []string{PlatformWindows},
		Detect:            func(Options) Detection { return Detection{Installed: true} },
		BuildLaunch: func(command string, title string, o Options) *LaunchSpec {
			platform := o.clientPlatform()
			switch platform {
			case PlatformWindows:
				if wt := pluginWindowsTerminal().BuildLaunch(command, title, o); wt != nil {
					return wt
				}
				spec := buildWindowsCmdLaunchSpec(command, true, title)
				spec.TerminalID = DefaultTerminalID
				return &spec
			case PlatformMacOS:
				lines := []string{
					`tell application "Terminal"`,
					`activate`,
					`do script "` + escapeAppleScriptString(command) + `"`,
					`end tell`,
				}
				args := make([]string, 0, len(lines)*2)
				for _, line := range lines {
					args = append(args, "-e", line)
				}
				return &LaunchSpec{
					TerminalID: DefaultTerminalID,
					File:       "osascript",
					Args:       args,
				}
			case PlatformLinux:
				type termCand struct {
					name   string
					prefix string
				}
				cands := make([]termCand, 0, 6)
				if req := strings.TrimSpace(o.lookupEnv("TERMINAL")); req != "" {
					cands = append(cands, termCand{name: req, prefix: "-e"})
				}
				cands = append(cands,
					termCand{"x-terminal-emulator", "-e"},
					termCand{"gnome-terminal", "--"},
					termCand{"konsole", "-e"},
					termCand{"xfce4-terminal", "-e"},
					termCand{"alacritty", "-e"},
				)
				for _, c := range cands {
					var exe string
					if strings.HasPrefix(c.name, "/") {
						if o.exists(c.name) {
							exe = c.name
						}
					} else {
						exe = findOnPath([]string{c.name}, o)
					}
					if exe != "" {
						return &LaunchSpec{
							TerminalID: DefaultTerminalID,
							File:       exe,
							Args:       []string{c.prefix, "bash", "-lc", command},
						}
					}
				}
			}
			return nil
		},
	}
}

func pluginWezTerm() terminalPlugin {
	p := terminalPlugin{
		ID:              "wezterm",
		Name:            "WezTerm",
		Description:     "跨平台 GPU 终端，支持 macOS、Windows 与 Linux。",
		SourceURL:       "https://wezterm.org/install/",
		Platforms:       []string{PlatformMacOS, PlatformWindows, PlatformLinux},
		WindowsOrder:    2,
		HasWindowsOrder: true,
		Executables: map[string]platformExecutables{
			PlatformMacOS: {
				BinaryNames:  []string{"wezterm", "wezterm-gui"},
				ManagedPaths: []string{"{hostHomeDir}/Applications/WezTerm.app/Contents/MacOS/wezterm"},
				Paths:        []string{"/Applications/WezTerm.app/Contents/MacOS/wezterm"},
			},
			PlatformWindows: {
				BinaryNames:  []string{"wezterm.exe", "wezterm-gui.exe"},
				ManagedPaths: []string{"{localAppData}/Programs/WezTerm/wezterm.exe"},
				Paths:        []string{"{hostHomeDir}/scoop/apps/wezterm/current/wezterm.exe"},
			},
			PlatformLinux: {
				BinaryNames:  []string{"wezterm", "wezterm-gui"},
				ManagedPaths: []string{"{hostHomeDir}/.local/bin/wezterm"},
				Paths:        []string{"/usr/bin/wezterm", "/usr/local/bin/wezterm"},
			},
		},
	}
	p.Detect = func(o Options) Detection {
		exe := resolveTerminalExecutable(p, nil, o)
		return Detection{Installed: exe != "", ExecutablePath: exe}
	}
	p.BuildLaunch = func(command string, title string, o Options) *LaunchSpec {
		exe := resolveTerminalExecutable(p, nil, o)
		if exe == "" {
			return nil
		}
		if o.clientPlatform() == PlatformWindows {
			return &LaunchSpec{
				TerminalID: p.ID,
				File:       exe,
				Args:       []string{"start", "--always-new-process", "--", "cmd.exe", "/k", command},
			}
		}
		return &LaunchSpec{
			TerminalID: p.ID,
			File:       exe,
			Args:       []string{"start", "--always-new-process", "--", "bash", "-lc", command},
			Title:      title,
		}
	}
	p.BuildLifecycle = func(o Options, installedPath string) []rawLifecyclePlan {
		switch o.clientPlatform() {
		case PlatformMacOS:
			if plans := buildPackageManagerPlans("homebrew", resolveBrew(o), "wezterm", "WezTerm"); len(plans) > 0 {
				return plans
			}
			target := macosAppTarget("WezTerm.app", o, installedPath)
			install := zipInstallScript(strings.Join([]string{
				`release_json="$(curl -fsSL -H 'Accept: application/vnd.github+json' -H 'User-Agent: ai-home-toolkit' ` + shQuote(weztermReleaseAPI) + `)"`,
				`url="$(printf '%s' "$release_json" | tr '\n' ' ' | sed -n 's/.*"browser_download_url":[[:space:]]*"\([^"]*WezTerm-macos-[^"]*\.zip\)".*/\1/p')"`,
				`case "$url" in https://github.com/wezterm/wezterm/releases/download/*/WezTerm-macos-*.zip) ;; *) echo "未解析到 WezTerm 官方 macOS 发布包" >&2; exit 1;; esac`,
			}, "\n"), target, "WezTerm.app")
			return buildShellPlans("WezTerm", map[string]string{
				"install":   install,
				"update":    install,
				"uninstall": uninstallAppBundleScript(target),
			})
		case PlatformWindows:
			if plans := buildPackageManagerPlans("winget", resolveWinget(o), "wez.wezterm", "WezTerm"); len(plans) > 0 {
				return plans
			}
			installRoot := joinPlatformPath(PlatformWindows, resolveLocalAppData(o), "Programs", "WezTerm")
			install := strings.Join([]string{
				`$release = Invoke-RestMethod -Uri ` + psQuote(weztermReleaseAPI) + ` -Headers @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'ai-home-toolkit' }`,
				`$asset = $release.assets | Where-Object { $_.name -match '^WezTerm-windows-.+\.zip$' } | Select-Object -First 1`,
				`if (-not $asset) { throw '未解析到 WezTerm 官方 Windows 发布包' }`,
				`$url = [string]$asset.browser_download_url`,
				`if (-not $url.StartsWith('https://github.com/wezterm/wezterm/releases/download/')) { throw 'WezTerm 发布地址不可信' }`,
				`$stage = Join-Path $env:TEMP ('aih-wezterm-' + [guid]::NewGuid().ToString('n'))`,
				`$archive = Join-Path $stage 'wezterm.zip'`,
				`$unpack = Join-Path $stage 'unpack'`,
				`New-Item -ItemType Directory -Force -Path $unpack | Out-Null`,
				`try {`,
				`  ` + windowsDownloadStatements(`$url`, `$archive`, `WezTerm 安装包`),
				`  Expand-Archive -LiteralPath $archive -DestinationPath $unpack -Force`,
				`  $executable = Get-ChildItem -LiteralPath $unpack -Recurse -File -Filter 'wezterm.exe' | Select-Object -First 1`,
				`  if (-not $executable) { throw '官方发布包中未找到 wezterm.exe' }`,
				`  $sourceRoot = $executable.Directory.FullName`,
				`  $targetRoot = ` + psQuote(installRoot),
				`  if (Test-Path -LiteralPath $targetRoot) { Remove-Item -LiteralPath $targetRoot -Recurse -Force }`,
				`  New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null`,
				`  Copy-Item -Path (Join-Path $sourceRoot '*') -Destination $targetRoot -Recurse -Force`,
				`} finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }`,
			}, "\n")
			return buildPowerShellPlans("WezTerm", map[string]string{
				"install":   install,
				"update":    install,
				"uninstall": registeredAppUninstallScript([]string{"WezTerm"}, []string{installRoot, installedPath}),
			}, o)
		case PlatformLinux:
			if plans := buildPackageManagerPlans("flatpak", resolveFlatpak(o), "org.wezfurlong.wezterm", "WezTerm"); len(plans) > 0 {
				return plans
			}
			return buildLinuxAppImagePlans("WezTerm", "wezterm", []string{"wezterm"}, strings.Join([]string{
				`release="$(curl -fsSL ` + shQuote(weztermReleaseAPI) + `)"`,
				`url="$(printf '%s\n' "$release" | grep -Eo 'https://github.com/wezterm/wezterm/releases/download/[^" ]+/WezTerm-[^" ]+-Ubuntu20\.04\.AppImage' | head -n1)"`,
				`case "$url" in https://github.com/wezterm/wezterm/releases/download/*/WezTerm-*-Ubuntu20.04.AppImage) ;; *) echo "未找到 WezTerm 官方 AppImage" >&2; exit 1;; esac`,
			}, "\n"), o)
		}
		return nil
	}
	return p
}

func pluginWarp() terminalPlugin {
	p := terminalPlugin{
		ID:              "warp",
		Name:            "Warp",
		Description:     "跨平台现代终端，支持 macOS、Windows 与 Linux。",
		SourceURL:       "https://www.warp.dev/terminal",
		Platforms:       []string{PlatformMacOS, PlatformWindows, PlatformLinux},
		WindowsOrder:    3,
		HasWindowsOrder: true,
		Executables: map[string]platformExecutables{
			PlatformMacOS: {
				ManagedPaths: []string{"{hostHomeDir}/Applications/Warp.app/Contents/MacOS/stable"},
				Paths:        []string{"/Applications/Warp.app/Contents/MacOS/stable"},
			},
			PlatformWindows: {
				BinaryNames:  []string{"warp.exe", "Warp.exe"},
				ManagedPaths: []string{"{localAppData}/Programs/Warp/Warp.exe"},
				Paths:        []string{"{hostHomeDir}/AppData/Local/Programs/Warp/Warp.exe"},
			},
			PlatformLinux: {
				BinaryNames:  []string{"warp-terminal"},
				ManagedPaths: []string{"{hostHomeDir}/.local/bin/warp-terminal"},
				Paths:        []string{"/usr/bin/warp-terminal", "/usr/local/bin/warp-terminal"},
			},
		},
	}
	p.Detect = func(o Options) Detection {
		exe := resolveTerminalExecutable(p, nil, o)
		return Detection{Installed: exe != "", ExecutablePath: exe}
	}
	p.BuildLaunch = func(_ string, title string, o Options) *LaunchSpec {
		exe := resolveTerminalExecutable(p, nil, o)
		if exe == "" {
			return nil
		}
		if o.clientPlatform() == PlatformMacOS {
			return &LaunchSpec{
				TerminalID: p.ID,
				File:       "/usr/bin/open",
				Args:       []string{"-n", "-a", "Warp"},
				Title:      title,
			}
		}
		return &LaunchSpec{
			TerminalID: p.ID,
			File:       exe,
			Args:       []string{},
			Title:      title,
		}
	}
	p.BuildLifecycle = func(o Options, installedPath string) []rawLifecyclePlan {
		switch o.clientPlatform() {
		case PlatformMacOS:
			if plans := buildPackageManagerPlans("homebrew", resolveBrew(o), "warp", "Warp"); len(plans) > 0 {
				return plans
			}
			target := macosAppTarget("Warp.app", o, installedPath)
			pkgName := "dmg_x86_64"
			if o.clientArch() == "arm64" {
				pkgName = "dmg_arm64"
			}
			install := dmgInstallScript("https://app.warp.dev/download?package="+pkgName, target, "Warp.app")
			return buildShellPlans("Warp", map[string]string{
				"install":   install,
				"update":    install,
				"uninstall": uninstallAppBundleScript(target),
			})
		case PlatformWindows:
			if plans := buildPackageManagerPlans("winget", resolveWinget(o), "Warp.Warp", "Warp"); len(plans) > 0 {
				return plans
			}
			installRoot := joinPlatformPath(PlatformWindows, resolveLocalAppData(o), "Programs", "Warp")
			install := strings.Join([]string{
				`$url = 'https://app.warp.dev/download?package=windows'`,
				`$installer = Join-Path $env:TEMP ('aih-warp-' + [guid]::NewGuid().ToString('n') + '.exe')`,
				`try {`,
				`  ` + windowsDownloadStatements(`$url`, `$installer`, `Warp 安装包`),
				`  $signature = Get-AuthenticodeSignature -LiteralPath $installer`,
				`  if ($signature.Status -ne 'Valid') { throw ('Warp 安装包签名校验失败: ' + $signature.Status) }`,
				`  $p = Start-Process -FilePath $installer -ArgumentList @('/VERYSILENT', '/NORESTART', '/CURRENTUSER') -Wait -PassThru`,
				`  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw ('安装包退出码: ' + $p.ExitCode) }`,
				`} finally { Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue }`,
			}, "\n")
			return buildPowerShellPlans("Warp", map[string]string{
				"install":   install,
				"update":    install,
				"uninstall": registeredAppUninstallScript([]string{"Warp"}, []string{installRoot, installedPath}),
			}, o)
		case PlatformLinux:
			return buildWarpLinuxPlans(o)
		}
		return nil
	}
	return p
}

func buildWarpLinuxPlans(o Options) []rawLifecyclePlan {
	aptRepo := "deb [arch=amd64 signed-by=" + warpAptKeyPath + "] https://releases.warp.dev/linux/deb stable main"
	rpmRepo := strings.Join([]string{
		"[warpdotdev]",
		"name=Warp",
		"baseurl=https://releases.warp.dev/linux/rpm/stable/$basearch",
		"enabled=1",
		"gpgcheck=1",
		"gpgkey=" + warpKeyURL,
	}, "\n")
	wrapRoot := func(lines ...string) string {
		prefix := []string{
			`set -eu`,
			`export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"`,
			`run_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }`,
		}
		return strings.Join(append(prefix, lines...), "\n")
	}
	type linuxMgr struct {
		id       string
		commands []string
		fallback []string
		scripts  map[string]string
	}
	strategies := []linuxMgr{
		{
			id:       "apt",
			commands: []string{"apt-get"},
			fallback: []string{"/usr/bin/apt-get", "/usr/local/bin/apt-get"},
			scripts: map[string]string{
				"install": wrapRoot(
					`run_root apt-get install -y wget gpg`,
					`tmp_dir="$(mktemp -d -t aih-warp.XXXXXX)"`,
					`trap 'rm -rf "$tmp_dir"' EXIT`,
					`wget -qO "$tmp_dir/warp.asc" `+shQuote(warpKeyURL),
					`gpg --batch --yes --dearmor -o "$tmp_dir/warpdotdev.gpg" "$tmp_dir/warp.asc"`,
					`printf '%s\n' `+shQuote(aptRepo)+` > "$tmp_dir/warpdotdev.list"`,
					`run_root install -D -o root -g root -m 0644 "$tmp_dir/warpdotdev.gpg" `+shQuote(warpAptKeyPath),
					`run_root install -D -o root -g root -m 0644 "$tmp_dir/warpdotdev.list" `+shQuote(warpAptRepoPath),
					`run_root apt-get update`,
					`run_root apt-get install -y `+warpPackageName,
				),
				"update": wrapRoot(
					`run_root apt-get update`,
					`run_root apt-get install -y --only-upgrade `+warpPackageName,
				),
				"uninstall": wrapRoot(`run_root apt-get remove -y ` + warpPackageName),
			},
		},
		{
			id:       "dnf",
			commands: []string{"dnf"},
			fallback: []string{"/usr/bin/dnf", "/usr/local/bin/dnf"},
			scripts: map[string]string{
				"install": wrapRoot(
					`tmp_dir="$(mktemp -d -t aih-warp.XXXXXX)"`,
					`trap 'rm -rf "$tmp_dir"' EXIT`,
					`printf '%s\n' `+shQuote(rpmRepo)+` > "$tmp_dir/warpdotdev.repo"`,
					`run_root rpm --import `+shQuote(warpKeyURL),
					`run_root install -D -o root -g root -m 0644 "$tmp_dir/warpdotdev.repo" `+shQuote(warpRpmRepoPath),
					`run_root dnf install -y `+warpPackageName,
				),
				"update":    wrapRoot(`run_root dnf upgrade -y ` + warpPackageName),
				"uninstall": wrapRoot(`run_root dnf remove -y ` + warpPackageName),
			},
		},
		{
			id:       "yum",
			commands: []string{"yum"},
			fallback: []string{"/usr/bin/yum", "/usr/local/bin/yum"},
			scripts: map[string]string{
				"install": wrapRoot(
					`tmp_dir="$(mktemp -d -t aih-warp.XXXXXX)"`,
					`trap 'rm -rf "$tmp_dir"' EXIT`,
					`printf '%s\n' `+shQuote(rpmRepo)+` > "$tmp_dir/warpdotdev.repo"`,
					`run_root rpm --import `+shQuote(warpKeyURL),
					`run_root install -D -o root -g root -m 0644 "$tmp_dir/warpdotdev.repo" `+shQuote(warpRpmRepoPath),
					`run_root yum install -y `+warpPackageName,
				),
				"update":    wrapRoot(`run_root yum update -y ` + warpPackageName),
				"uninstall": wrapRoot(`run_root yum remove -y ` + warpPackageName),
			},
		},
	}
	for _, st := range strategies {
		if resolveLifecycleExecutable(st.commands, st.fallback, o) != "" {
			actions := []string{"install", "update", "uninstall"}
			out := make([]rawLifecyclePlan, 0, len(actions))
			for _, a := range actions {
				out = append(out, rawLifecyclePlan{
					Action:         a,
					Label:          actionLabelPrefix(a) + " Warp",
					PackageManager: st.id,
					File:           "/bin/sh",
					Args:           []string{"-c", st.scripts[a]},
				})
			}
			return out
		}
	}
	return buildLinuxAppImagePlans("Warp", "warp-terminal", []string{warpPackageName}, "url='https://app.warp.dev/download?package=appimage'", o)
}

func pluginITerm2() terminalPlugin {
	p := terminalPlugin{
		ID:          "iterm2",
		Name:        "iTerm2",
		Description: "macOS 常用终端，适合多窗口和多会话开发。",
		SourceURL:   "https://iterm2.com/documentation.html",
		Platforms:   []string{PlatformMacOS},
	}
	p.Detect = func(o Options) Detection {
		home := o.hostHome()
		cands := []string{"/Applications/iTerm.app"}
		if home != "" {
			cands = append([]string{home + "/Applications/iTerm.app"}, cands...)
		}
		appPath := findFirstExisting(cands, o)
		return Detection{Installed: appPath != "", ExecutablePath: appPath}
	}
	p.BuildLaunch = func(command string, title string, o Options) *LaunchSpec {
		det := p.Detect(o)
		if !det.Installed {
			return nil
		}
		lines := []string{
			`tell application "iTerm2"`,
			`activate`,
			`tell current window`,
			`create tab with default profile`,
			`tell current session to write text "` + escapeAppleScriptString(command) + `"`,
			`end tell`,
			`end tell`,
		}
		args := make([]string, 0, len(lines)*2)
		for _, line := range lines {
			args = append(args, "-e", line)
		}
		return &LaunchSpec{
			TerminalID: p.ID,
			File:       "osascript",
			Args:       args,
			Title:      title,
		}
	}
	p.BuildLifecycle = func(o Options, installedPath string) []rawLifecyclePlan {
		if plans := buildPackageManagerPlans("homebrew", resolveBrew(o), "iterm2", "iTerm2"); len(plans) > 0 {
			return plans
		}
		target := macosAppTarget("iTerm.app", o, installedPath)
		install := zipInstallScript(strings.Join([]string{
			`page="$(curl -fsSL ` + shQuote(itermDownloadsPage) + `)"`,
			`url="$(printf '%s' "$page" | grep -Eo 'https://iterm2\.com/downloads/stable/iTerm2-[0-9_]+\.zip' | head -n1)"`,
			`case "$url" in https://iterm2.com/downloads/stable/iTerm2-*.zip) ;; *) echo "未解析到 iTerm2 官方稳定版" >&2; exit 1;; esac`,
		}, "\n"), target, "iTerm.app")
		return buildShellPlans("iTerm2", map[string]string{
			"install":   install,
			"update":    install,
			"uninstall": uninstallAppBundleScript(target),
		})
	}
	return p
}

func pluginWindowsTerminal() terminalPlugin {
	p := terminalPlugin{
		ID:                        "windows-terminal",
		Name:                      "Windows Terminal",
		Description:               "Windows 官方终端宿主，支持 PowerShell、CMD 与 WSL。",
		SourceURL:                 "https://learn.microsoft.com/en-us/windows/terminal/install",
		Platforms:                 []string{PlatformWindows},
		WindowsOrder:              0,
		HasWindowsOrder:           true,
		WindowsDefaultWhenInstall: true,
		Executables: map[string]platformExecutables{
			PlatformWindows: {
				BinaryNames: []string{"wt.exe", "wt"},
				Paths:       []string{"{hostHomeDir}/AppData/Local/Microsoft/WindowsApps/wt.exe"},
			},
		},
	}
	p.Detect = func(o Options) Detection {
		exe := resolveTerminalExecutable(p, resolveWindowsTerminalPackageExecutable, o)
		return Detection{Installed: exe != "", ExecutablePath: exe}
	}
	p.BuildLaunch = func(command string, title string, o Options) *LaunchSpec {
		exe := resolveTerminalExecutable(p, resolveWindowsTerminalPackageExecutable, o)
		if exe == "" {
			return nil
		}
		if winWtPkgExeRx.MatchString(exe) {
			hide := false
			args := []string{"-w", "new", "new-tab", "--title", title, "cmd.exe", "/d", "/s", "/k"}
			args = append(args, tokenizeWindowsTerminalCommand(command)...)
			return &LaunchSpec{
				TerminalID:         p.ID,
				File:               exe,
				Args:               args,
				Title:              title,
				WindowsHide:        &hide,
				TerminalExecutable: exe,
			}
		}
		hide := true
		return &LaunchSpec{
			TerminalID:               p.ID,
			File:                     "cmd.exe",
			Args:                     []string{"/d", "/s", "/c", buildWindowsTerminalStartLine(exe, title, command)},
			Title:                    title,
			WindowsHide:              &hide,
			WindowsVerbatimArguments: true,
			TerminalExecutable:       exe,
		}
	}
	p.BuildLifecycle = func(o Options, _ string) []rawLifecyclePlan {
		if plans := buildPackageManagerPlans("winget", resolveWinget(o), "Microsoft.WindowsTerminal", "Windows Terminal"); len(plans) > 0 {
			return plans
		}
		install := strings.Join([]string{
			`$release = Invoke-RestMethod -Uri ` + psQuote(windowsTerminalReleaseAPI) + ` -Headers @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'ai-home-toolkit' }`,
			`$asset = $release.assets | Where-Object { $_.name -match '^Microsoft\.WindowsTerminal_.+_8wekyb3d8bbwe\.msixbundle$' } | Select-Object -First 1`,
			`if (-not $asset) { throw '未解析到 Windows Terminal 官方 MSIXBundle' }`,
			`$url = [string]$asset.browser_download_url`,
			`if (-not $url.StartsWith('https://github.com/microsoft/terminal/releases/download/')) { throw 'Windows Terminal 发布地址不可信' }`,
			`$bundle = Join-Path $env:TEMP ('aih-windows-terminal-' + [guid]::NewGuid().ToString('n') + '.msixbundle')`,
			`try {`,
			`  ` + windowsDownloadStatements(`$url`, `$bundle`, `Windows Terminal MSIX`),
			`  Add-AppxPackage -Path $bundle -ForceApplicationShutdown`,
			`} finally { Remove-Item -LiteralPath $bundle -Force -ErrorAction SilentlyContinue }`,
		}, "\n")
		uninstall := strings.Join([]string{
			`$packages = Get-AppxPackage -Name 'Microsoft.WindowsTerminal'`,
			`if (-not $packages) { exit 0 }`,
			`$packages | Remove-AppxPackage`,
		}, "\n")
		return buildPowerShellPlans("Windows Terminal", map[string]string{
			"install":   install,
			"update":    install,
			"uninstall": uninstall,
		}, o)
	}
	return p
}

func pluginCMD() terminalPlugin {
	return terminalPlugin{
		ID:                     "cmd",
		Name:                   "CMD",
		Description:            "Windows 经典控制台（conhost）窗口，无需安装。",
		Platforms:              []string{PlatformWindows},
		WindowsOrder:           1,
		HasWindowsOrder:        true,
		WindowsFallbackDefault: true,
		Detect:                 func(Options) Detection { return Detection{Installed: true, ExecutablePath: "cmd.exe"} },
		BuildLaunch: func(command string, title string, _ Options) *LaunchSpec {
			spec := buildWindowsCmdLaunchSpec(command, true, title)
			spec.TerminalID = "cmd"
			return &spec
		},
	}
}

// ResolveTerminalActionPlan 解析并校验客户端终端安装/更新/卸载计划。
func ResolveTerminalActionPlan(terminalID string, action string, opts Options) ActionPlan {
	o := opts.withDefaults()
	normID := strings.ToLower(strings.TrimSpace(terminalID))
	normAction := strings.ToLower(strings.TrimSpace(action))
	plugin, ok := getTerminalPlugin(normID)
	if !ok || !supportsPlatform(plugin, o.clientPlatform()) || (normAction != "install" && normAction != "update" && normAction != "uninstall") {
		return ActionPlan{OK: false, Error: "unsupported_terminal_action"}
	}
	det := Detection{}
	if plugin.Detect != nil {
		det = plugin.Detect(o)
	}
	var rawPlans []rawLifecyclePlan
	if plugin.BuildLifecycle != nil {
		rawPlans = plugin.BuildLifecycle(o, det.ExecutablePath)
	}
	var matched *rawLifecyclePlan
	for i := range rawPlans {
		if rawPlans[i].Action == normAction {
			matched = &rawPlans[i]
			break
		}
	}
	if matched == nil {
		return ActionPlan{OK: false, Error: "terminal_action_unavailable"}
	}
	if normAction == "install" && det.Installed {
		return ActionPlan{OK: false, Error: "terminal_already_installed"}
	}
	if normAction != "install" && !det.Installed {
		return ActionPlan{OK: false, Error: "terminal_not_installed"}
	}
	return ActionPlan{
		OK:             true,
		TerminalID:     plugin.ID,
		Action:         normAction,
		Label:          matched.Label,
		File:           matched.File,
		Args:           append([]string(nil), matched.Args...),
		PackageManager: matched.PackageManager,
		Command:        renderCommand(matched.File, matched.Args, o.clientPlatform()),
	}
}
