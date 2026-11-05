package sqliteaccount

import (
	"context"
	"testing"

	"github.com/madou1217/ai_home/application/modelalias"
)

func aliasEnabled(value bool) *bool { return &value }

func TestModelAliasReplaceAndList(t *testing.T) {
	store := openOAuthJobStore(t)
	ctx := context.Background()

	records := []modelalias.Record{
		{ID: "a1", Alias: "fast", Target: "glm-5.3-flash", Provider: "zcode", Priority: 10, Description: "最快"},
		{ID: "a2", Alias: "smart", Target: "claude-opus-4-6", Provider: "claude", Priority: 5, Enabled: aliasEnabled(false)},
	}
	generation, err := store.ReplaceModelAliases(ctx, records)
	if err != nil {
		t.Fatalf("ReplaceModelAliases() error = %v", err)
	}
	if generation != 1 {
		t.Fatalf("generation = %d, want 1", generation)
	}

	got, storedGeneration, err := store.ListModelAliases(ctx)
	if err != nil {
		t.Fatalf("ListModelAliases() error = %v", err)
	}
	if storedGeneration != 1 {
		t.Fatalf("stored generation = %d, want 1", storedGeneration)
	}
	if len(got) != 2 {
		t.Fatalf("records = %d, want 2", len(got))
	}
	// 顺序必须与写入顺序一致：Node 用数组下标做同优先级 tiebreaker。
	if got[0].Alias != "fast" || got[1].Alias != "smart" {
		t.Fatalf("顺序 = %q, %q, want fast, smart", got[0].Alias, got[1].Alias)
	}
	if got[0].Priority != 10 || got[0].Description != "最快" {
		t.Fatalf("记录字段丢失: %+v", got[0])
	}
	// 显式 false 必须原样读回；缺失按启用处理。
	if got[1].IsEnabled() {
		t.Fatal("显式 disabled 被读成启用")
	}
	if !got[0].IsEnabled() {
		t.Fatal("未声明 enabled 应视为启用")
	}
}

func TestModelAliasReplaceIsWholeSetSemantics(t *testing.T) {
	store := openOAuthJobStore(t)
	ctx := context.Background()
	if _, err := store.ReplaceModelAliases(ctx, []modelalias.Record{
		{ID: "a1", Alias: "old", Target: "x"},
	}); err != nil {
		t.Fatalf("first Replace error = %v", err)
	}
	generation, err := store.ReplaceModelAliases(ctx, []modelalias.Record{
		{ID: "b1", Alias: "new", Target: "y"},
	})
	if err != nil {
		t.Fatalf("second Replace error = %v", err)
	}
	if generation != 2 {
		t.Fatalf("generation = %d, want 2（必须单调递增）", generation)
	}
	got, _, _ := store.ListModelAliases(ctx)
	if len(got) != 1 || got[0].Alias != "new" {
		t.Fatalf("替换后 = %+v, want 只剩 new", got)
	}
}

// 非法记录必须整体拒绝，不能留下半个集合。
func TestModelAliasReplaceRejectsInvalidWithoutPartialWrite(t *testing.T) {
	store := openOAuthJobStore(t)
	ctx := context.Background()
	if _, err := store.ReplaceModelAliases(ctx, []modelalias.Record{
		{ID: "a1", Alias: "keep", Target: "x"},
	}); err != nil {
		t.Fatalf("seed Replace error = %v", err)
	}
	if _, err := store.ReplaceModelAliases(ctx, []modelalias.Record{
		{ID: "b1", Alias: "ok", Target: "y"},
		{ID: "b2", Alias: "", Target: "z"},
	}); err == nil {
		t.Fatal("缺少别名的记录应被拒绝")
	}
	got, generation, _ := store.ListModelAliases(ctx)
	if generation != 1 || len(got) != 1 || got[0].Alias != "keep" {
		t.Fatalf("失败后被改写: generation=%d records=%+v", generation, got)
	}
}

func TestModelAliasListOnEmptyStore(t *testing.T) {
	store := openOAuthJobStore(t)
	records, generation, err := store.ListModelAliases(context.Background())
	if err != nil {
		t.Fatalf("ListModelAliases() error = %v", err)
	}
	if len(records) != 0 || generation != 0 {
		t.Fatalf("空表 = %d 条 / generation %d, want 0/0", len(records), generation)
	}
}

// 通配别名的展示名单必须落库：只存在内存里的话，重启后从库恢复会丢掉整份名单，
// 模型目录在 Node 再推一次之前会少一批可展示型号。
func TestModelAliasDisplayModelsRoundTrip(t *testing.T) {
	store := openOAuthJobStore(t)
	ctx := context.Background()
	display := []string{"claude-opus-5", "claude-sonnet-4-6", "claude-haiku-5-5"}
	if _, err := store.ReplaceModelAliases(ctx, []modelalias.Record{
		{ID: "a1", Alias: "claude-*", Target: "claude-sonnet-4-6", DisplayModels: display},
	}); err != nil {
		t.Fatalf("ReplaceModelAliases() error = %v", err)
	}
	records, _, err := store.ListModelAliases(ctx)
	if err != nil {
		t.Fatalf("ListModelAliases() error = %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("records = %d, want 1", len(records))
	}
	got := records[0].DisplayModels
	if len(got) != len(display) {
		t.Fatalf("displayModels = %v, want %v", got, display)
	}
	for index := range display {
		if got[index] != display[index] {
			t.Fatalf("displayModels[%d] = %q, want %q", index, got[index], display[index])
		}
	}
}

// 没有展示名单的普通别名读回来必须是 nil，而不是空切片（契约上 omitempty）。
func TestModelAliasWithoutDisplayModelsStaysNil(t *testing.T) {
	store := openOAuthJobStore(t)
	ctx := context.Background()
	if _, err := store.ReplaceModelAliases(ctx, []modelalias.Record{{ID: "a1", Alias: "a", Target: "b"}}); err != nil {
		t.Fatalf("ReplaceModelAliases() error = %v", err)
	}
	records, _, _ := store.ListModelAliases(ctx)
	if records[0].DisplayModels != nil {
		t.Fatalf("displayModels = %v, want nil", records[0].DisplayModels)
	}
}
