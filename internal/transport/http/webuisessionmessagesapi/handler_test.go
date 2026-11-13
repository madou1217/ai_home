package webuisessionmessagesapi

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

type allowAuth struct{}

func (allowAuth) Authorized(*http.Request) bool { return true }

func writeMsgTestFile(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

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

func TestAllProvidersMessagesAndByteBudget(t *testing.T) {
	home := t.TempDir()
	aiHome := filepath.Join(home, ".ai_home")

	// Gemini
	writeMsgTestFile(t, filepath.Join(home, ".gemini", "tmp", "gproj", "chats", "session-g1.json"),
		`{"sessionId":"g1","messages":[{"type":"user","content":[{"text":"Gem Q"}]},{"type":"gemini","model":"gemini-2.5-pro","content":"Gem A"}]}`)

	// AGY + app-state.db turn timeline + projection path canonicalization
	if err := os.MkdirAll(aiHome, 0o755); err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(aiHome, "app-state.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE model_usage_records (id INTEGER PRIMARY KEY, provider TEXT, session_id TEXT, model TEXT, source_kind TEXT, timestamp_ms INTEGER);
		INSERT INTO model_usage_records(provider, session_id, model, source_kind, timestamp_ms) VALUES ('agy','agy-1','claude-opus-4-6','native_session_done',1000);`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()

	projImg := filepath.Join(aiHome, "run", "auth-projections", "codex", "a1", ".codex", "pic.png")
	writeMsgTestFile(t, filepath.Join(home, ".gemini", "antigravity", "brain", "agy-1", ".system_generated", "logs", "transcript.jsonl"),
		`{"type":"USER_INPUT","content":"<USER_REQUEST>AGY Q</USER_REQUEST>","created_at":"1970-01-01T00:00:01.000Z"}`+"\n"+
			`{"type":"PLANNER_RESPONSE","content":"AGY A","created_at":"1970-01-01T00:00:01.500Z"}`+"\n")
	writeMsgTestFile(t, filepath.Join(aiHome, "chat-sessions", "canon-1.json"),
		`{"messages":[{"role":"user","content":"see `+projImg+`"}]}`)

	// 4MB page budget test (> 2.2MB per message => only 1 message returned in latest page)
	bigText := strings.Repeat("x", 2300*1024)
	bigPayload, _ := json.Marshal(map[string]any{
		"messages": []map[string]any{
			{"role": "user", "content": bigText},
			{"role": "assistant", "content": bigText},
		},
	})
	writeMsgTestFile(t, filepath.Join(aiHome, "chat-sessions", "big-1.json"), string(bigPayload))

	handler, err := NewHandler(Dependencies{Authorizer: allowAuth{}, HostHomeDir: home, AIHomeDir: aiHome})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET "+Path, handler)

	// 1. Unknown provider -> 501
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/sessions/unknown/s1/messages", nil))
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("unknown provider status=%d want 501", rec.Code)
	}

	// 2. Missing chat provider -> 404
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/sessions/chat/missing-1/messages", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing chat status=%d want 404", rec.Code)
	}

	// 3. Gemini
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/sessions/gemini/g1/messages?projectDirName=gproj", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Gem A") {
		t.Fatalf("gemini status=%d body=%s", rec.Code, rec.Body.String())
	}

	// 4. AGY timeline
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/sessions/agy/agy-1/messages", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "claude-opus-4-6") {
		t.Fatalf("agy status=%d body=%s", rec.Code, rec.Body.String())
	}

	// 5. Kimi (empty valid array, no 501)
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/sessions/kimi/k1/messages", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"messages":[]`) {
		t.Fatalf("kimi status=%d body=%s", rec.Code, rec.Body.String())
	}

	// 6. Canonicalize projection path
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/sessions/codex/canon-1/messages", nil))
	wantHostImg := filepath.Join(home, ".codex", "pic.png")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), wantHostImg) {
		t.Fatalf("canonicalize status=%d body=%s", rec.Code, rec.Body.String())
	}

	// 7. 4MB byte budget limits page to 1 message with hasMore=true
	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/management/webui/sessions/chat/big-1/messages?limit=50", nil))
	var bigResp struct {
		Start   int               `json:"start"`
		Total   int               `json:"total"`
		HasMore bool              `json:"hasMore"`
		Msgs    []json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &bigResp); err != nil {
		t.Fatal(err)
	}
	if bigResp.Total != 2 || len(bigResp.Msgs) != 1 || bigResp.Start != 1 || !bigResp.HasMore {
		t.Fatalf("expected 4MB cap to keep 1 message, got start=%d total=%d len=%d hasMore=%v", bigResp.Start, bigResp.Total, len(bigResp.Msgs), bigResp.HasMore)
	}
}
