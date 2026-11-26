package providerstorage

import (
	"sort"
	"strings"
	"sync"

	"github.com/madou1217/ai_home/core/providers"
)

// HomeRoots 返回所有内置 Provider 在 HOME 下的根目录（HOME 相对段，已去重）。
//
// fake HOME 账号沙箱里出现「别的 CLI」的根目录（.codex、.claude、
// .local/share/opencode 等）时，它属于跨 CLI 共享状态而不是这个账号的数据：
// 投影默认把它指回宿主，全机只有宿主这一份。清单完全来自 Provider 合同
// （NativeRoot / CLI.GlobalDir / HostAuthRoot），不在投影执行器里手写名单。
func HomeRoots() [][]string {
	return builtinHomeRoots()
}

var builtinHomeRoots = sync.OnceValue(func() [][]string {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil
	}
	seen := make(map[string]struct{})
	roots := make([][]string, 0, len(catalog.List())*2)
	add := func(segments []string) {
		if len(segments) == 0 {
			return
		}
		cleaned := make([]string, 0, len(segments))
		for _, segment := range segments {
			segment = strings.TrimSpace(segment)
			if segment == "" || segment == "." || segment == ".." {
				// 空段表示根就是 HOME 本身，不能作为共享叶子。
				return
			}
			cleaned = append(cleaned, segment)
		}
		key := strings.Join(cleaned, "/")
		if _, exists := seen[key]; exists {
			return
		}
		seen[key] = struct{}{}
		roots = append(roots, cleaned)
	}
	for _, definition := range catalog.List() {
		add(definition.EffectiveNativeRoot())
		if definition.CLI != nil {
			add(strings.Split(strings.Trim(strings.TrimSpace(definition.CLI.GlobalDir), "/"), "/"))
		}
		if definition.Storage != nil && definition.Storage.HostAuthRoot != nil {
			add(*definition.Storage.HostAuthRoot)
		}
	}
	sort.Slice(roots, func(left, right int) bool {
		return strings.Join(roots[left], "/") < strings.Join(roots[right], "/")
	})
	return roots
})
