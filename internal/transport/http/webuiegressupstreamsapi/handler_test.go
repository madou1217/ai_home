package webuiegressupstreamsapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
)

type stubAuthorizer bool

func (a stubAuthorizer) Authorized(*http.Request) bool { return bool(a) }

type fakeUpstreamsManager struct {
	view          *runtimeegress.EgressUpstreamsView
	viewErr       error
	lastFilterRef string

	watchCh      chan runtimeegress.WatchEvent
	geoEntry     *runtimeegress.NetworkGeoEntry
	geoErr       error
	lastPolicyID string
	lastPatch    runtimeegress.UpstreamPolicyPatch
	policyErr    error

	resetRemoved int
	resetStatus  int
	resetErrCode string
	lastExitKeys []string

	probeResult runtimeegress.UpstreamProbeHTTPResult
	probeStatus int
	lastNodes   []string

	validAccount *runtimeegress.AccountRecord
	validStatus  int
	validErr     string
	runtimeView  map[string]any
	putResp      map[string]any
	putStatus    int
	putErr       string
}

func (f *fakeUpstreamsManager) BuildUpstreamsView(_ context.Context, accountRefFilter string) (*runtimeegress.EgressUpstreamsView, error) {
	f.lastFilterRef = accountRefFilter
	return f.view, f.viewErr
}

func (f *fakeUpstreamsManager) SubscribeWatch() (<-chan runtimeegress.WatchEvent, func()) {
	ch := make(chan runtimeegress.WatchEvent, 8)
	f.watchCh = ch
	return ch, func() {
		select {
		case <-ch:
		default:
			close(ch)
		}
	}
}

func (f *fakeUpstreamsManager) RefreshDirectNetworkGeo(context.Context) (*runtimeegress.NetworkGeoEntry, error) {
	return f.geoEntry, f.geoErr
}

func (f *fakeUpstreamsManager) UpdateUpstreamPolicy(_ context.Context, upstreamID string, patch runtimeegress.UpstreamPolicyPatch) (runtimeegress.UpstreamPolicy, error) {
	f.lastPolicyID = upstreamID
	f.lastPatch = patch
	if f.policyErr != nil {
		return runtimeegress.UpstreamPolicy{}, f.policyErr
	}
	return runtimeegress.UpstreamPolicy{EvidenceTTLMS: 3600}, nil
}

func (f *fakeUpstreamsManager) ResetUpstreamEvidence(_ context.Context, _ string, exitKeys []string) (int, int, string) {
	f.lastExitKeys = exitKeys
	return f.resetRemoved, f.resetStatus, f.resetErrCode
}

func (f *fakeUpstreamsManager) StartUpstreamProbe(_ context.Context, _ string, requestedNodes []string) (runtimeegress.UpstreamProbeHTTPResult, int) {
	f.lastNodes = requestedNodes
	return f.probeResult, f.probeStatus
}

func (f *fakeUpstreamsManager) ValidateAccountPath(_ context.Context, _ string, _ string) (*runtimeegress.AccountRecord, int, string) {
	return f.validAccount, f.validStatus, f.validErr
}

func (f *fakeUpstreamsManager) GetAccountEgressRuntime(context.Context, runtimeegress.AccountRecord) map[string]any {
	return f.runtimeView
}

func (f *fakeUpstreamsManager) PutAccountEgressAssignment(context.Context, runtimeegress.AccountRecord, map[string]any) (map[string]any, int, string) {
	return f.putResp, f.putStatus, f.putErr
}

func TestUpstreamsAndAccountRoutes(t *testing.T) {
	t.Parallel()
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("期望 ErrInvalidDependencies，实际 %v", err)
	}

	accRef := "acct_1234567890abcdef1234"
	mgr := &fakeUpstreamsManager{
		view: &runtimeegress.EgressUpstreamsView{
			OK:         true,
			Upstreams:  []runtimeegress.UpstreamViewItem{},
			Groups:     []runtimeegress.UpstreamGroupSummary{},
			ServerTime: 1700000000000,
		},
		geoEntry: &runtimeegress.NetworkGeoEntry{
			Geo: runtimeegress.GeoLocation{Country: "US", IP: "1.1.1.1"},
			At:  1700000000100,
		},
		resetRemoved: 3,
		resetStatus:  http.StatusOK,
		probeResult: runtimeegress.UpstreamProbeHTTPResult{
			OK:         true,
			Background: true,
			Count:      15,
		},
		probeStatus:  http.StatusAccepted,
		validAccount: &runtimeegress.AccountRecord{AccountRef: accRef, Provider: "claude"},
		validStatus:  http.StatusOK,
		runtimeView:  map[string]any{"ok": true, "accountRef": accRef},
		putResp:      map[string]any{"ok": true, "assignment": map[string]any{"strategy": "sticky"}},
		putStatus:    http.StatusOK,
	}

	unauthH, _ := NewHandler(Dependencies{Authorizer: stubAuthorizer(false), Manager: mgr})
	wUnauth := httptest.NewRecorder()
	unauthH.ServeHTTP(wUnauth, httptest.NewRequest(http.MethodGet, UpstreamsPath, nil))
	if wUnauth.Code != http.StatusUnauthorized {
		t.Fatalf("未授权期望 401，实际 %d", wUnauth.Code)
	}

	h, err := NewHandler(Dependencies{
		Authorizer:        stubAuthorizer(true),
		Manager:           mgr,
		Now:               func() time.Time { return time.UnixMilli(1700000000000) },
		HeartbeatInterval: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("NewHandler error = %v", err)
	}

	// 1. GET upstreams 透传 accountRef
	wGet := httptest.NewRecorder()
	h.ServeHTTP(wGet, httptest.NewRequest(http.MethodGet, UpstreamsPath+"?accountRef="+accRef, nil))
	if wGet.Code != http.StatusOK || mgr.lastFilterRef != accRef {
		t.Fatalf("GET upstreams 失败: %d ref=%q", wGet.Code, mgr.lastFilterRef)
	}

	// 2. PUT policy
	wPut := httptest.NewRecorder()
	h.ServeHTTP(wPut, httptest.NewRequest(http.MethodPut, UpstreamsPath+"/api.anthropic.com", bytes.NewBufferString(`{"evidenceTtlMs":3600000}`)))
	if wPut.Code != http.StatusOK || mgr.lastPolicyID != "api.anthropic.com" || mgr.lastPatch.EvidenceTTLMS == nil || *mgr.lastPatch.EvidenceTTLMS != 3600000 {
		t.Fatalf("PUT upstream policy 失败: %d body=%s", wPut.Code, wPut.Body.String())
	}

	// 3. POST probe 返回 202
	wProbe := httptest.NewRecorder()
	h.ServeHTTP(wProbe, httptest.NewRequest(http.MethodPost, UpstreamsPath+"/api.anthropic.com/probe", bytes.NewBufferString(`{"nodes":["N1","N2"]}`)))
	if wProbe.Code != http.StatusAccepted || len(mgr.lastNodes) != 2 {
		t.Fatalf("POST probe 失败: %d body=%s", wProbe.Code, wProbe.Body.String())
	}

	// 4. POST evidence reset
	wReset := httptest.NewRecorder()
	h.ServeHTTP(wReset, httptest.NewRequest(http.MethodPost, UpstreamsPath+"/api.anthropic.com/evidence/reset", bytes.NewBufferString(`{"exitKeys":["node:x"]}`)))
	if wReset.Code != http.StatusOK || len(mgr.lastExitKeys) != 1 {
		t.Fatalf("POST evidence/reset 失败: %d", wReset.Code)
	}

	// 5. POST network refresh (200 & 502)
	wNet := httptest.NewRecorder()
	h.ServeHTTP(wNet, httptest.NewRequest(http.MethodPost, NetworkRefreshPath, nil))
	if wNet.Code != http.StatusOK {
		t.Fatalf("network/refresh 期望 200，实际 %d", wNet.Code)
	}
	mgr.geoErr = errors.New("offline")
	wNetFail := httptest.NewRecorder()
	h.ServeHTTP(wNetFail, httptest.NewRequest(http.MethodPost, NetworkRefreshPath, nil))
	if wNetFail.Code != http.StatusBadGateway {
		t.Fatalf("network/refresh 失败期望 502，实际 %d", wNetFail.Code)
	}

	// 6. Account runtime & assignment
	wAccGet := httptest.NewRecorder()
	h.ServeHTTP(wAccGet, httptest.NewRequest(http.MethodGet, AccountEgressPrefix+"claude/"+accRef+"/egress-runtime", nil))
	if wAccGet.Code != http.StatusOK {
		t.Fatalf("egress-runtime 期望 200，实际 %d body=%s", wAccGet.Code, wAccGet.Body.String())
	}
	wAccPutEmpty := httptest.NewRecorder()
	h.ServeHTTP(wAccPutEmpty, httptest.NewRequest(http.MethodPut, AccountEgressPrefix+"claude/"+accRef+"/egress-assignment", bytes.NewBufferString("")))
	if wAccPutEmpty.Code != http.StatusBadRequest {
		t.Fatalf("空 body assignment 期望 400，实际 %d", wAccPutEmpty.Code)
	}
	wAccPut := httptest.NewRecorder()
	h.ServeHTTP(wAccPut, httptest.NewRequest(http.MethodPut, AccountEgressPrefix+"claude/"+accRef+"/egress-assignment", bytes.NewBufferString(`{"strategy":"sticky"}`)))
	if wAccPut.Code != http.StatusOK {
		t.Fatalf("egress-assignment 期望 200，实际 %d body=%s", wAccPut.Code, wAccPut.Body.String())
	}

	// 7. SSE watch 流：ready + changed + heartbeat
	srv := httptest.NewServer(h)
	defer srv.Close()
	sseCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	reqSSE, _ := http.NewRequestWithContext(sseCtx, http.MethodGet, srv.URL+UpstreamsWatchPath, nil)
	respSSE, err := http.DefaultClient.Do(reqSSE)
	if err != nil {
		t.Fatalf("连接 SSE watch 失败: %v", err)
	}
	defer respSSE.Body.Close()
	if ct := respSSE.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("SSE Content-Type 异常: %q", ct)
	}

	scanner := bufio.NewScanner(respSSE.Body)
	var lines []string
	var sawReady, sawChanged bool
	// 发送一条变更事件
	go func() {
		time.Sleep(15 * time.Millisecond)
		if mgr.watchCh != nil {
			mgr.watchCh <- runtimeegress.WatchEvent{Type: "egress-upstreams-changed", Reason: "probe", At: 1700000000200}
		}
	}()
	for scanner.Scan() {
		line := scanner.Text()
		lines = append(lines, line)
		if strings.HasPrefix(line, "data: ") {
			var evt map[string]any
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &evt) == nil {
				if evt["type"] == "ready" {
					sawReady = true
				}
				if evt["type"] == "egress-upstreams-changed" {
					sawChanged = true
					break
				}
			}
		}
	}
	if !sawReady || !sawChanged {
		t.Fatalf("SSE 未收到完整事件: ready=%v changed=%v lines=%v", sawReady, sawChanged, lines)
	}
}
