package main

import (
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
)

// TestMatchGlobalSession 精确名 → 唯一前缀 → 唯一描述；多义返回候选。
func TestMatchGlobalSession(t *testing.T) {
	rows := []persistent.SessionRow{
		{Name: "p-ai_home-1", Label: "讨论 fork"},
		{Name: "p-ai_home-2", Label: "移除备份"},
		{Name: "p-shalou-1", Label: "优化布局"},
	}
	matched, ambiguous := matchGlobalSession(rows, "p-ai_home-1")
	if matched == nil || matched.Name != "p-ai_home-1" || len(ambiguous) != 0 {
		t.Fatalf("exact = %#v %#v", matched, ambiguous)
	}
	matched, ambiguous = matchGlobalSession(rows, "p-shalou")
	if matched == nil || matched.Name != "p-shalou-1" {
		t.Fatalf("prefix = %#v", matched)
	}
	matched, ambiguous = matchGlobalSession(rows, "p-ai_home")
	if matched != nil || len(ambiguous) != 2 {
		t.Fatalf("ambiguous = %#v %#v", matched, ambiguous)
	}
	matched, _ = matchGlobalSession(rows, "备份")
	if matched == nil || matched.Name != "p-ai_home-2" {
		t.Fatalf("description = %#v", matched)
	}
	if matched, ambiguous := matchGlobalSession(rows, "nope"); matched != nil || len(ambiguous) != 0 {
		t.Fatalf("not found = %#v %#v", matched, ambiguous)
	}
}

// TestPersistentAttachArgs 与 Node buildTmuxBaseArgs + attach-session 对齐。
func TestPersistentAttachArgs(t *testing.T) {
	args := persistentAttachArgs(persistent.SessionRow{Socket: "aih-codebuddycn-acct_x", Name: "p-ai_home-1"})
	want := "-u -L aih-codebuddycn-acct_x attach-session -d -t p-ai_home-1"
	if strings.Join(args, " ") != want {
		t.Fatalf("args = %v", args)
	}
}

// TestWithoutTmuxClientEnv 外层 tmux 变量必须去掉，避免嵌套客户端。
func TestWithoutTmuxClientEnv(t *testing.T) {
	filtered := withoutTmuxClientEnv([]string{"TMUX=/tmp/tmux,1,0", "TMUX_PANE=%1", "HOME=/Users/me"})
	joined := strings.Join(filtered, " ")
	if strings.Contains(joined, "TMUX") || !strings.Contains(joined, "HOME=/Users/me") {
		t.Fatalf("filtered = %v", filtered)
	}
}
