package providerconfigs

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
)

type fakeCLIRunner struct {
	bins     map[string]string
	versions map[string]string
	helps    map[string]string
}

func (f fakeCLIRunner) ResolveBinary(provider, _ string, _ map[string]string) string {
	return f.bins[provider]
}

func (f fakeCLIRunner) Version(_ context.Context, binary string) string {
	return f.versions[binary]
}

func (f fakeCLIRunner) Help(_ context.Context, binary string) string {
	return f.helps[binary]
}

func newTestService(t *testing.T) (*Service, string, string) {
	t.Helper()
	hostHome := t.TempDir()
	aiHome := t.TempDir()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	svc := NewService(catalog, hostHome, aiHome).WithCLIRunner(fakeCLIRunner{
		bins: map[string]string{
			"codex": "/usr/local/bin/codex",
		},
		versions: map[string]string{
			"/usr/local/bin/codex": "0.170.0",
		},
		helps: map[string]string{
			"/usr/local/bin/codex": "Usage: codex [OPTIONS]\n  --model <model>\n  --ask-for-approval <mode>\n  --sandbox <mode>\n",
		},
	})
	return svc, hostHome, aiHome
}

func TestListProvidersAndEmbeddedSchemas(t *testing.T) {
	svc, hostHome, _ := newTestService(t)
	if err := os.MkdirAll(filepath.Join(hostHome, ".codex"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hostHome, ".codex", "config.toml"), []byte("model = \"gpt-5\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	list := svc.ListProviders(context.Background(), true)
	if !list.OK || list.Total == 0 {
		t.Fatalf("expected non-empty provider config list: %+v", list)
	}
	var codex *ProviderSummary
	for i := range list.Providers {
		if list.Providers[i].ID == "codex" {
			codex = &list.Providers[i]
			break
		}
	}
	if codex == nil || codex.CLI == nil || !codex.CLI.Installed || codex.CLI.Version != "0.170.0" {
		t.Fatalf("unexpected codex summary: %+v", codex)
	}
	if !strings.HasPrefix(codex.Files[0].DisplayPath, "~") || strings.Contains(codex.Files[0].DisplayPath, hostHome) {
		t.Fatalf("displayPath must mask hostHomeDir: %s", codex.Files[0].DisplayPath)
	}

	rawJSON, _ := json.Marshal(list)
	if strings.Contains(string(rawJSON), hostHome) {
		t.Fatalf("list JSON leaked hostHomeDir: %s", hostHome)
	}

	if s := GetConfigSchema("codex.config"); s == nil || s.FieldCount == 0 {
		t.Fatalf("codex.config schema should be embedded")
	}
}

func TestFormatValidatorsAndRedaction(t *testing.T) {
	// JSONC valid with comments and trailing comma
	jsoncValid := `{
  // line comment
  "model": "claude-3.7",
  /* block
     comment */
  "provider": { "openai": { "apiKey": "sk-secret-1234", }, },
}`
	res := ValidateContent(jsoncValid, "jsonc")
	if !res.Valid || len(res.Errors) != 0 {
		t.Fatalf("expected valid jsonc, got %+v", res)
	}

	// JSONC invalid with line number check
	jsoncBad := "{\n  // c\n  \"a\": \n}"
	resBad := ValidateContent(jsoncBad, "jsonc")
	if resBad.Valid || len(resBad.Errors) == 0 || resBad.Errors[0].Line == 0 {
		t.Fatalf("expected JSONC syntax error with line > 0, got %+v", resBad)
	}

	// TOML valid
	tomlValid := `model = "gpt-5"
approval_policy = "on-request"

[mcp_servers.fs]
command = "npx"
args = ["-y", "mcp-fs"]
env = { API_KEY = "sk-abc", MODE = "ro" }

[[profiles]]
name = "fast"
`
	tomlRes := ValidateContent(tomlValid, "toml")
	if !tomlRes.Valid {
		t.Fatalf("expected valid TOML, got %+v", tomlRes)
	}

	// TOML duplicate key
	tomlDup := "model = \"a\"\nmodel = \"b\"\n"
	if ValidateContent(tomlDup, "toml").Valid {
		t.Fatalf("duplicate TOML key should fail validation")
	}

	// TOML redaction
	red := RedactConfigContent(tomlValid, "toml", GetConfigSchema("codex.config"), false)
	if !red.Parsed || strings.Contains(red.Content, "sk-abc") || !strings.Contains(red.Content, "<redacted>") {
		t.Fatalf("TOML redaction failed: %+v", red)
	}

	// YAML validation + redaction
	yamlSrc := "server:\n  api_token: tok-999\n  port: 8080\nitems:\n  - a\n  - b\n"
	if !ValidateContent(yamlSrc, "yaml").Valid {
		t.Fatalf("expected valid YAML")
	}
	if ValidateContent("key:\n\tbad: 1\n", "yaml").Valid {
		t.Fatalf("expected tab indent YAML to fail")
	}
	redYaml := RedactConfigContent(yamlSrc, "yaml", nil, false)
	if !redYaml.Parsed || strings.Contains(redYaml.Content, "tok-999") || !strings.Contains(redYaml.Content, "<redacted>") {
		t.Fatalf("YAML redaction failed: %+v", redYaml)
	}
}

func TestSaveHistoryConflictRestoreAndExport(t *testing.T) {
	svc, hostHome, _ := newTestService(t)
	ctx := context.Background()

	// Seed pre-existing codex config
	codexDir := filepath.Join(hostHome, ".codex")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfgPath := filepath.Join(codexDir, "config.toml")
	initial := "model = \"gpt-4\"\nopenai_api_key = \"sk-orig\"\n"
	if err := os.WriteFile(cfgPath, []byte(initial), 0o644); err != nil {
		t.Fatal(err)
	}

	read1, err := svc.ReadFile(ctx, "codex", "config")
	if err != nil {
		t.Fatalf("ReadFile error: %v", err)
	}
	if read1.Schema == nil || read1.SchemaVersion == nil || !read1.SchemaVersion.Mismatch || !read1.SchemaVersion.InstalledNewer {
		t.Fatalf("expected schema version mismatch info, got %+v", read1.SchemaVersion)
	}
	// Check CLI equivalent enrichment
	var foundApproval, foundModel bool
	for _, f := range read1.Schema.Fields {
		if f.Path == "approval_policy" && f.CLIFlag == "--ask-for-approval" {
			foundApproval = true
		}
		if f.Path == "model" && f.CLISample == "codex --model <model>" {
			foundModel = true
		}
	}
	if !foundApproval || !foundModel {
		t.Fatalf("expected CLI flag equivalents from --help, approval=%v model=%v", foundApproval, foundModel)
	}

	// Conflict on wrong revision
	_, err = svc.SaveFile(ctx, "codex", "config", "model = \"x\"\n", SaveOptions{ExpectedRevision: "badrev"})
	if cfgErr, ok := IsConfigError(err); !ok || cfgErr.HTTPStatus() != 409 {
		t.Fatalf("expected 409 conflict, got %v", err)
	}

	// Save v2 creates baseline + save entry
	save1, err := svc.SaveFile(ctx, "codex", "config", "model = \"gpt-5\"\nopenai_api_key = \"sk-new\"\n", SaveOptions{
		ExpectedRevision: read1.Revision,
		Note:             "upgrade model",
	})
	if err != nil || !save1.Changed || save1.HistoryEntry == nil {
		t.Fatalf("SaveFile failed: %+v err=%v", save1, err)
	}

	hist, err := svc.ListHistory("codex", "config")
	if err != nil || len(hist.Entries) != 2 {
		t.Fatalf("expected baseline + save entries, got %+v err=%v", hist, err)
	}
	baselineID := hist.Entries[1].ID

	// Export redacted masks secret
	expRed, err := svc.ExportFile(ctx, "codex", "config", "redacted")
	if err != nil || strings.Contains(expRed.Content, "sk-new") || expRed.Filename != "config.redacted.toml" {
		t.Fatalf("unexpected redacted export: %+v err=%v", expRed, err)
	}

	// Restore baseline
	restored, err := svc.RestoreHistoryEntry(ctx, "codex", "config", baselineID)
	if err != nil || !restored.Changed {
		t.Fatalf("RestoreHistoryEntry failed: %+v err=%v", restored, err)
	}
	disk, _ := os.ReadFile(cfgPath)
	if string(disk) != initial {
		t.Fatalf("expected restored content %q, got %q", initial, string(disk))
	}

	// Cap at MaxHistoryEntries (30)
	for i := 0; i < 35; i++ {
		if _, err := svc.SaveFile(ctx, "codex", "config", fmt.Sprintf("model = \"m-%d\"\n", i), SaveOptions{}); err != nil {
			t.Fatalf("save %d: %v", i, err)
		}
	}
	histCapped, _ := svc.ListHistory("codex", "config")
	if len(histCapped.Entries) != MaxHistoryEntries {
		t.Fatalf("expected %d history entries, got %d", MaxHistoryEntries, len(histCapped.Entries))
	}
}
