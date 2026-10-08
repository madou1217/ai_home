package modelalias_test

import (
	"testing"

	"github.com/madou1217/ai_home/application/modelalias"
)

func TestStoreReplacesProjectionAndBumpsGeneration(t *testing.T) {
	t.Parallel()

	store := modelalias.NewStore()
	if store.Generation() != 0 || store.Snapshot().Len() != 0 {
		t.Fatal("新 Store 应当是空投影且代次为 0")
	}
	generation, err := store.Replace([]modelalias.Record{
		{ID: "b", Alias: "fast", Target: "gpt-5"},
		{ID: "a", Alias: "smart", Target: "claude-opus-5"},
	})
	if err != nil || generation != 1 {
		t.Fatalf("Replace() generation=%d err=%v", generation, err)
	}
	snapshot := store.Snapshot()
	if snapshot.Len() != 2 {
		t.Fatalf("len = %d", snapshot.Len())
	}
	// 顺序必须原样保留：Node 用数组下标做同优先级 tiebreaker。
	if snapshot.Records()[0].ID != "b" || snapshot.Records()[1].ID != "a" {
		t.Fatalf("records = %#v", snapshot.Records())
	}
	// 空值规范化成 Node 的默认值。
	if snapshot.Records()[0].ScopeProvider() != modelalias.ScopeAll ||
		snapshot.Records()[0].ResolvedTargetProvider() != modelalias.TargetProviderAuto {
		t.Fatalf("record = %#v", snapshot.Records()[0])
	}

	generation, err = store.Replace(nil)
	if err != nil || generation != 2 || store.Snapshot().Len() != 0 {
		t.Fatalf("清空投影失败 generation=%d err=%v", generation, err)
	}
}

func TestStoreRejectsInvalidProjectionWithoutLosingCurrentOne(t *testing.T) {
	t.Parallel()

	store := modelalias.NewStore()
	if _, err := store.Replace([]modelalias.Record{{ID: "a", Alias: "fast", Target: "gpt-5"}}); err != nil {
		t.Fatalf("Replace() error = %v", err)
	}
	// 缺 target：整体拒绝，保留原投影。
	if _, err := store.Replace([]modelalias.Record{{ID: "b", Alias: "broken"}}); err != modelalias.ErrInvalidAlias {
		t.Fatalf("err = %v", err)
	}
	// 重复 id：整体拒绝。
	if _, err := store.Replace([]modelalias.Record{
		{ID: "dup", Alias: "x", Target: "gpt-5"},
		{ID: "dup", Alias: "y", Target: "gpt-5"},
	}); err != modelalias.ErrInvalidProjection {
		t.Fatalf("err = %v", err)
	}
	snapshot := store.Snapshot()
	if snapshot.Generation() != 1 || snapshot.Len() != 1 || snapshot.Records()[0].ID != "a" {
		t.Fatalf("拒绝后投影被破坏: %#v", snapshot.Records())
	}
}

func TestRecordEnabledDefaultsToTrue(t *testing.T) {
	t.Parallel()

	if !(modelalias.Record{Alias: "a", Target: "b"}).IsEnabled() {
		t.Fatal("未提供 enabled 时按启用处理，避免不完整推送静默停用全部别名")
	}
	disabled := false
	if (modelalias.Record{Alias: "a", Target: "b", Enabled: &disabled}).IsEnabled() {
		t.Fatal("显式 false 应当停用")
	}
}
