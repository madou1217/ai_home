package aihserver

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"time"

	"github.com/madou1217/ai_home/application/launcher"
	"github.com/madou1217/ai_home/internal/adapters/launcherstore"
	"github.com/madou1217/ai_home/internal/runtime/appcatalog"
	"github.com/madou1217/ai_home/internal/runtime/applaunch"
	"github.com/madou1217/ai_home/internal/runtime/desktoplauncher"
	"github.com/madou1217/ai_home/internal/runtime/desktoptranslation"
	"github.com/madou1217/ai_home/internal/runtime/launcherd"
	"github.com/madou1217/ai_home/internal/transport/http/webuilauncherapi"
)

// launcherRuntime owns the AIH Launch application service, optional Linux launcherd,
// and HTTP handler wired into aihserver.
type launcherRuntime struct {
	service     *launcher.Service
	handler     *webuilauncherapi.Handler
	linuxDaemon *launcherd.Daemon
}

// Close stops the Linux desktop launcher supervisor if running.
func (r *launcherRuntime) Close() error {
	if r == nil || r.linuxDaemon == nil {
		return nil
	}
	return r.linuxDaemon.Close()
}

// bindDesktopShow connects POST /v1/management/launcher/show to the native desktop helper.
func (r *launcherRuntime) bindDesktopShow(desktop *desktoptranslation.Service) {
	if r == nil || r.handler == nil || desktop == nil {
		return
	}
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		return
	}
	r.handler.Show = func(_ context.Context) error {
		if err := desktop.Send(map[string]any{"type": "launcher-show"}); err != nil {
			if errors.Is(err, desktoplauncher.ErrUnavailable) || errors.Is(err, desktoplauncher.ErrClosed) {
				return fmt.Errorf("%w: desktop helper unavailable", launcher.ErrUnsupported)
			}
			return err
		}
		return nil
	}
}

// newLauncherRuntime wires the platform app catalog, launcher opener, usage store,
// Linux launcherd (when running on a Linux desktop session), and HTTP routes.
// On non-desktop hosts (e.g. headless Linux servers without DISPLAY/WAYLAND_DISPLAY),
// it returns (nil, nil, nil) without constructing any launcher state or routes.
func newLauncherRuntime(ctx context.Context, dependencies webuiRouteDependencies) (*launcherRuntime, []webuiRoute, error) {
	if !launcherd.DesktopAvailable() {
		return nil, nil, nil
	}
	store, err := launcherstore.New(dependencies.AIHomeDir)
	if err != nil {
		return nil, nil, err
	}
	catalog := appcatalog.New()
	opener := applaunch.New()
	service, err := launcher.NewService(catalog, opener, store, time.Now)
	if err != nil {
		return nil, nil, err
	}
	handler, err := webuilauncherapi.NewHandler(dependencies.Authorizer, service)
	if err != nil {
		return nil, nil, err
	}

	rt := &launcherRuntime{
		service: service,
		handler: handler,
	}

	if runtime.GOOS == "linux" {
		if daemon, daemonErr := launcherd.New(launcherd.Options{
			AIHomeDir: dependencies.AIHomeDir,
			Service:   service,
		}); daemonErr == nil {
			rt.linuxDaemon = daemon
			handler.DesktopStatus = func(_ context.Context) any {
				return daemon.Status()
			}
			_ = daemon.Start(ctx)
			handler.Show = func(showCtx context.Context) error {
				return daemon.Show(showCtx)
			}
		}
	}

	routes := []webuiRoute{
		{Pattern: webuilauncherapi.Path + "/apps", Handler: handler, SkipPublicAlias: true},
		{Pattern: webuilauncherapi.Path + "/open", Handler: handler, SkipPublicAlias: true},
		{Pattern: webuilauncherapi.Path + "/show", Handler: handler, SkipPublicAlias: true},
		{Pattern: webuilauncherapi.Path + "/status", Handler: handler, SkipPublicAlias: true},
	}
	return rt, routes, nil
}
