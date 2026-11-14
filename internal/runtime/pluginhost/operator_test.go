package pluginhost

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	plugincontrol "github.com/madou1217/ai_home/application/plugincontrol"
	"github.com/madou1217/ai_home/internal/adapters/pluginartifact"
	"github.com/madou1217/ai_home/internal/adapters/pluginstatestore"
	"github.com/madou1217/ai_home/internal/pluginerr"
	"github.com/madou1217/ai_home/internal/runtime/pricingcatalog"
)

func seedControlStateDB(t *testing.T, aiHomeDir string, state map[string]any) {
	t.Helper()
	dbPath := filepath.Join(aiHomeDir, pluginstatestore.DatabaseFileName)
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`); err != nil {
		t.Fatalf("create app_kv: %v", err)
	}
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatalf("marshal seed state: %v", err)
	}
	if _, err := db.Exec(`INSERT OR REPLACE INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)`,
		pluginstatestore.ControlStateKey, string(raw), time.Now().UnixMilli()); err != nil {
		t.Fatalf("insert control state: %v", err)
	}
}

func TestServiceInstanceOperatorEnableDisableCASAndDefaults(t *testing.T) {
	nodePath, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node executable not found; skipping operator integration test")
	}
	repoRoot := locateRepoRoot(t)
	aiHomeDir := t.TempDir()
	pluginDir := filepath.Join(aiHomeDir, "plugins", "echo-op", "1.0.0")
	if err := os.MkdirAll(pluginDir, 0o755); err != nil {
		t.Fatalf("mkdir pluginDir: %v", err)
	}
	_ = writeTestPluginModule(t, pluginDir, "index.mjs", "echo-op.cmd", "op")
	artifactFile := filepath.Join(aiHomeDir, "plugins", "echo-op-1.0.0.aih-plugin")
	if err := os.WriteFile(artifactFile, []byte("zip-placeholder"), 0o600); err != nil {
		t.Fatalf("write artifact placeholder: %v", err)
	}

	manifest := makeValidTestManifest("echo-op", "1.0.0", "index.mjs", "echo-op.cmd", "command")
	manifest["permissions"] = map[string]any{
		"network":     []any{"https://api.example.com"},
		"filesystem":  map[string]any{"read": []any{}, "write": []any{}},
		"secrets":     []any{},
		"environment": []any{},
	}
	manifest["configSchema"] = map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"required":             []any{"endpoint"},
		"properties": map[string]any{
			"endpoint": map[string]any{"type": "string", "default": "https://default.example.com"},
			"retries":  map[string]any{"type": "integer", "default": 2},
		},
	}
	fingerprint := pluginartifact.PermissionFingerprint(manifest)

	seedControlStateDB(t, aiHomeDir, map[string]any{
		"schemaVersion":    1,
		"revision":         1,
		"activeGeneration": 0,
		"customTopExtra":   "preserve-me",
		"installed": []any{
			map[string]any{
				"pluginId":               "echo-op",
				"version":                "1.0.0",
				"digest":                 "abc123",
				"artifact":               artifactFile,
				"directory":              pluginDir,
				"manifest":               manifest,
				"permissionsFingerprint": fingerprint,
				"signature":              map[string]any{"status": "unsigned"},
			},
		},
		"instances":   []any{},
		"generations": []any{},
	})

	store, err := pluginstatestore.NewStore(aiHomeDir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	shortSock := filepath.Join(os.TempDir(), "aih-pl1-op-"+filepath.Base(aiHomeDir)+".sock")
	defer func() { _ = os.Remove(shortSock) }()

	var audits []string
	pStore, err := pricingcatalog.NewStore(aiHomeDir)
	if err != nil {
		t.Fatalf("pricingcatalog.NewStore: %v", err)
	}
	pSvc, err := pricingcatalog.NewService(pricingcatalog.ServiceDependencies{
		Store:            pStore,
		CommunitySources: []pricingcatalog.CommunitySource{},
	})
	if err != nil {
		t.Fatalf("pricingcatalog.NewService: %v", err)
	}

	svc, err := NewService(ServiceOptions{
		AIHomeDir:      aiHomeDir,
		RepoRoot:       repoRoot,
		SocketPath:     shortSock,
		NodePath:       nodePath,
		HostVersion:    "1.0.0",
		PricingService: pSvc,
		OnAudit: func(op string, details map[string]any) {
			audits = append(audits, op)
		},
	})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	defer func() { _ = svc.Close() }()

	if err := svc.Start(context.Background()); err != nil {
		t.Fatalf("Service.Start: %v", err)
	}
	operator, err := svc.Operator(store, store)
	if err != nil {
		t.Fatalf("Service.Operator: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// 1. Permission gate must reject without acceptPermissions.
	_, err = operator.Apply(ctx, plugincontrol.OperationEnable, "echo-op", json.RawMessage(`{"pluginId":"echo-op"}`), nil)
	if coded, ok := pluginerr.From(err); !ok || coded.Code != plugincontrol.CodePermissionsUnacknowledged {
		t.Fatalf("expected %s, got %v", plugincontrol.CodePermissionsUnacknowledged, err)
	}

	// 2. Invalid configSchema property must reject with plugin_config_invalid.
	_, err = operator.Apply(ctx, plugincontrol.OperationEnable, "echo-op", json.RawMessage(`{"pluginId":"echo-op","acceptPermissions":true,"configuration":{"retries":"bad"}}`), nil)
	if coded, ok := pluginerr.From(err); !ok || coded.Code != plugincontrol.CodeConfigInvalid {
		t.Fatalf("expected %s, got %v", plugincontrol.CodeConfigInvalid, err)
	}

	// 3. Valid enable fills configSchema defaults, commits CAS, activates real subprocess, and updates Registry!
	enableRes, err := operator.Apply(ctx, plugincontrol.OperationEnable, "echo-op", json.RawMessage(`{"pluginId":"echo-op","acceptPermissions":true}`), nil)
	if err != nil {
		t.Fatalf("enable failed: %v", err)
	}
	if enableRes.Revision != 2 || enableRes.Generation != 1 || enableRes.State != "active" {
		t.Fatalf("unexpected enable result: %+v", enableRes)
	}
	if len(svc.Registry().Generations()) != 1 {
		t.Fatalf("expected Registry to have generation 1, got %v", svc.Registry().Generations())
	}

	// Verify persisted DB applied defaults & kept extra top-level fields.
	reader, _ := NewSQLiteControlStateReader(aiHomeDir)
	rawDB, _ := reader.ReadRawControlState(ctx)
	var saved map[string]any
	if err := json.Unmarshal(rawDB, &saved); err != nil {
		t.Fatalf("unmarshal saved state: %v", err)
	}
	if saved["customTopExtra"] != "preserve-me" {
		t.Fatalf("expected customTopExtra preserved, got %v", saved["customTopExtra"])
	}
	if !strings.Contains(string(rawDB), `"endpoint":"https://default.example.com"`) {
		t.Fatalf("expected default config values persisted, got %s", string(rawDB))
	}

	// 4. Stale expectedRevision rejects and cleanly releases publish lock so next call isn't publish_busy.
	staleRev := int64(1)
	_, err = operator.Apply(ctx, plugincontrol.OperationDisable, "echo-op", json.RawMessage(`{"instanceId":"echo-op"}`), &staleRev)
	if coded, ok := pluginerr.From(err); !ok || coded.Code != plugincontrol.CodeRevisionConflict {
		t.Fatalf("expected revision conflict, got %v", err)
	}

	// 5. Doctor must report OK=true while active.
	doc := svc.Doctor(ctx)
	if !doc.OK || doc.Revision != 2 || doc.Capabilities["command"] != 1 {
		t.Fatalf("unexpected doctor report: %+v", doc)
	}

	// 6. Disable must stop the host cleanly and transition to idle.
	disRes, err := operator.Apply(ctx, plugincontrol.OperationDisable, "echo-op", json.RawMessage(`{"instanceId":"echo-op"}`), nil)
	if err != nil {
		t.Fatalf("disable failed: %v", err)
	}
	if disRes.Revision != 3 || disRes.Generation != 0 || disRes.State != "idle" {
		t.Fatalf("unexpected disable result: %+v", disRes)
	}
	time.Sleep(150 * time.Millisecond)
	if len(audits) != 2 || audits[0] != "enable" || audits[1] != "disable" {
		t.Fatalf("expected enable+disable audit calls, got %v", audits)
	}
}
