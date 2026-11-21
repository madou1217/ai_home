// Package providerroot 提供存储适配器共享的原生根解析。
//
// 目录事实来自 Provider 合同（Definition.EffectiveNativeRoot），适配器不再
// 各自手写 .codex / .gemini 等配置根。
package providerroot

import (
	"strings"
	"sync"

	"github.com/madou1217/ai_home/core/providers"
)

var builtinCatalog = sync.OnceValue(func() *providers.Catalog {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		panic("providerroot: Provider 合同无效: " + err.Error())
	}
	return catalog
})

// RuntimeHomeDir 是账号投影下的运行态目录名。
const RuntimeHomeDir = ".aih-runtime-home"

// NativeRoot 返回 Provider 的生效原生根（HOME 相对段）。
func NativeRoot(providerID string) []string {
	definition, found := builtinCatalog().Get(strings.ToLower(strings.TrimSpace(providerID)))
	if !found {
		return nil
	}
	return definition.EffectiveNativeRoot()
}

// NativePath 返回 <NativeRoot>/<suffix...>。
func NativePath(providerID string, suffix ...string) []string {
	return append(NativeRoot(providerID), suffix...)
}

// ConfigRoot 返回 CLI.GlobalDir 的 HOME 相对段。
func ConfigRoot(providerID string) []string {
	definition, found := builtinCatalog().Get(strings.ToLower(strings.TrimSpace(providerID)))
	if !found || definition.CLI == nil {
		return nil
	}
	dir := strings.TrimSpace(definition.CLI.GlobalDir)
	if dir == "" {
		return nil
	}
	return strings.Split(dir, "/")
}

// ConfigPath 返回 <CLI.GlobalDir>/<suffix...>，用于配置根下的私有文件。
func ConfigPath(providerID string, suffix ...string) []string {
	return append(ConfigRoot(providerID), suffix...)
}

// RuntimeHome 返回 <NativeRoot>/.aih-runtime-home。
func RuntimeHome(providerID string) []string {
	return append(NativeRoot(providerID), RuntimeHomeDir)
}
