package plugincontrol

import (
	"encoding/json"
	"reflect"
	"regexp"

	"github.com/madou1217/ai_home/internal/pluginerr"
)

// Operation 是一次控制状态提交的动作。
//
// 四个动作共享同一个写事务（CAS + 维护租约 + 原始字节落盘），区别只在允许改动的区域：
// enable/disable 只能改 instances，install 只能改 installed，uninstall 只能删 installed。
type Operation string

const (
	// OperationEnable 启用实例（instances 可变）。
	OperationEnable Operation = "enable"
	// OperationDisable 停用实例（instances 可变）。
	OperationDisable Operation = "disable"
	// OperationInstall 安装制品（installed 可变）。
	OperationInstall Operation = "install"
	// OperationUninstall 卸载制品（installed 可变，且被删记录不得仍被实例引用）。
	OperationUninstall Operation = "uninstall"
)

// MaxStateBytes 是 plugins.control.v1 文档上限（与 Node/application pluginruntime 一致）。
const MaxStateBytes = 4 << 20

// instanceIDPattern 与 Node control.js 的 INSTANCE_ID_PATTERN 逐字一致。
const instanceIDPattern = `^[a-z0-9][a-z0-9._-]{0,127}$`

var instanceIDRegexp = regexp.MustCompile(instanceIDPattern)

// ParseOperation 把请求里的动作字符串收敛成枚举；未知动作拒绝（不猜、不默认）。
func ParseOperation(raw string) (Operation, bool) {
	switch Operation(raw) {
	case OperationEnable, OperationDisable, OperationInstall, OperationUninstall:
		return Operation(raw), true
	default:
		return "", false
	}
}

// stateDocument 是提交时用到的控制状态视图。
//
// installed / instances / generations 保留原始 JSON：Go 只校验它认识的字段，
// 写入时用的是调用方给的候选原文，未知字段（artifact / directory / createdAt ...）一个都不动。
type stateDocument struct {
	SchemaVersion int64
	Revision      int64
	Installed     []json.RawMessage
	Instances     []json.RawMessage
	Generations   []json.RawMessage
}

type installedView struct {
	PluginID               string
	Version                string
	PermissionsFingerprint string
	DeclaresPermissions    bool
}

type instanceView struct {
	InstanceID     string
	PluginID       string
	Version        string
	Enabled        bool
	Configuration  json.RawMessage
	Fingerprint    string
	HasFingerprint bool
}

// ValidateCandidate 校验「这份候选能不能成为唯一事实」。
//
// 校验只覆盖结构与操作边界；候选里的语义（configSchema、默认值、权限指纹算法）仍由 Node 负责，
// Go 只做字符串比较，绝不重算（重算会因属性序不同让存量指纹全部失效）。
func ValidateCandidate(current []byte, candidate []byte, operation Operation, expectedRevision int64) error {
	next, err := decodeCandidateDocument(candidate)
	if err != nil {
		return err
	}
	if next.SchemaVersion != 1 {
		return invalidState("schemaVersion 必须为 1")
	}
	if next.Revision != expectedRevision+1 {
		return invalidState("revision 必须等于 expectedRevision + 1")
	}
	previous := stateDocument{}
	if len(current) > 0 {
		decoded, decodeErr := decodeCurrentDocument(current)
		if decodeErr != nil {
			return decodeErr
		}
		previous = decoded
	}
	installedByKey, err := indexInstalled(next.Installed)
	if err != nil {
		return err
	}
	instances, err := indexInstances(next.Instances, installedByKey)
	if err != nil {
		return err
	}
	switch operation {
	case OperationEnable, OperationDisable:
		// 启停不得夹带安装/卸载：installed 必须与当前文档语义一致。
		if !jsonArraysEqual(previous.Installed, next.Installed) {
			return invalidState("enable/disable 不得修改 installed")
		}
	case OperationInstall:
		// 安装只改 installed；实例集合由 Node 维护，不得在安装时被顺带改写。
		if !jsonArraysEqual(previous.Instances, next.Instances) {
			return invalidState("install 不得修改 instances")
		}
	case OperationUninstall:
		if !jsonArraysEqual(previous.Instances, next.Instances) {
			return invalidState("uninstall 不得修改 instances")
		}
		if err := ensureRemovedUnreferenced(previous.Installed, next.Installed, instances); err != nil {
			return err
		}
	default:
		return invalidState("未知 operation")
	}
	return nil
}

// decodeCandidateDocument 严格解析候选：必须是对象，且三个数组字段必须存在。
// 候选由 Node normalizeState 生成，形状固定；这里严格是为了不让半截文档落盘。
func decodeCandidateDocument(data []byte) (stateDocument, error) {
	if len(data) == 0 || len(data) > MaxStateBytes {
		return stateDocument{}, invalidState("控制状态文档为空或超过 4MB")
	}
	document, err := decodeJSONObject(data)
	if err != nil {
		return stateDocument{}, err
	}
	schemaVersion, ok := decodeInteger(document["schemaVersion"])
	if !ok {
		return stateDocument{}, invalidState("schemaVersion 必须是整数")
	}
	revision, ok := decodeInteger(document["revision"])
	if !ok || revision < 0 {
		return stateDocument{}, invalidState("revision 必须是非负整数")
	}
	installed, err := decodeRecordArray(document, "installed")
	if err != nil {
		return stateDocument{}, err
	}
	instances, err := decodeRecordArray(document, "instances")
	if err != nil {
		return stateDocument{}, err
	}
	generations, err := decodeRecordArray(document, "generations")
	if err != nil {
		return stateDocument{}, err
	}
	return stateDocument{
		SchemaVersion: schemaVersion,
		Revision:      revision,
		Installed:     installed,
		Instances:     instances,
		Generations:   generations,
	}, nil
}

// decodeCurrentDocument 解析当前文档。
//
// 数组字段沿用 Node normalizeState 的宽松归一（非法类型当空），revision 必须是合法非负整数：
// 文档损坏时宁可 plugin_state_invalid 拒绝写入，也不能把 revision 当 0 覆盖掉。
func decodeCurrentDocument(data []byte) (stateDocument, error) {
	document, err := decodeJSONObject(data)
	if err != nil {
		return stateDocument{}, err
	}
	revision, ok := decodeInteger(document["revision"])
	if !ok || revision < 0 {
		return stateDocument{}, invalidState("当前控制状态文档的 revision 非法")
	}
	return stateDocument{
		Revision:    revision,
		Installed:   decodeLenientArray(document["installed"]),
		Instances:   decodeLenientArray(document["instances"]),
		Generations: decodeLenientArray(document["generations"]),
	}, nil
}

func decodeJSONObject(data []byte) (map[string]json.RawMessage, error) {
	if !json.Valid(data) {
		return nil, invalidState("控制状态文档不是合法 JSON")
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(data, &document); err != nil || document == nil {
		return nil, invalidState("控制状态文档必须是 JSON 对象")
	}
	return document, nil
}

func decodeRecordArray(document map[string]json.RawMessage, name string) ([]json.RawMessage, error) {
	raw, present := document[name]
	if !present {
		return nil, invalidState(name + " 必须是数组")
	}
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil || values == nil {
		return nil, invalidState(name + " 必须是数组")
	}
	for _, value := range values {
		var object map[string]json.RawMessage
		if err := json.Unmarshal(value, &object); err != nil || object == nil {
			return nil, invalidState(name + " 的元素必须是 JSON 对象")
		}
	}
	return values, nil
}

func decodeLenientArray(raw json.RawMessage) []json.RawMessage {
	if len(raw) == 0 {
		return []json.RawMessage{}
	}
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil || values == nil {
		return []json.RawMessage{}
	}
	return values
}

func decodeInteger(raw json.RawMessage) (int64, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err != nil {
		return 0, false
	}
	value, err := number.Int64()
	if err != nil {
		return 0, false
	}
	return value, true
}

func decodeStringField(object map[string]json.RawMessage, name string) (string, bool) {
	raw, present := object[name]
	if !present || len(raw) == 0 || string(raw) == "null" {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

// indexInstalled 建立 pluginId@version → installed 视图；重复键本身不报错，
// 只在实例引用时要求「唯一解析」（与 Node findInstalled 的歧义语义对齐）。
func indexInstalled(values []json.RawMessage) (map[string][]installedView, error) {
	index := make(map[string][]installedView, len(values))
	for _, raw := range values {
		var object map[string]json.RawMessage
		if err := json.Unmarshal(raw, &object); err != nil || object == nil {
			return nil, invalidState("installed 的元素必须是 JSON 对象")
		}
		pluginID, ok := decodeStringField(object, "pluginId")
		if !ok || pluginID == "" {
			return nil, invalidState("installed 记录缺少 pluginId")
		}
		version, ok := decodeStringField(object, "version")
		if !ok || version == "" {
			return nil, invalidState("installed 记录缺少 version")
		}
		view := installedView{PluginID: pluginID, Version: version}
		if value, present := object["permissionsFingerprint"]; present && string(value) != "null" {
			var fingerprint string
			if err := json.Unmarshal(value, &fingerprint); err != nil {
				return nil, invalidState("permissionsFingerprint 必须是字符串")
			}
			view.PermissionsFingerprint = fingerprint
		}
		view.DeclaresPermissions = manifestDeclaresPermissions(object["manifest"])
		key := installedKey(pluginID, version)
		index[key] = append(index[key], view)
	}
	return index, nil
}

// indexInstances 校验实例自身的不变量（id 正则/唯一、能唯一解析到 installed、启用时配置是对象、权限指纹一致）。
func indexInstances(values []json.RawMessage, installed map[string][]installedView) ([]instanceView, error) {
	seen := make(map[string]struct{}, len(values))
	views := make([]instanceView, 0, len(values))
	for _, raw := range values {
		var object map[string]json.RawMessage
		if err := json.Unmarshal(raw, &object); err != nil || object == nil {
			return nil, invalidState("instances 的元素必须是 JSON 对象")
		}
		instanceID, ok := decodeStringField(object, "instanceId")
		if !ok || !instanceIDRegexp.MatchString(instanceID) {
			return nil, invalidState("instanceId 不符合 ^[a-z0-9][a-z0-9._-]{0,127}$")
		}
		if _, duplicate := seen[instanceID]; duplicate {
			return nil, invalidState("instanceId 重复：" + instanceID)
		}
		seen[instanceID] = struct{}{}
		pluginID, ok := decodeStringField(object, "pluginId")
		if !ok || pluginID == "" {
			return nil, invalidState("实例 " + instanceID + " 缺少 pluginId")
		}
		version, ok := decodeStringField(object, "version")
		if !ok || version == "" {
			return nil, invalidState("实例 " + instanceID + " 缺少 version")
		}
		enabled := false
		if value, present := object["enabled"]; present && string(value) != "null" {
			if err := json.Unmarshal(value, &enabled); err != nil {
				return nil, invalidState("实例 " + instanceID + " 的 enabled 必须是布尔值")
			}
		}
		view := instanceView{
			InstanceID: instanceID,
			PluginID:   pluginID,
			Version:    version,
			Enabled:    enabled,
		}
		if value, present := object["configuration"]; present {
			view.Configuration = value
		}
		if value, present := object["permissionsAcceptedFingerprint"]; present && string(value) != "null" {
			var fingerprint string
			if err := json.Unmarshal(value, &fingerprint); err != nil {
				return nil, invalidState("实例 " + instanceID + " 的 permissionsAcceptedFingerprint 必须是字符串")
			}
			view.Fingerprint = fingerprint
			view.HasFingerprint = true
		}
		matches := installed[installedKey(pluginID, version)]
		if len(matches) == 0 {
			return nil, invalidState("实例 " + instanceID + " 引用了未安装的 " + pluginID + "@" + version)
		}
		if len(matches) > 1 {
			return nil, invalidState("实例 " + instanceID + " 的 " + pluginID + "@" + version + " 无法唯一解析")
		}
		if enabled {
			if !isJSONObject(view.Configuration) {
				return nil, invalidState("启用的实例 " + instanceID + " 必须带 JSON 对象配置")
			}
			// 权限门只对启用的实例生效：停用实例保留历史指纹，否则权限变更后连停用都会被拒。
			if matches[0].DeclaresPermissions && view.Fingerprint != matches[0].PermissionsFingerprint {
				return nil, invalidState("实例 " + instanceID + " 的权限确认指纹与已安装制品不一致")
			}
		}
		views = append(views, view)
	}
	return views, nil
}

// ensureRemovedUnreferenced 保证被卸载的记录没有被任何实例引用。
func ensureRemovedUnreferenced(previous []json.RawMessage, next []json.RawMessage, instances []instanceView) error {
	for _, raw := range previous {
		if arrayContainsJSON(next, raw) {
			continue
		}
		var object map[string]json.RawMessage
		if err := json.Unmarshal(raw, &object); err != nil {
			continue
		}
		pluginID, _ := decodeStringField(object, "pluginId")
		version, _ := decodeStringField(object, "version")
		for _, instance := range instances {
			if instance.PluginID == pluginID && instance.Version == version {
				return invalidState("被卸载的 " + pluginID + "@" + version + " 仍被实例 " + instance.InstanceID + " 引用")
			}
		}
	}
	return nil
}

func installedKey(pluginID string, version string) string {
	return pluginID + "\x00" + version
}

func isJSONObject(raw json.RawMessage) bool {
	if len(raw) == 0 || !json.Valid(raw) {
		return false
	}
	var object map[string]json.RawMessage
	return json.Unmarshal(raw, &object) == nil && object != nil
}

func manifestDeclaresPermissions(raw json.RawMessage) bool {
	if len(raw) == 0 || !json.Valid(raw) {
		return false
	}
	var manifest struct {
		Permissions struct {
			Network     []json.RawMessage `json:"network"`
			Secrets     []json.RawMessage `json:"secrets"`
			Environment []json.RawMessage `json:"environment"`
			Filesystem  struct {
				Read  []json.RawMessage `json:"read"`
				Write []json.RawMessage `json:"write"`
			} `json:"filesystem"`
		} `json:"permissions"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return false
	}
	permissions := manifest.Permissions
	return len(permissions.Network) > 0 ||
		len(permissions.Secrets) > 0 ||
		len(permissions.Environment) > 0 ||
		len(permissions.Filesystem.Read) > 0 ||
		len(permissions.Filesystem.Write) > 0
}

func jsonArraysEqual(left []json.RawMessage, right []json.RawMessage) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if !jsonValuesEqual(left[index], right[index]) {
			return false
		}
	}
	return true
}

// jsonValuesEqual 按 JSON 语义比较（键序、空白差异不算修改；值或数组顺序变化算修改）。
//
// 不用原始字节比较：Node 的 clone/stringify 会重排转义与数字写法，
// 逐字节比较会把「原样保留字段」的正常候选误判成越权。
func jsonValuesEqual(left json.RawMessage, right json.RawMessage) bool {
	var leftValue any
	var rightValue any
	if json.Unmarshal(left, &leftValue) != nil || json.Unmarshal(right, &rightValue) != nil {
		return false
	}
	return reflect.DeepEqual(leftValue, rightValue)
}

func arrayContainsJSON(values []json.RawMessage, target json.RawMessage) bool {
	for _, value := range values {
		if jsonValuesEqual(value, target) {
			return true
		}
	}
	return false
}

func invalidState(detail string) error {
	return pluginerr.New(CodeStateInvalid, detail)
}

// RevisionConflictError 是 CAS 失败；Current 是写入时读到的权威 revision，
// 供 HTTP 层返回给调用方做重读/重试。
type RevisionConflictError struct {
	Current int64
}

// Error 返回与 Node 一致的领域错误码。
func (err *RevisionConflictError) Error() string { return CodeRevisionConflict }
