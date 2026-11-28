package aihserver

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"time"

	"github.com/madou1217/ai_home/application/launcher"
	"github.com/madou1217/ai_home/internal/adapters/launcherstore"
	"github.com/madou1217/ai_home/internal/runtime/appcatalog"
	"github.com/madou1217/ai_home/internal/runtime/applaunch"
	"github.com/madou1217/ai_home/internal/runtime/appproxyserve"
	"github.com/madou1217/ai_home/internal/runtime/desktoplauncher"
	"github.com/madou1217/ai_home/internal/runtime/desktoptranslation"
	"github.com/madou1217/ai_home/internal/runtime/launcherd"
	"github.com/madou1217/ai_home/internal/runtime/proxyserve"
	"github.com/madou1217/ai_home/internal/transport/http/webuiappsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuilauncherapi"
)

// launcherRuntime owns the AIH Launch application service, optional Linux launcherd,
// and HTTP handler wired into aihserver.
type launcherRuntime struct {
	service      *launcher.Service
	handler      *webuilauncherapi.Handler
	linuxDaemon  *launcherd.Daemon
	proxyEntries *appproxyserve.Provider
}

// Close stops the Linux desktop launcher supervisor if running.
func (r *launcherRuntime) Close() error {
	if r == nil {
		return nil
	}
	// Temporary app entries are detached on purpose: survive a server restart
	// and re-acquire their same selector against the new process. Stop them
	// explicitly from the app desk when the user kills the app.
	if r.linuxDaemon == nil {
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
	catalog := appcatalog.NewWithOptions(appcatalog.Options{CachePath: appcatalog.CachePath(dependencies.AIHomeDir)})
	opener := applaunch.New()
	service, err := launcher.NewService(catalog, opener, store, time.Now)
	if err != nil {
		return nil, nil, err
	}
	handler, err := webuilauncherapi.NewHandler(dependencies.Authorizer, service)
	if err != nil {
		return nil, nil, err
	}
	proxyEntries := appproxyserve.New(proxyserve.Options{
		AIHomeDir:     dependencies.AIHomeDir,
		ServerURL:     dependencies.SelfBaseURL,
		ManagementKey: dependencies.ManagementKey,
		LogDir:        filepath.Join(dependencies.AIHomeDir, "logs", "app-proxy"),
	})
	// A server restart must not leave already-open apps pointing at dead
	// temporary entries. Restore runs after the HTTP routes are ready.
	go func() {
		time.Sleep(2 * time.Second)
		proxyEntries.Restore(ctx, dependencies.AIHomeDir)
	}()
	appsHandler, err := webuiappsapi.NewHandler(webuiappsapi.Dependencies{
		Authorizer:   dependencies.Authorizer,
		Catalog:      service,
		Launcher:     opener,
		ProxyEntries: proxyEntries,
		AIHomeDir:    dependencies.AIHomeDir,
	})
	if err != nil {
		return nil, nil, err
	}

	rt := &launcherRuntime{
		service:      service,
		handler:      handler,
		proxyEntries: proxyEntries,
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
		// 代理启动复用同一 launcher.Service：WebUI、TAB、CLI 的应用集合不会漂移。
		{Pattern: webuiappsapi.Path, Handler: appsHandler, SkipPublicAlias: true},
		{Pattern: webuiappsapi.LaunchPath, Handler: appsHandler, SkipPublicAlias: true},
		{Pattern: webuiappsapi.DeskPath, Handler: appsHandler, SkipPublicAlias: true},
		{Pattern: webuiappsapi.DeskRenewPath, Handler: appsHandler, SkipPublicAlias: true},
		{Pattern: webuiappsapi.DeskKillPath, Handler: appsHandler, SkipPublicAlias: true},
		{Pattern: webuiappsapi.DeskHistoryPath, Handler: appsHandler, SkipPublicAlias: true},
		{Pattern: webuiappsapi.DeskHistoryClearPath, Handler: appsHandler, SkipPublicAlias: true},
	}
	return rt, routes, nil
}
