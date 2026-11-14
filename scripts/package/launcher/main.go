//go:build windows

package main

// Windows 便携版目录内的 aih.exe 启动器：不再解包，直接使用同目录的 runtime/。
// 单独做成 exe 是因为 Windows 的 .cmd 在 Node 里 spawn 需要 shell，
// 用它当 AIH_EXECUTABLE 会让 resume / 会话恢复这类内部调用变得脆弱。

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func main() {
	executable, err := os.Executable()
	if err != nil {
		fail(err)
	}
	directory := filepath.Dir(executable)
	node := filepath.Join(directory, "runtime", "node.exe")
	entry := filepath.Join(directory, "bin", "ai-home.js")
	if _, err := os.Stat(node); err != nil {
		fail(fmt.Errorf("运行时缺失：%s", node))
	}
	if _, err := os.Stat(entry); err != nil {
		fail(fmt.Errorf("入口缺失：%s", entry))
	}

	command := exec.Command(node, append([]string{entry}, os.Args[1:]...)...)
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
