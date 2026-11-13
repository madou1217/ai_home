package webuitoolsettingsapi

import (
	"strings"
)

// PermissionArgConflict 是一条互斥规则命中（message 与 Node 完全一致）。
type PermissionArgConflict struct {
	Message string
}

// ValidatePermissionArgs 复刻 Node validatePermissionArgs：
//
//   - 非旗标 token 跳过；
//   - 未登记的旗标名进入 unknown；
//   - 声明了取值枚举的旗标，取值不在枚举里时以 name=value 进入 unknown；
//   - 同时返回目录里声明的互斥关系。
//
// 参数校验的唯一数据源是 permissionCatalogSpecs；这里不维护第二份旗标名单。
func ValidatePermissionArgs(provider string, args []string) ([]string, []PermissionArgConflict) {
	spec := resolveCatalogSpec(provider)
	aliases := map[string]string{}
	byCanonical := map[string]flagSpec{}
	for _, entry := range spec.Flags {
		aliases[entry.Flag] = entry.Flag
		for _, alias := range entry.Aliases {
			aliases[alias] = entry.Flag
		}
		byCanonical[entry.Flag] = entry
	}
	unknown := make([]string, 0)
	for index := 0; index < len(args); index++ {
		token := args[index]
		if !strings.HasPrefix(token, "-") {
			continue
		}
		equals := strings.IndexByte(token, '=')
		name := token
		if equals > 0 {
			name = token[:equals]
		}
		canonical, known := aliases[name]
		if !known {
			unknown = append(unknown, name)
			continue
		}
		entry, exists := byCanonical[canonical]
		if !exists {
			continue
		}
		valueMode := entry.Value
		if valueMode == "" {
			valueMode = "none"
		}
		if valueMode == "none" {
			continue
		}
		value := ""
		if equals > 0 {
			value = token[equals+1:]
		} else if index+1 < len(args) {
			next := args[index+1]
			if !strings.HasPrefix(next, "-") {
				value = next
				index++
			}
		}
		if len(entry.Options) == 0 {
			continue
		}
		allowed := false
		for _, option := range entry.Options {
			if option == value {
				allowed = true
				break
			}
		}
		if !allowed {
			unknown = append(unknown, name+"="+value)
		}
	}
	present := presentFlags(spec, args)
	conflicts := make([]PermissionArgConflict, 0)
	for _, rule := range spec.Conflicts {
		_, hasA := present[rule.A]
		_, hasB := present[rule.B]
		if hasA && hasB {
			conflicts = append(conflicts, PermissionArgConflict{Message: rule.Message})
		}
	}
	return unknown, conflicts
}

// presentFlags 复刻 Node collectPresentFlags：按目录别名归一后记录出现过的规范旗标。
func presentFlags(spec catalogSpec, args []string) map[string]struct{} {
	aliases := map[string]string{}
	byCanonical := map[string]flagSpec{}
	for _, entry := range spec.Flags {
		aliases[entry.Flag] = entry.Flag
		for _, alias := range entry.Aliases {
			aliases[alias] = entry.Flag
		}
		byCanonical[entry.Flag] = entry
	}
	present := map[string]struct{}{}
	for index := 0; index < len(args); index++ {
		token := args[index]
		if !strings.HasPrefix(token, "-") {
			continue
		}
		equals := strings.IndexByte(token, '=')
		name := token
		if equals > 0 {
			name = token[:equals]
		}
		canonical, known := aliases[name]
		if !known {
			continue
		}
		entry, exists := byCanonical[canonical]
		valueMode := "none"
		if exists && entry.Value != "" {
			valueMode = entry.Value
		}
		if valueMode != "none" && equals <= 0 {
			next := ""
			if index+1 < len(args) {
				next = args[index+1]
			}
			if next != "" && !strings.HasPrefix(next, "-") {
				index++
			}
		}
		present[canonical] = struct{}{}
	}
	return present
}
