package webuiprovidercliupgradeapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/providercliupgrade"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

func newHandler(t *testing.T, aiHomeDir string) http.Handler {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}, AIHomeDir: aiHomeDir, Catalog: catalog})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func seedLedger(t *testing.T, aiHomeDir string, payload string) {
	t.Helper()
	directory := filepath.Join(aiHomeDir, "run")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, "provider-cli-upgrade.json"), []byte(payload), 0o600); err != nil {
		t.Fatalf("write ledger: %v", err)
	}
}

func readStatus(t *testing.T, handler http.Handler) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	var payload map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode %q: %v", recorder.Body.String(), err)
		}
	}
	return recorder, payload
}

func rowsByProvider(payload map[string]any) map[string]map[string]any {
	result := map[string]map[string]any{}
	for _, item := range payload["providers"].([]any) {
		row := item.(map[string]any)
		result[row["provider"].(string)] = row
	}
	return result
}

func TestLedgerProjection(t *testing.T) {
	aiHomeDir := t.TempDir()
	seedLedger(t, aiHomeDir, "{\"schemaVersion\":1,\"global\":{\"enabled\":false,\"disabledReason\":\"paused\"},\"providers\":{\"codex\":{\"channel\":\"npm_global\",\"state\":\"broken\",\"installedVersion\":\"1.0.0\",\"latestVersion\":\"2.0.0\",\"knownGoodRollbackable\":true,\"blockedVersions\":[],\"history\":[{\"at\":1},{\"at\":2},{\"at\":3},{\"at\":4},{\"at\":5},{\"at\":6}]},\"custom\":{\"channel\":\"vendor_selfupdate\",\"installedVersion\":\"1\",\"latestVersion\":\"2\"}}}")
	handler := newHandler(t, aiHomeDir)
	recorder, payload := readStatus(t, handler)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if payload["scheduler"] != nil {
		t.Fatalf("scheduler = %#v", payload["scheduler"])
	}
	global := payload["global"].(map[string]any)
	if global["enabled"] != false || global["disabledReason"] != "paused" {
		t.Fatalf("global = %#v", global)
	}
	rows := rowsByProvider(payload)
	codex := rows["codex"]
	if codex["pinnable"] != true || codex["updateAvailable"] != true || codex["knownGoodRollbackable"] != true {
		t.Fatalf("codex = %#v", codex)
	}
	if len(codex["history"].([]any)) != 5 {
		t.Fatalf("history = %#v", codex["history"])
	}
	if rows["custom"]["pinnable"] != false {
		t.Fatalf("custom = %#v", rows["custom"])
	}
	if rows["claude"]["pinnable"] != false || rows["claude"]["state"] != "unknown" {
		t.Fatalf("claude = %#v", rows["claude"])
	}
}

func TestLiveSchedulerProjectionMerged(t *testing.T) {
	aiHomeDir := t.TempDir()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	enabled := true
	sched := providercliupgrade.NewScheduler(providercliupgrade.SchedulerOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   catalog,
		Config:    providercliupgrade.SchedulerConfig{Enabled: &enabled, ApplyEnabled: new(bool)},
		Providers: []string{"codex"},
		CycleDeps: &providercliupgrade.CycleDeps{
			DetectChannel: func(context.Context, string) (providercliupgrade.ChannelDetection, error) {
				return providercliupgrade.ChannelDetection{Channel: providercliupgrade.ChannelNpmGlobal, ResolvedPath: "/usr/local/bin/codex", Pinnable: true}, nil
			},
			CheckUpdate: func(context.Context, string) (providercliupgrade.UpdateCheckResult, error) {
				return providercliupgrade.UpdateCheckResult{InstalledVersion: "1.0.0", LatestVersion: "1.0.0"}, nil
			},
		},
	})
	sched.Start(context.Background())
	defer sched.Stop()

	res := sched.RunNow(context.Background(), "test_tick")
	if !res.OK {
		t.Fatalf("RunNow failed: %+v", res)
	}

	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		AIHomeDir:  aiHomeDir,
		Catalog:    catalog,
		Scheduler:  sched,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder, payload := readStatus(t, handler)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	schedulerView, ok := payload["scheduler"].(map[string]any)
	if !ok || schedulerView == nil {
		t.Fatalf("expected non-nil scheduler view, got %#v", payload["scheduler"])
	}
	if schedulerView["running"] != true || schedulerView["tickCount"] != float64(1) {
		t.Fatalf("schedulerView = %#v", schedulerView)
	}
	codex := rowsByProvider(payload)["codex"]
	if codex["lastTickState"] != "healthy" || codex["lastTickReason"] != "up_to_date" {
		t.Fatalf("codex tick fields mismatch: %#v", codex)
	}
}

func TestBlockedVersionAndCorruptLedger(t *testing.T) {
	aiHomeDir := t.TempDir()
	seedLedger(t, aiHomeDir, "{\"schemaVersion\":1,\"providers\":{\"codex\":{\"installedVersion\":\"1\",\"latestVersion\":\"2\",\"blockedVersions\":[\"2\"]}}}")
	handler := newHandler(t, aiHomeDir)
	_, payload := readStatus(t, handler)
	if rowsByProvider(payload)["codex"]["updateAvailable"] != false {
		t.Fatalf("blocked latest reported available: %#v", rowsByProvider(payload)["codex"])
	}

	corruptDir := t.TempDir()
	seedLedger(t, corruptDir, "{")
	_, corrupt := readStatus(t, newHandler(t, corruptDir))
	if corrupt["global"].(map[string]any)["enabled"] != true || len(corrupt["providers"].([]any)) == 0 {
		t.Fatalf("corrupt ledger = %#v", corrupt)
	}
}

func TestAuthAndMethod(t *testing.T) {
	catalog, _ := providers.NewCatalog(providers.BuiltinManifest())
	handler, _ := NewHandler(Dependencies{Authorizer: fakeAuthorizer{}, AIHomeDir: t.TempDir(), Catalog: catalog})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized = %d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	newHandler(t, t.TempDir()).ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST = %d", recorder.Code)
	}
}
