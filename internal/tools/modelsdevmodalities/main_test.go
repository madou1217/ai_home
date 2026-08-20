package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
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
