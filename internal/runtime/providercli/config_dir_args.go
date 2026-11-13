package providercli

import (
	"strings"
	"sync"

	"github.com/madou1217/ai_home/core/providers"
)

// providerCatalog 只用于读取 Provider 合同的 CLI 旗标声明；构建一次即可。
var providerCatalog = sync.OnceValue(func() *providers.Catalog {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil
	}
	return catalog
})

// providerConfigDirFlag 返回 Provider 合同声明的账号配置根旗标。
//
// 当前只有 qoder / qodercn 声明 --config-dir：它们的账号隔离不是环境变量，
// 而是启动参数（登录流程另走 QODER_CONFIG_DIR 环境变量）。
func providerConfigDirFlag(providerID string) string {
	catalog := providerCatalog()
	if catalog == nil {
		return ""
	}
	definition, found := catalog.Get(strings.ToLower(strings.TrimSpace(providerID)))
	if !found || definition.CLI == nil {
		return ""
	}
	return strings.TrimSpace(definition.CLI.ConfigDirFlag)
}

// applyConfigDirArgument 在投影根就绪后把账号配置根注入 argv。
//
// 旗标必须指向本次账号的投影根（不是宿主 ~/.qoder）；调用方已经处理过
// 用户自带旗标的情况，这里再检查一次避免重复注入。
func applyConfigDirArgument(providerID string, arguments []string, root string) []string {
	flag := providerConfigDirFlag(providerID)
	directory := strings.TrimSpace(root)
	current := append([]string(nil), arguments...)
	if flag == "" || directory == "" {
		return current
	}
	for _, argument := range current {
		if argument == flag {
			return current
		}
	}
	return append([]string{flag, directory}, current...)
}
