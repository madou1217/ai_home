package webuiserverconfigapi

import (
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// Source 是 aih.db 中 config:server 的读写适配器。
//
// 读写语义（立即事务读改写）由 appstate.ServerConfigStore 统一维护，
// 本文件只保留面向本包的构造入口。
type Source = appstate.ServerConfigStore

// OpenSource 创建 app-state 数据源。
func OpenSource(aiHomeDir string) (*Source, error) {
	return appstate.OpenServerConfigStore(aiHomeDir)
}
