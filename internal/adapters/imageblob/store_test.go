package imageblob_test

import (
	"bytes"
	"fmt"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/imageblob"
)

// TestStoreIsContentAddressed 验证同一内容重复写入映射到同一 ID 且只保留一份。
func TestStoreIsContentAddressed(t *testing.T) {
	t.Parallel()

	store := imageblob.NewStore(0)
	first := store.Put([]byte("image-bytes"), "image/png")
	second := store.Put([]byte("image-bytes"), "image/png")
	if first == "" || first != second {
		t.Fatalf("content addressing failed: first=%q second=%q", first, second)
	}
	if store.Len() != 1 {
		t.Fatalf("store len = %d, want 1", store.Len())
	}
	if len(first) != 32 {
		t.Fatalf("blob id = %q, want 32 hex chars", first)
	}
	entry, found := store.Get(first)
	if !found || !bytes.Equal(entry.Bytes(), []byte("image-bytes")) || entry.MIME() != "image/png" {
		t.Fatalf("stored entry = %q/%q found=%v", entry.Bytes(), entry.MIME(), found)
	}
}

// TestStoreDefaultsMIME 验证未声明媒体类型时使用与 Node 一致的兜底值。
func TestStoreDefaultsMIME(t *testing.T) {
	t.Parallel()

	store := imageblob.NewStore(0)
	entry, found := store.Get(store.Put([]byte("no-mime"), ""))
	if !found || entry.MIME() != imageblob.DefaultMIME {
		t.Fatalf("default mime = %q, want %q", entry.MIME(), imageblob.DefaultMIME)
	}
}

// TestStoreReturnsCopies 验证读写都隔离调用方切片，仓库内容不会被外部改写。
func TestStoreReturnsCopies(t *testing.T) {
	t.Parallel()

	store := imageblob.NewStore(0)
	source := []byte("original")
	id := store.Put(source, "image/png")
	source[0] = 'X'

	entry, _ := store.Get(id)
	if !bytes.Equal(entry.Bytes(), []byte("original")) {
		t.Fatalf("stored bytes were mutated: %q", entry.Bytes())
	}
	entry.Bytes()[0] = 'Y'
	again, _ := store.Get(id)
	if !bytes.Equal(again.Bytes(), []byte("original")) {
		t.Fatalf("returned bytes alias the store: %q", again.Bytes())
	}
}

// TestStoreEvictsLeastRecentlyUsed 验证超限后按最近最少使用淘汰，且 Get 会刷新顺序。
func TestStoreEvictsLeastRecentlyUsed(t *testing.T) {
	t.Parallel()

	store := imageblob.NewStore(3)
	ids := make([]string, 0, 4)
	for index := 0; index < 4; index++ {
		ids = append(ids, store.Put([]byte(fmt.Sprintf("blob-%d", index)), "image/png"))
	}
	if store.Len() != 3 {
		t.Fatalf("store len = %d, want 3", store.Len())
	}
	if _, found := store.Get(ids[0]); found {
		t.Fatal("oldest blob should have been evicted")
	}
	for _, id := range ids[1:] {
		if _, found := store.Get(id); !found {
			t.Fatalf("blob %s should still be present", id)
		}
	}

	// 触碰最旧的一项后，淘汰目标应变成未触碰的那一项。
	store.Put([]byte("blob-1"), "image/png")
	store.Put([]byte("blob-5"), "image/png")
	if _, found := store.Get(ids[1]); !found {
		t.Fatal("recently used blob must survive eviction")
	}
	if _, found := store.Get(ids[2]); found {
		t.Fatal("least recently used blob should have been evicted")
	}
}

// TestStoreSurvivesEvictionAndRelookup 验证淘汰后映射与链表保持一致。
//
// 回归：LRU 搬运节点时若重建节点，Store.entries 会指向已摘链的孤儿，
// 后续淘汰删不到真正的表项，Len 与实际链表长度随之发散。
func TestStoreSurvivesEvictionAndRelookup(t *testing.T) {
	t.Parallel()

	store := imageblob.NewStore(2)
	first := store.Put([]byte("a"), "image/png")
	second := store.Put([]byte("b"), "image/png")
	store.Get(first)
	store.Put([]byte("c"), "image/png")

	if store.Len() != 2 {
		t.Fatalf("store len = %d, want 2", store.Len())
	}
	if _, found := store.Get(second); found {
		t.Fatal("second blob should have been evicted after the touch")
	}
	if _, found := store.Get(first); !found {
		t.Fatal("touched blob should remain")
	}
}

// TestStoreReset 验证 Reset 清空内容，供进程内重建使用。
func TestStoreReset(t *testing.T) {
	t.Parallel()

	store := imageblob.NewStore(0)
	id := store.Put([]byte("reset-me"), "image/png")
	store.Reset()
	if store.Len() != 0 {
		t.Fatalf("store len after reset = %d, want 0", store.Len())
	}
	if _, found := store.Get(id); found {
		t.Fatal("reset store should not return the old blob")
	}
}

// TestNilStoreIsSafe 验证未初始化仓库不会 panic，便于可选依赖场景。
func TestNilStoreIsSafe(t *testing.T) {
	t.Parallel()

	var store *imageblob.Store
	if id := store.Put([]byte("x"), "image/png"); id != "" {
		t.Fatalf("nil store Put = %q, want empty", id)
	}
	if _, found := store.Get("anything"); found {
		t.Fatal("nil store Get should miss")
	}
	if store.Len() != 0 {
		t.Fatalf("nil store Len = %d, want 0", store.Len())
	}
	store.Reset()
}
