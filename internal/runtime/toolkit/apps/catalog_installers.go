package apps

import (
	"fmt"
	"sort"
	"strings"
)

var (
	ideClientSpecs = []*IDEClientSpec{
		{
			ID:                     "vscode",
			Name:                   "Visual Studio Code",
			Order:                  0,
			BinaryName:             "code",
			MacBundleNames:         []string{"Visual Studio Code.app"},
			MacExecutableNames:     []string{"Visual Studio Code", "Electron"},
			WindowsProgramNames:    []string{"Microsoft VS Code"},
			WindowsExecutableNames: []string{"Code.exe"},
			LinuxExecutableNames:   []string{"code"},
			ConfigDirectoryName:    "Code",
			RemoteServerDirName:    ".vscode-server",
			Cask:                   "visual-studio-code",
			WingetID:               "Microsoft.VisualStudioCode",
			WindowsDisplayNames:    []string{"Microsoft Visual Studio Code", "Microsoft Visual Studio Code (User)"},
			LinuxRepo: LinuxRepoSpec{
				PackageName: "code",
				AptKeyURL:   "https://packages.microsoft.com/keys/microsoft.asc",
				AptKeyPath:  "/usr/share/keyrings/microsoft.gpg",
				AptRepoPath: "/etc/apt/sources.list.d/vscode.list",
				AptRepoLine: "deb [arch=amd64,arm64,armhf signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/code stable main",
				RpmKeyURL:   "https://packages.microsoft.com/keys/microsoft.asc",
				RpmRepoPath: "/etc/yum.repos.d/vscode.repo",
				RpmRepoBody: "[code]\nname=Visual Studio Code\nbaseurl=https://packages.microsoft.com/yumrepos/vscode\nenabled=1\nautorefresh=1\ntype=rpm-md\ngpgcheck=1\ngpgkey=https://packages.microsoft.com/keys/microsoft.asc",
			},
		},
		{
			ID:                     "cursor",
			Name:                   "Cursor",
			Order:                  1,
			BinaryName:             "cursor",
			MacBundleNames:         []string{"Cursor.app"},
			MacExecutableNames:     []string{"Cursor"},
			WindowsProgramNames:    []string{"Cursor"},
			WindowsExecutableNames: []string{"Cursor.exe"},
			LinuxExecutableNames:   []string{"cursor"},
			ConfigDirectoryName:    "Cursor",
			Cask:                   "cursor",
			WingetID:               "Anysphere.Cursor",
			WindowsDisplayNames:    []string{"Cursor"},
			LinuxRepo: LinuxRepoSpec{
				PackageName: "cursor",
				AptKeyURL:   "https://downloads.cursor.com/keys/anysphere.asc",
				AptKeyPath:  "/etc/apt/keyrings/cursor.gpg",
				AptRepoPath: "/etc/apt/sources.list.d/cursor.list",
				AptRepoLine: "deb [arch=amd64,arm64 signed-by=/etc/apt/keyrings/cursor.gpg] https://downloads.cursor.com/aptrepo stable main",
				RpmKeyURL:   "https://downloads.cursor.com/keys/anysphere.asc",
				RpmRepoPath: "/etc/yum.repos.d/cursor.repo",
				RpmRepoBody: "[cursor]\nname=Cursor\nbaseurl=https://downloads.cursor.com/yumrepo\nenabled=1\ngpgcheck=1\ngpgkey=https://downloads.cursor.com/keys/anysphere.asc",
			},
		},
		{
			ID:                     "windsurf",
			Name:                   "Devin Desktop",
			Order:                  2,
			BinaryName:             "devin-desktop",
			MacBundleNames:         []string{"Devin.app", "Windsurf.app"},
			MacExecutableNames:     []string{"Devin", "Windsurf"},
			WindowsProgramNames:    []string{"Windsurf", "Devin"},
			WindowsExecutableNames: []string{"Devin.exe", "Windsurf.exe"},
			LinuxExecutableNames:   []string{"devin-desktop", "windsurf"},
			ConfigDirectoryName:    "Windsurf",
			Cask:                   "devin-desktop",
			WingetID:               "Codeium.Windsurf",
			WindowsDisplayNames:    []string{"Devin", "Windsurf"},
			LinuxRepo: LinuxRepoSpec{
				PackageName: "devin-desktop",
				AptKeyURL:   "https://windsurf-stable.codeiumdata.com/wVxQEIWkwPUEAGf3/windsurf.gpg",
				AptKeyPath:  "/etc/apt/keyrings/windsurf-stable.gpg",
				AptRepoPath: "/etc/apt/sources.list.d/windsurf.list",
				AptRepoLine: "deb [arch=amd64 signed-by=/etc/apt/keyrings/windsurf-stable.gpg] https://windsurf-stable.codeiumdata.com/wVxQEIWkwPUEAGf3/apt stable main",
				RpmKeyURL:   "https://windsurf-stable.codeiumdata.com/wVxQEIWkwPUEAGf3/yum/RPM-GPG-KEY-windsurf",
				RpmRepoPath: "/etc/yum.repos.d/windsurf.repo",
				RpmRepoBody: "[windsurf]\nname=Devin Desktop\nbaseurl=https://windsurf-stable.codeiumdata.com/wVxQEIWkwPUEAGf3/yum/repo/\nenabled=1\ngpgcheck=1\nmetadata_expire=1h\ngpgkey=https://windsurf-stable.codeiumdata.com/wVxQEIWkwPUEAGf3/yum/RPM-GPG-KEY-windsurf",
			},
		},
	}

	installerRegistry = buildInstallerRegistry()
)

func listIDEClients() []*IDEClientSpec {
	out := make([]*IDEClientSpec, len(ideClientSpecs))
	copy(out, ideClientSpecs)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func getIDEClient(id string) *IDEClientSpec {
	norm := strings.ToLower(strings.TrimSpace(id))
	for _, spec := range ideClientSpecs {
		if spec.ID == norm {
			return spec
		}
	}
	return nil
}

func listStandaloneApps() []*StandaloneAppSpec {
	out := make([]*StandaloneAppSpec, 0, 2)
	for _, spec := range installerRegistry {
		if spec.ManagedApp != nil {
			out = append(out, spec.ManagedApp)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func getInstaller(provider string) *providerInstallerSpec {
	return installerRegistry[strings.ToLower(strings.TrimSpace(provider))]
}

func resolveInstalledAppNames(spec *providerInstallerSpec) bool {
	return spec != nil && spec.CLI != nil && (spec.CLI.ResolveInstallPlans != nil || spec.CLI.CollectPathEntries != nil || len(spec.CLI.BinaryNames) > 0)
}

func isCLIInstallSupported(provider string) bool {
	spec := getInstaller(provider)
	return resolveInstalledAppNames(spec) && spec.CLI.ResolveInstallPlans != nil
}

func buildInstallerRegistry() map[string]*providerInstallerSpec {
	reg := make(map[string]*providerInstallerSpec)

	add := func(spec *providerInstallerSpec) {
		reg[spec.Provider] = spec
	}

	add(&providerInstallerSpec{
		Provider: "claude",
		DesktopConfigPath: func(platform, home, configHome string) string {
			if platform == platformMacOS {
				return joinPlatformPath(platform, home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
			}
			return joinPlatformPath(platform, configHome, "Claude", "claude_desktop_config.json")
		},
		CLI: &cliDescriptor{
			BinaryNames:      []string{"claude"},
			CleanupHomeFiles: []string{".local/bin/claude"},
			CleanupHomeTrees: []string{".local/share/claude"},
			CollectPathEntries: func(opts Options) []string {
				if resolvePlatform(opts) == platformWindows {
					if home := ResolveHostHome(opts); home != "" {
						return []string{joinPlatformPath(platformWindows, home, ".local", "bin")}
					}
				}
				return nil
			},
			ResolveInstallPlans: func(opts Options) []LifecyclePlan {
				p := resolvePlatform(opts)
				if p == platformWindows {
					return filterValidPlans([]LifecyclePlan{
						buildPowerShellScriptPlan("claude_windows_official", "Claude Code 官方 Windows PowerShell 安装器", "https://claude.ai/install.ps1", []string{"claude.ai"}, opts),
						buildCmdScriptPlan("claude_windows_cmd_official", "Claude Code 官方 Windows CMD 安装器", "https://claude.ai/install.cmd", []string{"claude.ai"}),
						buildWingetPlan("Anthropic.ClaudeCode", "WinGet 安装 Claude Code", ""),
					})
				}
				plans := []LifecyclePlan{
					buildPosixScriptPlan("claude_posix_official", "Claude Code 官方 macOS/Linux 安装器", "https://claude.ai/install.sh", []string{"claude.ai"}, nil),
				}
				if p == platformMacOS {
					plans = append(plans, buildCaskPlan("claude-code", "Homebrew 安装 Claude Code（稳定频道）"))
				}
				return filterValidPlans(plans)
			},
		},
		Desktop: map[string]*desktopPlatformDescriptor{
			platformMacOS:   {Cask: "claude", CleanupHomeTrees: []string{"Applications/Claude.app"}},
			platformWindows: {WingetID: "Anthropic.Claude"},
		},
	})

	add(&providerInstallerSpec{
		Provider: "codex",
		CLI: &cliDescriptor{
			Pkg:              "@openai/codex",
			BinaryNames:      []string{"codex"},
			CleanupHomeFiles: []string{".local/bin/codex"},
			ResolveInstallPlans: func(opts Options) []LifecyclePlan {
				p := resolvePlatform(opts)
				if p == platformMacOS {
					return filterValidPlans([]LifecyclePlan{
						buildCaskPlan("codex", "Homebrew 安装 Codex CLI"),
						buildNpmPlan("@openai/codex", opts),
					})
				}
				return filterValidPlans([]LifecyclePlan{buildNpmPlan("@openai/codex", opts)})
			},
		},
		Desktop: map[string]*desktopPlatformDescriptor{
			platformMacOS:   {Cask: "chatgpt", CleanupHomeTrees: []string{"Applications/ChatGPT.app"}},
			platformWindows: {WingetID: "9PLM9XGG6VKS", WingetSource: "msstore", WindowsDisplayNames: []string{"ChatGPT"}},
		},
	})

	add(&providerInstallerSpec{
		Provider: "gemini",
		CLI: &cliDescriptor{
			Pkg:         "@google/gemini-cli",
			BinaryNames: []string{"gemini"},
			ResolveInstallPlans: func(opts Options) []LifecyclePlan {
				p := resolvePlatform(opts)
				plans := []LifecyclePlan{buildNpmPlan("@google/gemini-cli", opts)}
				if p == platformMacOS {
					plans = append(plans, buildCaskPlan("gemini-cli", "Homebrew 安装 Gemini CLI"))
				}
				return filterValidPlans(plans)
			},
		},
	})

	add(&providerInstallerSpec{
		Provider: "grok",
		CLI: &cliDescriptor{
			BinaryNames:      []string{"grok"},
			CleanupHomeTrees: []string{".grok/bin", ".grok/downloads"},
			CollectPathEntries: func(opts Options) []string {
				if home := ResolveHostHome(opts); home != "" {
					return []string{joinPlatformPath(resolvePlatform(opts), home, ".grok", "bin")}
				}
				return nil
			},
			ResolveInstallPlans: func(opts Options) []LifecyclePlan {
				if resolvePlatform(opts) == platformWindows {
					return filterValidPlans([]LifecyclePlan{buildPowerShellScriptPlan("grok_windows_official", "Grok CLI 官方 Windows 安装器", "https://x.ai/cli/install.ps1", []string{"x.ai"}, opts)})
				}
				return filterValidPlans([]LifecyclePlan{buildPosixScriptPlan("grok_posix_official", "Grok CLI 官方 macOS/Linux 安装器", "https://x.ai/cli/install.sh", []string{"x.ai"}, nil)})
			},
		},
	})

	add(&providerInstallerSpec{
		Provider: "cline",
		CLI: &cliDescriptor{
			Pkg:         "cline",
			BinaryNames: []string{"cline"},
			ResolveInstallPlans: func(opts Options) []LifecyclePlan {
				return filterValidPlans([]LifecyclePlan{buildNpmPlan("cline", opts)})
			},
			ResolveUpdatePlans: func(opts Options) []LifecyclePlan {
				return filterValidPlans([]LifecyclePlan{buildNpmUpdatePlan("cline", opts)})
			},
			ResolveUninstallPlans: func(opts Options) []LifecyclePlan {
				return filterValidPlans([]LifecyclePlan{buildNpmUninstallPlan("cline", opts)})
			},
		},
	})

	add(&providerInstallerSpec{
		Provider: "dsh",
		ManagedApp: &StandaloneAppSpec{
			ID: "dsh", Provider: "dsh", Name: "DeepSeek Harness", ClientName: "DeepSeek Harness",
			Categories: []string{"ALL", "CLI Code"}, BinaryName: "dsh", Pkg: "@deepseek-ai/dsh", HookSupported: false, SyncMode: "unavailable",
		},
		CLI: &cliDescriptor{
			Pkg:         "@deepseek-ai/dsh",
			BinaryNames: []string{"dsh"},
			ResolveInstallPlans: func(opts Options) []LifecyclePlan {
				return filterValidPlans([]LifecyclePlan{buildNpmPlan("@deepseek-ai/dsh", opts)})
			},
			ResolveUpdatePlans: func(opts Options) []LifecyclePlan {
				plans := []LifecyclePlan{buildNpmUpdatePlan("@deepseek-ai/dsh", opts)}
				plans = append(plans, buildDshTuiProfileUpdatePlans(opts)...)
				return filterValidPlans(plans)
			},
			ResolveUninstallPlans: func(opts Options) []LifecyclePlan {
				return filterValidPlans([]LifecyclePlan{buildNpmUninstallPlan("@deepseek-ai/dsh", opts)})
			},
		},
	})

	add(&providerInstallerSpec{
		Provider: "pi",
		ManagedApp: &StandaloneAppSpec{
			ID: "pi", Provider: "pi", Name: "Pi", ClientName: "Pi",
			Categories: []string{"ALL", "CLI Code"}, BinaryName: "pi", Pkg: "@earendil-works/pi-coding-agent", HookSupported: false, SyncMode: "unavailable",
		},
		CLI: &cliDescriptor{
			Pkg:            "@earendil-works/pi-coding-agent",
			BinaryNames:    []string{"pi"},
			MinNodeVersion: "22.19.0",
			ResolveInstallPlans: func(opts Options) []LifecyclePlan {
				return filterValidPlans([]LifecyclePlan{buildNpmPlan("@earendil-works/pi-coding-agent", opts)})
			},
			ResolveUpdatePlans: func(opts Options) []LifecyclePlan {
				return filterValidPlans([]LifecyclePlan{buildNpmUpdatePlan("@earendil-works/pi-coding-agent", opts)})
			},
			ResolveUninstallPlans: func(opts Options) []LifecyclePlan {
				return filterValidPlans([]LifecyclePlan{buildNpmUninstallPlan("@earendil-works/pi-coding-agent", opts)})
			},
		},
	})

	add(&providerInstallerSpec{
		Provider: "opencode",
		CLI: &cliDescriptor{
			Pkg:               "@opencode/cli",
			BinaryNames:       []string{"opencode"},
			LegacyNpmPackages: []string{"opencode-ai"},
			CleanupHomeFiles:  []string{".opencode/bin/opencode"},
			CollectPathEntries: func(opts Options) []string {
				if home := ResolveHostHome(opts); home != "" {
					p := resolvePlatform(opts)
					return []string{joinPlatformPath(p, home, ".opencode", "bin"), joinPlatformPath(p, home, ".local", "bin")}
				}
				return nil
			},
			ResolveInstallPlans: func(opts Options) []LifecyclePlan {
				p := resolvePlatform(opts)
				var plans []LifecyclePlan
				if p == platformWindows {
					plans = append(plans, buildPowerShellScriptPlan("opencode_windows_official", "OpenCode CLI 官方 Windows 安装器", "https://opencode.ai/v2/install.ps1", []string{"opencode.ai"}, opts))
				} else {
					plans = append(plans, buildPosixScriptPlan("opencode_posix_official", "OpenCode CLI 官方 macOS/Linux 安装器", "https://opencode.ai/v2/install", []string{"opencode.ai"}, []string{"--no-modify-path"}))
				}
				if p == platformMacOS {
					plans = append(plans, buildBrewFormulaPlan("anomalyco/tap/opencode", "Homebrew 安装 OpenCode CLI"))
				}
				plans = append(plans, buildNpmPlan("@opencode/cli", opts))
				return filterValidPlans(plans)
			},
			ResolveUpdatePlans: func(opts Options) []LifecyclePlan {
				p := resolvePlatform(opts)
				plans := []LifecyclePlan{buildNpmUpdatePlan("@opencode/cli", opts)}
				if p == platformMacOS {
					plans = append(plans, buildBrewFormulaUpdatePlan("anomalyco/tap/opencode", "Homebrew 更新 OpenCode CLI"))
				}
				return filterValidPlans(plans)
			},
			ResolveUninstallPlans: func(opts Options) []LifecyclePlan {
				p := resolvePlatform(opts)
				plans := []LifecyclePlan{buildNpmUninstallPlan("@opencode/cli", opts)}
				if p == platformMacOS {
					plans = append(plans, buildBrewFormulaUninstallPlan("anomalyco/tap/opencode", "Homebrew 卸载 OpenCode CLI"))
				}
				return filterValidPlans(plans)
			},
		},
		Desktop: map[string]*desktopPlatformDescriptor{
			platformMacOS: {Cask: "opencode-desktop", CleanupHomeTrees: []string{"Applications/OpenCode.app"}},
			platformWindows: {
				WindowsDisplayNames: []string{"OpenCode"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					return filterValidPlans([]LifecyclePlan{buildWindowsExecutableInstallPlan("opencode_desktop_windows", "OpenCode 官方 Windows Desktop 安装器", "https://dev.opencode.ai/download/stable/windows-x64-nsis", []string{"dev.opencode.ai"}, windowsNsisSilent, opts)})
				},
			},
			platformLinux: {
				LinuxPackages: []string{"opencode"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					return filterValidPlans([]LifecyclePlan{
						buildLinuxPackageInstallPlan("opencode_desktop_linux_deb", "OpenCode 官方 Linux DEB 安装器", "https://dev.opencode.ai/download/stable/linux-x64-deb", []string{"dev.opencode.ai"}, "deb"),
						buildLinuxPackageInstallPlan("opencode_desktop_linux_rpm", "OpenCode 官方 Linux RPM 安装器", "https://dev.opencode.ai/download/stable/linux-x64-rpm", []string{"dev.opencode.ai"}, "rpm"),
					})
				},
			},
		},
	})

	add(&providerInstallerSpec{
		Provider: "kimi",
		CLI: &cliDescriptor{
			Pkg:              "@moonshot-ai/kimi-code",
			BinaryNames:      []string{"kimi"},
			CleanupHomeFiles: []string{".local/bin/kimi"},
			CollectPathEntries: func(opts Options) []string {
				return collectCommonPOSIXAndBinDirs(opts, ".local/bin", ".kimi-code/bin", ".bun/bin")
			},
			ResolveInstallPlans: func(opts Options) []LifecyclePlan {
				p := resolvePlatform(opts)
				official := buildPosixScriptPlan("kimi_posix_official", "Kimi Code CLI 官方 macOS/Linux 安装器", "https://code.kimi.com/kimi-code/install.sh", []string{"kimi.com"}, nil)
				if p == platformWindows {
					official = buildPowerShellScriptPlan("kimi_windows_official", "Kimi Code CLI 官方 Windows 安装器", "https://code.kimi.com/kimi-code/install.ps1", []string{"kimi.com"}, opts)
				}
				uvCmd := "uv"
				if p == platformWindows {
					uvCmd = "uv.exe"
				}
				return filterValidPlans([]LifecyclePlan{
					official,
					{ID: "kimi_uv_official", Label: "uv 安装 Kimi Code CLI（官方文档）", Command: uvCmd, Args: []string{"tool", "install", "--python", "3.13", "kimi-cli"}, Timeout: packagePlanTimeout},
					buildNpmPlan("@moonshot-ai/kimi-code", opts),
				})
			},
			ResolveUpdatePlans: func(opts Options) []LifecyclePlan {
				return filterValidPlans([]LifecyclePlan{buildNpmUpdatePlan("@moonshot-ai/kimi-code", opts)})
			},
			ResolveUninstallPlans: func(opts Options) []LifecyclePlan {
				return filterValidPlans([]LifecyclePlan{buildNpmUninstallPlan("@moonshot-ai/kimi-code", opts)})
			},
		},
		Desktop: map[string]*desktopPlatformDescriptor{
			platformMacOS: {
				CleanupHomeTrees: []string{"Applications/Kimi.app"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					if !isArchSupported(opts, "arm64") {
						return nil
					}
					script := strings.Join([]string{
						`url="$(curl -fsSI "https://appsupport.kimi.ai/api/app/pkg/latest/macos/download" | grep -i '^location:' | tail -n1 | awk '{print $2}' | tr -d '\r')"`,
						`case "$url" in https://cdn.kimi.com/app/download/macos/kimi_*.dmg) ;; *) echo "未从 Kimi 官方端点解析到 macOS 安装器" >&2; exit 1;; esac`,
						`tmp="$(mktemp -t kimi).dmg"; mount="$(mktemp -d -t kimi-mount)"; cleanup() { hdiutil detach "$mount" -force >/dev/null 2>&1 || true; rm -rf "$mount" "$tmp"; }; trap cleanup EXIT`,
						`curl -fsSL "$url" -o "$tmp"; hdiutil attach "$tmp" -nobrowse -readonly -mountpoint "$mount" >/dev/null; app="$(find "$mount" -maxdepth 1 -type d -name "Kimi.app" -print -quit)"; if [ -z "$app" ]; then app="$(find "$mount" -maxdepth 1 -type d -name "*.app" -print -quit)"; fi; if [ -z "$app" ]; then echo "Kimi.app not found" >&2; exit 1; fi; mkdir -p "$HOME/Applications"; installed="$HOME/Applications/$(basename "$app")"; ditto "$app" "$installed"; echo "` + installedPathMarker + `$installed"`,
					}, "; ")
					return []LifecyclePlan{buildShellPlan("kimi_desktop_macos_official", "Kimi 官方 macOS Desktop 下载器", script)}
				},
			},
			platformWindows: {
				WindowsDisplayNames: []string{"Kimi"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					if !isArchSupported(opts, "x64") {
						return nil
					}
					script := strings.Join([]string{
						`$endpoint = 'https://appsupport.kimi.ai/api/app/pkg/latest/windows/download'`,
						`$request = [System.Net.HttpWebRequest]::Create($endpoint); $request.AllowAutoRedirect = $false; $response = $request.GetResponse()`,
						`try { $url = [string]$response.Headers['Location'] } finally { $response.Close() }`,
						`$uri = [Uri]$url; if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'cdn.kimi.com' -or $uri.AbsolutePath -notmatch '^/app/download/windows/kimi_[0-9.]+\.exe$') { throw '未从 Kimi 官方端点解析到 Windows 安装器' }`,
						`$dest = Join-Path $env:TEMP ('kimi-' + [guid]::NewGuid().ToString('n') + '.exe')`,
						`try { ` + buildWindowsDownloadStatements("", "$url", "Kimi 安装器") + `; ` + buildWindowsExecutableLaunchStatements(windowsNsisSilent) + ` } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }`,
					}, "; ")
					return []LifecyclePlan{buildPowerShellPlan("kimi_desktop_windows_official", "Kimi 官方 Windows Desktop 安装器", script, opts)}
				},
			},
		},
	})

	add(&providerInstallerSpec{
		Provider: "kiro",
		CLI: &cliDescriptor{
			BinaryNames:      []string{"kiro-cli", "kiro-cli-chat"},
			CleanupHomeFiles: []string{".local/bin/kiro-cli", ".local/bin/kiro-cli-chat"},
			CleanupHomeTrees: []string{".local/share/kiro-cli"},
			CollectPathEntries: func(opts Options) []string {
				p := resolvePlatform(opts)
				home := ResolveHostHome(opts)
				if home == "" {
					return nil
				}
				if p == platformWindows {
					env := resolveEnvMap(opts)
					localAppData := nonEmpty(envLookup(env, "LOCALAPPDATA"), joinPlatformPath(p, home, "AppData", "Local"))
					progFiles := nonEmpty(envLookup(env, "ProgramFiles", "PROGRAMFILES"), `C:\Program Files`)
					return []string{joinPlatformPath(p, localAppData, "Kiro-Cli"), joinPlatformPath(p, progFiles, "Kiro-Cli")}
				}
				if p == platformMacOS {
					return []string{joinPlatformPath(p, home, ".local", "bin"), "/Applications/Kiro CLI.app/Contents/MacOS", joinPlatformPath(p, home, "Applications", "Kiro CLI.app", "Contents", "MacOS"), "/usr/local/bin"}
				}
				return []string{joinPlatformPath(p, home, ".local", "bin"), "/usr/local/bin"}
			},
			ResolveInstallPlans: func(opts Options) []LifecyclePlan {
				if resolvePlatform(opts) == platformWindows {
					return filterValidPlans([]LifecyclePlan{buildPowerShellScriptPlan("kiro_windows_official", "Kiro CLI 官方 Windows 安装器", "https://cli.kiro.dev/install.ps1", []string{"kiro.dev"}, opts)})
				}
				return filterValidPlans([]LifecyclePlan{buildPosixScriptPlan("kiro_posix_official", "Kiro CLI 官方 macOS/Linux 安装器", "https://cli.kiro.dev/install", []string{"kiro.dev"}, nil)})
			},
		},
		Desktop: map[string]*desktopPlatformDescriptor{
			platformMacOS: {
				CleanupHomeTrees: []string{"Applications/Kiro.app"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					script := strings.Join([]string{
						`arch="$(uname -m)"; if [ "$arch" = "arm64" ]; then target="dmg-darwin-arm64"; else target="dmg-darwin-x64"; fi`,
						`payload="$(curl --compressed -fsSL "https://prod.download.desktop.kiro.dev/stable/metadata-$target-stable.json")"`,
						`url="$(printf "%s" "$payload" | grep -Eo '"url"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/.*"(https:[^"]+)".*/\1/')"`,
						`case "$url" in https://prod.download.desktop.kiro.dev/*) ;; *) echo "未从 Kiro 官方 metadata 解析到 macOS 安装器" >&2; exit 1;; esac`,
						`tmp="$(mktemp -t kiro).dmg"; mount="$(mktemp -d -t kiro-mount)"; cleanup() { hdiutil detach "$mount" -force >/dev/null 2>&1 || true; rm -rf "$mount" "$tmp"; }; trap cleanup EXIT`,
						`curl -fsSL "$url" -o "$tmp"; hdiutil attach "$tmp" -nobrowse -readonly -mountpoint "$mount" >/dev/null; app="$(find "$mount" -maxdepth 1 -type d -name "Kiro.app" -print -quit)"; if [ -z "$app" ]; then app="$(find "$mount" -maxdepth 1 -type d -name "*.app" -print -quit)"; fi; if [ -z "$app" ]; then echo "Kiro.app not found" >&2; exit 1; fi; mkdir -p "$HOME/Applications"; installed="$HOME/Applications/$(basename "$app")"; ditto "$app" "$installed"; echo "` + installedPathMarker + `$installed"`,
					}, "; ")
					return []LifecyclePlan{buildShellPlan("kiro_desktop_macos_official_metadata", "Kiro 官方 macOS Desktop 安装器", script)}
				},
			},
			platformWindows: {
				WindowsDisplayNames: []string{"Kiro"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					script := strings.Join([]string{
						`$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }`,
						`$metadata = "https://prod.download.desktop.kiro.dev/stable/metadata-win32-$arch-user-stable.json"`,
						`$payload = (Invoke-WebRequest -Uri $metadata -UseBasicParsing).Content`,
						`$match = [regex]::Match([string]$payload, '"url"\s*:\s*"([^"]+)"'); if (-not $match.Success) { throw '未从 Kiro 官方 metadata 解析到 Windows 安装器' }`,
						`$url = $match.Groups[1].Value; if ($url -notlike 'https://prod.download.desktop.kiro.dev/*') { throw 'Kiro Windows 安装器地址不在官方域内' }`,
						`$dest = Join-Path $env:TEMP ('kiro-' + [guid]::NewGuid().ToString('n') + '.exe')`,
						`try { ` + buildWindowsDownloadStatements("", "$url", "Kiro 安装器") + `; ` + buildWindowsExecutableLaunchStatements(windowsInnoSilent) + ` } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }`,
					}, "; ")
					return []LifecyclePlan{buildPowerShellPlan("kiro_desktop_windows_official_metadata", "Kiro 官方 Windows Desktop 安装器", script, opts)}
				},
			},
			platformLinux: {
				LinuxPackages:    []string{"kiro"},
				CleanupHomeFiles: []string{".local/bin/kiro"},
				CleanupHomeTrees: []string{".local/opt/kiro"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					if !isArchSupported(opts, "x64") {
						return nil
					}
					script := strings.Join([]string{
						`payload="$(curl --compressed -fsSL "https://prod.download.desktop.kiro.dev/stable/metadata-linux-x64-deb-stable.json")"`,
						`url="$(printf "%s" "$payload" | grep -Eo '"url"[[:space:]]*:[[:space:]]*"[^"]+"' | head -n1 | sed -E 's/.*"(https:[^"]+)".*/\1/')"`,
						`case "$url" in https://prod.download.desktop.kiro.dev/*) ;; *) echo "未从 Kiro 官方 metadata 解析到 Linux 安装器" >&2; exit 1;; esac`,
						`tmp="$(mktemp --suffix=.deb kiro.XXXXXX)"; trap 'rm -f "$tmp"' EXIT; curl -fsSL "$url" -o "$tmp"; if [ "$(id -u)" -eq 0 ]; then apt-get install -y "$tmp"; else sudo -n apt-get install -y "$tmp"; fi`,
					}, "; ")
					return []LifecyclePlan{buildShellPlan("kiro_desktop_linux_official_metadata", "Kiro 官方 Linux Desktop 安装器", script)}
				},
			},
		},
	})

	// codebuddy & codebuddycn
	addCodeBuddy := func(provider, labelPrefix, macCask string, macCleanup []string, hint string, displayName string, preferWorkBuddyBundle bool) {
		cliPlan := func(opts Options) []LifecyclePlan {
			var official LifecyclePlan
			if resolvePlatform(opts) == platformWindows {
				official = buildPowerShellScriptPlan(provider+"_windows_official", labelPrefix+" CLI 官方 Windows 安装器", "https://copilot.tencent.com/cli/install.ps1", []string{"copilot.tencent.com"}, opts)
			} else {
				official = buildPosixScriptPlan(provider+"_posix_official", labelPrefix+" CLI 官方 macOS/Linux 安装器", "https://copilot.tencent.com/cli/install.sh", []string{"copilot.tencent.com"}, nil)
			}
			return filterValidPlans([]LifecyclePlan{official, buildNpmPlan("@tencent-ai/codebuddy-code", opts)})
		}
		add(&providerInstallerSpec{
			Provider: provider,
			CLI: &cliDescriptor{
				Pkg:              "@tencent-ai/codebuddy-code",
				BinaryNames:      []string{"codebuddy", "cbc", "codebuddy-code"},
				CleanupHomeFiles: []string{".local/bin/codebuddy"},
				CleanupHomeTrees: []string{".local/share/codebuddy"},
				CollectPathEntries: func(opts Options) []string {
					var entries []string
					if preferWorkBuddyBundle {
						entries = append(entries, collectBundledCodeBuddyCliPathEntries(opts)...)
					}
					entries = append(entries, collectCommonPOSIXAndBinDirs(opts, ".local/bin")...)
					if resolvePlatform(opts) == platformWindows {
						if home := ResolveHostHome(opts); home != "" {
							env := resolveEnvMap(opts)
							localAppData := nonEmpty(envLookup(env, "LOCALAPPDATA"), joinPlatformPath(platformWindows, home, "AppData", "Local"))
							entries = append(entries, joinPlatformPath(platformWindows, localAppData, "codebuddy", "bin"))
						}
					}
					return uniqueStrings(entries)
				},
				ResolveInstallPlans: cliPlan,
				ResolveUpdatePlans:  cliPlan,
				ResolveUninstallPlans: func(opts Options) []LifecyclePlan {
					return filterValidPlans([]LifecyclePlan{buildNpmUninstallPlan("@tencent-ai/codebuddy-code", opts)})
				},
			},
			Desktop: map[string]*desktopPlatformDescriptor{
				platformMacOS:   {Cask: macCask, CleanupHomeTrees: macCleanup},
				platformWindows: {Hint: hint, WindowsDisplayNames: []string{displayName}},
				platformLinux:   {Hint: hint},
			},
		})
	}
	addCodeBuddy("codebuddy", "CodeBuddy Code", "codebuddy", []string{"Applications/CodeBuddy.app"}, "CodeBuddy IDE 暂无 Windows 免交互安装源，请从 https://www.codebuddy.ai/ide/ 下载安装后重试。", "CodeBuddy", false)
	addCodeBuddy("codebuddycn", "CodeBuddy CN Code", "codebuddy-cn", []string{"Applications/CodeBuddy CN.app", "Applications/CodeBuddyCN.app"}, "CodeBuddy CN IDE 暂无 Windows 免交互安装源，请从 https://copilot.tencent.com/ide/ 下载安装后重试。", "CodeBuddy CN", true)

	add(&providerInstallerSpec{
		Provider: "workbuddy",
		Desktop: map[string]*desktopPlatformDescriptor{
			platformMacOS:   {Cask: "workbuddy-ai", CleanupHomeTrees: []string{"Applications/WorkBuddy AI.app"}},
			platformWindows: {Hint: "WorkBuddy AI 暂无 Windows 免交互安装源，请从 https://www.workbuddy.ai/ 下载安装后重试。", WindowsDisplayNames: []string{"WorkBuddy AI"}},
			platformLinux:   {Hint: "WorkBuddy AI 暂无 Linux 免交互安装源，请从 https://www.workbuddy.ai/ 下载安装后重试。"},
		},
	})
	add(&providerInstallerSpec{
		Provider: "workbuddycn",
		Desktop: map[string]*desktopPlatformDescriptor{
			platformMacOS:   {Cask: "workbuddy-cn", CleanupHomeTrees: []string{"Applications/WorkBuddy.app"}},
			platformWindows: {Hint: "WorkBuddy 暂无 Windows 免交互安装源，请从 https://www.workbuddy.cn/ 下载安装后重试。", WindowsDisplayNames: []string{"WorkBuddy"}},
			platformLinux:   {Hint: "WorkBuddy 暂无 Linux 免交互安装源，请从 https://www.workbuddy.cn/ 下载安装后重试。"},
		},
	})

	add(&providerInstallerSpec{
		Provider: "qoder",
		CLI: &cliDescriptor{
			Pkg:              "@qoder-ai/qodercli",
			BinaryNames:      []string{"qodercli"},
			CleanupHomeFiles: []string{".local/bin/qodercli"},
			CleanupHomeTrees: []string{".qoder/bin/qodercli"},
			CollectPathEntries: func(opts Options) []string {
				return collectQoderPathEntries(opts, ".qoder", "qodercli", "Qoder")
			},
			ResolveInstallPlans: func(opts Options) []LifecyclePlan {
				p := resolvePlatform(opts)
				if p == platformWindows {
					return filterValidPlans([]LifecyclePlan{
						buildPowerShellScriptPlan("qoder_windows_official", "Qoder CLI 官方 Windows PowerShell 安装器", "https://qoder.com/install.ps1", []string{"qoder.com"}, opts),
						buildCmdScriptPlan("qoder_windows_cmd_official", "Qoder CLI 官方 Windows CMD 安装器", "https://qoder.com/install.cmd", []string{"qoder.com"}),
						buildNpmPlan("@qoder-ai/qodercli", opts),
					})
				}
				return filterValidPlans([]LifecyclePlan{
					buildPosixScriptPlan("qoder_posix_official", "Qoder CLI 官方 macOS/Linux 安装器", "https://qoder.com/install", []string{"qoder.com"}, nil),
					buildNpmPlan("@qoder-ai/qodercli", opts),
				})
			},
			ResolveUpdatePlans: func(opts Options) []LifecyclePlan {
				return filterValidPlans([]LifecyclePlan{buildNpmUpdatePlan("@qoder-ai/qodercli", opts)})
			},
			ResolveUninstallPlans: func(opts Options) []LifecyclePlan {
				return filterValidPlans([]LifecyclePlan{buildNpmUninstallPlan("@qoder-ai/qodercli", opts)})
			},
		},
		Desktop: map[string]*desktopPlatformDescriptor{
			platformMacOS: {
				CleanupHomeTrees: []string{"Applications/Qoder IDE.app", "Applications/Qoder.app"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					arch := "x64"
					if resolveArch(opts) == "arm64" {
						arch = "arm64"
					}
					return filterValidPlans([]LifecyclePlan{buildMacDmgInstallPlan("qoder_desktop_macos_official", "Qoder 官方 macOS Desktop 安装器", fmt.Sprintf("https://download.qoder.com/release/latest/Qoder-IDE-darwin-%s.dmg", arch), []string{"download.qoder.com"}, "Qoder IDE.app")})
				},
			},
			platformWindows: {
				WindowsDisplayNames: []string{"Qoder IDE"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					if !isArchSupported(opts, "x64") {
						return nil
					}
					return filterValidPlans([]LifecyclePlan{buildWindowsExecutableInstallPlan("qoder_desktop_windows_official", "Qoder 官方 Windows Desktop 安装器", "https://download.qoder.com/release/latest/QoderIDEUserSetup-x64.exe", []string{"download.qoder.com"}, windowsInnoSilent, opts)})
				},
			},
			platformLinux: {
				LinuxPackages:    []string{"qoder"},
				CleanupHomeTrees: []string{".local/opt/qoder"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					if !isArchSupported(opts, "x64") {
						return nil
					}
					return filterValidPlans([]LifecyclePlan{
						buildLinuxPackageInstallPlan("qoder_desktop_linux_deb", "Qoder 官方 Linux DEB 安装器", "https://download.qoder.com/release/latest/qoder_amd64.deb", []string{"download.qoder.com"}, "deb"),
						buildLinuxPackageInstallPlan("qoder_desktop_linux_rpm", "Qoder 官方 Linux RPM 安装器", "https://download.qoder.com/release/latest/qoder_x86_64.rpm", []string{"download.qoder.com"}, "rpm"),
					})
				},
			},
		},
	})

	add(&providerInstallerSpec{
		Provider: "qodercn",
		CLI: &cliDescriptor{
			BinaryNames:      []string{"qoderclicn"},
			CleanupHomeFiles: []string{".local/bin/qoderclicn"},
			CleanupHomeTrees: []string{".qoder-cn/bin/qoderclicn"},
			CollectPathEntries: func(opts Options) []string {
				return collectQoderPathEntries(opts, ".qoder-cn", "qoderclicn", "QoderCN")
			},
			ResolveInstallPlans: func(opts Options) []LifecyclePlan {
				if resolvePlatform(opts) == platformWindows {
					return filterValidPlans([]LifecyclePlan{
						buildPowerShellScriptPlan("qodercn_windows_official", "Qoder CN CLI 官方 Windows PowerShell 安装器", "https://qoder.com.cn/install.ps1", []string{"qoder.com.cn"}, opts),
						buildCmdScriptPlan("qodercn_windows_cmd_official", "Qoder CN CLI 官方 Windows CMD 安装器", "https://qoder.com.cn/install.cmd", []string{"qoder.com.cn"}),
					})
				}
				return filterValidPlans([]LifecyclePlan{buildPosixScriptPlan("qodercn_posix_official", "Qoder CN CLI 官方 macOS/Linux 安装器", "https://qoder.com.cn/install", []string{"qoder.com.cn"}, nil)})
			},
		},
		Desktop: map[string]*desktopPlatformDescriptor{
			platformMacOS: {
				CleanupHomeTrees: []string{"Applications/Qoder CN IDE.app", "Applications/Qoder CN.app", "Applications/QoderCN.app"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					arch := "x64"
					if resolveArch(opts) == "arm64" {
						arch = "arm64"
					}
					return filterValidPlans([]LifecyclePlan{buildMacDmgInstallPlan("qodercn_desktop_macos_official", "Qoder CN 官方 macOS Desktop 安装器", fmt.Sprintf("https://qoder-ide-cn.oss-cn-hangzhou.aliyuncs.com/qoder/release/lastest/Qoder-CN-IDE-darwin-%s.dmg", arch), []string{"qoder-ide-cn.oss-cn-hangzhou.aliyuncs.com"}, "Qoder CN IDE.app")})
				},
			},
			platformWindows: {
				WindowsDisplayNames: []string{"Qoder CN IDE"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					if !isArchSupported(opts, "x64") {
						return nil
					}
					return filterValidPlans([]LifecyclePlan{buildWindowsExecutableInstallPlan("qodercn_desktop_windows_official", "Qoder CN 官方 Windows Desktop 安装器", "https://qoder-ide-cn.oss-cn-hangzhou.aliyuncs.com/qoder/release/lastest/QoderCNIDEUserSetup-x64.exe", []string{"qoder-ide-cn.oss-cn-hangzhou.aliyuncs.com"}, windowsInnoSilent, opts)})
				},
			},
			platformLinux: {
				LinuxPackages:    []string{"qoder-cn"},
				CleanupHomeTrees: []string{".local/opt/qoder-cn"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					if !isArchSupported(opts, "x64") {
						return nil
					}
					return filterValidPlans([]LifecyclePlan{
						buildLinuxPackageInstallPlan("qodercn_desktop_linux_deb", "Qoder CN 官方 Linux DEB 安装器", "https://ide.qoder.com.cn/qoder/release/lastest/qoder-cn_amd64.deb", []string{"ide.qoder.com.cn"}, "deb"),
						buildLinuxPackageInstallPlan("qodercn_desktop_linux_rpm", "Qoder CN 官方 Linux RPM 安装器", "https://ide.qoder.com.cn/qoder/release/lastest/qoder-cn_x86_64.rpm", []string{"ide.qoder.com.cn"}, "rpm"),
					})
				},
			},
		},
	})

	add(&providerInstallerSpec{
		Provider: "agy",
		CLI: &cliDescriptor{
			BinaryNames:      []string{"agy"},
			CleanupHomeFiles: []string{".local/bin/agy"},
			CollectPathEntries: func(opts Options) []string {
				if home := ResolveHostHome(opts); home != "" {
					return []string{joinPlatformPath(resolvePlatform(opts), home, ".local", "bin")}
				}
				return nil
			},
			ResolveInstallPlans: func(opts Options) []LifecyclePlan {
				if resolvePlatform(opts) == platformWindows {
					return filterValidPlans([]LifecyclePlan{
						buildPowerShellScriptPlan("agy_windows_official", "Antigravity CLI 官方 Windows PowerShell 安装器", "https://antigravity.google/cli/install.ps1", []string{"antigravity.google"}, opts),
						buildCmdScriptPlan("agy_windows_cmd_official", "Antigravity CLI 官方 Windows CMD 安装器", "https://antigravity.google/cli/install.cmd", []string{"antigravity.google"}),
					})
				}
				return filterValidPlans([]LifecyclePlan{buildPosixScriptPlan("agy_posix_official", "Antigravity CLI 官方 macOS/Linux 安装器", "https://antigravity.google/cli/install.sh", []string{"antigravity.google"}, nil)})
			},
		},
		Desktop: map[string]*desktopPlatformDescriptor{
			platformMacOS: {
				CleanupHomeTrees: []string{"Applications/Antigravity.app"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					return []LifecyclePlan{buildShellPlan("agy_desktop_official_page", "Antigravity 官方桌面下载页安装器", buildAgyPosixScript())}
				},
			},
			platformWindows: {
				WindowsDisplayNames: []string{"Antigravity"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					script := strings.Join([]string{
						`$page = (Invoke-WebRequest -Uri 'https://antigravity.google/download' -UseBasicParsing).Content`,
						`$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm' } else { 'x64' }`,
						`$pattern = 'https://storage\.googleapis\.com/antigravity-public/[^\"'' ]+/windows-' + $arch + '/Antigravity-[^\"'' ]+\.exe'`,
						`$url = [regex]::Matches($page, $pattern) | Select-Object -First 1 | ForEach-Object { $_.Value }`,
						`if (-not $url -or $url -notlike 'https://storage.googleapis.com/antigravity-public/*') { throw '未从官方页面解析到 Antigravity Windows 下载地址' }`,
						`$dest = Join-Path $env:TEMP ('antigravity-' + [guid]::NewGuid().ToString('n') + '.exe')`,
						`try { ` + buildWindowsDownloadStatements("", "$url", "Antigravity 安装器") + `; ` + buildWindowsExecutableLaunchStatements(windowsNsisSilent) + ` } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }`,
					}, "; ")
					return []LifecyclePlan{buildPowerShellPlan("agy_desktop_official_page", "Antigravity 官方桌面安装器", script, opts)}
				},
			},
			platformLinux: {
				CleanupHomeFiles: []string{".local/bin/agy"},
				CleanupHomeTrees: []string{".local/opt/antigravity"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					return []LifecyclePlan{buildShellPlan("agy_desktop_official_page", "Antigravity 官方桌面下载页安装器", buildAgyPosixScript())}
				},
			},
		},
	})

	add(&providerInstallerSpec{
		Provider: "zcode",
		CLI: &cliDescriptor{
			BinaryNames:        []string{"zcode", "zcode.cjs"},
			CollectPathEntries: collectZcodeBundledCliPathEntries,
			// ZCode CLI 随 Desktop 安装分发，没有独立安装计划。
		},
		Desktop: map[string]*desktopPlatformDescriptor{
			platformMacOS: {
				CleanupHomeTrees: []string{"Applications/ZCode.app"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					script := strings.Join([]string{
						`page="$(curl --compressed -fsSL "https://zcode.z.ai/en/docs/install")"`,
						`arch="$(uname -m)"; if [ "$arch" = "arm64" ]; then target="macos-arm64"; else target="macos-x64"; fi`,
						`url="$(printf "%s" "$page" | grep -Eo "https://cdn-zcode.z.ai/zcode/electron/releases/[^\" ]+/$target/ZCode-[^\" ]+-(mac|darwin)-[^\" ]+\.dmg" | head -n1)"`,
						`case "$url" in https://cdn-zcode.z.ai/*) ;; *) echo "未从 ZCode 官方页面解析到 macOS 安装器" >&2; exit 1;; esac`,
						`tmp="$(mktemp -t zcode).dmg"; mount="$(mktemp -d -t zcode-mount)"; cleanup() { hdiutil detach "$mount" -force >/dev/null 2>&1 || true; rm -rf "$mount" "$tmp"; }; trap cleanup EXIT`,
						`curl -fsSL "$url" -o "$tmp"; hdiutil attach "$tmp" -nobrowse -readonly -mountpoint "$mount" >/dev/null; app="$(find "$mount" -maxdepth 1 -type d -name "ZCode.app" -print -quit)"; if [ -z "$app" ]; then app="$(find "$mount" -maxdepth 1 -type d -name "*.app" -print -quit)"; fi; if [ -z "$app" ]; then echo "ZCode.app not found" >&2; exit 1; fi; mkdir -p "$HOME/Applications"; installed="$HOME/Applications/$(basename "$app")"; ditto "$app" "$installed"; echo "` + installedPathMarker + `$installed"`,
					}, "; ")
					return []LifecyclePlan{buildShellPlan("zcode_desktop_macos_official_page", "ZCode 官方 macOS Desktop 下载器", script)}
				},
			},
			platformWindows: {
				WindowsDisplayNames: []string{"ZCode"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					script := strings.Join([]string{
						`$page = (Invoke-WebRequest -Uri 'https://zcode.z.ai/en/docs/install' -UseBasicParsing).Content`,
						`$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }`,
						`$pattern = 'https://cdn-zcode.z.ai/zcode/electron/releases/[^\"'' ]+/windows-' + $arch + '/ZCode-[^\"'' ]+-win-' + $arch + '\.exe'`,
						`$url = [regex]::Matches($page, $pattern) | Select-Object -First 1 | ForEach-Object { $_.Value }`,
						`if (-not $url -or $url -notlike 'https://cdn-zcode.z.ai/*') { throw '未从 ZCode 官方页面解析到 Windows 安装器' }`,
						`$dest = Join-Path $env:TEMP ('zcode-' + [guid]::NewGuid().ToString('n') + '.exe')`,
						`try { ` + buildWindowsDownloadStatements("", "$url", "ZCode 安装器") + `; ` + buildWindowsExecutableLaunchStatements(windowsNsisSilent) + ` } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }`,
					}, "; ")
					return []LifecyclePlan{buildPowerShellPlan("zcode_desktop_windows_official_page", "ZCode 官方 Windows Desktop 安装器", script, opts)}
				},
			},
			platformLinux: {
				CleanupHomeFiles: []string{".local/bin/zcode"},
				CleanupHomeTrees: []string{".local/opt/zcode"},
				ResolveInstallPlans: func(opts Options) []LifecyclePlan {
					if !isArchSupported(opts, "x64") {
						return nil
					}
					script := strings.Join([]string{
						`page="$(curl --compressed -fsSL "https://zcode.z.ai/en/docs/install")"`,
						`arch="$(uname -m)"; case "$arch" in x86_64|amd64) target="linux-x64" ;; *) echo "ZCode Linux Desktop 官方仅支持 x64" >&2; exit 1 ;; esac`,
						`url="$(printf "%s" "$page" | grep -Eo "https://cdn-zcode.z.ai/zcode/electron/releases/[^\" ]+/$target/ZCode-[^\" ]+\.AppImage" | head -n1)"`,
						`case "$url" in https://cdn-zcode.z.ai/*) ;; *) echo "未从 ZCode 官方页面解析到 Linux AppImage" >&2; exit 1;; esac`,
						`root="$HOME/.local/opt/zcode"; file="$root/ZCode.AppImage"; mkdir -p "$root" "$HOME/.local/bin"; curl -fsSL "$url" -o "$file"; chmod +x "$file"; ln -sf "$file" "$HOME/.local/bin/zcode"`,
					}, "; ")
					return []LifecyclePlan{buildShellPlan("zcode_desktop_linux_official_page", "ZCode 官方 Linux AppImage 安装器", script)}
				},
			},
		},
	})

	// IDE 安装器从 ideClientSpecs 自动派生。
	for _, spec := range ideClientSpecs {
		ide := spec
		add(&providerInstallerSpec{
			Provider:  ide.ID,
			IDEClient: ide,
			Desktop: map[string]*desktopPlatformDescriptor{
				platformMacOS:   {Cask: ide.Cask},
				platformWindows: {WingetID: ide.WingetID, WindowsDisplayNames: ide.WindowsDisplayNames},
				platformLinux: {
					LinuxPackages: []string{ide.LinuxRepo.PackageName},
					ResolveInstallPlans: func(Options) []LifecyclePlan {
						return []LifecyclePlan{buildLinuxRepoPlan(ide.ID, ide.Name, "install", ide.LinuxRepo)}
					},
					ResolveUpdatePlans: func(Options) []LifecyclePlan {
						return []LifecyclePlan{buildLinuxRepoPlan(ide.ID, ide.Name, "update", ide.LinuxRepo)}
					},
					ResolveUninstallPlans: func(Options) []LifecyclePlan {
						return []LifecyclePlan{buildLinuxRepoPlan(ide.ID, ide.Name, "uninstall", ide.LinuxRepo)}
					},
				},
			},
		})
	}

	return reg
}

func buildAgyPosixScript() string {
	return strings.Join([]string{
		`page="$(curl --compressed -fsSL "https://antigravity.google/download")"`,
		`arch="$(uname -m)"`,
		`if [ "$(uname -s)" = "Darwin" ]; then`,
		`  if [ "$arch" = "arm64" ]; then pattern="darwin-arm/Antigravity\.dmg"; else pattern="darwin-x64/Antigravity\.dmg"; fi`,
		`  url="$(printf "%s" "$page" | grep -Eo "https://storage\.googleapis\.com/antigravity-public/[^\" ]+/$pattern" | head -n1)"`,
		`  case "$url" in https://storage.googleapis.com/antigravity-public/*) ;; *) echo "未从官方页面解析到 Antigravity macOS 下载地址" >&2; exit 1;; esac`,
		`  tmp="$(mktemp -t antigravity).dmg"; mount="$(mktemp -d -t antigravity-mount)"`,
		`  cleanup() { hdiutil detach "$mount" -force >/dev/null 2>&1 || true; rm -rf "$mount" "$tmp"; }; trap cleanup EXIT`,
		`  curl -fsSL "$url" -o "$tmp"; hdiutil attach "$tmp" -nobrowse -readonly -mountpoint "$mount" >/dev/null`,
		`  app="$(find "$mount" -maxdepth 1 -type d -name "Antigravity.app" -print -quit)"; if [ -z "$app" ]; then echo "Antigravity.app not found" >&2; exit 1; fi`,
		`  mkdir -p "$HOME/Applications"; installed="$HOME/Applications/Antigravity.app"; ditto "$app" "$installed"; echo "` + installedPathMarker + `$installed"`,
		`else`,
		`  if [ "$arch" = "aarch64" ] || [ "$arch" = "arm64" ]; then pattern="linux-arm/Antigravity\.tar\.gz"; else pattern="linux-x64/Antigravity\.tar\.gz"; fi`,
		`  url="$(printf "%s" "$page" | grep -Eo "https://storage\.googleapis\.com/antigravity-public/[^\" ]+/$pattern" | head -n1)"`,
		`  case "$url" in https://storage.googleapis.com/antigravity-public/*) ;; *) echo "未从官方页面解析到 Antigravity Linux 下载地址" >&2; exit 1;; esac`,
		`  root="$HOME/.local/opt/antigravity"; tmp="$(mktemp --suffix=.tar.gz antigravity.XXXXXX)"; trap 'rm -f "$tmp"' EXIT`,
		`  mkdir -p "$root" "$HOME/.local/bin"; curl -fsSL "$url" -o "$tmp"; tar -xzf "$tmp" -C "$root"`,
		`  candidate="$(find "$root" -type f \( -name agy -o -name antigravity \) -perm -u+x -print -quit)"; if [ -n "$candidate" ]; then ln -sf "$candidate" "$HOME/.local/bin/agy"; fi`,
		`fi`,
	}, "\n")
}

func collectCommonPOSIXAndBinDirs(opts Options, relDirs ...string) []string {
	home := ResolveHostHome(opts)
	if home == "" {
		return nil
	}
	p := resolvePlatform(opts)
	var out []string
	for _, rel := range relDirs {
		out = append(out, joinPlatformPath(p, home, rel))
	}
	if p != platformWindows {
		if opts.NodeExecPath != "" {
			out = append(out, dirPlatformPath(p, opts.NodeExecPath))
		}
		out = append(out, "/opt/homebrew/bin", "/usr/local/bin")
	} else {
		out = append(out, joinPlatformPath(p, home, "AppData", "Roaming", "npm"))
	}
	return uniqueStrings(out)
}

func collectQoderPathEntries(opts Options, dotDir, binSubDir, progDir string) []string {
	home := ResolveHostHome(opts)
	if home == "" {
		return nil
	}
	p := resolvePlatform(opts)
	entries := []string{
		joinPlatformPath(p, home, ".local", "bin"),
		joinPlatformPath(p, home, dotDir, "bin", binSubDir),
		joinPlatformPath(p, home, dotDir, "bin"),
	}
	if p == platformWindows {
		env := resolveEnvMap(opts)
		localAppData := nonEmpty(envLookup(env, "LOCALAPPDATA"), joinPlatformPath(p, home, "AppData", "Local"))
		progFiles := nonEmpty(envLookup(env, "ProgramFiles"), `C:\Program Files`)
		entries = append(entries,
			joinPlatformPath(p, localAppData, binSubDir),
			joinPlatformPath(p, localAppData, "QoderCli"),
			joinPlatformPath(p, localAppData, "Programs", progDir),
			joinPlatformPath(p, progFiles, progDir, "bin"),
			joinPlatformPath(p, home, "AppData", "Roaming", "npm"),
		)
	} else {
		entries = append(entries, "/usr/local/bin", "/opt/homebrew/bin")
	}
	return uniqueStrings(entries)
}

func collectBundledCodeBuddyCliPathEntries(opts Options) []string {
	if resolvePlatform(opts) != platformMacOS {
		return nil
	}
	bundles := []string{"/Applications/WorkBuddy.app"}
	if home := ResolveHostHome(opts); home != "" {
		bundles = append(bundles, joinPlatformPath(platformMacOS, home, "Applications", "WorkBuddy.app"))
	}
	for _, bundle := range bundles {
		cliRoot := joinPlatformPath(platformMacOS, bundle, "Contents", "Resources", "app.asar.unpacked", "cli")
		if fileExists(joinPlatformPath(platformMacOS, cliRoot, "dist", "codebuddy")) ||
			fileExists(joinPlatformPath(platformMacOS, cliRoot, "dist", "codebuddy-headless")) {
			return []string{joinPlatformPath(platformMacOS, cliRoot, "bin")}
		}
	}
	return nil
}

func collectZcodeBundledCliPathEntries(opts Options) []string {
	if resolvePlatform(opts) != platformMacOS {
		return nil
	}
	bundles := []string{"/Applications/ZCode.app"}
	if home := ResolveHostHome(opts); home != "" {
		bundles = append(bundles, joinPlatformPath(platformMacOS, home, "Applications", "ZCode.app"))
	}
	for _, bundle := range bundles {
		cjs := joinPlatformPath(platformMacOS, bundle, "Contents", "Resources", "glm", "zcode.cjs")
		if fileExists(cjs) {
			return []string{joinPlatformPath(platformMacOS, bundle, "Contents", "Resources", "glm")}
		}
	}
	return nil
}

// ResolveDesktopInstallPlans 返回桌面端 / IDE 在当前平台与架构下的安装计划。
func ResolveDesktopInstallPlans(provider string, opts Options) []LifecyclePlan {
	spec := getInstaller(provider)
	if spec == nil || spec.Desktop == nil {
		return nil
	}
	desc := spec.Desktop[resolvePlatform(opts)]
	if desc == nil {
		return nil
	}
	if desc.ResolveInstallPlans != nil {
		return filterValidPlans(desc.ResolveInstallPlans(opts))
	}
	var plans []LifecyclePlan
	if desc.Cask != "" {
		plans = append(plans, buildCaskPlan(desc.Cask, "Homebrew 安装 "+spec.Provider+" Desktop"))
	}
	if desc.WingetID != "" {
		plans = append(plans, buildWingetPlan(desc.WingetID, "winget 安装 "+spec.Provider+" Desktop", desc.WingetSource))
	}
	return filterValidPlans(plans)
}

// HasDesktopInstallPlan 返回桌面端或 IDE 是否存在自动安装计划。
func HasDesktopInstallPlan(provider string, opts Options) bool {
	return len(ResolveDesktopInstallPlans(provider, opts)) > 0
}

// ResolveDesktopVersionSource 返回桌面端远程版本源（用于 check-update）。
func ResolveDesktopVersionSource(provider string, opts Options) *VersionSource {
	spec := getInstaller(provider)
	if spec == nil || spec.Desktop == nil {
		return nil
	}
	desc := spec.Desktop[resolvePlatform(opts)]
	if desc == nil {
		return nil
	}
	if desc.ExplicitVersionSource != nil {
		return normalizeVersionSource(desc.ExplicitVersionSource)
	}
	for _, plan := range ResolveDesktopInstallPlans(provider, opts) {
		if src := inferVersionSourceFromPlan(plan); src != nil {
			return src
		}
	}
	return nil
}

// ResolveCLIVersionSource 返回 CLI 远程版本源。
func ResolveCLIVersionSource(provider, pkg string, opts Options) *VersionSource {
	spec := getInstaller(provider)
	if spec != nil && spec.CLI != nil {
		if spec.CLI.ExplicitVersionSource != nil {
			return normalizeVersionSource(spec.CLI.ExplicitVersionSource)
		}
		if src := normalizeVersionSource(&VersionSource{Type: "npm", PackageName: nonEmpty(pkg, spec.CLI.Pkg)}); src != nil {
			return src
		}
		if spec.CLI.ResolveInstallPlans != nil {
			for _, plan := range spec.CLI.ResolveInstallPlans(opts) {
				if src := inferVersionSourceFromPlan(plan); src != nil {
					return src
				}
			}
		}
	}
	if src := normalizeVersionSource(&VersionSource{Type: "npm", PackageName: pkg}); src != nil {
		return src
	}
	return nil
}

// ResolveLifecyclePlans 返回给定 provider / kind / action 的可执行生命周期计划。
func ResolveLifecyclePlans(provider, kind, action string, opts Options, installedPath string, installedRecord *DesktopRecord) []LifecyclePlan {
	normProvider := strings.ToLower(strings.TrimSpace(provider))
	normKind := strings.ToLower(strings.TrimSpace(kind))
	normAction := strings.ToLower(strings.TrimSpace(action))
	spec := getInstaller(normProvider)
	if spec == nil {
		return nil
	}

	if normKind == "desktop" {
		if spec.Desktop == nil {
			return nil
		}
		p := resolvePlatform(opts)
		desc := spec.Desktop[p]
		if desc == nil {
			return nil
		}
		if normAction == "install" {
			return ResolveDesktopInstallPlans(normProvider, opts)
		}
		installPlans := ResolveDesktopInstallPlans(normProvider, opts)
		var explicit []LifecyclePlan
		if normAction == "update" && desc.ResolveUpdatePlans != nil {
			explicit = desc.ResolveUpdatePlans(opts)
		} else if normAction == "uninstall" && desc.ResolveUninstallPlans != nil {
			explicit = desc.ResolveUninstallPlans(opts)
		}
		var inferred []LifecyclePlan
		if desc.Cask != "" {
			if normAction == "update" {
				inferred = append(inferred, buildCaskUpdatePlan(desc.Cask, "Homebrew 更新 "+normProvider+" Desktop"))
			} else if normAction == "uninstall" {
				inferred = append(inferred, buildCaskUninstallPlan(desc.Cask, "Homebrew 卸载 "+normProvider+" Desktop"))
			}
		}
		if desc.WingetID != "" {
			if normAction == "update" {
				inferred = append(inferred, buildWingetUpdatePlan(desc.WingetID, "winget 更新 "+normProvider+" Desktop", desc.WingetSource))
			} else if normAction == "uninstall" {
				inferred = append(inferred, buildWingetUninstallPlan(desc.WingetID, "winget 卸载 "+normProvider+" Desktop"))
			}
		}
		inferred = append(inferred, inferLifecyclePlansFromInstallPlans(normAction, installPlans, opts)...)
		if normAction == "update" {
			combined := uniquePlans(append(explicit, inferred...))
			if len(combined) > 0 {
				return combined
			}
			return installPlans
		}
		if normAction == "uninstall" {
			inferred = append(inferred, buildDesktopFallbackPlans(normProvider, desc, opts, installedRecord)...)
			return uniquePlans(append(explicit, inferred...))
		}
		return nil
	}

	if !resolveInstalledAppNames(spec) {
		return nil
	}
	var installPlans []LifecyclePlan
	if spec.CLI.ResolveInstallPlans != nil {
		installPlans = filterValidPlans(spec.CLI.ResolveInstallPlans(opts))
	}
	if normAction == "install" {
		return installPlans
	}
	var explicit []LifecyclePlan
	if normAction == "update" && spec.CLI.ResolveUpdatePlans != nil {
		explicit = spec.CLI.ResolveUpdatePlans(opts)
	} else if normAction == "uninstall" && spec.CLI.ResolveUninstallPlans != nil {
		explicit = spec.CLI.ResolveUninstallPlans(opts)
	}
	inferred := inferLifecyclePlansFromInstallPlans(normAction, installPlans, opts)
	if normAction == "update" {
		combined := uniquePlans(append(explicit, inferred...))
		if len(combined) > 0 {
			return combined
		}
		return installPlans
	}
	if normAction == "uninstall" {
		cleanup := buildCLIPathCleanupPlan(normProvider, spec.CLI, opts, installedPath)
		combined := append(explicit, inferred...)
		if cleanup.Command != "" {
			combined = append(combined, cleanup)
		}
		return uniquePlans(combined)
	}
	return nil
}

func buildCLIPathCleanupPlan(provider string, cli *cliDescriptor, opts Options, installedPath string) LifecyclePlan {
	p := resolvePlatform(opts)
	home := ResolveHostHome(opts)
	var files, trees []string
	if strings.TrimSpace(installedPath) != "" {
		files = append(files, strings.TrimSpace(installedPath))
	}
	if cli.CollectPathEntries != nil {
		for _, entry := range cli.CollectPathEntries(opts) {
			trimmed := strings.TrimSpace(entry)
			if trimmed == "" {
				continue
			}
			base := strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(basePlatformPath(p, trimmed), ".cmd"), ".exe"), ".ps1")
			matchedSelf := false
			for _, name := range cli.BinaryNames {
				if strings.EqualFold(name, base) {
					matchedSelf = true
					break
				}
			}
			if matchedSelf {
				files = append(files, trimmed)
				continue
			}
			for _, name := range cli.BinaryNames {
				files = append(files, joinPlatformPath(p, trimmed, name))
				if p == platformWindows {
					files = append(files,
						joinPlatformPath(p, trimmed, name+".exe"),
						joinPlatformPath(p, trimmed, name+".cmd"),
						joinPlatformPath(p, trimmed, name+".ps1"),
					)
				}
			}
		}
	}
	files = append(files, cli.CleanupFiles...)
	trees = append(trees, cli.CleanupTrees...)
	if home != "" {
		for _, rel := range cli.CleanupHomeFiles {
			files = append(files, joinPlatformPath(p, home, rel))
		}
		for _, rel := range cli.CleanupHomeTrees {
			trees = append(trees, joinPlatformPath(p, home, rel))
		}
	}
	return buildManagedPathCleanupPlan(provider+"_managed_cli_uninstall", "移除 "+provider+" CLI 程序文件", files, trees, opts)
}

func buildDesktopFallbackPlans(provider string, desc *desktopPlatformDescriptor, opts Options, record *DesktopRecord) []LifecyclePlan {
	p := resolvePlatform(opts)
	home := ResolveHostHome(opts)
	var plans []LifecyclePlan
	if p == platformWindows && len(desc.WindowsDisplayNames) > 0 {
		if plan := buildWindowsRegistryUninstallPlan(desc.WindowsDisplayNames, "卸载 "+provider+" Desktop", opts); plan.Command != "" {
			plans = append(plans, plan)
		}
	}
	if p == platformLinux && len(desc.LinuxPackages) > 0 {
		if plan := buildLinuxPackageUninstallPlan(desc.LinuxPackages, "卸载 "+provider+" Desktop"); plan.Command != "" {
			plans = append(plans, plan)
		}
	}
	var files, trees []string
	files = append(files, desc.CleanupFiles...)
	trees = append(trees, desc.CleanupTrees...)
	if home != "" {
		for _, rel := range desc.CleanupHomeFiles {
			files = append(files, joinPlatformPath(p, home, rel))
		}
		for _, rel := range desc.CleanupHomeTrees {
			trees = append(trees, joinPlatformPath(p, home, rel))
		}
	}
	if record != nil {
		disp := nonEmpty(record.BundlePath, record.DisplayPath)
		if disp != "" {
			if strings.HasSuffix(strings.ToLower(disp), ".app") {
				trees = append(trees, disp)
			} else if disp == record.ExecutablePath || record.ExecutablePath == "" {
				files = append(files, disp)
			}
		}
		if record.ExecutablePath != "" && p != platformWindows {
			files = append(files, record.ExecutablePath)
		}
	}
	if cleanup := buildManagedPathCleanupPlan(provider+"_managed_desktop_uninstall", "移除 "+provider+" Desktop 程序文件", files, trees, opts); cleanup.Command != "" {
		plans = append(plans, cleanup)
	}
	return plans
}

// BuildDesktopInstallHint 在当前平台无自动安装计划时提供明确手动安装提示。
func BuildDesktopInstallHint(provider string, opts Options) string {
	norm := strings.ToLower(strings.TrimSpace(provider))
	spec := getInstaller(norm)
	if spec != nil && spec.Desktop != nil {
		if desc := spec.Desktop[resolvePlatform(opts)]; desc != nil {
			if desc.Cask != "" {
				return fmt.Sprintf("请先安装 Homebrew，然后执行 brew install --cask %s。", desc.Cask)
			}
			if desc.WingetID != "" {
				return fmt.Sprintf("请先安装 winget，然后执行 winget install --id %s --exact。", desc.WingetID)
			}
			if desc.Hint != "" {
				return desc.Hint
			}
		}
	}
	return fmt.Sprintf("当前平台没有 %s Desktop 的无交互安装器，请手动安装官方应用后重试。", norm)
}
