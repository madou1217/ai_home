package webuiprojectswriteapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

type staticAuthorizer struct{ allow bool }

func (a staticAuthorizer) Authorized(*http.Request) bool { return a.allow }

func TestProjectsWriteBrowseOpenRemoveAndPick(t *testing.T) {
	ctx := context.Background()
	hostHome := t.TempDir()
	aiHome := filepath.Join(hostHome, ".ai_home")
	projA := filepath.Join(hostHome, "alpha")
	projB := filepath.Join(hostHome, "Beta")
	sshDir := filepath.Join(hostHome, ".ssh")
	plainFile := filepath.Join(hostHome, "note.txt")
	for _, dir := range []string{aiHome, projA, projB, sshDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
	}
	if err := os.WriteFile(plainFile, []byte("hi"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	codexDir := filepath.Join(hostHome, ".codex")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatalf("mkdir codex: %v", err)
	}
	if err := os.WriteFile(filepath.Join(codexDir, "config.toml"), []byte("[features]\nhooks = false\n\n[model]\nname = \"gpt-5\"\n"), 0o644); err != nil {
		t.Fatalf("write codex config: %v", err)
	}

	changes := 0
	var pickerResult struct {
		path      string
		cancelled bool
		err       error
	}
	handler, err := NewHandler(Dependencies{
		Authorizer:  staticAuthorizer{allow: true},
		HostHomeDir: hostHome,
		AiHomeDir:   aiHome,
		Picker: func(context.Context, string) (string, bool, error) {
			return pickerResult.path, pickerResult.cancelled, pickerResult.err
		},
		OnChanged: func(context.Context) { changes++ },
		Now:       func() int64 { return 1700000000000 },
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}

	post := func(path string, body any) *httptest.ResponseRecorder {
		var buf bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&buf).Encode(body)
		}
		req := httptest.NewRequest(http.MethodPost, path, &buf)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	// 1. Browse ~ & reject .ssh & plain file & missing.
	rec := post(BrowsePath, map[string]string{"subDir": "~"})
	if rec.Code != http.StatusOK {
		t.Fatalf("browse ~ = %d %s", rec.Code, rec.Body.String())
	}
	var browseResp struct {
		OK          bool   `json:"ok"`
		CurrentDir  string `json:"currentDir"`
		Directories []struct {
			Name string `json:"name"`
			Path string `json:"path"`
		} `json:"directories"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &browseResp)
	if len(browseResp.Directories) < 3 || browseResp.CurrentDir != hostHome {
		t.Fatalf("unexpected browse response: %+v", browseResp)
	}
	if post(BrowsePath, map[string]string{"subDir": sshDir}).Code != http.StatusForbidden {
		t.Fatal("expected .ssh browse to be 403")
	}
	if post(BrowsePath, map[string]string{"subDir": plainFile}).Code != http.StatusBadRequest {
		t.Fatal("expected non-dir browse to be 400")
	}
	if post(BrowsePath, map[string]string{"subDir": filepath.Join(hostHome, "missing")}).Code != http.StatusNotFound {
		t.Fatal("expected missing browse to be 404")
	}

	// 2. Open project validation & persistence & codex config.
	if post(OpenPath, map[string]string{"projectPath": "relative/path"}).Code != http.StatusBadRequest {
		t.Fatal("expected relative open path to fail 400")
	}
	openRec := post(OpenPath, map[string]string{"projectPath": projA + "/", "name": "Alpha Repo"})
	if openRec.Code != http.StatusOK || changes != 1 {
		t.Fatalf("open failed: code=%d body=%s changes=%d", openRec.Code, openRec.Body.String(), changes)
	}
	dbPath, _ := appstate.DatabasePath(aiHome)
	rawState, found, _ := appstate.ReadKV(ctx, dbPath, webuiProjectsKey)
	if !found || !strings.Contains(rawState, projA) || !strings.Contains(rawState, "Alpha Repo") {
		t.Fatalf("unexpected saved state: %q", rawState)
	}
	tomlAfterOpen, _ := os.ReadFile(filepath.Join(codexDir, "config.toml"))
	tomlStr := string(tomlAfterOpen)
	if strings.Contains(tomlStr, "hooks = false") || !strings.Contains(tomlStr, "[projects."+`"`+projA+`"`+"]") {
		t.Fatalf("unexpected codex config after open:\n%s", tomlStr)
	}

	// 3. Remove project removes opened entry, hides path, removes codex section.
	remRec := post(RemovePath, map[string]string{"projectPath": projA})
	if remRec.Code != http.StatusOK || changes != 2 {
		t.Fatalf("remove failed: code=%d body=%s changes=%d", remRec.Code, remRec.Body.String(), changes)
	}
	rawState, _, _ = appstate.ReadKV(ctx, dbPath, webuiProjectsKey)
	if !strings.Contains(rawState, `"hiddenPaths":["`+projA+`"]`) {
		t.Fatalf("expected hiddenPaths in state: %q", rawState)
	}
	tomlAfterRem, _ := os.ReadFile(filepath.Join(codexDir, "config.toml"))
	if strings.Contains(string(tomlAfterRem), projA) {
		t.Fatalf("expected codex project section removed:\n%s", string(tomlAfterRem))
	}

	// Re-open unhides path.
	if openAgain := post(OpenPath, map[string]string{"projectPath": projA}); openAgain.Code != http.StatusOK {
		t.Fatalf("re-open failed: %d", openAgain.Code)
	}
	rawState, _, _ = appstate.ReadKV(ctx, dbPath, webuiProjectsKey)
	if strings.Contains(rawState, `"hiddenPaths":["`+projA+`"]`) {
		t.Fatalf("expected re-open to clear hiddenPaths: %q", rawState)
	}

	// 4. Pick project states: picked, cancelled, unsupported.
	pickerResult.path = projB + "/"
	pickRec := post(PickPath, nil)
	if pickRec.Code != http.StatusOK || !strings.Contains(pickRec.Body.String(), `"cancelled":false`) || !strings.Contains(pickRec.Body.String(), `"Beta"`) {
		t.Fatalf("unexpected pick response: code=%d body=%s", pickRec.Code, pickRec.Body.String())
	}
	pickerResult.path = ""
	pickerResult.cancelled = true
	cancelRec := post(PickPath, nil)
	if cancelRec.Code != http.StatusOK || !strings.Contains(cancelRec.Body.String(), `"cancelled":true`) {
		t.Fatalf("unexpected cancel pick response: %d %s", cancelRec.Code, cancelRec.Body.String())
	}
	pickerResult.cancelled = false
	pickerResult.err = &PickerError{Code: "project_picker_unsupported_platform"}
	errRec := post(PickPath, nil)
	if errRec.Code != http.StatusInternalServerError || !strings.Contains(errRec.Body.String(), "project_picker_unsupported_platform") {
		t.Fatalf("unexpected error pick response: %d %s", errRec.Code, errRec.Body.String())
	}
}
