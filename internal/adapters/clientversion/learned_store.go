package clientversion

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// LearnedStore 持久化每个 Provider 从真实客户端学到的最高版本。
//
// 只保存版本号（不保存完整 User-Agent：其中含操作系统、终端等信息）；
// 小 JSON 文件足够，不为此引入数据库表。写入失败只影响重启后的记忆，不影响请求。
type LearnedStore struct {
	path     string
	mu       sync.Mutex
	versions map[string]string
}

// NewLearnedStore 打开（或延迟创建）学习版本文件。
func NewLearnedStore(path string) *LearnedStore {
	store := &LearnedStore{path: path, versions: make(map[string]string)}
	if payload, err := os.ReadFile(path); err == nil {
		var stored map[string]string
		if json.Unmarshal(payload, &stored) == nil {
			for provider, raw := range stored {
				if version, ok := Parse(raw); ok && version.String() == raw {
					store.versions[provider] = raw
				}
			}
		}
	}
	return store
}

// Get 返回 Provider 已学习的版本文本。
func (store *LearnedStore) Get(provider string) string {
	if store == nil {
		return ""
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.versions[provider]
}

// Raise 只在版本更高时更新并原子写回文件。
func (store *LearnedStore) Raise(provider string, version Version) {
	if store == nil || version.IsZero() {
		return
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if current, ok := Parse(store.versions[provider]); ok && version.Compare(current) <= 0 {
		return
	}
	store.versions[provider] = version.String()
	payload, err := json.MarshalIndent(store.versions, "", "  ")
	if err != nil || store.path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(store.path), 0o700); err != nil {
		return
	}
	temporary := store.path + ".tmp"
	if os.WriteFile(temporary, payload, 0o600) != nil {
		return
	}
	_ = os.Rename(temporary, store.path)
}
