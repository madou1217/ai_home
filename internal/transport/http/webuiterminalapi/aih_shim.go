package webuiterminalapi

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// prepareAihShim 让终端会话里的 aih 命令直接执行同目录的 Go CLI。
//
// 终端不再经由 Node 入口：命令解析、账号/会话读取与启动都由 Go CLI 负责；
// Node 仅作为插件运行时存在。
func prepareAihShim() string {
	if runtime.GOOS == "windows" {
		return ""
	}
	root := repositoryRootFromExecutable()
	if root == "" {
		return ""
	}
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	// Native package contract: aih-go is adjacent to the running aih-server. Do
	// not execute this server as a CLI and do not recurse through PATH/aih.
	cli := filepath.Join(filepath.Dir(executable), "aih-go")
	body := aihShimBody(cli)
	directory := filepath.Join(root, ".runtime-bin")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return ""
	}
	file := filepath.Join(directory, "aih")
	existing, _ := os.ReadFile(file)
	if string(existing) != body {
		if err := os.WriteFile(file, []byte(body), 0o755); err != nil {
			return ""
		}
	}
	if err := os.Chmod(file, 0o755); err != nil {
		return ""
	}
	return directory
}

func aihShimBody(cli string) string {
	return "#!/bin/sh\nexec " + quoteAihShimArgument(cli) + ` "$@"` + "\n"
}

func quoteAihShimArgument(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
