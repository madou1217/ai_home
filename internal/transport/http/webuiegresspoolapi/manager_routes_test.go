package webuiegresspoolapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
)

type fakePoolManager struct {
	describeResult *runtimeegress.PoolDescribeResult
	describeETag   string
	describeErr    error
	lastQuery      runtimeegress.PoolQueryOptions
	actionCalls    []string
	lastBlocked    bool
	lastReason     string
	lastPatch      runtimeegress.NodePolicyPatch
	groups         []runtimeegress.ResourceGroupView
	pools          []runtimeegress.ResourcePoolView
	nodeView       *runtimeegress.ResourceNodeView
	diagView       runtimeegress.AccountDiagnosticView
}

func (f *fakePoolManager) DescribePool(_ context.Context, query runtimeegress.PoolQueryOptions) (*runtimeegress.PoolDescribeResult, string, error) {
	f.lastQuery = query
	return f.describeResult, f.describeETag, f.describeErr
}

func (f *fakePoolManager) ProbePoolNodes(_ context.Context, nodeName string) runtimeegress.PoolActionResult {
	f.actionCalls = append(f.actionCalls, "probe:"+nodeName)
	return runtimeegress.PoolActionResult{OK: true}
}

func (f *fakePoolManager) SelectPoolNode(_ context.Context, nodeName string) runtimeegress.PoolActionResult {
	f.actionCalls = append(f.actionCalls, "select:"+nodeName)
	return runtimeegress.PoolActionResult{OK: true, Node: nodeName}
}

func (f *fakePoolManager) ClearPoolNodeCooldown(_ context.Context, nodeName string) runtimeegress.PoolActionResult {
	f.actionCalls = append(f.actionCalls, "clear-cooldown:"+nodeName)
	return runtimeegress.PoolActionResult{OK: true}
}

func (f *fakePoolManager) SetPoolNodeBlocked(_ context.Context, nodeName string, blocked bool, reason string) runtimeegress.PoolActionResult {
	f.actionCalls = append(f.actionCalls, "block:"+nodeName)
	f.lastBlocked = blocked
	f.lastReason = reason
	return runtimeegress.PoolActionResult{OK: true, Blocked: &blocked}
}

func (f *fakePoolManager) ReadNodePolicySummary(context.Context) runtimeegress.NodePolicySummary {
	return runtimeegress.NodePolicySummary{Summary: "ok"}
}

func (f *fakePoolManager) UpdateNodePolicy(_ context.Context, patch runtimeegress.NodePolicyPatch) runtimeegress.PoolActionResult {
	f.lastPatch = patch
	return runtimeegress.PoolActionResult{OK: true, NodePolicy: &runtimeegress.NodePolicySummary{Summary: "updated"}}
}

func (f *fakePoolManager) ClearDisabledNodePolicy(context.Context) runtimeegress.PoolActionResult {
	removed := 2
	return runtimeegress.PoolActionResult{OK: true, Removed: &removed}
}

func (f *fakePoolManager) ListPoolGroupsTree(context.Context) []runtimeegress.ResourceGroupView {
	return f.groups
}

func (f *fakePoolManager) ListPoolsView(context.Context) []runtimeegress.ResourcePoolView {
	return f.pools
}

func (f *fakePoolManager) GetPoolView(_ context.Context, poolID string) (*runtimeegress.ResourcePoolView, bool) {
	for i := range f.pools {
		if f.pools[i].PoolID == poolID {
			p := f.pools[i]
			return &p, true
		}
	}
	return nil, false
}

func (f *fakePoolManager) GetNodeView(_ context.Context, nodeID string) (*runtimeegress.ResourceNodeView, bool) {
	if f.nodeView != nil && f.nodeView.NodeID == nodeID {
		return f.nodeView, true
	}
	return nil, false
}

func (f *fakePoolManager) BuildDiagnosticView(_ context.Context, query runtimeegress.AccountDiagnosticQuery) runtimeegress.AccountDiagnosticView {
	out := f.diagView
	out.Query = query
	return out
}

func TestManagerModePaginationETagAndActions(t *testing.T) {
	t.Parallel()
	mgr := &fakePoolManager{
		describeETag: `W/"abc123"`,
		describeResult: &runtimeegress.PoolDescribeResult{
			Available:     true,
			Version:       "abc123",
			ServerTime:    1700000000000,
			BoundAccounts: []runtimeegress.BoundAccountSummary{},
			Pagination:    &runtimeegress.PoolPagination{Page: 1, PageSize: 20, Total: 1, PageCount: 1},
		},
		groups: []runtimeegress.ResourceGroupView{{PoolGroupID: "g1", Name: "G1", Enabled: true}},
		pools:  []runtimeegress.ResourcePoolView{{PoolID: "default", Name: "默认池", Enabled: true}},
		nodeView: &runtimeegress.ResourceNodeView{
			NodeID: "node_123",
			Name:   "HK-01",
		},
		diagView: runtimeegress.AccountDiagnosticView{Scope: "account_diagnostic"},
	}

	h, err := NewHandler(Dependencies{Authorizer: stubAuthorizer(true), Manager: mgr})
	if err != nil {
		t.Fatalf("NewHandler(Manager) error = %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, Path+"?page=1&pageSize=20&filter=healthy&query=hk", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Header().Get("ETag") != `W/"abc123"` {
		t.Fatalf("分页 GET 响应异常: code=%d etag=%q body=%s", rec.Code, rec.Header().Get("ETag"), rec.Body.String())
	}
	if !mgr.lastQuery.HasPage || mgr.lastQuery.Page != 1 || mgr.lastQuery.PageSize != 20 || mgr.lastQuery.Filter != "healthy" || mgr.lastQuery.Query != "hk" {
		t.Fatalf("分页参数解析异常: %+v", mgr.lastQuery)
	}

	req304 := httptest.NewRequest(http.MethodGet, Path+"?page=1", nil)
	req304.Header.Set("If-None-Match", `W/"abc123"`)
	rec304 := httptest.NewRecorder()
	h.ServeHTTP(rec304, req304)
	if rec304.Code != http.StatusNotModified {
		t.Fatalf("If-None-Match 期望 304，实际 %d", rec304.Code)
	}

	reqAction := httptest.NewRequest(http.MethodPost, Path+"/nodes/HK%2001/block", bytes.NewBufferString(`{"reason":"manual-test"}`))
	recAction := httptest.NewRecorder()
	h.ServeHTTP(recAction, reqAction)
	if recAction.Code != http.StatusOK || !mgr.lastBlocked || mgr.lastReason != "manual-test" {
		t.Fatalf("节点 block 响应异常: code=%d body=%s", recAction.Code, recAction.Body.String())
	}

	reqPolicy := httptest.NewRequest(http.MethodPost, PolicyPath, bytes.NewBufferString(`{"latency":{"enabled":true,"maxMs":1200}}`))
	recPolicy := httptest.NewRecorder()
	h.ServeHTTP(recPolicy, reqPolicy)
	if recPolicy.Code != http.StatusOK || mgr.lastPatch.Latency == nil || *mgr.lastPatch.Latency.MaxMS != 1200 {
		t.Fatalf("node-policy 更新异常: code=%d body=%s", recPolicy.Code, recPolicy.Body.String())
	}

	for _, tc := range []struct {
		path string
		code int
	}{
		{GroupsPath, http.StatusOK},
		{PoolsPath, http.StatusOK},
		{PoolsPath + "/default", http.StatusOK},
		{PoolsPath + "/missing", http.StatusNotFound},
		{"/v1/management/webui/egress-nodes/node_123", http.StatusOK},
		{"/v1/management/webui/egress-nodes/missing", http.StatusNotFound},
		{EvidencePath, http.StatusBadRequest},
		{EvidencePath + "?provider=claude", http.StatusOK},
	} {
		r := httptest.NewRequest(http.MethodGet, tc.path, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.code {
			t.Fatalf("%s 期望状态码 %d，实际 %d body=%s", tc.path, tc.code, w.Code, w.Body.String())
		}
	}

	reqBad := httptest.NewRequest(http.MethodPost, ProbePath, bytes.NewBufferString("{bad"))
	recBad := httptest.NewRecorder()
	h.ServeHTTP(recBad, reqBad)
	if recBad.Code != http.StatusBadRequest {
		t.Fatalf("非法 JSON 期望 400，实际 %d", recBad.Code)
	}
	var payload map[string]any
	_ = json.Unmarshal(recBad.Body.Bytes(), &payload)
	if payload["error"] != "invalid_json_body" {
		t.Fatalf("期望 invalid_json_body，实际 %+v", payload)
	}
}
