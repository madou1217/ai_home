//go:build linux

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
	execLine := strings.TrimSpace(app.Exec)
	if execLine == "" && strings.TrimSpace(app.Path) != "" {
		execLine = readDesktopExecField(app.Path)
	}
	argv := parseDesktopExec(execLine)
	if len(argv) == 0 {
		return errors.New("应用缺少 Exec 命令")
	}
	binary, err := resolveLinuxExecutable(argv[0])
	if err != nil {
		return err
	}
	argv[0] = binary
	if mode == ProxyModeChromium {
		if err := ensureProfileDir(options.ProfileDir); err != nil {
			return err
		}
		argv = append(argv, chromiumArguments(proxyURL, options.ProfileDir, options.ExtraArgs)...)
	}
	if app.Terminal {
		argv, err = wrapLinuxTerminal(argv)
		if err != nil {
			return err
		}
	}
	command := exec.Command(argv[0], argv[1:]...)
	command.Env = os.Environ()
	for key, value := range ProxyEnvironment(proxyURL) {
		command.Env = append(command.Env, key+"="+value)
	}
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		return err
	}
	go func() { _ = command.Wait() }()
	return nil
}
