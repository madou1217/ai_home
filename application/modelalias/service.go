package modelalias

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
)

var (
	// ErrAliasNotFound 表示按 id 找不到别名。
	ErrAliasNotFound = errors.New("模型别名不存在")
	// ErrDuplicateAlias 表示同一作用域下已存在同名别名。
	//
	// 为什么拒绝而不是覆盖：别名解析按 (alias, provider) 选候选，重名会让
	// 「谁生效」取决于插入顺序，用户根本看不出为什么改了没反应。
	ErrDuplicateAlias = errors.New("模型别名已存在")
)

// Service 是别名的写用例：读当前集合 → 改一条 → 整体替换。
//
// 为什么每次整体替换而不是逐行 UPDATE：集合顺序参与解析（同优先级按 position 取第一个），
// 逐行改动让顺序变得不可预测；整体替换复用同一套校验与代次推进，语义只有一种。
type Service struct {
	store     *Store
	providers map[string]struct{}
}

// NewService 创建别名写服务。providerIDs 用于把未知作用域 Provider 归一到 all，
// 与 Node 的 normalizeAliasScopeProvider 同口径；空集合时只有 all 合法。
func NewService(store *Store, providerIDs []string) (*Service, error) {
	if store == nil {
		return nil, ErrInvalidProjection
	}
	providers := make(map[string]struct{}, len(providerIDs)+1)
	providers[ScopeAll] = struct{}{}
	for _, id := range providerIDs {
		if normalized := strings.ToLower(strings.TrimSpace(id)); normalized != "" {
			providers[normalized] = struct{}{}
		}
	}
	return &Service{store: store, providers: providers}, nil
}

// CreateInput 是新建别名的输入。
type CreateInput struct {
	Alias          string
	Target         string
	Provider       string
	TargetProvider string
	Priority       int32
	Enabled        *bool
	Description    string
}

// UpdateInput 是更新别名的输入；nil 字段表示保持不变。
type UpdateInput struct {
	Alias          *string
	Target         *string
	Provider       *string
	TargetProvider *string
	Priority       *int32
	Enabled        *bool
	Description    *string
}

// List 返回当前全部别名。
func (service *Service) List() []Record {
	if service == nil || service.store == nil {
		return nil
	}
	return service.store.Snapshot().Records()
}

// Create 追加一条别名并返回新记录与新代次。
func (service *Service) Create(ctx context.Context, input CreateInput) (Record, int64, error) {
	if service == nil || service.store == nil {
		return Record{}, 0, ErrInvalidProjection
	}
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	record := Record{
		ID:             generateAliasID(),
		Alias:          strings.TrimSpace(input.Alias),
		Target:         strings.TrimSpace(input.Target),
		Provider:       service.normalizeScope(input.Provider),
		TargetProvider: strings.TrimSpace(input.TargetProvider),
		Priority:       input.Priority,
		// enabled 显式落成布尔：Node 的契约里它是 true/false，存成 null 会让
		// 前端拿到第三种状态（"未设置"），而语义上「未设置」就是启用。
		Enabled:     &enabled,
		Description: strings.TrimSpace(input.Description),
	}
	if !record.IsValid() {
		return Record{}, 0, ErrInvalidAlias
	}
	records := service.List()
	if err := service.assertUnique(records, record.Alias, record.ScopeProvider(), ""); err != nil {
		return Record{}, 0, err
	}
	generation, err := service.store.Replace(append(records, record))
	if err != nil {
		return Record{}, 0, err
	}
	// 返回「存进去之后读回来的样子」：Store 会补全 provider/targetProvider 的默认值，
	// 直接返回入参会和随后的列表接口对不上（前端刚创建就看到空字段）。
	return service.lastRecord(), generation, nil
}

// lastRecord 返回当前集合的最后一条；Create 刚追加的就是它。
func (service *Service) lastRecord() Record {
	records := service.store.Snapshot().Records()
	if len(records) == 0 {
		return Record{}
	}
	return records[len(records)-1]
}

// Update 修改一条别名；找不到时报 ErrAliasNotFound。
func (service *Service) Update(ctx context.Context, id string, input UpdateInput) (Record, int64, error) {
	if service == nil || service.store == nil {
		return Record{}, 0, ErrInvalidProjection
	}
	records := service.List()
	index := indexOf(records, id)
	if index < 0 {
		return Record{}, 0, ErrAliasNotFound
	}
	updated := records[index]
	if input.Alias != nil {
		updated.Alias = strings.TrimSpace(*input.Alias)
	}
	if input.Target != nil {
		updated.Target = strings.TrimSpace(*input.Target)
	}
	if input.Provider != nil {
		updated.Provider = service.normalizeScope(*input.Provider)
	}
	if input.TargetProvider != nil {
		updated.TargetProvider = strings.TrimSpace(*input.TargetProvider)
	}
	if input.Priority != nil {
		updated.Priority = *input.Priority
	}
	if input.Enabled != nil {
		updated.Enabled = input.Enabled
	}
	if input.Description != nil {
		updated.Description = strings.TrimSpace(*input.Description)
	}
	if !updated.IsValid() {
		return Record{}, 0, ErrInvalidAlias
	}
	if err := service.assertUnique(records, updated.Alias, updated.ScopeProvider(), id); err != nil {
		return Record{}, 0, err
	}
	records[index] = updated
	generation, err := service.store.Replace(records)
	if err != nil {
		return Record{}, 0, err
	}
	return service.recordAt(index), generation, nil
}

// recordAt 返回替换后同一位置上的记录（Store 可能补全默认值）。
func (service *Service) recordAt(index int) Record {
	records := service.store.Snapshot().Records()
	if index < 0 || index >= len(records) {
		return Record{}
	}
	return records[index]
}

// Delete 删除一条别名。
func (service *Service) Delete(ctx context.Context, id string) (int64, error) {
	if service == nil || service.store == nil {
		return 0, ErrInvalidProjection
	}
	records := service.List()
	index := indexOf(records, id)
	if index < 0 {
		return 0, ErrAliasNotFound
	}
	remaining := append(append([]Record(nil), records[:index]...), records[index+1:]...)
	return service.store.Replace(remaining)
}

// SetEnabled 只切换启停，保留其余字段。
func (service *Service) SetEnabled(ctx context.Context, id string, enabled bool) (int64, error) {
	_, generation, err := service.Update(ctx, id, UpdateInput{Enabled: &enabled})
	return generation, err
}

// normalizeScope 把未知 Provider 归一到 all（与 Node 同口径）。
func (service *Service) normalizeScope(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return ScopeAll
	}
	if _, known := service.providers[normalized]; !known {
		return ScopeAll
	}
	return normalized
}

// assertUnique 检查同一作用域下是否已有同名别名；skipID 用于更新时跳过自身。
func (service *Service) assertUnique(records []Record, alias, provider, skipID string) error {
	for _, record := range records {
		if record.ID == skipID {
			continue
		}
		if record.Alias == alias && record.ScopeProvider() == provider {
			return ErrDuplicateAlias
		}
	}
	return nil
}

func indexOf(records []Record, id string) int {
	trimmed := strings.TrimSpace(id)
	if trimmed == "" {
		return -1
	}
	for index, record := range records {
		if record.ID == trimmed {
			return index
		}
	}
	return -1
}

// generateAliasID 生成 8 位十六进制 id，与 Node 的 crypto.randomBytes(4).toString('hex') 同形。
func generateAliasID() string {
	var buffer [4]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		// 随机源不可用时退回空 id：Replace 允许空 id，但唯一性检查会失效，
		// 因此这里宁可返回空让上层看到异常形状，也不伪造可预测的 id。
		return ""
	}
	return hex.EncodeToString(buffer[:])
}

// ReplaceGroupInput 是「按 id 集合整体替换」的输入。
//
// 为什么需要整组替换而不是逐条改：WebUI 的一条别名可以对应多个目标（同一 alias 多行），
// 编辑时前端提交的是「整组的新样子」。逐条 diff 会在中途失败时留下半组记录，
// 表现为「别名指向一半旧目标一半新目标」。
type ReplaceGroupInput struct {
	ReplaceIDs []string
	Records    []CreateInput
}

// ReplaceGroup 删除 replaceIDs 指向的记录、追加新记录，并返回新建的那批。
func (service *Service) ReplaceGroup(
	ctx context.Context,
	input ReplaceGroupInput,
) ([]Record, int64, error) {
	if service == nil || service.store == nil {
		return nil, 0, ErrInvalidProjection
	}
	replaced := make(map[string]struct{}, len(input.ReplaceIDs))
	for _, id := range input.ReplaceIDs {
		if trimmed := strings.TrimSpace(id); trimmed != "" {
			replaced[trimmed] = struct{}{}
		}
	}
	records := service.List()
	kept := make([]Record, 0, len(records))
	for _, record := range records {
		if _, drop := replaced[record.ID]; drop {
			continue
		}
		kept = append(kept, record)
	}
	created := make([]Record, 0, len(input.Records))
	for _, item := range input.Records {
		enabled := true
		if item.Enabled != nil {
			enabled = *item.Enabled
		}
		record := Record{
			ID:             generateAliasID(),
			Alias:          strings.TrimSpace(item.Alias),
			Target:         strings.TrimSpace(item.Target),
			Provider:       service.normalizeScope(item.Provider),
			TargetProvider: strings.TrimSpace(item.TargetProvider),
			Priority:       item.Priority,
			Enabled:        &enabled,
			Description:    strings.TrimSpace(item.Description),
		}
		if !record.IsValid() {
			return nil, 0, ErrInvalidAlias
		}
		created = append(created, record)
	}
	// 唯一性在「保留 + 新建」整体上检查：分组替换最容易出的错就是把一条记录改成
	// 与组外记录同名，逐条校验看不出来。
	combined := append(append([]Record(nil), kept...), created...)
	seen := make(map[string]struct{}, len(combined))
	for _, record := range combined {
		key := record.ScopeProvider() + "\u0000" + record.Alias
		if _, duplicate := seen[key]; duplicate {
			return nil, 0, ErrDuplicateAlias
		}
		seen[key] = struct{}{}
	}
	generation, err := service.store.Replace(combined)
	if err != nil {
		return nil, 0, err
	}
	if len(created) == 0 {
		return nil, generation, nil
	}
	return service.recordsTail(len(created)), generation, nil
}

// recordsTail 返回集合末尾 n 条（ReplaceGroup 刚追加的就是它们）。
func (service *Service) recordsTail(count int) []Record {
	records := service.store.Snapshot().Records()
	if count <= 0 || len(records) == 0 {
		return nil
	}
	if count > len(records) {
		count = len(records)
	}
	return append([]Record(nil), records[len(records)-count:]...)
}
