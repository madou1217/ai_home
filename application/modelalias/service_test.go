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
	if _, err := service.SetEnabled(context.Background(), record.ID, false); err != nil {
		t.Fatalf("SetEnabled() error = %v", err)
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
