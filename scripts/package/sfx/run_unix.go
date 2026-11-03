//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
)

func launch(dest string) error {
	node := filepath.Join(dest, "runtime", "bin", "node")
	entry := filepath.Join(dest, "bin", "ai-home.js")
	args := append([]string{node, entry}, os.Args[1:]...)
	return syscall.Exec(node, args, packageEnv(dest))
}
