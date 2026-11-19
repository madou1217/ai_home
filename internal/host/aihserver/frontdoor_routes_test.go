package aihserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// newFrontDoorTestRouter 构造最小路由表：只有前置门是真实处理器，其余入口一律 404。
func newFrontDoorTestRouter(t *testing.T, target string) http.Handler {
	t.Helper()
	frontDoor, err := newFrontDoorHandler(target)
	if err != nil {
		t.Fatalf("构造前置门失败: %v", err)
	}
	noop := http.NotFoundHandler()
	return newRouter(serverHandlers{
		accounts:          noop,
		models:            noop,
		gemini:            noop,
		blobs:             noop,
		tokenCount:        noop,
		images:            noop,
		clientProps:       noop,
		accountAuth:       noop,
		claudeRelayLeases: noop,
		inference:         noop,
		claudeNativeRelay: noop,
		frontDoor:         frontDoor,
	})
}

// TestRouterRejectsUnregisteredPathEvenWithFrontDoor 验证公开端口模式不再把未知路径
// 转交给其它宿主：缺少注册即稳定 JSON 404。
func TestRouterRejectsUnregisteredPathEvenWithFrontDoor(t *testing.T) {
	nodeCalled := false
	node := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		nodeCalled = true
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"owner":"legacy"}`))
	}))
	defer node.Close()

	router := newFrontDoorTestRouter(t, node.URL)
	front := httptest.NewServer(router)
	defer front.Close()

	response, err := front.Client().Get(front.URL + "/v0/webui/accounts/watch")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer response.Body.Close()
	if nodeCalled {
		t.Fatal("未注册路径不应再转交给其它宿主")
	}
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("状态码 = %d，期望 404", response.StatusCode)
	}
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("响应不是稳定 JSON: %v", err)
	}
	if payload.Error.Code != "route_not_found" {
		t.Fatalf("错误码 = %q", payload.Error.Code)
	}
}

// TestRouterKeeps404WithoutFrontDoor 保证私有端口模式没有行为漂移：
// 未注册路径仍是稳定 JSON 404，不会因为装配错误被 Node 的响应掩盖。
func TestRouterKeeps404WithoutFrontDoor(t *testing.T) {
	router := newFrontDoorTestRouter(t, "")
	front := httptest.NewServer(router)
	defer front.Close()

	response, err := front.Client().Get(front.URL + "/v0/webui/accounts/watch")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("状态码 = %d，期望 404", response.StatusCode)
	}
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("响应不是稳定 JSON: %v", err)
	}
	if payload.Error.Code != "route_not_found" {
		t.Fatalf("错误码 = %q", payload.Error.Code)
	}
}

// TestNewFrontDoorHandlerRejectsNonLoopback 把「前置门不得出网」拦在启动期。
func TestNewFrontDoorHandlerRejectsNonLoopback(t *testing.T) {
	for _, target := range []string{"http://10.0.0.5:9527", "http://example.com:9527"} {
		if _, err := newFrontDoorHandler(target); err == nil {
			t.Fatalf("newFrontDoorHandler(%q) 未报错", target)
		}
	}
}

// TestNewFrontDoorHandlerAllowsLoopbackAliases 覆盖 127.0.0.1 / localhost / ::1 三种写法。
func TestNewFrontDoorHandlerAllowsLoopbackAliases(t *testing.T) {
	for _, target := range []string{"http://127.0.0.1:19551", "http://localhost:19551", "http://[::1]:19551"} {
		handler, err := newFrontDoorHandler(target)
		if err != nil {
			t.Fatalf("newFrontDoorHandler(%q) 报错: %v", target, err)
		}
		if handler == nil {
			t.Fatalf("newFrontDoorHandler(%q) 返回空处理器", target)
		}
	}
}
