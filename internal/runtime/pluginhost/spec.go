package pluginhost

import (
	"strings"
)

// NewPluginSpec 从已校验的清单构造宿主加载规格。
//
// 插件启停（ControlPreparer）与 CLI 的一次性试加载共用这一份解释，避免
// entry/runtime/exec 的推导在不同入口分叉。
func NewPluginSpec(
	directory string,
	instanceID string,
	pluginID string,
	version string,
	manifest map[string]any,
	configuration map[string]any,
) PluginSpec {
	entryRel := stringField(manifest, "entry")
	runtimeKind := strings.TrimSpace(stringField(manifest, "runtime"))
	if runtimeKind == "" {
		runtimeKind = "node"
	}
	execArgv, execEnv := processExecFields(manifest)
	if configuration == nil {
		configuration = map[string]any{}
	}
	return PluginSpec{
		InstanceID:    strings.TrimSpace(instanceID),
		PluginID:      strings.TrimSpace(pluginID),
		Version:       strings.TrimSpace(version),
		EntryPath:     joinManifestEntry(directory, entryRel),
		Directory:     directory,
		Runtime:       runtimeKind,
		ExecArgv:      execArgv,
		ExecEnv:       execEnv,
		Manifest:      manifest,
		Configuration: configuration,
	}
}
