package sessionchat

import (
	"net/url"
	"strings"
	"sync"

	"github.com/madou1217/ai_home/core/providers"
)

// urlPathUnescape 是 decodeURIComponent 的等价实现：解百分号转义，保留 '+'。
func urlPathUnescape(value string) (string, error) {
	return url.PathUnescape(value)
}

// providerCatalog 由 Go Provider 合同构建一次，供账号目录旗标等静态事实查询。
var providerCatalog = sync.OnceValue(func() *providers.Catalog {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil
	}
	return catalog
})

// providerConfigDirFlag 返回 Provider 合同声明的账号目录旗标；未声明返回空串。
func providerConfigDirFlag(provider string) string {
	catalog := providerCatalog()
	if catalog == nil {
		return ""
	}
	definition, found := catalog.Get(provider)
	if !found || definition.CLI == nil {
		return ""
	}
	return strings.TrimSpace(definition.CLI.ConfigDirFlag)
}
