package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	goruntime "runtime"
	"strings"

	"golang.org/x/term"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/terminalicon"
)

// terminalIconOptions 是 aih <cli> terminal-icon 的开关集合（与 Node 同名）。
type terminalIconOptions struct {
	all            bool
	json           bool
	install        bool
	printFragment  bool
	installWindows bool
	printIterm2    bool
	installIterm2  bool
	installLinux   bool
	help           bool
}

// runProviderTerminalIcon 安装/打印终端 Profile 图标；图标来自内嵌资产，
// Profile GUID 与 Node 完全一致，两个实现可以互相覆盖同一份配置。
func runProviderTerminalIcon(
	_ context.Context,
	providerID string,
	arguments []string,
	runtime commandRuntime,
) error {
	options, unknown := parseTerminalIconOptions(arguments)
	if len(unknown) > 0 {
		return fmt.Errorf("%w: Unknown terminal-icon arg: %s", errInvalidCommand, unknown[0])
	}
	if options.help {
		writeTerminalIconUsage(runtime.stdout, providerID)
		return nil
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return fmt.Errorf("创建 Provider Catalog 失败: %w", err)
	}
	registry := terminalicon.NewRegistry(catalog)
	items := []terminalicon.Provider{}
	if options.all {
		items = registry.List()
	} else {
		provider, ok := registry.Get(providerID)
		if !ok {
			return fmt.Errorf("%w: Unknown provider: %s", errInvalidCommand, providerID)
		}
		items = []terminalicon.Provider{provider}
	}
	if len(items) == 0 {
		return fmt.Errorf("%w: No providers selected", errInvalidCommand)
	}
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	hostHomeDir := lookupOrDefault(runtime.lookupEnv, "AIH_HOST_HOME", "")
	if hostHomeDir == "" {
		hostHomeDir, err = runtime.userHomeDir()
		if err != nil {
			return err
		}
	}
	layout := terminalicon.Layout{
		AIHomeDir:   aiHomeDir,
		HostHomeDir: hostHomeDir,
		Env:         environmentMap(runtime),
		Platform:    goruntime.GOOS,
		AIHCommand:  "aih",
	}
	switch {
	case options.printIterm2:
		paths, buildErr := terminalicon.MaterializeIcons(items, aiHomeDir)
		if buildErr != nil {
			return buildErr
		}
		profiles, buildErr := terminalicon.BuildIterm2Profiles(
			items,
			layout.AIHCommand,
			terminalicon.IconPathFunc(paths),
		)
		if buildErr != nil {
			return buildErr
		}
		return writeJSONDocument(runtime.stdout, profiles)
	case options.printFragment:
		paths, buildErr := terminalicon.MaterializeIcons(items, aiHomeDir)
		if buildErr != nil {
			return buildErr
		}
		fragment, buildErr := terminalicon.BuildWindowsTerminalFragment(
			items,
			layout.AIHCommand,
			"",
			terminalicon.IconPathFunc(paths),
		)
		if buildErr != nil {
			return buildErr
		}
		return writeJSONDocument(runtime.stdout, fragment)
	case options.installIterm2:
		return installIterm2(runtime.stdout, items, layout, options.json)
	case options.installLinux:
		return installLinux(runtime.stdout, items, layout, options.json)
	case options.installWindows:
		return installWindowsTerminal(runtime.stdout, items, layout, options.json)
	case options.install:
		switch detectTerminalIconTarget(environmentMap(runtime), goruntime.GOOS) {
		case "warp":
			return installWarp(runtime.stdout, items, layout, options.json)
		case "windows-terminal":
			return installWindowsTerminal(runtime.stdout, items, layout, options.json)
		case "linux":
			return installLinux(runtime.stdout, items, layout, options.json)
		default:
			return installIterm2(runtime.stdout, items, layout, options.json)
		}
	}
	// 默认形态：只打印每个 Provider 的图标路径，提示如何安装。
	paths, err := terminalicon.MaterializeIcons(items, aiHomeDir)
	if err != nil {
		return err
	}
	if options.json {
		return writeJSONDocument(runtime.stdout, map[string]any{"ok": true, "icons": paths})
	}
	for _, provider := range items {
		_, _ = fmt.Fprintf(
			runtime.stdout,
			"%s: %s\n",
			provider.Label,
			paths[provider.ID],
		)
	}
	_, _ = fmt.Fprintln(
		runtime.stdout,
		"Run with --install for this OS, or use --install-windows-terminal / --install-iterm2 / --install-linux explicitly.",
	)
	return nil
}

// prepareFamilyTerminalIcon 在交互式启动前切到该 Provider 的终端 Profile/标题。
// 只在 stdout 是 TTY 时执行：管道/脚本里的 OSC 序列没有意义。
func prepareFamilyTerminalIcon(runtime commandRuntime, providerID string) {
	if !terminalWriterIsTTY(runtime.stdout) {
		return
	}
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return
	}
	hostHomeDir := lookupOrDefault(runtime.lookupEnv, "AIH_HOST_HOME", "")
	if hostHomeDir == "" {
		hostHomeDir, err = runtime.userHomeDir()
		if err != nil {
			return
		}
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return
	}
	provider, ok := terminalicon.NewRegistry(catalog).Get(providerID)
	if !ok {
		return
	}
	terminalicon.PrepareForLaunch(provider, terminalicon.Layout{
		AIHomeDir:   aiHomeDir,
		HostHomeDir: hostHomeDir,
		Env:         environmentMap(runtime),
		Platform:    goruntime.GOOS,
		AIHCommand:  "aih",
	}, runtime.stdout)
}

// terminalWriterIsTTY 判断输出是否是真实终端。
func terminalWriterIsTTY(output io.Writer) bool {
	file, ok := output.(*os.File)
	if !ok || file == nil {
		return false
	}
	return term.IsTerminal(int(file.Fd()))
}

// parseTerminalIconOptions 与 Node parseTerminalIconArgs 同旗标。
func parseTerminalIconOptions(arguments []string) (terminalIconOptions, []string) {
	options := terminalIconOptions{}
	unknown := make([]string, 0)
	for _, argument := range arguments {
		switch strings.TrimSpace(argument) {
		case "":
		case "--all":
			options.all = true
		case "--json":
			options.json = true
		case "--install":
			options.install = true
		case "--windows-terminal-fragment":
			options.printFragment = true
		case "--install-windows-terminal":
			options.installWindows = true
		case "--iterm2-dynamic-profile":
			options.printIterm2 = true
		case "--install-iterm2":
			options.installIterm2 = true
		case "--install-linux":
			options.installLinux = true
		case "--help", "-h", "help":
			options.help = true
		default:
			unknown = append(unknown, strings.TrimSpace(argument))
		}
	}
	return options, unknown
}

// detectTerminalIconTarget 与 Node detectTerminalIconStrategy 的安装目标一致：
// Warp 优先（写 settings.toml），其余按平台默认。
func detectTerminalIconTarget(env map[string]string, platform string) string {
	termProgram := strings.ToLower(strings.TrimSpace(env["TERM_PROGRAM"]))
	if termProgram == "warpterminal" || termProgram == "warp" ||
		strings.TrimSpace(env["WARP_IS_LOCAL_SHELL_SESSION"]) != "" ||
		strings.TrimSpace(env["WARP_SESSION_ID"]) != "" {
		return "warp"
	}
	switch platform {
	case "darwin":
		return "iterm2"
	case "linux":
		return "linux"
	default:
		return "windows-terminal"
	}
}

func installIterm2(output io.Writer, items []terminalicon.Provider, layout terminalicon.Layout, asJSON bool) error {
	path, profiles, err := terminalicon.WriteIterm2Profiles(items, layout)
	if err != nil {
		return fmt.Errorf("failed to install iTerm2 provider icons: %w", err)
	}
	if asJSON {
		return writeJSONDocument(output, map[string]any{"ok": true, "path": path, "profiles": profiles.Profiles})
	}
	_, _ = fmt.Fprintf(output, "[aih] iTerm2 provider icon dynamic profiles written: %s\n", path)
	_, _ = fmt.Fprintln(output, "Switch to an AIH iTerm2 profile, or run aih from iTerm2 and AIH will switch the session profile automatically.")
	return nil
}

func installLinux(output io.Writer, items []terminalicon.Provider, layout terminalicon.Layout, asJSON bool) error {
	dataHome, entries, err := terminalicon.WriteLinuxFiles(items, layout)
	if err != nil {
		return fmt.Errorf("failed to install Linux provider icons: %w", err)
	}
	if asJSON {
		return writeJSONDocument(output, map[string]any{"ok": true, "linux": map[string]any{"xdgDataHome": dataHome, "entries": entries}})
	}
	_, _ = fmt.Fprintf(output, "[aih] Linux terminal provider icons written under: %s\n", dataHome)
	_, _ = fmt.Fprintln(output, "This installs XDG app icons/desktop entries and Konsole profiles using real provider PNG icons.")
	return nil
}

func installWindowsTerminal(output io.Writer, items []terminalicon.Provider, layout terminalicon.Layout, asJSON bool) error {
	result, err := terminalicon.WriteWindowsTerminalFragment(items, layout)
	if err != nil {
		return fmt.Errorf("failed to install Windows Terminal provider icons: %w", err)
	}
	if asJSON {
		return writeJSONDocument(output, map[string]any{"ok": true, "path": result.Path, "fragment": result.Fragment})
	}
	_, _ = fmt.Fprintf(output, "[aih] Windows Terminal provider icon profiles written: %s\n", result.Path)
	_, _ = fmt.Fprintln(output, "Open a new Windows Terminal tab with an AIH profile to see the provider icon.")
	return nil
}

func installWarp(output io.Writer, items []terminalicon.Provider, layout terminalicon.Layout, asJSON bool) error {
	path, entries, changed, err := terminalicon.WriteWarpSettings(items, layout)
	if err != nil {
		return fmt.Errorf("failed to install Warp CLI-agent mappings: %w", err)
	}
	if asJSON {
		return writeJSONDocument(output, map[string]any{"ok": true, "path": path, "entries": entries, "changed": changed})
	}
	_, _ = fmt.Fprintf(output, "[aih] Warp CLI-agent command mappings written: %s\n", path)
	_, _ = fmt.Fprintln(output, "Open a new Warp tab after settings reload; aih provider commands will be classified as their native CLI agents.")
	return nil
}

// writeJSONDocument 输出缩进 JSON（Node 用 2 空格）。
func writeJSONDocument(output io.Writer, value any) error {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintln(output, string(encoded))
	return nil
}

// environmentMap 把进程环境转成查找表（只读，用于终端检测与 XDG 路径）。
func environmentMap(runtime commandRuntime) map[string]string {
	values := make(map[string]string)
	for _, name := range []string{
		"TERM_PROGRAM", "WARP_IS_LOCAL_SHELL_SESSION", "WARP_SESSION_ID",
		"XDG_DATA_HOME", "XDG_CONFIG_HOME", "LOCALAPPDATA", "USERPROFILE", "HOME",
	} {
		if value, found := runtime.lookupEnv(name); found {
			values[name] = value
		}
	}
	return values
}

func writeTerminalIconUsage(output io.Writer, providerID string) {
	_, _ = fmt.Fprintf(output, "Usage:\n  aih %s terminal-icon\n", providerID)
	_, _ = fmt.Fprintf(output, "  aih %s terminal-icon --install [--all]\n", providerID)
	_, _ = fmt.Fprintf(output, "  aih %s terminal-icon --windows-terminal-fragment [--all]\n", providerID)
	_, _ = fmt.Fprintf(output, "  aih %s terminal-icon --install-windows-terminal [--all]\n", providerID)
	_, _ = fmt.Fprintf(output, "  aih %s terminal-icon --iterm2-dynamic-profile [--all]\n", providerID)
	_, _ = fmt.Fprintf(output, "  aih %s terminal-icon --install-iterm2 [--all]\n", providerID)
	_, _ = fmt.Fprintf(output, "  aih %s terminal-icon --install-linux [--all]\n", providerID)
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "Notes:")
	_, _ = fmt.Fprintln(output, "  Real graphical tab/window icons are terminal profile settings, not OSC title text.")
	_, _ = fmt.Fprintln(output, "  Windows Terminal uses profile icons; iTerm2 uses Dynamic Profiles; Konsole uses")
	_, _ = fmt.Fprintln(output, "  profiles over DBus. Warp is repaired through its CLI-agent command mapping in settings.toml.")
}
