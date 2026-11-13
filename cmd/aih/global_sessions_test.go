package main

import (
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
)

// TestGroupSessionsByProject 组间按路径排序，组内按活动时间倒序。
func TestGroupSessionsByProject(t *testing.T) {
	rows := []persistent.SessionRow{
		{Provider: "a", Path: "/tmp/b", Name: "s1", LastActivityAtMS: 100},
		{Provider: "a", Path: "/tmp/a", Name: "s2", LastActivityAtMS: 200},
		{Provider: "a", Path: "/tmp/b", Name: "s3", LastActivityAtMS: 300},
	}
	groups := groupSessionsByProject(rows)
	if len(groups) != 2 || groups[0].Project != "/tmp/a" || groups[1].Project != "/tmp/b" {
		t.Fatalf("groups = %#v", groups)
	}
	if groups[1].Rows[0].Name != "s3" || groups[1].Rows[1].Name != "s1" {
		t.Fatalf("组内顺序 = %#v", groups[1].Rows)
	}
}

// TestWriteGlobalSessionGroups 空列表给提示；有行时输出账号与名称。
func TestWriteGlobalSessionGroups(t *testing.T) {
	var empty strings.Builder
	writeGlobalSessionGroups(&empty, nil, nil)
	if !strings.Contains(empty.String(), "当前没有活跃的持久会话") {
		t.Fatalf("empty = %q", empty.String())
	}
	rows := []persistent.SessionRow{{
		Provider:   "codebuddycn",
		AccountRef: "acct_0123456789abcdef0123",
		Label:      "验收会话",
		Name:       "p-ai_home-1",
		Path:       "/tmp/project",
		Live:       true,
	}}
	var output strings.Builder
	writeGlobalSessionGroups(&output, rows, map[string]string{
		"acct_0123456789abcdef0123": "#2 MeaDeo",
	})
	text := output.String()
	for _, want := range []string{
		"项目：/tmp/project", "● 运行中", "codebuddycn", "#2 MeaDeo",
		"验收会话", "p-ai_home-1",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("输出缺少 %q:\n%s", want, text)
		}
	}
}
