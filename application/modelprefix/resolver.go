// Package modelprefix 把 Provider 合同的模型命名空间声明编译成只读前缀索引。
//
// 解析只回答「这个前缀是否被某个 Provider 显式声明」；完整 id 优先与别名优先
// 由调用方在入口判定，避免把请求语义塞进合同索引。
package modelprefix

import (
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// Resolver 是不可变的前缀→Provider 索引。
type Resolver struct {
	byPrefix map[string]string
}

// New 编译 Provider 合同中显式声明 supported=true 的前缀。
//
// Provider ID 本身隐含可用；aliases 承载历史/上游写法。同一个前缀被两个
// Provider 声明时视为歧义并从索引移除——不猜，保持原行为。
func New(definitions []providers.Definition) *Resolver {
	resolved := make(map[string]string)
	ambiguous := make(map[string]struct{})
	for _, definition := range definitions {
		prefix := definition.ModelPrefix
		if prefix == nil || !prefix.Supported {
			continue
		}
		providerID := strings.ToLower(strings.TrimSpace(definition.ID))
		if providerID == "" {
			continue
		}
		candidates := make([]string, 0, 1+len(prefix.Aliases))
		candidates = append(candidates, providerID)
		candidates = append(candidates, prefix.Aliases...)
		for _, raw := range candidates {
			key := strings.ToLower(strings.TrimSpace(raw))
			if key == "" {
				continue
			}
			if existing, ok := resolved[key]; ok && existing != providerID {
				ambiguous[key] = struct{}{}
				continue
			}
			resolved[key] = providerID
		}
	}
	for key := range ambiguous {
		delete(resolved, key)
	}
	return &Resolver{byPrefix: resolved}
}

// Resolve 把 `provider/model` 还原成裸模型与 Provider。
//
// 只做形状与声明匹配：前缀必须在合同中显式声明，剩余部分非空。完整 id 是否
// 已经真实存在、是否命中别名，由调用方在改写前判定。
func (resolver *Resolver) Resolve(model string) (bare string, provider string, ok bool) {
	if resolver == nil {
		return "", "", false
	}
	raw := strings.TrimSpace(model)
	separator := strings.Index(raw, "/")
	if separator <= 0 || separator >= len(raw)-1 {
		return "", "", false
	}
	prefix := strings.ToLower(strings.TrimSpace(raw[:separator]))
	rest := strings.TrimSpace(raw[separator+1:])
	if prefix == "" || rest == "" {
		return "", "", false
	}
	provider, found := resolver.byPrefix[prefix]
	if !found {
		return "", "", false
	}
	return rest, provider, true
}
