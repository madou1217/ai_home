package webuicontrolplaneapi

import (
	"context"
	"encoding/json"
	"os"
	"sync"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// RemoteProfile 是缓存索引中的控制面远端节点快照。
type RemoteProfile struct {
	ID            string
	Name          string
	Endpoint      string
	ManagementKey string
	Raw           map[string]any
}

type dbFileFingerprint struct {
	dbModNano  int64
	dbSize     int64
	walModNano int64
	walSize    int64
	dbExists   bool
	walExists  bool
}

// profileCache 基于 SQLite 主文件 + WAL 指纹实现控制面 profiles 的内存索引与按需刷新：
//   - 读热路径只做一次 VFS stat 校验（纳秒级内核目录项缓存）与 RWMutex O(1) map 查找；
//   - 本包写操作（保存/切换/删除/远端密钥轮换回写）直通更新缓存；
//   - 外部进程改库后下次请求检测到 stat 指纹变化即自动单飞重装，兼顾零陈旧与高并发吞吐。
type profileCache struct {
	aiHomeDir string

	loadMu sync.Mutex
	mu     sync.RWMutex
	loaded bool
	fp     dbFileFingerprint
	store  map[string]any
	byID   map[string]RemoteProfile
}

func newProfileCache(aiHomeDir string) *profileCache {
	return &profileCache{
		aiHomeDir: aiHomeDir,
		byID:      map[string]RemoteProfile{},
	}
}

func statFingerprint(dbPath string) dbFileFingerprint {
	var fp dbFileFingerprint
	if info, err := os.Stat(dbPath); err == nil {
		fp.dbExists = true
		fp.dbModNano = info.ModTime().UnixNano()
		fp.dbSize = info.Size()
	}
	if walInfo, err := os.Stat(dbPath + "-wal"); err == nil {
		fp.walExists = true
		fp.walModNano = walInfo.ModTime().UnixNano()
		fp.walSize = walInfo.Size()
	}
	return fp
}

func cloneStoreMap(store map[string]any) map[string]any {
	raw, err := json.Marshal(store)
	if err != nil {
		return normalizeStore(nil)
	}
	var copied map[string]any
	if err := json.Unmarshal(raw, &copied); err != nil {
		return normalizeStore(nil)
	}
	return normalizeStore(copied)
}

func cloneMapShallowOrJSON(input map[string]any) map[string]any {
	raw, err := json.Marshal(input)
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]any{}
	}
	return out
}

func buildProfileIndex(store map[string]any) map[string]RemoteProfile {
	index := map[string]RemoteProfile{}
	list, _ := store["profiles"].([]map[string]any)
	for _, entry := range list {
		id := text(entry["id"], 96)
		endpoint := normalizeEndpoint(entry["endpoint"])
		if id == "" || endpoint == "" {
			continue
		}
		index[id] = RemoteProfile{
			ID:            id,
			Name:          text(entry["name"], 120),
			Endpoint:      endpoint,
			ManagementKey: text(entry["managementKey"], 4096),
			Raw:           cloneMapShallowOrJSON(entry),
		}
	}
	return index
}

func (cache *profileCache) databasePath() (string, error) {
	return appstate.DatabasePath(cache.aiHomeDir)
}

func (cache *profileCache) ensureFresh(ctx context.Context) (string, error) {
	dbPath, err := cache.databasePath()
	if err != nil {
		return "", err
	}
	currentFP := statFingerprint(dbPath)
	cache.mu.RLock()
	upToDate := cache.loaded && cache.fp == currentFP
	cache.mu.RUnlock()
	if upToDate {
		return dbPath, nil
	}

	cache.loadMu.Lock()
	defer cache.loadMu.Unlock()

	currentFP = statFingerprint(dbPath)
	cache.mu.RLock()
	upToDate = cache.loaded && cache.fp == currentFP
	cache.mu.RUnlock()
	if upToDate {
		return dbPath, nil
	}

	raw, found, err := appstate.ReadKV(ctx, dbPath, profilesKey)
	if err != nil {
		return "", err
	}
	decoded, err := decodeStore(raw, found)
	if err != nil {
		return "", err
	}
	postFP := statFingerprint(dbPath)
	index := buildProfileIndex(decoded)

	cache.mu.Lock()
	cache.store = decoded
	cache.byID = index
	cache.fp = postFP
	cache.loaded = true
	cache.mu.Unlock()
	return dbPath, nil
}

// ReadStore 返回归一化后的 store 副本。
func (cache *profileCache) ReadStore(ctx context.Context) (map[string]any, error) {
	if _, err := cache.ensureFresh(ctx); err != nil {
		return nil, err
	}
	cache.mu.RLock()
	snapshot := cloneStoreMap(cache.store)
	cache.mu.RUnlock()
	return snapshot, nil
}

// Lookup 按 profileID 查找远端节点配置；命中走内存 O(1) 索引。
func (cache *profileCache) Lookup(ctx context.Context, profileID string) (RemoteProfile, bool, error) {
	id := text(profileID, 96)
	if id == "" {
		return RemoteProfile{}, false, nil
	}
	if _, err := cache.ensureFresh(ctx); err != nil {
		return RemoteProfile{}, false, err
	}
	cache.mu.RLock()
	profile, ok := cache.byID[id]
	cache.mu.RUnlock()
	if !ok {
		return RemoteProfile{}, false, nil
	}
	profile.Raw = cloneMapShallowOrJSON(profile.Raw)
	return profile, true, nil
}

// UpdateStore 原子写入 SQLite app_kv 并同步刷新内存索引。
func (cache *profileCache) UpdateStore(
	ctx context.Context,
	mutate func(store map[string]any) (map[string]any, error),
) error {
	cache.loadMu.Lock()
	defer cache.loadMu.Unlock()

	dbPath, err := cache.databasePath()
	if err != nil {
		return err
	}
	var committed map[string]any
	err = appstate.UpdateKV(ctx, dbPath, profilesKey, func(current string, found bool) (string, error) {
		store, decodeErr := decodeStore(current, found)
		if decodeErr != nil {
			return "", decodeErr
		}
		next, mutateErr := mutate(store)
		if mutateErr != nil {
			return "", mutateErr
		}
		encoded, marshalErr := json.Marshal(next)
		if marshalErr != nil {
			return "", marshalErr
		}
		committed = next
		return string(encoded), nil
	})
	if err != nil {
		cache.mu.Lock()
		cache.loaded = false
		cache.mu.Unlock()
		return err
	}
	postFP := statFingerprint(dbPath)
	index := buildProfileIndex(committed)
	cache.mu.Lock()
	cache.store = committed
	cache.byID = index
	cache.fp = postFP
	cache.loaded = true
	cache.mu.Unlock()
	return nil
}
