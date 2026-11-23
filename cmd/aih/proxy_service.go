package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/autostart"
)

const defaultProxyLabel = "com.meadeo.ai_home.proxy"

func runProxyServiceCommand(ctx context.Context, args []string, runtime commandRuntime) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		writeProxyServiceUsage(runtime)
		return nil
	}
	action := strings.TrimSpace(args[0])
	switch action {
	case "install", "uninstall", "status":
	default:
		return errors.New("用法: aih proxy service <install|uninstall|status> [options]")
	}
	options, label, err := parseProxyServiceOptions(action, args[1:], runtime)
	if err != nil {
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, resolveErr := filepath.EvalSymlinks(executable); resolveErr == nil {
		executable = resolved
	}
	home, err := resolveAIHomeDir(runtime)
	if err != nil {
		return err
	}
	hostHome, err := runtime.userHomeDir()
	if err != nil {
		return err
	}
	keyFile := options.managementKeyFile
	if keyFile == "" {
		keyFile = filepath.Join(home, "run", "proxy", "management.key")
	}
	if action == "install" {
		if _, statErr := os.Stat(keyFile); statErr != nil {
			if keyErr := writeManagementKeyFile(keyFile, readEnv(runtime.lookupEnv, "AIH_SERVER_MANAGEMENT_KEY")); keyErr != nil {
				return fmt.Errorf("无法准备 Management Key 文件: %w", keyErr)
			}
		}
	}
	serviceArgs := []string{"proxy", "serve", "--selector", options.selector, "--management-key-file", keyFile}
	if options.server != "" {
		serviceArgs = append(serviceArgs, "--server", options.server)
	}
	if options.ssh != "" {
		serviceArgs = append(serviceArgs, "--ssh", options.ssh, "--ssh-remote-address", options.sshRemote, "--listen", options.listen)
		if options.sshVia != "" {
			serviceArgs = append(serviceArgs, "--ssh-via", options.sshVia)
		}
	}
	if options.noSocks {
		serviceArgs = append(serviceArgs, "--no-socks")
	}
	if options.system {
		serviceArgs = append(serviceArgs, "--system")
		if options.systemService != "" {
			serviceArgs = append(serviceArgs, "--system-service", options.systemService)
		}
		if options.systemForce {
			serviceArgs = append(serviceArgs, "--system-force")
		}
	}
	if options.tun {
		serviceArgs = append(serviceArgs, "--tun", "--tun-stack", options.tunStack, "--tun-dns", options.tunDNS, "--tun-mtu", fmt.Sprint(options.tunMTU))
		if options.tunInterface != "" {
			serviceArgs = append(serviceArgs, "--tun-interface", options.tunInterface)
		}
		if options.tunNoAutoRoute {
			serviceArgs = append(serviceArgs, "--tun-no-auto-route")
		}
		if options.tunStrictRoute {
			serviceArgs = append(serviceArgs, "--tun-strict-route")
		}
	}
	serviceOptions := autostart.Options{
		Label:        label,
		Home:         home,
		HostHome:     hostHome,
		ServerBinary: executable,
		Args:         serviceArgs,
		Description:  "AI Home proxy service",
		WorkingDir:   filepath.Dir(executable),
		LogFile:      filepath.Join(home, "logs", "services", "proxy-serve.log"),
	}
	switch action {
	case "install":
		status, installErr := autostart.Install(ctx, serviceOptions)
		if installErr != nil {
			return installErr
		}
		writeProxyServiceStatus(runtime, status, serviceOptions.LogFile, options.json)
	case "uninstall":
		if err := autostart.Uninstall(ctx, serviceOptions); err != nil {
			return err
		}
		if options.json {
			writeProxyServiceJSON(runtime, map[string]any{"ok": true, "action": "uninstall"})
			return nil
		}
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] proxy service uninstalled")
	case "status":
		status, statusErr := autostart.StatusFor(ctx, serviceOptions)
		if statusErr != nil {
			return statusErr
		}
		writeProxyServiceStatus(runtime, status, serviceOptions.LogFile, options.json)
	}
	return nil
}

func parseProxyServiceOptions(action string, args []string, runtime commandRuntime) (proxyServeOptions, string, error) {
	options, err := parseProxyServeOptions(args)
	if err != nil {
		return options, "", err
	}
	label := strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_PROXY_SERVICE_LABEL"))
	if label == "" {
		label = defaultProxyLabel
	}
	return options, label, nil
}

func writeProxyServiceStatus(runtime commandRuntime, status autostart.Status, logFile string, jsonOutput bool) {
	if jsonOutput {
		writeProxyServiceJSON(runtime, map[string]any{
			"ok": true, "label": status.Label, "installed": status.Installed,
			"loaded": status.Loaded, "pid": status.PID, "file": status.File, "log": logFile,
		})
		return
	}
	_, _ = fmt.Fprintln(runtime.stdout, "[aih] proxy service")
	_, _ = fmt.Fprintf(runtime.stdout, "  label: %s\n", status.Label)
	_, _ = fmt.Fprintf(runtime.stdout, "  installed: %t\n", status.Installed)
	_, _ = fmt.Fprintf(runtime.stdout, "  loaded: %t\n", status.Loaded)
	_, _ = fmt.Fprintf(runtime.stdout, "  pid: %d\n", status.PID)
	_, _ = fmt.Fprintf(runtime.stdout, "  file: %s\n", status.File)
	_, _ = fmt.Fprintf(runtime.stdout, "  log: %s\n", logFile)
}

func writeProxyServiceJSON(runtime commandRuntime, payload any) {
	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return
	}
	_, _ = fmt.Fprintln(runtime.stdout, string(encoded))
}

func writeProxyServiceUsage(runtime commandRuntime) {
	_, _ = fmt.Fprintln(runtime.stdout, "用法: aih proxy service <install|uninstall|status> [--selector ...] [--server URL | --ssh <connectionId>] [--no-socks] [--system --system-service <name>] [--management-key-file <path>]")
	_, _ = fmt.Fprintln(runtime.stdout, "install 使用 launchd（macOS）、systemd --user（Linux）或 Windows 登录任务托管 aih proxy serve。")
	_, _ = fmt.Fprintln(runtime.stdout, "Management Key 默认保存到 <aiHome>/run/proxy/management.key（0600）；可用 --management-key-file 覆盖。")
	_, _ = fmt.Fprintln(runtime.stdout, "可用 AIH_PROXY_SERVICE_LABEL 覆盖服务名。")
}
