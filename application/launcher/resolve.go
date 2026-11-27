package launcher

import (
	"errors"
	"strings"
)

// ErrQueryAmbiguous 表示一个应用查询命中多个同等优先级的应用。
//
// 调用方应展示候选而不是替用户猜一个：启动应用是不可撤销的副作用。
var ErrQueryAmbiguous = errors.New("launcher_query_ambiguous")

// ResolveQuery 按稳定优先级解析用户输入：ID 精确 → 名称精确 → 别名精确 →
// 名称/别名唯一前缀。它不做模糊/子序列匹配，避免 `aih app e` 这类输入
// 命中一个用户没预期的应用；需要排序候选时仍用 Rank。
func ResolveQuery(apps []App, query string) (App, error) {
	normalized := strings.ToLower(strings.TrimSpace(query))
	if normalized == "" {
		return App{}, ErrInvalidInput
	}

	for _, match := range []func(App) bool{
		func(app App) bool { return strings.EqualFold(app.ID, normalized) },
		func(app App) bool { return strings.EqualFold(app.Name, normalized) },
		func(app App) bool { return hasAliasFold(app.Aliases, normalized) },
	} {
		matched := uniqueMatches(apps, match)
		if len(matched) == 1 {
			return matched[0], nil
		}
		if len(matched) > 1 {
			return App{}, ErrQueryAmbiguous
		}
	}

	// 单字符前缀太容易误启动（例如 `e` 命中 Edge），只接受至少两个字符。
	if len([]rune(normalized)) < 2 {
		return App{}, ErrNotFound
	}
	prefixed := uniqueMatches(apps, func(app App) bool {
		if strings.HasPrefix(strings.ToLower(app.Name), normalized) {
			return true
		}
		for _, alias := range app.Aliases {
			if strings.HasPrefix(strings.ToLower(strings.TrimSpace(alias)), normalized) {
				return true
			}
		}
		return false
	})
	if len(prefixed) == 1 {
		return prefixed[0], nil
	}
	if len(prefixed) > 1 {
		return App{}, ErrQueryAmbiguous
	}
	return App{}, ErrNotFound
}

func hasAliasFold(aliases []string, normalized string) bool {
	for _, alias := range aliases {
		if strings.EqualFold(strings.TrimSpace(alias), normalized) {
			return true
		}
	}
	return false
}

func uniqueMatches(apps []App, match func(App) bool) []App {
	matched := make([]App, 0, 2)
	seen := make(map[string]struct{}, 2)
	for _, app := range apps {
		if !match(app) {
			continue
		}
		if _, duplicate := seen[app.ID]; duplicate {
			continue
		}
		seen[app.ID] = struct{}{}
		matched = append(matched, app)
	}
	return matched
}
