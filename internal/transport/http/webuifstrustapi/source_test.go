package webuifstrustapi

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/webuifile"
)

func TestSourceRoundTripsNodeShape(t *testing.T) {
	home := t.TempDir()
	source, err := OpenSource(home)
	if err != nil {
		t.Fatalf("OpenSource() error = %v", err)
	}
	roots, err := source.ReadTrustedRoots(context.Background())
	if err != nil || len(roots) != 0 {
		t.Fatalf("空库 ReadTrustedRoots() = %#v, %v", roots, err)
	}

	root := t.TempDir()
	if err := source.WriteTrustedRoots(context.Background(), []webuifile.TrustedRoot{{Path: root, TrustedAt: 42}}); err != nil {
		t.Fatalf("WriteTrustedRoots() error = %v", err)
	}
	loaded, err := source.ReadTrustedRoots(context.Background())
	if err != nil {
		t.Fatalf("ReadTrustedRoots() error = %v", err)
	}
	want := webuifile.NormalizeTrustedRoots([]webuifile.TrustedRoot{{Path: root, TrustedAt: 42}})
	if len(loaded) != 1 || loaded[0] != want[0] {
		t.Fatalf("loaded = %#v, want %#v", loaded, want)
	}

	databasePath, err := appstate.DatabasePath(home)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	raw, found, err := appstate.ReadKV(context.Background(), databasePath, trustedRootsKey)
	if err != nil || !found {
		t.Fatalf("读取落盘值 found=%v err=%v", found, err)
	}
	var entries []map[string]any
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		t.Fatalf("落盘值不是 JSON: %s (%v)", raw, err)
	}
	if len(entries) != 1 || entries[0]["path"] != want[0].Path || entries[0]["trustedAt"] != float64(42) {
		t.Fatalf("落盘值 = %s", raw)
	}
	if _, camel := entries[0]["trustedAt"]; !camel {
		t.Fatalf("字段名偏离 Node: %s", raw)
	}
	if _, wrong := entries[0]["Path"]; wrong {
		t.Fatalf("不应出现 Go 字段名: %s", raw)
	}
}

func TestSourceTreatsCorruptValueAsEmpty(t *testing.T) {
	home := t.TempDir()
	source, err := OpenSource(home)
	if err != nil {
		t.Fatalf("OpenSource() error = %v", err)
	}
	databasePath, err := appstate.DatabasePath(home)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	if err := appstate.WriteKV(context.Background(), databasePath, trustedRootsKey, "not-json", 1); err != nil {
		t.Fatalf("写入坏值失败: %v", err)
	}
	roots, err := source.ReadTrustedRoots(context.Background())
	if err != nil || len(roots) != 0 {
		t.Fatalf("坏值 ReadTrustedRoots() = %#v, %v", roots, err)
	}
}

func TestSourceSkipsMalformedEntries(t *testing.T) {
	home := t.TempDir()
	source, err := OpenSource(home)
	if err != nil {
		t.Fatalf("OpenSource() error = %v", err)
	}
	root := t.TempDir()
	document, err := json.Marshal([]any{
		map[string]any{"path": root, "trustedAt": 5},
		42,
		map[string]any{"path": "relative"},
		map[string]any{"path": root, "trustedAt": 9},
	})
	if err != nil {
		t.Fatalf("编码夹具失败: %v", err)
	}
	databasePath, err := appstate.DatabasePath(home)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	if err := appstate.WriteKV(context.Background(), databasePath, trustedRootsKey, string(document), 1); err != nil {
		t.Fatalf("写入夹具失败: %v", err)
	}
	roots, err := source.ReadTrustedRoots(context.Background())
	if err != nil {
		t.Fatalf("ReadTrustedRoots() error = %v", err)
	}
	want := webuifile.NormalizeTrustedRoots([]webuifile.TrustedRoot{{Path: root, TrustedAt: 5}})
	if len(roots) != 1 || roots[0] != want[0] {
		t.Fatalf("roots = %#v, want %#v", roots, want)
	}
}

func TestOpenSourceRejectsEmptyRoot(t *testing.T) {
	if _, err := OpenSource("  "); err == nil {
		t.Fatal("OpenSource(\"  \") 应当报错")
	}
}
