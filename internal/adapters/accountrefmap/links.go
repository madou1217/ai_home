// Package accountrefmap 是 Node↔Go 账号引用映射表的存储适配器。
//
// 映射的解析与翻译语义属于应用层契约（application/accountrefs）：那是纯领域逻辑，
// 与数据存在哪无关。本包只负责从 app-state.db 的 go-account-sync:state 读取原始文档，
// 并把应用层类型以别名暴露给既有调用方，使调用方无需改动。
package accountrefmap

import (
	"context"

	apprefs "github.com/madou1217/ai_home/application/accountrefs"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// SyncStateKey 是 Node go-account-sync 在 app-state.db 中保存同步状态的键。
const SyncStateKey = apprefs.SyncStateKey

// 映射形状与翻译语义来自应用层契约；这里只做别名，避免出现第二份定义。
type (
	// Link 是单个账号的同步链接。
	Link = apprefs.Link
	// Table 是一份不可变的 Node→Go 映射表。
	Table = apprefs.Table
	// Resolver 是把「同步是否启用」与映射表合成的翻译器。
	Resolver = apprefs.Resolver
)

// Parse 解析 go-account-sync:state 的原始 JSON；规则只在应用层定义一次。
func Parse(raw string) (Table, error) {
	return apprefs.Parse(raw)
}

// NewResolver 构造翻译器；规则只在应用层定义一次。
func NewResolver(enabled bool, table Table) Resolver {
	return apprefs.NewResolver(enabled, table)
}

// Load 读取 aiHomeDir 下 app-state.db 的同步链接表。
//
// 数据库或键不存在返回空表（调用方按恒等回落）；只有读库失败才返回错误。
func Load(ctx context.Context, aiHomeDir string) (Table, error) {
	empty := Table{}
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return Table{}, err
	}
	raw, found, err := appstate.ReadKV(ctx, databasePath, SyncStateKey)
	if err != nil {
		return Table{}, err
	}
	if !found {
		return empty, nil
	}
	table, err := Parse(raw)
	if err != nil {
		// Node 的 readJsonValue 在解析失败时返回 null，随后整表退化为恒等。
		return empty, nil
	}
	return table, nil
}

// LoadStrict is used by destructive lifecycle coordination. A malformed mapping
// is unknown ownership, not permission to inspect/delete the identity fallback.
func LoadStrict(ctx context.Context, aiHomeDir string) (Table, error) {
	empty := Table{}
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return empty, err
	}
	raw, found, err := appstate.ReadKV(ctx, databasePath, SyncStateKey)
	if err != nil || !found {
		return empty, err
	}
	return Parse(raw)
}
