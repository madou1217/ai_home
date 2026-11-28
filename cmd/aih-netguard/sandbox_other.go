//go:build !darwin

package main

import (
	"fmt"
	"os"
)

func runSandboxExec([]string) int {
	fmt.Fprintln(os.Stderr, "aih-netguard exec: 当前平台尚未实现 sandbox 执行器")
	return 1
}
