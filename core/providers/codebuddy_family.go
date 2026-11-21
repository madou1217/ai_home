package providers

import (
	"strings"
	"sync"
)

// builtinFamilyProviderIDs 从内置 Manifest 的 Family 派生 CodeBuddy 存储家族成员。
//
// 不再维护固定的四支名单：新 Provider 只要在自己的 Definition 里声明
// Family = "codebuddy" / "workbuddy"，就会自动加入家族；是否真正可用由
// ValidateManifest 的 StorageFacts 校验把关。
var builtinFamilyProviderIDs = sync.OnceValue(func() []string {
	ids := make([]string, 0, 4)
	for _, definition := range BuiltinManifest().Providers {
		if definition.Family == "codebuddy" || definition.Family == "workbuddy" {
			ids = append(ids, definition.ID)
		}
	}
	return ids
})

// CodeBuddyFamilyProviders 返回家族成员的副本，顺序沿用 Manifest 声明顺序。
func CodeBuddyFamilyProviders() []string {
	return append([]string(nil), builtinFamilyProviderIDs()...)
}

// IsCodeBuddyFamilyProvider 判断 Provider 是否属于 CodeBuddy 存储家族。
func IsCodeBuddyFamilyProvider(providerID string) bool {
	normalized := strings.ToLower(strings.TrimSpace(providerID))
	for _, provider := range builtinFamilyProviderIDs() {
		if provider == normalized {
			return true
		}
	}
	return false
}
