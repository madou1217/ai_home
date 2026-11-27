//go:build !darwin && !windows && !linux

package applaunch

import (
	"context"
	"errors"

	"github.com/madou1217/ai_home/application/launcher"
)

func openWithProxy(_ context.Context, _ launcher.App, _ ProxyMode, _ string, _ ProxyOptions) error {
	return errors.New(launcher.ErrUnsupported.Error())
}
