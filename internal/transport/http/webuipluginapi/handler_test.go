package webuipluginapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/pluginerr"
	"github.com/madou1217/ai_home/internal/runtime/pluginhost"
	"github.com/madou1217/ai_home/internal/runtime/pricingcatalog"
)

type stubAuth struct{ allowed bool }

func (s stubAuth) Authorized(*http.Request) bool { return s.allowed }

type stubHostClient struct {
	running bool
	invHook func(gen int64, cid string, val any) (json.RawMessage, []byte, error)
}

func (c *stubHostClient) Start(context.Context) error { c.running = true; return nil }
func (c *stubHostClient) Stop(context.Context) error  { c.running = false; return nil }
func (c *stubHostClient) Prepare(_ context.Context, generation int64, plugins []pluginhost.PluginSpec) (pluginhost.HostPrepareResult, error) {
	var contribs []string
	for _, p := range plugins {
		if raw, ok := p.Manifest["contributes"].([]any); ok {
			for _, item := range raw {
				if m, ok := item.(map[string]any); ok {
					if id, _ := m["id"].(string); id != "" {
						contribs = append(contribs, id)
					}
				}
			}
		}
	}
	return pluginhost.HostPrepareResult{Generation: generation, State: "prepared", Contributions: contribs}, nil
}
func (c *stubHostClient) Activate(_ context.Context, generation int64, _ bool) (pluginhost.HostActivateResult, error) {
	return pluginhost.HostActivateResult{Generation: generation, State: "active"}, nil
}
func (c *stubHostClient) Invoke(ctx context.Context, generation int64, cid string, val any, timeout time.Duration) (json.RawMessage, error) {
	raw, _, err := c.InvokeRaw(ctx, generation, cid, val, timeout)
	return raw, err
}
func (c *stubHostClient) InvokeRaw(_ context.Context, generation int64, cid string, val any, _ time.Duration) (json.RawMessage, []byte, error) {
	if c.invHook != nil {
		return c.invHook(generation, cid, val)
	}
	return json.RawMessage(`{}`), nil, nil
}
func (c *stubHostClient) Dispose(_ context.Context, gen int64) (pluginhost.HostDisposeResult, error) {
	return pluginhost.HostDisposeResult{Generation: gen, State: "disposed"}, nil
}
func (c *stubHostClient) Status(context.Context) (pluginhost.HostStatusResult, error) {
	return pluginhost.HostStatusResult{ActiveGeneration: 1}, nil
}
func (c *stubHostClient) Ping(context.Context) error { return nil }
func (c *stubHostClient) SocketPath() string         { return "/tmp/stub.sock" }
func (c *stubHostClient) Token() string              { return "tok" }
func (c *stubHostClient) PID() int                   { return 1234 }
func (c *stubHostClient) Running() bool              { return c.running }

type stubStateReader struct{ doc map[string]any }

func (r stubStateReader) ReadRawControlState(context.Context) ([]byte, error) {
	return json.Marshal(r.doc)
}

type stubRegistrar struct {
	res pluginhost.ProjectionRegisterResult
}

func (r stubRegistrar) RegisterProjection(context.Context, pluginhost.ProjectionRegisterRequest) (pluginhost.ProjectionRegisterResult, error) {
	return r.res, nil
}

func newFullTestHandler(t *testing.T, publishPlugins bool) (*Handler, *pluginhost.Service, string) {
	t.Helper()
	home := t.TempDir()
	pStore, err := pricingcatalog.NewStore(home)
	if err != nil {
		t.Fatalf("NewStore 失败: %v", err)
	}
	pSvc, err := pricingcatalog.NewService(pricingcatalog.ServiceDependencies{
		Store:            pStore,
		CommunitySources: []pricingcatalog.CommunitySource{},
	})
	if err != nil {
		t.Fatalf("pricing NewService 失败: %v", err)
	}
	host := &stubHostClient{
		invHook: func(_ int64, cid string, val any) (json.RawMessage, []byte, error) {
			reqMap, _ := val.(map[string]any)
			switch cid {
			case "echo.ok":
				return json.RawMessage(`{"pong":true}`), []byte{1, 2, 3}, nil
			case "pricing.cat":
				return json.RawMessage(`{"source":{"id":"plug-cat","kind":"official"},"generatedAt":"2026-11-13T12:00:00Z","quotes":[{"provider":"openai","model":"gpt-5-mini","input":0.25,"output":1.0}]}`), nil, nil
			case "pricing.q":
				return json.RawMessage(`{"quotes":[{"provider":"openai","model":"gpt-5-mini","input":0.25,"output":1.0,"source":{"id":"plug-q","kind":"official"}}]}`), nil, nil
			case "acc.src":
				switch reqMap["kind"] {
				case "list":
					return json.RawMessage(`{"sources":[{"id":"plug-direct","kind":"local","authMode":"oauth","clientDependent":false,"directImport":true}]}`), nil, nil
				case "import":
					return json.RawMessage(`{"files":[{"path":".codex/auth.json","content":"{\"token\":\"abc\"}"}]}`), nil, nil
				}
			case "acc.refresh":
				if reqMap["kind"] == "match" {
					return json.RawMessage(`{"handles":true}`), nil, nil
				}
				return json.RawMessage(`{"handled":true,"files":[{"path":".codex/auth.json","content":"{\"token\":\"ref\"}"}]}`), nil, nil
			case "acc.mat":
				if reqMap["kind"] == "match" {
					return json.RawMessage(`{"handles":true}`), nil, nil
				}
				return json.RawMessage(`{"handled":true,"files":[{"path":".codex/auth.json","content":"{\"token\":\"mat\"}"}]}`), nil, nil
			}
			return nil, nil, pluginerr.New("plugin_contribution_unknown", "贡献项不存在")
		},
	}
	svc, err := pluginhost.NewService(pluginhost.ServiceOptions{
		AIHomeDir:      home,
		HostVersion:    "1.0.0",
		PricingService: pSvc,
		StateReader: stubStateReader{doc: map[string]any{
			"schemaVersion": 1,
			"revision":      7,
			"installed":     []any{},
			"instances":     []any{},
		}},
		SupervisorFactory: func(int64) (pluginhost.HostClient, error) { return host, nil },
	})
	if err != nil {
		t.Fatalf("pluginhost NewService 失败: %v", err)
	}
	t.Cleanup(func() { _ = svc.Close() })

	if publishPlugins {
		_, err := svc.Runtime().Publish(context.Background(), []pluginhost.PluginSpec{{
			InstanceID: "inst-1",
			PluginID:   "plug-1",
			Version:    "1.0.0",
			EntryPath:  "/tmp/p.mjs",
			Manifest: map[string]any{
				"pluginId": "plug-1",
				"contributes": []any{
					map[string]any{"id": "echo.ok", "capability": "observe", "order": 1},
					map[string]any{"id": "pricing.cat", "capability": pluginhost.PricingCatalogCapability, "order": 1, "failurePolicy": "delegate"},
					map[string]any{"id": "pricing.q", "capability": pluginhost.PricingQuoteCapability, "order": 1, "failurePolicy": "delegate"},
					map[string]any{"id": "acc.src", "capability": pluginhost.AccountSourceCapability, "order": 1},
					map[string]any{"id": "acc.refresh", "capability": pluginhost.AccountRefreshCapability, "order": 1},
					map[string]any{"id": "acc.mat", "capability": pluginhost.AccountMaterializeCapability, "order": 1},
				},
			},
		}}, nil)
		if err != nil {
			t.Fatalf("Publish 失败: %v", err)
		}
	}

	h, err := NewHandler(Dependencies{
		Authorizer:       stubAuth{allowed: true},
		HostService:      svc,
		PricingService:   pSvc,
		AccountRegistrar: stubRegistrar{res: pluginhost.ProjectionRegisterResult{Registered: true, Provider: "codex", AccountRef: "acct_go_1", CLIAccountID: "9"}},
	})
	if err != nil {
		t.Fatalf("NewHandler 失败: %v", err)
	}
	return h, svc, home
}

func doReq(t *testing.T, h http.Handler, method, target, body string) (int, map[string]any) {
	t.Helper()
	var req *http.Request
	if body != "" {
		req = httptest.NewRequest(method, target, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	} else {
		req = httptest.NewRequest(method, target, nil)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var payload map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &payload)
	return rec.Code, payload
}

func TestWebUIPluginAPIAuthAndMethodGuards(t *testing.T) {
	svc, err := pluginhost.NewService(pluginhost.ServiceOptions{AIHomeDir: t.TempDir()})
	if err != nil {
		t.Fatalf("NewService 失败: %v", err)
	}
	defer func() { _ = svc.Close() }()
	unauth, _ := NewHandler(Dependencies{Authorizer: stubAuth{allowed: false}, HostService: svc})
	status, payload := doReq(t, unauth, http.MethodGet, DoctorPath, "")
	if status != http.StatusUnauthorized || payload["error"] != "unauthorized" {
		t.Fatalf("未授权应返回 401: %d %+v", status, payload)
	}

	h, _, _ := newFullTestHandler(t, false)
	status, _ = doReq(t, h, http.MethodPost, DoctorPath, "{}")
	if status != http.StatusMethodNotAllowed {
		t.Fatalf("doctor POST 应返回 405，实际 %d", status)
	}
	status, _ = doReq(t, h, http.MethodGet, InvokePath, "")
	if status != http.StatusMethodNotAllowed {
		t.Fatalf("invoke GET 应返回 405，实际 %d", status)
	}
}

func TestWebUIPluginAPIDoctorInvokePricingAndAccounts(t *testing.T) {
	h, svc, _ := newFullTestHandler(t, true)
	svc.Audit("trust", map[string]any{"keyId": "k1"})

	// 1. Doctor 返回 revision/audit/pricing/healthy
	status, doc := doReq(t, h, http.MethodGet, DoctorPath, "")
	if status != http.StatusOK || doc["healthy"] != true || doc["revision"] != float64(7) {
		t.Fatalf("doctor 响应异常: %d %+v", status, doc)
	}
	if auditList, _ := doc["audit"].([]any); len(auditList) != 1 {
		t.Fatalf("doctor 应包含 1 条审计记录，实际 %+v", doc["audit"])
	}
	if doc["pricing"] == nil {
		t.Fatalf("doctor 应包含 pricing 字段: %+v", doc)
	}

	// 2. Invoke 成功与 400 / 404 状态映射
	status, invOK := doReq(t, h, http.MethodPost, InvokePath, `{"contributionId":"echo.ok","value":{"ping":1}}`)
	if status != http.StatusOK || invOK["payloadBytes"] != float64(3) {
		t.Fatalf("invoke 成功响应异常: %d %+v", status, invOK)
	}
	status, invBad := doReq(t, h, http.MethodPost, InvokePath, `{}`)
	if status != http.StatusBadRequest || invBad["error"] != "plugin_contribution_required" {
		t.Fatalf("空 contributionId 应 400: %d %+v", status, invBad)
	}
	status, invMiss := doReq(t, h, http.MethodPost, InvokePath, `{"contributionId":"missing.one"}`)
	if status != http.StatusNotFound || invMiss["error"] != "plugin_contribution_unknown" {
		t.Fatalf("未知 contributionId 应 404: %d %+v", status, invMiss)
	}

	// 3. Pricing refresh & quote
	status, pref := doReq(t, h, http.MethodPost, PricingRefreshPath, `{}`)
	if status != http.StatusOK {
		t.Fatalf("pricing/refresh 失败: %d %+v", status, pref)
	}
	pluginRun, _ := pref["pluginRun"].(map[string]any)
	if sources, _ := pluginRun["sources"].([]any); len(sources) != 1 {
		t.Fatalf("pricing/refresh 应生效 1 个插件价格源: %+v", pref)
	}
	status, pquote := doReq(t, h, http.MethodPost, PricingQuotePath, `{"provider":"openai","model":"gpt-5-mini"}`)
	if status != http.StatusOK || pquote["contributions"] != float64(1) {
		t.Fatalf("pricing/quote 失败: %d %+v", status, pquote)
	}

	// 4. Accounts sources / import / refresh / materialize
	status, srcs := doReq(t, h, http.MethodGet, AccountsSourcesPath+"?provider=codex", "")
	if status != http.StatusOK {
		t.Fatalf("accounts/sources 失败: %d %+v", status, srcs)
	}
	if list, _ := srcs["sources"].([]any); len(list) != 1 {
		t.Fatalf("accounts/sources 期望 1 条来源: %+v", srcs)
	}
	status, imp := doReq(t, h, http.MethodPost, AccountsImportPath, `{"provider":"codex","sourceId":"plug-direct"}`)
	if status != http.StatusOK || imp["ok"] != true || imp["accountRef"] != "acct_go_1" {
		t.Fatalf("accounts/import 失败: %d %+v", status, imp)
	}
	runtimeDir, _ := imp["runtimeDir"].(string)
	status, ref := doReq(t, h, http.MethodPost, AccountsRefreshPath, `{"provider":"codex","accountRef":"acct_go_1","runtimeDir":`+func() string {
		raw, _ := json.Marshal(runtimeDir)
		return string(raw)
	}()+`}`)
	if status != http.StatusOK || ref["handled"] != true {
		t.Fatalf("accounts/refresh 失败: %d %+v", status, ref)
	}
	matDir := filepath.Join(filepath.Dir(runtimeDir), "mat-target")
	_ = os.MkdirAll(matDir, 0o700)
	status, mat := doReq(t, h, http.MethodPost, AccountsMaterializePath, `{"provider":"codex","accountRef":"acct_go_1","runtimeDir":`+func() string {
		raw, _ := json.Marshal(matDir)
		return string(raw)
	}()+`}`)
	if status != http.StatusOK || mat["handled"] != true {
		t.Fatalf("accounts/materialize 失败: %d %+v", status, mat)
	}
}

func TestWebUIPluginAPIInactiveRuntimeReturns503(t *testing.T) {
	h, _, _ := newFullTestHandler(t, false)
	status, inv := doReq(t, h, http.MethodPost, InvokePath, `{"contributionId":"echo.ok"}`)
	if status != http.StatusServiceUnavailable || inv["error"] != "plugin_runtime_inactive" {
		t.Fatalf("未激活时 invoke 应返回 503 plugin_runtime_inactive: %d %+v", status, inv)
	}
	status, q := doReq(t, h, http.MethodPost, PricingQuotePath, `{"provider":"openai","model":"gpt-5"}`)
	if status != http.StatusServiceUnavailable || q["error"] != "plugin_runtime_inactive" {
		t.Fatalf("未激活时 pricing/quote 应返回 503 plugin_runtime_inactive: %d %+v", status, q)
	}
	status, imp := doReq(t, h, http.MethodPost, AccountsImportPath, `{"provider":"codex","sourceId":"plug-direct"}`)
	if status != http.StatusOK || imp["ok"] != false || imp["code"] != "plugin_runtime_inactive" {
		t.Fatalf("未激活时 accounts/import 应返回 {ok:false, code:plugin_runtime_inactive}: %d %+v", status, imp)
	}
}
