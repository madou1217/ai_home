//go:build darwin

package applaunch

import (
	"context"
	"fmt"
	"os/exec"
	"strings"

	"github.com/madou1217/ai_home/application/launcher"
)

func openApp(ctx context.Context, app launcher.App) error {
	target := strings.TrimSpace(app.Path)
	if target == "" {
		return fmt.Errorf("%w: missing application path", launcher.ErrInvalidInput)
	}
	cmd := exec.CommandContext(ctx, "open", "-a", target)
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg != "" {
			return fmt.Errorf("open -a %q failed: %s (%w)", target, msg, err)
		}
		return fmt.Errorf("open -a %q failed: %w", target, err)
	}
	return nil
}
