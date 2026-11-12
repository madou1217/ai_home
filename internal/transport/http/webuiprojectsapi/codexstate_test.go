package webuiprojectsapi

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// codexStateTestRow 是一条 codex state 库 threads 行。
type codexStateTestRow struct {
	ID               string
	Cwd              string
	Title            string
	FirstUserMessage string
	RolloutPath      string
	Source           string
	ThreadSource     string
	ParentThreadID   string
	Archived         bool
	UpdatedAtMS      int64
}

// writeCodexStateDatabase 造一个 codex state 库；spawnedChildIDs 写进
// thread_spawn_edges（为空时不建该表）。
func writeCodexStateDatabase(
	t *testing.T,
	hostHome, fileName string,
	rows []codexStateTestRow,
	spawnedChildIDs []string,
) {
	t.Helper()
	database := openTestSQLite(t, filepath.Join(hostHome, ".codex", fileName))
	if _, err := database.Exec("CREATE TABLE threads (" +
		"id TEXT PRIMARY KEY, " +
		"rollout_path TEXT, " +
		"created_at INTEGER, " +
		"updated_at INTEGER, " +
		"source TEXT, " +
		"cwd TEXT, " +
		"title TEXT, " +
		"archived INTEGER DEFAULT 0, " +
		"first_user_message TEXT, " +
		"updated_at_ms INTEGER, " +
		"thread_source TEXT, " +
		"parent_thread_id TEXT" +
		")"); err != nil {
		t.Fatalf("创建 threads 表失败: %v", err)
	}
	insert := "INSERT INTO threads (" +
		"id, rollout_path, created_at, updated_at, source, cwd, title, archived, " +
		"first_user_message, updated_at_ms, thread_source, parent_thread_id" +
		") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
	for _, row := range rows {
		archived := int64(0)
		if row.Archived {
			archived = 1
		}
		if _, err := database.Exec(
			insert,
			row.ID, row.RolloutPath, row.UpdatedAtMS/1000, row.UpdatedAtMS/1000, row.Source,
			row.Cwd, row.Title, archived, row.FirstUserMessage, row.UpdatedAtMS,
			row.ThreadSource, row.ParentThreadID,
		); err != nil {
			t.Fatalf("写入 threads 行 %s 失败: %v", row.ID, err)
		}
	}
	if len(spawnedChildIDs) == 0 {
		return
	}
	if _, err := database.Exec("CREATE TABLE thread_spawn_edges (child_thread_id TEXT)"); err != nil {
		t.Fatalf("创建 thread_spawn_edges 表失败: %v", err)
	}
	for _, childID := range spawnedChildIDs {
		if _, err := database.Exec("INSERT INTO thread_spawn_edges (child_thread_id) VALUES (?)", childID); err != nil {
			t.Fatalf("写入 spawn 边失败: %v", err)
		}
	}
}

// writeCodexRolloutFile 造一个 rollout JSONL，返回文件路径。
func writeCodexRolloutFile(t *testing.T, hostHome, sessionID, cwd string, records []map[string]any) string {
	t.Helper()
	sessionsDir := filepath.Join(hostHome, ".codex", "sessions", "2026", "11", "02")
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		t.Fatalf("创建 codex 会话目录失败: %v", err)
	}
	metaLine, err := json.Marshal(map[string]any{
		"type": "session_meta",
		"payload": map[string]any{
			"id":     sessionID,
			"cwd":    cwd,
			"source": "vscode",
		},
	})
	if err != nil {
		t.Fatalf("序列化 codex meta 失败: %v", err)
	}
	lines := []string{string(metaLine)}
	for _, record := range records {
		line, err := json.Marshal(record)
		if err != nil {
			t.Fatalf("序列化 codex 记录失败: %v", err)
		}
		lines = append(lines, string(line))
	}
	rolloutPath := filepath.Join(sessionsDir, "rollout-2026-11-02T10-00-00-"+sessionID+".jsonl")
	if err := os.WriteFile(rolloutPath, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatalf("写入 rollout 失败: %v", err)
	}
	return rolloutPath
}

// writeCodexSessionIndex 造 session_index.jsonl（id -> thread_name）。
func writeCodexSessionIndex(t *testing.T, hostHome string, entries map[string]string) {
	t.Helper()
	codexDir := filepath.Join(hostHome, ".codex")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatalf("创建 codex 目录失败: %v", err)
	}
	lines := make([]string, 0, len(entries))
	for id, title := range entries {
		line, err := json.Marshal(map[string]any{
			"id":          id,
			"thread_name": title,
			"updated_at":  time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC).Format(time.RFC3339Nano),
		})
		if err != nil {
			t.Fatalf("序列化 codex 索引失败: %v", err)
		}
		lines = append(lines, string(line))
	}
	if err := os.WriteFile(filepath.Join(codexDir, "session_index.jsonl"), []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatalf("写入 codex 索引失败: %v", err)
	}
}

// codexUserMessage 造一条 response_item 用户消息。
func codexUserMessage(text string) map[string]any {
	return map[string]any{
		"type": "response_item",
		"payload": map[string]any{
			"type": "message",
			"role": "user",
			"content": []map[string]any{
				{"type": "input_text", "text": text},
			},
		},
	}
}

// TestSessionsHandlerCodexStateDbSessions 守住 codex 项目的完整会话集合：
//
// Node 先读 ~/.codex/state*.sqlite 的 threads 表，库里读得到就不再扫 rollout
// 文件。只扫文件会漏掉「库里有、rollout 已被清理」和「标题只写在库里」的会话
// —— 真机就有一个首个用户消息在 3MB 之后、文件头取不到标题的会话整条消失。
func TestSessionsHandlerCodexStateDbSessions(t *testing.T) {
	hostHome := t.TempDir()
	projectDir := newProjectDir(t, "codex-state-db")
	base := int64(1793622183483)

	// 文件只写到 session_meta：文件分支读不出标题，旧实现会整条丢弃。
	titleInDbRollout := writeCodexRolloutFile(t, hostHome, "codex-title-in-db", projectDir, []map[string]any{
		{
			"type": "response_item",
			"payload": map[string]any{
				"type":    "message",
				"role":    "assistant",
				"content": []map[string]any{{"type": "output_text", "text": "收到"}},
			},
		},
	})
	fallbackRollout := writeCodexRolloutFile(t, hostHome, "codex-fallback-title", projectDir, []map[string]any{
		codexUserMessage("文件头里的标题"),
	})
	// 只有文件、库里没有行：库可用时整份以库为准（Node 同口径）。
	writeCodexRolloutFile(t, hostHome, "codex-file-only", projectDir, []map[string]any{
		codexUserMessage("只有文件没有库行"),
	})
	writeCodexSessionIndex(t, hostHome, map[string]string{
		"codex-index-title": "索引命名",
	})

	writeCodexStateDatabase(t, hostHome, "state_6.sqlite", []codexStateTestRow{
		// 同一 id 两代库都有：更新时间新的副本胜出。
		{ID: "codex-dup", Cwd: projectDir, Title: "旧库副本", Source: "vscode", ThreadSource: "user", UpdatedAtMS: base + 1000},
		{ID: "codex-db-only", Cwd: projectDir, Title: "只在库里的会话", Source: "vscode", ThreadSource: "user", UpdatedAtMS: base + 7000},
	}, nil)
	writeCodexStateDatabase(t, hostHome, "state_5.sqlite", []codexStateTestRow{
		{ID: "codex-dup", Cwd: projectDir, Title: "新库副本", Source: "vscode", ThreadSource: "user", UpdatedAtMS: base + 2000},
		{ID: "codex-index-title", Cwd: projectDir, Title: "库里的命名", Source: "vscode", ThreadSource: "user", UpdatedAtMS: base + 3000},
		{ID: "codex-title-in-db", Cwd: projectDir, Title: "标题只写在库里", RolloutPath: titleInDbRollout, Source: "vscode", ThreadSource: "user", UpdatedAtMS: base + 6000},
		{ID: "codex-first-user-message", Cwd: projectDir, FirstUserMessage: "库里记录的首条用户消息", Source: "vscode", ThreadSource: "user", UpdatedAtMS: base + 5000},
		{ID: "codex-fallback-title", Cwd: projectDir, RolloutPath: fallbackRollout, Source: "vscode", ThreadSource: "user", UpdatedAtMS: base + 4000},
		{ID: "codex-archived", Cwd: projectDir, Title: "已归档", Source: "vscode", ThreadSource: "user", Archived: true, UpdatedAtMS: base + 8000},
		{ID: "codex-subagent-thread", Cwd: projectDir, Title: "子代理", Source: "vscode", ThreadSource: "subagent", UpdatedAtMS: base + 9000},
		{ID: "codex-spawned-child", Cwd: projectDir, Title: "spawn 出来的子线程", Source: "vscode", ThreadSource: "user", UpdatedAtMS: base + 10000},
		{ID: "codex-non-interactive", Cwd: projectDir, Title: "exec 会话", Source: "exec", ThreadSource: "user", UpdatedAtMS: base + 11000},
	}, []string{"codex-spawned-child"})

	handler := newTestHandler(t, hostHome, true)
	body := decodeProjectSessions(t, doSessionsRequest(t, handler, http.MethodGet, projectDir))

	project := body.Project
	if strings.Join(project.Providers, ",") != "codex" {
		t.Fatalf("providers = %v, 期望 [codex]", project.Providers)
	}
	wantIDs := []string{
		"codex-db-only", "codex-dup", "codex-fallback-title",
		"codex-first-user-message", "codex-index-title", "codex-title-in-db",
	}
	if got := sessionIDs(project); strings.Join(got, ",") != strings.Join(wantIDs, ",") {
		t.Fatalf("会话 id = %v, 期望 %v（库里有行的会话一条都不能少；只有文件的会话不应出现）", got, wantIDs)
	}
	if project.SessionTotal != len(wantIDs) {
		t.Fatalf("sessionTotal = %d, 期望 %d", project.SessionTotal, len(wantIDs))
	}

	wantTitles := map[string]string{
		"codex-dup":                "新库副本",
		"codex-db-only":            "只在库里的会话",
		"codex-fallback-title":     "文件头里的标题",
		"codex-first-user-message": "库里记录的首条用户消息",
		"codex-index-title":        "索引命名",
		"codex-title-in-db":        "标题只写在库里",
	}
	wantUpdatedAt := map[string]int64{
		"codex-db-only": base + 7000,
		"codex-dup":     base + 2000,
	}
	for _, session := range project.Sessions {
		if expected, exists := wantTitles[session.ID]; exists && session.Title != expected {
			t.Fatalf("%s title = %q, 期望 %q", session.ID, session.Title, expected)
		}
		if expected, exists := wantUpdatedAt[session.ID]; exists && session.UpdatedAt != expected {
			t.Fatalf("%s updatedAt = %d, 期望库里的 %d", session.ID, session.UpdatedAt, expected)
		}
	}
}
