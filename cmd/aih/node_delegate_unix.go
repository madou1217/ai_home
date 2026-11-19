//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

// execNode 用 node 替换当前进程：不额外留下 Go 外壳，退出码与信号语义保持原样。
func execNode(entry string, args []string) bool {
	nodePath, err := exec.LookPath("node")
	if err != nil {
		return false
	}
	argv := append([]string{"node", entry}, args...)
	if err = syscall.Exec(nodePath, argv, os.Environ()); err != nil {
		return false
	}
	return true
}
