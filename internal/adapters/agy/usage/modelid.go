package usage

import (
	"encoding/json"
	"strings"
)

// 本文件移植 Node 的两处模型 ID 规则：
//
//	lib/server/model-id.js                     isRealProviderModelId / isInternalModelEnumId / isNonModelResourceId
//	lib/server/code-assist-model-registry.js   stripCodeAssistModelSuffix / MODEL_ID_FIELDS 顺序 / readPublicModelId
//
// 配额文档的 models[] 是「可请求模型」清单：内部枚举（MODEL_*）、编辑器资源
// （chat_* / tab_* / models/*）、占位条目与 * 通配对选号与账号页都没有意义，
// 必须按 Node 同一判据排除，否则会把不可请求的条目当成可用模型。

// modelVertexSuffix 是 Vertex 后端的内部版本后缀；Node stripCodeAssistModelSuffix
// 用 /_vertex$/i 去掉它（只用于数组形态的模型条目，对象键保持原样）。
const modelVertexSuffix = "_vertex"

// modelIDFields 与 Node code-assist-model-registry 的 MODEL_ID_FIELDS 同序。
// 顺序即优先级：同时存在 id 与 model 时 Node 取 id。
var modelIDFields = []string{"id", "model", "modelId", "model_id", "newModelId", "new_model_id"}

// objectModelIDFields 与 Node normalizeQuotaModel 的兜底顺序同序（对象形态的键为空时）。
var objectModelIDFields = []string{"model", "id", "modelId", "model_id"}

// stripCodeAssistModelSuffix 去掉大小写不敏感的 _vertex 后缀。
func stripCodeAssistModelSuffix(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= len(modelVertexSuffix) &&
		strings.EqualFold(value[len(value)-len(modelVertexSuffix):], modelVertexSuffix) {
		return value[:len(value)-len(modelVertexSuffix)]
	}
	return value
}

// isInternalModelEnumID 复刻 Node isInternalModelEnumId：去掉 _vertex 后匹配
// ^MODEL_[A-Z0-9_]+$。只认全大写枚举，MODEL_ 开头但含小写字母的值不是内部枚举。
func isInternalModelEnumID(value string) bool {
	base := stripCodeAssistModelSuffix(value)
	const prefix = "MODEL_"
	if !strings.HasPrefix(base, prefix) || len(base) == len(prefix) {
		return false
	}
	for _, character := range base[len(prefix):] {
		if character == '_' ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') {
			continue
		}
		return false
	}
	return true
}

// isNonModelResourceID 复刻 Node isNonModelResourceId：
// ^chat_[a-z0-9]+$、^tab_[a-z0-9_]+$（都带锚点，chat_x_y 不算）、models/ 前缀、
// 以及 proactive-observer / placeholder 两个占位标记。
func isNonModelResourceID(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if hasSuffixAlphabet(normalized, "chat_", "abcdefghijklmnopqrstuvwxyz0123456789") {
		return true
	}
	if hasSuffixAlphabet(normalized, "tab_", "abcdefghijklmnopqrstuvwxyz0123456789_") {
		return true
	}
	if strings.HasPrefix(normalized, "models/") {
		return true
	}
	return strings.Contains(normalized, "proactive-observer") ||
		strings.Contains(normalized, "placeholder")
}

// hasSuffixAlphabet 判断 value 是否为 prefix + 至少一个 alphabet 内字符（等价于带锚点的正则）。
func hasSuffixAlphabet(value string, prefix string, alphabet string) bool {
	if !strings.HasPrefix(value, prefix) || len(value) == len(prefix) {
		return false
	}
	for _, character := range value[len(prefix):] {
		if !strings.ContainsRune(alphabet, character) {
			return false
		}
	}
	return true
}

// isRealProviderModelID 复刻 Node isRealProviderModelId：非空、无 *、不是内部枚举、
// 不是编辑器资源。它不负责「能否进入 Go 运行态索引」，那一层由 parseQuotaModel 另判。
func isRealProviderModelID(value string) bool {
	id := strings.TrimSpace(value)
	if id == "" || strings.Contains(id, "*") {
		return false
	}
	if isInternalModelEnumID(id) {
		return false
	}
	return !isNonModelResourceID(id)
}

// readStringField 复刻 Node readStringField：先按原始字段名取，再按归一字段名
// （去分隔符、小写）匹配。只接受字符串值，缺失/null/空串都继续找下一个。
func readStringField(source map[string]json.RawMessage, fieldNames ...string) string {
	if source == nil {
		return ""
	}
	for _, fieldName := range fieldNames {
		if text := readText(source[fieldName]); text != "" {
			return text
		}
	}
	for key, raw := range source {
		normalized := normalizeFieldName(key)
		for _, fieldName := range fieldNames {
			if normalized != normalizeFieldName(fieldName) {
				continue
			}
			if text := readText(raw); text != "" {
				return text
			}
		}
	}
	return ""
}

// readPublicModelID 复刻 Node readPublicModelId（当前上下文没有容器键时的等价形态）：
// 按 MODEL_ID_FIELDS 顺序取候选项，去 _vertex 后缀后第一个真实模型 ID 胜出。
func readPublicModelID(source map[string]json.RawMessage) string {
	for _, candidate := range []string{readStringField(source, modelIDFields...)} {
		id := stripCodeAssistModelSuffix(candidate)
		if id != "" && isRealProviderModelID(id) {
			return id
		}
	}
	return ""
}

// objectModelID 复刻 Node normalizeQuotaModel 的模型名取值：对象键优先，
// 键为空时才回退到条目里的 model/id/modelId/model_id（这条路径不做 _vertex 去后缀）。
func objectModelID(key string, info map[string]json.RawMessage) string {
	if key = strings.TrimSpace(key); key != "" {
		return key
	}
	for _, fieldName := range objectModelIDFields {
		if text := readStringField(info, fieldName); text != "" {
			return text
		}
	}
	return ""
}

// normalizeFieldName 复刻 Node normalizeFieldName：去掉非字母数字分隔符并小写。
func normalizeFieldName(value string) string {
	var builder strings.Builder
	builder.Grow(len(value))
	for _, character := range strings.ToLower(strings.TrimSpace(value)) {
		switch {
		case character >= 'a' && character <= 'z',
			character >= '0' && character <= '9':
			builder.WriteRune(character)
		}
	}
	return builder.String()
}

// maxQuotaEntryKeyLength 与 core/accountusage 的 maxIdentifierLength 同值：
// 额度条目的 bucket / scopeKey 超过这个长度会让整份快照无效。
const maxQuotaEntryKeyLength = 128

// validQuotaEntryKey 判断模型 ID 转小写后能否作为 Go 额度条目的 bucket / scopeKey。
//
// core/accountusage 的标识符只接受 [a-z0-9_.:-]；不满足的 ID（大写以外还有 + / @ 等）
// 会让整份 NewSnapshot 失败。Node 没有这层约束，但让一次刷新因为一个奇异模型 ID 全军
// 覆没代价更大，所以在这里丢掉单条模型（文档也只保留能进快照的模型）。
func validQuotaEntryKey(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" || len(normalized) > maxQuotaEntryKeyLength {
		return false
	}
	for index := 0; index < len(normalized); index++ {
		current := normalized[index]
		if (current >= 'a' && current <= 'z') ||
			(current >= '0' && current <= '9') ||
			current == '_' || current == '-' || current == '.' || current == ':' {
			continue
		}
		return false
	}
	return true
}
