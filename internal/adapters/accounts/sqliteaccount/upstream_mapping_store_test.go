package sqliteaccount

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	mappingapp "github.com/madou1217/ai_home/application/upstreammapping"
	mappingcore "github.com/madou1217/ai_home/core/upstreammapping"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

// newMappingService 用真实 SQLite 仓储组装映射组用例。
func newMappingService(t *testing.T, store *Store) *mappingapp.Service {
	t.Helper()
	service, err := mappingapp.NewService(
		NewUpstreamErrorMappingRepository(store),
		[]string{"codex", "claude"},
	)
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	return service
}

// mappingTestRule 构造一条合法规则；正则编译留给写入口。
func mappingTestRule(t *testing.T) rulescore.Rule {
	t.Helper()
	raw := `{"kind":"rate_limited","statuses":[429],"matchers":[{"source":"body","operator":"contains","value":"rate limit"}]}`
	var rule rulescore.Rule
	if err := json.Unmarshal([]byte(raw), &rule); err != nil {
		t.Fatalf("解析规则失败: %v", err)
	}
	compiled, err := rulescore.NewRule(rule.Name(), rule.Kind(), rule.Enabled(), rule.Statuses(), rule.Matchers())
	if err != nil {
		t.Fatalf("编译规则失败: %v", err)
	}
	return compiled
}

func createMappingGroup(t *testing.T, service *mappingapp.Service, name string) mappingcore.Group {
	t.Helper()
	group, err := service.Create(context.Background(), mappingapp.CreateInput{
		Name:     name,
		Provider: "codex",
		Rules:    []rulescore.Rule{mappingTestRule(t)},
	})
	if err != nil {
		t.Fatalf("Create(%q) error = %v", name, err)
	}
	return group
}

func TestUpstreamErrorMappingGroupCRUD(t *testing.T) {
	ctx := context.Background()
	store := openOAuthJobStore(t)
	service := newMappingService(t, store)

	first := createMappingGroup(t, service, "第一组")
	if first.Position() != 0 || first.Version() != 1 || first.Provider() != "codex" {
		t.Fatalf("首个组元数据 = position=%d version=%d provider=%q", first.Position(), first.Version(), first.Provider())
	}
	second := createMappingGroup(t, service, "第二组")
	if second.Position() != 1 {
		t.Fatalf("第二个组 position = %d, want 1", second.Position())
	}

	groups, err := service.List(ctx)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(groups) != 2 || groups[0].ID() != first.ID() || groups[1].ID() != second.ID() {
		t.Fatalf("List() = %+v", groups)
	}

	name := "第一组（改）"
	description := "描述"
	updated, err := service.Update(ctx, first.ID(), mappingapp.UpdateInput{
		Name:        &name,
		Description: &description,
		Version:     int64Pointer(first.Version()),
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if updated.Name() != name || updated.Description() != description || updated.Version() != 2 {
		t.Fatalf("更新结果 = name=%q description=%q version=%d", updated.Name(), updated.Description(), updated.Version())
	}
	if !updated.CreatedAt().Equal(first.CreatedAt()) {
		t.Fatalf("updatedAt 覆盖了 createdAt: %s vs %s", updated.CreatedAt(), first.CreatedAt())
	}
	if len(updated.Rules()) != 1 {
		t.Fatalf("规则数 = %d, want 1", len(updated.Rules()))
	}

	if err := service.Delete(ctx, second.ID(), nil); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	groups, err = service.List(ctx)
	if err != nil {
		t.Fatalf("List() after delete error = %v", err)
	}
	if len(groups) != 1 || groups[0].ID() != first.ID() {
		t.Fatalf("删除后 = %+v", groups)
	}
	if _, err := service.Get(ctx, second.ID()); !errors.Is(err, mappingcore.ErrGroupNotFound) {
		t.Fatalf("Get(deleted) error = %v, want ErrGroupNotFound", err)
	}
}

// 重启后必须还能读到组与规则：映射组是 Go 自己的持久化事实，不靠 Node 再推。
func TestUpstreamErrorMappingGroupSurvivesReopen(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store := openOAuthJobStoreAt(t, dir)
	service := newMappingService(t, store)
	created := createMappingGroup(t, service, "持久化")
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	reopened := openOAuthJobStoreAt(t, dir)
	reopenedService := newMappingService(t, reopened)
	group, err := reopenedService.Get(ctx, created.ID())
	if err != nil {
		t.Fatalf("重新打开后 Get() error = %v", err)
	}
	if group.Name() != "持久化" || group.Version() != created.Version() {
		t.Fatalf("重新打开后 group = %+v", group)
	}
	if len(group.Rules()) != 1 || group.Rules()[0].Kind() != rulescore.KindRateLimited {
		t.Fatalf("重新打开后规则 = %+v", group.Rules())
	}
}

func TestUpstreamErrorMappingGroupVersionConflict(t *testing.T) {
	ctx := context.Background()
	store := openOAuthJobStore(t)
	service := newMappingService(t, store)
	created := createMappingGroup(t, service, "并发")

	stale := created.Version()
	name := "第一次修改"
	if _, err := service.Update(ctx, created.ID(), mappingapp.UpdateInput{
		Name:    &name,
		Version: &stale,
	}); err != nil {
		t.Fatalf("第一次 Update() error = %v", err)
	}
	// 用同一个版本再提交：必须拒绝，而不是覆盖第一次修改。
	second := "第二次修改"
	_, err := service.Update(ctx, created.ID(), mappingapp.UpdateInput{
		Name:    &second,
		Version: &stale,
	})
	if !errors.Is(err, mappingcore.ErrGroupConflict) {
		t.Fatalf("过期版本 Update() error = %v, want ErrGroupConflict", err)
	}
}

// 两个写者拿着同一个版本并发更新，只能有一个成功；另一个必须是 409，
// 不能因为 SQLite 忙就变成 500。
func TestUpstreamErrorMappingGroupConcurrentUpdate(t *testing.T) {
	ctx := context.Background()
	store := openOAuthJobStore(t)
	service := newMappingService(t, store)
	created := createMappingGroup(t, service, "并发")

	version := created.Version()
	var waitGroup sync.WaitGroup
	results := make(chan error, 2)
	for index := range 2 {
		waitGroup.Add(1)
		go func(index int) {
			defer waitGroup.Done()
			name := "写者"
			if index == 1 {
				name = "写者二"
			}
			_, err := service.Update(ctx, created.ID(), mappingapp.UpdateInput{
				Name:    &name,
				Version: &version,
			})
			results <- err
		}(index)
	}
	waitGroup.Wait()
	close(results)

	successes, conflicts := 0, 0
	for err := range results {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, mappingcore.ErrGroupConflict):
			conflicts++
		default:
			t.Fatalf("并发 Update() error = %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("并发结果 = %d 成功 / %d 冲突, want 1/1", successes, conflicts)
	}
}

// 删除组必须级联删除条目；否则残留规则会让下次同 id 创建读到脏数据。
func TestUpstreamErrorMappingGroupDeleteCascadesRules(t *testing.T) {
	ctx := context.Background()
	store := openOAuthJobStore(t)
	service := newMappingService(t, store)
	created := createMappingGroup(t, service, "级联删除")
	if err := service.Delete(ctx, created.ID(), nil); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	var rules int
	if err := store.db.QueryRowContext(
		ctx,
		"SELECT COUNT(*) FROM upstream_error_mapping_rule WHERE group_id = ?",
		created.ID(),
	).Scan(&rules); err != nil {
		t.Fatalf("统计规则失败: %v", err)
	}
	if rules != 0 {
		t.Fatalf("残留规则 = %d, want 0", rules)
	}
}

// 库里的规则顺序必须从 0 连续；出现空洞说明被外部工具改过，读取要报结构不兼容，
// 不能猜一个顺序继续匹配。
func TestUpstreamErrorMappingRuleOrderIsValidatedOnLoad(t *testing.T) {
	ctx := context.Background()
	store := openOAuthJobStore(t)
	now := time.Now().UTC().UnixMilli()
	const groupID = "uem_000000000001"
	if _, err := store.db.ExecContext(
		ctx,
		`INSERT INTO upstream_error_mapping_group (
			id, name, description, provider, enabled, position, version,
			created_at_ms, updated_at_ms
		) VALUES (?, '坏数据', '', 'all', 1, 0, 1, ?, ?)`,
		groupID,
		now,
		now,
	); err != nil {
		t.Fatalf("插入组失败: %v", err)
	}
	encoded, err := json.Marshal(mappingTestRule(t))
	if err != nil {
		t.Fatalf("序列化规则失败: %v", err)
	}
	for _, position := range []int{0, 2} {
		if _, err := store.db.ExecContext(
			ctx,
			"INSERT INTO upstream_error_mapping_rule (group_id, position, rule_json) VALUES (?, ?, ?)",
			groupID,
			position,
			string(encoded),
		); err != nil {
			t.Fatalf("插入规则失败: %v", err)
		}
	}
	repository := NewUpstreamErrorMappingRepository(store)
	if _, err := repository.List(ctx); !errors.Is(err, ErrIncompatibleDatabase) {
		t.Fatalf("List() error = %v, want ErrIncompatibleDatabase", err)
	}
}

func TestUpstreamErrorMappingGroupLimit(t *testing.T) {
	ctx := context.Background()
	store := openOAuthJobStore(t)
	service := newMappingService(t, store)
	now := time.Now().UTC().UnixMilli()
	for index := range mappingcore.MaxGroups {
		if _, err := store.db.ExecContext(
			ctx,
			`INSERT INTO upstream_error_mapping_group (
				id, name, description, provider, enabled, position, version,
				created_at_ms, updated_at_ms
			) VALUES (?, ?, '', 'all', 1, ?, 1, ?, ?)`,
			fmt.Sprintf("uem_fill_%06d", index),
			"填充",
			index,
			now,
			now,
		); err != nil {
			t.Fatalf("插入第 %d 个组失败: %v", index, err)
		}
	}
	_, err := service.Create(ctx, mappingapp.CreateInput{
		Name:  "溢出",
		Rules: []rulescore.Rule{mappingTestRule(t)},
	})
	if !errors.Is(err, mappingcore.ErrGroupLimit) {
		t.Fatalf("Create() error = %v, want ErrGroupLimit", err)
	}
}

func int64Pointer(value int64) *int64 { return &value }
