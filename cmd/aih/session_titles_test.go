package main

import (
	"testing"

	"github.com/madou1217/ai_home/internal/sessionscan/sessionread"
)

// TestUsableSessionTitle 过滤合成上下文并压缩空白。
func TestUsableSessionTitle(t *testing.T) {
	cases := map[string]string{
		"  讨论   由 aih  fork  ":           "讨论 由 aih fork",
		"<goal_context>":                 "",
		"# AGENTS.md instructions for x": "",
		"Caveat: x":                      "",
		"Warmup":                         "",
		"未命名会话":                          "",
	}
	for input, want := range cases {
		if got := usableSessionTitle(input); got != want {
			t.Fatalf("usableSessionTitle(%q) = %q, want %q", input, got, want)
		}
	}
}

// TestSessionUpdatedMillis 秒级时间戳归一成毫秒。
func TestSessionUpdatedMillis(t *testing.T) {
	if got := sessionUpdatedMillis(sessionread.Session{UpdatedAt: 1700000000}); got != 1700000000000 {
		t.Fatalf("seconds = %d", got)
	}
	if got := sessionUpdatedMillis(sessionread.Session{UpdatedAt: 1700000000123}); got != 1700000000123 {
		t.Fatalf("millis = %d", got)
	}
}

// TestNormalizeSessionProjectPath 尾斜杠与相对片段被归一。
func TestNormalizeSessionProjectPath(t *testing.T) {
	if got := normalizeSessionProjectPath("/tmp/project/"); got != "/tmp/project" {
		t.Fatalf("path = %q", got)
	}
	if got := normalizeSessionProjectPath("  "); got != "" {
		t.Fatalf("blank = %q", got)
	}
}
