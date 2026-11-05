package modelalias

import (
	"context"
	"errors"
	"testing"
)

type fakeRepository struct {
	records    []Record
	generation int64
	saves      int
	loads      int
	saveErr    error
	loadErr    error
}

func (fake *fakeRepository) Load(context.Context) ([]Record, int64, error) {
	fake.loads++
	if fake.loadErr != nil {
		return nil, 0, fake.loadErr
	}
	return append([]Record(nil), fake.records...), fake.generation, nil
}

func (fake *fakeRepository) Save(_ context.Context, records []Record) (int64, error) {
	fake.saves++
	if fake.saveErr != nil {
		return 0, fake.saveErr
	}
	fake.records = append([]Record(nil), records...)
	fake.generation++
	return fake.generation, nil
}

// 有仓储时：先落库，代次用仓储返回的值（重启后不会从头计数）。
func TestStoreReplacePersistsAndUsesRepositoryGeneration(t *testing.T) {
	repository := &fakeRepository{generation: 7}
	store := NewStoreWithRepository(repository)
	generation, err := store.Replace([]Record{{Alias: "fast", Target: "glm-5.3-flash"}})
	if err != nil {
		t.Fatalf("Replace() error = %v", err)
	}
	if generation != 8 {
		t.Fatalf("generation = %d, want 8（仓储 7 + 1）", generation)
	}
	if repository.saves != 1 {
		t.Fatalf("saves = %d, want 1", repository.saves)
	}
	if store.Generation() != 8 {
		t.Fatalf("memory generation = %d, want 8", store.Generation())
	}
	if store.Snapshot().Len() != 1 {
		t.Fatalf("memory records = %d, want 1", store.Snapshot().Len())
	}
}

// 落库失败时内存不能前进：否则重启后会回到旧集合，表现为「刚改的别名丢了」。
func TestStoreReplaceKeepsMemoryWhenRepositoryFails(t *testing.T) {
	repository := &fakeRepository{saveErr: errors.New("db locked")}
	store := NewStoreWithRepository(repository)
	if _, err := store.Replace([]Record{{Alias: "a", Target: "b"}}); err == nil {
		t.Fatal("期望落库失败被返回")
	}
	if store.Generation() != 0 || store.Snapshot().Len() != 0 {
		t.Fatalf("失败后内存被改写: generation=%d records=%d", store.Generation(), store.Snapshot().Len())
	}
}

// Restore 只读仓储，不回写；代次沿用仓储的值。
func TestStoreRestoreLoadsWithoutSaving(t *testing.T) {
	repository := &fakeRepository{
		generation: 12,
		records:    []Record{{Alias: "smart", Target: "claude-opus-4-6"}},
	}
	store := NewStoreWithRepository(repository)
	if err := store.Restore(context.Background()); err != nil {
		t.Fatalf("Restore() error = %v", err)
	}
	if repository.saves != 0 {
		t.Fatalf("Restore 不应写库，saves = %d", repository.saves)
	}
	if store.Generation() != 12 || store.Snapshot().Len() != 1 {
		t.Fatalf("Restore 后 = generation %d / %d 条", store.Generation(), store.Snapshot().Len())
	}
	if store.Snapshot().Records()[0].Provider != ScopeAll {
		t.Fatalf("恢复时未规整 Provider: %q", store.Snapshot().Records()[0].Provider)
	}
}

func TestStoreRestoreFailsSoftOnBrokenData(t *testing.T) {
	repository := &fakeRepository{records: []Record{{Alias: "", Target: ""}}, generation: 3}
	store := NewStoreWithRepository(repository)
	if err := store.Restore(context.Background()); err != nil {
		t.Fatalf("Restore() error = %v", err)
	}
	if store.Snapshot().Len() != 0 {
		t.Fatalf("坏行应被跳过，实际 %d 条", store.Snapshot().Len())
	}
}

// 没有仓储时保持旧语义：内存自增代次。
func TestStoreWithoutRepositoryKeepsLegacyGeneration(t *testing.T) {
	store := NewStore()
	first, _ := store.Replace([]Record{{Alias: "a", Target: "b"}})
	second, _ := store.Replace([]Record{{Alias: "a", Target: "c"}})
	if first != 1 || second != 2 {
		t.Fatalf("generation = %d, %d, want 1, 2", first, second)
	}
}
