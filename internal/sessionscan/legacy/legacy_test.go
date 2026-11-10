package legacy

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

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

func sessionByID(t *testing.T, sessions []Session, id string) Session {
	t.Helper()
	for _, session := range sessions {
		if session.ID == id {
			return session
		}
	}
	t.Fatalf("session %q not found in %+v", id, sessions)
	return Session{}
}

func TestReadClaudeProjectsScansTitlesHistoryAndSkips(t *testing.T) {
	home := t.TempDir()
	workDir := filepath.Join(home, "alpha")
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(workDir): %v", err)
	}
	projectDir := filepath.Join(home, ".claude", "projects", "-work-alpha")

	writeFixture(t, filepath.Join(projectDir, "newer.jsonl"), fmt.Sprintf(
		"{\"type\":\"assistant\",\"cwd\":%q,\"message\":{\"content\":\"ignored\"}}\n"+
			"{\"type\":\"user\",\"message\":{\"content\":\"Caveat: synthetic\"}}\n"+
			"{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Fix the parser\"},{\"type\":\"text\",\"text\":\"now\"}]}}\n",
		workDir), time.Date(2026, 1, 3, 0, 0, 0, 0, time.UTC))

	// 主线程存在但没有可读标题：回退 history.jsonl 的 display。
	writeFixture(t, filepath.Join(projectDir, "older.jsonl"),
		"{\"type\":\"user\",\"isSidechain\":true,\"message\":{\"content\":\"sidechain title\"}}\n"+
			"{\"type\":\"assistant\",\"message\":{\"content\":\"no user text\"}}\n",
		time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	writeFixture(t, filepath.Join(home, ".claude", "history.jsonl"),
		"{\"sessionId\":\"older\",\"display\":\"History fallback\",\"project\":\"/does/not/exist\"}\n",
		time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))

	writeFixture(t, filepath.Join(projectDir, "warmup.jsonl"),
		"{\"type\":\"user\",\"message\":{\"content\":\"Warmup\"}}\n",
		time.Date(2026, 1, 5, 0, 0, 0, 0, time.UTC))
	writeFixture(t, filepath.Join(projectDir, "unnamed.jsonl"),
		"{\"type\":\"assistant\",\"message\":{\"content\":\"tool only\"}}\n",
		time.Date(2026, 1, 6, 0, 0, 0, 0, time.UTC))

	projects := ReadClaudeProjects(home, nil)
	if len(projects) != 1 {
		t.Fatalf("projects = %+v, want 1", projects)
	}
	project := projects[0]
	if project.ID != "-work-alpha" || project.Name != "alpha" || project.Path != workDir || project.Provider != "claude" {
		t.Fatalf("project = %+v", project)
	}
	if len(project.Sessions) != 2 {
		t.Fatalf("sessions = %+v, want 2", project.Sessions)
	}
	if project.Sessions[0].ID != "newer" || project.Sessions[1].ID != "older" {
		t.Fatalf("session order = %+v", project.Sessions)
	}
	newer := sessionByID(t, project.Sessions, "newer")
	if newer.Title != "Fix the parser now" {
		t.Fatalf("newer title = %q", newer.Title)
	}
	if newer.UpdatedAt != time.Date(2026, 1, 3, 0, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("newer updatedAt = %d", newer.UpdatedAt)
	}
	if newer.ProjectDirName != "-work-alpha" || newer.Provider != "claude" {
		t.Fatalf("newer = %+v", newer)
	}
	if older := sessionByID(t, project.Sessions, "older"); older.Title != "History fallback" {
		t.Fatalf("older title = %q", older.Title)
	}
}

func TestReadClaudeProjectResolvesKnownPathWhenNoCwd(t *testing.T) {
	home := t.TempDir()
	writeFixture(t, filepath.Join(home, ".claude", "projects", "-work-beta", "s1.jsonl"),
		"{\"type\":\"user\",\"message\":{\"content\":\"Hello\"}}\n",
		time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC))

	project, ok := ReadClaudeProject(home, "-work-beta", []string{"/work/beta"})
	if !ok {
		t.Fatal("ReadClaudeProject returned ok=false")
	}
	if project.Path != "/work/beta" || project.Name != "beta" {
		t.Fatalf("project = %+v", project)
	}
	if _, ok := ReadClaudeProject(home, "-missing", nil); ok {
		t.Fatal("missing project should not be returned")
	}
}

func TestReadGeminiProjectsScansCheckpointsAndNativeSessions(t *testing.T) {
	home := t.TempDir()
	chatsDir := filepath.Join(home, ".gemini", "tmp", "proj-a", "chats")
	writeFixture(t, filepath.Join(home, ".gemini", "history", "proj-a", ".project_root"),
		"/work/gemini-a\n", time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))

	writeFixture(t, filepath.Join(chatsDir, "checkpoint.json"),
		"{\"sessionId\":\"sess-checkpoint\",\"summary\":\"Checkpoint title\",\"lastUpdated\":\"2026-01-10T00:00:00.000Z\",\"messages\":[]}",
		time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	// 同 id 的 .jsonl 更新，但 .json 检查点优先。
	writeFixture(t, filepath.Join(chatsDir, "checkpoint-native.jsonl"),
		"{\"sessionId\":\"sess-checkpoint\",\"type\":\"meta\"}\n{\"type\":\"user\",\"content\":\"JSONL should not win\"}\n",
		time.Date(2026, 1, 20, 0, 0, 0, 0, time.UTC))

	writeFixture(t, filepath.Join(chatsDir, "native.jsonl"),
		"{\"sessionId\":\"sess-native\",\"type\":\"meta\"}\n"+
			"{\"type\":\"assistant\",\"content\":\"ignored\"}\n"+
			"{\"type\":\"user\",\"content\":[{\"text\":\"Native title\"}]}\n",
		time.Date(2026, 1, 5, 0, 0, 0, 0, time.UTC))

	writeFixture(t, filepath.Join(chatsDir, "nosummary.json"),
		"{\"sessionId\":\"sess-nosummary\",\"messages\":[{\"type\":\"user\",\"content\":[{\"text\":\"From messages\"}]}]}",
		time.Date(2026, 1, 4, 0, 0, 0, 0, time.UTC))

	// 同一 sessionId 的多个 .jsonl fork：取 mtime 最新的。
	writeFixture(t, filepath.Join(chatsDir, "fork-old.jsonl"),
		"{\"sessionId\":\"sess-fork\"}\n{\"type\":\"user\",\"content\":\"Old fork\"}\n",
		time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC))
	writeFixture(t, filepath.Join(chatsDir, "fork-new.jsonl"),
		"{\"sessionId\":\"sess-fork\"}\n{\"type\":\"user\",\"content\":\"New fork\"}\n",
		time.Date(2026, 1, 3, 0, 0, 0, 0, time.UTC))

	writeFixture(t, filepath.Join(chatsDir, "warmup.json"),
		"{\"sessionId\":\"sess-warm\",\"summary\":\"Warmup\",\"messages\":[]}",
		time.Date(2026, 1, 6, 0, 0, 0, 0, time.UTC))
	writeFixture(t, filepath.Join(chatsDir, "broken.json"), "{not json",
		time.Date(2026, 1, 7, 0, 0, 0, 0, time.UTC))
	// chats 目录缺失的项目不出现；只有 Warmup 的项目仍返回空会话（与 Node 一致）。
	writeFixture(t, filepath.Join(home, ".gemini", "tmp", "no-chats", "notes.txt"), "x",
		time.Date(2026, 1, 8, 0, 0, 0, 0, time.UTC))
	writeFixture(t, filepath.Join(home, ".gemini", "tmp", "empty", "chats", "warmup.json"),
		"{\"sessionId\":\"sess-warm\",\"summary\":\"Warmup\",\"messages\":[]}",
		time.Date(2026, 1, 9, 0, 0, 0, 0, time.UTC))

	projects := ReadGeminiProjects(home)
	if len(projects) != 2 {
		t.Fatalf("projects = %+v, want 2", projects)
	}
	if projects[0].ID != "gemini-empty" || len(projects[0].Sessions) != 0 {
		t.Fatalf("empty project = %+v", projects[0])
	}
	project := projects[1]
	if project.ID != "gemini-proj-a" || project.Name != "proj-a" || project.Path != "/work/gemini-a" || project.Provider != "gemini" {
		t.Fatalf("project = %+v", project)
	}
	if len(project.Sessions) != 4 {
		t.Fatalf("sessions = %+v, want 4", project.Sessions)
	}
	wantOrder := []string{"sess-checkpoint", "sess-native", "sess-nosummary", "sess-fork"}
	for index, want := range wantOrder {
		if project.Sessions[index].ID != want {
			t.Fatalf("session order = %+v, want %v", project.Sessions, wantOrder)
		}
	}
	checkpoint := sessionByID(t, project.Sessions, "sess-checkpoint")
	if checkpoint.Title != "Checkpoint title" {
		t.Fatalf("checkpoint title = %q", checkpoint.Title)
	}
	if checkpoint.UpdatedAt != time.Date(2026, 1, 10, 0, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("checkpoint updatedAt = %d", checkpoint.UpdatedAt)
	}
	if native := sessionByID(t, project.Sessions, "sess-native"); native.Title != "Native title" {
		t.Fatalf("native title = %q", native.Title)
	}
	if fallback := sessionByID(t, project.Sessions, "sess-nosummary"); fallback.Title != "From messages" {
		t.Fatalf("nosummary title = %q", fallback.Title)
	}
	if fork := sessionByID(t, project.Sessions, "sess-fork"); fork.Title != "New fork" {
		t.Fatalf("fork title = %q", fork.Title)
	}
}

func TestReadGeminiProjectMissingChats(t *testing.T) {
	home := t.TempDir()
	if _, ok := ReadGeminiProject(home, "absent"); ok {
		t.Fatal("missing chats dir should not produce a project")
	}
}
