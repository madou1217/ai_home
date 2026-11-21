package providers

import (
	"fmt"
	"regexp"
	"strings"
)

// modelPrefixAliasPattern 与插件描述符的 providerModelPrefix 别名同一形状。
var modelPrefixAliasPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

// validateModelPrefix 校验 Provider 对模型命名空间前缀的声明。
//
// 未声明（nil）表示不解析前缀，保持原行为；声明 supported=false 时必须给出
// 原因，避免「为什么不能」变成一个没人知道原因的缺席。别名只承载历史/上游
// 写法，Provider ID 本身由解析器隐含接受，不需要也不允许重复声明。
func validateModelPrefix(definition Definition) error {
	prefix := definition.ModelPrefix
	if prefix == nil {
		return nil
	}
	if !prefix.Supported {
		if strings.TrimSpace(prefix.Reason) == "" {
			return fmt.Errorf("Provider %s 的 modelPrefix.supported=false 时必须声明 reason", definition.ID)
		}
		return nil
	}
	providerID := strings.ToLower(strings.TrimSpace(definition.ID))
	seen := make(map[string]struct{}, len(prefix.Aliases))
	for _, raw := range prefix.Aliases {
		alias := strings.ToLower(strings.TrimSpace(raw))
		if !modelPrefixAliasPattern.MatchString(alias) {
			return fmt.Errorf("Provider %s 的 modelPrefix 别名不合法: %q", definition.ID, raw)
		}
		if alias == providerID {
			return fmt.Errorf("Provider %s 的 modelPrefix 别名不能重复声明 Provider ID", definition.ID)
		}
		if _, duplicate := seen[alias]; duplicate {
			return fmt.Errorf("Provider %s 的 modelPrefix 别名重复: %q", definition.ID, raw)
		}
		seen[alias] = struct{}{}
	}
	return nil
}
