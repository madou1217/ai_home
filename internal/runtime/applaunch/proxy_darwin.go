//go:build darwin

package applaunch

import (
	"context"
	"errors"
	"os/exec"
	"strings"

	"github.com/madou1217/ai_home/application/launcher"
)

func openWithProxy(_ context.Context, app launcher.App, mode ProxyMode, proxyURL string, options ProxyOptions) error {
	target := strings.TrimSpace(app.Path)
	if target == "" {
		return errors.New("应用缺少可启动路径")
	}
	args := []string{"-n", "-a", target}
	for key, value := range ProxyEnvironment(proxyURL) {
		// 只传大写一套；open 会把变量原样写入子进程环境，重复的小写值没有意义。
		switch key {
		case "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY":
			args = append(args, "--env", key+"="+value)
		}
	}
	if mode == ProxyModeChromium {
		if err := ensureProfileDir(options.ProfileDir); err != nil {
			return err
		}
		args = append(args, "--args")
		args = append(args, chromiumArguments(proxyURL, options.ProfileDir, options.ExtraArgs)...)
	}
	command := exec.Command("/usr/bin/open", args...)
	if output, err := command.CombinedOutput(); err != nil {
		message := strings.TrimSpace(string(output))
		if message != "" {
			return errors.New("启动应用失败: " + message)
		}
		return err
	}
	return nil
}
