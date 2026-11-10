package aihserver

import (
	"net/http"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

// refreshRouteAuthorizer 是路由装配用的最小鉴权替身：装配阶段不会真的鉴权。
type refreshRouteAuthorizer struct{}

func (refreshRouteAuthorizer) Authorized(*http.Request) bool { return true }

// TestBuildWebUIRefreshRoutes 守住三条刷新路由的挂载条件与模式串。
//
// 这三条是公开 WebUI 契约（Node 代理 + 前端轮询都按字面路径访问），模式串一旦
// 漂移就是全线 404，所以逐条比对完整字符串而不是只比数量。
func TestBuildWebUIRefreshRoutes(t *testing.T) {
	t.Run("依赖齐全时返回三条路由", func(t *testing.T) {
		routes, err := buildWebUIRefreshRoutes(webuiRouteDependencies{
			Authorizer: refreshRouteAuthorizer{},
			AIHomeDir:  t.TempDir(),
			Store:      &sqliteaccount.Store{},
		})
		if err != nil {
			t.Fatalf("装配刷新路由失败: %v", err)
		}
		want := []string{
			"POST /v1/management/webui/accounts/{provider}/{accountRef}/refresh",
			"POST /v1/management/webui/accounts/{provider}/{accountRef}/refresh-usage",
			"GET /v1/management/webui/accounts/refresh-jobs/{jobId}",
		}
		if len(routes) != len(want) {
			t.Fatalf("路由条数 = %d, want %d: %+v", len(routes), len(want), routes)
		}
		for index, pattern := range want {
			if routes[index].Pattern != pattern {
				t.Fatalf("第 %d 条路由 = %q, want %q", index, routes[index].Pattern, pattern)
			}
			if routes[index].Handler == nil {
				t.Fatalf("第 %d 条路由没有 Handler: %q", index, pattern)
			}
		}
	})

	// 模型/额度端口未接线是合法配置：路由仍然挂载，执行器把对应段标
	// refresh_unavailable，额度入口回 501。缺端口不该让整组路由消失。
	t.Run("可选端口为空时仍然挂载", func(t *testing.T) {
		routes, err := buildWebUIRefreshRoutes(webuiRouteDependencies{
			Authorizer: refreshRouteAuthorizer{},
			AIHomeDir:  t.TempDir(),
			Store:      &sqliteaccount.Store{},
		})
		if err != nil {
			t.Fatalf("装配刷新路由失败: %v", err)
		}
		if len(routes) != 3 {
			t.Fatalf("路由条数 = %d, want 3", len(routes))
		}
	})

	// 账号存储是必需端口：缺失时整组不挂载，也不报错——保持「可选路由不阻断启动」。
	t.Run("缺少账号存储时不挂载", func(t *testing.T) {
		routes, err := buildWebUIRefreshRoutes(webuiRouteDependencies{
			Authorizer: refreshRouteAuthorizer{},
			AIHomeDir:  t.TempDir(),
		})
		if err != nil {
			t.Fatalf("缺依赖不应报错: %v", err)
		}
		if len(routes) != 0 {
			t.Fatalf("缺依赖时不应挂载路由: %+v", routes)
		}
	})

	t.Run("缺少鉴权时不挂载", func(t *testing.T) {
		routes, err := buildWebUIRefreshRoutes(webuiRouteDependencies{
			AIHomeDir: t.TempDir(),
			Store:     &sqliteaccount.Store{},
		})
		if err != nil {
			t.Fatalf("缺依赖不应报错: %v", err)
		}
		if len(routes) != 0 {
			t.Fatalf("缺依赖时不应挂载路由: %+v", routes)
		}
	})

	// 数据根不可用时返回中文错误而不是 panic：启动期能定位到是哪一组端口坏了。
	t.Run("数据根无效时返回错误", func(t *testing.T) {
		_, err := buildWebUIRefreshRoutes(webuiRouteDependencies{
			Authorizer: refreshRouteAuthorizer{},
			Store:      &sqliteaccount.Store{},
		})
		if err == nil {
			t.Fatal("数据根为空时应当报错")
		}
		if !strings.Contains(err.Error(), "额度刷新账号读端口") {
			t.Fatalf("错误应指明失败的装配环节，实际 %v", err)
		}
	})
}
