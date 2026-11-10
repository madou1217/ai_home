package webuiprojectsapi

import (
	"encoding/json"
	"fmt"
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

// projectsResponse 是测试侧的响应形状。
type projectsResponse struct {
	OK        bool          `json:"ok"`
	Truncated bool          `json:"truncated"`
	Projects  []projectView `json:"projects"`
}

func newTestHandler(t *testing.T, hostHome string, allowed bool, mutate ...func(*Dependencies)) *Handler {
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

func doRequest(t *testing.T, handler http.Handler, method string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, Path, nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeProjects(t *testing.T, recorder *httptest.ResponseRecorder) projectsResponse {
	t.Helper()
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, 期望 200, body=%s", recorder.Code, recorder.Body.String())
	}
	var body projectsResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v, body=%s", err, recorder.Body.String())
	}
	if !body.OK {
		t.Fatalf("ok = false, body=%s", recorder.Body.String())
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

// writeGeminiProject 造一个 Gemini 项目：.gemini/tmp/<name>/chats 与 history/.project_root。
func writeGeminiProject(t *testing.T, hostHome, name, projectPath, sessionID, title string, mtime time.Time) {
	t.Helper()
	chatsDir := filepath.Join(hostHome, ".gemini", "tmp", name, "chats")
	if err := os.MkdirAll(chatsDir, 0o755); err != nil {
		t.Fatalf("创建 Gemini 会话目录失败: %v", err)
	}
	checkpoint := fmt.Sprintf(`{"sessionId":%q,"summary":%q,"lastUpdated":""}`, sessionID, title)
	chatPath := filepath.Join(chatsDir, sessionID+".json")
	if err := os.WriteFile(chatPath, []byte(checkpoint), 0o644); err != nil {
		t.Fatalf("写入 Gemini 会话失败: %v", err)
	}
	if err := os.Chtimes(chatPath, mtime, mtime); err != nil {
		t.Fatalf("设置 Gemini 会话时间失败: %v", err)
	}
	historyDir := filepath.Join(hostHome, ".gemini", "history", name)
	if err := os.MkdirAll(historyDir, 0o755); err != nil {
		t.Fatalf("创建 Gemini history 目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(historyDir, ".project_root"), []byte(projectPath), 0o644); err != nil {
		t.Fatalf("写入 .project_root 失败: %v", err)
	}
}

// writeCodexSession 造一条 Codex rollout 会话与索引命名。
func writeCodexSession(t *testing.T, hostHome, sessionID, cwd, title string, mtime time.Time) {
	t.Helper()
	sessionsDir := filepath.Join(hostHome, ".codex", "sessions", "2026", "01", "02")
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
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
	metaLine, err := json.Marshal(meta)
	if err != nil {
		t.Fatalf("序列化 Codex meta 失败: %v", err)
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
	messageLine, err := json.Marshal(message)
	if err != nil {
		t.Fatalf("序列化 Codex 消息失败: %v", err)
	}
	content := strings.Join([]string{string(metaLine), string(messageLine)}, "\n") + "\n"
	fileName := fmt.Sprintf("rollout-2026-01-02T10-00-00-%s.jsonl", sessionID)
	sessionPath := filepath.Join(sessionsDir, fileName)
	if err := os.WriteFile(sessionPath, []byte(content), 0o644); err != nil {
		t.Fatalf("写入 Codex 会话失败: %v", err)
	}
	if err := os.Chtimes(sessionPath, mtime, mtime); err != nil {
		t.Fatalf("设置 Codex 会话时间失败: %v", err)
	}

	indexLine, err := json.Marshal(map[string]any{
		"id":          sessionID,
		"thread_name": title,
		"updated_at":  mtime.UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatalf("序列化 Codex 索引失败: %v", err)
	}
	indexPath := filepath.Join(hostHome, ".codex", "session_index.jsonl")
	if err := os.WriteFile(indexPath, append(indexLine, '\n'), 0o644); err != nil {
		t.Fatalf("写入 Codex 索引失败: %v", err)
	}
}

// newProjectDir 造一个真实存在的项目目录（项目路径必须在磁盘上存在才会下发）。
func newProjectDir(t *testing.T, name string) string {
	t.Helper()
	projectDir := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("创建项目目录失败: %v", err)
	}
	return projectDir
}

func TestHandlerRequiresAuthorization(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), false)
	recorder := doRequest(t, handler, http.MethodGet)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("状态码 = %d, 期望 401", recorder.Code)
	}
	if got := recorder.Header().Get("WWW-Authenticate"); got != "Bearer" {
		t.Fatalf("WWW-Authenticate = %q, 期望 Bearer", got)
	}
}

func TestHandlerRejectsNonGet(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), true)
	recorder := doRequest(t, handler, http.MethodPost)
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("状态码 = %d, 期望 405", recorder.Code)
	}
	if got := recorder.Header().Get("Allow"); got != http.MethodGet {
		t.Fatalf("Allow = %q, 期望 GET", got)
	}
}

func TestHandlerEmptyHostHomeReturnsEmptyList(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), true)
	body := decodeProjects(t, doRequest(t, handler, http.MethodGet))
	if len(body.Projects) != 0 {
		t.Fatalf("空宿主目录下项目数 = %d, 期望 0", len(body.Projects))
	}
	if body.Truncated {
		t.Fatal("空宿主目录不应标记 truncated")
	}
}

func TestHandlerAggregatesProjectsAndSorts(t *testing.T) {
	hostHome := t.TempDir()
	olderProject := newProjectDir(t, "older")
	newerProject := newProjectDir(t, "newer")

	base := time.Date(2026, 1, 2, 10, 0, 0, 0, time.UTC)
	// 同一路径被 claude 与 codex 各读出一份：必须合并成一个项目、两个 Provider。
	writeClaudeSession(t, hostHome, "claude-older", "claude-session", olderProject, "整理旧项目", base)
	writeCodexSession(t, hostHome, "codex-session", olderProject, "Codex 旧项目会话", base.Add(30*time.Minute))
	// 另一个路径只有 gemini，且时间更新 → 排在前面。
	writeGeminiProject(t, hostHome, "gemini-newer", newerProject, "gemini-session", "新的 Gemini 项目", base.Add(2*time.Hour))

	handler := newTestHandler(t, hostHome, true)
	body := decodeProjects(t, doRequest(t, handler, http.MethodGet))

	if len(body.Projects) != 2 {
		t.Fatalf("项目数 = %d, 期望 2, body=%+v", len(body.Projects), body.Projects)
	}
	if body.Projects[0].Path != newerProject {
		t.Fatalf("首个项目路径 = %q, 期望最新的 %q", body.Projects[0].Path, newerProject)
	}
	if body.Projects[1].Path != olderProject {
		t.Fatalf("第二个项目路径 = %q, 期望 %q", body.Projects[1].Path, olderProject)
	}

	merged := body.Projects[1]
	if strings.Join(merged.Providers, ",") != "claude,codex" {
		t.Fatalf("providers = %v, 期望 [claude codex]", merged.Providers)
	}
	if merged.SessionTotal != 2 || len(merged.Sessions) != 2 {
		t.Fatalf("会话数 = %d/%d, 期望 2/2", merged.SessionTotal, len(merged.Sessions))
	}
	// 会话按 updatedAt 降序：codex 那份更新，排第一。
	if merged.Sessions[0].ID != "codex-session" {
		t.Fatalf("首条会话 = %q, 期望 codex-session", merged.Sessions[0].ID)
	}
	if merged.Sessions[0].ProjectPath != olderProject {
		t.Fatalf("会话 projectPath = %q, 期望 %q", merged.Sessions[0].ProjectPath, olderProject)
	}
	if merged.Sessions[0].Provider != "codex" {
		t.Fatalf("会话 provider = %q, 期望 codex", merged.Sessions[0].Provider)
	}
	if merged.Sessions[1].Title != "整理旧项目" {
		t.Fatalf("会话标题 = %q, 期望 整理旧项目", merged.Sessions[1].Title)
	}
	if merged.Name != "older" {
		t.Fatalf("项目名 = %q, 期望 older", merged.Name)
	}
}

func TestHandlerCapsSessionPayload(t *testing.T) {
	hostHome := t.TempDir()
	projectDir := newProjectDir(t, "busy")
	base := time.Date(2026, 1, 2, 10, 0, 0, 0, time.UTC)
	total := sessionPayloadCap + 5
	for index := 0; index < total; index++ {
		writeClaudeSession(
			t,
			hostHome,
			"claude-busy",
			fmt.Sprintf("session-%02d", index),
			projectDir,
			fmt.Sprintf("会话 %02d", index),
			base.Add(time.Duration(index)*time.Minute),
		)
	}

	handler := newTestHandler(t, hostHome, true)
	body := decodeProjects(t, doRequest(t, handler, http.MethodGet))
	if len(body.Projects) != 1 {
		t.Fatalf("项目数 = %d, 期望 1", len(body.Projects))
	}
	project := body.Projects[0]
	if project.SessionTotal != total {
		t.Fatalf("sessionTotal = %d, 期望 %d", project.SessionTotal, total)
	}
	if len(project.Sessions) != sessionPayloadCap {
		t.Fatalf("下发会话数 = %d, 期望 %d", len(project.Sessions), sessionPayloadCap)
	}
	// 截断保留最近的：最后一条会话时间最大，必须出现在首条。
	if project.Sessions[0].ID != fmt.Sprintf("session-%02d", total-1) {
		t.Fatalf("首条会话 = %q, 期望最新的 session-%02d", project.Sessions[0].ID, total-1)
	}
}

func TestHandlerSkipsSymlinkEscape(t *testing.T) {
	hostHome := t.TempDir()
	escapedProject := newProjectDir(t, "escaped")

	// 白名单根之外的真实目录，通过符号链接挂到 .claude/projects 下。
	outsideDir := t.TempDir()
	outsideProjectDir := filepath.Join(outsideDir, "claude-linked")
	if err := os.MkdirAll(outsideProjectDir, 0o755); err != nil {
		t.Fatalf("创建外部目录失败: %v", err)
	}
	record := map[string]any{
		"type":    "user",
		"cwd":     escapedProject,
		"message": map[string]any{"content": "逃逸会话"},
	}
	line, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("序列化记录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(outsideProjectDir, "escape.jsonl"), append(line, '\n'), 0o644); err != nil {
		t.Fatalf("写入外部会话失败: %v", err)
	}

	projectsRoot := filepath.Join(hostHome, ".claude", "projects")
	if err := os.MkdirAll(projectsRoot, 0o755); err != nil {
		t.Fatalf("创建 Claude 根目录失败: %v", err)
	}
	if err := os.Symlink(outsideProjectDir, filepath.Join(projectsRoot, "linked")); err != nil {
		t.Skipf("当前环境不支持创建符号链接: %v", err)
	}

	handler := newTestHandler(t, hostHome, true)
	body := decodeProjects(t, doRequest(t, handler, http.MethodGet))
	if len(body.Projects) != 0 {
		t.Fatalf("项目数 = %d, 期望 0（符号链接目录必须跳过）: %+v", len(body.Projects), body.Projects)
	}
}

func TestHandlerReportsTruncatedScan(t *testing.T) {
	hostHome := t.TempDir()
	projectDir := newProjectDir(t, "budget")
	base := time.Date(2026, 1, 2, 10, 0, 0, 0, time.UTC)
	writeClaudeSession(t, hostHome, "claude-budget", "session", projectDir, "预算会话", base)

	handler := newTestHandler(t, hostHome, true, func(dependencies *Dependencies) {
		dependencies.MaxEntries = 1
	})
	body := decodeProjects(t, doRequest(t, handler, http.MethodGet))
	if !body.Truncated {
		t.Fatal("条目预算耗尽时必须标记 truncated")
	}
	if len(body.Projects) != 0 {
		t.Fatalf("预算耗尽后项目数 = %d, 期望 0", len(body.Projects))
	}
}

func TestHandlerExcludesChatWorkspaceProjects(t *testing.T) {
	hostHome := t.TempDir()
	chatWorkspace := filepath.Join(hostHome, ".ai_home", "run", "chat-workspaces", "deadbeef")
	if err := os.MkdirAll(chatWorkspace, 0o755); err != nil {
		t.Fatalf("创建 chat 工作区失败: %v", err)
	}
	realProject := newProjectDir(t, "real")
	base := time.Date(2026, 1, 2, 10, 0, 0, 0, time.UTC)
	writeClaudeSession(t, hostHome, "claude-chat", "chat-session", chatWorkspace, "工作区会话", base.Add(time.Hour))
	writeClaudeSession(t, hostHome, "claude-real", "real-session", realProject, "真实项目会话", base)

	handler := newTestHandler(t, hostHome, true)
	body := decodeProjects(t, doRequest(t, handler, http.MethodGet))
	if len(body.Projects) != 1 {
		t.Fatalf("项目数 = %d, 期望 1（chat 工作区必须排除）: %+v", len(body.Projects), body.Projects)
	}
	if body.Projects[0].Path != realProject {
		t.Fatalf("项目路径 = %q, 期望 %q", body.Projects[0].Path, realProject)
	}
}

func TestNewHandlerRequiresHostHome(t *testing.T) {
	if _, err := NewHandler(Dependencies{Authorizer: stubAuthorizer{allowed: true}}); err == nil {
		t.Fatal("缺少宿主目录时 NewHandler 必须失败")
	}
	if _, err := NewHandler(Dependencies{HostHomeDir: t.TempDir()}); err == nil {
		t.Fatal("缺少鉴权策略时 NewHandler 必须失败")
	}
}
