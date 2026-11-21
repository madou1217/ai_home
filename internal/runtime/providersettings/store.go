// Package providersettings stores per-account overrides for Provider 配置关键项。
//
// 公共值仍是 Provider 的宿主 config 文件；这里只保存账号显式覆盖的键。
// 读取方按「公共值 + 账号覆盖」合成有效值，未覆盖的键保持继承。
package providersettings

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// KeyPrefix 是账号级 Provider 设置的 app_kv 前缀。
const KeyPrefix = "account:provider-settings:"

// Values 是 key path -> 覆盖值；空值表示不覆盖（继承公共值）。
type Values map[string]string

// Document 是单个账号的覆盖文档。
type Document struct {
	Provider  string `json:"provider"`
	Values    Values `json:"values"`
	UpdatedAt int64  `json:"updatedAt"`
}

// Store 读写账号级 Provider 设置。
type Store struct {
	databasePath string
}

// NewStore 按业务数据库路径构造 Store；空路径视为不可用。
func NewStore(databasePath string) *Store {
	return &Store{databasePath: strings.TrimSpace(databasePath)}
}

// Read 读取账号覆盖；缺失或损坏时返回空文档，不阻断公共配置。
func (s *Store) Read(ctx context.Context, accountRef string) (Document, error) {
	ref := strings.TrimSpace(accountRef)
	if s == nil || s.databasePath == "" || ref == "" {
		return Document{}, nil
	}
	raw, found, err := appstate.ReadKV(ctx, s.databasePath, KeyPrefix+ref)
	if err != nil {
		return Document{}, err
	}
	if !found || strings.TrimSpace(raw) == "" {
		return Document{}, nil
	}
	var document Document
	if json.Unmarshal([]byte(raw), &document) != nil {
		return Document{}, nil
	}
	document.Provider = strings.ToLower(strings.TrimSpace(document.Provider))
	if document.Values == nil {
		document.Values = Values{}
	}
	return document, nil
}

// Write 覆盖保存账号设置；空值条目会被移除，values 为空时删除文档。
func (s *Store) Write(ctx context.Context, accountRef, provider string, values Values) (Document, error) {
	ref := strings.TrimSpace(accountRef)
	normalizedProvider := strings.ToLower(strings.TrimSpace(provider))
	if s == nil || s.databasePath == "" || ref == "" || normalizedProvider == "" {
		return Document{}, fmt.Errorf("provider_settings_account_required")
	}
	cleaned := Values{}
	for path, value := range values {
		key := strings.TrimSpace(path)
		if key == "" {
			continue
		}
		text := strings.TrimSpace(value)
		if text != "" {
			cleaned[key] = text
		}
	}
	now := time.Now().UnixMilli()
	if len(cleaned) == 0 {
		// 全部恢复公共：写入空文档，保留 provider 便于审计与读取。
		cleaned = nil
	}
	document := Document{Provider: normalizedProvider, Values: cleaned, UpdatedAt: now}
	raw, err := json.Marshal(document)
	if err != nil {
		return Document{}, err
	}
	if err := appstate.WriteKV(ctx, s.databasePath, KeyPrefix+ref, string(raw), now); err != nil {
		return Document{}, err
	}
	if document.Values == nil {
		document.Values = Values{}
	}
	return document, nil
}

// Effective 把账号覆盖叠加到公共值上；未覆盖的键返回公共值。
func Effective(public Values, overrides Values) Values {
	effective := make(Values, len(public)+len(overrides))
	for path, value := range public {
		effective[path] = value
	}
	for path, value := range overrides {
		if strings.TrimSpace(value) != "" {
			effective[path] = value
		}
	}
	return effective
}
