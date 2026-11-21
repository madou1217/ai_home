package providers

import "strings"

// codeBuddyFamilyProviders 是 CodeBuddy 家族四支的规范顺序：
// 国际站与国内站 × CodeBuddy / WorkBuddy。
//
// 顺序沿用 Node FAMILY_PROVIDERS：只影响候选目录的读取优先级，
// 四支共用同一份物理会话存储，读取时按真实路径去重。
var codeBuddyFamilyProviders = []string{"codebuddy", "codebuddycn", "workbuddy", "workbuddycn"}

// CodeBuddyFamilyProviders 返回家族四支的副本，调用方可安全修改。
func CodeBuddyFamilyProviders() []string {
	return append([]string(nil), codeBuddyFamilyProviders...)
}

// IsCodeBuddyFamilyProvider 判断 Provider 是否属于 CodeBuddy 家族。
func IsCodeBuddyFamilyProvider(providerID string) bool {
	normalized := strings.ToLower(strings.TrimSpace(providerID))
	for _, provider := range codeBuddyFamilyProviders {
		if provider == normalized {
			return true
		}
	}
	return false
}
