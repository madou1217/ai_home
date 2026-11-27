package main

import (
	"strings"
	"sync"

	"github.com/madou1217/ai_home/core/providers"
)

// loadProviderCatalog 复用同一份 Provider 目录：帮助、能力判断和补全在一条命令里
// 会重复查询，没必要每次重建 Catalog。构建失败时返回 nil，调用方按未知处理。
var loadProviderCatalog = sync.OnceValue(func() *providers.Catalog {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil
	}
	return catalog
})

func lookupProviderDefinition(providerID string) (providers.Definition, bool) {
	catalog := loadProviderCatalog()
	if catalog == nil {
		return providers.Definition{}, false
	}
	return catalog.Get(strings.ToLower(strings.TrimSpace(providerID)))
}
