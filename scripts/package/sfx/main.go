package main

import (
	"archive/zip"
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"time"
)

//go:embed payload.zip
var payload []byte

const (
	bundleVersion = "__AIH_BUNDLE_VERSION__"
	bundleTarget  = "__AIH_BUNDLE_TARGET__"
	payloadSHA    = "__AIH_PAYLOAD_SHA__"
	markerName    = ".aih-package.json"
)

type marker struct {
	Version string `json:"version"`
	Target  string `json:"target"`
	SHA256  string `json:"sha256"`
}

func main() {
	// Docker 在 ARM 上用 QEMU 跑 amd64 时，Go 的 GC 会触发
	// "marked free object in span" 崩溃；解包是一次性的 I/O 密集型操作，
	// 峰值内存只有载荷本身的大小，关掉 GC 不会造成压力。
	runtime.GOMAXPROCS(1)
	debug.SetGCPercent(-1)
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "[aih] 启动失败: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	dest, err := destination()
	if err != nil {
		return err
	}
	if os.Getenv("AIH_PKG_FORCE_EXTRACT") == "1" {
		_ = os.RemoveAll(dest)
	}
	if !markerMatches(dest) {
		if err := extractWithLock(dest); err != nil {
			return err
		}
	}
	if os.Getenv("AIH_PKG_EXTRACT_ONLY") == "1" {
		fmt.Println(dest)
		return nil
	}
	return launch(dest)
}

func destination() (string, error) {
	root := strings.TrimSpace(os.Getenv("AIH_PKG_DIR"))
	if root == "" {
		if aiHome := strings.TrimSpace(os.Getenv("AIH_HOME_DIR")); aiHome != "" {
			root = filepath.Join(aiHome, "pkg")
		} else {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", fmt.Errorf("无法确定用户目录: %w", err)
			}
			root = filepath.Join(home, ".ai_home", "pkg")
		}
	}
	short := payloadSHA
	if len(short) > 8 {
		short = short[:8]
	}
	return filepath.Join(root, fmt.Sprintf("%s-%s-%s", bundleVersion, bundleTarget, short)), nil
}

func markerMatches(dest string) bool {
	data, err := os.ReadFile(filepath.Join(dest, markerName))
	if err != nil {
		return false
	}
	var found marker
	if err := json.Unmarshal(data, &found); err != nil {
		return false
	}
	if found.Version != bundleVersion || found.Target != bundleTarget || found.SHA256 != payloadSHA {
		return false
	}
	_, err = os.Stat(filepath.Join(dest, "bin", "ai-home.js"))
	return err == nil
}

func extractWithLock(dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	unlock, err := acquireLock(dest + ".lock")
	if err != nil {
		return err
	}
	defer unlock()
	if markerMatches(dest) {
		return nil
	}
	fmt.Fprintf(os.Stderr, "[aih] 首次运行，正在解包到 %s ...\n", dest)
	staging, err := os.MkdirTemp(filepath.Dir(dest), ".aih-extract-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)

	reader, err := zip.NewReader(bytes.NewReader(payload), int64(len(payload)))
	if err != nil {
		return fmt.Errorf("内嵌安装包损坏: %w", err)
	}
	for _, file := range reader.File {
		name := path.Clean(strings.TrimPrefix(file.Name, "./"))
		if name == "." || name == "" {
			continue
		}
		if strings.HasPrefix(name, "../") || path.IsAbs(name) {
			return fmt.Errorf("安装包包含非法路径: %s", file.Name)
		}
		target := filepath.Join(staging, filepath.FromSlash(name))
		if !strings.HasPrefix(target, staging+string(os.PathSeparator)) && target != staging {
			return fmt.Errorf("安装包包含越界路径: %s", file.Name)
		}
		mode := file.Mode()
		if mode == 0 {
			if file.FileInfo().IsDir() {
				mode = 0o755
			} else {
				mode = 0o644
			}
		}
		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(target, mode); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		source, err := file.Open()
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
		if err != nil {
			source.Close()
			return err
		}
		_, copyErr := io.Copy(output, source)
		closeErr := output.Close()
		source.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
		if mode&0o111 != 0 {
			_ = os.Chmod(target, mode)
		}
	}
	if err := writeMarker(staging); err != nil {
		return err
	}
	if err := os.RemoveAll(dest); err != nil {
		return err
	}
	if err := os.Rename(staging, dest); err != nil {
		if markerMatches(dest) {
			return nil
		}
		return err
	}
	return nil
}

func writeMarker(directory string) error {
	data, err := json.MarshalIndent(marker{Version: bundleVersion, Target: bundleTarget, SHA256: payloadSHA}, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return os.WriteFile(filepath.Join(directory, markerName), data, 0o644)
}

func acquireLock(lockPath string) (func(), error) {
	deadline := time.Now().Add(120 * time.Second)
	for {
		if err := os.Mkdir(lockPath, 0o700); err == nil {
			_ = os.WriteFile(filepath.Join(lockPath, "pid"), []byte(fmt.Sprintf("%d\n", os.Getpid())), 0o600)
			return func() { _ = os.RemoveAll(lockPath) }, nil
		} else if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if info, err := os.Stat(lockPath); err == nil && time.Since(info.ModTime()) > 10*time.Minute {
			_ = os.RemoveAll(lockPath)
			continue
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("等待其它 aih 进程解包超时: %s", lockPath)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func packageEnv(dest string) []string {
	exe, err := os.Executable()
	if err == nil {
		exe = filepath.Clean(exe)
	}
	runtimeDir := filepath.Join(dest, "runtime")
	nodeDir := filepath.Join(runtimeDir, "bin")
	if _, statErr := os.Stat(nodeDir); statErr != nil {
		nodeDir = runtimeDir
	}
	env := os.Environ()
	env = setEnv(env, "AIH_PACKAGED", "1")
	env = setEnv(env, "AIH_PACKAGE_ROOT", dest)
	if exe != "" {
		env = setEnv(env, "AIH_EXECUTABLE", exe)
		if os.Getenv("AIH_CLI_PATH") == "" {
			env = setEnv(env, "AIH_CLI_PATH", exe)
		}
	}
	current := os.Getenv("PATH")
	if current == "" {
		env = setEnv(env, "PATH", nodeDir)
	} else {
		env = setEnv(env, "PATH", nodeDir+string(os.PathListSeparator)+current)
	}
	return env
}

func setEnv(env []string, key, value string) []string {
	prefix := key + "="
	for index, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			env[index] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}
