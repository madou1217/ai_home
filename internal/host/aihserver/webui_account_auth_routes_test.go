package aihserver

import (
	"net/http"
	"testing"

	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountauthapi"
)

type accountAuthRouteAuthorizer struct{}

func (accountAuthRouteAuthorizer) Authorized(*http.Request) bool { return true }

// TestBuildWebUIAccountAuthRoutes 守住三条认证与导入路由的装配签名及模式串。
func TestBuildWebUIAccountAuthRoutes(t *testing.T) {
	t.Run("装配三条认证与导入路由", func(t *testing.T) {
		routes, err := buildWebUIAccountAuthRoutes(webuiRouteDependencies{
			Authorizer: accountAuthRouteAuthorizer{},
			AIHomeDir:  t.TempDir(),
		})
		if err != nil {
			t.Fatalf("buildWebUIAccountAuthRoutes() error = %v", err)
		}
		want := []string{
			"POST " + webuiaccountauthapi.ZCodeURLCallbackPath,
			"POST " + webuiaccountauthapi.StaticAccountPath,
			"POST " + webuiaccountauthapi.LocalImportPath,
			"POST /v0/webui/accounts/local-import",
		}
		if len(routes) != len(want) {
			t.Fatalf("routes len = %d, want %d", len(routes), len(want))
		}
		for idx, pattern := range want {
			if routes[idx].Pattern != pattern || routes[idx].Handler == nil {
				t.Fatalf("route[%d] = %+v, want %q", idx, routes[idx], pattern)
			}
		}
	})

	t.Run("缺少鉴权时不挂载", func(t *testing.T) {
		routes, err := buildWebUIAccountAuthRoutes(webuiRouteDependencies{})
		if err != nil || len(routes) != 0 {
			t.Fatalf("routes = %+v, err = %v, want empty nil", routes, err)
		}
	})
}
