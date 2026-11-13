package aihserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
)

func TestSubaggregatorPublicRoutesDisabledWhenUnconfigured(t *testing.T) {
	h, err := newPublicSubaggregatorHandler(webuiRouteDependencies{})
	if err != nil || h != nil {
		t.Fatalf("未配置目录时应返回 nil, nil，实际 handler=%v err=%v", h, err)
	}
	routes, err := buildSubaggregatorPublicRoutes(webuiRouteDependencies{})
	if err != nil || len(routes) != 0 {
		t.Fatalf("未配置目录时应返回空路由列表，实际 len=%d err=%v", len(routes), err)
	}
}

func TestSubaggregatorPublicRoutesServeMuxMount(t *testing.T) {
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	svc := subaggregator.NewService(aiHome, subaggregator.ServiceOptions{
		HostHomeDir: hostHome,
	})
	if _, err := svc.SaveSource(context.Background(), map[string]any{
		"name":    "MountLocal",
		"kind":    "local",
		"content": "trojan://pw@jp.example.com:443#JP%2001",
	}); err != nil {
		t.Fatalf("SaveSource: %v", err)
	}
	prof, err := svc.SaveProfile(map[string]any{
		"name":    "MountProfile",
		"sources": map[string]any{"all": true},
	})
	if err != nil {
		t.Fatalf("SaveProfile: %v", err)
	}

	routes, err := buildSubaggregatorPublicRoutes(webuiRouteDependencies{
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
	})
	if err != nil || len(routes) != 1 {
		t.Fatalf("装配公开订阅路由失败: routes=%d err=%v", len(routes), err)
	}
	if routes[0].Pattern != "/sub/" {
		t.Fatalf("路由模式预期 /sub/，实际 %q", routes[0].Pattern)
	}

	mux := http.NewServeMux()
	mux.Handle(routes[0].Pattern, routes[0].Handler)

	// 1. 无需 Authorization 即可拉取合法 token 订阅
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/sub/"+prof.Token+"?target=clash&relay=0", nil)
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "JP 01") {
		t.Fatalf("GET /sub/{token} 失败: status=%d body=%q", rec.Code, rec.Body.String())
	}

	// 2. HEAD 保留头但空响应体
	headRec := httptest.NewRecorder()
	mux.ServeHTTP(headRec, httptest.NewRequest(http.MethodHead, "/sub/"+prof.Token+"?target=clash&relay=0", nil))
	if headRec.Code != http.StatusOK || headRec.Body.Len() != 0 {
		t.Fatalf("HEAD /sub/{token} 失败: status=%d len=%d", headRec.Code, headRec.Body.Len())
	}

	// 3. POST 返回 405 method not allowed
	postRec := httptest.NewRecorder()
	mux.ServeHTTP(postRec, httptest.NewRequest(http.MethodPost, "/sub/"+prof.Token, nil))
	if postRec.Code != http.StatusMethodNotAllowed || postRec.Body.String() != "method not allowed" {
		t.Fatalf("POST 预期 405，实际 %d %q", postRec.Code, postRec.Body.String())
	}

	// 4. 未知 token 与规则集返回 404
	unknownRec := httptest.NewRecorder()
	mux.ServeHTTP(unknownRec, httptest.NewRequest(http.MethodGet, "/sub/missing_token_123456", nil))
	if unknownRec.Code != http.StatusNotFound {
		t.Fatalf("未知 token 预期 404，实际 %d", unknownRec.Code)
	}
	ruleRec := httptest.NewRecorder()
	mux.ServeHTTP(ruleRec, httptest.NewRequest(http.MethodGet, "/sub/"+prof.Token+"/rules/geosite-none?target=surge", nil))
	if ruleRec.Code != http.StatusNotFound {
		t.Fatalf("未知规则集预期 404，实际 %d", ruleRec.Code)
	}
}
