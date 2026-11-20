//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
)

func prepareConsole() {}

func launch(dest string) error {
	// CLI 入口是 Go 原生实现（Node 只留给 codex hooks / DSH 等外部运行时）。
	cli := filepath.Join(dest, "bin", "native", bundleTarget, "aih-go")
	if _, err := os.Stat(cli); err != nil {
		return err
	}
	args := append([]string{cli}, os.Args[1:]...)
	return syscall.Exec(cli, args, packageEnv(dest))
}
