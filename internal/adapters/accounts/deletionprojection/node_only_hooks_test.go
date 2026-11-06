package deletionprojection

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// nodeOnlyHooksRelativePath 是 Node 侧登记「删除仍留在 Node」的拦截点表。
// 它与 nodeOnlyDeletionReasons 是同一件事的两半：Go 只写原因，Node 必须真的
// 在删除路径上调用这些 hook。两个方向都必须能失败，否则「留在 Node」会退化成
// 一句无法验证的注释。
const nodeOnlyHooksRelativePath = "lib/server/node-only-deletion-hooks.js"

type nodeOnlyDeletionHook struct {
	file      string
	export    string
	callSites []string
}

var (
	// 只认「provider: Object.freeze(」这个开头，不依赖数组写法：把整块写成
	// Object.freeze([])（零 hook）也必须被识别出来，否则删掉条目就能绕过检查。
	nodeOnlyProviderStartPattern = regexp.MustCompile(`(?m)^  ([A-Za-z0-9_]+): Object\.freeze\(`)
	nodeOnlyHookPattern          = regexp.MustCompile(`(?s)Object\.freeze\(\{\s*file: '([^']+)',\s*export: '([^']+)',\s*callSites: \[([^\]]*)\]`)
	nodeOnlyCallSitePattern      = regexp.MustCompile(`'([^']+)'`)
)

// TestNodeOnlyDeletionHooksMatchNodeRegistry 把 nodeOnlyDeletionReasons 从说明
// 变成可验证的合同：名单里的每个 Provider 都必须在 Node 登记表里出现，且登记的
// 文件存在、导出名真的在 module.exports 中、调用点真的调用了它。反向也一样——
// Node 登记了一家 Go 已经不认的 Provider，测试同样失败。
func TestNodeOnlyDeletionHooksMatchNodeRegistry(t *testing.T) {
	repoRoot := filepath.Join("..", "..", "..", "..")
	registrySource, err := os.ReadFile(filepath.Join(repoRoot, nodeOnlyHooksRelativePath))
	if err != nil {
		t.Fatalf("读取 Node 侧 node-only 删除钩子登记表失败: %v", err)
	}

	hooksByProvider := parseNodeOnlyDeletionHooks(t, string(registrySource))
	goProviders := make([]string, 0, len(nodeOnlyDeletionReasons))
	for providerID := range nodeOnlyDeletionReasons {
		goProviders = append(goProviders, providerID)
	}
	nodeProviders := make([]string, 0, len(hooksByProvider))
	for providerID := range hooksByProvider {
		nodeProviders = append(nodeProviders, providerID)
	}
	slices.Sort(goProviders)
	slices.Sort(nodeProviders)
	if !slices.Equal(goProviders, nodeProviders) {
		t.Fatalf("node-only 名单不一致：Go=%v Node=%v", goProviders, nodeProviders)
	}

	for providerID, providerHooks := range hooksByProvider {
		if len(providerHooks) == 0 {
			t.Errorf("%s 在 Node 登记表里没有任何拦截点", providerID)
		}
		for _, hook := range providerHooks {
			assertNodeOnlyDeletionHook(t, repoRoot, providerID, hook)
		}
	}
}

func parseNodeOnlyDeletionHooks(t *testing.T, source string) map[string][]nodeOnlyDeletionHook {
	t.Helper()
	hooks := make(map[string][]nodeOnlyDeletionHook)
	matches := nodeOnlyProviderStartPattern.FindAllStringSubmatchIndex(source, -1)
	for index, match := range matches {
		providerID := source[match[2]:match[3]]
		blockEnd := len(source)
		if index+1 < len(matches) {
			blockEnd = matches[index+1][0]
		}
		block := source[match[1]:blockEnd]
		// 先占位：零 hook 的 Provider 也必须进入集合，集合比对才能发现它。
		if _, found := hooks[providerID]; !found {
			hooks[providerID] = nil
		}
		for _, entry := range nodeOnlyHookPattern.FindAllStringSubmatch(block, -1) {
			hook := nodeOnlyDeletionHook{file: entry[1], export: entry[2]}
			for _, site := range nodeOnlyCallSitePattern.FindAllStringSubmatch(entry[3], -1) {
				hook.callSites = append(hook.callSites, site[1])
			}
			hooks[providerID] = append(hooks[providerID], hook)
		}
	}
	if len(hooks) == 0 {
		t.Fatalf("Node 侧登记表里没有解析到任何 Provider（格式是否被改动？）")
	}
	return hooks
}

func assertNodeOnlyDeletionHook(
	t *testing.T,
	repoRoot string,
	providerID string,
	hook nodeOnlyDeletionHook,
) {
	t.Helper()
	if strings.TrimSpace(hook.file) == "" || strings.TrimSpace(hook.export) == "" {
		t.Errorf("%s 的 hook 缺少 file/export: %+v", providerID, hook)
		return
	}
	if len(hook.callSites) == 0 {
		t.Errorf("%s 的 %s 没有登记调用点", providerID, hook.export)
	}

	modulePath := resolveRepoFile(t, repoRoot, hook.file)
	moduleSource, err := os.ReadFile(modulePath)
	if err != nil {
		t.Errorf("%s 的 hook 文件不存在: %s", providerID, hook.file)
		return
	}
	exportsIndex := strings.LastIndex(string(moduleSource), "module.exports")
	if exportsIndex < 0 {
		t.Errorf("%s 的 hook 文件没有 module.exports: %s", providerID, hook.file)
	} else if !regexp.MustCompile(`\b` + regexp.QuoteMeta(hook.export) + `\b`).MatchString(string(moduleSource)[exportsIndex:]) {
		t.Errorf("%s 的 %s 未在 %s 导出", providerID, hook.export, hook.file)
	}

	callPattern := regexp.MustCompile(`\b` + regexp.QuoteMeta(hook.export) + `\s*\(`)
	for _, callSite := range hook.callSites {
		callSource, err := os.ReadFile(resolveRepoFile(t, repoRoot, callSite))
		if err != nil {
			t.Errorf("%s 的 hook 调用点不存在: %s", providerID, callSite)
			continue
		}
		if !callPattern.Match(callSource) {
			t.Errorf("%s 的 %s 在调用点 %s 没有被调用", providerID, hook.export, callSite)
		}
	}
}

func resolveRepoFile(t *testing.T, repoRoot string, relativePath string) string {
	t.Helper()
	cleaned := filepath.Clean(relativePath)
	if filepath.IsAbs(cleaned) || cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		t.Fatalf("node-only hook 路径必须是仓库内相对路径: %q", relativePath)
	}
	return filepath.Join(repoRoot, cleaned)
}
