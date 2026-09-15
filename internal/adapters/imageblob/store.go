// Package imageblob 提供进程内、按内容寻址的图片字节仓。
//
// 它对应 Node 的 lib/server/image-blob-store.js：从请求里被剥离出来的图片（目标是
// 纯文本上游模型）与按 response_format=url 返回的生成结果都存放在这里，供
// 具备视觉能力的下游通过 GET /v1/blobs/{id} 取回。
//
// ID 是字节的 sha256 前 32 个十六进制字符，因此同一张图片跨轮次重发会映射到同一个
// 稳定句柄——借用只需描述一次并复用，不必每轮重新描述。
package imageblob

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
)

// MaxEntries 是进程内保留的 blob 上限；超出后按最近最少使用淘汰。
const MaxEntries = 256

// DefaultMIME 是调用方未声明类型时的兜底媒体类型。
const DefaultMIME = "application/octet-stream"

// idHashBytes 是参与 ID 的 sha256 前缀字节数；32 个十六进制字符。
const idHashBytes = 16

// Entry 是一份不可变的 blob 内容。
type Entry struct {
	bytes []byte
	mime  string
}

// Bytes 返回字节副本，调用方修改不会影响仓库内容。
func (entry Entry) Bytes() []byte {
	if entry.bytes == nil {
		return nil
	}
	copied := make([]byte, len(entry.bytes))
	copy(copied, entry.bytes)
	return copied
}

// MIME 返回入库时记录的媒体类型。
func (entry Entry) MIME() string {
	return entry.mime
}

// Store 是按内容寻址且带 LRU 淘汰的并发安全 blob 仓。
//
// 零值不可用；必须经 NewStore 创建。
type Store struct {
	mutex   sync.Mutex
	entries map[string]*entryNode
	// order 保存按最近使用排序的节点，头部最新、尾部最旧。
	order *entryList
	limit int
}

// NewStore 创建上限为 limit 的 blob 仓；limit 非正时使用 MaxEntries。
func NewStore(limit int) *Store {
	if limit <= 0 {
		limit = MaxEntries
	}
	return &Store{
		entries: make(map[string]*entryNode, limit),
		order:   newEntryList(),
		limit:   limit,
	}
}

// Put 写入字节并返回内容寻址 ID；同一内容重复写入只刷新最近使用顺序。
func (store *Store) Put(bytes []byte, mime string) string {
	if store == nil {
		return ""
	}
	copied := make([]byte, len(bytes))
	copy(copied, bytes)

	digest := sha256.Sum256(copied)
	id := hex.EncodeToString(digest[:idHashBytes])

	store.mutex.Lock()
	defer store.mutex.Unlock()
	if existing, found := store.entries[id]; found {
		store.order.moveToFront(existing)
		return id
	}
	normalizedMIME := mime
	if normalizedMIME == "" {
		normalizedMIME = DefaultMIME
	}
	node := store.order.pushFront(id, Entry{bytes: copied, mime: normalizedMIME})
	store.entries[id] = node
	for len(store.entries) > store.limit {
		oldest := store.order.back()
		if oldest == nil {
			break
		}
		store.order.remove(oldest)
		delete(store.entries, oldest.id)
	}
	return id
}

// Get 读取指定 ID 的内容；不存在时返回 false。
//
// 命中会刷新最近使用顺序，与 Node 的 Map 删除后重插语义一致。
func (store *Store) Get(id string) (Entry, bool) {
	if store == nil || id == "" {
		return Entry{}, false
	}
	store.mutex.Lock()
	defer store.mutex.Unlock()
	node, found := store.entries[id]
	if !found {
		return Entry{}, false
	}
	store.order.moveToFront(node)
	return Entry{bytes: node.entry.bytes, mime: node.entry.mime}, true
}

// Len 返回当前保留的 blob 数量。
func (store *Store) Len() int {
	if store == nil {
		return 0
	}
	store.mutex.Lock()
	defer store.mutex.Unlock()
	return len(store.entries)
}

// Reset 清空仓库，供测试与进程内重建使用。
func (store *Store) Reset() {
	if store == nil {
		return
	}
	store.mutex.Lock()
	defer store.mutex.Unlock()
	store.entries = make(map[string]*entryNode, store.limit)
	store.order = newEntryList()
}

// entryNode 是 LRU 双向链表节点。
type entryNode struct {
	id    string
	entry Entry
	prev  *entryNode
	next  *entryNode
}

// entryList 是仅服务本包的最小双向链表，避免为固定上限引入额外依赖。
type entryList struct {
	head *entryNode
	tail *entryNode
}

func newEntryList() *entryList {
	return &entryList{}
}

func (list *entryList) pushFront(id string, entry Entry) *entryNode {
	node := &entryNode{id: id, entry: entry, next: list.head}
	if list.head != nil {
		list.head.prev = node
	}
	list.head = node
	if list.tail == nil {
		list.tail = node
	}
	return node
}

// moveToFront 把已在链上的节点搬到头部。
//
// 必须搬运原节点而不是新建：Store.entries 持有的是节点指针，重建节点会让映射
// 指向一个已被摘链的孤儿，淘汰时删不到真正的表项。
func (list *entryList) moveToFront(node *entryNode) {
	if node == nil || list.head == node {
		return
	}
	list.remove(node)
	node.prev = nil
	node.next = list.head
	if list.head != nil {
		list.head.prev = node
	}
	list.head = node
	if list.tail == nil {
		list.tail = node
	}
}

func (list *entryList) back() *entryNode {
	return list.tail
}

func (list *entryList) remove(node *entryNode) {
	if node == nil {
		return
	}
	if node.prev != nil {
		node.prev.next = node.next
	} else {
		list.head = node.next
	}
	if node.next != nil {
		node.next.prev = node.prev
	} else {
		list.tail = node.prev
	}
	node.prev = nil
	node.next = nil
}
