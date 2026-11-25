//go:build !darwin && !windows && !linux

package applaunch

import (
	"context"

	"github.com/madou1217/ai_home/application/launcher"
)

func openApp(_ context.Context, _ launcher.App) error {
	return launcher.ErrUnsupported
}
