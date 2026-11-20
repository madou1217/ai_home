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
	// CLI 入口是 Go 原生实现（Node 只留给 codex hooks / DSH 等外部运行时）。
	cli := filepath.Join(dest, "bin", "native", bundleTarget, "aih-go.exe")
	command := exec.Command(cli, os.Args[1:]...)
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
