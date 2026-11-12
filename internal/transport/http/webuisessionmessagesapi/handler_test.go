package webuisessionmessagesapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

type allowAuth struct{}

func (allowAuth) Authorized(*http.Request) bool { return true }

func TestChatSessionMessagesPagination(t *testing.T) {
	home := t.TempDir()
	sessions := filepath.Join(home, ".ai_home", "chat-sessions")
	if err := os.MkdirAll(sessions, 0o755); err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"id": "s1", "messages": []any{map[string]any{"role": "user", "content": "a"}, map[string]any{"role": "assistant", "content": "b"}, map[string]any{"role": "user", "content": "c"}}}
	raw, _ := json.Marshal(payload)
	if err := os.WriteFile(filepath.Join(sessions, "s1.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandler(Dependencies{Authorizer: allowAuth{}, HostHomeDir: home})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	mux := http.NewServeMux()
	mux.Handle("GET "+Path, handler)
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/management/webui/sessions/claude/s1/messages?limit=2", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		OK       bool              `json:"ok"`
		Messages []json.RawMessage `json:"messages"`
		Start    int               `json:"start"`
		Total    int               `json:"total"`
		HasMore  bool              `json:"hasMore"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || body.Total != 3 || body.Start != 1 || len(body.Messages) != 2 || !body.HasMore {
		t.Fatalf("body=%+v", body)
	}
}
