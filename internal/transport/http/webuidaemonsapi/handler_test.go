package webuidaemonsapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/madou1217/ai_home/internal/runtime/peer"
	"github.com/madou1217/ai_home/internal/runtime/retention"
	"github.com/madou1217/ai_home/internal/runtime/tokenrefreshdaemon"
	"github.com/madou1217/ai_home/internal/runtime/usagedaemons"
)

type stubAuthorizer struct {
	allow bool
}

func (a stubAuthorizer) Authorized(r *http.Request) bool {
	return a.allow && r.Header.Get("Authorization") == "Bearer ok-token"
}

type stubController struct {
	mu       sync.Mutex
	triggers []TriggerRequest
}

func (c *stubController) Status(context.Context) StatusReport {
	return StatusReport{
		GeneratedAt: 1_700_000_000_000,
		Peer: &peer.DispatchDaemonState{
			Running:    true,
			IntervalMs: 3000,
			Batch:      5,
			TickCount:  7,
		},
		Retention: &retention.DaemonState{
			Running:      true,
			LogTickCount: 1,
		},
		QuotaProbe: &usagedaemons.QuotaProbeState{
			Running:   true,
			Enabled:   true,
			BatchSize: 4,
		},
		UsageScan: &usagedaemons.UsageScanState{
			Running:       true,
			Enabled:       true,
			PortAvailable: false,
		},
		ProviderRefresh: &usagedaemons.ProviderRefreshState{
			Running: true,
			Enabled: true,
		},
		TokenRefresh: &tokenrefreshdaemon.DaemonState{
			Running:        true,
			Enabled:        true,
			RefreshedCount: 3,
		},
	}
}

func (c *stubController) Trigger(_ context.Context, req TriggerRequest) (TriggerResult, error) {
	c.mu.Lock()
	c.triggers = append(c.triggers, req)
	c.mu.Unlock()
	return TriggerResult{
		Target: req.Daemon,
		Results: map[string]any{
			req.Daemon: map[string]any{"ok": true},
		},
		Status: c.Status(context.Background()),
	}, nil
}

func TestHandlerAuthMethodStatusAndTrigger(t *testing.T) {
	t.Parallel()

	if _, err := NewHandler(Dependencies{}); err == nil {
		t.Fatal("expected error when dependencies missing")
	}

	ctrl := &stubController{}
	h, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allow: true},
		Controller: ctrl,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}

	// 1) 未携带密钥返回 401
	rec401 := httptest.NewRecorder()
	req401 := httptest.NewRequest(http.MethodGet, StatusPath, nil)
	h.ServeHTTP(rec401, req401)
	if rec401.Code != http.StatusUnauthorized {
		t.Fatalf("GET without auth code = %d, want 401", rec401.Code)
	}

	// 2) 方法错误返回 405
	rec405 := httptest.NewRecorder()
	req405 := httptest.NewRequest(http.MethodPost, StatusPath, nil)
	req405.Header.Set("Authorization", "Bearer ok-token")
	h.ServeHTTP(rec405, req405)
	if rec405.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST on status code = %d, want 405", rec405.Code)
	}

	// 3) GET status 返回 200 及守护状态
	recStatus := httptest.NewRecorder()
	reqStatus := httptest.NewRequest(http.MethodGet, StatusPath, nil)
	reqStatus.Header.Set("Authorization", "Bearer ok-token")
	h.ServeHTTP(recStatus, reqStatus)
	if recStatus.Code != http.StatusOK {
		t.Fatalf("GET status code = %d, want 200: %s", recStatus.Code, recStatus.Body.String())
	}
	var statusBody struct {
		OK     bool         `json:"ok"`
		Status StatusReport `json:"status"`
	}
	if err := json.Unmarshal(recStatus.Body.Bytes(), &statusBody); err != nil {
		t.Fatal(err)
	}
	if !statusBody.OK || statusBody.Status.Peer == nil || statusBody.Status.Peer.TickCount != 7 || statusBody.Status.TokenRefresh == nil || statusBody.Status.TokenRefresh.RefreshedCount != 3 {
		t.Fatalf("unexpected status body: %+v", statusBody)
	}

	// 4) 空 POST trigger 默认归一化为 all
	recTriggerAll := httptest.NewRecorder()
	reqTriggerAll := httptest.NewRequest(http.MethodPost, TriggerPath, nil)
	reqTriggerAll.Header.Set("Authorization", "Bearer ok-token")
	h.ServeHTTP(recTriggerAll, reqTriggerAll)
	if recTriggerAll.Code != http.StatusOK || !strings.Contains(recTriggerAll.Body.String(), `"target":"all"`) {
		t.Fatalf("POST empty trigger = %d %s", recTriggerAll.Code, recTriggerAll.Body.String())
	}

	// 5) 指定守护与 provider
	recPeer := httptest.NewRecorder()
	reqPeer := httptest.NewRequest(http.MethodPost, TriggerPath, strings.NewReader(`{"daemon":"quota","provider":"codex"}`))
	reqPeer.Header.Set("Authorization", "Bearer ok-token")
	h.ServeHTTP(recPeer, reqPeer)
	if recPeer.Code != http.StatusOK || !strings.Contains(recPeer.Body.String(), `"target":"quota-probe"`) {
		t.Fatalf("POST quota trigger = %d %s", recPeer.Code, recPeer.Body.String())
	}

	// 6) 未知目标返回 400
	recBadTarget := httptest.NewRecorder()
	reqBadTarget := httptest.NewRequest(http.MethodPost, TriggerPath, strings.NewReader(`{"daemon":"unknown-daemon"}`))
	reqBadTarget.Header.Set("Authorization", "Bearer ok-token")
	h.ServeHTTP(recBadTarget, reqBadTarget)
	if recBadTarget.Code != http.StatusBadRequest || !strings.Contains(recBadTarget.Body.String(), `invalid_daemon_target`) {
		t.Fatalf("POST unknown daemon = %d %s", recBadTarget.Code, recBadTarget.Body.String())
	}

	// 7) 重复 JSON 键或未知字段拒绝
	recDup := httptest.NewRecorder()
	reqDup := httptest.NewRequest(http.MethodPost, TriggerPath, strings.NewReader(`{"daemon":"peer","unknown":1}`))
	reqDup.Header.Set("Authorization", "Bearer ok-token")
	h.ServeHTTP(recDup, reqDup)
	if recDup.Code != http.StatusBadRequest {
		t.Fatalf("POST unknown JSON field = %d, want 400", recDup.Code)
	}
}

func TestNormalizeTargetTokenRefreshAliasesAndTrigger(t *testing.T) {
	t.Parallel()

	for _, raw := range []string{"token-refresh", "token_refresh", "tokenrefresh", "refresh", " TOKEN_REFRESH "} {
		got, err := NormalizeTarget(raw)
		if err != nil || got != "token-refresh" {
			t.Fatalf("NormalizeTarget(%q) = (%q, %v), want (%q, nil)", raw, got, err, "token-refresh")
		}
	}

	ctrl := &stubController{}
	h, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allow: true},
		Controller: ctrl,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	for _, alias := range []string{"token-refresh", "token_refresh", "tokenrefresh", "refresh"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, TriggerPath, strings.NewReader(`{"daemon":"`+alias+`","provider":"codex"}`))
		req.Header.Set("Authorization", "Bearer ok-token")
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"target":"token-refresh"`) {
			t.Fatalf("POST %q trigger = %d %s", alias, rec.Code, rec.Body.String())
		}
	}
}
