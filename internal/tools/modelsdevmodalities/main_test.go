package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestParseModelDocumentReadsOnlyRequiredFields 验证解析器只读取继承和模态字段。
func TestParseModelDocumentReadsOnlyRequiredFields(t *testing.T) {
	t.Parallel()

	document := `
base_model = "openai/base-model"
name = "Ignored # text"

[modalities]
input = ["text", "image", "pdf"] # 行尾注释
output = ["text"]

[cost]
input = 1
`
	model, err := parseModelDocument(strings.NewReader(document))
	if err != nil {
		t.Fatalf("parseModelDocument() error = %v", err)
	}
	if model.baseModel != "openai/base-model" {
		t.Fatalf("baseModel = %q", model.baseModel)
	}
	assertValues(t, model.input, []string{"text", "image", "pdf"})
	assertValues(t, model.output, []string{"text"})
}

// TestResolveModelInheritsMissingModalities 验证派生模型只覆盖自己明确声明的方向。
func TestResolveModelInheritsMissingModalities(t *testing.T) {
	t.Parallel()

	models := map[string]rawModel{
		"openai/base": {
			input:  []string{"text", "image"},
			output: []string{"text"},
		},
		"openai/derived": {
			baseModel: "openai/base",
			output:    []string{"image"},
		},
	}
	resolved, err := resolveModel("openai/derived", models, map[string]bool{})
	if err != nil {
		t.Fatalf("resolveModel() error = %v", err)
	}
	assertValues(t, resolved.input, []string{"text", "image"})
	assertValues(t, resolved.output, []string{"image"})
}

// TestParseModelDocumentRejectsInvalidArray 验证损坏的模态不会进入生成快照。
func TestParseModelDocumentRejectsInvalidArray(t *testing.T) {
	t.Parallel()

	document := "[modalities]\ninput = [text]\noutput = [\"text\"]\n"
	if _, err := parseModelDocument(strings.NewReader(document)); err == nil {
		t.Fatal("parseModelDocument() error = nil")
	}
}

// TestBuildSnapshotWalksNestedModelIDs 验证文件相对路径就是稳定的 models.dev 模型键。
func TestBuildSnapshotWalksNestedModelIDs(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	modelDir := filepath.Join(root, "openai", "nested")
	if err := os.MkdirAll(modelDir, 0o755); err != nil {
		t.Fatalf("os.MkdirAll() error = %v", err)
	}
	document := []byte("[modalities]\ninput = [\"text\"]\noutput = [\"text\"]\n")
	if err := os.WriteFile(filepath.Join(modelDir, "model.toml"), document, 0o600); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}
	snapshot, err := buildSnapshot(root)
	if err != nil {
		t.Fatalf("buildSnapshot() error = %v", err)
	}
	record, found := snapshot["openai/nested/model"]
	if !found {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	assertValues(t, record.Input, []string{"text"})
	assertValues(t, record.Output, []string{"text"})
}

// assertValues 验证生成器保留 models.dev 的原始模态顺序。
func assertValues(t *testing.T, got []string, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("values = %#v, want %#v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("values = %#v, want %#v", got, want)
		}
	}
}
