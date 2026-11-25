//go:build windows

package applaunch

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"syscall"

	"github.com/madou1217/ai_home/application/launcher"
)

func openApp(ctx context.Context, app launcher.App) error {
	target := strings.TrimSpace(app.Path)
	if target == "" {
		return fmt.Errorf("%w: missing application path", launcher.ErrInvalidInput)
	}
	if app.Kind == launcher.KindUWP || strings.HasPrefix(strings.ToLower(target), `shell:appsfolder\`) {
		cmd := exec.Command("explorer.exe", target)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := cmd.Start(); err != nil {
			return fmt.Errorf("explorer.exe %q failed: %w", target, err)
		}
		go func() { _ = cmd.Wait() }()
		return nil
	}

	// Sanitize quotes defensively; Windows file paths cannot contain double quotes.
	safePath := strings.ReplaceAll(target, `"`, "")
	cmd := exec.CommandContext(ctx, "cmd.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow: true,
		CmdLine:    `cmd.exe /c start "" "` + safePath + `"`,
	}
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("cmd start %q failed: %w", safePath, err)
	}
	return nil
}
