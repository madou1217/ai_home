package egress

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	_ "modernc.org/sqlite"
	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

func seedTestAccountRef(t *testing.T, ctx context.Context, aiHomeDir, accountRef, provider string, nowMS int64) {
	t.Helper()
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		t.Fatal(err)
	}
	_ = writeJSONKV(ctx, aiHomeDir, serverConfigKey, map[string]any{}, nowMS)
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	_, err = db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS account_refs (
			account_ref TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.ExecContext(ctx,
		`INSERT OR REPLACE INTO account_refs (account_ref, provider, created_at, updated_at) VALUES (?, ?, ?, ?)`,
		accountRef, provider, nowMS, nowMS,
	)
	if err != nil {
		t.Fatal(err)
	}
}

func TestIdentityAndRedaction(t *testing.T) {
	t.Parallel()
	id1 := BuildExitIdentity("VMESS", " Example.COM ", 443)
	id2 := BuildExitIdentity("vmess", "example.com", 443)
	if id1 == "" || id1 != id2 {
		t.Fatalf("期望一致规范化身份，实际 id1=%q id2=%q", id1, id2)
	}
	nodeID := BuildNodeEntityID("vmess", "example.com", 443)
	if !strings.HasPrefix(nodeID, "node_") || len(nodeID) != 29 {
		t.Fatalf("NodeID 格式异常: %q", nodeID)
	}
	if IsRoutableServer("127.0.0.1") || IsRoutableServer("0.0.0.0") || !IsRoutableServer("1.2.3.4") {
		t.Fatalf("IsRoutableServer 判定有误")
	}
	if !IsInformationalNode("剩余流量：100GB") || IsInformationalNode("JP-01") {
		t.Fatalf("IsInformationalNode 判定有误")
	}
	redacted := RedactProxyURL("http://alice:secret@127.0.0.1:7890/")
	if strings.Contains(redacted, "alice") || strings.Contains(redacted, "secret") || !strings.Contains(redacted, "***:***@") {
		t.Fatalf("代理凭据脱敏失败: %q", redacted)
	}
	if got := ExitKeyOfProxyURL("http://user:pass@10.0.0.5:8080"); got != "http://10.0.0.5:8080" {
		t.Fatalf("ExitKeyOfProxyURL = %q", got)
	}
}

func TestReadEgressPoolCatalogAndAggregator(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	nodesDoc := map[string]any{
		"version": 1,
		"subscriptions": []map[string]any{
			{"id": "sub1", "name": "Main", "enabled": true},
			{"id": "sub2", "name": "DisabledSub", "enabled": false},
		},
		"nodes": []map[string]any{
			{"id": "n1", "name": "US-Node-1", "protocol": "vmess", "server": "us1.example.com", "port": 443, "subscriptionId": "sub1", "countryCode": "US"},
			{"id": "n2", "name": "US-Dup", "protocol": "vmess", "server": "us1.example.com", "port": 443, "subscriptionId": "sub1"},
			{"id": "n3", "name": "JP-Node-1", "protocol": "trojan", "server": "jp1.example.com", "port": 443, "subscriptionId": "sub1"},
			{"id": "n4", "name": "Off-Node", "protocol": "ss", "server": "off.example.com", "port": 8388, "subscriptionId": "sub2"},
			{"id": "n5", "name": "过期时间：2026", "protocol": "ss", "server": "info.example.com", "port": 8388, "subscriptionId": "sub1"},
		},
	}
	rawNodes, _ := json.Marshal(nodesDoc)
	if err := os.WriteFile(filepath.Join(dir, "proxy-pool.json"), rawNodes, 0o600); err != nil {
		t.Fatal(err)
	}
	aggDoc := map[string]any{
		"version": 1,
		"profiles": []map[string]any{
			{
				"id":   "prof1",
				"name": "默认聚合",
				"sources": map[string]any{
					"all": true,
				},
				"groups": map[string]any{
					"custom": []map[string]any{
						{
							"id":   "cg-us",
							"name": "USGroup",
							"nodes": map[string]any{
								"include": "^US-",
							},
						},
					},
				},
			},
		},
	}
	rawAgg, _ := json.Marshal(aggDoc)
	if err := os.WriteFile(filepath.Join(dir, "subscription-aggregator.json"), rawAgg, 0o600); err != nil {
		t.Fatal(err)
	}

	res, err := ReadEgressPoolCatalog(dir)
	if err != nil {
		t.Fatalf("ReadEgressPoolCatalog error = %v", err)
	}
	if len(res.Nodes) != 2 {
		t.Fatalf("去重且过滤停用订阅后节点数 = %d，期望 2", len(res.Nodes))
	}
	if len(res.Groups) != 1 || res.Groups[0].Name != "USGroup" || len(res.Groups[0].Identities) != 1 {
		t.Fatalf("聚合分组展开结果异常: %+v", res.Groups)
	}
}

func TestNodePolicyAndHealthPickNext(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	ctx := context.Background()
	nowMS := int64(1_700_000_000_000)

	enabledTrue := true
	maxMS := float64(1500)
	pol, err := WriteNodePolicy(ctx, dir, NodePolicyPatch{
		Latency:     &LatencyPatch{Enabled: &enabledTrue, MaxMS: &maxMS},
		Unreachable: &UnreachablePatch{Enabled: &enabledTrue},
	}, nowMS)
	if err != nil {
		t.Fatalf("WriteNodePolicy error = %v", err)
	}
	pol, err = SetNodeDisabled(ctx, dir, "vmess|a.example.com|443", true, "Node-A", "manual", nowMS)
	if err != nil {
		t.Fatalf("SetNodeDisabled error = %v", err)
	}
	if d := DecideNode(pol, "vmess|a.example.com|443", nil); d.Status != "blocked" || d.Reason != "node_blocked_manual" {
		t.Fatalf("期望 node_blocked_manual 拦截，实际 %+v", d)
	}
	if d := DecideNode(pol, "vmess|b.example.com|443", &ProbeFact{OK: true, LatencyMS: 2200, At: nowMS}); d.Status != "blocked" || d.Reason != BlockReasonSlow {
		t.Fatalf("期望延迟拦截，实际 %+v", d)
	}
	if EffectiveProbeTimeoutMS(pol, 5000) != 5000 {
		t.Fatalf("EffectiveProbeTimeoutMS(1500, 5000) 应为 5000")
	}

	// 写入遗留 ip_blocked 冷却验证加载清理。
	healthPath := NodeHealthFilePath(dir)
	if err := os.MkdirAll(filepath.Dir(healthPath), 0o755); err != nil {
		t.Fatal(err)
	}
	legacyJSON, _ := json.Marshal(map[string]any{
		"version": 1,
		"nodes": map[string]any{
			"vmess|c.example.com|443": map[string]any{
				"cooldownKind":  "ip_blocked",
				"cooldownUntil": nowMS + 600_000,
			},
			"vmess|b.example.com|443": map[string]any{
				"probe": map[string]any{"ok": true, "latencyMs": 2200, "at": nowMS},
			},
		},
		"events": []any{},
	})
	if err := os.WriteFile(healthPath, legacyJSON, 0o600); err != nil {
		t.Fatal(err)
	}
	ledger := LoadNodeHealthLedger(dir, func() int64 { return nowMS })
	ledger.BindNodes([]ProxyNode{
		{Name: "Node-A", Protocol: "vmess", Server: "a.example.com", Port: 443},
		{Name: "Node-B", Protocol: "vmess", Server: "b.example.com", Port: 443},
		{Name: "Node-C", Protocol: "vmess", Server: "c.example.com", Port: 443},
	})
	if ledger.IsCooling("Node-C", nowMS) {
		t.Fatalf("遗留 ip_blocked 不应判为冷却")
	}
	picked := ledger.PickNext(-1, nil, nil, &pol, nowMS)
	if picked != 2 {
		t.Fatalf("Node-A disabled、Node-B latency_too_high，应选择索引 2(Node-C)，实际=%d", picked)
	}
	if removed, _, err := ClearDisabledNodes(ctx, dir, nowMS+1000); err != nil || removed != 1 {
		t.Fatalf("ClearDisabledNodes = (%d, %v)", removed, err)
	}
}

func TestEvaluateExitAndScopedEvidenceIsolation(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	dir := t.TempDir()
	nowMS := int64(1_700_000_000_000)

	if !CIDRContains("198.51.100.0/24", "198.51.100.42") || CIDRContains("198.51.100.0/24", "198.51.101.1") {
		t.Fatalf("CIDRContains 判定错误")
	}

	evStore := NewEvidenceStore(dir, func() int64 { return nowMS })
	recorded, reason, _ := evStore.RecordEvidence(ctx, UpstreamEvidenceEntry{
		Scope:      ScopeAccountUpstream,
		AccountRef: "acct_11111111111111111111",
		Provider:   "claude",
		UpstreamID: "api.anthropic.com",
		NodeID:     "node_jp",
		Status:     "blocked",
		Reason:     "region_denied:451",
		Source:     "traffic",
	})
	if !recorded {
		t.Fatalf("RecordEvidence failed: %s", reason)
	}
	scoped := evStore.ListEvidence(ctx, ScopedEvidenceQuery{UpstreamID: "api.anthropic.com"})

	v1 := EvaluateExit(ExitEvaluationInput{
		Exit:           ExitDescriptor{Identity: "vmess://jp.example.com:443", NodeID: "node_jp", Geo: &GeoLocation{Country: "JP"}},
		Hints:          UpstreamHints(&UpstreamInfo{ID: "api.anthropic.com", Provider: "claude", Official: true}),
		ScopedEvidence: scoped,
		Provider:       "claude",
		UpstreamID:     "api.anthropic.com",
		AccountRef:     "acct_11111111111111111111",
		NodeID:         "node_jp",
		NowMS:          nowMS + 1000,
	})
	if v1.Status != "denied" {
		t.Fatalf("同账号作用域证据应判 denied，实际=%+v", v1)
	}

	// 另一账号不应受 acct_1111... 的 account-scoped blocked 影响。
	v2 := EvaluateExit(ExitEvaluationInput{
		Exit:           ExitDescriptor{Identity: "vmess://jp.example.com:443", NodeID: "node_jp", Geo: &GeoLocation{Country: "JP"}},
		Hints:          UpstreamHints(&UpstreamInfo{ID: "api.anthropic.com", Provider: "claude", Official: true}),
		ScopedEvidence: scoped,
		Provider:       "claude",
		UpstreamID:     "api.anthropic.com",
		AccountRef:     "acct_22222222222222222222",
		NodeID:         "node_jp",
		NowMS:          nowMS + 1000,
	})
	if v2.Status == "denied" {
		t.Fatalf("跨账号不应污染，实际=%+v", v2)
	}
}

func TestComputeEgressPlanStickyAndDowngrade(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	ctx := context.Background()
	nodes := []PlannerNode{
		{Name: "US-1", NodeID: "node_1", Identity: "vmess://us1:443", Geo: &GeoLocation{Country: "US"}},
		{Name: "HK-1", NodeID: "node_2", Identity: "vmess://hk1:443", Geo: &GeoLocation{Country: "HK"}},
	}
	acc1 := "acct_aaaaaaaaaaaaaaaaaaaa"
	acc2 := "acct_bbbbbbbbbbbbbbbbbbbb"
	plan := ComputeEgressPlan(ctx, PlanInput{
		AIHomeDir: dir,
		Accounts: []AccountRecord{
			{AccountRef: acc1, Provider: "claude"},
			{AccountRef: acc2, Provider: "claude"},
		},
		Nodes:     nodes,
		LaneSlots: 1,
		Assignments: []AccountEgressAssignment{
			{AccountRef: acc1, Strategy: "sticky", Scope: agyegress.PoolScope{Kind: "all", Groups: []string{}, Nodes: []string{}}},
			{AccountRef: acc2, Strategy: "sticky", Scope: agyegress.PoolScope{Kind: "all", Groups: []string{}, Nodes: []string{}}},
		},
		NowMS: 1_700_000_000_000,
	})
	if len(plan.Plan) != 1 || plan.Plan[0].Strategy != "shared" {
		t.Fatalf("槽位只有 1 个时两个 sticky 应降级合并为 1 条 shared 车道: %+v", plan.Plan)
	}
	if !plan.Accounts[acc1].Downgraded || !plan.Accounts[acc2].Downgraded {
		t.Fatalf("两个账号都应标记 Downgraded")
	}
	if len(plan.Plan[0].Allowed) != 1 || plan.Plan[0].Allowed[0] != "US-1" {
		t.Fatalf("claude 官方应排除 HK 节点只保留 US-1: %+v", plan.Plan[0].Allowed)
	}
}

func TestManagerWithMockMihomoAndAccountAssignment(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	ctx := context.Background()

	// Mock 上游：返回 451 / 401
	var upstreamHits int
	upstreamSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		if r.Header.Get("X-Test-Block") == "1" {
			w.WriteHeader(http.StatusUnavailableForLegalReasons)
			_, _ = io.WriteString(w, `{"error":"country not supported"}`)
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"error":"unauthorized"}`)
	}))
	defer upstreamSrv.Close()

	var mu sync.Mutex
	selectedByGroup := map[string]string{
		"GLOBAL":    "US-01",
		"AIH-PROBE": "US-01",
		"LANE-0":    "US-01",
	}

	// Mock 探测入站（充当 HTTP Proxy 转发到 upstreamSrv）
	probeProxySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		activeProbe := selectedByGroup["AIH-PROBE"]
		mu.Unlock()
		targetReq, err := http.NewRequestWithContext(r.Context(), r.Method, upstreamSrv.URL+r.URL.Path, nil)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		if activeProbe == "HK-01" {
			targetReq.Header.Set("X-Test-Block", "1")
		}
		resp, err := http.DefaultClient.Do(targetReq)
		if err != nil {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	}))
	defer probeProxySrv.Close()
	probeParsed, _ := url.Parse(probeProxySrv.URL)
	probePort, _ := strconv.Atoi(probeParsed.Port())

	// Mock Mihomo Controller
	ctrlSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/version":
			_, _ = io.WriteString(w, `{"version":"1.18"}`)
		case r.Method == http.MethodGet && r.URL.Path == "/proxies":
			mu.Lock()
			payload := map[string]any{
				"proxies": map[string]any{
					"GLOBAL":    map[string]any{"name": "GLOBAL", "now": selectedByGroup["GLOBAL"]},
					"AIH-PROBE": map[string]any{"name": "AIH-PROBE", "now": selectedByGroup["AIH-PROBE"]},
					"LANE-0":    map[string]any{"name": "LANE-0", "now": selectedByGroup["LANE-0"]},
				},
			}
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(payload)
		case r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/proxies/"):
			group := strings.TrimPrefix(r.URL.Path, "/proxies/")
			group, _ = url.PathUnescape(group)
			var body struct {
				Name string `json:"name"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			selectedByGroup[group] = body.Name
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/delay"):
			_, _ = io.WriteString(w, `{"delay":123}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer ctrlSrv.Close()
	ctrlParsed, _ := url.Parse(ctrlSrv.URL)
	ctrlPort, _ := strconv.Atoi(ctrlParsed.Port())

	// 写入 <aiHomeDir>/proxy-pool.json 与 run/egress-pool/{config.json,state.json}
	runDir := filepath.Join(dir, "run", "egress-pool")
	_ = os.MkdirAll(runDir, 0o755)

	nodesJSON, _ := json.Marshal(map[string]any{
		"version": 1,
		"nodes": []map[string]any{
			{"id": "n1", "name": "US-01", "protocol": "vmess", "server": "us1.example.com", "port": 443, "countryCode": "US"},
			{"id": "n2", "name": "HK-01", "protocol": "vmess", "server": "hk1.example.com", "port": 443, "countryCode": "HK"},
		},
	})
	_ = os.WriteFile(filepath.Join(dir, "proxy-pool.json"), nodesJSON, 0o600)

	cfgJSON, _ := json.Marshal(map[string]any{
		"mixed-port":          19000,
		"external-controller": fmt.Sprintf("127.0.0.1:%d", ctrlPort),
		"secret":              "test-secret",
		"listeners": []map[string]any{
			{"name": "probe-in", "port": probePort, "proxy": "AIH-PROBE"},
			{"name": "lane-0", "port": 20001, "proxy": "LANE-0"},
		},
		"proxies": []map[string]any{
			{"name": "US-01", "type": "vmess", "server": "us1.example.com", "port": 443},
			{"name": "HK-01", "type": "vmess", "server": "hk1.example.com", "port": 443},
		},
	})
	_ = os.WriteFile(filepath.Join(runDir, "config.json"), cfgJSON, 0o600)

	stateJSON, _ := json.Marshal(map[string]any{
		"version":        1,
		"ownerPid":       os.Getpid(),
		"corePid":        os.Getpid(),
		"proxyUrl":       "http://127.0.0.1:19000",
		"controllerPort": ctrlPort,
		"secret":         "test-secret",
		"lanes":          map[string]string{},
	})
	_ = os.WriteFile(filepath.Join(runDir, "state.json"), stateJSON, 0o600)

	// 在 app-state.db account_refs 表写入账号，并在 KV 写入 config:server
	accRef := "acct_1234567890abcdef1234"
	nowMS := time.Now().UnixMilli()
	seedTestAccountRef(t, ctx, dir, accRef, "claude", nowMS)
	_ = writeJSONKV(ctx, dir, serverConfigKey, map[string]any{
		"claude_base_url": upstreamSrv.URL,
	}, nowMS)

	mgr := NewManager(ManagerOptions{
		AIHomeDir:            dir,
		PIDAlive:             func(pid int) bool { return pid == os.Getpid() },
		DisableAutoDirectGeo: true,
	})
	mgr.health.RecordGeo("US-01", GeoLocation{Country: "US", IP: "1.1.1.1", At: nowMS})
	mgr.health.RecordGeo("HK-01", GeoLocation{Country: "HK", IP: "2.2.2.2", At: nowMS})
	_ = mgr.health.Save()

	desc, etag, err := mgr.DescribePool(ctx, PoolQueryOptions{HasPage: true, Page: 1, PageSize: 1, Filter: "all"})
	if err != nil || !desc.Available || !desc.Status.Ready || etag == "" {
		t.Fatalf("DescribePool 失败: desc=%+v err=%v", desc, err)
	}
	if desc.Pagination == nil || desc.Pagination.Total != 2 || len(desc.Nodes) != 1 {
		t.Fatalf("DescribePool 分页异常: %+v", desc.Pagination)
	}

	sel := mgr.SelectPoolNode(ctx, "HK-01")
	if !sel.OK || selectedByGroup["GLOBAL"] != "HK-01" {
		t.Fatalf("SelectPoolNode 未切到 HK-01: %+v", sel)
	}

	pr := mgr.ProbePoolNodes(ctx, "US-01")
	if !pr.OK || len(pr.Results) != 1 || !pr.Results[0].OK || pr.Results[0].LatencyMS != 123 {
		t.Fatalf("ProbePoolNodes 异常: %+v", pr)
	}

	blk := mgr.SetPoolNodeBlocked(ctx, "HK-01", true, "bad")
	if !blk.OK || blk.Blocked == nil || !*blk.Blocked {
		t.Fatalf("SetPoolNodeBlocked 异常: %+v", blk)
	}
	unblk := mgr.SetPoolNodeBlocked(ctx, "HK-01", false, "")
	if !unblk.OK || unblk.Blocked == nil || *unblk.Blocked {
		t.Fatalf("SetPoolNodeBlocked(false) 异常: %+v", unblk)
	}

	// 测试 PutAccountEgressAssignment 与 ValidateAccountPath
	acc, st, code := mgr.ValidateAccountPath(ctx, "claude", accRef)
	if st != http.StatusOK || acc == nil {
		t.Fatalf("ValidateAccountPath 失败: %d %s", st, code)
	}
	putRes, st, code := mgr.PutAccountEgressAssignment(ctx, *acc, map[string]any{
		"strategy": "sticky",
		"scope":    map[string]any{"kind": "all", "groups": []string{}, "nodes": []string{}},
	})
	if st != http.StatusOK || putRes["ok"] != true {
		t.Fatalf("PutAccountEgressAssignment 失败: %d %s %+v", st, code, putRes)
	}

	// 测试经 HK-01 探测上游返回 blocked(region_denied:451)
	upRes := mgr.ProbeUpstreamViaNode(ctx, &UpstreamInfo{
		ID:       "127.0.0.1",
		Host:     "127.0.0.1",
		BaseURL:  upstreamSrv.URL,
		Provider: "claude",
	}, "HK-01")
	if upRes.Status != "blocked" || !strings.Contains(upRes.Reason, "451") {
		t.Fatalf("HK-01 探测上游应返回 blocked(451)，实际 %+v", upRes)
	}
	if upstreamHits == 0 {
		t.Fatalf("期望上游服务收到探测请求")
	}
}
