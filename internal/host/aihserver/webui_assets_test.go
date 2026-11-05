package aihserver

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestNewWebUIHandlerDisabledByEmptyDir(t *testing.T) {
	handler, err := newWebUIHandler("   ")
	if err != nil || handler != nil {
		t.Fatalf("empty web dir should disable hosting, got handler=%v err=%v", handler, err)
	}
}

func TestNewWebUIHandlerRejectsMissingDir(t *testing.T) {
	if _, err := newWebUIHandler(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("missing web dir should fail fast")
	}
}

func TestNewWebUIHandlerServesIndex(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>ui</html>"), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
	handler, err := newWebUIHandler(dir)
	if err != nil || handler == nil {
		t.Fatalf("handler=%v err=%v", handler, err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/ui/", nil))
	if recorder.Code != http.StatusOK || recorder.Body.String() != "<html>ui</html>" {
		t.Fatalf("status=%d body=%q", recorder.Code, recorder.Body.String())
	}
}
