package configedit

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
)

func TestResolveAppTargetFromCatalogAndIDE(t *testing.T) {
	cat, catErr := providers.NewCatalog(providers.BuiltinManifest())
	if catErr != nil {
		t.Fatalf("catalog failed: %v", catErr)
	}
	home := t.TempDir()

	codexTarget, err := ResolveAppTarget(cat, "codex", home, "darwin", nil)
	if err != nil {
		t.Fatalf("resolve codex failed: %v", err)
	}
	if !strings.HasSuffix(codexTarget.TargetPath, filepath.Join(".codex", "config.toml")) || codexTarget.ConfigFormat != "toml" {
		t.Fatalf("unexpected codex target: %+v", codexTarget)
	}

	claudeDesktop, err := ResolveAppTarget(cat, "claude-desktop", home, "darwin", nil)
	if err != nil {
		t.Fatalf("resolve claude-desktop failed: %v", err)
	}
	if !strings.HasSuffix(claudeDesktop.TargetPath, filepath.Join("Library", "Application Support", "Claude", "claude_desktop_config.json")) {
		t.Fatalf("unexpected claude-desktop target: %+v", claudeDesktop)
	}

	vscodeTarget, err := ResolveAppTarget(cat, "vscode", home, "linux", func(k string) string {
		if k == "XDG_CONFIG_HOME" {
			return filepath.Join(home, "xdg")
		}
		return ""
	})
	if err != nil || !strings.HasSuffix(vscodeTarget.TargetPath, filepath.Join("xdg", "Code", "User", "settings.json")) {
		t.Fatalf("unexpected vscode target: %+v, err=%v", vscodeTarget, err)
	}

	if _, err := ResolveAppTarget(cat, "nonexistent", home, "darwin", nil); HTTPStatus(err) != 400 {
		t.Fatalf("expected 400 unsupported_app, got err=%v", err)
	}
}

func TestReadSaveAtomicRevisionConflictAndCreate(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.toml")

	// 1. Missing without AllowCreate -> 404 config_not_found
	if _, err := ReadTarget(context.Background(), Target{
		AppID: "herdr", Platform: "linux", TargetPath: cfgPath, ConfigName: "config.toml", ConfigFormat: "toml",
	}, Options{}); HTTPStatus(err) != 404 {
		t.Fatalf("expected 404 when missing, got err=%v", err)
	}

	// 2. AllowCreate returns revision="missing" then creates once; second create -> 409 config_conflict
	target := Target{AppID: "herdr", Platform: "linux", TargetPath: cfgPath, ConfigName: "config.toml", ConfigFormat: "toml"}
	missingView, err := ReadTarget(context.Background(), target, Options{AllowCreate: true, DefaultContent: "# default\n"})
	if err != nil || missingView.Exists || missingView.Revision != "missing" {
		t.Fatalf("expected missing create view, got %+v err=%v", missingView, err)
	}

	saved, err := SaveTarget(context.Background(), target, "port = 8080\n", Options{
		AllowCreate:      true,
		ExpectedRevision: "missing",
	})
	if err != nil || !saved.Exists || saved.Size != len("port = 8080\n") {
		t.Fatalf("create failed: %+v err=%v", saved, err)
	}

	if _, err := SaveTarget(context.Background(), target, "port = 9090\n", Options{
		AllowCreate:      true,
		ExpectedRevision: "missing",
	}); HTTPStatus(err) != 409 {
		t.Fatalf("expected 409 conflict on duplicate create, got %v", err)
	}

	// 3. Stale revision triggers 409 config_conflict
	if _, err := SaveTarget(context.Background(), target, "port = 9999\n", Options{
		ExpectedRevision: "deadbeef",
	}); HTTPStatus(err) != 409 {
		t.Fatalf("expected 409 conflict on stale revision, got %v", err)
	}

	// 4. Current revision succeeds
	readBack, err := ReadTarget(context.Background(), target, Options{})
	if err != nil || readBack.Content != "port = 8080\n" {
		t.Fatalf("readBack unexpected: %+v err=%v", readBack, err)
	}
	updated, err := SaveTarget(context.Background(), target, "port = 8081\n", Options{ExpectedRevision: readBack.Revision})
	if err != nil || updated.Revision == readBack.Revision {
		t.Fatalf("update failed: %+v err=%v", updated, err)
	}

	// 5. Over 2MB triggers 413 config_too_large
	oversized := strings.Repeat("a", MaxConfigBytes+1)
	if _, err := SaveTarget(context.Background(), target, oversized, Options{ExpectedRevision: updated.Revision}); HTTPStatus(err) != 413 {
		t.Fatalf("expected 413 config_too_large, got %v", err)
	}
}

func TestValidateTOMLAndTargetRevision(t *testing.T) {
	if res := ValidateTOML("[section]\nkey = \"ok\"\n"); !res.OK {
		t.Fatalf("expected valid toml, got %+v", res)
	}
	if res := ValidateTOML("[unclosed\nkey = "); res.OK {
		t.Fatalf("expected invalid toml error")
	}

	dir := t.TempDir()
	pathA := filepath.Join(dir, "a.toml")
	if err := os.WriteFile(pathA, []byte("x=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	rev1 := ComputeTargetRevision(pathA, "linux")
	rev2 := ComputeTargetRevision(pathA, "linux")
	if rev1 == "" || rev1 != rev2 {
		t.Fatalf("expected deterministic target revision")
	}
}

type fakeElevation struct {
	available bool
	ok        bool
}

func (fake fakeElevation) RunElevated(_ context.Context, _ string, _ string, _ map[string]string) ElevationResult {
	return ElevationResult{OK: fake.ok, Available: fake.available, Cancelled: !fake.ok, Detail: "cancelled"}
}

func TestElevationErrorMapping(t *testing.T) {
	var tkErr *ToolkitError
	errUnavail := buildElevationError("读取", ElevationResult{Available: false})
	if !errors.As(errUnavail, &tkErr) || tkErr.Code != "privilege_unavailable" || HTTPStatus(errUnavail) != 403 {
		t.Fatalf("expected privilege_unavailable 403, got %v", errUnavail)
	}
	errDenied := buildElevationError("保存", ElevationResult{Available: true, Cancelled: true, Detail: "user cancel"})
	if !errors.As(errDenied, &tkErr) || tkErr.Code != "privilege_denied" || HTTPStatus(errDenied) != 403 {
		t.Fatalf("expected privilege_denied 403, got %v", errDenied)
	}
}
