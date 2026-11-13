package providercli

import (
	"slices"
	"testing"
)

func TestApplyConfigDirArgument(t *testing.T) {
	root := "/tmp/projection/qoder"
	got := applyConfigDirArgument("qoder", []string{"--model", "x"}, root)
	if len(got) != 4 || got[0] != "--config-dir" || got[1] != root {
		t.Fatalf("qoder args = %v", got)
	}
	if !slices.Equal(applyConfigDirArgument("codex", []string{"--model", "x"}, root), []string{"--model", "x"}) {
		t.Fatal("非 qoder Provider 不应注入 --config-dir")
	}
	existing := []string{"--config-dir", "/custom"}
	if !slices.Equal(applyConfigDirArgument("qoder", existing, root), existing) {
		t.Fatal("已有 --config-dir 时不应重复注入")
	}
}
