package upstreammapping

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	mappingcore "github.com/madou1217/ai_home/core/upstreammapping"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

// fakeRepository 是内存版持久化端口，用版本 CAS 模拟真实存储的并发语义。
type fakeRepository struct {
	mutex       sync.Mutex
	groups      map[string]mappingcore.Group
	order       []string
	createCalls int
	updateCalls int
	deleteCalls int
	failWith    error
}

func newFakeRepository() *fakeRepository {
	return &fakeRepository{groups: map[string]mappingcore.Group{}}
}

func (repository *fakeRepository) List(context.Context) ([]mappingcore.Group, error) {
	repository.mutex.Lock()
	defer repository.mutex.Unlock()
	if repository.failWith != nil {
		return nil, repository.failWith
	}
	groups := make([]mappingcore.Group, 0, len(repository.order))
	for _, id := range repository.order {
		groups = append(groups, repository.groups[id])
	}
	return groups, nil
}

func (repository *fakeRepository) Get(_ context.Context, id string) (mappingcore.Group, error) {
	repository.mutex.Lock()
	defer repository.mutex.Unlock()
	if repository.failWith != nil {
		return mappingcore.Group{}, repository.failWith
	}
	group, ok := repository.groups[id]
	if !ok {
		return mappingcore.Group{}, mappingcore.ErrGroupNotFound
	}
	return group, nil
}

func (repository *fakeRepository) Create(_ context.Context, group mappingcore.Group) (mappingcore.Group, error) {
	repository.mutex.Lock()
	defer repository.mutex.Unlock()
	if repository.failWith != nil {
		return mappingcore.Group{}, repository.failWith
	}
	if _, exists := repository.groups[group.ID()]; exists {
		return mappingcore.Group{}, mappingcore.ErrGroupExists
	}
	repository.createCalls++
	now := time.Now().UTC()
	stored, err := mappingcore.RestoreGroup(mappingcore.Input{
		ID:          group.ID(),
		Name:        group.Name(),
		Description: group.Description(),
		Provider:    group.Provider(),
		Enabled:     boolPointer(group.Enabled()),
		Entries:     group.Entries(),
		Position:    len(repository.order),
		Version:     1,
		CreatedAt:   now,
		UpdatedAt:   now,
	})
	if err != nil {
		return mappingcore.Group{}, err
	}
	repository.groups[stored.ID()] = stored
	repository.order = append(repository.order, stored.ID())
	return stored, nil
}

func (repository *fakeRepository) Update(
	_ context.Context,
	group mappingcore.Group,
	expectedVersion int64,
) (mappingcore.Group, error) {
	repository.mutex.Lock()
	defer repository.mutex.Unlock()
	if repository.failWith != nil {
		return mappingcore.Group{}, repository.failWith
	}
	current, ok := repository.groups[group.ID()]
	if !ok {
		return mappingcore.Group{}, mappingcore.ErrGroupNotFound
	}
	if current.Version() != expectedVersion {
		return mappingcore.Group{}, mappingcore.ErrGroupConflict
	}
	repository.updateCalls++
	stored, err := mappingcore.RestoreGroup(mappingcore.Input{
		ID:          group.ID(),
		Name:        group.Name(),
		Description: group.Description(),
		Provider:    group.Provider(),
		Enabled:     boolPointer(group.Enabled()),
		Entries:     group.Entries(),
		Position:    current.Position(),
		Version:     current.Version() + 1,
		CreatedAt:   current.CreatedAt(),
		UpdatedAt:   time.Now().UTC(),
	})
	if err != nil {
		return mappingcore.Group{}, err
	}
	repository.groups[stored.ID()] = stored
	return stored, nil
}

func (repository *fakeRepository) Delete(_ context.Context, id string, expectedVersion *int64) error {
	repository.mutex.Lock()
	defer repository.mutex.Unlock()
	if repository.failWith != nil {
		return repository.failWith
	}
	current, ok := repository.groups[id]
	if !ok {
		return mappingcore.ErrGroupNotFound
	}
	if expectedVersion != nil && *expectedVersion != current.Version() {
		return mappingcore.ErrGroupConflict
	}
	repository.deleteCalls++
	delete(repository.groups, id)
	remaining := repository.order[:0]
	for _, existing := range repository.order {
		if existing != id {
			remaining = append(remaining, existing)
		}
	}
	repository.order = remaining
	return nil
}

func boolPointer(value bool) *bool { return &value }

func testRule(t *testing.T) rulescore.Rule {
	t.Helper()
	var rule rulescore.Rule
	raw := `{"kind":"rate_limited","statuses":[429],"matchers":[{"source":"body","operator":"contains","value":"rate limit"}]}`
	if err := json.Unmarshal([]byte(raw), &rule); err != nil {
		t.Fatalf("解析规则失败: %v", err)
	}
	compiled, err := rulescore.NewRule(rule.Name(), rule.Kind(), rule.Enabled(), rule.Statuses(), rule.Matchers())
	if err != nil {
		t.Fatalf("编译规则失败: %v", err)
	}
	return compiled
}

func newService(t *testing.T) (*Service, *fakeRepository) {
	t.Helper()
	repository := newFakeRepository()
	service, err := NewService(repository, []string{"CodeX", "claude"})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	return service, repository
}

func TestServiceCreateNormalizesProviderAndPersists(t *testing.T) {
	service, _ := newService(t)
	group, err := service.Create(context.Background(), CreateInput{
		Name:     "额度",
		Provider: "CODEX",
		Rules:    []rulescore.Rule{testRule(t)},
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if group.Provider() != "codex" || group.Version() != 1 || group.Position() != 0 {
		t.Fatalf("group = %+v", group)
	}
	if group.ID() == "" || group.CreatedAt().IsZero() {
		t.Fatalf("存储层未补齐元数据: %+v", group)
	}
}

func TestServiceCreateRejectsUnknownProvider(t *testing.T) {
	service, repository := newService(t)
	_, err := service.Create(context.Background(), CreateInput{
		Name:     "未知",
		Provider: "not-registered",
		Rules:    []rulescore.Rule{testRule(t)},
	})
	if !errors.Is(err, mappingcore.ErrUnknownProvider) {
		t.Fatalf("Create() error = %v, want ErrUnknownProvider", err)
	}
	if repository.createCalls != 0 {
		t.Fatal("非法 Provider 不应触达存储")
	}
}

func TestServiceCreateIsIdempotentByID(t *testing.T) {
	service, repository := newService(t)
	input := CreateInput{
		ID:       "uem_abcdef012345",
		Name:     "幂等",
		Provider: "all",
		Rules:    []rulescore.Rule{testRule(t)},
	}
	first, err := service.Create(context.Background(), input)
	if err != nil {
		t.Fatalf("首次 Create() error = %v", err)
	}
	second, err := service.Create(context.Background(), input)
	if err != nil {
		t.Fatalf("重试 Create() error = %v", err)
	}
	if repository.createCalls != 1 || second.Version() != first.Version() {
		t.Fatalf("幂等重试仍写库: calls=%d version=%d", repository.createCalls, second.Version())
	}
	input.Name = "改了名字"
	if _, err := service.Create(context.Background(), input); !errors.Is(err, mappingcore.ErrGroupExists) {
		t.Fatalf("同 id 不同内容 error = %v, want ErrGroupExists", err)
	}
}

func TestServiceUpdateKeepsOmittedFields(t *testing.T) {
	service, _ := newService(t)
	created, err := service.Create(context.Background(), CreateInput{
		Name:     "旧名字",
		Provider: "all",
		Enabled:  boolPointer(false),
		Rules:    []rulescore.Rule{testRule(t)},
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	name := "新名字"
	updated, err := service.Update(context.Background(), created.ID(), UpdateInput{Name: &name})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if updated.Name() != name || updated.Enabled() {
		t.Fatalf("更新后 name/enabled = %q/%v", updated.Name(), updated.Enabled())
	}
	if updated.Provider() != "all" || len(updated.Rules()) != 1 {
		t.Fatalf("未提供字段被重置: provider=%q rules=%d", updated.Provider(), len(updated.Rules()))
	}
	if updated.Version() != created.Version()+1 {
		t.Fatalf("version = %d, want %d", updated.Version(), created.Version()+1)
	}
}

func TestServiceUpdateRejectsStaleVersion(t *testing.T) {
	service, _ := newService(t)
	created, err := service.Create(context.Background(), CreateInput{
		Name: "并发", Rules: []rulescore.Rule{testRule(t)},
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	stale := created.Version() + 10
	_, err = service.Update(context.Background(), created.ID(), UpdateInput{Version: &stale})
	if !errors.Is(err, mappingcore.ErrGroupConflict) {
		t.Fatalf("Update() error = %v, want ErrGroupConflict", err)
	}
}

func TestServiceUpdateRejectsUnknownGroup(t *testing.T) {
	service, _ := newService(t)
	_, err := service.Update(context.Background(), "uem_ffffffffffff", UpdateInput{})
	if !errors.Is(err, mappingcore.ErrGroupNotFound) {
		t.Fatalf("Update() error = %v, want ErrGroupNotFound", err)
	}
}

func TestServiceDeleteUsesVersion(t *testing.T) {
	service, _ := newService(t)
	created, err := service.Create(context.Background(), CreateInput{
		Name: "删除", Rules: []rulescore.Rule{testRule(t)},
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	stale := created.Version() + 1
	if err := service.Delete(context.Background(), created.ID(), &stale); !errors.Is(err, mappingcore.ErrGroupConflict) {
		t.Fatalf("Delete(stale) error = %v, want ErrGroupConflict", err)
	}
	version := created.Version()
	if err := service.Delete(context.Background(), created.ID(), &version); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if err := service.Delete(context.Background(), created.ID(), nil); !errors.Is(err, mappingcore.ErrGroupNotFound) {
		t.Fatalf("重复 Delete() error = %v, want ErrGroupNotFound", err)
	}
}
