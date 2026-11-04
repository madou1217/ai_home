//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

var (
	kernel32           = syscall.NewLazyDLL("kernel32.dll")
	setConsoleOutputCP = kernel32.NewProc("SetConsoleOutputCP")
	setConsoleCP       = kernel32.NewProc("SetConsoleCP")
)

// Windows 控制台默认是本地代码页（中文系统为 936）。Node 输出 UTF-8，
// 不切到 65001 时中文帮助/日志会显示成 U+FFFD 加问号这类乱码。
func prepareConsole() {
	_, _, _ = setConsoleOutputCP.Call(65001)
	_, _, _ = setConsoleCP.Call(65001)
}

func launch(dest string) error {
	node := filepath.Join(dest, "runtime", "node.exe")
	entry := filepath.Join(dest, "bin", "ai-home.js")
	command := exec.Command(node, append([]string{entry}, os.Args[1:]...)...)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	command.Env = packageEnv(dest)
	if err := command.Run(); err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			os.Exit(exitError.ExitCode())
		}
		return err
	}
	return nil
}
