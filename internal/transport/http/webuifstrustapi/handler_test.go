package webuifstrustapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/webuifile"
)

const testNowMS int64 = 1_700_000_000_000

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type fakeStore struct {
	roots      []webuifile.TrustedRoot
	readErr    error
	writeErr   error
	written    []webuifile.TrustedRoot
	writeCalls int
}

func (fake *fakeStore) ReadTrustedRoots(context.Context) ([]webuifile.TrustedRoot, error) {
	return append([]webuifile.TrustedRoot(nil), fake.roots...), fake.readErr
}

func (fake *fakeStore) WriteTrustedRoots(_ context.Context, roots []webuifile.TrustedRoot) error {
	fake.writeCalls++
	if fake.writeErr != nil {
		return fake.writeErr
	}
	fake.written = append([]webuifile.TrustedRoot(nil), roots...)
	fake.roots = append([]webuifile.TrustedRoot(nil), roots...)
	return nil
}

func newTestHandler(t *testing.T, store Store, hostHomeDir string) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer:  fakeAuthorizer{allowed: true},
		Store:       store,
		AIHomeDir:   t.TempDir(),
		HostHomeDir: hostHomeDir,
		Now:         func() time.Time { return time.UnixMilli(testNowMS) },
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func performJSON(t *testing.T, handler http.Handler, body any) *httptest.ResponseRecorder {
	t.Helper()
	document, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("编码请求体失败: %v", err)
	}
	return performRaw(t, handler, string(document))
}

func performRaw(t *testing.T, handler http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, TrustPath, strings.NewReader(body)))
	return recorder
}

func decodeTrust(t *testing.T, recorder *httptest.ResponseRecorder) trustResponse {
	t.Helper()
	var response trustResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("响应不是 JSON: %s (%v)", recorder.Body.String(), err)
	}
	return response
}

func decodeError(t *testing.T, recorder *httptest.ResponseRecorder) errorView {
	t.Helper()
	var response errorView
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("错误响应不是 JSON: %s (%v)", recorder.Body.String(), err)
	}
	return response
}

func createFile(t *testing.T) (string, string) {
	t.Helper()
	directory := t.TempDir()
	filePath := filepath.Join(directory, "notes.md")
	if err := os.WriteFile(filePath, []byte("hello"), 0o600); err != nil {
		t.Fatalf("写入测试文件失败: %v", err)
	}
	return directory, filePath
}

func realPath(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatalf("EvalSymlinks(%s) error = %v", path, err)
	}
	return filepath.Clean(resolved)
}

func requireStatus(t *testing.T, recorder *httptest.ResponseRecorder, want int) {
	t.Helper()
	if recorder.Code != want {
		t.Fatalf("status = %d, want %d, body = %s", recorder.Code, want, recorder.Body.String())
	}
}

// TestTrustPersistsFileDirectory 锁住 200 响应形状与 app-state 写入内容。
func TestTrustPersistsFileDirectory(t *testing.T) {
	_, filePath := createFile(t)
	store := &fakeStore{}
	recorder := performJSON(t, newTestHandler(t, store, ""), map[string]any{
		"path":  filePath,
		"scope": webuifile.TrustScopeFileDirectory,
	})
	requireStatus(t, recorder, http.StatusOK)

	response := decodeTrust(t, recorder)
	wantFile := realPath(t, filePath)
	if !response.OK || response.FilePath != wantFile {
		t.Fatalf("response = %#v, want filePath=%s", response, wantFile)
	}
	wantRoot := filepath.Dir(wantFile)
	if response.TrustedRoot != wantRoot {
		t.Fatalf("trustedRoot = %s, want %s", response.TrustedRoot, wantRoot)
	}
	if store.writeCalls != 1 {
		t.Fatalf("writeCalls = %d, want 1", store.writeCalls)
	}
	if len(store.written) != 1 || store.written[0] != (webuifile.TrustedRoot{Path: wantRoot, TrustedAt: testNowMS}) {
		t.Fatalf("written = %#v", store.written)
	}
}

// TestTrustRejectsScopeThatExposesHostHome 覆盖 Node 的 unsafe_trust_scope：
// 父级候选包含宿主 HOME 时被 TrustCandidates 过滤掉。
func TestTrustRejectsScopeThatExposesHostHome(t *testing.T) {
	hostHome := t.TempDir()
	workspace := filepath.Join(hostHome, "project")
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	filePath := filepath.Join(workspace, "notes.md")
	if err := os.WriteFile(filePath, []byte("hello"), 0o600); err != nil {
		t.Fatalf("写入测试文件失败: %v", err)
	}

	store := &fakeStore{}
	recorder := performJSON(t, newTestHandler(t, store, hostHome), map[string]any{
		"path":  filePath,
		"scope": webuifile.TrustScopeParentDirectory,
	})
	requireStatus(t, recorder, http.StatusBadRequest)
	response := decodeError(t, recorder)
	if response.OK || response.Error != "unsafe_trust_scope" {
		t.Fatalf("error = %#v", response)
	}
	if store.writeCalls != 0 {
		t.Fatalf("writeCalls = %d, want 0", store.writeCalls)
	}
}

func TestTrustRejectsUnknownScope(t *testing.T) {
	_, filePath := createFile(t)
	store := &fakeStore{}
	recorder := performJSON(t, newTestHandler(t, store, ""), map[string]any{
		"path":  filePath,
		"scope": "workspace",
	})
	requireStatus(t, recorder, http.StatusBadRequest)
	if response := decodeError(t, recorder); response.Error != "unsafe_trust_scope" {
		t.Fatalf("error = %#v", response)
	}
	if store.writeCalls != 0 {
		t.Fatalf("writeCalls = %d, want 0", store.writeCalls)
	}
}

func TestTrustTargetErrorsMatchNode(t *testing.T) {
	directory := t.TempDir()
	cases := []struct {
		name   string
		body   map[string]any
		status int
		code   string
	}{
		{name: "path required", body: map[string]any{"scope": "file_directory"}, status: 400, code: "path_required"},
		{name: "missing", body: map[string]any{"path": filepath.Join(directory, "missing.txt"), "scope": "file_directory"}, status: 404, code: "not_found"},
		{name: "directory", body: map[string]any{"path": directory, "scope": "file_directory"}, status: 400, code: "not_a_file"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := performJSON(t, newTestHandler(t, &fakeStore{}, ""), testCase.body)
			requireStatus(t, recorder, testCase.status)
			if response := decodeError(t, recorder); response.Error != testCase.code {
				t.Fatalf("error = %#v, want %s", response, testCase.code)
			}
		})
	}
}

func TestTrustInvalidJSON(t *testing.T) {
	for _, body := range []string{"", "  ", "{", "[]", "null", "{\"path\":12}"} {
		t.Run(body, func(t *testing.T) {
			recorder := performRaw(t, newTestHandler(t, &fakeStore{}, ""), body)
			// 非对象 JSON 与 Node 一样落到字段为空 → path_required；语法错误才是 invalid_json。
			switch body {
			case "[]", "null", "{\"path\":12}":
				requireStatus(t, recorder, http.StatusBadRequest)
				if response := decodeError(t, recorder); response.Error != "path_required" {
					t.Fatalf("error = %#v", response)
				}
			default:
				requireStatus(t, recorder, http.StatusBadRequest)
				if response := decodeError(t, recorder); response.Error != "invalid_json" {
					t.Fatalf("error = %#v", response)
				}
			}
		})
	}
}

// TestTrustBodyLimit 锁住 64KB 上限与 Node 路由 catch 后的 500 形状。
func TestTrustBodyLimit(t *testing.T) {
	recorder := performRaw(t, newTestHandler(t, &fakeStore{}, ""), strings.Repeat("a", maxBodyBytes+1))
	requireStatus(t, recorder, http.StatusInternalServerError)
	response := decodeError(t, recorder)
	if response.Error != "trust_file_path_failed" || response.Message != "request_body_too_large" {
		t.Fatalf("error = %#v", response)
	}
}

func TestTrustReusesCoveringRootWithoutWriting(t *testing.T) {
	_, filePath := createFile(t)
	root := filepath.Dir(realPath(t, filePath))
	store := &fakeStore{roots: []webuifile.TrustedRoot{{Path: root, TrustedAt: 1}}}
	recorder := performJSON(t, newTestHandler(t, store, ""), map[string]any{
		"path":  filePath,
		"scope": webuifile.TrustScopeFileDirectory,
	})
	requireStatus(t, recorder, http.StatusOK)
	if response := decodeTrust(t, recorder); response.TrustedRoot != root {
		t.Fatalf("trustedRoot = %s, want %s", response.TrustedRoot, root)
	}
	if store.writeCalls != 0 {
		t.Fatalf("writeCalls = %d, want 0", store.writeCalls)
	}
}

func TestTrustReplacesCoveredRoots(t *testing.T) {
	_, filePath := createFile(t)
	root := filepath.Dir(realPath(t, filePath))
	unrelated := filepath.Join(t.TempDir(), "other")
	store := &fakeStore{roots: []webuifile.TrustedRoot{
		{Path: filepath.Join(root, "nested"), TrustedAt: 2},
		{Path: unrelated, TrustedAt: 3},
	}}
	recorder := performJSON(t, newTestHandler(t, store, ""), map[string]any{
		"path":  filePath,
		"scope": webuifile.TrustScopeFileDirectory,
	})
	requireStatus(t, recorder, http.StatusOK)
	want := []webuifile.TrustedRoot{
		{Path: root, TrustedAt: testNowMS},
		{Path: unrelated, TrustedAt: 3},
	}
	if len(store.written) != len(want) {
		t.Fatalf("written = %#v, want %#v", store.written, want)
	}
	for index := range want {
		if store.written[index] != want[index] {
			t.Fatalf("written[%d] = %#v, want %#v", index, store.written[index], want[index])
		}
	}
}

func TestTrustStorageFailures(t *testing.T) {
	t.Run("read", func(t *testing.T) {
		_, filePath := createFile(t)
		store := &fakeStore{readErr: errors.New("boom")}
		recorder := performJSON(t, newTestHandler(t, store, ""), map[string]any{
			"path": filePath, "scope": "file_directory",
		})
		requireStatus(t, recorder, http.StatusInternalServerError)
		response := decodeError(t, recorder)
		if response.Error != "trust_file_path_failed" || response.Message != "boom" {
			t.Fatalf("error = %#v", response)
		}
	})
	t.Run("write", func(t *testing.T) {
		_, filePath := createFile(t)
		store := &fakeStore{writeErr: errors.New("disk full")}
		recorder := performJSON(t, newTestHandler(t, store, ""), map[string]any{
			"path": filePath, "scope": "file_directory",
		})
		requireStatus(t, recorder, http.StatusInternalServerError)
		if response := decodeError(t, recorder); response.Error != "trust_file_path_failed" {
			t.Fatalf("error = %#v", response)
		}
	})
}

func TestTrustAuthorizationAndMethod(t *testing.T) {
	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{}, Store: &fakeStore{}})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder := performRaw(t, handler, "{}")
	requireStatus(t, recorder, http.StatusUnauthorized)

	recorder = httptest.NewRecorder()
	newTestHandler(t, &fakeStore{}, "").ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, TrustPath, nil))
	requireStatus(t, recorder, http.StatusMethodNotAllowed)
	if recorder.Header().Get("Allow") != http.MethodPost {
		t.Fatalf("Allow = %q, want POST", recorder.Header().Get("Allow"))
	}
}
