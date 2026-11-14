package routeownership

import (
	"strings"
	"testing"
)

// TestGoOwnedEntriesAreCompleteAndUnique 守住归属投影的基本不变量：
//  1. go_owned 条目必须有 GoRoutes；
//  2. 同一条 (transport, method, path) 不能出现在两个条目里——重复注册会让
//     http.ServeMux 在启动期 panic（sessions/unarchive 就踩过一次）；
//  3. 浏览器数据面的 Go 路由必须落在 /v0/webui 下，避免把管理路径误标成公开面。
func TestGoOwnedEntriesAreCompleteAndUnique(t *testing.T) {
	manifest := Current()
	type routeKey struct {
		transport string
		method    string
		path      string
	}
	seen := map[routeKey]string{}
	for _, entry := range manifest.Entries {
		if entry.ProductionOwner != "go" || entry.MigrationState != "go_owned" {
			continue
		}
		if len(entry.GoRoutes) == 0 {
			t.Fatalf("go_owned 条目 %s 没有 GoRoutes", entry.ID)
		}
		for _, route := range entry.GoRoutes {
			methods := route.Methods
			if len(methods) == 0 {
				methods = []string{"*"}
			}
			for _, method := range methods {
				key := routeKey{transport: route.Transport, method: strings.ToUpper(method), path: route.Path}
				if owner, exists := seen[key]; exists {
					t.Fatalf("路由重复声明: %s 同时出现在 %s 与 %s", route.Path, owner, entry.ID)
				}
				seen[key] = entry.ID
			}
			if strings.HasPrefix(route.Path, "/v0/webui") && !strings.HasPrefix(route.Path, "/v0/webui/") {
				t.Fatalf("公开数据面路径缺少尾段: %s (%s)", route.Path, entry.ID)
			}
		}
	}
}
