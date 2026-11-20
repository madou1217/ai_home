package main

import (
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// isKnownProvider 报告 providerID 是否为 Provider 合同里的规范 Provider。
//
// 用于「这个 Provider 是否存在」的场景（例如 `aih account default`）：服务端的
// ProviderDefaults 只接受 Catalog 中的规范 ID，因此 CLI 侧必须用同一份事实判定，
// 否则会出现服务端接受、CLI 先拒的错位（此前 `aih gemini` 可用但
// `aih account default show gemini` 被判非法）。
//
// 注意与 isCLIProvider 的区别：后者回答「本 CLI 是否提供该 Provider 的原生客户端
// 命令」，是更窄的问题，不能拿来当「Provider 是否存在」用。
func isKnownProvider(providerID string) bool {
	normalized := strings.TrimSpace(providerID)
	if normalized == "" {
		return false
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return false
	}
	_, found := catalog.CanonicalID(normalized)
	return found
}
