package webuiterminalapi

import (
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/webuipublicalias"
)

// BrowserPrefix is the existing WebUI terminal endpoint, now handled by Go.
const BrowserPrefix = "/v0/webui/terminal"

// BrowserHandler exposes only the browser contract on the same terminal handler.
// In particular, management-only launch/probe must not become browser endpoints.
// Open's typed body already excludes executable, argv and environment overrides.
func BrowserHandler(handler http.Handler) http.Handler {
	forward := webuipublicalias.Rewrite(BrowserPrefix, Prefix, handler)
	// Reuse the management handler's authentication and JSON error response even
	// for rejected paths; never pass an unknown browser action to a Node fallback.
	rejected := webuipublicalias.RewritePath(Prefix+"/__browser_route_not_found", handler)
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		action := strings.TrimPrefix(request.URL.Path, BrowserPrefix)
		// A target not consumed by the outer remote-profile transport must never
		// accidentally open or modify a local terminal when Node is unavailable.
		if strings.TrimSpace(request.Header.Get("X-Aih-Server-Id")) != "" ||
			!browserActionAllowed(request.Method, action) {
			rejected.ServeHTTP(response, request)
			return
		}
		forward.ServeHTTP(response, request)
	})
}

func browserActionAllowed(method, action string) bool {
	switch method {
	case http.MethodGet:
		return action == "/sessions" || action == "/mux" || action == "/stream"
	case http.MethodPost:
		switch action {
		case "/open", "/attach", "/focus", "/input", "/resize", "/close", "/clipboard-image":
			return true
		}
	}
	return false
}
