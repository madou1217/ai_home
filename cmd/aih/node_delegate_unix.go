//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// execNode 用 node 替换当前进程：不额外留下 Go 外壳，退出码与信号语义保持原样。
func execNode(entry string, args []string) bool {
	nodePath, err := exec.LookPath("node")
	if err != nil {
		return false
	}
	// argv[0] 必须是真实的 node 路径：Node 侧会用 process.argv[0] 判断是否需要重新 exec，
	// 传字面量 "node" 会被当成另一个可执行文件而无限重入。
	argv := append([]string{nodePath, entry}, args...)
	if err = syscall.Exec(nodePath, argv, envWithDelegationMarker()); err != nil {
		return false
	}
	return true
}
