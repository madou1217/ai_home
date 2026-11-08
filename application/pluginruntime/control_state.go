package pluginruntime

import (
	"encoding/json"
	"errors"
	"sort"
)

// ControlStateKey 是 Node 控制面在 app-state.db 的 app_kv 里保存插件控制状态的键。
//
// 插件安装、实例启停与 revision 的唯一事实都在这份文档里；Go 只读它，从不写回。
const ControlStateKey = "plugins.control.v1"

// MaxControlStateBytes 限制单份控制状态的大小，避免损坏或伪造的记录占用无界内存。
const MaxControlStateBytes = 4 << 20

var (
	// ErrControlStateUnavailable 表示控制状态存储不可打开或读取失败。
	ErrControlStateUnavailable = errors.New("插件控制状态不可读")
	// ErrControlStateInvalid 表示控制状态文档结构无效。
	ErrControlStateInvalid = errors.New("插件控制状态无效")
)

// Signature 是插件制品的签名结论（Node 的 signature 字段）。
//
// 用 RawMessage 透传：Node 会附带 keyId、fingerprint 等字段，Go 不解释它们，
// 只保证列表契约与 Node 原样一致。
type Signature = json.RawMessage

// Manifest 只解码插件清单里与列表和投影一致性有关的字段。
//
// Node 的清单还有 configSchema、permissions 等字段；Go 不校验清单，也不据此执行插件，
// 未列出的字段一律忽略，避免清单演进把只读列表打成 503。
type Manifest struct {
	PluginID    string         `json:"pluginId"`
	Version     string         `json:"version"`
	Contributes []Contribution `json:"contributes"`
}

// InstalledRecord 是已接受的一个插件制品（Node control 的 installed 条目）。
type InstalledRecord struct {
	PluginID    string          `json:"pluginId"`
	Version     string          `json:"version"`
	Digest      string          `json:"digest"`
	Manifest    Manifest        `json:"manifest"`
	InstalledAt int64           `json:"installedAt"`
	Signature   Signature       `json:"signature"`
	Permissions json.RawMessage `json:"permissions"`
}

// InstanceRecord 是一个插件实例的期望状态（Node control 的 instances 条目）。
type InstanceRecord struct {
	InstanceID            string                     `json:"instanceId"`
	PluginID              string                     `json:"pluginId"`
	Version               string                     `json:"version"`
	Enabled               bool                       `json:"enabled"`
	Configuration         map[string]json.RawMessage `json:"configuration"`
	PermissionsAcceptedAt *int64                     `json:"permissionsAcceptedAt"`
	UpdatedAt             int64                      `json:"updatedAt"`
}

// ControlState 是 plugins.control.v1 的只读投影。
//
// generations/activeGeneration 是 Node 运行时观察值，不在 Go 的读取范围内：
// Go 的存活代次只认 Node 通过管理接口推送的投影，两者不混用。
type ControlState struct {
	SchemaVersion int               `json:"schemaVersion"`
	Revision      int64             `json:"revision"`
	Installed     []InstalledRecord `json:"installed"`
	Instances     []InstanceRecord  `json:"instances"`
}

// Normalize 把缺字段与非法 revision 收敛成可展示的空状态。
func (state ControlState) Normalize() ControlState {
	normalized := state
	if normalized.SchemaVersion == 0 {
		normalized.SchemaVersion = 1
	}
	if normalized.Revision < 0 {
		normalized.Revision = 0
	}
	if normalized.Installed == nil {
		normalized.Installed = []InstalledRecord{}
	}
	if normalized.Instances == nil {
		normalized.Instances = []InstanceRecord{}
	}
	return normalized
}

// Validate 校验 Go 能理解的文档版本。
//
// 只接受缺失或 1：遇到未知版本时失败关闭，避免把未来结构当成当前结构静默展示。
func (state ControlState) Validate() error {
	if state.SchemaVersion != 0 && state.SchemaVersion != 1 {
		return ErrControlStateInvalid
	}
	return nil
}

// DecodeControlState 解析 plugins.control.v1 的 JSON 文本。
func DecodeControlState(data []byte) (ControlState, error) {
	if len(data) > MaxControlStateBytes {
		return ControlState{}, ErrControlStateInvalid
	}
	var state ControlState
	if err := json.Unmarshal(data, &state); err != nil {
		return ControlState{}, ErrControlStateInvalid
	}
	if err := state.Validate(); err != nil {
		return ControlState{}, err
	}
	return state.Normalize(), nil
}

// sortedConfigurationKeys 返回配置键名（列表不回显配置值，Node 契约同样只给键名）。
func (instance InstanceRecord) sortedConfigurationKeys() []string {
	keys := make([]string, 0, len(instance.Configuration))
	for key := range instance.Configuration {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
