package modelalias

import (
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

// Store 保存 Node 推送的别名投影；整体替换，读多写少。
type Store struct {
	mu         sync.RWMutex
	generation int64
	records    []Record
}

// NewStore 创建空投影（没有任何别名时 Go 不做别名改写）。
func NewStore() *Store {
	return &Store{}
}

// Replace 用 Node 推送的完整别名集合替换当前投影，返回新代次。
// 任一记录无效时整体拒绝并保留原投影，避免部分应用让别名解析出现空洞。
func (store *Store) Replace(records []Record) (int64, error) {
	if store == nil || len(records) > MaxRecords {
		return 0, ErrInvalidProjection
	}
	next := make([]Record, 0, len(records))
	seen := make(map[string]struct{}, len(records))
	for _, record := range records {
		if !record.IsValid() {
			return 0, ErrInvalidAlias
		}
		if record.ID != "" {
			if _, duplicate := seen[record.ID]; duplicate {
				return 0, ErrInvalidProjection
			}
			seen[record.ID] = struct{}{}
		}
		normalized := record
		if normalized.Provider == "" {
			normalized.Provider = ScopeAll
		}
		if normalized.TargetProvider == "" {
			normalized.TargetProvider = TargetProviderAuto
		}
		next = append(next, normalized)
	}
	// 保留 Node 的推送顺序（created_at ASC, id ASC）：Node 用数组下标作为同优先级
	// 候选的稳定 tiebreaker，Go 必须保持同一顺序，别名解析结果才与 Node 一致。
	store.mu.Lock()
	store.generation++
	store.records = next
	generation := store.generation
	store.mu.Unlock()
	return generation, nil
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
