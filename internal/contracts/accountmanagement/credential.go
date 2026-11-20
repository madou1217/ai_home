package accountmanagement

import (
	"strings"

	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

// StaticCredentialKind 是静态凭据资源接受的凭据类型标识。
type StaticCredentialKind string

const (
	// StaticCredentialAPIKey 表示 API Key 形态的静态凭据。
	StaticCredentialAPIKey StaticCredentialKind = "api_key"
	// StaticCredentialAuthToken 表示 Bearer 令牌形态的静态凭据。
	StaticCredentialAuthToken StaticCredentialKind = "auth_token"
)

// StaticCredentialSupport 声明一个 Provider 在账号 HTTP 面接受的静态凭据类型。
type StaticCredentialSupport struct {
	ProviderID string
	Kinds      []StaticCredentialKind
}

// staticCredentialSupport 是账号 HTTP 面确认支持的 Provider 顺序表。
//
// 这张表是服务端凭据构造、客户端预检与 CLI 帮助文本的共同事实来源：
// 此前三处各自按 Provider 名写分支，新增 Provider 时任何一处漏改都会让
// 「客户端接受、服务端拒绝」。Provider 领域包仍需提供构造器来证明该组合可实现，
// 表与构造器的不一致由 BuildStatic 显式报错，不会静默放行。
//
// 顺序即 CLI 帮助文本的展示顺序。
var staticCredentialSupport = []StaticCredentialSupport{
	{ProviderID: codex.ProviderID, Kinds: []StaticCredentialKind{StaticCredentialAPIKey}},
	{ProviderID: claude.ProviderID, Kinds: []StaticCredentialKind{StaticCredentialAPIKey, StaticCredentialAuthToken}},
}

// StaticCredentialProviders 返回支持静态凭据的 Provider，按声明顺序排列。
func StaticCredentialProviders() []string {
	providers := make([]string, 0, len(staticCredentialSupport))
	for _, support := range staticCredentialSupport {
		providers = append(providers, support.ProviderID)
	}
	return providers
}

// StaticCredentialKinds 返回 Provider 接受的静态凭据类型；不支持的 Provider 返回 nil。
func StaticCredentialKinds(providerID string) []StaticCredentialKind {
	support, found := findStaticCredentialSupport(providerID)
	if !found {
		return nil
	}
	return append([]StaticCredentialKind(nil), support.Kinds...)
}

// SupportsStaticCredential 判断 Provider 与凭据类型的组合是否被账号 HTTP 面接受。
func SupportsStaticCredential(providerID string, kind StaticCredentialKind) bool {
	support, found := findStaticCredentialSupport(providerID)
	if !found {
		return false
	}
	for _, candidate := range support.Kinds {
		if candidate == kind {
			return true
		}
	}
	return false
}

// IsStaticCredentialKind 判断凭据类型是否属于账号 HTTP 面定义的取值。
func IsStaticCredentialKind(kind string) bool {
	switch StaticCredentialKind(kind) {
	case StaticCredentialAPIKey, StaticCredentialAuthToken:
		return true
	default:
		return false
	}
}

// findStaticCredentialSupport 按规范化 Provider ID 查找声明。
func findStaticCredentialSupport(providerID string) (StaticCredentialSupport, bool) {
	normalized := strings.ToLower(strings.TrimSpace(providerID))
	for _, support := range staticCredentialSupport {
		if support.ProviderID == normalized {
			return support, true
		}
	}
	return StaticCredentialSupport{}, false
}
