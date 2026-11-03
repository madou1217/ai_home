package modelcatalog

import (
	"reflect"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

func validItem(id string) Item {
	return Item{
		ID:               id,
		OwnedBy:          "openai",
		InputModalities:  []string{"text", "image"},
		OutputModalities: []string{"text"},
		ReasoningEfforts: []inference.ReasoningEffort{inference.ReasoningEffortLow, inference.ReasoningEffortHigh},
	}
}

func TestStoreReplaceSortsAndCopiesWholeSnapshot(t *testing.T) {
	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	first := validItem("z-model")
	second := validItem("a-model")
	snapshot, err := store.Replace("rev-1", []Item{first, second})
	if err != nil {
		t.Fatalf("Replace() error = %v", err)
	}
	if snapshot.Generation != 1 || snapshot.Revision != "rev-1" {
		t.Fatalf("snapshot metadata = %#v, want generation 1 revision rev-1", snapshot)
	}
	if got := []string{snapshot.Items[0].ID, snapshot.Items[1].ID}; !reflect.DeepEqual(got, []string{"a-model", "z-model"}) {
		t.Fatalf("sorted IDs = %#v", got)
	}
	first.InputModalities[0] = "mutated"
	read := store.Snapshot()
	if read.Items[1].InputModalities[0] != "text" {
		t.Fatalf("store retained caller slice mutation: %#v", read.Items[1])
	}
	read.Items[0].OutputModalities[0] = "mutated"
	if store.Snapshot().Items[0].OutputModalities[0] != "text" {
		t.Fatal("Snapshot() exposed mutable store state")
	}
}

func TestStoreReplaceRejectsInvalidProjectionAndPreservesPrevious(t *testing.T) {
	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if _, err := store.Replace("rev-1", []Item{validItem("kept")}); err != nil {
		t.Fatalf("initial Replace() error = %v", err)
	}
	cases := []struct {
		name  string
		items []Item
	}{
		{name: "duplicate id", items: []Item{validItem("same"), validItem("same")}},
		{name: "empty id", items: []Item{validItem("")}},
		{name: "empty modality", items: []Item{func() Item { item := validItem("bad"); item.InputModalities = nil; return item }()}},
		{name: "duplicate modality", items: []Item{func() Item { item := validItem("bad"); item.InputModalities = []string{"text", "text"}; return item }()}},
		{name: "invalid reasoning", items: []Item{func() Item {
			item := validItem("bad")
			item.ReasoningEfforts = []inference.ReasoningEffort{"invalid"}
			return item
		}()}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := store.Replace("bad-"+tc.name, tc.items); err == nil {
				t.Fatal("Replace() unexpectedly accepted invalid projection")
			}
			read := store.Snapshot()
			if read.Revision != "rev-1" || len(read.Items) != 1 || read.Items[0].ID != "kept" {
				t.Fatalf("invalid replacement changed snapshot: %#v", read)
			}
		})
	}
}

func TestStoreReplaceRejectsDuplicateRevisionOnlyAfterValidValidation(t *testing.T) {
	store, err := NewStore()
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	first, err := store.Replace("rev-1", []Item{validItem("model")})
	if err != nil {
		t.Fatalf("initial Replace() error = %v", err)
	}
	second, err := store.Replace("rev-1", []Item{validItem("model")})
	if err != nil {
		t.Fatalf("same revision Replace() error = %v", err)
	}
	if second.Generation != first.Generation+1 {
		t.Fatalf("same revision generation = %d, want %d", second.Generation, first.Generation+1)
	}
}
