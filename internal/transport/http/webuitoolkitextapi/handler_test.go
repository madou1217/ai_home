package webuitoolkitextapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/edgeproxy"
	"github.com/madou1217/ai_home/internal/runtime/nativeresources"
	"github.com/madou1217/ai_home/internal/runtime/providerconfigs"
	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
)

type stubAuthorizer struct {
	allow bool
}

func (a stubAuthorizer) Authorized(r *http.Request) bool {
	if !a.allow {
		return false
	}
	return r.Header.Get("Authorization") == "Bearer test-secret"
}

type fakeEdgeFS struct {
	mu    sync.Mutex
	files map[string][]byte
	execs map[string]bool
}

func newFakeEdgeFS() *fakeEdgeFS {
	return &fakeEdgeFS{
		files: map[string][]byte{},
		execs: map[string]bool{},
	}
}

func (f *fakeEdgeFS) Exists(path string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.files[path]
	return ok
}

func (f *fakeEdgeFS) IsExecutable(path string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.execs[path]
}

func (f *fakeEdgeFS) IsWritable(path string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.files[path]
	return ok
}

func (f *fakeEdgeFS) ReadFile(path string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, ok := f.files[path]
	if !ok {
		return nil, os.ErrNotExist
	}
	cp := make([]byte, len(data))
	copy(cp, data)
	return cp, nil
}

func (f *fakeEdgeFS) WriteFile(path string, data []byte, _ os.FileMode) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := make([]byte, len(data))
	copy(cp, data)
	f.files[path] = cp
	return nil
}

func (f *fakeEdgeFS) Rename(oldPath, newPath string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, ok := f.files[oldPath]
	if !ok {
		return os.ErrNotExist
	}
	f.files[newPath] = data
	delete(f.files, oldPath)
	return nil
}

func (f *fakeEdgeFS) Remove(path string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.files, path)
	return nil
}

type fakeEdgeRunner struct{}

func (fakeEdgeRunner) Run(_ context.Context, _ string, args []string, _ time.Duration) edgeproxy.ExecResult {
	if len(args) > 0 && args[0] == "-v" {
		return edgeproxy.ExecResult{ExitCode: 0, Stderr: "nginx version: nginx/1.26.0 --conf-path=/etc/nginx/nginx.conf"}
	}
	return edgeproxy.ExecResult{ExitCode: 0}
}

func buildTestHandler(t *testing.T, allowAuth bool) (*Handler, string, string) {
	t.Helper()
	root := t.TempDir()
	aiHome := filepath.Join(root, ".ai_home")
	hostHome := filepath.Join(root, "home")
	demoRoot := filepath.Join(root, "repo")
	if err := os.MkdirAll(aiHome, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(hostHome, 0o700); err != nil {
		t.Fatal(err)
	}
	skillDemoDir := filepath.Join(demoRoot, "assets", "provider-skills", "aih-demo")
	if err := os.MkdirAll(skillDemoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDemoDir, "SKILL.md"), []byte("---\nname: aih-demo\ndescription: Demo native skill\n---\n# Demo Skill\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mcpDemoDir := filepath.Join(demoRoot, "examples", "mcp")
	if err := os.MkdirAll(mcpDemoDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mcpDemoDir, "aih-demo-server.js"), []byte("console.log('mcp');\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cat, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatal(err)
	}

	edgeFS := newFakeEdgeFS()
	edgeFS.execs["/usr/sbin/nginx"] = true
	edgeFS.files["/etc/nginx/nginx.conf"] = []byte("http {}\n")
	edgeFS.execs["/usr/bin/caddy"] = true
	edgeFS.files["/etc/caddy/Caddyfile"] = []byte("# caddy\n")
	edgeCtx := `{"nginxBin":"/usr/sbin/nginx","nginxConfigDir":"/etc/nginx","caddyBin":"/usr/bin/caddy","caddyConfig":"/etc/caddy/Caddyfile"}`
	edgeSvc := edgeproxy.NewServiceWithDeps(edgeFS, fakeEdgeRunner{}, map[string]string{
		"AIH_EDGE_CONTEXT": edgeCtx,
	}, nil)

	pcSvc := providerconfigs.NewService(cat, hostHome, aiHome)

	nrSvc, err := nativeresources.NewService(nativeresources.Config{
		AIHomeDir:       aiHome,
		HostHomeDir:     hostHome,
		Catalog:         cat,
		DemoRoot:        demoRoot,
		SkipDoctorProbe: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	subSvc := subaggregator.NewService(aiHome, subaggregator.ServiceOptions{
		HostHomeDir: hostHome,
		Platform:    "linux",
		Env:         map[string]string{"HOME": hostHome},
	})

	h, err := NewHandler(Dependencies{
		Authorizer:        stubAuthorizer{allow: allowAuth},
		Edge:              edgeSvc,
		ProviderConfigs:   pcSvc,
		NativeResources:   nrSvc,
		SubAggregator:     subSvc,
		DefaultAIHPort:    4321,
		HeartbeatInterval: 40 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	return h, hostHome, demoRoot
}

func doReq(t *testing.T, handler http.Handler, method, target, body string, auth bool) *httptest.ResponseRecorder {
	t.Helper()
	var buf *bytes.Reader
	if body != "" {
		buf = bytes.NewReader([]byte(body))
	} else {
		buf = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, target, buf)
	req.RemoteAddr = "127.0.0.1:54321"
	if auth {
		req.Header.Set("Authorization", "Bearer test-secret")
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func decodeJSON(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("解析响应 JSON 失败 (status=%d, body=%s): %v", rec.Code, rec.Body.String(), err)
	}
	return out
}

func TestAuthAndUnavailableGuards(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); err == nil {
		t.Fatal("缺少 Authorizer 应返回错误")
	}
	h, _, _ := buildTestHandler(t, false)
	rec := doReq(t, h, http.MethodGet, EdgePath, "", true)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("未鉴权应返回 401，实际 %d", rec.Code)
	}
	if rec.Header().Get("WWW-Authenticate") != "Bearer" {
		t.Fatalf("缺少 WWW-Authenticate Bearer 头: %v", rec.Header())
	}

	nilServicesHandler, err := NewHandler(Dependencies{Authorizer: stubAuthorizer{allow: true}})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{EdgePath, ProviderConfigsPath, NativeResourcesPath, SubAggregatorPath} {
		rec = doReq(t, nilServicesHandler, http.MethodGet, path, "", true)
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s 服务未注入应返回 503，实际 %d", path, rec.Code)
		}
	}
}

func TestEdgeProxyHTTP(t *testing.T) {
	h, _, _ := buildTestHandler(t, true)

	rec := doReq(t, h, http.MethodGet, EdgePath+"?aihPort=4888", "", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET edge status=%d body=%s", rec.Code, rec.Body.String())
	}
	body := decodeJSON(t, rec)
	if body["ok"] != true || int(body["aihPort"].(float64)) != 4888 {
		t.Fatalf("edge status payload mismatch: %+v", body)
	}

	rec = doReq(t, h, http.MethodGet, EdgePlanPath+"?provider=unknown", "", true)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("unknown provider expected 400, got %d", rec.Code)
	}
	if decodeJSON(t, rec)["error"] != "edge_unknown_provider" {
		t.Fatalf("expected edge_unknown_provider: %s", rec.Body.String())
	}

	rec = doReq(t, h, http.MethodGet, EdgePlanPath+"?provider=frp&domain=example.com", "", true)
	if rec.Code != http.StatusBadRequest || decodeJSON(t, rec)["error"] != "edge_remote_port_required" {
		t.Fatalf("expected frp missing port 400, got %d body=%s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, h, http.MethodGet, EdgePlanPath+"?provider=caddy&domain=ai.example.com&aihPort=4999", "", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("caddy plan failed status=%d body=%s", rec.Code, rec.Body.String())
	}
	planResp := decodeJSON(t, rec)
	rawPlan, _ := json.Marshal(planResp["plan"])
	if !strings.Contains(string(rawPlan), "4999") {
		t.Fatalf("caddy plan should reference aihPort 4999: %s", string(rawPlan))
	}

	rec = doReq(t, h, http.MethodPost, EdgeApplyPath, `{"provider":"caddy","domain":"ai.example.com","dryRun":true,"aihPort":4321}`, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("edge dryRun apply failed: %d %s", rec.Code, rec.Body.String())
	}
	if decodeJSON(t, rec)["dryRun"] != true {
		t.Fatalf("expected dryRun=true in apply response: %s", rec.Body.String())
	}

	rec = doReq(t, h, http.MethodPost, EdgeApplyPath, `{"provider":"caddy","provider":"nginx"}`, true)
	if rec.Code != http.StatusBadRequest || decodeJSON(t, rec)["error"] != "invalid_json_body" {
		t.Fatalf("duplicate key json expected 400 invalid_json_body, got %d %s", rec.Code, rec.Body.String())
	}
	rec = doReq(t, h, http.MethodPost, EdgeApplyPath, `{"provider":"caddy",`, true)
	if rec.Code != http.StatusBadRequest || decodeJSON(t, rec)["error"] != "invalid_json_body" {
		t.Fatalf("invalid json expected 400 invalid_json_body, got %d %s", rec.Code, rec.Body.String())
	}
}

func TestProviderConfigsHTTP(t *testing.T) {
	h, _, _ := buildTestHandler(t, true)

	rec := doReq(t, h, http.MethodGet, ProviderConfigsPath, "", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("list provider configs failed: %d %s", rec.Code, rec.Body.String())
	}
	listBody := decodeJSON(t, rec)
	if listBody["ok"] != true || listBody["total"].(float64) < 1 {
		t.Fatalf("unexpected list response: %+v", listBody)
	}

	rec = doReq(t, h, http.MethodPost, ProviderConfigsPath, "{}", true)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST list expected 405, got %d", rec.Code)
	}

	rec = doReq(t, h, http.MethodGet, ProviderConfigsPath+"/claude/unknown", "", true)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown file expected 404, got %d", rec.Code)
	}

	rec = doReq(t, h, http.MethodPut, ProviderConfigsPath+"/claude/settings", `{"content":123}`, true)
	if rec.Code != http.StatusBadRequest || decodeJSON(t, rec)["error"] != "content_required" {
		t.Fatalf("non-string content expected 400 content_required, got %d %s", rec.Code, rec.Body.String())
	}

	// 验证 -> 写入 -> 冲突 -> 导出 -> 历史恢复
	rec = doReq(t, h, http.MethodPost, ProviderConfigsPath+"/claude/settings/validate", `{"content":"{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"sk-secret-value-1234\"}}"}`, true)
	if rec.Code != http.StatusOK || decodeJSON(t, rec)["valid"] != true {
		t.Fatalf("validate valid json failed: %d %s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, h, http.MethodPut, ProviderConfigsPath+"/claude/settings", `{"content":"{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"sk-secret-value-1234\"}}","note":"v1"}`, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT settings failed: %d %s", rec.Code, rec.Body.String())
	}
	rev1 := decodeJSON(t, rec)["revision"].(string)

	rec = doReq(t, h, http.MethodPut, ProviderConfigsPath+"/claude/settings", `{"content":"{\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"sk-new-9999\"}}","revision":"stale-rev"}`, true)
	if rec.Code != http.StatusConflict || decodeJSON(t, rec)["error"] != "provider_config_conflict" {
		t.Fatalf("stale revision expected 409 conflict, got %d %s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, h, http.MethodPut, ProviderConfigsPath+"/claude/settings", `{"content":"{bad-json","revision":"`+rev1+`"}`, true)
	if rec.Code != http.StatusUnprocessableEntity || decodeJSON(t, rec)["error"] != "provider_config_validation_failed" {
		t.Fatalf("invalid json content expected 422, got %d %s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, h, http.MethodPut, ProviderConfigsPath+"/claude/settings", `{"content":"{\"model\":\"sonnet\",\"env\":{\"ANTHROPIC_AUTH_TOKEN\":\"sk-second-secret\"}}","revision":"`+rev1+`","note":"v2"}`, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT v2 failed: %d %s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, h, http.MethodGet, ProviderConfigsPath+"/claude/settings/export?mode=redacted", "", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("export failed: %d %s", rec.Code, rec.Body.String())
	}
	exportBody := decodeJSON(t, rec)
	if strings.Contains(exportBody["content"].(string), "sk-second-secret") {
		t.Fatalf("redacted export leaked token: %s", exportBody["content"])
	}

	rec = doReq(t, h, http.MethodGet, ProviderConfigsPath+"/claude/settings/history", "", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("history list failed: %d %s", rec.Code, rec.Body.String())
	}
	entries := decodeJSON(t, rec)["entries"].([]any)
	if len(entries) < 2 {
		t.Fatalf("expected >=2 history entries, got %d", len(entries))
	}
	entryID := entries[1].(map[string]any)["id"].(string)

	rec = doReq(t, h, http.MethodGet, ProviderConfigsPath+"/claude/settings/history/"+entryID, "", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("read history entry failed: %d %s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, h, http.MethodPost, ProviderConfigsPath+"/claude/settings/history/"+entryID+"/restore", "", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("restore history entry failed: %d %s", rec.Code, rec.Body.String())
	}
}

func TestNativeResourcesHTTP(t *testing.T) {
	h, _, demoRoot := buildTestHandler(t, true)

	rec := doReq(t, h, http.MethodGet, NativeResourcesPath, "", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET native-resources failed: %d %s", rec.Code, rec.Body.String())
	}
	if decodeJSON(t, rec)["ok"] != true {
		t.Fatalf("expected ok=true: %s", rec.Body.String())
	}

	rec = doReq(t, h, http.MethodPost, NativeResourcesPath, `{"kind":"skill","action":"install","provider":"codex","source":"/etc/passwd"}`, true)
	if rec.Code != http.StatusBadRequest || decodeJSON(t, rec)["error"] != "native_resource_source_forbidden" {
		t.Fatalf("traversal source expected 400 forbidden, got %d %s", rec.Code, rec.Body.String())
	}

	skillSrc := filepath.Join(demoRoot, "assets", "provider-skills", "aih-demo")
	installBody, _ := json.Marshal(map[string]any{
		"kind":     "skill",
		"action":   "install",
		"provider": "codex",
		"source":   skillSrc,
	})
	rec = doReq(t, h, http.MethodPost, NativeResourcesPath, string(installBody), true)
	if rec.Code != http.StatusOK || decodeJSON(t, rec)["ok"] != true {
		t.Fatalf("install skill failed: %d %s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, h, http.MethodPost, NativeResourcesPath, `{"kind":"skill","action":"disable","provider":"codex","id":"aih-demo"}`, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("disable skill failed: %d %s", rec.Code, rec.Body.String())
	}

	oversized := `{"kind":"skill","action":"install","provider":"codex","source":"` + strings.Repeat("a", nativeResourcesMaxBodyBytes+10) + `"}`
	rec = doReq(t, h, http.MethodPost, NativeResourcesPath, oversized, true)
	if rec.Code != http.StatusRequestEntityTooLarge || decodeJSON(t, rec)["error"] != "native_resource_payload_too_large" {
		t.Fatalf("oversized expected 413, got %d %s", rec.Code, rec.Body.String())
	}
}

func TestSubAggregatorHTTPServeMuxAndSSE(t *testing.T) {
	h, _, _ := buildTestHandler(t, true)

	// 验证真实 Go ServeMux 全量模式无冲突 panic。
	mux := http.NewServeMux()
	patterns := []string{
		"GET " + EdgePath,
		"GET " + EdgePlanPath,
		"POST " + EdgeApplyPath,
		"GET " + ProviderConfigsPath,
		"GET " + ProviderConfigFilePath,
		"PUT " + ProviderConfigFilePath,
		"POST " + ProviderConfigValidatePath,
		"GET " + ProviderConfigHistoryPath,
		"GET " + ProviderConfigHistoryEntryPath,
		"POST " + ProviderConfigHistoryRestorePath,
		"GET " + ProviderConfigExportPath,
		"GET " + NativeResourcesPath,
		"POST " + NativeResourcesPath,
		"GET " + SubAggregatorPath,
		"GET " + SubAggregatorLocalClientsPath,
		"GET " + SubAggregatorLocalSourcesPath,
		"POST " + SubAggregatorLocalSourcesImportPath,
		"GET " + SubAggregatorSourcesSyncWatchPath,
		"GET " + SubAggregatorRelayPath,
		"POST " + SubAggregatorProfilesPath,
		"POST " + SubAggregatorProfileNodesPath,
		"POST " + SubAggregatorProfileTestRoutePath,
		"POST " + SubAggregatorProbePath,
		"POST " + SubAggregatorNodesParsePath,
		"GET " + SubAggregatorNodesPath,
		"POST " + SubAggregatorNodesChainPath,
		"POST " + SubAggregatorSourcesPreviewPath,
		"POST " + SubAggregatorSourcesPath,
		"POST " + SubAggregatorSourcesSyncPath,
		"POST " + SubAggregatorProfileTokenPath,
		"GET " + SubAggregatorProfilePreviewPath,
		"GET " + SubAggregatorProfileImportLinksPath,
		"DELETE " + SubAggregatorProfileItemPath,
		"GET " + SubAggregatorSourceNodesPath,
		"POST " + SubAggregatorSourceLatencyPath,
		"POST " + SubAggregatorSourceSyncPath,
		"POST " + SubAggregatorSourceEnabledPath,
		"DELETE " + SubAggregatorSourceItemPath,
	}
	for _, pattern := range patterns {
		mux.Handle(pattern, h)
	}

	// 1. 远端请求访问 local-sources 被 403 拦截
	rec := doReq(t, mux, http.MethodGet, SubAggregatorLocalSourcesPath+"?remoteAddr=203.0.113.5", "", true)
	if rec.Code != http.StatusForbidden || decodeJSON(t, rec)["error"] != "local_scan_requires_local_request" {
		t.Fatalf("remote local-sources expected 403, got %d %s", rec.Code, rec.Body.String())
	}

	// 2. 本机 local-sources / relay / overview / nodes
	rec = doReq(t, mux, http.MethodGet, SubAggregatorRelayPath, "", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET relay failed: %d %s", rec.Code, rec.Body.String())
	}
	if relayBody := decodeJSON(t, rec); relayBody["ok"] != true || relayBody["local"] != true {
		t.Fatalf("expected ok/local true in relay response: %+v", relayBody)
	}

	// 3. 预览并保存本地订阅源 -> 预览节点 -> 保存配置 -> 测试路由 -> 生成导入链接 -> 删除
	vlessURI := "vless://11111111-1111-4111-8111-111111111111@hk1.example.com:443?type=ws&security=tls#HK-Node-1"
	rec = doReq(t, mux, http.MethodPost, SubAggregatorSourcesPreviewPath, `{"content":"`+vlessURI+`"}`, true)
	if rec.Code != http.StatusOK || decodeJSON(t, rec)["ok"] != true {
		t.Fatalf("sources preview failed: %d %s", rec.Code, rec.Body.String())
	}

	saveSourcePayload, _ := json.Marshal(map[string]any{
		"name":    "Test Local Sub",
		"kind":    "local",
		"content": vlessURI,
	})
	rec = doReq(t, mux, http.MethodPost, SubAggregatorSourcesPath, string(saveSourcePayload), true)
	if rec.Code != http.StatusOK {
		t.Fatalf("save local source failed: %d %s", rec.Code, rec.Body.String())
	}
	savedSub := decodeJSON(t, rec)["subscription"].(map[string]any)
	subID := savedSub["id"].(string)

	rec = doReq(t, mux, http.MethodGet, SubAggregatorPath+"/sources/"+subID+"/nodes", "", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET source nodes failed: %d %s", rec.Code, rec.Body.String())
	}
	if len(decodeJSON(t, rec)["nodes"].([]any)) != 1 {
		t.Fatalf("expected 1 node in source, got %s", rec.Body.String())
	}

	saveProfilePayload, _ := json.Marshal(map[string]any{
		"name":    "MyAgg",
		"sources": []string{subID},
	})
	rec = doReq(t, mux, http.MethodPost, SubAggregatorProfilesPath, string(saveProfilePayload), true)
	if rec.Code != http.StatusOK {
		t.Fatalf("save profile failed: %d %s", rec.Code, rec.Body.String())
	}
	prof := decodeJSON(t, rec)["profile"].(map[string]any)
	profID := prof["id"].(string)

	rec = doReq(t, mux, http.MethodGet, SubAggregatorPath+"/profiles/"+profID+"/import-links?origin=https://sub.example.com", "", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("import-links failed: %d %s", rec.Code, rec.Body.String())
	}
	if linksBody := decodeJSON(t, rec); linksBody["origin"] != "https://sub.example.com" {
		t.Fatalf("unexpected import-links origin: %+v", linksBody)
	}

	rec = doReq(t, mux, http.MethodGet, SubAggregatorPath+"/profiles/"+profID+"/preview?format=mihomo", "", true)
	if rec.Code != http.StatusOK || !strings.Contains(decodeJSON(t, rec)["content"].(string), "HK-Node-1") {
		t.Fatalf("profile preview failed: %d %s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, mux, http.MethodPost, SubAggregatorSourcesSyncPath, `{"ids":[]}`, true)
	if rec.Code != http.StatusAccepted || decodeJSON(t, rec)["ok"] != true {
		t.Fatalf("async sync expected 202, got %d %s", rec.Code, rec.Body.String())
	}

	// 4. 验证 SSE /sources/sync/watch
	srv := httptest.NewServer(mux)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	sseReq, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+SubAggregatorSourcesSyncWatchPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	sseReq.Header.Set("Authorization", "Bearer test-secret")
	sseResp, err := http.DefaultClient.Do(sseReq)
	if err != nil {
		t.Fatal(err)
	}
	defer sseResp.Body.Close()
	if sseResp.StatusCode != http.StatusOK || !strings.Contains(sseResp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("SSE watch unexpected response: %d %v", sseResp.StatusCode, sseResp.Header)
	}
	scanner := bufio.NewScanner(sseResp.Body)
	firstData := ""
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data: ") {
			firstData = strings.TrimPrefix(line, "data: ")
			break
		}
	}
	if firstData == "" {
		t.Fatalf("SSE watch did not emit initial snapshot event (err=%v)", scanner.Err())
	}
	var snap map[string]any
	if err := json.Unmarshal([]byte(firstData), &snap); err != nil || snap["type"] != "snapshot" {
		t.Fatalf("expected snapshot SSE event, got %s (err=%v)", firstData, err)
	}

	rec = doReq(t, mux, http.MethodPost, SubAggregatorNodesParsePath, `{"content":"`+vlessURI+`"}`, true)
	if rec.Code != http.StatusOK || len(decodeJSON(t, rec)["nodes"].([]any)) != 1 {
		t.Fatalf("nodes/parse failed: %d %s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, mux, http.MethodGet, SubAggregatorNodesPath, "", true)
	if rec.Code != http.StatusOK || len(decodeJSON(t, rec)["nodes"].([]any)) != 1 {
		t.Fatalf("GET nodes failed: %d %s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, mux, http.MethodPost, SubAggregatorProfileNodesPath, `{"sources":["`+subID+`"]}`, true)
	if rec.Code != http.StatusOK || len(decodeJSON(t, rec)["nodes"].([]any)) != 1 {
		t.Fatalf("profiles/nodes failed: %d %s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, mux, http.MethodPost, SubAggregatorPath+"/profiles/"+profID+"/token", "", true)
	if rec.Code != http.StatusOK || decodeJSON(t, rec)["ok"] != true {
		t.Fatalf("rotate token failed: %d %s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, mux, http.MethodPost, SubAggregatorPath+"/sources/"+subID+"/enabled", `{"enabled":false}`, true)
	if rec.Code != http.StatusOK || decodeJSON(t, rec)["ok"] != true {
		t.Fatalf("set source enabled failed: %d %s", rec.Code, rec.Body.String())
	}

	rec = doReq(t, mux, http.MethodPost, SubAggregatorPath+"/sources/"+subID+"/sync", "", true)
	if rec.Code != http.StatusConflict || decodeJSON(t, rec)["error"] != "subscription_disabled" {
		t.Fatalf("sync disabled source expected 409 subscription_disabled, got %d %s", rec.Code, rec.Body.String())
	}

	// 5. 清理 Profile & Source
	rec = doReq(t, mux, http.MethodDelete, SubAggregatorPath+"/profiles/"+profID, "", true)
	if rec.Code != http.StatusOK || decodeJSON(t, rec)["ok"] != true {
		t.Fatalf("DELETE profile failed: %d %s", rec.Code, rec.Body.String())
	}
	rec = doReq(t, mux, http.MethodDelete, SubAggregatorPath+"/sources/"+subID, "", true)
	if rec.Code != http.StatusOK || decodeJSON(t, rec)["ok"] != true {
		t.Fatalf("DELETE source failed: %d %s", rec.Code, rec.Body.String())
	}
}
