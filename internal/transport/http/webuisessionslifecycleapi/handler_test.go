package webuisessionslifecycleapi

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

	"github.com/madou1217/ai_home/internal/adapters/codex/appserver"
)

// fakeAuthorizer 是可控的鉴权策略。
type fakeAuthorizer struct {
	allow bool
}

func (authorizer fakeAuthorizer) Authorized(*http.Request) bool {
	return authorizer.allow
}

// fakeCodexClient 记录调用，不启动子进程。
type fakeCodexClient struct {
	capabilities appserver.Capabilities
	probeErr     error
	archiveErr   error
	unarchiveErr error
	archived     []string
	unarchived   []string
	closeCount   int
}

func (client *fakeCodexClient) ListArchivedThreads(context.Context) ([]appserver.ArchivedThread, error) {
	return nil, nil
}

func (client *fakeCodexClient) ArchiveThread(_ context.Context, threadID string) error {
	if client.archiveErr != nil {
		return client.archiveErr
	}
	client.archived = append(client.archived, threadID)
	return nil
}

func (client *fakeCodexClient) UnarchiveThread(_ context.Context, threadID string) error {
	if client.unarchiveErr != nil {
		return client.unarchiveErr
	}
	client.unarchived = append(client.unarchived, threadID)
	return nil
}

func (client *fakeCodexClient) ProbeCapabilities(context.Context) (appserver.Capabilities, error) {
	if client.probeErr != nil {
		return appserver.Capabilities{}, client.probeErr
	}
	return client.capabilities, nil
}

func (client *fakeCodexClient) Close() error {
	client.closeCount++
	return nil
}

// newTestHandler 用给定的宿主 HOME 与依赖创建 Handler；默认覆盖三个 Provider。
func newTestHandler(t *testing.T, home string, dependencies Dependencies) *Handler {
	t.Helper()
	dependencies.Authorizer = fakeAuthorizer{allow: true}
	dependencies.HostHomeDir = home
	if len(dependencies.Providers) == 0 {
		dependencies.Providers = []string{providerClaude, providerGemini, providerCodex, providerOpenCode}
	}
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("创建 Handler 失败: %v", err)
	}
	return handler
}

func performRequest(handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeBody(t *testing.T, recorder *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(recorder.Body.Bytes(), target); err != nil {
		t.Fatalf("解析响应失败: %v（body=%s）", err, recorder.Body.String())
	}
}

func TestNewHandlerRejectsMissingDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("缺少鉴权与 HOME 时应返回 ErrInvalidDependencies，实际: %v", err)
	}
	if _, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allow: true}}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("缺少 HostHomeDir 时应返回 ErrInvalidDependencies，实际: %v", err)
	}
}

func TestArchiveRequestValidation(t *testing.T) {
	cases := []struct {
		name       string
		method     string
		authorized bool
		body       string
		wantStatus int
		wantCode   string
	}{
		{name: "未鉴权", method: http.MethodPost, authorized: false, body: `{"provider":"claude","sessionId":"a"}`, wantStatus: http.StatusUnauthorized, wantCode: "unauthorized"},
		{name: "方法不允许", method: http.MethodGet, authorized: true, body: "", wantStatus: http.StatusMethodNotAllowed, wantCode: "method_not_allowed"},
		{name: "空请求体", method: http.MethodPost, authorized: true, body: "", wantStatus: http.StatusBadRequest, wantCode: "missing_params"},
		{name: "JSON 无效", method: http.MethodPost, authorized: true, body: "{", wantStatus: http.StatusBadRequest, wantCode: "invalid_json"},
		{name: "缺 provider", method: http.MethodPost, authorized: true, body: `{"sessionId":"a"}`, wantStatus: http.StatusBadRequest, wantCode: "missing_params"},
		{name: "缺 sessionId", method: http.MethodPost, authorized: true, body: `{"provider":"claude"}`, wantStatus: http.StatusBadRequest, wantCode: "missing_params"},
		{name: "上跳目录", method: http.MethodPost, authorized: true, body: `{"provider":"claude","sessionId":"../escape"}`, wantStatus: http.StatusBadRequest, wantCode: "invalid_session_id"},
		{name: "路径分隔符", method: http.MethodPost, authorized: true, body: `{"provider":"claude","sessionId":"a/b"}`, wantStatus: http.StatusBadRequest, wantCode: "invalid_session_id"},
		{name: "反斜杠", method: http.MethodPost, authorized: true, body: `{"provider":"claude","sessionId":"a\\b"}`, wantStatus: http.StatusBadRequest, wantCode: "invalid_session_id"},
		{name: "点目录", method: http.MethodPost, authorized: true, body: `{"provider":"claude","sessionId":".."}`, wantStatus: http.StatusBadRequest, wantCode: "invalid_session_id"},
		{name: "未知 Provider", method: http.MethodPost, authorized: true, body: `{"provider":"cline","sessionId":"a"}`, wantStatus: http.StatusUnprocessableEntity, wantCode: "session_archive_unsupported"},
		{name: "会话不存在", method: http.MethodPost, authorized: true, body: `{"provider":"claude","sessionId":"missing"}`, wantStatus: http.StatusNotFound, wantCode: "session_not_found"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			home := t.TempDir()
			handler := newTestHandler(t, home, Dependencies{})
			if !testCase.authorized {
				handler.authorizer = fakeAuthorizer{allow: false}
			}
			recorder := performRequest(handler, testCase.method, ArchivePath, testCase.body)
			if recorder.Code != testCase.wantStatus {
				t.Fatalf("状态码 = %d，期望 %d（body=%s）", recorder.Code, testCase.wantStatus, recorder.Body.String())
			}
			var body errorResponse
			decodeBody(t, recorder, &body)
			if body.OK {
				t.Fatalf("失败响应不应带 ok=true: %s", recorder.Body.String())
			}
			if body.Error != testCase.wantCode {
				t.Fatalf("错误码 = %q，期望 %q", body.Error, testCase.wantCode)
			}
			if strings.TrimSpace(body.Message) == "" {
				t.Fatalf("错误响应缺少 message: %s", recorder.Body.String())
			}
		})
	}
}

func TestArchiveClaudeMovesFileAndIsIdempotent(t *testing.T) {
	home := t.TempDir()
	projectRoot := filepath.Join(home, ".claude", "projects", "alpha")
	if err := os.MkdirAll(projectRoot, 0o755); err != nil {
		t.Fatalf("准备项目目录失败: %v", err)
	}
	activePath := filepath.Join(projectRoot, "claude-1.jsonl")
	if err := os.WriteFile(activePath, []byte(`{"type":"user"}`+"\n"), 0o644); err != nil {
		t.Fatalf("准备会话文件失败: %v", err)
	}
	archivedPath := filepath.Join(projectRoot, archiveDirName, "claude-1.jsonl")

	handler := newTestHandler(t, home, Dependencies{})
	recorder := performRequest(handler, http.MethodPost, ArchivePath, `{"provider":"claude","sessionId":"claude-1"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("归档状态码 = %d，期望 200（body=%s）", recorder.Code, recorder.Body.String())
	}
	var body archiveResponse
	decodeBody(t, recorder, &body)
	if !body.OK || body.Provider != providerClaude || body.SessionID != "claude-1" ||
		body.NativeSessionID != "claude-1" || body.Origin != originLegacy {
		t.Fatalf("归档响应形状不符: %+v", body)
	}
	if _, err := os.Stat(activePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("活跃会话文件应已被移走: %v", err)
	}
	if !isRegularFile(archivedPath) {
		t.Fatalf("归档文件不存在: %s", archivedPath)
	}

	// 重复归档必须幂等：仍然 200，且不产生第二个文件。
	before, err := os.Stat(archivedPath)
	if err != nil {
		t.Fatalf("读取归档文件失败: %v", err)
	}
	repeat := performRequest(handler, http.MethodPost, ArchivePath, `{"provider":"claude","sessionId":"claude-1"}`)
	if repeat.Code != http.StatusOK {
		t.Fatalf("重复归档状态码 = %d，期望 200（body=%s）", repeat.Code, repeat.Body.String())
	}
	after, err := os.Stat(archivedPath)
	if err != nil {
		t.Fatalf("重复归档后归档文件丢失: %v", err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatalf("重复归档不应改写归档文件: %v -> %v", before.ModTime(), after.ModTime())
	}
	entries, err := os.ReadDir(filepath.Join(projectRoot, archiveDirName))
	if err != nil {
		t.Fatalf("读取归档目录失败: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("归档目录条目数 = %d，期望 1", len(entries))
	}
}

func TestArchiveGeminiMatchesSessionIDField(t *testing.T) {
	home := t.TempDir()
	chatsRoot := filepath.Join(home, ".gemini", "tmp", "beta", "chats")
	if err := os.MkdirAll(chatsRoot, 0o755); err != nil {
		t.Fatalf("准备 chats 目录失败: %v", err)
	}
	fileName := "session-2026.json"
	content := `{"sessionId":"gemini-9","summary":"标题","messages":[]}`
	if err := os.WriteFile(filepath.Join(chatsRoot, fileName), []byte(content), 0o644); err != nil {
		t.Fatalf("准备会话文件失败: %v", err)
	}

	handler := newTestHandler(t, home, Dependencies{})
	recorder := performRequest(handler, http.MethodPost, ArchivePath, `{"provider":"gemini","sessionId":"gemini-9"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("归档状态码 = %d，期望 200（body=%s）", recorder.Code, recorder.Body.String())
	}
	archivedPath := filepath.Join(chatsRoot, archiveDirName, fileName)
	if !isRegularFile(archivedPath) {
		t.Fatalf("归档文件不存在: %s", archivedPath)
	}
	if _, err := os.Stat(filepath.Join(chatsRoot, fileName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("活跃文件应已被移走: %v", err)
	}

	repeat := performRequest(handler, http.MethodPost, ArchivePath, `{"provider":"gemini","sessionId":"gemini-9"}`)
	if repeat.Code != http.StatusOK {
		t.Fatalf("重复归档状态码 = %d，期望 200（body=%s）", repeat.Code, repeat.Body.String())
	}
}

func TestArchiveCodexUsesAppServer(t *testing.T) {
	home := t.TempDir()
	client := &fakeCodexClient{}
	handler := newTestHandler(t, home, Dependencies{
		Codex: func(context.Context) (CodexClient, error) { return client, nil },
	})
	recorder := performRequest(handler, http.MethodPost, ArchivePath, `{"provider":"codex","sessionId":"thread-1"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("归档状态码 = %d，期望 200（body=%s）", recorder.Code, recorder.Body.String())
	}
	var body archiveResponse
	decodeBody(t, recorder, &body)
	if body.Origin != originNative || body.NativeSessionID != "thread-1" {
		t.Fatalf("Codex 归档响应形状不符: %+v", body)
	}
	if len(client.archived) != 1 || client.archived[0] != "thread-1" {
		t.Fatalf("应调用一次 thread/archive，实际: %v", client.archived)
	}
	if client.closeCount != 1 {
		t.Fatalf("客户端应被关闭一次，实际 %d", client.closeCount)
	}
}

func TestArchiveCodexFailures(t *testing.T) {
	cases := []struct {
		name       string
		codex      CodexDialer
		wantStatus int
		wantCode   string
	}{
		{
			name:       "未接线",
			codex:      nil,
			wantStatus: http.StatusServiceUnavailable,
			wantCode:   codeProviderRuntimeNotFound,
		},
		{
			name: "运行时启动失败",
			codex: func(context.Context) (CodexClient, error) {
				return nil, errors.New("找不到可执行文件")
			},
			wantStatus: http.StatusServiceUnavailable,
			wantCode:   codeProviderRuntimeNotFound,
		},
		{
			name: "归档调用失败",
			codex: func(context.Context) (CodexClient, error) {
				return &fakeCodexClient{archiveErr: errors.New("rpc 失败")}, nil
			},
			wantStatus: http.StatusBadGateway,
			wantCode:   codeCodexArchiveFailed,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler := newTestHandler(t, t.TempDir(), Dependencies{Codex: testCase.codex})
			recorder := performRequest(handler, http.MethodPost, ArchivePath, `{"provider":"codex","sessionId":"thread-1"}`)
			if recorder.Code != testCase.wantStatus {
				t.Fatalf("状态码 = %d，期望 %d（body=%s）", recorder.Code, testCase.wantStatus, recorder.Body.String())
			}
			var body errorResponse
			decodeBody(t, recorder, &body)
			if body.Error != testCase.wantCode {
				t.Fatalf("错误码 = %q，期望 %q", body.Error, testCase.wantCode)
			}
		})
	}
}

func TestCapabilitiesShape(t *testing.T) {
	client := &fakeCodexClient{capabilities: appserver.Capabilities{
		Provider:          providerCodex,
		WorkflowAvailable: true,
		Operations: appserver.Operations{
			Archive:      appserver.Operation{Support: appserver.SupportNative, Available: true},
			ListArchived: appserver.Operation{Support: appserver.SupportNative, Available: true},
			Unarchive:    appserver.Operation{Support: appserver.SupportNative, Available: true},
		},
	}}
	handler := newTestHandler(t, t.TempDir(), Dependencies{
		Codex: func(context.Context) (CodexClient, error) { return client, nil },
	})
	recorder := performRequest(handler, http.MethodGet, LifecycleCapabilitiesPath, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200（body=%s）", recorder.Code, recorder.Body.String())
	}
	var body capabilitiesResponse
	decodeBody(t, recorder, &body)
	if !body.OK {
		t.Fatalf("响应应带 ok=true: %s", recorder.Body.String())
	}
	if len(body.Providers) != 4 {
		t.Fatalf("Provider 数量 = %d，期望 4（%v）", len(body.Providers), body.Providers)
	}

	// Claude / Gemini：会话文件归档，三个动作都可用。
	for _, provider := range []string{providerClaude, providerGemini} {
		capability, ok := body.Providers[provider]
		if !ok {
			t.Fatalf("缺少 %s 的能力声明", provider)
		}
		if capability.Provider != provider || !capability.WorkflowAvailable || capability.Reason != "" {
			t.Fatalf("%s 能力声明不符: %+v", provider, capability)
		}
		for name, operation := range map[string]operationCapability{
			"archive":      capability.Operations.Archive,
			"listArchived": capability.Operations.ListArchived,
			"unarchive":    capability.Operations.Unarchive,
		} {
			if operation.Support != supportNative || !operation.Available || operation.Reason != "" {
				t.Fatalf("%s.%s 能力不符: %+v", provider, name, operation)
			}
		}
	}

	// Codex：探测结果原样透传。
	codex, ok := body.Providers[providerCodex]
	if !ok {
		t.Fatal("缺少 codex 的能力声明")
	}
	if !codex.WorkflowAvailable || codex.Operations.Archive.Support != supportNative || !codex.Operations.Archive.Available {
		t.Fatalf("codex 能力声明不符: %+v", codex)
	}

	// 没有事实源的 Provider：support=unsupported，但三个键必须都在。
	openCode, ok := body.Providers[providerOpenCode]
	if !ok {
		t.Fatal("缺少 opencode 的能力声明")
	}
	if openCode.WorkflowAvailable || openCode.Reason != reasonNativeUnarchiveUnavailable {
		t.Fatalf("opencode 能力声明不符: %+v", openCode)
	}
	if openCode.Operations.Archive.Support != supportUnsupported || openCode.Operations.Archive.Available {
		t.Fatalf("opencode 的 archive 应为 unsupported: %+v", openCode.Operations.Archive)
	}
}

func TestCapabilitiesCodexUnavailableIsNotUnsupported(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), Dependencies{})
	recorder := performRequest(handler, http.MethodGet, LifecycleCapabilitiesPath, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200（body=%s）", recorder.Code, recorder.Body.String())
	}
	var body capabilitiesResponse
	decodeBody(t, recorder, &body)
	codex := body.Providers[providerCodex]
	if codex.WorkflowAvailable {
		t.Fatalf("运行时不可用时不应声明工作流可用: %+v", codex)
	}
	if codex.Operations.Archive.Support != supportNative || codex.Operations.Archive.Available {
		t.Fatalf("运行时不可用应保留 native 且 available=false: %+v", codex.Operations.Archive)
	}
	if codex.Reason != reasonProviderRuntimeNotFound || codex.Operations.Archive.Reason != reasonProviderRuntimeNotFound {
		t.Fatalf("应声明 provider_runtime_not_found: %+v", codex)
	}
}

func TestCapabilitiesProbeFailure(t *testing.T) {
	client := &fakeCodexClient{probeErr: errors.New("探测失败")}
	handler := newTestHandler(t, t.TempDir(), Dependencies{
		Codex: func(context.Context) (CodexClient, error) { return client, nil },
	})
	recorder := performRequest(handler, http.MethodGet, LifecycleCapabilitiesPath, "")
	var body capabilitiesResponse
	decodeBody(t, recorder, &body)
	codex := body.Providers[providerCodex]
	if codex.Reason != reasonRuntimeProbeFailed || codex.Operations.ListArchived.Support != supportNative {
		t.Fatalf("探测失败应保留 native 并声明失败原因: %+v", codex)
	}
	if client.closeCount != 1 {
		t.Fatalf("客户端应被关闭一次，实际 %d", client.closeCount)
	}
}

func TestCapabilitiesRejectsUnauthorizedAndWrongMethod(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), Dependencies{})

	unauthorized := performRequest(&Handler{
		authorizer:  fakeAuthorizer{allow: false},
		hostHomeDir: t.TempDir(),
		providerIDs: []string{providerClaude},
	}, http.MethodGet, LifecycleCapabilitiesPath, "")
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("状态码 = %d，期望 401", unauthorized.Code)
	}

	wrongMethod := performRequest(handler, http.MethodPost, LifecycleCapabilitiesPath, "")
	if wrongMethod.Code != http.StatusMethodNotAllowed {
		t.Fatalf("状态码 = %d，期望 405", wrongMethod.Code)
	}
	if allow := wrongMethod.Header().Get("Allow"); allow != http.MethodGet {
		t.Fatalf("Allow 头 = %q，期望 GET", allow)
	}
}
