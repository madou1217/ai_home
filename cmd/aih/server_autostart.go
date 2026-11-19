package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/autostart"
)

// runServerAutostart handles the server autostart verbs in Go before the Node
// fallback. Unsupported platforms and unknown actions return handled=false so
// the legacy CLI remains the fallback for Windows and other server verbs.
func runServerAutostart(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) < 3 || (arguments[0] != "server" && arguments[0] != "daemon") || arguments[1] != "autostart" {
		return false, nil
	}
	action := strings.TrimSpace(arguments[2])
	if action != "install" && action != "uninstall" && action != "status" {
		return false, nil
	}
	options, err := resolveAutostartOptions(runtime)
	if err != nil {
		return true, err
	}
	switch action {
	case "install":
		status, err := autostart.Install(ctx, options)
		if err != nil {
			return true, err
		}
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] server autostart installed")
		writeAutostartStatus(runtime, status)
	case "uninstall":
		if err := autostart.Uninstall(ctx, options); err != nil {
			return true, err
		}
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] server autostart uninstalled")
	case "status":
		status, err := autostart.StatusFor(ctx, options)
		if err != nil {
			return true, err
		}
		writeAutostartStatus(runtime, status)
	}
	return true, nil
}

func writeAutostartStatus(runtime commandRuntime, status autostart.Status) {
	_, _ = fmt.Fprintln(runtime.stdout, "[aih] server autostart status")
	_, _ = fmt.Fprintf(runtime.stdout, "  type: %s\n", autostartType())
	_, _ = fmt.Fprintf(runtime.stdout, "  installed: %t\n", status.Installed)
	_, _ = fmt.Fprintf(runtime.stdout, "  loaded: %t\n", status.Loaded)
	_, _ = fmt.Fprintf(runtime.stdout, "  file: %s\n", status.File)
	_, _ = fmt.Fprintf(runtime.stdout, "  label: %s\n", status.Label)
}

func autostartType() string {
	switch goruntime.GOOS {
	case "darwin":
		return "launchd"
	case "windows":
		return "windows-scheduled-task"
	default:
		return "systemd"
	}
}

func resolveAutostartOptions(runtime commandRuntime) (autostart.Options, error) {
	userHome, err := runtime.userHomeDir()
	if err != nil {
		return autostart.Options{}, err
	}
	home := strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_HOME_DIR"))
	if home == "" {
		home = filepath.Join(userHome, ".ai_home")
	}
	hostHome := strings.TrimSpace(readEnv(runtime.lookupEnv, "HOME"))
	if hostHome == "" {
		hostHome = userHome
	}
	receiptExecutable, receiptRoot := readInstallReceipt(home)
	serverBinary := firstExisting(
		strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_SERVER_BINARY")),
		receiptExecutable,
		executableSibling("aih-server"),
		packagedServerSibling("aih-server"),
	)
	if serverBinary == "" {
		if resolved, lookupErr := exec.LookPath("aih-server"); lookupErr == nil {
			serverBinary = resolved
		}
	}
	if serverBinary == "" {
		return autostart.Options{}, errors.New("autostart_server_binary_not_found")
	}
	webDir := ""
	candidates := []string{
		strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_WEB_DIR")),
	}
	if receiptRoot != "" {
		candidates = append(candidates, filepath.Join(receiptRoot, "web", "dist"))
	}
	candidates = append(candidates,
		filepath.Join(filepath.Dir(serverBinary), "web", "dist"),
		filepath.Join(filepath.Dir(serverBinary), "..", "web", "dist"),
		filepath.Join(filepath.Dir(serverBinary), "..", "..", "..", "web", "dist"),
	)
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if info, statErr := os.Stat(filepath.Join(candidate, "index.html")); statErr == nil && !info.IsDir() {
			webDir = candidate
			break
		}
	}
	label := strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_AUTOSTART_LABEL"))
	if label == "" {
		label = autostart.DefaultLabel
	}
	return autostart.Options{
		Label:        label,
		Home:         home,
		HostHome:     hostHome,
		ServerBinary: serverBinary,
		WebDir:       webDir,
	}, nil
}

func readInstallReceipt(home string) (string, string) {
	raw, err := os.ReadFile(filepath.Join(home, "distribution-install.json"))
	if err != nil || len(raw) > 64*1024 {
		return "", ""
	}
	var decoded map[string]any
	if json.Unmarshal(raw, &decoded) != nil {
		return "", ""
	}
	if textValue(decoded["state"]) != "installed" {
		return "", ""
	}
	return textValue(decoded["executable"]), textValue(decoded["packageRoot"])
}

func readEnv(lookup func(string) (string, bool), key string) string {
	value, _ := lookup(key)
	return value
}

func textValue(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

func packagedServerSibling(name string) string {
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, linkErr := filepath.EvalSymlinks(executable); linkErr == nil {
		executable = resolved
	}
	candidate := filepath.Join(filepath.Dir(executable), "bin", "native", goruntime.GOOS+"-"+goruntime.GOARCH, name)
	if goruntime.GOOS == "windows" {
		candidate += ".exe"
	}
	if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
		return candidate
	}
	return ""
}

func executableSibling(name string) string {
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, linkErr := filepath.EvalSymlinks(executable); linkErr == nil {
		executable = resolved
	}
	candidate := filepath.Join(filepath.Dir(executable), name)
	if goruntime.GOOS == "windows" {
		candidate += ".exe"
	}
	if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
		return candidate
	}
	return ""
}

func firstExisting(candidates ...string) string {
	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}
