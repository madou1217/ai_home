package codexindex

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestListReadsSessionMetaAndTitle 从 rollout 首段读取 thread id/cwd 与首条可用用户消息。
func TestListReadsSessionMetaAndTitle(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".codex", "sessions", "2026", "11", "13")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	lines := []string{
		"{\"timestamp\":\"2026-11-13T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"11111111-2222-3333-4444-555555555555\",\"cwd\":\"/tmp/proj\",\"timestamp\":\"2026-11-13T10:00:00Z\"}}",
		"{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<environment_context>meta</environment_context>\"}]}}",
		"{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"修复 登录 bug\"}]}}",
	}
	path := filepath.Join(dir, "rollout-2026-11-13T10-00-00-11111111-2222-3333-4444-555555555555.jsonl")
	body := lines[0] + "\n" + lines[1] + "\n" + lines[2] + "\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	sessions := List(home)
	if len(sessions) != 1 {
		t.Fatalf("sessions = %#v", sessions)
	}
	session := sessions[0]
	if session.ID != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("id = %q", session.ID)
	}
	if session.CWD != "/tmp/proj" {
		t.Fatalf("cwd = %q", session.CWD)
	}
	if session.Title != "修复 登录 bug" {
		t.Fatalf("title = %q", session.Title)
	}
	if session.UpdatedAtMS <= 0 {
		t.Fatalf("updatedAt = %d", session.UpdatedAtMS)
	}
}

// TestReadSessionFallsBackToFileName 没有 session_meta 时从文件名提取 uuid。
func TestReadSessionFallsBackToFileName(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rollout-2026-11-13T10-00-00-11111111-2222-3333-4444-555555555555.jsonl")
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	session := readSession(path, time.Now())
	if session.ID != "11111111-2222-3333-4444-555555555555" {
		t.Fatalf("fallback id = %q", session.ID)
	}
}

// TestIsSynthetic 上下文块不被当成标题。
func TestIsSynthetic(t *testing.T) {
	if !isSynthetic("<environment_context>x</environment_context>") {
		t.Fatal("环境块应判为合成")
	}
	if isSynthetic("修复登录") {
		t.Fatal("普通消息不应判为合成")
	}
}
