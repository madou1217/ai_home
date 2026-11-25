package manual

import (
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/runtime/completion"
)

func TestRenderInjectsManifestAndMeta(t *testing.T) {
	entries := []completion.DocEntry{
		{Group: "顶层命令", Path: "aih man", Description: "打开命令手册", Example: "aih man"},
	}
	notes := map[string]string{"顶层命令": "先看全局地图"}
	page, err := Render(entries, notes, Meta{Model: "agy/gemini-4-neon-xhigh", Server: "aws", GeneratedAt: "2026-11-25 18:00"})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	text := string(page)
	for _, unwanted := range []string{"__AIH_MANIFEST__", "__AIH_MODEL__", "__AIH_SERVER__"} {
		if strings.Contains(text, unwanted) {
			t.Fatalf("占位符未替换：%s", unwanted)
		}
	}
	for _, wanted := range []string{
		"<!DOCTYPE html>",
		"window.__AIH_MANUAL__",
		"class=\"hero\"",
		"agy/gemini-4-neon-xhigh",
		"先看全局地图",
		"aih man",
	} {
		if !strings.Contains(text, wanted) {
			t.Fatalf("渲染结果缺少 %q", wanted)
		}
	}
	if !strings.Contains(text, "--accent") {
		t.Fatal("样式未内联")
	}
}

func TestRenderHandlesEmptyInput(t *testing.T) {
	page, err := Render(nil, nil, Meta{})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(string(page), "window.__AIH_MANUAL__") {
		t.Fatal("空输入也应产出可打开页面")
	}
}

func TestDocumentationEntriesCarryExamples(t *testing.T) {
	entries := completion.DocumentationEntries()
	seen := map[string]bool{}
	for _, entry := range entries {
		seen[entry.Path] = true
		if entry.Path == "" || entry.Description == "" {
			t.Fatalf("条目缺少路径或说明：%+v", entry)
		}
	}
	for _, path := range []string{"aih man", "aih codex relay", "aih usage stats", "aih native plugin enable"} {
		if !seen[path] {
			t.Fatalf("缺少命令 %q", path)
		}
	}
	found := false
	for _, entry := range entries {
		if entry.Path == "aih codex relay" && entry.Example != "" && entry.Usage != "" {
			found = true
		}
	}
	if !found {
		t.Fatal("关键命令缺少用法或示例")
	}
}
