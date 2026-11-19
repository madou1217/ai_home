package providerconfigs

import (
	"fmt"
	"strings"
)

// LookupValue 读取配置文本里的一个点路径值（只用于权限等只读判定）。
//
// 与校验器共用同一份 JSONC/TOML 解析，避免「启动时按一套宽松语法读、界面按另一套
// 严格语法校验」的分叉。值统一转成字符串：调用方只做等价比较，不关心数字/布尔形态。
func LookupValue(content string, format string, path string) (string, bool) {
	normalized := strings.ToLower(strings.TrimSpace(format))
	path = strings.TrimSpace(path)
	if path == "" {
		return "", false
	}
	switch normalized {
	case "toml":
		root, err := parseTOML(content)
		if err != nil {
			return "", false
		}
		// TOML 的权限键都在顶层；点路径只支持顶层键，与 Node readTomlTopLevelValue 一致。
		value, found := root[path]
		if !found {
			return "", false
		}
		return scalarString(value), true
	case "json", "jsonc":
		root, errs := parseJSONC(content)
		if len(errs) > 0 {
			return "", false
		}
		current := root
		for _, segment := range strings.Split(path, ".") {
			table, ok := current.(map[string]any)
			if !ok {
				return "", false
			}
			next, found := table[segment]
			if !found {
				return "", false
			}
			current = next
		}
		return scalarString(current), true
	default:
		return "", false
	}
}

func scalarString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return fmt.Sprintf("%g", typed)
	case int64:
		return fmt.Sprintf("%d", typed)
	case int:
		return fmt.Sprintf("%d", typed)
	default:
		return fmt.Sprint(typed)
	}
}
