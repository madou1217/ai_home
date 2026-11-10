package webuisshhostbrowseapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

const testConnectionsJSON = `[
  {"id":"conn_1","label":"prod","host":"10.0.0.1","port":2222,"user":"deploy","authType":"key","identityFile":"/home/deploy/.ssh/id_ed25519"},
  {"id":"conn_2","label":"stage","host":"10.0.0.2"}
]`

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type fakeConnections struct {
	raw   string
	found bool
	err   error
	reads int
}

func (fake *fakeConnections) ReadConnections(context.Context) (string, bool, error) {
	fake.reads++
	return fake.raw, fake.found, fake.err
}

type runnerCall struct {
	connection Conn
	argv       []string
}

type fakeRunner struct {
	stdout []byte
	err    error
	calls  []runnerCall
}

func (runner *fakeRunner) Run(_ context.Context, connection Conn, argv []string) ([]byte, error) {
	runner.calls = append(runner.calls, runnerCall{connection: connection, argv: append([]string(nil), argv...)})
	return runner.stdout, runner.err
}

func newTestHandler(t *testing.T, dependencies Dependencies) *Handler {
	t.Helper()
	if dependencies.Authorizer == nil {
		dependencies.Authorizer = fakeAuthorizer{allowed: true}
	}
	if dependencies.Connections == nil {
		dependencies.Connections = &fakeConnections{raw: testConnectionsJSON, found: true}
	}
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func browseRequest(connectionID string, subDir string) *http.Request {
	query := url.Values{}
	query.Set("connectionId", connectionID)
	query.Set("subDir", subDir)
	return httptest.NewRequest(http.MethodGet, Path+"?"+query.Encode(), nil)
}

func assertError(t *testing.T, recorder *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if recorder.Code != status {
		t.Fatalf("status = %d, want %d; body = %s", recorder.Code, status, recorder.Body.String())
	}
	var payload struct {
		OK      bool   `json:"ok"`
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	if payload.OK {
		t.Fatalf("ok = true: %s", recorder.Body.String())
	}
	if payload.Error != code {
		t.Fatalf("error = %q, want %q", payload.Error, code)
	}
}

func TestUnauthorized(t *testing.T) {
	runner := &fakeRunner{}
	handler := newTestHandler(t, Dependencies{
		Authorizer: fakeAuthorizer{allowed: false},
		Runner:     runner,
	})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, browseRequest("conn_1", "/srv"))

	assertError(t, recorder, http.StatusUnauthorized, "unauthorized")
	if len(runner.calls) != 0 {
		t.Fatalf("runner calls = %d", len(runner.calls))
	}
}

func TestMethodNotAllowed(t *testing.T) {
	runner := &fakeRunner{}
	handler := newTestHandler(t, Dependencies{Runner: runner})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, nil))

	assertError(t, recorder, http.StatusMethodNotAllowed, "method_not_allowed")
	if allow := recorder.Header().Get("Allow"); allow != http.MethodGet {
		t.Fatalf("Allow = %q", allow)
	}
	if len(runner.calls) != 0 {
		t.Fatalf("runner calls = %d", len(runner.calls))
	}
}

func TestRunnerUnavailable(t *testing.T) {
	handler := newTestHandler(t, Dependencies{})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, browseRequest("conn_1", "/srv"))

	assertError(t, recorder, http.StatusNotImplemented, "ssh_runner_unavailable")
}

func TestMissingConnectionID(t *testing.T) {
	runner := &fakeRunner{}
	handler := newTestHandler(t, Dependencies{Runner: runner})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, browseRequest("", "/srv"))

	assertError(t, recorder, http.StatusBadRequest, "missing_connection")
	if len(runner.calls) != 0 {
		t.Fatalf("runner calls = %d", len(runner.calls))
	}
}

func TestUnknownConnection(t *testing.T) {
	runner := &fakeRunner{}
	handler := newTestHandler(t, Dependencies{Runner: runner})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, browseRequest("conn_missing", "/srv"))

	assertError(t, recorder, http.StatusNotFound, "not_found")
	if len(runner.calls) != 0 {
		t.Fatalf("runner calls = %d", len(runner.calls))
	}
}

func TestInvalidRemotePath(t *testing.T) {
	cases := map[string]string{
		"空路径":   "",
		"相对路径":  "srv/app",
		"家目录简写": "~/app",
		"上跳段":   "/srv/../etc",
		"末尾上跳段": "/srv/app/..",
		"换行":    "/srv/app\nrm -rf /",
		"回车":    "/srv/app\r",
		"NUL":   "/srv/app\x00",
		"过长":    "/" + strings.Repeat("a", maxRemotePathBytes),
	}
	for name, subDir := range cases {
		t.Run(name, func(t *testing.T) {
			runner := &fakeRunner{}
			connections := &fakeConnections{raw: testConnectionsJSON, found: true}
			handler := newTestHandler(t, Dependencies{Connections: connections, Runner: runner})
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, browseRequest("conn_1", subDir))

			assertError(t, recorder, http.StatusBadRequest, "invalid_path")
			if connections.reads != 0 {
				t.Fatalf("connections reads = %d", connections.reads)
			}
			if len(runner.calls) != 0 {
				t.Fatalf("runner calls = %d", len(runner.calls))
			}
		})
	}
}

func TestBrowseListsEntries(t *testing.T) {
	stdout := strings.Join([]string{
		"total 12",
		"drwxr-xr-x  2 deploy deploy 4096 Nov 10 12:34 app",
		"-rw-r--r--  1 deploy deploy  128 Nov 10 11:00 notes.txt",
		"lrwxrwxrwx  1 deploy deploy    3 Nov 10 12:00 current -> app",
		"drwx------  2 deploy deploy 4096 Nov  9 08:15 .secret",
		"",
	}, "\n")
	runner := &fakeRunner{stdout: []byte(stdout)}
	handler := newTestHandler(t, Dependencies{Runner: runner})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, browseRequest("conn_1", "/srv"))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d; body = %s", recorder.Code, recorder.Body.String())
	}
	if len(runner.calls) != 1 {
		t.Fatalf("runner calls = %d", len(runner.calls))
	}
	call := runner.calls[0]
	if strings.Join(call.argv, "|") != "ls|-lA|--|/srv/" {
		t.Fatalf("argv = %#v", call.argv)
	}
	if call.connection.ID != "conn_1" || call.connection.Host != "10.0.0.1" ||
		call.connection.User != "deploy" || call.connection.Port != 2222 {
		t.Fatalf("connection = %#v", call.connection)
	}

	var payload struct {
		OK          bool        `json:"ok"`
		CurrentDir  string      `json:"currentDir"`
		ParentDir   string      `json:"parentDir"`
		Entries     []Entry     `json:"entries"`
		Directories []Directory `json:"directories"`
		Truncated   bool        `json:"truncated"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	if !payload.OK || payload.CurrentDir != "/srv" || payload.ParentDir != "/" {
		t.Fatalf("payload = %#v", payload)
	}
	if payload.Truncated {
		t.Fatal("truncated = true")
	}
	names := make([]string, 0, len(payload.Entries))
	for _, entry := range payload.Entries {
		names = append(names, entry.Name)
	}
	if strings.Join(names, ",") != ".secret,app,current,notes.txt" {
		t.Fatalf("entries = %v", names)
	}
	app := payload.Entries[1]
	if !app.IsDirectory || app.Type != "d" || app.Permissions != "rwxr-xr-x" ||
		app.Size != 4096 || app.Modified != "Nov 10 12:34" || app.Path != "/srv/app" {
		t.Fatalf("app = %#v", app)
	}
	link := payload.Entries[2]
	if link.IsDirectory || link.Type != "l" || link.Name != "current" || link.Path != "/srv/current" {
		t.Fatalf("link = %#v", link)
	}
	if len(payload.Directories) != 2 ||
		payload.Directories[0].Name != ".secret" || payload.Directories[0].Path != "/srv/.secret" ||
		payload.Directories[1].Name != "app" || payload.Directories[1].Path != "/srv/app" {
		t.Fatalf("directories = %#v", payload.Directories)
	}
}

func TestBrowseRootDirectory(t *testing.T) {
	runner := &fakeRunner{stdout: []byte("drwxr-xr-x 2 root root 4096 Nov 10 12:34 srv\n")}
	handler := newTestHandler(t, Dependencies{Runner: runner})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, browseRequest("conn_1", "/"))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d; body = %s", recorder.Code, recorder.Body.String())
	}
	if strings.Join(runner.calls[0].argv, "|") != "ls|-lA|--|/" {
		t.Fatalf("argv = %#v", runner.calls[0].argv)
	}
	var payload struct {
		CurrentDir string `json:"currentDir"`
		ParentDir  string `json:"parentDir"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.CurrentDir != "/" || payload.ParentDir != "/" {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestBrowseTruncatesOutput(t *testing.T) {
	alpha := "drwxr-xr-x 2 u g 4096 Nov 10 12:34 alpha\n"
	beta := "-rw-r--r-- 1 u g 10 Nov 10 12:34 beta\n"
	gamma := "-rw-r--r-- 1 u g 10 Nov 10 12:34 gamma\n"
	limit := len(alpha) + len(beta) + 5

	runner := &fakeRunner{stdout: []byte(alpha + beta + gamma)}
	handler := newTestHandler(t, Dependencies{Runner: runner, MaxOutputBytes: limit})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, browseRequest("conn_1", "/srv"))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d; body = %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Entries   []Entry `json:"entries"`
		Truncated bool    `json:"truncated"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !payload.Truncated {
		t.Fatal("truncated = false")
	}
	if len(payload.Entries) != 2 || payload.Entries[0].Name != "alpha" || payload.Entries[1].Name != "beta" {
		t.Fatalf("entries = %#v", payload.Entries)
	}
}

func TestBrowseTruncatesBeforeFirstLine(t *testing.T) {
	runner := &fakeRunner{stdout: []byte("-rw-r--r-- 1 u g 10 Nov 10 12:34 alpha\n")}
	handler := newTestHandler(t, Dependencies{Runner: runner, MaxOutputBytes: 10})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, browseRequest("conn_1", "/srv"))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d; body = %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Entries   []Entry `json:"entries"`
		Truncated bool    `json:"truncated"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !payload.Truncated || len(payload.Entries) != 0 {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestConnectionsReadFailure(t *testing.T) {
	runner := &fakeRunner{}
	handler := newTestHandler(t, Dependencies{
		Connections: &fakeConnections{err: errors.New("db down")},
		Runner:      runner,
	})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, browseRequest("conn_1", "/srv"))

	assertError(t, recorder, http.StatusInternalServerError, "ssh_connections_read_failed")
	if len(runner.calls) != 0 {
		t.Fatalf("runner calls = %d", len(runner.calls))
	}
}

func TestInvalidConnectionsJSON(t *testing.T) {
	handler := newTestHandler(t, Dependencies{
		Connections: &fakeConnections{raw: "{", found: true},
		Runner:      &fakeRunner{},
	})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, browseRequest("conn_1", "/srv"))

	assertError(t, recorder, http.StatusInternalServerError, "ssh_connections_invalid")
}

func TestRemoteFailureMessage(t *testing.T) {
	runner := &fakeRunner{err: &RemoteFailure{Code: "not_found"}}
	handler := newTestHandler(t, Dependencies{Runner: runner})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, browseRequest("conn_1", "/srv"))

	assertError(t, recorder, http.StatusInternalServerError, "remote_execution_failed")
	if !strings.Contains(recorder.Body.String(), "目录不存在或不可访问") {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}

func TestRemoteExecutionErrorPassthrough(t *testing.T) {
	runner := &fakeRunner{err: errors.New("dial tcp 10.0.0.1:2222: connection refused")}
	handler := newTestHandler(t, Dependencies{Runner: runner})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, browseRequest("conn_1", "/srv"))

	assertError(t, recorder, http.StatusInternalServerError, "remote_execution_failed")
	if !strings.Contains(recorder.Body.String(), "connection refused") {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}
