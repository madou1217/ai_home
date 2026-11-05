package modelalias

import (
	"context"
	"errors"
	"regexp"
	"testing"
)

func newTestService(t *testing.T, repository Repository) *Service {
	t.Helper()
	store := NewStoreWithRepository(repository)
	service, err := NewService(store, []string{"codex", "claude", "zcode"})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	return service
}

var aliasIDPattern = regexp.MustCompile("^[0-9a-f]{8}$")

func TestServiceCreateNormalizesAndPersists(t *testing.T) {
	repository := &fakeRepository{}
	service := newTestService(t, repository)
	enabled := true
	record, generation, err := service.Create(context.Background(), CreateInput{
		Alias:    " fast ",
		Target:   " glm-5.3-flash ",
		Provider: "ZCODE",
		Priority: 5,
		Enabled:  &enabled,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if !aliasIDPattern.MatchString(record.ID) {
		t.Fatalf("id = %q, want 8 位小写十六进制", record.ID)
	}
	if record.Alias != "fast" || record.Target != "glm-5.3-flash" {
		t.Fatalf("未 trim: %+v", record)
	}
	if record.Provider != "zcode" {
		t.Fatalf("provider = %q, want zcode（大小写归一）", record.Provider)
	}
	if generation != 1 || repository.saves != 1 {
		t.Fatalf("generation=%d saves=%d, want 1/1", generation, repository.saves)
	}
	if len(service.List()) != 1 {
		t.Fatalf("内存条目 = %d, want 1", len(service.List()))
	}
}

// 未知 Provider 归一到 all，与 Node 的 normalizeAliasScopeProvider 同口径。
func TestServiceCreateFallsBackToAllScope(t *testing.T) {
	service := newTestService(t, &fakeRepository{})
	record, _, err := service.Create(context.Background(), CreateInput{
		Alias: "x", Target: "y", Provider: "not-a-provider",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if record.ScopeProvider() != ScopeAll {
		t.Fatalf("scope = %q, want all", record.ScopeProvider())
	}
}

// 同作用域重名必须拒绝：重名会让「谁生效」取决于插入顺序。
func TestServiceRejectsDuplicateAliasInSameScope(t *testing.T) {
	service := newTestService(t, &fakeRepository{})
	if _, _, err := service.Create(context.Background(), CreateInput{Alias: "fast", Target: "a", Provider: "codex"}); err != nil {
		t.Fatalf("first Create() error = %v", err)
	}
	_, _, err := service.Create(context.Background(), CreateInput{Alias: "fast", Target: "b", Provider: "codex"})
	if !errors.Is(err, ErrDuplicateAlias) {
		t.Fatalf("error = %v, want ErrDuplicateAlias", err)
	}
	// 不同作用域允许同名：两个 Provider 各自有自己的 fast。
	if _, _, err := service.Create(context.Background(), CreateInput{Alias: "fast", Target: "b", Provider: "claude"}); err != nil {
		t.Fatalf("不同作用域应允许同名: %v", err)
	}
}

func TestServiceUpdatePartialAndDuplicate(t *testing.T) {
	service := newTestService(t, &fakeRepository{})
	first, _, _ := service.Create(context.Background(), CreateInput{Alias: "a", Target: "x", Provider: "codex"})
	if _, _, err := service.Create(context.Background(), CreateInput{Alias: "b", Target: "y", Provider: "codex"}); err != nil {
		t.Fatalf("seed error = %v", err)
	}

	priority := int32(9)
	updated, _, err := service.Update(context.Background(), first.ID, UpdateInput{Priority: &priority})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if updated.Priority != 9 || updated.Alias != "a" || updated.Target != "x" {
		t.Fatalf("局部更新影响到其它字段: %+v", updated)
	}

	// 改成已存在的别名要拒绝。
	conflict := "b"
	if _, _, err := service.Update(context.Background(), first.ID, UpdateInput{Alias: &conflict}); !errors.Is(err, ErrDuplicateAlias) {
		t.Fatalf("error = %v, want ErrDuplicateAlias", err)
	}
	// 改成自己原来的名字不算冲突。
	same := "a"
	if _, _, err := service.Update(context.Background(), first.ID, UpdateInput{Alias: &same}); err != nil {
		t.Fatalf("改回自身名字应允许: %v", err)
	}
}

func TestServiceUpdateAndDeleteMissing(t *testing.T) {
	service := newTestService(t, &fakeRepository{})
	if _, _, err := service.Update(context.Background(), "deadbeef", UpdateInput{}); !errors.Is(err, ErrAliasNotFound) {
		t.Fatalf("Update error = %v, want ErrAliasNotFound", err)
	}
	if _, err := service.Delete(context.Background(), "deadbeef"); !errors.Is(err, ErrAliasNotFound) {
		t.Fatalf("Delete error = %v, want ErrAliasNotFound", err)
	}
}

func TestServiceDeleteAndToggle(t *testing.T) {
	service := newTestService(t, &fakeRepository{})
	record, _, _ := service.Create(context.Background(), CreateInput{Alias: "a", Target: "x"})
	toggled, _, err := service.SetEnabled(context.Background(), record.ID, false)
	if err != nil {
		t.Fatalf("SetEnabled() error = %v", err)
	}
	if toggled.ID != record.ID || toggled.IsEnabled() {
		t.Fatalf("toggle 返回的记录不对: %+v", toggled)
	}
	if service.List()[0].IsEnabled() {
		t.Fatal("停用没有生效")
	}
	generation, err := service.Delete(context.Background(), record.ID)
	if err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if len(service.List()) != 0 {
		t.Fatalf("删除后仍有 %d 条", len(service.List()))
	}
	if generation != 3 {
		t.Fatalf("generation = %d, want 3（新建/停用/删除各一次）", generation)
	}
}

// 写库失败时读投影不能前进：与 Store 的约定一致。
func TestServiceCreateDoesNotPublishWhenSaveFails(t *testing.T) {
	service := newTestService(t, &fakeRepository{saveErr: errors.New("db locked")})
	if _, _, err := service.Create(context.Background(), CreateInput{Alias: "a", Target: "x"}); err == nil {
		t.Fatal("期望落库失败被返回")
	}
	if len(service.List()) != 0 {
		t.Fatalf("失败后内存被改写: %d 条", len(service.List()))
	}
}

// 返回值必须是「读回来的样子」：Store 会补 provider/targetProvider 默认值，
// 返回入参会让前端刚创建就看到空字段（真机上就出现过 targetProvider=""）。
func TestServiceCreateReturnsNormalizedRecord(t *testing.T) {
	service := newTestService(t, &fakeRepository{})
	record, _, err := service.Create(context.Background(), CreateInput{Alias: "a", Target: "x"})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if record.Provider != ScopeAll {
		t.Fatalf("provider = %q, want all", record.Provider)
	}
	if record.TargetProvider != TargetProviderAuto {
		t.Fatalf("targetProvider = %q, want auto", record.TargetProvider)
	}
	if record.Enabled == nil || !*record.Enabled {
		t.Fatalf("enabled = %v, want 显式 true", record.Enabled)
	}
}

func TestServiceUpdateReturnsNormalizedRecord(t *testing.T) {
	service := newTestService(t, &fakeRepository{})
	record, _, _ := service.Create(context.Background(), CreateInput{Alias: "a", Target: "x"})
	empty := ""
	updated, _, err := service.Update(context.Background(), record.ID, UpdateInput{TargetProvider: &empty})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if updated.TargetProvider != TargetProviderAuto {
		t.Fatalf("targetProvider = %q, want auto（空值应归一到 auto）", updated.TargetProvider)
	}
}

// 组替换：删掉 replaceIds、追加新记录，新记录必须拿到新 id 并补默认值。
func TestServiceReplaceGroupDropsAndAppends(t *testing.T) {
	service := newTestService(t, &fakeRepository{})
	first, _, _ := service.Create(context.Background(), CreateInput{Alias: "old", Target: "x", Provider: "codex"})
	created, generation, _, err := service.ReplaceGroup(context.Background(), ReplaceGroupInput{
		ReplaceIDs: []string{first.ID},
		Records:    []CreateInput{{Alias: "new", Target: "y", Provider: "codex"}},
	})
	if err != nil {
		t.Fatalf("ReplaceGroup() error = %v", err)
	}
	if len(created) != 1 || created[0].Alias != "new" {
		t.Fatalf("created = %+v", created)
	}
	if created[0].ID == first.ID || created[0].ID == "" {
		t.Fatalf("新记录必须拿新 id，got %q", created[0].ID)
	}
	if created[0].TargetProvider != TargetProviderAuto || created[0].Enabled == nil {
		t.Fatalf("新记录没有补默认值: %+v", created[0])
	}
	if generation != 2 {
		t.Fatalf("generation = %d, want 2", generation)
	}
	remaining := service.List()
	if len(remaining) != 1 || remaining[0].Alias != "new" {
		t.Fatalf("替换后 = %+v", remaining)
	}
}

// records 为空即删除整组（WebUI 删除聚合行时就是这个语义）。
func TestServiceReplaceGroupWithNoRecordsDeletes(t *testing.T) {
	service := newTestService(t, &fakeRepository{})
	first, _, _ := service.Create(context.Background(), CreateInput{Alias: "a", Target: "x"})
	if _, _, _, err := service.ReplaceGroup(context.Background(), ReplaceGroupInput{
		ReplaceIDs: []string{first.ID},
	}); err != nil {
		t.Fatalf("ReplaceGroup() error = %v", err)
	}
	if len(service.List()) != 0 {
		t.Fatalf("仍有 %d 条", len(service.List()))
	}
}

// 新建记录与「保留下来的记录」重名要整体拒绝：逐条校验看不出跨组的冲突。
func TestServiceReplaceGroupRejectsDuplicateAcrossGroups(t *testing.T) {
	service := newTestService(t, &fakeRepository{})
	keep, _, _ := service.Create(context.Background(), CreateInput{Alias: "dup", Target: "x", Provider: "codex"})
	drop, _, _ := service.Create(context.Background(), CreateInput{Alias: "other", Target: "y", Provider: "codex"})
	_, _, _, err := service.ReplaceGroup(context.Background(), ReplaceGroupInput{
		ReplaceIDs: []string{drop.ID},
		Records:    []CreateInput{{Alias: "dup", Target: "z", Provider: "codex"}},
	})
	if !errors.Is(err, ErrDuplicateAlias) {
		t.Fatalf("error = %v, want ErrDuplicateAlias", err)
	}
	// 失败后集合必须原样：keep 还在，drop 没被删。
	if len(service.List()) != 2 {
		t.Fatalf("失败后被改写: %+v", service.List())
	}
	_ = keep
}

func TestValidateAliasPattern(t *testing.T) {
	cases := []struct {
		alias string
		want  error
	}{
		{"fast", nil},
		{"", ErrInvalidAlias},
		{"   ", ErrInvalidAlias},
		{"claude-*", nil},
		{"a*", ErrInvalidAliasWildcard},   // 前缀太短
		{"*", ErrInvalidAliasWildcard},    // 只有 *
		{"a*b", ErrInvalidAliasWildcard},  // * 不在末尾
		{"a*b*", ErrInvalidAliasWildcard}, // 多个 *
		{"gpt-5.1-coding-*", nil},
	}
	for _, testCase := range cases {
		err := ValidateAliasPattern(testCase.alias)
		if !errors.Is(err, testCase.want) && err != testCase.want {
			t.Fatalf("ValidateAliasPattern(%q) = %v, want %v", testCase.alias, err, testCase.want)
		}
	}
}

func TestServiceCreateRejectsBadWildcard(t *testing.T) {
	service := newTestService(t, &fakeRepository{})
	if _, _, err := service.Create(context.Background(), CreateInput{Alias: "a*b", Target: "x"}); !errors.Is(err, ErrInvalidAliasWildcard) {
		t.Fatalf("error = %v, want ErrInvalidAliasWildcard", err)
	}
	if len(service.List()) != 0 {
		t.Fatal("非法别名被写入")
	}
}

func TestServiceReplaceGroupRejectsBadWildcard(t *testing.T) {
	service := newTestService(t, &fakeRepository{})
	if _, _, _, err := service.ReplaceGroup(context.Background(), ReplaceGroupInput{
		Records: []CreateInput{{Alias: "x*", Target: "y"}},
	}); !errors.Is(err, ErrInvalidAliasWildcard) {
		t.Fatalf("error = %v, want ErrInvalidAliasWildcard", err)
	}
}
