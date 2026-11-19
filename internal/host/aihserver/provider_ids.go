package aihserver

import (
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// providerIDs 返回 Provider 目录里的全部 ID（归属解析的唯一真值源）。
//
// 该函数随 node-only provider 概念一起被误删，但成本计算、别名与模型规则仍
// 依赖它；这里只保留目录读取，不再重新引入 nodeOnly 名单。
func providerIDs(catalog *providers.Catalog) []string {
	if catalog == nil {
		return nil
	}
	definitions := catalog.List()
	ids := make([]string, 0, len(definitions))
	for _, definition := range definitions {
		if id := strings.TrimSpace(definition.ID); id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}
