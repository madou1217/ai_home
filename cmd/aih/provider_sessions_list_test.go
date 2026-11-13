package main

import (
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
)

// TestWriteSessionRows 空列表给明确提示；有行时输出状态/账号/名称/项目。
func TestWriteSessionRows(t *testing.T) {
	var empty strings.Builder
	writeSessionRows(&empty, "codebuddycn", nil, nil)
	if !strings.Contains(empty.String(), "当前没有活跃的持久会话") {
		t.Fatalf("empty = %q", empty.String())
	}
	rows := []persistent.SessionRow{
		{
			Provider:         "codebuddycn",
			AccountRef:       "acct_0123456789abcdef0123",
			Label:            "验收会话",
			Name:             "aih-codebuddycn-acct",
			Path:             "/tmp/project",
			Live:             true,
			LastActivityAtMS: 1700000000000,
		},
	}
	labels := map[string]string{"acct_0123456789abcdef0123": "#2 MeaDeo"}
	var output strings.Builder
	writeSessionRows(&output, "codebuddycn", rows, labels)
	text := output.String()
	for _, want := range []string{
		"codebuddycn 持久会话（1）", "● 运行中", "#2 MeaDeo", "验收会话",
		"aih-codebuddycn-acct", "/tmp/project",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("输出缺少 %q:\n%s", want, text)
		}
	}
}

// TestShortAccountRef 管理面不可用时只暴露 ref 尾段。
func TestShortAccountRef(t *testing.T) {
	if got := shortAccountRef("acct_0123456789abcdef0123"); !strings.HasSuffix(got, "cdef0123") {
		t.Fatalf("short = %q", got)
	}
}
