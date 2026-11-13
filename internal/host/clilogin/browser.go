package clilogin

import (
	"os"
	"path/filepath"
	"runtime"
)

const (
	browserCaptureUnix = "browser-capture.sh"
	browserCaptureWin  = "browser-capture.cmd"
)

// browserCapture 生成「不启动真实浏览器、只把 URL 回显到日志」的 BROWSER 脚本。
//
// 与 Node buildBrowserCaptureCommand 同语义：WebUI 登录要拿到授权链接展示给用户，
// 而 CLI 调浏览器时如果直接打开宿主浏览器，作业既拿不到 URL 又会在用户桌面弹窗。
// 脚本按 POSIX sh / cmd 两套写出，权限 0755。
func browserCapture(runtimeDir string) (string, error) {
	if runtime.GOOS == "windows" {
		path := filepath.Join(runtimeDir, browserCaptureWin)
		content := "@echo off\r\necho %*\r\n:loop\r\ntimeout /t 3600 /nobreak >nul\r\ngoto loop\r\n"
		if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
			return "", err
		}
		return path, nil
	}
	path := filepath.Join(runtimeDir, browserCaptureUnix)
	content := "#!/bin/sh\ntrap \"exit 0\" INT TERM HUP\nprintf \"%s\\n\" \"$@\"\nwhile :; do sleep 3600; done\n"
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		return "", err
	}
	return path, nil
}
