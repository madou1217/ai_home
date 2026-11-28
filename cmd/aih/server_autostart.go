package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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
	if len(arguments) < 2 || (arguments[0] != "server" && arguments[0] != "daemon") || arguments[1] != "autostart" {
		return false, nil
	}
	action := "status"
	if len(arguments) > 2 {
		action = strings.TrimSpace(arguments[2])
	}
	if action == "remove" {
		action = "uninstall"
	}
	if action != "install" && action != "uninstall" && action != "status" {
		// Node: any unknown autostart subcommand (including --help) is status.
		action = "status"
	}
	switch action {
	case "install":
		options, err := resolveAutostartOptions(runtime)
		if err != nil {
			return true, err
		}
		status, err := autostart.Install(ctx, options)
		if err != nil {
			return true, err
		}
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] server autostart installed")
		writeAutostartStatus(runtime, status)
	case "uninstall":
		options, err := resolveAutostartOptionsLoose(runtime)
		if err != nil {
			return true, err
		}
		if err := autostart.Uninstall(ctx, options); err != nil {
			return true, err
		}
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] server autostart uninstalled")
	case "status":
		options, err := resolveAutostartOptionsLoose(runtime)
		if err != nil {
			return true, err
		}
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
	return resolveAutostartOptionsWithBinary(runtime, true)
}

// resolveAutostartOptionsLoose 允许 ServerBinary 缺失；status/stop 只需要
// label、home 和 pid，不应因为找不到 server 二进制而无法诊断。
func resolveAutostartOptionsLoose(runtime commandRuntime) (autostart.Options, error) {
	return resolveAutostartOptionsWithBinary(runtime, false)
}

func resolveAutostartOptionsWithBinary(runtime commandRuntime, requireBinary bool) (autostart.Options, error) {
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
	// 仓库根目录的 aih-server 只是构建产物，不是 canonical 运行入口。
	// 优先选择 bin/native/<goos>-<goarch>/aih-server；若只能选到没有
	// build stamp 的 sibling，而同树里有已校验的 canonical 构建，则改用它。
	packagedBinary := packagedServerSibling("aih-server")
	siblingBinary := executableSibling("aih-server")
	serverBinary := firstExisting(
		strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_SERVER_BINARY")),
		receiptExecutable,
		packagedBinary,
		runtimeServerBinary(home),
		siblingBinary,
	)
	if serverBinary == "" {
		if resolved, lookupErr := exec.LookPath("aih-server"); lookupErr == nil {
			serverBinary = resolved
		}
	}
	if serverBinary == siblingBinary && packagedBinary != "" && packagedBinary != siblingBinary &&
		serverBinaryStamped(packagedBinary) && !serverBinaryStamped(siblingBinary) {
		serverBinary = packagedBinary
	}
	if serverBinary == "" && requireBinary {
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

// runtimeServerBinary 返回当前运行实例实际加载的 server 路径，作为
// autostart 解析的兜底：安装器没有 distribution receipt、CLI 旁边也没有
// sibling 时，status/restart 仍能拿到正在跑的 canonical 二进制。
func runtimeServerBinary(home string) string {
	raw, err := os.ReadFile(filepath.Join(home, "run", "go-server-runtime.json"))
	if err != nil || len(raw) > 64*1024 {
		return ""
	}
	var decoded struct {
		Executable string `json:"executable"`
	}
	if json.Unmarshal(raw, &decoded) != nil {
		return ""
	}
	value := strings.TrimSpace(decoded.Executable)
	if value == "" {
		return ""
	}
	if info, statErr := os.Stat(value); statErr != nil || !info.Mode().IsRegular() {
		return ""
	}
	return value
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

// serverBinaryStamped 校验二进制与同目录 build stamp 的 sha256 是否一致。
// 只用于 autostart 选择运行入口，不参与其他构建流程。
func serverBinaryStamped(path string) bool {
	if strings.TrimSpace(path) == "" {
		return false
	}
	raw, err := os.ReadFile(path + ".build.json")
	if err != nil || len(raw) > 64*1024 {
		return false
	}
	var stamp struct {
		BinarySHA256 string `json:"binary_sha256"`
	}
	if json.Unmarshal(raw, &stamp) != nil {
		return false
	}
	expected := strings.ToLower(strings.TrimSpace(stamp.BinarySHA256))
	if expected == "" {
		return false
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return false
	}
	return hex.EncodeToString(hash.Sum(nil)) == expected
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
