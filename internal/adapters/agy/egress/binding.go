package egress

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// 本文件对应 Node lib/account/zcode-egress-binding-store.js 的 normalizeEgressBinding()：
// 只做读取与形状校验，不解析代理、不碰启动流程。读侧语义与 Node 一致——
// 没有记录返回 unbound；记录损坏必须报错，让调用方 fail-closed，而不是当成未绑定
// 静默回落到全局代理。

const (
	bindingKeyPrefix = "account:egress:"
	// 与 Node egress-domain-contract 的 MAX_SCOPE_ITEMS 对齐。
	maxPoolScopeItems = 500
)

// 已下线的模式：节点/分组依赖 AIH 自己开的本地代理端口（旧实现）。读到这类历史
// 记录时标记 retired 交给上层 fail-closed，并保留原字段供 WebUI 提示改绑。
var retiredBindingModes = map[string]struct{}{
	"node":  {},
	"group": {},
}

// knownBindingModes 与 Node EGRESS_MODES 一致（pool 已重新启用，不属于 retired）。
var knownBindingModes = map[string]struct{}{
	ModeDirect: {},
	ModeSystem: {},
	ModeTUN:    {},
	ModeURL:    {},
	ModePool:   {},
}

// poolBindingStrategies 与 Node POOL_STRATEGIES 一致。
var poolBindingStrategies = map[string]struct{}{
	"shared":  {},
	"sticky":  {},
	"session": {},
}

// runtimeNodeNamePattern 对应 Node 的 /^node-\d+$/i：持久化选择里出现运行时节点名
// 说明记录已经失去稳定的出口身份，按非法记录处理（Node 抛 invalid_persistent_node_id，
// 上层归一化成 invalid_account_egress_binding_record）。
var runtimeNodeNamePattern = regexp.MustCompile("(?i)^node-[0-9]+$")

// errInvalidBindingRecord 与 Node 的 new Error('invalid_account_egress_binding_record')
// 同文案：调用方只把它当作 egress_binding_read_failed 的 reason。
var errInvalidBindingRecord = errors.New("invalid_account_egress_binding_record")

// PoolScope 是出口池绑定的节点选择范围（Node normalizePoolScope() 的输出）。
// Kind 取 all / groups / nodes；groups 与 nodes 始终是非 nil 切片，空表示该维度未选。
type PoolScope struct {
	Kind   string   `json:"kind"`
	Groups []string `json:"groups"`
	Nodes  []string `json:"nodes"`
}

// Binding 是规范化后的账号出口绑定。
//
// Mode 取值见 ModeDirect/ModeSystem/ModeTUN/ModeURL/ModePool；Retired 为 true 时
// 除 Mode/ProxyURL 外的字段只用于展示。PoolStrategy / PoolScope 是出口池选择的
// 形状校验结果，Go 解析不需要它们（账号车道由池运行时写进 state.json，按 accountRef
// 查表），保留是为了让 WebUI 与排查看到同一份规范化记录。PoolScopeKind 是
// PoolScope.Kind 的冗余投影，供只需要范围的调用方使用。
type Binding struct {
	Mode          string
	ProxyURL      string
	NodeID        string
	GroupID       string
	Retired       bool
	PoolStrategy  string
	PoolScopeKind string
	PoolScope     *PoolScope
	UpdatedAtMS   int64
}

// IsKnownMode 判断 mode 是否属于当前支持的出口模式（已下线的 node/group 不算）。
func IsKnownMode(mode string) bool {
	_, known := knownBindingModes[strings.ToLower(strings.TrimSpace(mode))]
	return known
}

// bindingKey 与 Node buildEgressBindingKey() 同构。
func bindingKey(accountRef string) string {
	reference := strings.TrimSpace(accountRef)
	if reference == "" {
		return ""
	}
	return bindingKeyPrefix + reference
}

// textValue 对应 Node normalizeText()：只接受字符串并 trim，其它类型一律空。
func textValue(value any) string {
	text, valid := value.(string)
	if !valid {
		return ""
	}
	return strings.TrimSpace(text)
}

// numberValue 对应 Node normalizeUpdatedAt()：有限且大于 0 的数字，否则 0。
func numberValue(value any) int64 {
	switch typed := value.(type) {
	case float64:
		if typed > 0 && typed <= float64(1<<53) {
			return int64(typed)
		}
	case string:
		if parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64); err == nil && parsed > 0 {
			return parsed
		}
	}
	return 0
}

// parseBinding 把 app_kv 里的原始 JSON 规范化为 Binding。
//
// 返回 errInvalidBindingRecord 表示记录存在但形状非法（Node 返回 null 后由
// readAccountEgressBinding 抛错）；JSON 解析失败单独包装，保留原始信息。
func parseBinding(raw string) (Binding, error) {
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return Binding{}, fmt.Errorf("解析账号出口绑定失败: %w", err)
	}
	object, valid := decoded.(map[string]any)
	if !valid {
		return Binding{}, errInvalidBindingRecord
	}
	return parseBindingObject(object)
}

// parseBindingObject 是 parseBinding 的对象分支：WebUI 写入也需要同一套归一化，
// 但输入来自已解码的请求体，不必再拼一次 JSON。
func parseBindingObject(object map[string]any) (Binding, error) {
	proxyURL := textValue(object["proxyUrl"])
	nodeID := textValue(object["nodeId"])
	groupID := textValue(object["groupId"])
	rawMode := strings.ToLower(textValue(object["mode"]))
	// 历史记录可能没有 mode，只剩 nodeId/groupId：Node 按 retired 形状返回，
	// 由上层提示用户改绑，不能当成未绑定。
	inferredRetired := rawMode == "" && proxyURL == "" && (nodeID != "" || groupID != "")
	if _, retired := retiredBindingModes[rawMode]; retired || inferredRetired {
		mode := rawMode
		if mode == "" {
			if nodeID != "" {
				mode = "node"
			} else {
				mode = "group"
			}
		}
		return Binding{
			Mode:        mode,
			Retired:     true,
			ProxyURL:    proxyURL,
			NodeID:      nodeID,
			GroupID:     groupID,
			UpdatedAtMS: numberValue(object["updatedAt"]),
		}, nil
	}
	if rawMode != "" {
		if _, known := knownBindingModes[rawMode]; !known {
			return Binding{}, errInvalidBindingRecord
		}
	}
	mode := rawMode
	if mode == "" {
		if proxyURL == "" {
			return Binding{}, errInvalidBindingRecord
		}
		// 没有 mode 但有 proxyUrl：Node 按 url 模式解释。
		mode = ModeURL
	}
	if mode == ModeURL && proxyURL == "" {
		return Binding{}, errInvalidBindingRecord
	}
	binding := Binding{
		Mode:        mode,
		ProxyURL:    proxyURL,
		NodeID:      nodeID,
		GroupID:     groupID,
		UpdatedAtMS: numberValue(object["updatedAt"]),
	}
	if mode == ModePool {
		selection, ok := parsePoolSelection(object)
		if !ok {
			return Binding{}, errInvalidBindingRecord
		}
		// Node 在 pool 模式下把 proxyUrl 归一化为空：实际地址来自池运行时。
		binding.ProxyURL = ""
		binding.PoolStrategy = selection.strategy
		binding.PoolScopeKind = selection.scope.Kind
		binding.PoolScope = &selection.scope
	}
	return binding, nil
}

type poolSelection struct {
	strategy string
	scope    PoolScope
}

// parsePoolSelection 对应 Node normalizePoolSelection() + normalizePoolScope()。
// 返回值 ok=false 等价于 normalizePoolScope 抛错（记录非法）。
func parsePoolSelection(object map[string]any) (poolSelection, bool) {
	source := object
	if scope, isObject := object["scope"].(map[string]any); isObject {
		source = scope
	}
	groups, ok := scopeList(firstPresent(source, "groups", "groupIds"))
	if !ok {
		return poolSelection{}, false
	}
	nodes, ok := scopeList(firstPresent(source, "nodes", "nodeIds"))
	if !ok {
		return poolSelection{}, false
	}
	for _, node := range nodes {
		if runtimeNodeNamePattern.MatchString(node) {
			return poolSelection{}, false
		}
	}
	kind := strings.ToLower(textValue(source["kind"]))
	if _, known := map[string]struct{}{"all": {}, "groups": {}, "nodes": {}}[kind]; !known {
		switch {
		case len(groups) > 0:
			kind = "groups"
		case len(nodes) > 0:
			kind = "nodes"
		default:
			kind = "all"
		}
	}
	// 显式空白名单选不出任何节点：与 Node 一样按全部节点处理。
	if (kind == "groups" && len(groups) == 0) || (kind == "nodes" && len(nodes) == 0) {
		kind = "all"
	}
	strategy := strings.ToLower(textValue(object["strategy"]))
	if _, known := poolBindingStrategies[strategy]; !known {
		strategy = "shared"
	}
	scope := PoolScope{Kind: kind, Groups: []string{}, Nodes: []string{}}
	if kind == "groups" {
		scope.Groups = groups
	}
	if kind == "nodes" {
		scope.Nodes = nodes
	}
	return poolSelection{strategy: strategy, scope: scope}, true
}

// firstPresent 模拟 JS 的 source.groups || source.groupIds：键存在且非空时优先，
// 否则看后备键。
func firstPresent(source map[string]any, primary string, fallback string) any {
	value, exists := source[primary]
	if exists && value != nil && value != "" {
		return value
	}
	return source[fallback]
}

// scopeList 对应 Node list()：只处理数组；对象项取 nodeId/groupId/poolGroupId/id/
// identity 中第一个非空值，所有字段都不存在则整条记录非法；结果去重并截断 500。
func scopeList(value any) ([]string, bool) {
	values, isArray := value.([]any)
	if !isArray {
		return nil, true
	}
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, item := range values {
		var key string
		switch typed := item.(type) {
		case string:
			key = strings.TrimSpace(typed)
		case map[string]any:
			found := false
			for _, field := range []string{"nodeId", "groupId", "poolGroupId", "id", "identity"} {
				raw, exists := typed[field]
				if !exists {
					continue
				}
				found = true
				if candidate := textValue(raw); candidate != "" {
					key = candidate
					break
				}
			}
			if !found {
				return nil, false
			}
		case nil:
			key = ""
		default:
			key = strings.TrimSpace(fmt.Sprint(typed))
		}
		if key == "" {
			continue
		}
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, key)
	}
	if len(result) > maxPoolScopeItems {
		result = result[:maxPoolScopeItems]
	}
	return result, true
}
