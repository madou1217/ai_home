//go:build windows

package main

// Windows 便携版目录内的 aih.exe 启动器：不再解包，直接使用同目录的 Go CLI。
// 单独做成 exe 是因为 Windows 的 .cmd 在内部 spawn 时需要 shell，
// 用它当 AIH_EXECUTABLE 会让 resume / 会话恢复这类内部调用变得脆弱。

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func main() {
	executable, err := os.Executable()
	if err != nil {
		fail(err)
	}
	directory := filepath.Dir(executable)
	if raw, err := os.ReadFile(executable + ".package.json"); err == nil {
		var binding struct {
			Version     int    `json:"version"`
			Home        string `json:"home"`
			PackageRoot string `json:"packageRoot"`
			SHA         string `json:"serverSha256"`
		}
		if len(raw) > 16384 || json.Unmarshal(raw, &binding) != nil || binding.Version != 1 || !filepath.IsAbs(binding.Home) || !filepath.IsAbs(binding.PackageRoot) {
			fail(fmt.Errorf("安装资源记录无效"))
		}
		root, err := filepath.EvalSymlinks(binding.PackageRoot)
		if err != nil {
			fail(err)
		}
		rel, err := filepath.Rel(filepath.Join(binding.Home, "pkg"), root)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || filepath.IsAbs(rel) {
			fail(fmt.Errorf("安装资源不在已管理目录"))
		}
		server := filepath.Join(root, "bin", "native", "win32-"+mapArch(), "aih-server.exe")
		file, err := os.Open(server)
		if err != nil {
			fail(err)
		}
		hash := sha256.New()
		_, err = io.Copy(hash, file)
		file.Close()
		if err != nil || hex.EncodeToString(hash.Sum(nil)) != binding.SHA {
			fail(fmt.Errorf("安装资源校验失败"))
		}
		directory = root
		if strings.TrimSpace(os.Getenv("AIH_HOME_DIR")) == "" {
			if err := os.Setenv("AIH_HOME_DIR", binding.Home); err != nil {
				fail(err)
			}
		}
	}

	// CLI 直接运行 Go 实现；Node 运行时只留给 codex hooks / DSH 等外部运行时，
	// 不再作为 CLI 入口。
	cli := filepath.Join(directory, "bin", "native", "win32-"+mapArch(), "aih-go.exe")
	if _, err := os.Stat(cli); err != nil {
		fail(fmt.Errorf("入口缺失：%s", cli))
	}

	command := exec.Command(cli, os.Args[1:]...)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	command.Env = environment(directory, executable)
	if err := command.Run(); err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			os.Exit(exitError.ExitCode())
		}
		fail(err)
	}
}

func environment(directory, executable string) []string {
	env := os.Environ()
	runtimeDir := filepath.Join(directory, "runtime")
	env = set(env, "AIH_PACKAGED", "1")
	env = set(env, "AIH_PACKAGE_ROOT", directory)
	env = set(env, "AIH_EXECUTABLE", executable)
	current := os.Getenv("PATH")
	if current == "" {
		env = set(env, "PATH", runtimeDir)
	} else {
		env = set(env, "PATH", runtimeDir+string(os.PathListSeparator)+current)
	}
	return env
}

func set(env []string, key, value string) []string {
	prefix := key + "="
	for index, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			env[index] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}

func fail(err error) {
	fmt.Fprintf(os.Stderr, "[aih] 启动失败: %v\n", err)
	os.Exit(1)
}

func mapArch() string {
	if runtime.GOARCH == "amd64" {
		return "x64"
	}
	return runtime.GOARCH
}
