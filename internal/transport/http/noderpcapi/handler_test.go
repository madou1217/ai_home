package noderpcapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountsapi"
)

type stubAuth struct{ allow bool }

func (s stubAuth) Authorized(_ *http.Request) bool { return s.allow }

type stubRows struct{ rows []webuiaccountsapi.Row }

func (s stubRows) ListAccountRows(_ context.Context, _ webuiaccountsapi.Query) (webuiaccountsapi.Result, error) {
	return webuiaccountsapi.Result{Rows: s.rows}, nil
}

type stubOverviews struct{ items []accountapp.AccountOverview }

func (s stubOverviews) ListAccountOverviews(_ context.Context, _ accountapp.OverviewQuery) ([]accountapp.AccountOverview, error) {
	return s.items, nil
}

type stubStates struct{ items []runtimecore.AccountState }

func (s stubStates) ListAccountStates(_ context.Context) ([]runtimecore.AccountState, error) {
	return s.items, nil
}

type stubRuntime struct{ views []runtimeapp.AccountView }

func (s stubRuntime) RuntimeSnapshot() []runtimeapp.AccountView { return s.views }

type stubStamp struct{ stamp accountapp.AccountModelCatalogStamp }

func (s stubStamp) AccountModelCatalogStamp(_ context.Context) (accountapp.AccountModelCatalogStamp, error) {
	return s.stamp, nil
}

func doRPC(t *testing.T, h http.Handler, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestGuardsAndUnknownRPC(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); err == nil {
		t.Fatal("缺少鉴权器应当报错")
	}
	unauth, _ := NewHandler(Dependencies{Authorizer: stubAuth{allow: false}})
	if rec := doRPC(t, unauth, http.MethodGet, Prefix+"device-status"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("未鉴权期望 401，实际 %d", rec.Code)
	}
	h, _ := NewHandler(Dependencies{Authorizer: stubAuth{allow: true}})
	if rec := doRPC(t, h, http.MethodPost, Prefix+"device-status"); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST 期望 405，实际 %d", rec.Code)
	}
	for _, target := range []string{Prefix + "unknown-op", WebUIPrefix + "unknown-op"} {
		rec := doRPC(t, h, http.MethodGet, target)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s 期望 404，实际 %d", target, rec.Code)
		}
		var body map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if body["ok"] != false || body["error"] != "rpc_not_found" {
			t.Fatalf("%s 错误载荷不符: %+v", target, body)
		}
	}
}

func TestDeviceStatusNodesAndAccountsAcrossBothPrefixes(t *testing.T) {
	hostHome := t.TempDir()
	aiHome := filepath.Join(hostHome, ".ai_home")
	_ = os.MkdirAll(aiHome, 0o755)
	dbPath, err := appstate.DatabasePath(aiHome)
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1700000120000).UTC()
	started := now.Add(-12 * time.Second)
	_ = appstate.WriteKV(context.Background(), dbPath, "config:server", `{"strategy":"least-used"}`, now.UnixMilli())

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatal(err)
	}
	ref1 := accountcore.AccountRef("acct_11111111111111111111")
	ref2 := accountcore.AccountRef("acct_22222222222222222222")

	state1, err := runtimecore.NewAccountState(runtimecore.AccountStateInput{
		AccountRef: ref1,
		Document:   []byte(`{"successCount":10,"failCount":2,"lastRefresh":1700000100000,"modelCooldowns":{"m1":1700000200000,"m2":1700000000000}}`),
		UpdatedAt:  now.Add(-5 * time.Second),
	})
	if err != nil {
		t.Fatal(err)
	}
	state2, err := runtimecore.NewAccountState(runtimecore.AccountStateInput{
		AccountRef: ref2,
		Document:   []byte(`{"successCount":3,"failCount":5}`),
		UpdatedAt:  now,
	})
	if err != nil {
		t.Fatal(err)
	}

	pct := 88.5
	h, err := NewHandler(Dependencies{
		Authorizer: stubAuth{allow: true},
		AIHomeDir:  aiHome,
		Catalog:    catalog,
		AccountRows: stubRows{rows: []webuiaccountsapi.Row{
			{AccountRef: string(ref1), Provider: "claude", DisplayName: "Claude Main", Enabled: true, PlanType: "pro", RemainingPct: &pct},
			{AccountRef: string(ref2), Provider: "codex", Email: "c@example.com", Enabled: false, APIKeyMode: true, AuthMode: "api-key"},
		}},
		States:           stubStates{items: []runtimecore.AccountState{state1, state2}},
		Runtime:          stubRuntime{views: []runtimeapp.AccountView{{AccountRef: ref2, Blocks: []runtimecore.RecoveryTrigger{"usage_snapshot"}}}},
		ModelStampReader: stubStamp{stamp: accountapp.AccountModelCatalogStamp{Generation: 2, UpdatedAtMS: 1700000111000}},
		Hostname:         "mac-mini.local",
		StartedAt:        started,
		Now:              func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}

	// device-status on both /v1/management/node-rpc and /v1/management/webui/node-rpc
	for _, path := range []string{Prefix + "device-status", WebUIPrefix + "device-status"} {
		rec := doRPC(t, h, http.MethodGet, path)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s 期望 200，实际 %d body=%s", path, rec.Code, rec.Body.String())
		}
		var payload struct {
			OK     bool   `json:"ok"`
			RPC    string `json:"rpc"`
			Result struct {
				Status map[string]any `json:"status"`
			} `json:"result"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if !payload.OK || payload.RPC != "control_plane.device.status" {
			t.Fatalf("头部不符: %+v", payload)
		}
		st := payload.Result.Status
		if st["service"] != "aih-control-plane" || st["strategy"] != "least-used" {
			t.Fatalf("status 字段不符: %+v", st)
		}
		if int(st["uptimeSec"].(float64)) != 12 || int(st["totalAccounts"].(float64)) != 2 || int(st["activeAccounts"].(float64)) != 1 || int(st["cooldownAccounts"].(float64)) != 1 {
			t.Fatalf("计数不符: %+v", st)
		}
		if int64(st["modelsUpdatedAt"].(float64)) != 1700000111000 {
			t.Fatalf("modelsUpdatedAt 不符: %+v", st["modelsUpdatedAt"])
		}
	}

	// device-nodes
	nodesRec := doRPC(t, h, http.MethodGet, WebUIPrefix+"device-nodes")
	if nodesRec.Code != http.StatusOK {
		t.Fatal(nodesRec.Code)
	}
	var nodesResp struct {
		OK     bool   `json:"ok"`
		RPC    string `json:"rpc"`
		Result struct {
			Nodes []map[string]any `json:"nodes"`
		} `json:"result"`
	}
	_ = json.Unmarshal(nodesRec.Body.Bytes(), &nodesResp)
	wantID := DeriveDeviceID("mac-mini.local", aiHome)
	if len(nodesResp.Result.Nodes) != 1 || nodesResp.Result.Nodes[0]["id"] != wantID || nodesResp.Result.Nodes[0]["name"] != "mac-mini.local" {
		t.Fatalf("nodes 不符: %+v", nodesResp)
	}

	// device-accounts
	acctsRec := doRPC(t, h, http.MethodGet, Prefix+"device-accounts")
	if acctsRec.Code != http.StatusOK {
		t.Fatal(acctsRec.Code)
	}
	var acctsResp struct {
		OK     bool   `json:"ok"`
		RPC    string `json:"rpc"`
		Result struct {
			Accounts []deviceAccountItem `json:"accounts"`
			Summary  map[string]any      `json:"summary"`
		} `json:"result"`
	}
	if err := json.Unmarshal(acctsRec.Body.Bytes(), &acctsResp); err != nil {
		t.Fatal(err)
	}
	if len(acctsResp.Result.Accounts) != 2 {
		t.Fatalf("期望 2 条账号，实际 %d", len(acctsResp.Result.Accounts))
	}
	a1 := acctsResp.Result.Accounts[0]
	a2 := acctsResp.Result.Accounts[1]
	if a1.Status != "up" || a1.RuntimeStatus != "healthy" || a1.ModelCooldownCount != 1 || a1.SuccessCount != 10 || a1.FailCount != 2 || a1.RemainingPct == nil || *a1.RemainingPct != 88.5 {
		t.Fatalf("账号1字段不符: %+v", a1)
	}
	if a2.Status != "down" || a2.AuthMode != "api-key" || a2.RuntimeStatus != "rate_limited" || a2.RemainingPct != nil {
		t.Fatalf("账号2(Runtime 叠加层优先)不符: %+v", a2)
	}
}

func TestDeviceAccountsOverviewFallback(t *testing.T) {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatal(err)
	}
	ref := accountcore.AccountRef("acct_0123456789abcdef0123")
	now := time.UnixMilli(1700000100000).UTC()
	acct, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref:          ref,
		ProviderID:   "claude",
		CLIAccountID: accountcore.CLIAccountID(1),
		Enabled:      true,
		CreatedAt:    now,
		UpdatedAt:    now,
	})
	if err != nil {
		t.Fatal(err)
	}
	qs, err := accountapp.NewAccountQuotaState(accountapp.AccountQuotaStateInput{
		Found:               true,
		Status:              "available",
		RemainingBPS:        7500,
		HasNumericRemaining: true,
		CapturedAt:          now,
	})
	if err != nil {
		t.Fatal(err)
	}
	ov, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account:          acct,
		HasCredential:    true,
		AuthKind:         "api_key",
		AuthMode:         "api_key",
		HasProfile:       true,
		DisplayName:      "OV User",
		SubscriptionKind: "team",
		ProfileUpdatedAt: now,
		QuotaState:       qs,
	})
	if err != nil {
		t.Fatal(err)
	}
	h, _ := NewHandler(Dependencies{
		Authorizer:    stubAuth{allow: true},
		OverviewStore: stubOverviews{items: []accountapp.AccountOverview{ov}},
		Now:           func() time.Time { return now },
	})
	rec := doRPC(t, h, http.MethodGet, Prefix+"device-accounts")
	if rec.Code != http.StatusOK {
		t.Fatal(rec.Code)
	}
	var resp struct {
		Result struct {
			Accounts []deviceAccountItem `json:"accounts"`
		} `json:"result"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp.Result.Accounts) != 1 || resp.Result.Accounts[0].RemainingPct == nil || *resp.Result.Accounts[0].RemainingPct != 75.0 || resp.Result.Accounts[0].AuthMode != "api-key" {
		t.Fatalf("OverviewStore 兜底结果不符: %+v", resp.Result.Accounts)
	}
}

func TestDeviceSessionsAndMessagesCanonicalAndLegacy(t *testing.T) {
	hostHome := t.TempDir()
	aiHome := filepath.Join(hostHome, ".ai_home")
	chatDir := filepath.Join(aiHome, "chat-sessions")
	_ = os.MkdirAll(chatDir, 0o755)

	// 1. Legacy 会话
	_ = os.WriteFile(filepath.Join(chatDir, "leg-chat.json"), []byte(`{
		"id":"leg-chat",
		"provider":"claude",
		"title":"旧聊天",
		"createdAt":100,
		"updatedAt":300,
		"messages":[
			{"role":"user","content":"hi legacy","timestamp":110},
			{"role":"assistant","content":"hello back","timestamp":120}
		]
	}`), 0o600)

	// 2. Canonical 会话 + 时间线事件 + 原生线程兜底会话
	dbPath, err := appstate.DatabasePath(aiHome)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	db, err := appstate.OpenWritable(ctx, dbPath)
	if err != nil {
		t.Fatal(err)
	}
	schema := `
	CREATE TABLE chat_runtime_sessions (
		session_id TEXT PRIMARY KEY, provider TEXT NOT NULL, execution_account_ref TEXT NOT NULL,
		project_path TEXT NOT NULL, state TEXT NOT NULL, runtime_binding_json TEXT NOT NULL,
		capability_snapshot_json TEXT NOT NULL, policy_json TEXT NOT NULL, active_turn_json TEXT,
		last_event_seq INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
	);
	CREATE TABLE chat_runtime_events (
		event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, schema TEXT NOT NULL,
		type TEXT NOT NULL, at INTEGER NOT NULL, turn_id TEXT, run_id TEXT, item_id TEXT,
		source_json TEXT NOT NULL, payload_json TEXT NOT NULL
	);
	CREATE TABLE chat_runtime_native_thread_items (
		session_id TEXT NOT NULL, native_thread_id TEXT NOT NULL, native_turn_id TEXT NOT NULL,
		item_id TEXT NOT NULL, item_json TEXT NOT NULL, raw_message_id TEXT, ordinal INTEGER NOT NULL,
		PRIMARY KEY (session_id, item_id)
	);`
	if _, err := db.ExecContext(ctx, schema); err != nil {
		t.Fatal(err)
	}
	_, _ = db.ExecContext(ctx, `INSERT INTO chat_runtime_sessions VALUES ('can-1', 'codex', 'acct_1', '', 'idle', '{}', '{}', '{"title":"新架构讨论"}', NULL, 4, 200, 500)`)
	_, _ = db.ExecContext(ctx, `INSERT INTO chat_runtime_events VALUES
		('e1','can-1',1,'v1','timeline.item.completed',210,NULL,NULL,'i1','{}','{"item":{"id":"i1","kind":"message","detail":{"role":"user"},"content":"question 1","at":210}}'),
		('e2','can-1',2,'v1','timeline.item.started',220,NULL,NULL,'i2','{}','{"item":{"id":"i2","kind":"assistant_message","detail":{"role":"assistant"},"content":"ans","at":220}}'),
		('e3','can-1',3,'v1','timeline.item.delta',225,NULL,NULL,'i2','{}','{"itemId":"i2","chunk":"wer 1"}'),
		('e4','can-1',4,'v1','timeline.item.completed',230,NULL,NULL,'i3','{}','{"item":{"id":"i3","kind":"tool_call","text":"ignored tool"}}')`)

	_, _ = db.ExecContext(ctx, `INSERT INTO chat_runtime_sessions VALUES ('can-native', 'claude', 'acct_1', '', 'idle', '{}', '{}', '{"title":"原生兜底"}', NULL, 0, 150, 200)`)
	_, _ = db.ExecContext(ctx, `INSERT INTO chat_runtime_native_thread_items VALUES ('can-native', 't1', 'turn1', 'n1', '{"role":"user","content":"from native thread","createdAt":155}', NULL, 1)`)
	_ = db.Close()

	h, _ := NewHandler(Dependencies{
		Authorizer:  stubAuth{allow: true},
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		Hostname:    "node-box",
	})
	localID := DeriveDeviceID("node-box", aiHome)

	// device-sessions 倒序: can-1(500), leg-chat(300), can-native(200)
	sessRec := doRPC(t, h, http.MethodGet, Prefix+"device-sessions")
	if sessRec.Code != http.StatusOK {
		t.Fatalf("device-sessions 失败: %d %s", sessRec.Code, sessRec.Body.String())
	}
	var sessResp struct {
		Result deviceSessionsResult `json:"result"`
	}
	_ = json.Unmarshal(sessRec.Body.Bytes(), &sessResp)
	if sessResp.Result.Summary.Total != 3 || sessResp.Result.Sessions[0].SessionRef != "can-1" || sessResp.Result.Sessions[1].SessionRef != "leg-chat" {
		t.Fatalf("device-sessions 合并排序不符: %+v", sessResp.Result)
	}

	// device-node-sessions: mismatch -> empty, match -> 3
	foreignRec := doRPC(t, h, http.MethodGet, Prefix+"device-node-sessions?nodeId=node-other")
	var foreignResp struct {
		NodeID string               `json:"nodeId"`
		Result deviceSessionsResult `json:"result"`
	}
	_ = json.Unmarshal(foreignRec.Body.Bytes(), &foreignResp)
	if foreignResp.NodeID != "node-other" || foreignResp.Result.Summary.Total != 0 || len(foreignResp.Result.Sessions) != 0 {
		t.Fatalf("非本机 nodeId 应返回空列表: %+v", foreignResp)
	}
	matchRec := doRPC(t, h, http.MethodGet, WebUIPrefix+"device-node-sessions?nodeId="+localID)
	var matchResp struct {
		Result deviceSessionsResult `json:"result"`
	}
	_ = json.Unmarshal(matchRec.Body.Bytes(), &matchResp)
	if matchResp.Result.Summary.Total != 3 {
		t.Fatalf("本机 nodeId 期望 3 条会话: %+v", matchResp)
	}

	// device-session-messages: 404 on unknown
	missRec := doRPC(t, h, http.MethodGet, Prefix+"device-session-messages?sessionRef=nope")
	if missRec.Code != http.StatusNotFound {
		t.Fatalf("不存在会话期望 404，实际 %d", missRec.Code)
	}

	// can-1 with delta + limit + debug=1
	msgRec := doRPC(t, h, http.MethodGet, WebUIPrefix+"device-session-messages?sessionRef=can-1&limit=1&debug=1")
	if msgRec.Code != http.StatusOK {
		t.Fatalf("消息读取失败: %d %s", msgRec.Code, msgRec.Body.String())
	}
	var msgResp struct {
		RPC    string               `json:"rpc"`
		Result deviceMessagesResult `json:"result"`
	}
	_ = json.Unmarshal(msgRec.Body.Bytes(), &msgResp)
	if msgResp.RPC != "control_plane.device.session_messages" || msgResp.Result.Summary.Total != 2 || msgResp.Result.Summary.Returned != 1 || !msgResp.Result.Summary.Truncated {
		t.Fatalf("分页摘要不符: %+v", msgResp)
	}
	if msgResp.Result.Messages[0].Role != "assistant" || msgResp.Result.Messages[0].Content != "answer 1" {
		t.Fatalf("delta 合并结果不符: %+v", msgResp.Result.Messages)
	}
	if msgResp.Result.Debug == nil || msgResp.Result.Debug.ItemCount != 3 || len(msgResp.Result.Debug.Kinds) != 3 {
		t.Fatalf("debug 形状不符: %+v", msgResp.Result.Debug)
	}

	// native thread items 兜底
	nativeRec := doRPC(t, h, http.MethodGet, Prefix+"device-node-session-messages?nodeId="+localID+"&sessionRef=can-native")
	var nativeResp struct {
		RPC    string               `json:"rpc"`
		NodeID string               `json:"nodeId"`
		Result deviceMessagesResult `json:"result"`
	}
	_ = json.Unmarshal(nativeRec.Body.Bytes(), &nativeResp)
	if nativeResp.RPC != "control_plane.device.node_session_messages" || nativeResp.NodeID != localID || len(nativeResp.Result.Messages) != 1 || nativeResp.Result.Messages[0].Content != "from native thread" {
		t.Fatalf("native_thread_items 兜底失败: %+v", nativeResp)
	}

	// legacy JSON 消息读取（无 debug 字段）
	legRec := doRPC(t, h, http.MethodGet, Prefix+"device-session-messages?sessionRef=leg-chat")
	var legResp struct {
		Result deviceMessagesResult `json:"result"`
	}
	_ = json.Unmarshal(legRec.Body.Bytes(), &legResp)
	if len(legResp.Result.Messages) != 2 || legResp.Result.Debug != nil {
		t.Fatalf("legacy 消息或 debug 省略不符: %+v", legResp)
	}
}
