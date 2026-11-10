package webuiarchivedsessionsapi

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	fakeCodexMarker = "AIH_FAKE_CODEX_ARCHIVE"
	fakeCodexMode   = "AIH_FAKE_CODEX_ARCHIVE_MODE"

	fakeCodexEmpty         = "empty"
	fakeCodexThreads       = "threads"
	fakeCodexListError     = "list-error"
	fakeCodexImmediateExit = "exit-immediately"
)

// TestCodexAppServerProcess 是假 app-server：同一测试二进制带标记重新执行时，
// 只跑 NDJSON 服务循环，不进入任何断言。
func TestCodexAppServerProcess(t *testing.T) {
	if os.Getenv(fakeCodexMarker) != "1" {
		return
	}
	runFakeCodexAppServer(os.Getenv(fakeCodexMode))
	os.Exit(0)
}

func runFakeCodexAppServer(mode string) {
	if mode == fakeCodexImmediateExit {
		os.Exit(3)
	}
	writer := bufio.NewWriter(os.Stdout)
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64<<10), 8<<20)

	write := func(value map[string]any) {
		payload, err := json.Marshal(value)
		if err != nil {
			return
		}
		_, _ = writer.Write(append(payload, 10))
		_ = writer.Flush()
	}
	respond := func(id json.RawMessage, result any) {
		if len(id) == 0 {
			return
		}
		write(map[string]any{"id": id, "result": result})
	}
	fail := func(id json.RawMessage, code int, message string) {
		if len(id) == 0 {
			return
		}
		write(map[string]any{
			"id":    id,
			"error": map[string]any{"code": code, "message": message},
		})
	}

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		// 不声明 struct tag：直接取字段，避免替身与协议结构耦合。
		var envelope map[string]json.RawMessage
		if err := json.Unmarshal([]byte(line), &envelope); err != nil {
			continue
		}
		id := envelope["id"]
		var method string
		_ = json.Unmarshal(envelope["method"], &method)
		switch method {
		case "initialize":
			respond(id, map[string]any{})
		case "thread/list":
			if mode == fakeCodexListError {
				fail(id, -32000, "归档列表不可用")
				continue
			}
			if mode == fakeCodexEmpty || mode == "" {
				respond(id, map[string]any{"data": []any{}, "nextCursor": ""})
				continue
			}
			respond(id, map[string]any{
				"data": []any{
					map[string]any{
						"id":        "0192aaaa-native",
						"name":      "Native named",
						"preview":   "preview ignored",
						"cwd":       "/Users/x/repo",
						"updatedAt": 1767398400,
					},
					map[string]any{
						"id":        "0192bbbb-native",
						"name":      "",
						"preview":   "Preview title",
						"cwd":       "/Users/x/other",
						"updatedAt": 1767148800,
					},
					map[string]any{
						"id":        "",
						"name":      "dropped",
						"cwd":       "/tmp",
						"updatedAt": 1,
					},
				},
				"nextCursor": "",
			})
		}
	}
}

// codexCommandResolver 返回指向假 app-server 的 resolver。
func codexCommandResolver(t *testing.T, mode string) CodexCommandResolver {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable(): %v", err)
	}
	return func(context.Context) (CodexCommand, error) {
		return CodexCommand{
			Command: executable,
			Args:    []string{"-test.run=TestCodexAppServerProcess", "--"},
			Env: append(os.Environ(),
				fakeCodexMarker+"=1",
				fakeCodexMode+"="+mode,
			),
		}, nil
	}
}

func emptyCodexCommandResolver(t *testing.T) CodexCommandResolver {
	t.Helper()
	return codexCommandResolver(t, fakeCodexEmpty)
}

func newTestHandlerWithCodex(t *testing.T, home string, resolver CodexCommandResolver) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer:   fakeAuthorizer{allowed: true},
		HostHomeDir:  home,
		CodexCommand: resolver,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle(Path, handler)
	return mux
}

type archivedPayload struct {
	OK       bool              `json:"ok"`
	Scope    string            `json:"scope"`
	Archived []Entry           `json:"archived"`
	Errors   []json.RawMessage `json:"errors"`
}

func TestMergesCodexNativeArchivedThreads(t *testing.T) {
	home := t.TempDir()
	writeFixture(t,
		filepath.Join(home, ".claude", "projects", "alpha", ".archived", "claude-a.jsonl"),
		`{"type":"user","message":{"content":"Legacy title"}}`,
		time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC),
	)
	recorder := doGet(t, newTestHandlerWithCodex(t, home, codexCommandResolver(t, fakeCodexThreads)))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var payload archivedPayload
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !payload.OK || payload.Scope != ScopeAll {
		t.Fatalf("ok=%v scope=%q body=%s", payload.OK, payload.Scope, recorder.Body.String())
	}
	if len(payload.Errors) != 0 {
		t.Fatalf("errors = %s", recorder.Body.String())
	}
	if len(payload.Archived) != 3 {
		t.Fatalf("archived = %+v", payload.Archived)
	}
	native := payload.Archived[0]
	if native.ID != "0192aaaa-native" || native.Title != "Native named" ||
		native.Provider != providerCodex || native.Origin != "native" ||
		native.ProjectPath != "/Users/x/repo" || !native.CanUnarchive {
		t.Fatalf("native entry = %+v", native)
	}
	if native.UpdatedAt != 1767398400000 || native.ArchivedAt != 0 {
		t.Fatalf("native timestamps = %d/%d", native.UpdatedAt, native.ArchivedAt)
	}
	if payload.Archived[1].Provider != "claude" || payload.Archived[1].Title != "Legacy title" {
		t.Fatalf("legacy entry lost: %+v", payload.Archived)
	}
	preview := payload.Archived[2]
	if preview.ID != "0192bbbb-native" || preview.Title != "Preview title" {
		t.Fatalf("preview fallback entry = %+v", preview)
	}
}

func TestCodexProcessFailureIsReportedPerProvider(t *testing.T) {
	home := t.TempDir()
	writeFixture(t,
		filepath.Join(home, ".gemini", "tmp", "beta", "chats", ".archived", "gem.json"),
		`{"sessionId":"gem-1","summary":"Gemini","messages":[]}`,
		time.Now(),
	)
	recorder := doGet(t, newTestHandlerWithCodex(t, home, codexCommandResolver(t, fakeCodexImmediateExit)))
	var payload archivedPayload
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !payload.OK || payload.Scope != ScopeLegacy {
		t.Fatalf("ok=%v scope=%q", payload.OK, payload.Scope)
	}
	if len(payload.Archived) != 1 || payload.Archived[0].Provider != "gemini" {
		t.Fatalf("legacy entries must survive: %+v", payload.Archived)
	}
	failure := decodeErrors(t, payload)
	if len(failure) != 1 || failure[0].Provider != providerCodex ||
		failure[0].Error != codeCodexListFailed {
		t.Fatalf("errors = %+v", failure)
	}
	if strings.TrimSpace(failure[0].Message) == "" {
		t.Fatalf("failure must carry a message: %+v", failure[0])
	}
}

func TestCodexRPCErrorIsNotReportedAsSuccess(t *testing.T) {
	recorder := doGet(t, newTestHandlerWithCodex(t, t.TempDir(), codexCommandResolver(t, fakeCodexListError)))
	var payload archivedPayload
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.Scope != ScopeLegacy || len(payload.Archived) != 0 {
		t.Fatalf("scope=%q archived=%+v", payload.Scope, payload.Archived)
	}
	failure := decodeErrors(t, payload)
	if len(failure) != 1 || failure[0].Error != codeCodexListFailed {
		t.Fatalf("errors = %+v", failure)
	}
}

func TestCodexResolverFailuresAreReported(t *testing.T) {
	cases := map[string]CodexCommandResolver{
		"nil resolver": nil,
		"resolver error": func(context.Context) (CodexCommand, error) {
			return CodexCommand{}, os.ErrNotExist
		},
		"empty command": func(context.Context) (CodexCommand, error) {
			return CodexCommand{Command: "  "}, nil
		},
	}
	for name, resolver := range cases {
		t.Run(name, func(t *testing.T) {
			recorder := doGet(t, newTestHandlerWithCodex(t, t.TempDir(), resolver))
			var payload archivedPayload
			if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if payload.Scope != ScopeLegacy {
				t.Fatalf("scope = %q", payload.Scope)
			}
			failure := decodeErrors(t, payload)
			if len(failure) != 1 || failure[0].Provider != providerCodex ||
				failure[0].Error != codeCodexCommandUnavailable {
				t.Fatalf("errors = %+v", failure)
			}
		})
	}
}

func decodeErrors(t *testing.T, payload archivedPayload) []archivedError {
	t.Helper()
	failures := make([]archivedError, 0, len(payload.Errors))
	for _, raw := range payload.Errors {
		var failure archivedError
		if err := json.Unmarshal(raw, &failure); err != nil {
			t.Fatalf("decode error entry: %v", err)
		}
		failures = append(failures, failure)
	}
	return failures
}
