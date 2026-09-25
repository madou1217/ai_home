package codeassist

import "strings"

// 工具 schema 在 Code Assist 线路上的「可投递形状」，与 Node 的 lib/server/gemini-schema.js +
// code-assist-tool-schema.js 保持一致。
//
// schema 进入 Gemini Schema proto；目标是 Claude 家族时上游还会翻回 Anthropic input_schema。
// 这条往返比 JSON Schema 窄，实测硬限制：
//   - 非白名单关键字、`$` 前缀（$schema/$ref/$defs）会被拒；
//   - enum 只能是字符串（proto 是 repeated string）；
//   - Claude 目标上 anyOf 必定 400（补同级 type 也救不回来），只能发出前折叠；
//   - 顶层空 schema 报 input_schema.type 缺失，根必须是 object。

var geminiSchemaScalarKeys = map[string]bool{
	"type": true, "format": true, "title": true, "description": true, "nullable": true,
	"enum": true, "required": true, "minimum": true, "maximum": true, "minItems": true,
	"maxItems": true, "minLength": true, "maxLength": true, "minProperties": true,
	"maxProperties": true, "pattern": true, "example": true, "default": true,
	"propertyOrdering": true,
}

// normalizeToolSchema 清洗 schema，Claude 目标再折叠联合类型，并保证根为 object。
func normalizeToolSchema(schema map[string]any, flattenUnions bool) map[string]any {
	sanitized, _ := sanitizeGeminiSchema(schema).(map[string]any)
	if flattenUnions {
		sanitized, _ = flattenSchemaUnions(sanitized).(map[string]any)
	}
	if sanitized == nil {
		sanitized = map[string]any{}
	}
	if typeName, ok := sanitized["type"].(string); !ok || typeName == "" {
		sanitized["type"] = "object"
	}
	return sanitized
}

func sanitizeGeminiSchema(value any) any {
	switch typed := value.(type) {
	case []any:
		items := sanitizeSchemaArray(typed)
		if len(items) > 0 {
			return items[0]
		}
		return map[string]any{}
	case map[string]any:
		return sanitizeSchemaObject(typed)
	default:
		return value
	}
}

func sanitizeSchemaObject(schema map[string]any) map[string]any {
	result := make(map[string]any, len(schema))
	for key, value := range schema {
		if key == "" || strings.HasPrefix(key, "$") {
			continue
		}
		switch key {
		case "type":
			result["type"] = normalizeSchemaType(value)
		case "properties":
			if properties := sanitizeProperties(value); properties != nil {
				result["properties"] = properties
			}
		case "items":
			if sanitized, ok := sanitizeGeminiSchema(value).(map[string]any); ok && len(sanitized) > 0 {
				result["items"] = sanitized
			}
		case "additionalProperties":
			if flag, ok := value.(bool); ok {
				result["additionalProperties"] = flag
			} else if nested, ok := value.(map[string]any); ok {
				if sanitized := sanitizeSchemaObject(nested); len(sanitized) > 0 {
					result["additionalProperties"] = sanitized
				}
			}
		case "anyOf":
			if branches, ok := value.([]any); ok {
				if items := sanitizeSchemaArray(branches); len(items) > 0 {
					result["anyOf"] = items
				}
			}
		case "required", "propertyOrdering":
			if items := sanitizeStringArray(value); items != nil {
				result[key] = items
			}
		case "enum":
			if items := sanitizeEnum(value); items != nil {
				result["enum"] = items
			}
		default:
			if geminiSchemaScalarKeys[key] {
				result[key] = value
			}
		}
	}
	return result
}

// normalizeSchemaType 把 ["string","null"] 这类联合类型收敛为首个非 null 类型。
func normalizeSchemaType(value any) any {
	list, ok := value.([]any)
	if !ok {
		return value
	}
	for _, item := range list {
		if text, ok := item.(string); ok && strings.TrimSpace(text) != "" && !strings.EqualFold(strings.TrimSpace(text), "null") {
			return strings.TrimSpace(text)
		}
	}
	return "string"
}

func sanitizeProperties(value any) map[string]any {
	source, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	properties := make(map[string]any, len(source))
	for name, propertySchema := range source {
		if sanitized, ok := sanitizeGeminiSchema(propertySchema).(map[string]any); ok && len(sanitized) > 0 {
			properties[name] = sanitized
		}
	}
	if len(properties) == 0 {
		return nil
	}
	return properties
}

func sanitizeSchemaArray(values []any) []any {
	items := make([]any, 0, len(values))
	for _, value := range values {
		if sanitized, ok := sanitizeGeminiSchema(value).(map[string]any); ok && len(sanitized) > 0 {
			items = append(items, sanitized)
		}
	}
	return items
}

func sanitizeStringArray(value any) []any {
	list, ok := value.([]any)
	if !ok {
		return nil
	}
	items := make([]any, 0, len(list))
	for _, item := range list {
		if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
			items = append(items, strings.TrimSpace(text))
		}
	}
	if len(items) == 0 {
		return nil
	}
	return items
}

// sanitizeEnum 全是字符串才保留；出现非字符串整条丢掉（少一个约束好过请求发不出去）。
func sanitizeEnum(value any) []any {
	list, ok := value.([]any)
	if !ok {
		return nil
	}
	items := make([]any, 0, len(list))
	for _, item := range list {
		text, ok := item.(string)
		if !ok {
			return nil
		}
		if trimmed := strings.TrimSpace(text); trimmed != "" {
			items = append(items, trimmed)
		}
	}
	if len(items) == 0 {
		return nil
	}
	return items
}

var mergeableBranchKeys = []string{"properties", "items", "required", "additionalProperties"}

// flattenSchemaUnions 把 anyOf 折叠进宿主节点（递归到 properties / items / additionalProperties）。
func flattenSchemaUnions(value any) any {
	node, ok := value.(map[string]any)
	if !ok {
		return value
	}
	if branches, ok := node["anyOf"].([]any); ok {
		node = flattenUnionNode(node, branches)
		if _, still := node["anyOf"]; still {
			return flattenSchemaUnions(node)
		}
	} else {
		copied := make(map[string]any, len(node))
		for key, item := range node {
			copied[key] = item
		}
		node = copied
	}
	if properties, ok := node["properties"].(map[string]any); ok {
		flattened := make(map[string]any, len(properties))
		for name, property := range properties {
			flattened[name] = flattenSchemaUnions(property)
		}
		node["properties"] = flattened
	}
	if items, ok := node["items"]; ok {
		node["items"] = flattenSchemaUnions(items)
	}
	if nested, ok := node["additionalProperties"].(map[string]any); ok {
		node["additionalProperties"] = flattenSchemaUnions(nested)
	}
	return node
}

func flattenUnionNode(node map[string]any, rawBranches []any) map[string]any {
	flattened := make(map[string]any, len(node))
	for key, item := range node {
		if key != "anyOf" {
			flattened[key] = item
		}
	}
	branches := make([]map[string]any, 0, len(rawBranches))
	for _, branch := range rawBranches {
		if object, ok := branch.(map[string]any); ok {
			branches = append(branches, object)
		}
	}
	if len(branches) == 0 {
		return flattened
	}
	// 分支类型一致才继承；不一致或有分支没写 type 时输出无 type 节点（上游收得下，失真更小）。
	if unified := unifiedBranchType(branches); unified != "" {
		if _, ok := flattened["type"].(string); !ok {
			flattened["type"] = unified
		}
	} else {
		delete(flattened, "type")
	}
	if _, ok := flattened["enum"]; !ok {
		if merged := mergeBranchEnums(branches); merged != nil {
			flattened["enum"] = merged
		}
	}
	for _, key := range mergeableBranchKeys {
		if _, ok := flattened[key]; ok {
			continue
		}
		for _, branch := range branches {
			if value, ok := branch[key]; ok {
				flattened[key] = value
				break
			}
		}
	}
	return flattened
}

func unifiedBranchType(branches []map[string]any) string {
	first := ""
	for index, branch := range branches {
		typeName, ok := branch["type"].(string)
		if !ok || typeName == "" {
			return ""
		}
		if index == 0 {
			first = typeName
		} else if typeName != first {
			return ""
		}
	}
	return first
}

// mergeBranchEnums 只有每个分支都有 enum 时取值集合才封闭；否则整条 enum 丢掉，
// 以免把合法值（如 TaskUpdate.status 的 deleted）判为非法。
func mergeBranchEnums(branches []map[string]any) []any {
	merged := make([]any, 0)
	seen := make(map[any]bool)
	for _, branch := range branches {
		values, ok := branch["enum"].([]any)
		if !ok {
			return nil
		}
		for _, value := range values {
			if !seen[value] {
				seen[value] = true
				merged = append(merged, value)
			}
		}
	}
	if len(merged) == 0 {
		return nil
	}
	return merged
}
