//go:build linux

package launcherd

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed ui/main.c
var embeddedMainC []byte

const (
	gtkBinaryName = "aih-launch-ui"
	buildTimeout  = 60 * time.Second
)

var buildMu sync.Mutex

// Build compiles the embedded GTK4 launcher UI into a content-addressed cache under
// <aiHomeDir>/run/launcher/linux/<sha256>/aih-launch-ui and returns its path.
func Build(ctx context.Context, aiHomeDir string) (string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	home := strings.TrimSpace(aiHomeDir)
	if home == "" {
		return "", errors.New("aiHomeDir 不能为空")
	}

	buildMu.Lock()
	defer buildMu.Unlock()

	gccPath, err := exec.LookPath("gcc")
	if err != nil {
		return "", errors.New("缺少 gcc 编译器，无法构建 Linux 启动器界面（Ubuntu/Debian: sudo apt install build-essential libgtk-4-dev pkg-config）")
	}
	pkgConfigPath, err := exec.LookPath("pkg-config")
	if err != nil {
		return "", errors.New("缺少 pkg-config，无法构建 Linux 启动器界面（Ubuntu/Debian: sudo apt install pkg-config libgtk-4-dev）")
	}

	gtkVersion, err := runPkgConfig(ctx, pkgConfigPath, "--modversion", "gtk4")
	if err != nil {
		return "", errors.New("缺少 GTK4 开发包，无法构建 Linux 启动器界面（Ubuntu/Debian: sudo apt install libgtk-4-dev；Fedora: sudo dnf install gtk4-devel）")
	}
	if _, err := runPkgConfig(ctx, pkgConfigPath, "--exists", "gio-2.0"); err != nil {
		return "", errors.New("缺少 GIO (glib) 开发包，无法构建 Linux 启动器界面（Ubuntu/Debian: sudo apt install libglib2.0-dev libgtk-4-dev）")
	}
	_, x11Err := runPkgConfig(ctx, pkgConfigPath, "--exists", "x11")
	hasX11 := x11Err == nil

	fingerprint := computeBuildFingerprint(embeddedMainC, gtkVersion, hasX11)
	cacheDir := filepath.Join(home, "run", "launcher", "linux", fingerprint)
	binaryPath := filepath.Join(cacheDir, gtkBinaryName)

	if info, statErr := os.Stat(binaryPath); statErr == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
		return binaryPath, nil
	}

	if err := os.MkdirAll(cacheDir, 0o700); err != nil {
		return "", fmt.Errorf("创建启动器构建缓存目录 %s 失败: %w", cacheDir, err)
	}

	pkgs := []string{"gtk4", "gio-2.0"}
	if hasX11 {
		pkgs = append(pkgs, "x11")
	}
	pkgFlagArgs := append([]string{"--cflags", "--libs"}, pkgs...)
	rawFlags, err := runPkgConfig(ctx, pkgConfigPath, pkgFlagArgs...)
	if err != nil {
		return "", fmt.Errorf("获取 GTK4 pkg-config 编译参数失败: %w", err)
	}
	pkgFlags := strings.Fields(rawFlags)

	tmpSrc, err := os.CreateTemp(cacheDir, "main-*.c")
	if err != nil {
		return "", fmt.Errorf("创建临时 C 源文件失败: %w", err)
	}
	tmpSrcPath := tmpSrc.Name()
	defer func() { _ = os.Remove(tmpSrcPath) }()

	if _, err := tmpSrc.Write(embeddedMainC); err != nil {
		_ = tmpSrc.Close()
		return "", fmt.Errorf("写入临时 C 源文件失败: %w", err)
	}
	if err := tmpSrc.Close(); err != nil {
		return "", fmt.Errorf("关闭临时 C 源文件失败: %w", err)
	}

	tmpBinPath := filepath.Join(cacheDir, fmt.Sprintf(".%s.%d.tmp", gtkBinaryName, os.Getpid()))
	_ = os.Remove(tmpBinPath)
	cleanupBin := true
	defer func() {
		if cleanupBin {
			_ = os.Remove(tmpBinPath)
		}
	}()

	gccArgs := []string{"-O2", "-Wall", "-Wextra"}
	if hasX11 {
		gccArgs = append(gccArgs, "-DHAVE_X11")
	}
	gccArgs = append(gccArgs, tmpSrcPath, "-o", tmpBinPath)
	gccArgs = append(gccArgs, pkgFlags...)
	gccArgs = append(gccArgs, "-lm")

	buildCtx, cancel := context.WithTimeout(ctx, buildTimeout)
	defer cancel()

	// Keep gcc intermediate files inside cacheDir instead of a potentially tight /tmp tmpfs.
	gccTmpDir := filepath.Join(cacheDir, fmt.Sprintf(".gcc-tmp-%d", os.Getpid()))
	if err := os.MkdirAll(gccTmpDir, 0o700); err == nil {
		defer func() { _ = os.RemoveAll(gccTmpDir) }()
	}

	var stderr bytes.Buffer
	cmd := exec.CommandContext(buildCtx, gccPath, gccArgs...)
	if info, err := os.Stat(gccTmpDir); err == nil && info.IsDir() {
		cmd.Env = replaceEnvVar(os.Environ(), "TMPDIR", gccTmpDir)
	}
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail != "" {
			return "", fmt.Errorf("gcc 编译启动器界面失败: %w\n%s", err, detail)
		}
		return "", fmt.Errorf("gcc 编译启动器界面失败: %w", err)
	}

	if err := os.Chmod(tmpBinPath, 0o755); err != nil {
		return "", fmt.Errorf("设置启动器二进制权限失败: %w", err)
	}
	if err := os.Rename(tmpBinPath, binaryPath); err != nil {
		return "", fmt.Errorf("写入缓存启动器二进制失败: %w", err)
	}
	cleanupBin = false
	return binaryPath, nil
}

func computeBuildFingerprint(source []byte, gtkVersion string, hasX11 bool) string {
	h := sha256.New()
	_, _ = h.Write(source)
	_, _ = h.Write([]byte("\x00gtk4="))
	_, _ = h.Write([]byte(strings.TrimSpace(gtkVersion)))
	_, _ = h.Write([]byte("\x00x11="))
	_, _ = h.Write([]byte(strconv.FormatBool(hasX11)))
	return hex.EncodeToString(h.Sum(nil))
}

func runPkgConfig(ctx context.Context, pkgConfigPath string, args ...string) (string, error) {
	cmdCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cmdCtx, pkgConfigPath, args...).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func replaceEnvVar(env []string, key, value string) []string {
	prefix := key + "="
	out := make([]string, 0, len(env)+1)
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			continue
		}
		out = append(out, entry)
	}
	return append(out, prefix+value)
}
