package webuiarchivedsessionsapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

func newTestHandler(t *testing.T, home string) http.Handler {
	t.Helper()
	// 历史归档用例走一个「没有原生归档」的假 app-server，
	// 保证 errors 只反映真实失败。
	return newTestHandlerWithCodex(t, home, emptyCodexCommandResolver(t))
}

func writeFixture(t *testing.T, path, body string, modifiedAt time.Time) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll(%s): %v", path, err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("WriteFile(%s): %v", path, err)
	}
	if err := os.Chtimes(path, modifiedAt, modifiedAt); err != nil {
		t.Fatalf("Chtimes(%s): %v", path, err)
	}
}

func doGet(t *testing.T, handler http.Handler) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	return recorder
}

func TestReturnsLegacyArchivesAndScope(t *testing.T) {
	home := t.TempDir()
	writeFixture(t,
		filepath.Join(home, ".claude", "projects", "alpha", ".archived", "claude-a.jsonl"),
		"{\"type\":\"user\",\"message\":{\"content\":\"Claude first\"}}\n",
		time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	)
	writeFixture(t,
		filepath.Join(home, ".claude", "projects", "alpha", ".archived", "claude-b.jsonl"),
		"{\"type\":\"assistant\",\"message\":{\"content\":\"ignore\"}}\n"+
			"{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Hello\"},{\"type\":\"text\",\"text\":\"world\"}]}}\n",
		time.Date(2026, 1, 3, 0, 0, 0, 0, time.UTC),
	)
	writeFixture(t,
		filepath.Join(home, ".gemini", "tmp", "beta", "chats", ".archived", "gemini-c.json"),
		"{\"sessionId\":\"gem-1\",\"summary\":\"Gemini summary\",\"messages\":[]}",
		time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC),
	)
	writeFixture(t,
		filepath.Join(home, ".gemini", "tmp", "beta", "chats", ".archived", "gemini-d.json"),
		"{\"messages\":[{\"type\":\"user\",\"content\":\"Gemini first\"}]}",
		time.Date(2026, 1, 4, 0, 0, 0, 0, time.UTC),
	)
	writeFixture(t,
		filepath.Join(home, ".gemini", "tmp", "beta", "chats", ".archived", "broken.json"),
		"{not json",
		time.Date(2026, 1, 5, 0, 0, 0, 0, time.UTC),
	)
	// 非归档位置与非归档后缀都不能出现在结果里。
	writeFixture(t,
		filepath.Join(home, ".claude", "projects", "alpha", "live.jsonl"),
		"{\"type\":\"user\",\"message\":{\"content\":\"live\"}}",
		time.Date(2026, 1, 6, 0, 0, 0, 0, time.UTC),
	)
	writeFixture(t,
		filepath.Join(home, ".claude", "projects", "alpha", ".archived", "notes.txt"),
		"not a session",
		time.Date(2026, 1, 6, 0, 0, 0, 0, time.UTC),
	)

	recorder := doGet(t, newTestHandler(t, home))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		OK       bool              `json:"ok"`
		Scope    string            `json:"scope"`
		Archived []Entry           `json:"archived"`
		Errors   []json.RawMessage `json:"errors"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !payload.OK || payload.Scope != ScopeAll {
		t.Fatalf("ok=%v scope=%q", payload.OK, payload.Scope)
	}
	if len(payload.Errors) != 0 {
		t.Fatalf("errors = %s", recorder.Body.String())
	}
	body := recorder.Body.String()
	for _, fragment := range []string{
		"\"projectDirName\":\"alpha\"",
		"\"canUnarchive\":true",
		"\"archivedAt\":",
	} {
		if !strings.Contains(body, fragment) {
			t.Fatalf("body missing %s: %s", fragment, body)
		}
	}
	wantIDs := []string{"gemini-d", "claude-b", "gem-1", "claude-a"}
	if len(payload.Archived) != len(wantIDs) {
		t.Fatalf("archived = %+v", payload.Archived)
	}
	for index, wantID := range wantIDs {
		if payload.Archived[index].ID != wantID {
			t.Fatalf("archived[%d].id = %q, want %q", index, payload.Archived[index].ID, wantID)
		}
	}
	first := payload.Archived[0]
	if first.Title != "Gemini first" || first.Provider != "gemini" ||
		first.ProjectDirName != "beta" || first.Origin != legacyOrigin || !first.CanUnarchive {
		t.Fatalf("gemini entry = %+v", first)
	}
	second := payload.Archived[1]
	if second.Title != "Hello world" || second.Provider != "claude" ||
		second.ProjectDirName != "alpha" || second.Origin != legacyOrigin || !second.CanUnarchive {
		t.Fatalf("claude entry = %+v", second)
	}
	if second.UpdatedAt != time.Date(2026, 1, 3, 0, 0, 0, 0, time.UTC).UnixMilli() ||
		second.ArchivedAt != second.UpdatedAt {
		t.Fatalf("timestamps = %d/%d", second.UpdatedAt, second.ArchivedAt)
	}
}

func TestTitleFallbacksMatchNodeSemantics(t *testing.T) {
	home := t.TempDir()
	writeFixture(t,
		filepath.Join(home, ".claude", "projects", "alpha", ".archived", "no-user.jsonl"),
		"{\"type\":\"assistant\",\"message\":{\"content\":\"assistant only\"}}\n",
		time.Now(),
	)
	writeFixture(t,
		filepath.Join(home, ".claude", "projects", "alpha", ".archived", "bad-json.jsonl"),
		"{bad\n{\"type\":\"user\",\"message\":{\"content\":\"after corruption\"}}\n",
		time.Now(),
	)
	writeFixture(t,
		filepath.Join(home, ".gemini", "tmp", "beta", "chats", ".archived", "first-empty.json"),
		"{\"messages\":[{\"type\":\"user\",\"content\":\"\"},{\"type\":\"user\",\"content\":\"later\"}]}",
		time.Now(),
	)

	recorder := doGet(t, newTestHandler(t, home))
	var payload struct {
		Archived []Entry `json:"archived"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload.Archived) != 3 {
		t.Fatalf("archived = %+v", payload.Archived)
	}
	for _, entry := range payload.Archived {
		if entry.Title != unnamedTitle {
			t.Fatalf("%s title = %q, want %q", entry.ID, entry.Title, unnamedTitle)
		}
	}
}

func TestClaudeTitleTruncatedTo80Runes(t *testing.T) {
	home := t.TempDir()
	title := strings.Repeat("汉", 100)
	writeFixture(t,
		filepath.Join(home, ".claude", "projects", "alpha", ".archived", "long.jsonl"),
		"{\"type\":\"user\",\"message\":{\"content\":\""+title+"\"}}",
		time.Now(),
	)
	recorder := doGet(t, newTestHandler(t, home))
	var payload struct {
		Archived []Entry `json:"archived"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload.Archived) != 1 || utf8.RuneCountInString(payload.Archived[0].Title) != maxTitleRunes {
		t.Fatalf("archived = %+v", payload.Archived)
	}
}

func TestEmptyResultIsArrayNotNull(t *testing.T) {
	recorder := doGet(t, newTestHandler(t, t.TempDir()))
	body := recorder.Body.String()
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, body)
	}
	if !strings.Contains(body, "\"archived\":[]") || !strings.Contains(body, "\"errors\":[]") {
		t.Fatalf("body = %s", body)
	}
}

func TestRejectsUnauthorized(t *testing.T) {
	handler, err := NewHandler(Dependencies{
		Authorizer:  fakeAuthorizer{allowed: false},
		HostHomeDir: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", recorder.Code)
	}
	if recorder.Header().Get("WWW-Authenticate") != "Bearer" {
		t.Fatalf("WWW-Authenticate = %q", recorder.Header().Get("WWW-Authenticate"))
	}
}

func TestRejectsNonGET(t *testing.T) {
	recorder := httptest.NewRecorder()
	newTestHandler(t, t.TempDir()).ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodPost, Path, nil),
	)
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", recorder.Code)
	}
	if recorder.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("Allow = %q", recorder.Header().Get("Allow"))
	}
}

func TestNewHandlerRequiresDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{HostHomeDir: t.TempDir()}); err != ErrInvalidDependencies {
		t.Fatalf("missing authorizer error = %v", err)
	}
	if _, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{}}); err != ErrInvalidDependencies {
		t.Fatalf("missing home error = %v", err)
	}
}

func TestSkipsSymlinkedEntries(t *testing.T) {
	home := t.TempDir()
	outside := t.TempDir()
	outsideFile := filepath.Join(outside, "linked.jsonl")
	writeFixture(t, outsideFile, "{\"type\":\"user\",\"message\":{\"content\":\"linked\"}}", time.Now())

	archivedRoot := filepath.Join(home, ".claude", "projects", "alpha", ".archived")
	if err := os.MkdirAll(archivedRoot, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.Symlink(outsideFile, filepath.Join(archivedRoot, "linked.jsonl")); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	// 整个项目目录是软链时也不能跟进去。
	projectsRoot := filepath.Join(home, ".claude", "projects")
	if err := os.Symlink(outside, filepath.Join(projectsRoot, "linked-project")); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}

	recorder := doGet(t, newTestHandler(t, home))
	var payload struct {
		Archived []Entry `json:"archived"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(payload.Archived) != 0 {
		t.Fatalf("archived = %+v", payload.Archived)
	}
}
