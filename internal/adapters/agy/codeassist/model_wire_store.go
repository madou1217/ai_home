package codeassist

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/oauthutil"
)

// ModelWireReader 按账号查询公开模型实际使用的上游 ID。
type ModelWireReader interface {
	Resolve(accountRef accountcore.AccountRef, publicID string) string
}

var errInvalidModelWires = errors.New("AGY 模型转发表无效")

// ModelWireStore 保存账号各自的上游转发表。只含公开标识，不保存凭据；
// 刷新时原子替换，重启时恢复，推理时只读内存。
type ModelWireStore struct {
	path     string
	mu       sync.RWMutex
	accounts map[accountcore.AccountRef]map[string]string
}

func NewModelWireStore(path string) *ModelWireStore {
	store := &ModelWireStore{path: path, accounts: make(map[accountcore.AccountRef]map[string]string)}
	file, err := os.Open(path)
	if err != nil {
		return store
	}
	defer file.Close()
	var stored map[accountcore.AccountRef]map[string]string
	if oauthutil.DecodeJSONResponse(file, maxModelCatalogBytes, &stored) != nil {
		return store
	}
	for ref, models := range stored {
		if ref.IsValid() && validModelWires(models) {
			store.accounts[ref] = models
		}
	}
	return store
}

func (store *ModelWireStore) Resolve(accountRef accountcore.AccountRef, publicID string) string {
	if store == nil {
		return publicID
	}
	store.mu.RLock()
	wireID := store.accounts[accountRef][publicID]
	store.mu.RUnlock()
	if wireID == "" {
		return publicID
	}
	return wireID
}

// Replace 只在完整有效目录解析成功后调用；空映射会清除该账号的旧转发关系。
func (store *ModelWireStore) Replace(accountRef accountcore.AccountRef, models map[string]string) error {
	if store == nil || !accountRef.IsValid() || !validModelWires(models) {
		return errInvalidModelWires
	}
	copyModels := make(map[string]string, len(models))
	for publicID, wireID := range models {
		copyModels[publicID] = wireID
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	next := make(map[accountcore.AccountRef]map[string]string, len(store.accounts)+1)
	for ref, current := range store.accounts {
		next[ref] = current
	}
	next[accountRef] = copyModels
	if err := store.persist(next); err != nil {
		return err
	}
	store.accounts = next
	return nil
}

func (store *ModelWireStore) persist(accounts map[accountcore.AccountRef]map[string]string) error {
	if store.path == "" {
		return nil
	}
	payload, err := json.Marshal(accounts)
	if err != nil || len(payload) > maxModelCatalogBytes {
		return errInvalidModelWires
	}
	directory := filepath.Dir(store.path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".agy-model-wires-*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())
	_, writeErr := temporary.Write(payload)
	closeErr := temporary.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return err
	}
	return os.Rename(temporary.Name(), store.path)
}

func validModelWires(models map[string]string) bool {
	if len(models) > accountapp.MaxDiscoveredModelsPerAccount {
		return false
	}
	for publicID, wireID := range models {
		if !validCatalogModelID(publicID) || !validCatalogModelID(wireID) || publicID == wireID {
			return false
		}
	}
	return true
}
