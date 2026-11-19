package aihserver

import (
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/webuipublicalias"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshreverseapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiwatchws"
)

const legacySSHReverseTunnelsWatchPath = "/v0/webui/ssh-connections/tunnels/watch"

// buildWebUIWatchWSRoutes snapshots the already-constructed WebUI routes into a
// private in-process ServeMux (with the same /v0/webui public aliases) and
// mounts the allowlisted multiplexed watch WebSocket endpoints on top.
//
// Capturing existingRoutes before appending prevents recursive dispatch to
// /watch/ws in addition to webuiwatchws's strict static path allowlist.
func buildWebUIWatchWSRoutes(
	dependencies webuiRouteDependencies,
	existingRoutes []webuiRoute,
) ([]webuiRoute, error) {
	snapshot := append([]webuiRoute(nil), existingRoutes...)
	privateMux := http.NewServeMux()
	for _, route := range snapshot {
		if route.Handler == nil || strings.TrimSpace(route.Pattern) == "" {
			continue
		}
		privateMux.Handle(route.Pattern, route.Handler)
	}
	mountPublicManagementAliases(privateMux, snapshot)
	registerLegacySSHWatchAlias(privateMux, snapshot)

	var shutdownDone <-chan struct{}
	if dependencies.SessionEventBus != nil {
		shutdownDone = dependencies.SessionEventBus.Done()
	}

	watchWS, err := webuiwatchws.NewHandler(webuiwatchws.Dependencies{
		Authorizer:   dependencies.Authorizer,
		Dispatch:     privateMux,
		ShutdownDone: shutdownDone,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 WebUI watch WebSocket 接口失败: %w", err)
	}

	return []webuiRoute{
		{Pattern: "GET " + webuiwatchws.Path, Handler: watchWS, SkipPublicAlias: true},
		{Pattern: "GET " + webuiwatchws.PublicPath, Handler: watchWS, SkipPublicAlias: true},
	}, nil
}

// registerLegacySSHWatchAlias maps the existing legacy frontend watch path
// /v0/webui/ssh-connections/tunnels/watch onto the canonical SSH reverse-tunnel
// watch handler strictly inside privateMux (preserving the frontend wire path
// and existing domain handler without adding broad public HTTP routes).
func registerLegacySSHWatchAlias(mux *http.ServeMux, routes []webuiRoute) {
	canonicalPattern := "GET " + webuisshreverseapi.WatchPath
	legacyPattern := "GET " + legacySSHReverseTunnelsWatchPath
	var canonicalHandler http.Handler
	for _, route := range routes {
		if route.Pattern == legacyPattern && route.Handler != nil {
			return
		}
		if route.Pattern == canonicalPattern && route.Handler != nil {
			canonicalHandler = route.Handler
		}
	}
	if canonicalHandler == nil {
		return
	}
	mux.Handle(
		legacyPattern,
		webuipublicalias.Rewrite(legacySSHReverseTunnelsWatchPath, webuisshreverseapi.WatchPath, canonicalHandler),
	)
}

// findWebUIWatchWSCloser returns the unique multiplexed watch WebSocket handler
// registered in routes as an io.Closer so Server.Close can gate, cancel, and
// join all hijacked watch connections before closing domain stores.
func findWebUIWatchWSCloser(routes []webuiRoute) io.Closer {
	for _, route := range routes {
		if closer, ok := route.Handler.(*webuiwatchws.Handler); ok && closer != nil {
			return closer
		}
	}
	return nil
}
