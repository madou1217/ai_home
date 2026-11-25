//go:build !darwin && !windows && !linux

package appcatalog

import (
	"context"

	"github.com/madou1217/ai_home/application/launcher"
)

func platformSupported() bool {
	return false
}

func scanApps(_ context.Context) ([]launcher.App, error) {
	return nil, launcher.ErrUnsupported
}
