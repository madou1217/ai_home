// Package modelcatalog stores the immutable public model catalog projection
// supplied by the Node host. It is deliberately separate from the Go
// routable-model index: a model may be visible to clients while its requests
// still belong to Node.
package modelcatalog

import (
	"errors"
	"sort"
	"strings"
	"sync"

	"github.com/madou1217/ai_home/core/inference"
)

const MaxItems = 4096

var (
	ErrInvalidProjection = errors.New("模型目录投影无效")
	ErrInvalidItem       = errors.New("模型目录项无效")
)

// Item is the low-sensitivity public projection of one model.
type Item struct {
	ID               string
	OwnedBy          string
	InputModalities  []string
	OutputModalities []string
	ReasoningEfforts []inference.ReasoningEffort
}

// Snapshot is a consistent, immutable view returned by Store.
type Snapshot struct {
	Generation int64
	Revision   string
	Items      []Item
}

// Store atomically replaces the complete public projection.
type Store struct {
	mu         sync.RWMutex
	generation int64
	revision   string
	items      []Item
}

func NewStore() (*Store, error) {
	return &Store{}, nil
}

// Replace validates and publishes a complete projection. Invalid input never
// changes the previous snapshot.
func (store *Store) Replace(revision string, items []Item) (Snapshot, error) {
	if store == nil {
		return Snapshot{}, ErrInvalidProjection
	}
	revision = strings.TrimSpace(revision)
	if revision == "" || len(items) > MaxItems {
		return Snapshot{}, ErrInvalidProjection
	}
	normalized, err := normalizeItems(items)
	if err != nil {
		return Snapshot{}, err
	}
	store.mu.Lock()
	store.generation++
	store.revision = revision
	store.items = normalized
	snapshot := store.snapshotLocked()
	store.mu.Unlock()
	return snapshot, nil
}

// Snapshot returns a deep copy so callers cannot mutate the store.
func (store *Store) Snapshot() Snapshot {
	if store == nil {
		return Snapshot{}
	}
	store.mu.RLock()
	defer store.mu.RUnlock()
	return store.snapshotLocked()
}

func (store *Store) snapshotLocked() Snapshot {
	return Snapshot{
		Generation: store.generation,
		Revision:   store.revision,
		Items:      copyItems(store.items),
	}
}

func normalizeItems(items []Item) ([]Item, error) {
	if len(items) == 0 {
		return []Item{}, nil
	}
	normalized := make([]Item, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		id := strings.TrimSpace(item.ID)
		ownedBy := strings.TrimSpace(item.OwnedBy)
		if id == "" || ownedBy == "" {
			return nil, ErrInvalidItem
		}
		if _, exists := seen[id]; exists {
			return nil, ErrInvalidProjection
		}
		seen[id] = struct{}{}
		input, err := normalizeValues(item.InputModalities, true)
		if err != nil {
			return nil, ErrInvalidItem
		}
		output, err := normalizeValues(item.OutputModalities, true)
		if err != nil {
			return nil, ErrInvalidItem
		}
		efforts, err := normalizeEfforts(item.ReasoningEfforts)
		if err != nil {
			return nil, ErrInvalidItem
		}
		normalized = append(normalized, Item{
			ID:               id,
			OwnedBy:          ownedBy,
			InputModalities:  input,
			OutputModalities: output,
			ReasoningEfforts: efforts,
		})
	}
	sort.Slice(normalized, func(left, right int) bool {
		return normalized[left].ID < normalized[right].ID
	})
	return normalized, nil
}

func normalizeValues(values []string, required bool) ([]string, error) {
	if len(values) == 0 {
		if required {
			return nil, ErrInvalidItem
		}
		return []string{}, nil
	}
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" {
			return nil, ErrInvalidItem
		}
		if _, exists := seen[value]; exists {
			return nil, ErrInvalidItem
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result, nil
}

func normalizeEfforts(values []inference.ReasoningEffort) ([]inference.ReasoningEffort, error) {
	result := make([]inference.ReasoningEffort, 0, len(values))
	seen := make(map[inference.ReasoningEffort]struct{}, len(values))
	for _, effort := range values {
		if !effort.IsValid() {
			return nil, ErrInvalidItem
		}
		if _, exists := seen[effort]; exists {
			return nil, ErrInvalidItem
		}
		seen[effort] = struct{}{}
		result = append(result, effort)
	}
	return result, nil
}

func copyItems(items []Item) []Item {
	if items == nil {
		return []Item{}
	}
	result := make([]Item, len(items))
	for index, item := range items {
		result[index] = Item{
			ID:               item.ID,
			OwnedBy:          item.OwnedBy,
			InputModalities:  append([]string(nil), item.InputModalities...),
			OutputModalities: append([]string(nil), item.OutputModalities...),
			ReasoningEfforts: append([]inference.ReasoningEffort(nil), item.ReasoningEfforts...),
		}
	}
	return result
}
