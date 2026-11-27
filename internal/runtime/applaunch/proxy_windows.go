//go:build windows

package applaunch

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"syscall"

	"github.com/madou1217/ai_home/application/launcher"
)

func openWithProxy(ctx context.Context, app launcher.App, mode ProxyMode, proxyURL string, options ProxyOptions) error {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	target := strings.TrimSpace(app.Path)
	if target == "" {
		return errors.New("应用缺少可启动路径")
	}

	var command *exec.Cmd
	// UWP/Store 应用只能经 AppsFolder shell 路径启动，参数无法透传；桌面应用
	// 直接执行真实 exe，Chromium 参数与环境变量都能可靠生效。
	if strings.HasPrefix(strings.ToLower(target), "shell:appsfolder\\") {
		command = exec.Command("cmd", "/c", "start", "", target)
	} else {
		arguments := []string{}
		if mode == ProxyModeChromium && proxyURL != "" {
			if err := ensureProfileDir(options.ProfileDir); err != nil {
				return err
			}
			arguments = chromiumArguments(proxyURL, options.ProfileDir, options.ExtraArgs)
		}
		command = exec.Command(target, arguments...)
		command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	}
	command.Env = os.Environ()
	for key, value := range ProxyEnvironment(proxyURL) {
		command.Env = append(command.Env, key+"="+value)
	}
	if err := command.Start(); err != nil {
		return err
	}
	go func() { _ = command.Wait() }()
	return nil
}
