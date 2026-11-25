// Package applaunch executes platform-specific application open actions for AIH Launch.
package applaunch

import (
	"context"

	"github.com/madou1217/ai_home/application/launcher"
)

// Launcher opens installed desktop applications using native platform mechanisms.
type Launcher struct{}

// New returns a platform application launcher.
func New() *Launcher {
	return &Launcher{}
}

// Open launches app on the current operating system.
func (l *Launcher) Open(ctx context.Context, app launcher.App) error {
	return openApp(ctx, app)
}

var _ launcher.Launcher = (*Launcher)(nil)
