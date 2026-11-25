//go:build linux

package launcherd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	autostartFileName      = "aih-launch.desktop"
	autostartManagedHeader = "# Managed by AIH Launch (aih launch enable)"
)

// AutostartPath resolves the user's XDG autostart desktop file path.
func AutostartPath() (string, error) {
	if xdgConfig := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); xdgConfig != "" {
		return filepath.Join(xdgConfig, "autostart", autostartFileName), nil
	}
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return "", fmt.Errorf("无法确定用户主目录: %w", err)
	}
	return filepath.Join(home, ".config", "autostart", autostartFileName), nil
}

// AutostartEnabled reports whether the XDG autostart entry currently exists.
func AutostartEnabled() bool {
	path, err := AutostartPath()
	if err != nil {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// EnableAutostart idempotently writes ~/.config/autostart/aih-launch.desktop
// pointing to `<abs aih> launch ui --daemon`.
func EnableAutostart(aihExecPath string) (string, error) {
	desktopPath, err := AutostartPath()
	if err != nil {
		return "", err
	}
	execPath := strings.TrimSpace(aihExecPath)
	if execPath == "" {
		resolved, exeErr := os.Executable()
		if exeErr != nil {
			return "", fmt.Errorf("无法定位当前 aih 可执行文件: %w", exeErr)
		}
		execPath = resolved
	}
	absExec, err := filepath.Abs(execPath)
	if err != nil {
		return "", fmt.Errorf("解析 aih 绝对路径失败: %w", err)
	}
	if evaluated, evalErr := filepath.EvalSymlinks(absExec); evalErr == nil && strings.TrimSpace(evaluated) != "" {
		absExec = evaluated
	}

	dir := filepath.Dir(desktopPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("创建 autostart 目录 %s 失败: %w", dir, err)
	}

	content := renderAutostartDesktop(absExec)
	tmpFile, err := os.CreateTemp(dir, ".aih-launch-*.desktop.tmp")
	if err != nil {
		return "", fmt.Errorf("创建临时 autostart 文件失败: %w", err)
	}
	tmpPath := tmpFile.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()

	if _, err := tmpFile.WriteString(content); err != nil {
		_ = tmpFile.Close()
		return "", fmt.Errorf("写入 autostart 文件失败: %w", err)
	}
	if err := tmpFile.Chmod(0o644); err != nil {
		_ = tmpFile.Close()
		return "", fmt.Errorf("设置 autostart 文件权限失败: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return "", fmt.Errorf("关闭临时 autostart 文件失败: %w", err)
	}
	if err := os.Rename(tmpPath, desktopPath); err != nil {
		return "", fmt.Errorf("原子替换 autostart 文件失败: %w", err)
	}
	cleanup = false
	return desktopPath, nil
}

// DisableAutostart idempotently removes ~/.config/autostart/aih-launch.desktop.
func DisableAutostart() (string, bool, error) {
	desktopPath, err := AutostartPath()
	if err != nil {
		return "", false, err
	}
	if err := os.Remove(desktopPath); err != nil {
		if os.IsNotExist(err) {
			return desktopPath, false, nil
		}
		return desktopPath, false, fmt.Errorf("删除 autostart 文件 %s 失败: %w", desktopPath, err)
	}
	return desktopPath, true, nil
}

func renderAutostartDesktop(absExec string) string {
	execToken := quoteDesktopExecArg(absExec)
	var b strings.Builder
	b.WriteString(autostartManagedHeader)
	b.WriteByte('\n')
	b.WriteString("[Desktop Entry]\n")
	b.WriteString("Type=Application\n")
	b.WriteString("Version=1.0\n")
	b.WriteString("Name=AIH Launch\n")
	b.WriteString("Comment=AIH Launch application launcher (Alt+Space)\n")
	b.WriteString("Exec=")
	b.WriteString(execToken)
	b.WriteString(" launch ui --daemon\n")
	b.WriteString("Terminal=false\n")
	b.WriteString("X-GNOME-Autostart-enabled=true\n")
	return b.String()
}

func quoteDesktopExecArg(arg string) string {
	if !strings.ContainsAny(arg, " \t\n\"'\\><~|&;$*?#()`") {
		return arg
	}
	escaped := strings.NewReplacer(`\`, `\\`, `"`, `\"`, `$`, `\$`, "`", "\\`").Replace(arg)
	return `"` + escaped + `"`
}
