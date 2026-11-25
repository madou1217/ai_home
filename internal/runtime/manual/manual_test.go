package manual

import (
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/runtime/completion"
)

func TestRenderInjectsManifestAndMeta(t *testing.T) {
	entries := []completion.DocEntry{{Group: "顶层命令", Path: "aih man", Description: "打开命令手册"}}
	page, err := Render(entries, Meta{Model: "agy/gemini-4-neon-xhigh", Server: "aws"})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	text := string(page)
	for _, unwanted := range []string{"__AIH_MANIFEST__", "__AIH_MODEL__", "__AIH_SERVER__"} {
		if strings.Contains(text, unwanted) {
			t.Fatalf("占位符未替换：%s", unwanted)
		}
	}
	if !strings.Contains(text, "aih man") || !strings.Contains(text, "agy/gemini-4-neon-xhigh") {
		t.Fatal("渲染结果缺少条目或来源信息")
	}
	if !strings.HasPrefix(strings.TrimSpace(text), "<!DOCTYPE html>") {
		t.Fatal("模板不是完整 HTML 文档")
	}
}
