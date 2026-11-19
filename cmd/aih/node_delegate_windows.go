//go:build windows

package main

import (
	"os"
	"os/exec"
)

// execNode 在 Windows 没有 exec 语义：等子进程结束并透传退出码。
func execNode(entry string, args []string) bool {
	nodePath, err := exec.LookPath("node")
	if err != nil {
		return false
	}
	cmd := exec.Command(nodePath, append([]string{entry}, args...)...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = os.Environ()
	if err = cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			os.Exit(exitErr.ExitCode())
		}
		return false
	}
	os.Exit(0)
	return true
}
