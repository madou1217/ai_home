package desktoptranslation

import (
	"context"
	"errors"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/desktoplauncher"
	"github.com/madou1217/ai_home/internal/runtime/translation"
)

// RunFullApp is the standalone host lifecycle. It does not start a server, register
// accounts, or borrow another instance's management credentials.
func RunFullApp(ctx context.Context, home string, build func(context.Context) (desktoplauncher.LaunchSpec, error), protocolOnly bool) error {
	database, err := appstate.DatabasePath(home)
	if err != nil {
		return err
	}
	if _, err := translation.ReadSettings(ctx, database); err != nil {
		return err
	}
	executor := &Executor{DatabasePath: database}
	// Full-app has no implicit gateway; explicit direct routes use existing provider settings.
	service, err := New(ctx, Options{AIHomeDir: home, DatabasePath: database, Mode: "full-app", Build: build, Executor: executor})
	if err != nil {
		return err
	}
	defer service.Close()
	if err := service.Start(ctx); err != nil {
		return err
	}
	if protocolOnly {
		if err := service.Send(map[string]any{"type": "configure", "target": "zh-Hans"}); err != nil {
			return err
		}
		if err := service.Send(map[string]any{"type": "shutdown"}); err != nil {
			return err
		}
		deadline := time.NewTimer(5 * time.Second)
		defer deadline.Stop()
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-deadline.C:
				return errors.New("desktop_protocol_shutdown_timeout")
			case <-ticker.C:
				if service.launcher.Status().PID == 0 {
					return nil
				}
			}
		}
	}
	err = service.launcher.Wait(ctx)
	if ctx.Err() != nil {
		return nil
	}
	return err
}
