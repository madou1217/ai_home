package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

func writeCatalogFixture(t *testing.T, models map[string]catalogModel, shaOverride string) string {
	t.Helper()
	catalogBytes, err := json.Marshal(map[string]any{
		"models":    models,
		"providers": map[string]any{"openai": map[string]any{"id": "openai", "models": map[string]any{}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(catalogBytes)
	sha := hex.EncodeToString(digest[:])
	if shaOverride != "" {
		sha = shaOverride
	}
	documentBytes, err := json.Marshal(map[string]any{
		"schemaVersion": snapshotSchemaVersion,
		"source": sourceMetadata{
			URL:    modelsDevCatalogURL,
			SHA256: sha,
		},
		"catalog": json.RawMessage(catalogBytes),
	})
	if err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(t.TempDir(), "catalog.json")
	if err := os.WriteFile(filePath, documentBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	return filePath
}

func TestBuildSnapshotReadsCanonicalCatalogModalities(t *testing.T) {
	t.Parallel()
	source := writeCatalogFixture(t, map[string]catalogModel{
		"openai/gpt-example": {
			ID: "openai/gpt-example",
			Modalities: snapshotRecord{
				Input:  []string{"text", "image", "pdf"},
				Output: []string{"text"},
			},
		},
	}, "")
	snapshot, err := buildSnapshot(source)
	if err != nil {
		t.Fatalf("buildSnapshot() error = %v", err)
	}
	record, found := snapshot["openai/gpt-example"]
	if !found {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	assertValues(t, record.Input, []string{"text", "image", "pdf"})
	assertValues(t, record.Output, []string{"text"})
}

func TestBuildSnapshotRejectsHashMismatch(t *testing.T) {
	t.Parallel()
	source := writeCatalogFixture(t, map[string]catalogModel{
		"openai/gpt-example": {
			ID:         "openai/gpt-example",
			Modalities: snapshotRecord{Input: []string{"text"}, Output: []string{"text"}},
		},
	}, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if _, err := buildSnapshot(source); err == nil {
		t.Fatal("buildSnapshot() error = nil")
	}
}

func TestBuildSnapshotRejectsInvalidModalities(t *testing.T) {
	t.Parallel()
	source := writeCatalogFixture(t, map[string]catalogModel{
		"openai/gpt-example": {
			ID:         "openai/gpt-example",
			Modalities: snapshotRecord{Input: []string{"text", "text"}, Output: []string{"text"}},
		},
	}, "")
	if _, err := buildSnapshot(source); err == nil {
		t.Fatal("buildSnapshot() error = nil")
	}
}

// assertValues 验证生成器保留 models.dev API 的原始模态顺序。
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

// TestEffortLadderOrdersByCanonicalStrength 锁住阶梯顺序：对齐按位置配对，顺序错了映射就错。
func TestEffortLadderOrdersByCanonicalStrength(t *testing.T) {
	t.Parallel()
	got, err := effortLadder([]catalogReasoningItem{
		{Type: "toggle"},
		{Type: "effort", Values: []string{"high", "low", "max"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertValues(t, got, []string{"low", "high", "max"})
}

// TestEffortLadderRejectsUnknownTiers 失败关闭：目录出现未登记档位时不能静默丢弃——
// 那会把「模型支持该档位」变成「模型不支持」。
func TestEffortLadderRejectsUnknownTiers(t *testing.T) {
	t.Parallel()
	if _, err := effortLadder([]catalogReasoningItem{{Type: "effort", Values: []string{"turbo"}}}); err == nil {
		t.Fatal("effortLadder() error = nil for an unknown tier")
	}
}

func TestEffortLadderAbsentWhenNoEffortOption(t *testing.T) {
	t.Parallel()
	got, err := effortLadder([]catalogReasoningItem{{Type: "toggle"}, {Type: "budget_tokens"}})
	if err != nil || len(got) != 0 {
		t.Fatalf("effortLadder() = %v, %v; want empty", got, err)
	}
}

// TestCanonicalOrderMatchesInferencePackage 守住生成器里重复声明的那份 Canonical 全序
// 与 core/inference 一致（生成器不能 import core，因此只能靠测试兜住）。
func TestCanonicalOrderMatchesInferencePackage(t *testing.T) {
	t.Parallel()
	canonical := inference.CanonicalEffortOrder()
	if len(canonical) != len(canonicalEffortOrder) {
		t.Fatalf("canonical order length = %d, generator has %d", len(canonical), len(canonicalEffortOrder))
	}
	for index, effort := range canonical {
		if string(effort) != canonicalEffortOrder[index] {
			t.Fatalf("canonical order[%d] = %q, generator has %q", index, effort, canonicalEffortOrder[index])
		}
	}
}
