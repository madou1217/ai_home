package aihserver

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/webuiauth"
	"github.com/madou1217/ai_home/internal/transport/http/webuicontrolplaneapi"
)

const remoteWebUIHeader = webuicontrolplaneapi.TargetServerHeader

type remoteWebUIProxy struct {
	target        *webuicontrolplaneapi.RemoteProxy
	managementKey func() string
}

func newRemoteWebUIProxy(aiHomeDir string, managementKey func() string) (*remoteWebUIProxy, error) {
	if managementKey == nil {
		return nil, webuicontrolplaneapi.ErrInvalidDependencies
	}
	target, err := webuicontrolplaneapi.NewRemoteProxy(webuicontrolplaneapi.RemoteProxyOptions{AIHomeDir: aiHomeDir})
	if err != nil {
		return nil, err
	}
	return &remoteWebUIProxy{target: target, managementKey: managementKey}, nil
}

// withRemoteWebUIProxy authenticates the local caller before resolving a profile
// and replacing its credentials for the remote Go transport.
func withRemoteWebUIProxy(proxy *remoteWebUIProxy, next http.Handler) http.Handler {
	unavailable := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		writeSystemJSON(response, http.StatusServiceUnavailable, map[string]any{
			"ok": false, "error": "server_proxy_unavailable",
		})
	})
	var remote http.Handler = unavailable
	if proxy != nil && proxy.target != nil {
		remote = webuiauth.RequireManagementKey(proxy.managementKey, proxy.target.Wrap(next))
	}
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if isRemoteWebUIRequest(request) {
			remote.ServeHTTP(response, request)
			return
		}
		next.ServeHTTP(response, request)
	})
}

func isRemoteWebUIRequest(request *http.Request) bool {
	if request == nil || request.URL == nil {
		return false
	}
	path := request.URL.Path
	// /v0/node-rpc 是浏览器控制面（device-status/accounts/sessions）的实际入口；
	// 远程 profile 必须和 /v0/webui 一样走同源代理，否则浏览器直连会撞 CORS。
	if path != "/v0/webui" && !strings.HasPrefix(path, "/v0/webui/") &&
		path != "/v0/node-rpc" && !strings.HasPrefix(path, "/v0/node-rpc/") &&
		path != "/v0/management" && !strings.HasPrefix(path, "/v0/management/") {
		return false
	}
	if strings.TrimSpace(request.Header.Get(remoteWebUIHeader)) != "" {
		return true
	}
	query, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil {
		return true
	}
	for key, values := range query {
		if !strings.EqualFold(key, remoteWebUIHeader) {
			continue
		}
		if len(values) > 0 && strings.TrimSpace(values[0]) != "" {
			return true
		}
	}
	return false
}
