package providercli

import (
	"runtime"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/application/providerlaunch"
)

// applyEnvironment 把不可变补丁应用到父进程环境，并消除重复变量。
func applyEnvironment(base []string, patch providerlaunch.EnvironmentPatch) []string {
	values := make(map[string]string, len(base)+len(patch.SetNames()))
	names := make(map[string]string, len(base)+len(patch.SetNames()))
	for _, entry := range base {
		name, value, found := strings.Cut(entry, "=")
		if !found || name == "" {
			continue
		}
		key := environmentKey(name)
		values[key] = value
		names[key] = name
	}
	for _, name := range patch.UnsetNames() {
		key := environmentKey(name)
		delete(values, key)
		delete(names, key)
	}
	for name, value := range patch.RevealSet() {
		key := environmentKey(name)
		values[key] = value
		names[key] = name
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, names[key]+"="+values[key])
	}
	return result
}

// setEnvironmentValue 覆盖 Runtime 动态分配的 Socket 等非持久配置。
func setEnvironmentValue(environment []string, name string, value string) []string {
	patch, _ := providerlaunch.NewEnvironmentPatch(map[string]string{name: value}, nil)
	return applyEnvironment(environment, patch)
}

// unsetEnvironmentValue 删除 Runtime 已经转移到本地代理内存的敏感变量。
func unsetEnvironmentValue(environment []string, name string) []string {
	patch, _ := providerlaunch.NewEnvironmentPatch(nil, []string{name})
	return applyEnvironment(environment, patch)
}

// environmentValue 按当前平台的环境变量大小写规则读取最终值。
func environmentValue(environment []string, name string) (string, bool) {
	target := environmentKey(name)
	for _, entry := range environment {
		entryName, value, found := strings.Cut(entry, "=")
		if found && environmentKey(entryName) == target {
			return value, true
		}
	}
	return "", false
}

// environmentKey 在 Windows 上按环境变量不区分大小写的规则去重。
func environmentKey(name string) string {
	return environmentKeyForOS(runtime.GOOS, name)
}

// environmentKeyForOS 隔离平台规则，避免测试依赖实际运行主机。
func environmentKeyForOS(goos string, name string) string {
	if goos == "windows" {
		return strings.ToUpper(name)
	}
	return name
}
