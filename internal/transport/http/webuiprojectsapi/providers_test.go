package webuiprojectsapi

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

// openTestSQLite 打开（必要时创建）一个测试数据库，测试结束自动关闭。
func openTestSQLite(t *testing.T, databasePath string) *sql.DB {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(databasePath), 0o755); err != nil {
		t.Fatalf("创建数据库目录失败: %v", err)
	}
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatalf("打开测试数据库失败: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

// openCodeTestRow 是一条 opencode 会话（两代布局用同一形状）。
type openCodeTestRow struct {
	ID        string
	Directory string
	Title     string
	UpdatedAt int64
	Archived  bool
	ParentID  string
}

// writeOpenCodeDatabase 造宿主 opencode.db；sessionV2 / legacy 可以用 nil 表示不建该代表。
func writeOpenCodeDatabase(t *testing.T, hostHome string, sessionV2, legacy []openCodeTestRow) {
	t.Helper()
	database := openTestSQLite(t, filepath.Join(hostHome, ".local", "share", "opencode", "opencode.db"))

	if sessionV2 != nil {
		if _, err := database.Exec(`CREATE TABLE session_v2 (
			id TEXT PRIMARY KEY,
			directory TEXT,
			title TEXT,
			time_updated INTEGER,
			time_created INTEGER,
			time_archived INTEGER,
			parent_id TEXT
		)`); err != nil {
			t.Fatalf("创建 session_v2 失败: %v", err)
		}
		for _, row := range sessionV2 {
			var archived any
			if row.Archived {
				archived = int64(1)
			}
			var parent any
			if row.ParentID != "" {
				parent = row.ParentID
			}
			if _, err := database.Exec(
				"INSERT INTO session_v2 (id, directory, title, time_updated, time_created, time_archived, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
				row.ID, row.Directory, row.Title, row.UpdatedAt, row.UpdatedAt, archived, parent,
			); err != nil {
				t.Fatalf("写入 session_v2 失败: %v", err)
			}
		}
	}

	if legacy != nil {
		if _, err := database.Exec(`CREATE TABLE session (
			id TEXT PRIMARY KEY,
			directory TEXT,
			title TEXT,
			time_created INTEGER
		)`); err != nil {
			t.Fatalf("创建 session 失败: %v", err)
		}
		for _, row := range legacy {
			if _, err := database.Exec(
				"INSERT INTO session (id, directory, title, time_created) VALUES (?, ?, ?, ?)",
				row.ID, row.Directory, row.Title, row.UpdatedAt,
			); err != nil {
				t.Fatalf("写入 session 失败: %v", err)
			}
		}
	}
}

// clineTestRow 是一条 cline sessions.db 记录。
type clineTestRow struct {
	SessionID string
	Cwd       string
	Prompt    string
	StartedAt int64
	UpdatedAt int64
}

// writeClineDatabase 在指定数据根下造 db/sessions.db。
func writeClineDatabase(t *testing.T, dataDir string, rows []clineTestRow) {
	t.Helper()
	database := openTestSQLite(t, filepath.Join(dataDir, "db", "sessions.db"))
	if _, err := database.Exec(`CREATE TABLE sessions (
		session_id TEXT PRIMARY KEY,
		started_at INTEGER,
		updated_at INTEGER,
		cwd TEXT,
		workspace_root TEXT,
		prompt TEXT,
		model TEXT
	)`); err != nil {
		t.Fatalf("创建 cline sessions 表失败: %v", err)
	}
	for _, row := range rows {
		if _, err := database.Exec(
			"INSERT INTO sessions (session_id, started_at, updated_at, cwd, workspace_root, prompt, model) VALUES (?, ?, ?, ?, ?, ?, ?)",
			row.SessionID, row.StartedAt, row.UpdatedAt, row.Cwd, row.Cwd, row.Prompt, "cline-model",
		); err != nil {
			t.Fatalf("写入 cline 会话失败: %v", err)
		}
	}
}

// writeClineSessionJSON 造 cline 的单会话 JSON 兜底文件。
func writeClineSessionJSON(t *testing.T, dataDir, sessionID, cwd, prompt string, startedAt int64) {
	t.Helper()
	sessionDir := filepath.Join(dataDir, "sessions", sessionID)
	if err := os.MkdirAll(sessionDir, 0o755); err != nil {
		t.Fatalf("创建 cline 会话目录失败: %v", err)
	}
	payload := map[string]any{
		"sessionId":  sessionID,
		"started_at": startedAt,
		"updated_at": startedAt + 1000,
		"cwd":        cwd,
		"prompt":     prompt,
	}
	content, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("序列化 cline 会话失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sessionDir, sessionID+".json"), content, 0o644); err != nil {
		t.Fatalf("写入 cline 会话失败: %v", err)
	}
}

// writeCodebuddySession 造一条 CodeBuddy 家族会话（JSONL）。
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
	if err := os.WriteFile(filepath.Join(projectDir, sessionID+".jsonl"), []byte(builder.String()), 0o644); err != nil {
		t.Fatalf("写入 CodeBuddy 会话失败: %v", err)
	}
}

func sessionIDs(project projectView) []string {
	ids := make([]string, 0, len(project.Sessions))
	for _, session := range project.Sessions {
		ids = append(ids, session.ID)
	}
	sort.Strings(ids)
	return ids
}

// TestSessionsHandlerCoversAllSupportedProviders 验证 /projects/sessions 的
// projectPath 扫描覆盖 Node 会返回的全部 Provider：claude、codex、gemini、
// opencode、CodeBuddy 家族与 cline。
func TestSessionsHandlerCoversAllSupportedProviders(t *testing.T) {
	hostHome := t.TempDir()
	projectDir := newProjectDir(t, "all-providers")
	base := time.Date(2026, 2, 3, 10, 0, 0, 0, time.UTC)

	writeClaudeSession(t, hostHome, "claude-all", "claude-session", projectDir, "Claude 会话", base)
	writeCodexSession(t, hostHome, "codex-session", projectDir, "Codex 会话", base.Add(time.Minute))
	writeGeminiProject(t, hostHome, "gemini-all", projectDir, "gemini-session", "Gemini 会话", base.Add(2*time.Minute))
	writeOpenCodeDatabase(t, hostHome, []openCodeTestRow{{
		ID:        "opencode-session",
		Directory: projectDir,
		Title:     "OpenCode 会话",
		UpdatedAt: base.Add(3 * time.Minute).UnixMilli(),
	}}, nil)
	writeClineDatabase(t, filepath.Join(hostHome, ".cline", "data"), []clineTestRow{{
		SessionID: "1700000000001_cline",
		Cwd:       projectDir,
		Prompt:    "Cline 会话",
		StartedAt: base.Add(4 * time.Minute).UnixMilli(),
		UpdatedAt: base.Add(4 * time.Minute).UnixMilli(),
	}})
	writeCodebuddySession(t, hostHome, ".codebuddy", "all-providers", "buddy-session", []map[string]any{
		{"type": "ai-title", "aiTitle": "CodeBuddy 会话", "cwd": projectDir},
		{"type": "message", "role": "user", "content": "你好", "timestamp": base.Add(5 * time.Minute).UnixMilli()},
	})

	handler := newTestHandler(t, hostHome, true)
	body := decodeProjectSessions(t, doSessionsRequest(t, handler, http.MethodGet, projectDir))

	project := body.Project
	wantProviders := "claude,codex,gemini,opencode,cline,codebuddy,codebuddycn,workbuddy,workbuddycn"
	if got := strings.Join(project.Providers, ","); got != wantProviders {
		t.Fatalf("providers = %q, 期望 %q", got, wantProviders)
	}
	wantSessions := []string{
		"1700000000001_cline", "buddy-session", "claude-session", "codex-session",
		"gemini-session", "opencode-session",
	}
	if got := sessionIDs(project); strings.Join(got, ",") != strings.Join(wantSessions, ",") {
		t.Fatalf("会话 id = %v, 期望 %v", got, wantSessions)
	}
	if project.SessionTotal != len(wantSessions) {
		t.Fatalf("sessionTotal = %d, 期望 %d", project.SessionTotal, len(wantSessions))
	}
	for _, session := range project.Sessions {
		if session.ID == "1700000000001_cline" {
			if session.ProjectDirName != projectDir {
				t.Fatalf("cline projectDirName = %q, 期望 %q", session.ProjectDirName, projectDir)
			}
			if session.Title != "Cline 会话" {
				t.Fatalf("cline title = %q, 期望 Cline 会话", session.Title)
			}
		}
		if session.ID == "opencode-session" && session.Title != "OpenCode 会话" {
			t.Fatalf("opencode title = %q, 期望 OpenCode 会话", session.Title)
		}
	}
}

// TestSessionsHandlerOpencodeLayoutsAndVisibility 验证 opencode 两代布局都会读、
// 同 id 取更新的副本，并过滤归档与子代理会话。
func TestSessionsHandlerOpencodeLayoutsAndVisibility(t *testing.T) {
	hostHome := t.TempDir()
	projectDir := newProjectDir(t, "opencode-layouts")
	base := time.Date(2026, 2, 4, 10, 0, 0, 0, time.UTC).UnixMilli()

	writeOpenCodeDatabase(t, hostHome,
		[]openCodeTestRow{
			{ID: "oc-v2", Directory: projectDir, Title: "新代标题", UpdatedAt: base + 3000},
			{ID: "oc-dup", Directory: projectDir, Title: "新代副本", UpdatedAt: base + 2000},
			{ID: "oc-archived", Directory: projectDir, Title: "已归档", UpdatedAt: base + 4000, Archived: true},
			{ID: "oc-child", Directory: projectDir, Title: "子代理", UpdatedAt: base + 5000, ParentID: "oc-v2"},
		},
		[]openCodeTestRow{
			{ID: "oc-legacy", Directory: projectDir, Title: "旧代标题", UpdatedAt: base + 1000},
			{ID: "oc-dup", Directory: projectDir, Title: "旧代副本", UpdatedAt: base + 1000},
		},
	)

	handler := newTestHandler(t, hostHome, true)
	body := decodeProjectSessions(t, doSessionsRequest(t, handler, http.MethodGet, projectDir))

	got := sessionIDs(body.Project)
	want := []string{"oc-dup", "oc-legacy", "oc-v2"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("会话 id = %v, 期望 %v（归档/子代理应被过滤）", got, want)
	}
	for _, session := range body.Project.Sessions {
		if session.ID == "oc-dup" && session.Title != "新代副本" {
			t.Fatalf("oc-dup title = %q, 期望取更新的新代副本", session.Title)
		}
	}
}

// TestSessionsHandlerClineAccountProjection 验证 cline 的账号投影会话库也会被读取。
func TestSessionsHandlerClineAccountProjection(t *testing.T) {
	hostHome := t.TempDir()
	aiHome := filepath.Join(t.TempDir(), "ai-home")
	projectDir := newProjectDir(t, "cline-projection")
	projectionDataDir := filepath.Join(aiHome, "run", "auth-projections", "cline", "acct-1", ".cline", "data")
	writeClineDatabase(t, projectionDataDir, []clineTestRow{{
		SessionID: "1700000000002_proj",
		Cwd:       projectDir,
		Prompt:    "投影会话",
		StartedAt: 1700000000002,
		UpdatedAt: 1700000000500,
	}})

	handler := newTestHandler(t, hostHome, true, func(dependencies *Dependencies) {
		dependencies.AiHomeDir = aiHome
	})
	body := decodeProjectSessions(t, doSessionsRequest(t, handler, http.MethodGet, projectDir))

	got := sessionIDs(body.Project)
	if strings.Join(got, ",") != "1700000000002_proj" {
		t.Fatalf("会话 id = %v, 期望 [1700000000002_proj]", got)
	}
	if strings.Join(body.Project.Providers, ",") != "cline" {
		t.Fatalf("providers = %v, 期望 [cline]", body.Project.Providers)
	}
}

// TestSessionsHandlerClineJSONFallback 验证 sessions.db 缺失时回退单会话 JSON。
func TestSessionsHandlerClineJSONFallback(t *testing.T) {
	hostHome := t.TempDir()
	projectDir := newProjectDir(t, "cline-json")
	writeClineSessionJSON(
		t,
		filepath.Join(hostHome, ".cline", "data"),
		"1700000000003_json", projectDir, "JSON 兜底", 1700000000003,
	)

	handler := newTestHandler(t, hostHome, true)
	body := decodeProjectSessions(t, doSessionsRequest(t, handler, http.MethodGet, projectDir))

	got := sessionIDs(body.Project)
	if strings.Join(got, ",") != "1700000000003_json" {
		t.Fatalf("会话 id = %v, 期望 [1700000000003_json]", got)
	}
	if body.Project.Sessions[0].Title != "JSON 兜底" {
		t.Fatalf("title = %q, 期望 JSON 兜底", body.Project.Sessions[0].Title)
	}
}
