package modelalias

import (
	"context"
	"sync"
)

// Snapshot 是某个代次的不可变别名投影。
type Snapshot struct {
	generation int64
	records    []Record
}

// Generation 返回投影代次；0 表示尚未收到任何推送。
func (snapshot Snapshot) Generation() int64 {
	return snapshot.generation
}

// Records 返回不会修改内部顺序的记录副本。
func (snapshot Snapshot) Records() []Record {
	return append([]Record(nil), snapshot.records...)
}

// Len 返回记录数量。
func (snapshot Snapshot) Len() int {
	return len(snapshot.records)
}

// Store 保存别名投影；整体替换，读多写少。
//
// repository 非空时每次替换都会落库并把代次换成仓储返回的值：进程重启后
// 可以用 Restore 直接恢复，不必等 Node 再推一次。
type Store struct {
	mu         sync.RWMutex
	repository Repository
	generation int64
	records    []Record
}

// NewStore 创建空投影（没有任何别名时 Go 不做别名改写）。
func NewStore() *Store {
	return &Store{}
}

// NewStoreWithRepository 创建会落库的投影。
func NewStoreWithRepository(repository Repository) *Store {
	return &Store{repository: repository}
}

// Restore 用持久化的别名填充内存投影，不改写仓储（启动恢复用）。
//
// 代次直接采用仓储里的值：路由编译靠代次判断快照新旧，重启后从头计数会让
// 「已发布的旧快照」看起来比新快照还新。
func (store *Store) Restore(ctx context.Context) error {
	if store == nil || store.repository == nil {
		return nil
	}
	records, generation, err := store.repository.Load(ctx)
	if err != nil {
		return err
	}
	store.mu.Lock()
	store.records = normalizeRecords(records)
	store.generation = generation
	store.mu.Unlock()
	return nil
}

// Replace 用 Node 推送的完整别名集合替换当前投影，返回新代次。
// 任一记录无效时整体拒绝并保留原投影，避免部分应用让别名解析出现空洞。
func (store *Store) Replace(records []Record) (int64, error) {
	if store == nil || len(records) > MaxRecords {
		return 0, ErrInvalidProjection
	}
	next, err := validateRecords(records)
	if err != nil {
		return 0, err
	}
	// 先落库再发布内存：写库失败时内存不能前进，否则重启后会回到旧集合。
	generation := int64(0)
	if store.repository != nil {
		generation, err = store.repository.Save(context.Background(), next)
		if err != nil {
			return 0, err
		}
	}
	// 保留 Node 的推送顺序（created_at ASC, id ASC）：Node 用数组下标作为同优先级
	// 候选的稳定 tiebreaker，Go 必须保持同一顺序，别名解析结果才与 Node 一致。
	store.mu.Lock()
	if store.repository == nil {
		store.generation++
		generation = store.generation
	} else {
		store.generation = generation
	}
	store.records = next
	store.mu.Unlock()
	return generation, nil
}

// validateRecords 校验并规整推送集合；任一记录无效时整体拒绝。
func validateRecords(records []Record) ([]Record, error) {
	if len(records) > MaxRecords {
		return nil, ErrInvalidProjection
	}
	next := make([]Record, 0, len(records))
	seen := make(map[string]struct{}, len(records))
	for _, record := range records {
		if !record.IsValid() {
			return nil, ErrInvalidAlias
		}
		if record.ID != "" {
			if _, duplicate := seen[record.ID]; duplicate {
				return nil, ErrInvalidProjection
			}
			seen[record.ID] = struct{}{}
		}
		normalized := record
		// 名单是切片：复制一份，推送方后续改动不会穿透到已发布投影。
		normalized.DisplayModels = append([]string(nil), record.DisplayModels...)
		if normalized.Provider == "" {
			normalized.Provider = ScopeAll
		}
		if normalized.TargetProvider == "" {
			normalized.TargetProvider = TargetProviderAuto
		}
		next = append(next, normalized)
	}
	return next, nil
}

// normalizeRecords 与 validateRecords 同义但不报错：读取历史数据时遇到坏行
// 应该跳过而不是让整个启动失败。
func normalizeRecords(records []Record) []Record {
	normalized, err := validateRecords(records)
	if err != nil {
		return nil
	}
	return normalized
}

// Snapshot 返回当前投影的一致快照。
func (store *Store) Snapshot() Snapshot {
	if store == nil {
		return Snapshot{}
	}
	store.mu.RLock()
	defer store.mu.RUnlock()
	return Snapshot{
		generation: store.generation,
		records:    append([]Record(nil), store.records...),
	}
}

// Generation 返回当前投影代次；0 表示尚未收到任何推送。
func (store *Store) Generation() int64 {
	return store.Snapshot().Generation()
}
