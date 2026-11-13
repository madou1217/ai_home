package webuisessionslistapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// stubAuthorizer 是固定结果的鉴权桩。
type stubAuthorizer struct {
	allowed bool
}

func (stub stubAuthorizer) Authorized(*http.Request) bool {
	return stub.allowed
}

// sessionsResponse 是测试侧的响应形状。
type sessionsResponse struct {
	OK        bool          `json:"ok"`
	Projects  []projectView `json:"projects"`
	Truncated bool          `json:"truncated"`
}

type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message"`
}

func newTestHandler(t *testing.T, hostHome string, allowed bool, mutate ...func(*Dependencies)) http.Handler {
	t.Helper()
	dependencies := Dependencies{
		Authorizer:  stubAuthorizer{allowed: allowed},
		HostHomeDir: hostHome,
	}
	for _, apply := range mutate {
		apply(&dependencies)
	}
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("NewHandler 失败: %v", err)
	}
	return handler
}

func doRequest(t *testing.T, handler http.Handler, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func doRequestWithParams(t *testing.T, handler http.Handler, method, target, provider, accountRef string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, nil)
	request.SetPathValue("provider", provider)
	request.SetPathValue("accountRef", accountRef)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeSessions(t *testing.T, recorder *httptest.ResponseRecorder) sessionsResponse {
	t.Helper()
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, 期望 200, body=%s", recorder.Code, recorder.Body.String())
	}
	var body sessionsResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v, body=%s", err, recorder.Body.String())
	}
	if !body.OK {
		t.Fatalf("ok = false, body=%s", recorder.Body.String())
	}
	return body
}

func decodeError(t *testing.T, recorder *httptest.ResponseRecorder, status int, code string) errorResponse {
	t.Helper()
	if recorder.Code != status {
		t.Fatalf("状态码 = %d, 期望 %d, body=%s", recorder.Code, status, recorder.Body.String())
	}
	var body errorResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("错误响应不是合法 JSON: %v, body=%s", err, recorder.Body.String())
	}
	if body.Error != code {
		t.Fatalf("错误码 = %q, 期望 %q", body.Error, code)
	}
	return body
}

// writeClaudeSession 在宿主 HOME 下造一条 Claude 会话：
// .claude/projects/<dirName>/<sessionID>.jsonl。
func writeClaudeSession(t *testing.T, hostHome, dirName, sessionID, cwd, title string, mtime time.Time) {
	t.Helper()
	projectDir := filepath.Join(hostHome, ".claude", "projects", dirName)
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("创建 Claude 项目目录失败: %v", err)
	}
	record := map[string]any{
		"type": "user",
		"cwd":  cwd,
		"message": map[string]any{
			"content": title,
		},
	}
	line, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("序列化 Claude 记录失败: %v", err)
	}
	sessionPath := filepath.Join(projectDir, sessionID+".jsonl")
	if err := os.WriteFile(sessionPath, append(line, '\n'), 0o644); err != nil {
		t.Fatalf("写入 Claude 会话失败: %v", err)
	}
	if err := os.Chtimes(sessionPath, mtime, mtime); err != nil {
		t.Fatalf("设置 Claude 会话时间失败: %v", err)
	}
}

// writeCodexRollout 造一条 Codex 会话：.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl。
func writeCodexRollout(t *testing.T, hostHome, sessionID, cwd, title string, mtime time.Time) {
	t.Helper()
	dir := filepath.Join(hostHome, ".codex", "sessions", "2026", "01", "02")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("创建 Codex 会话目录失败: %v", err)
	}
	meta := map[string]any{
		"type": "session_meta",
		"payload": map[string]any{
			"id":     sessionID,
			"cwd":    cwd,
			"source": "cli",
		},
	}
	message := map[string]any{
		"type": "response_item",
		"payload": map[string]any{
			"type": "message",
			"role": "user",
			"content": []map[string]any{
				{"type": "input_text", "text": title},
			},
		},
	}
	metaLine, _ := json.Marshal(meta)
	messageLine, _ := json.Marshal(message)
	sessionPath := filepath.Join(dir, "rollout-2026-01-02T10-00-00-"+sessionID+".jsonl")
	content := append(append(metaLine, '\n'), append(messageLine, '\n')...)
	if err := os.WriteFile(sessionPath, content, 0o644); err != nil {
		t.Fatalf("写入 Codex 会话失败: %v", err)
	}
	if err := os.Chtimes(sessionPath, mtime, mtime); err != nil {
		t.Fatalf("设置 Codex 会话时间失败: %v", err)
	}
}

// writeCodebuddySession 造一条 CodeBuddy 家族会话。
func writeCodebuddySession(t *testing.T, hostHome, configDir, projectDirName, sessionID string, records []map[string]any) {
	t.Helper()
	projectDir := filepath.Join(hostHome, configDir, "projects", projectDirName)
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("创建 CodeBuddy 项目目录失败: %v", err)
	}
	builder := strings.Builder{}
	for _, record := range records {
		line, err := json.Marshal(record)
		if err != nil {
			t.Fatalf("序列化 CodeBuddy 记录失败: %v", err)
		}
		builder.Write(line)
		builder.WriteByte('\n')
	}
	sessionPath := filepath.Join(projectDir, sessionID+".jsonl")
	if err := os.WriteFile(sessionPath, []byte(builder.String()), 0o644); err != nil {
		t.Fatalf("写入 CodeBuddy 会话失败: %v", err)
	}
}

func TestUnauthorized(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), false)
	recorder := doRequest(t, handler, http.MethodGet, Path+"/claude/acct-1")
	decodeError(t, recorder, http.StatusUnauthorized, errorCodeUnauthorized)
}

func TestMethodNotAllowed(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), true)
	recorder := doRequest(t, handler, http.MethodPost, Path+"/claude/acct-1")
	decodeError(t, recorder, http.StatusMethodNotAllowed, errorCodeMethodNotAllowed)
}

func TestInvalidRefs(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), true)

	recorder := doRequestWithParams(t, handler, http.MethodGet, Path+"/claude/acct-1", "claude", "..")
	decodeError(t, recorder, http.StatusBadRequest, errorCodeInvalidAccount)

	recorder = doRequestWithParams(t, handler, http.MethodGet, Path+"/claude/acct-1", "..", "acct-1")
	decodeError(t, recorder, http.StatusBadRequest, errorCodeInvalidProvider)

	recorder = doRequestWithParams(t, handler, http.MethodGet, Path+"/claude/acct-1", "claude", "a/b")
	decodeError(t, recorder, http.StatusBadRequest, errorCodeInvalidAccount)
}

func TestUnsupportedProvider(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), true)
	recorder := doRequest(t, handler, http.MethodGet, Path+"/unknown/acct-1")
	decodeError(t, recorder, http.StatusNotImplemented, errorCodeUnsupported)
	if strings.Contains(recorder.Body.String(), `"projects"`) {
		t.Fatalf("不支持的 Provider 不应返回 projects 字段: %s", recorder.Body.String())
	}
}

func TestMissingRouteShape(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), true)
	recorder := doRequest(t, handler, http.MethodGet, Path+"/claude")
	decodeError(t, recorder, http.StatusNotFound, errorCodeNotFound)
}

func TestEmptyHostReturnsEmptyArray(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), true)
	recorder := doRequest(t, handler, http.MethodGet, Path+"/claude/acct-1")
	body := decodeSessions(t, recorder)
	if len(body.Projects) != 0 {
		t.Fatalf("项目数 = %d, 期望 0", len(body.Projects))
	}
	if !strings.Contains(recorder.Body.String(), `"projects":[]`) {
		t.Fatalf("空结果应下发空数组而不是 null: %s", recorder.Body.String())
	}
	if body.Truncated {
		t.Fatalf("空目录不应标记 truncated")
	}
}

func TestClaudeSessionsSortedByUpdatedAt(t *testing.T) {
	hostHome := t.TempDir()
	projectDir := filepath.Join(hostHome, "work", "demo")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("创建项目目录失败: %v", err)
	}
	older := time.Now().Add(-2 * time.Hour)
	newer := time.Now().Add(-1 * time.Hour)
	writeClaudeSession(t, hostHome, "work-demo", "session-old", projectDir, "旧会话", older)
	writeClaudeSession(t, hostHome, "work-demo", "session-new", projectDir, "新会话", newer)

	handler := newTestHandler(t, hostHome, true)
	body := decodeSessions(t, doRequest(t, handler, http.MethodGet, Path+"/claude/acct-1"))
	if len(body.Projects) != 1 {
		t.Fatalf("项目数 = %d, 期望 1", len(body.Projects))
	}
	project := body.Projects[0]
	if project.ID != "work-demo" {
		t.Fatalf("项目 id = %q, 期望 work-demo", project.ID)
	}
	if project.Path != projectDir {
		t.Fatalf("项目 path = %q, 期望 %q", project.Path, projectDir)
	}
	if project.Name != "demo" {
		t.Fatalf("项目 name = %q, 期望 demo", project.Name)
	}
	if project.Provider != "claude" {
		t.Fatalf("provider = %q, 期望 claude", project.Provider)
	}
	if len(project.Sessions) != 2 {
		t.Fatalf("会话数 = %d, 期望 2", len(project.Sessions))
	}
	if project.Sessions[0].ID != "session-new" || project.Sessions[1].ID != "session-old" {
		t.Fatalf("会话未按 updatedAt 降序: %+v", project.Sessions)
	}
	if project.Sessions[0].Title != "新会话" {
		t.Fatalf("标题 = %q, 期望 新会话", project.Sessions[0].Title)
	}
	if project.Sessions[0].ProjectDirName != "work-demo" {
		t.Fatalf("projectDirName = %q, 期望 work-demo", project.Sessions[0].ProjectDirName)
	}
	if body.Truncated {
		t.Fatalf("正常结果不应标记 truncated")
	}
}

func TestSymlinkProjectEscapeSkipped(t *testing.T) {
	hostHome := t.TempDir()
	outside := t.TempDir()
	outsideProject := filepath.Join(outside, "secret")
	if err := os.MkdirAll(outsideProject, 0o755); err != nil {
		t.Fatalf("创建外部项目目录失败: %v", err)
	}
	writeClaudeSession(t, outside, "secret", "outside-session", outsideProject, "外部会话", time.Now())

	projectsRoot := filepath.Join(hostHome, ".claude", "projects")
	if err := os.MkdirAll(projectsRoot, 0o755); err != nil {
		t.Fatalf("创建 Claude projects 目录失败: %v", err)
	}
	if err := os.Symlink(filepath.Join(outside, ".claude", "projects", "secret"), filepath.Join(projectsRoot, "escape")); err != nil {
		t.Fatalf("创建逃逸符号链接失败: %v", err)
	}

	handler := newTestHandler(t, hostHome, true)
	body := decodeSessions(t, doRequest(t, handler, http.MethodGet, Path+"/claude/acct-1"))
	if len(body.Projects) != 0 {
		t.Fatalf("符号链接逃逸的项目不应下发: %+v", body.Projects)
	}
}

func TestCodexProjectsAndIndexTitle(t *testing.T) {
	hostHome := t.TempDir()
	projectDir := filepath.Join(hostHome, "work", "codex-demo")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("创建项目目录失败: %v", err)
	}
	sessionID := "11111111-1111-1111-1111-111111111111"
	writeCodexRollout(t, hostHome, sessionID, projectDir, "回退标题", time.Now().Add(-time.Hour))

	indexPath := filepath.Join(hostHome, ".codex", "session_index.jsonl")
	index := map[string]any{
		"id":          sessionID,
		"thread_name": "索引标题",
		"updated_at":  "2026-01-02T10:30:00Z",
	}
	line, _ := json.Marshal(index)
	if err := os.WriteFile(indexPath, append(line, '\n'), 0o644); err != nil {
		t.Fatalf("写入 session_index 失败: %v", err)
	}

	handler := newTestHandler(t, hostHome, true)
	body := decodeSessions(t, doRequest(t, handler, http.MethodGet, Path+"/codex/acct-1"))
	if len(body.Projects) != 1 {
		t.Fatalf("项目数 = %d, 期望 1", len(body.Projects))
	}
	project := body.Projects[0]
	if project.Path != projectDir || project.Name != "codex-demo" {
		t.Fatalf("项目 = %+v, 期望 path=%s name=codex-demo", project, projectDir)
	}
	if project.ID != codexProjectID(projectDir) {
		t.Fatalf("项目 id = %q, 期望 base64 派生值", project.ID)
	}
	if len(project.Sessions) != 1 || project.Sessions[0].ID != sessionID {
		t.Fatalf("会话 = %+v, 期望只有 %s", project.Sessions, sessionID)
	}
	if project.Sessions[0].Title != "索引标题" {
		t.Fatalf("标题 = %q, 期望 索引标题", project.Sessions[0].Title)
	}
	wantUpdatedAt := time.Date(2026, 1, 2, 10, 30, 0, 0, time.UTC).UnixMilli()
	if project.Sessions[0].UpdatedAt != wantUpdatedAt {
		t.Fatalf("updatedAt = %d, 期望 %d", project.Sessions[0].UpdatedAt, wantUpdatedAt)
	}
}

func TestCodebuddyFamilyTitlesAndRegionDedupe(t *testing.T) {
	hostHome := t.TempDir()
	projectPath := filepath.Join(hostHome, "work", "buddy-demo")
	if err := os.MkdirAll(projectPath, 0o755); err != nil {
		t.Fatalf("创建项目目录失败: %v", err)
	}
	writeCodebuddySession(t, hostHome, ".codebuddy", "work-buddy-demo", "session-ai", []map[string]any{
		{"type": "ai-title", "aiTitle": "AI 标题", "cwd": projectPath},
		{"type": "message", "role": "user", "content": []map[string]any{
			{"type": "input_text", "text": "第一条用户消息"},
		}, "timestamp": int64(1700000000000)},
	})
	writeCodebuddySession(t, hostHome, ".codebuddy", "work-buddy-demo", "session-custom", []map[string]any{
		{"type": "message", "role": "user", "content": "普通消息", "timestamp": int64(1700000005000)},
		{"type": "custom-title", "customTitle": "自定义标题", "timestamp": int64(1700000006000)},
	})

	// 家族归一后的真实布局：另一个配置根的 projects 是指向规范存储的软链接。
	if err := os.MkdirAll(filepath.Join(hostHome, ".workbuddy-ai"), 0o755); err != nil {
		t.Fatalf("创建 workbuddy 配置根失败: %v", err)
	}
	if err := os.Symlink(
		filepath.Join(hostHome, ".codebuddy", "projects"),
		filepath.Join(hostHome, ".workbuddy-ai", "projects"),
	); err != nil {
		t.Fatalf("创建家族软链接失败: %v", err)
	}

	handler := newTestHandler(t, hostHome, true)
	body := decodeSessions(t, doRequest(t, handler, http.MethodGet, Path+"/codebuddy/acct-1"))
	if len(body.Projects) != 1 {
		t.Fatalf("项目数 = %d, 期望 1（软链接根应去重）", len(body.Projects))
	}
	project := body.Projects[0]
	if project.ID != "work-buddy-demo" || project.Path != projectPath {
		t.Fatalf("项目 = %+v, 期望 id=work-buddy-demo path=%s", project, projectPath)
	}
	if project.Name != "buddy-demo" || project.Provider != "codebuddy" {
		t.Fatalf("项目 = %+v, 期望 name=buddy-demo provider=codebuddy", project)
	}
	if len(project.Sessions) != 2 {
		t.Fatalf("会话数 = %d, 期望 2", len(project.Sessions))
	}
	if project.Sessions[0].ID != "session-custom" || project.Sessions[0].Title != "自定义标题" {
		t.Fatalf("首个会话 = %+v, 期望 session-custom/自定义标题", project.Sessions[0])
	}
	if project.Sessions[0].UpdatedAt != 1700000006000 {
		t.Fatalf("updatedAt = %d, 期望 1700000006000", project.Sessions[0].UpdatedAt)
	}
	if project.Sessions[1].ID != "session-ai" || project.Sessions[1].Title != "AI 标题" {
		t.Fatalf("第二个会话 = %+v, 期望 session-ai/AI 标题", project.Sessions[1])
	}
}

func TestCodebuddyFamilyProviderRoots(t *testing.T) {
	cases := []struct {
		provider  string
		configDir string
	}{
		{"codebuddy", ".codebuddy"},
		{"codebuddycn", ".codebuddy-cn"},
		{"workbuddy", ".workbuddy-ai"},
		{"workbuddycn", ".workbuddy"},
	}
	for _, testCase := range cases {
		t.Run(testCase.provider, func(t *testing.T) {
			hostHome := t.TempDir()
			projectPath := filepath.Join(hostHome, "work", testCase.provider)
			if err := os.MkdirAll(projectPath, 0o755); err != nil {
				t.Fatalf("创建项目目录失败: %v", err)
			}
			writeCodebuddySession(t, hostHome, testCase.configDir, "proj", "session-1", []map[string]any{
				{"type": "ai-title", "aiTitle": "家族标题", "cwd": projectPath},
				{"type": "message", "role": "user", "content": "你好", "timestamp": int64(1700000000000)},
			})

			handler := newTestHandler(t, hostHome, true)
			body := decodeSessions(t, doRequest(t, handler, http.MethodGet, Path+"/"+testCase.provider+"/acct-1"))
			if len(body.Projects) != 1 {
				t.Fatalf("项目数 = %d, 期望 1", len(body.Projects))
			}
			project := body.Projects[0]
			if project.Provider != testCase.provider {
				t.Fatalf("provider = %q, 期望 %q", project.Provider, testCase.provider)
			}
			if project.Path != projectPath {
				t.Fatalf("path = %q, 期望 %q", project.Path, projectPath)
			}
			if len(project.Sessions) != 1 || project.Sessions[0].Title != "家族标题" {
				t.Fatalf("会话 = %+v, 期望一条「家族标题」", project.Sessions)
			}
		})
	}
}

func TestBudgetTruncation(t *testing.T) {
	hostHome := t.TempDir()
	projectA := filepath.Join(hostHome, "work", "a")
	projectB := filepath.Join(hostHome, "work", "b")
	for _, dir := range []string{projectA, projectB} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("创建项目目录失败: %v", err)
		}
	}
	writeClaudeSession(t, hostHome, "work-a", "session-a", projectA, "会话 A", time.Now().Add(-2*time.Hour))
	writeClaudeSession(t, hostHome, "work-b", "session-b", projectB, "会话 B", time.Now().Add(-time.Hour))

	handler := newTestHandler(t, hostHome, true, func(dependencies *Dependencies) {
		dependencies.MaxEntries = 1
	})
	body := decodeSessions(t, doRequest(t, handler, http.MethodGet, Path+"/claude/acct-1"))
	if !body.Truncated {
		t.Fatalf("预算耗尽应标记 truncated")
	}
	if len(body.Projects) != 1 {
		t.Fatalf("项目数 = %d, 期望 1（预算只够一个目录）", len(body.Projects))
	}
}

func TestScanTimeoutReturnsPartial(t *testing.T) {
	hostHome := t.TempDir()
	projectDir := filepath.Join(hostHome, "work", "slow")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("创建项目目录失败: %v", err)
	}
	writeClaudeSession(t, hostHome, "work-slow", "session-slow", projectDir, "慢会话", time.Now())

	handler := newTestHandler(t, hostHome, true, func(dependencies *Dependencies) {
		// 极短超时：collect 一进来就判定预算用尽。
		dependencies.ScanTimeout = time.Nanosecond
	})
	body := decodeSessions(t, doRequest(t, handler, http.MethodGet, Path+"/claude/acct-1"))
	if !body.Truncated {
		t.Fatalf("超时应标记 truncated")
	}
	if len(body.Projects) != 0 {
		t.Fatalf("超时后不应继续下发项目: %+v", body.Projects)
	}
}


func TestAllAdditionalProvidersListHandler(t *testing.T) {
	hostHome := t.TempDir()
	aiHome := filepath.Join(hostHome, ".ai_home")

	// Gemini
	writeListTestFile(t, filepath.Join(hostHome, ".gemini", "history", "gem-proj", ".project_root"), "/tmp/gem")
	writeListTestFile(t, filepath.Join(hostHome, ".gemini", "tmp", "gem-proj", "chats", "session-g1.json"),
		`{"sessionId":"g1","messages":[{"type":"user","content":[{"text":"Gem ask"}]}]}`)

	// AGY
	writeListTestFile(t, filepath.Join(hostHome, ".gemini", "antigravity-cli", "aih-session-projects.json"), `{"agy-1":{"projectPath":"/tmp/agy","updatedAt":2000}}`)
	writeListTestFile(t, filepath.Join(hostHome, ".gemini", "antigravity", "brain", "agy-1", ".system_generated", "logs", "transcript.jsonl"),
		`{"type":"USER_INPUT","content":"<USER_REQUEST>AGY run</USER_REQUEST>","created_at":"1970-01-01T00:00:02.000Z"}`+"\n")

	// Qoder
	writeListTestFile(t, filepath.Join(aiHome, "run", "auth-projections", "qoder", "acct-q", "projects", "-tmp-q", "q1.jsonl"),
		`{"type":"user","cwd":"/tmp/q","timestamp":1000,"message":{"role":"user","content":"Hello Qoder"}}`+"\n")

	// Grok
	writeListTestFile(t, filepath.Join(aiHome, "run", "auth-projections", "grok", "acct-g", ".grok", "sessions", "projg", ".cwd"), "/tmp/grok")
	writeListTestFile(t, filepath.Join(aiHome, "run", "auth-projections", "grok", "acct-g", ".grok", "sessions", "projg", "g1", "summary.json"), `{"title":"Grok S"}`)
	writeListTestFile(t, filepath.Join(aiHome, "run", "auth-projections", "grok", "acct-g", ".grok", "sessions", "projg", "g1", "chat_history.jsonl"),
		`{"role":"user","prompt_index":0,"content":"Grok hi"}`+"\n")

	handler := newTestHandler(t, hostHome, true, func(d *Dependencies) { d.AIHomeDir = aiHome })

	for _, tc := range []struct {
		provider string
		ref      string
		wantID   string
	}{
		{"gemini", "acct-1", "g1"},
		{"agy", "acct-1", "agy-1"},
		{"qoder", "acct-q", "q1"},
		{"grok", "acct-g", "g1"},
		{"kimi", "acct-1", ""},
		{"chat", "acct-1", ""},
	} {
		rec := doRequestWithParams(t, handler, http.MethodGet, Path+"/"+tc.provider+"/"+tc.ref, tc.provider, tc.ref)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d body=%s", tc.provider, rec.Code, rec.Body.String())
		}
		var resp sessionsResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode %s: %v", tc.provider, err)
		}
		if tc.wantID == "" {
			if len(resp.Projects) != 0 {
				t.Fatalf("%s expected empty projects, got %+v", tc.provider, resp.Projects)
			}
			continue
		}
		if len(resp.Projects) != 1 || len(resp.Projects[0].Sessions) != 1 || resp.Projects[0].Sessions[0].ID != tc.wantID {
			t.Fatalf("%s unexpected projects: %+v", tc.provider, resp.Projects)
		}
	}
}

func writeListTestFile(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
}
