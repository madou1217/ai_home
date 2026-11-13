package windowactivation

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

const (
	testAccountRef = "acct_0123456789abcdef0123"
	testOtherRef   = "acct_fedcba98765432100123"
)

func seedAppStateDB(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, appstate.DatabaseFileName))
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer func() { _ = db.Close() }()
	for _, stmt := range []string{
		"CREATE TABLE account_refs (account_ref TEXT PRIMARY KEY, provider TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
		"CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("exec schema: %v", err)
		}
	}
	return dir
}

func writeKVTest(t *testing.T, dir, key, value string) {
	t.Helper()
	dbPath, err := appstate.DatabasePath(dir)
	if err != nil {
		t.Fatalf("DatabasePath: %v", err)
	}
	if err := appstate.WriteKV(context.Background(), dbPath, key, value, time.Now().UnixMilli()); err != nil {
		t.Fatalf("WriteKV(%s): %v", key, err)
	}
}

func TestSpecsAndResolveProbeModel(t *testing.T) {
	t.Parallel()
	if !IsSupportedProvider("Codex") || !IsSupportedProvider("AGY") || IsSupportedProvider("claude") {
		t.Fatalf("provider support check failed")
	}
	providers := ListProbeProviders()
	if len(providers) != 2 || providers[0] != "codex" || providers[1] != "agy" {
		t.Fatalf("providers = %v", providers)
	}
	agySpec, ok := GetProbeSpec("agy")
	if !ok || agySpec.Path("gemini-3 flash") != "/v1beta/models/gemini-3%20flash:generateContent" {
		t.Fatalf("unexpected agy spec/path: ok=%v path=%q", ok, agySpec.Path("gemini-3 flash"))
	}
	codexSpec, _ := GetProbeSpec("codex")

	if res := ResolveProbeModel(codexSpec, nil); res.Source != "unknown_catalog" || res.Model != "gpt-5.4-mini" {
		t.Fatalf("empty catalog = %+v", res)
	}
	if res := ResolveProbeModel(codexSpec, []string{"gpt-6-luna", "gpt-5.4-mini"}); res.Source != "spec" || res.Model != "gpt-5.4-mini" {
		t.Fatalf("spec hit = %+v", res)
	}
	if res := ResolveProbeModel(codexSpec, []string{"gpt-6-sol", "gpt-6-luna"}); res.Source != "candidate" || res.Model != "gpt-6-sol" {
		t.Fatalf("candidate hit = %+v", res)
	}
	if res := ResolveProbeModel(codexSpec, []string{"gpt-9-z", "gpt-9-a", "claude-4"}); res.Source != "pattern" || res.Model != "gpt-9-a" {
		t.Fatalf("pattern hit = %+v", res)
	}
	if res := ResolveProbeModel(codexSpec, []string{"claude-4"}); res.Source != "unavailable" || res.Model != "" {
		t.Fatalf("unavailable = %+v", res)
	}
}

func TestWindowLedgerPhantomAndReconcile(t *testing.T) {
	t.Parallel()
	const base = int64(1_700_000_000_000)
	codexSpec, _ := GetProbeSpec("codex")
	agySpec, _ := GetProbeSpec("agy")

	// F3 幻影：reset = capturedAt + 300m
	phantomCodex := &UsageSnapshot{
		CapturedAtMs: base,
		Entries:      []UsageEntry{{WindowMinutes: 300, ResetAtMs: base + 300*MsPerMinute}},
	}
	obsPhantom := ObserveWindow(phantomCodex, codexSpec, 0)
	if obsPhantom.Kind != "absent" || obsPhantom.Reason != "phantom_reset" {
		t.Fatalf("obsPhantom = %+v", obsPhantom)
	}

	// 刚探过（probeNearAnchor）时同样的 reset 应判为 live
	obsProbeLive := ObserveWindow(phantomCodex, codexSpec, base-1000)
	if obsProbeLive.Kind != "live" || obsProbeLive.Reason != "probe_anchor" {
		t.Fatalf("obsProbeLive = %+v", obsProbeLive)
	}

	// agy fixed window 模式忽略周窗口模型，选中 5h 模型并正确判真窗口
	agySnap := &UsageSnapshot{
		CapturedAtMs: base,
		Models: []UsageEntry{
			{ResetAtMs: base + 7*24*60*MsPerMinute, ResetIn: "5h"}, // 天级周窗口
			{ResetAtMs: base + 200*MsPerMinute, ResetIn: "5h"},    // 真实活跃 5h 窗口（锚点距今 100 分钟）
		},
	}
	obsAgy := ObserveWindow(agySnap, agySpec, 0)
	if obsAgy.Kind != "live" || obsAgy.WindowMinutes != 300 || obsAgy.CloseAtMs != base+200*MsPerMinute {
		t.Fatalf("obsAgy = %+v", obsAgy)
	}

	// Reconcile 单调性：旧观察不覆盖新账本
	ledger := ReconcileLedger(Ledger{}, obsAgy)
	olderAbsent := Observation{Kind: "absent", ObservedAtMs: base - 5000, WindowMinutes: 300}
	if after := ReconcileLedger(ledger, olderAbsent); after.WindowCloseAtMs != ledger.WindowCloseAtMs {
		t.Fatalf("older observation overwrote ledger: %+v", after)
	}
}

func TestDispatchProbeHTTPAndLocalHandler(t *testing.T) {
	t.Parallel()
	codexSpec, _ := GetProbeSpec("codex")
	var gotAuth, gotProvider, gotRef, gotModel string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotProvider = r.Header.Get("X-Provider")
		gotRef = r.Header.Get("X-Account-Ref")
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		gotModel, _ = body["model"].(string)
		w.Header().Set("x-aih-server-account-ref", gotRef)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"ok"}`))
	}))
	defer srv.Close()

	res := DispatchProbe(context.Background(), ProbeInput{
		BaseURL:    srv.URL,
		ClientKey:  "client-secret",
		Spec:       codexSpec,
		Model:      "gpt-6-sol",
		Provider:   "codex",
		AccountRef: testAccountRef,
	})
	if !res.OK || !res.Matched || res.Model != "gpt-6-sol" || res.ServedAccountRef != testAccountRef {
		t.Fatalf("DispatchProbe HTTP res = %+v", res)
	}
	if gotAuth != "Bearer client-secret" || gotProvider != "codex" || gotRef != testAccountRef || gotModel != "gpt-6-sol" {
		t.Fatalf("headers/body mismatch: auth=%q prov=%q ref=%q model=%q", gotAuth, gotProvider, gotRef, gotModel)
	}

	// fallback mismatch (local handler serves wrong account)
	local := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("x-aih-server-account-ref", testOtherRef)
		w.WriteHeader(http.StatusOK)
	})
	resMismatch := DispatchProbe(context.Background(), ProbeInput{
		LocalHandler: local,
		Spec:         codexSpec,
		Provider:     "codex",
		AccountRef:   testAccountRef,
	})
	if !resMismatch.OK || resMismatch.Matched || resMismatch.ServedAccountRef != testOtherRef {
		t.Fatalf("DispatchProbe local mismatch res = %+v", resMismatch)
	}

	// reject redirect
	redirSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/other", http.StatusFound)
	}))
	defer redirSrv.Close()
	resRedir := DispatchProbe(context.Background(), ProbeInput{
		BaseURL:    redirSrv.URL,
		Spec:       codexSpec,
		Provider:   "codex",
		AccountRef: testAccountRef,
	})
	if resRedir.OK || resRedir.HTTPStatus == nil || *resRedir.HTTPStatus != http.StatusFound || !strings.Contains(resRedir.Error, "http_302") {
		t.Fatalf("redirect should not follow: %+v", resRedir)
	}
}

func TestStoreConfigServerAndGlobalState(t *testing.T) {
	t.Parallel()
	dir := seedAppStateDB(t)
	ctx := context.Background()

	savedDefault := ReadSavedServerConfig(ctx, dir)
	if savedDefault.Enabled || savedDefault.MinIntervalMs != DefaultMinIntervalMs {
		t.Fatalf("default saved = %+v", savedDefault)
	}
	writeKVTest(t, dir, ServerConfigKVKey, `{"windowActivation":true,"windowActivationMinIntervalMs":1800000,"windowActivationDefaultIntervalMs":900000}`)
	saved := ReadSavedServerConfig(ctx, dir)
	if !saved.Enabled || saved.MinIntervalMs != 1800000 || saved.DefaultIntervalMs != 1800000 {
		t.Fatalf("parsed saved = %+v", saved)
	}

	globalNil := ReadGlobalState(ctx, dir, nil)
	if globalNil.Enabled != nil || !globalNil.SavedEnabled || globalNil.RestartRequired {
		t.Fatalf("globalNil = %+v", globalNil)
	}
	if floor := EffectiveMinIntervalMs(ctx, dir, nil); floor != 1800000 {
		t.Fatalf("EffectiveMinIntervalMs = %d, want 1800000", floor)
	}
}
