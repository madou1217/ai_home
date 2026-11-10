package webuiegresspoolapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"
)

const (
	nowMS           = int64(1794000000000)
	cooldownUntilMS = nowMS + 90_000
)

type stubAuthorizer bool

func (authorizer stubAuthorizer) Authorized(*http.Request) bool { return bool(authorizer) }

type fakeSource struct {
	pool Pool
	err  error
}

func (source fakeSource) ReadEgressPool(context.Context) (Pool, error) {
	return source.pool, source.err
}

type fakeHealth struct {
	ledger map[string]NodeHealth
	err    error
}

func (health fakeHealth) SnapshotNodeHealth(context.Context) (map[string]NodeHealth, error) {
	return health.ledger, health.err
}

func fixedNow() time.Time { return time.UnixMilli(nowMS) }

func samplePool() Pool {
	return Pool{
		Available: true,
		Status: Status{
			Ready:           true,
			ProxyURL:        "http://127.0.0.1:17890",
			ActiveNode:      "node-2",
			ProbeIntervalMS: 120_000,
			ProbePort:       17892,
			LaneSlots:       2,
		},
		Nodes: []Node{
			{
				Name:     "node-1",
				NodeID:   "node_entity_1",
				Label:    "东京 01",
				Protocol: "ss",
				Server:   "jp1.example.com",
				Port:     8388,
				Enabled:  true,
			},
			{
				Name:     "node-2",
				NodeID:   "node_entity_2",
				Label:    "新加坡 01",
				Protocol: "trojan",
				Server:   "sg1.example.com",
				Port:     443,
				Enabled:  true,
			},
			{
				Name:        "node-3",
				NodeID:      "node_entity_3",
				Label:       "洛杉矶 01",
				Protocol:    "vmess",
				Server:      "us1.example.com",
				Port:        8443,
				CountryCode: "US",
				CountryFlag: "🇺🇸",
				Enabled:     false,
			},
		},
	}
}

func newTestHandler(t *testing.T, dependencies Dependencies) *Handler {
	t.Helper()
	if dependencies.Now == nil {
		dependencies.Now = fixedNow
	}
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("NewHandler() 错误 = %v", err)
	}
	return handler
}

func doRequest(t *testing.T, handler http.Handler, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(method, target, nil))
	return recorder
}

// decodeBody 解开响应体；顺带确认是合法 JSON。
func decodeBody(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是合法 JSON：%v（%s）", err, recorder.Body.String())
	}
	return payload
}

func TestNewHandlerRejectsMissingDependencies(t *testing.T) {
	t.Parallel()
	cases := map[string]Dependencies{
		"缺鉴权":  {Source: fakeSource{pool: samplePool()}},
		"缺数据源": {Authorizer: stubAuthorizer(true)},
	}
	for name, dependencies := range cases {
		if _, err := NewHandler(dependencies); !errors.Is(err, ErrInvalidDependencies) {
			t.Errorf("%s：NewHandler() 错误 = %v，期望 ErrInvalidDependencies", name, err)
		}
	}
}

func TestServeHTTPRejectsUnauthorized(t *testing.T) {
	t.Parallel()
	handler := newTestHandler(t, Dependencies{
		Authorizer: stubAuthorizer(false),
		Source:     fakeSource{pool: samplePool()},
	})
	recorder := doRequest(t, handler, http.MethodGet, Path)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("状态码 = %d，期望 401", recorder.Code)
	}
	if got := recorder.Header().Get("WWW-Authenticate"); got != "Bearer" {
		t.Errorf("WWW-Authenticate = %q，期望 Bearer", got)
	}
	payload := decodeBody(t, recorder)
	if payload["ok"] != false || payload["error"] != "unauthorized" {
		t.Errorf("响应 = %v，期望 ok:false error:unauthorized", payload)
	}
}

func TestServeHTTPRejectsNonGet(t *testing.T) {
	t.Parallel()
	handler := newTestHandler(t, Dependencies{
		Authorizer: stubAuthorizer(true),
		Source:     fakeSource{pool: samplePool()},
	})
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		recorder := doRequest(t, handler, method, Path)
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s 状态码 = %d，期望 405", method, recorder.Code)
		}
		if got := recorder.Header().Get("Allow"); got != http.MethodGet {
			t.Errorf("%s Allow = %q，期望 GET", method, got)
		}
	}
}

func TestServeHTTPRejectsQueryParameters(t *testing.T) {
	t.Parallel()
	handler := newTestHandler(t, Dependencies{
		Authorizer: stubAuthorizer(true),
		Source:     fakeSource{pool: samplePool()},
	})
	recorder := doRequest(t, handler, http.MethodGet, Path+"?page=1")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("状态码 = %d，期望 400", recorder.Code)
	}
	if payload := decodeBody(t, recorder); payload["error"] != "invalid_query" {
		t.Errorf("响应 = %v，期望 error:invalid_query", payload)
	}
}

// 没有出口池服务：nodes 必须是 null（未知），不能是空数组（已知没有节点）。
func TestServeHTTPMarksPoolUnavailable(t *testing.T) {
	t.Parallel()
	handler := newTestHandler(t, Dependencies{
		Authorizer: stubAuthorizer(true),
		Source:     fakeSource{pool: Pool{Available: false}},
		Health:     fakeHealth{ledger: map[string]NodeHealth{}},
	})
	recorder := doRequest(t, handler, http.MethodGet, Path)
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", recorder.Code)
	}
	payload := decodeBody(t, recorder)
	if payload["available"] != false {
		t.Errorf("available = %v，期望 false", payload["available"])
	}
	if payload["status"] != nil {
		t.Errorf("status = %v，期望 null", payload["status"])
	}
	nodes, present := payload["nodes"]
	if !present {
		t.Fatal("响应缺少 nodes 键")
	}
	if nodes != nil {
		t.Errorf("nodes = %v，期望 null（不得用空数组冒充「没有节点」）", nodes)
	}
	if payload["version"] != "" {
		t.Errorf("version = %v，期望空串", payload["version"])
	}
	if !containsString(payload["unavailable_sources"], "egress_pool") {
		t.Errorf("unavailable_sources = %v，期望包含 egress_pool", payload["unavailable_sources"])
	}
	if payload["serverTime"] != float64(nowMS) {
		t.Errorf("serverTime = %v，期望 %d", payload["serverTime"], nowMS)
	}
}

// 账本读不出来：节点照给，冷却与探测整块不填，并标注 node_health。
func TestServeHTTPMarksHealthUnavailable(t *testing.T) {
	t.Parallel()
	handler := newTestHandler(t, Dependencies{
		Authorizer: stubAuthorizer(true),
		Source:     fakeSource{pool: samplePool()},
		Health:     fakeHealth{err: errors.New("账本读失败")},
	})
	recorder := doRequest(t, handler, http.MethodGet, Path)
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200（账本是可选事实源）", recorder.Code)
	}
	payload := decodeBody(t, recorder)
	if !containsString(payload["unavailable_sources"], "node_health") {
		t.Errorf("unavailable_sources = %v，期望包含 node_health", payload["unavailable_sources"])
	}
	if !containsString(payload["unfilled_fields"], "nodes[].probe") {
		t.Errorf("unfilled_fields = %v，期望包含 nodes[].probe", payload["unfilled_fields"])
	}
	nodes := payload["nodes"].([]any)
	first := nodes[0].(map[string]any)
	if first["probe"] != nil {
		t.Errorf("probe = %v，期望 null", first["probe"])
	}
	if first["cooling"] != false {
		t.Errorf("cooling = %v，期望 false", first["cooling"])
	}
	if status := payload["status"].(map[string]any); status["coolingCount"] != float64(0) {
		t.Errorf("coolingCount = %v，期望 0", status["coolingCount"])
	}
}

// 出口池配置读失败是硬失败：没有节点表就没有可标注的视图。
func TestServeHTTPFailsWhenSourceErrors(t *testing.T) {
	t.Parallel()
	handler := newTestHandler(t, Dependencies{
		Authorizer: stubAuthorizer(true),
		Source:     fakeSource{err: errors.New("配置损坏")},
	})
	recorder := doRequest(t, handler, http.MethodGet, Path)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("状态码 = %d，期望 503", recorder.Code)
	}
	if payload := decodeBody(t, recorder); payload["error"] != "egress_pool_unavailable" {
		t.Errorf("响应 = %v，期望 error:egress_pool_unavailable", payload)
	}
}

func TestServeHTTPNodeList(t *testing.T) {
	t.Parallel()
	handler := newTestHandler(t, Dependencies{
		Authorizer: stubAuthorizer(true),
		Source:     fakeSource{pool: samplePool()},
		Health: fakeHealth{ledger: map[string]NodeHealth{
			"node-1": {
				Probe: &Probe{OK: true, LatencyMS: 240, AtMS: nowMS - 5_000, Source: "core"},
			},
			"node-2": {
				Probe: &Probe{OK: true, LatencyMS: 180, AtMS: nowMS - 2_000, Source: "library"},
			},
		}},
	})
	recorder := doRequest(t, handler, http.MethodGet, Path)
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", recorder.Code)
	}
	payload := decodeBody(t, recorder)
	if payload["ok"] != true || payload["available"] != true {
		t.Fatalf("响应 = %v，期望 ok:true available:true", payload)
	}
	if payload["derived_by"] != derivedByGoPartial || payload["data_source"] != dataSource {
		t.Errorf("元数据 = %v / %v", payload["derived_by"], payload["data_source"])
	}
	if sources := asStrings(payload["unavailable_sources"]); len(sources) != 0 {
		t.Errorf("unavailable_sources = %v，期望空数组", sources)
	}
	if payload["version"] == "" {
		t.Error("version 为空，期望节点表指纹")
	}

	status := payload["status"].(map[string]any)
	if status["activeNode"] != "node-2" {
		t.Errorf("activeNode = %v，期望 node-2", status["activeNode"])
	}
	if status["activeNodeIndex"] != float64(1) {
		t.Errorf("activeNodeIndex = %v，期望 1", status["activeNodeIndex"])
	}
	if status["nodeCount"] != float64(3) {
		t.Errorf("nodeCount = %v，期望 3", status["nodeCount"])
	}
	if status["proxyUrl"] != "http://127.0.0.1:17890" {
		t.Errorf("proxyUrl = %v", status["proxyUrl"])
	}

	nodes := payload["nodes"].([]any)
	if len(nodes) != 3 {
		t.Fatalf("节点数 = %d，期望 3", len(nodes))
	}
	first := nodes[0].(map[string]any)
	if first["name"] != "node-1" || first["server"] != "jp1.example.com" || first["port"] != float64(8388) {
		t.Errorf("节点身份 = %v", first)
	}
	if first["enabled"] != true {
		t.Errorf("enabled = %v，期望 true", first["enabled"])
	}
	if first["cooling"] != false || first["cooldownUntil"] != float64(0) {
		t.Errorf("未冷却节点 = %v", first)
	}
	probe := first["probe"].(map[string]any)
	if probe["ok"] != true || probe["latencyMs"] != float64(240) || probe["source"] != "core" {
		t.Errorf("probe = %v", probe)
	}
	if probe["error"] != "" {
		t.Errorf("probe.error = %v，期望空串", probe["error"])
	}

	third := nodes[2].(map[string]any)
	if third["enabled"] != false {
		t.Errorf("enabled = %v，期望 false（订阅已停用）", third["enabled"])
	}
	if third["probe"] != nil {
		t.Errorf("probe = %v，期望 null（没探测过）", third["probe"])
	}
	if third["label"] != "洛杉矶 01" || third["countryCode"] != "US" {
		t.Errorf("展示字段 = %v", third)
	}
}

func TestServeHTTPCoolingNode(t *testing.T) {
	t.Parallel()
	handler := newTestHandler(t, Dependencies{
		Authorizer: stubAuthorizer(true),
		Source:     fakeSource{pool: samplePool()},
		Health: fakeHealth{ledger: map[string]NodeHealth{
			"node-1": {
				CooldownUntilMS: cooldownUntilMS,
				CooldownKind:    "network",
				Probe:           &Probe{OK: false, AtMS: nowMS - 1_000, Error: "probe_unreachable", Source: "core"},
			},
			"node-2": {
				Blocked:       true,
				BlockedReason: "latency_threshold",
				BlockedDetail: "延迟 1800ms 超过阈值",
				// 已到期的冷却不算冷却中。
				CooldownUntilMS: nowMS - 1_000,
				CooldownKind:    "network",
			},
			"node-3": {
				// 已废弃类别：账本加载时会清掉，这里同样不算冷却。
				CooldownUntilMS: cooldownUntilMS,
				CooldownKind:    legacyIPBlockedKind,
			},
		}},
	})
	recorder := doRequest(t, handler, http.MethodGet, Path)
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", recorder.Code)
	}
	payload := decodeBody(t, recorder)
	nodes := payload["nodes"].([]any)

	cooling := nodes[0].(map[string]any)
	if cooling["cooling"] != true {
		t.Fatalf("cooling = %v，期望 true", cooling["cooling"])
	}
	if cooling["cooldownUntil"] != float64(cooldownUntilMS) {
		t.Errorf("cooldownUntil = %v，期望 %d", cooling["cooldownUntil"], cooldownUntilMS)
	}
	if cooling["cooldownKind"] != "network" {
		t.Errorf("cooldownKind = %v，期望 network", cooling["cooldownKind"])
	}
	if cooling["cooldownRemainingMs"] != float64(cooldownUntilMS-nowMS) {
		t.Errorf("cooldownRemainingMs = %v，期望 %d", cooling["cooldownRemainingMs"], cooldownUntilMS-nowMS)
	}
	if probe := cooling["probe"].(map[string]any); probe["ok"] != false || probe["error"] != "probe_unreachable" {
		t.Errorf("probe = %v", probe)
	}

	blocked := nodes[1].(map[string]any)
	if blocked["blocked"] != true || blocked["blockedReason"] != "latency_threshold" {
		t.Errorf("拦截字段 = %v", blocked)
	}
	if blocked["cooling"] != false || blocked["cooldownUntil"] != float64(0) {
		t.Errorf("已到期冷却不该算冷却中：%v", blocked)
	}

	legacy := nodes[2].(map[string]any)
	if legacy["cooling"] != false {
		t.Errorf("ip_blocked 类别不该算冷却中：%v", legacy)
	}

	if status := payload["status"].(map[string]any); status["coolingCount"] != float64(1) {
		t.Errorf("coolingCount = %v，期望 1", status["coolingCount"])
	}
}

// 版本指纹只随展示字段变化：冷却剩余时间每毫秒都在变，不能进指纹。
func TestNodesVersionIgnoresRemainingTime(t *testing.T) {
	t.Parallel()
	base := newNodeView(samplePool().Nodes[0], NodeHealth{CooldownUntilMS: cooldownUntilMS, CooldownKind: "network"}, nowMS)
	later := newNodeView(samplePool().Nodes[0], NodeHealth{CooldownUntilMS: cooldownUntilMS, CooldownKind: "network"}, nowMS+1_000)
	if base.CooldownRemainingMS == later.CooldownRemainingMS {
		t.Fatal("用例无效：剩余时间应当不同")
	}
	if nodesVersion([]nodeView{base}) != nodesVersion([]nodeView{later}) {
		t.Error("冷却剩余时间变化不应改变节点表指纹")
	}
	changed := newNodeView(samplePool().Nodes[0], NodeHealth{CooldownUntilMS: cooldownUntilMS + 1_000, CooldownKind: "network"}, nowMS)
	if nodesVersion([]nodeView{base}) == nodesVersion([]nodeView{changed}) {
		t.Error("冷却截止变化应当改变节点表指纹")
	}
}

func containsString(value any, want string) bool {
	return slices.Contains(asStrings(value), want)
}

func asStrings(value any) []string {
	list, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(list))
	for _, item := range list {
		text, ok := item.(string)
		if !ok {
			return nil
		}
		result = append(result, text)
	}
	return result
}
