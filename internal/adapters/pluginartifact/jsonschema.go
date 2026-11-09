package pluginartifact

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

// Schema 是 draft-07 JSON Schema 的一个受限实现。
//
// 为什么不是通用实现：Go 侧没有可用的 JSON Schema 依赖（离线构建），而安装校验
// 不能接受「未校验的清单」。这里只实现插件合同实际用到、以及配置 schema 最常用的
// 关键字；遇到未实现的关键字在编译期直接拒绝（fail closed），而不是静默忽略——
// 静默忽略会让一份带校验约束的 configSchema 在 Go 侧变成空壳。
type Schema struct {
	root any
}

// SchemaValidationError 汇总一次校验失败的原因。
type SchemaValidationError struct {
	Errors []string
}

func (err *SchemaValidationError) Error() string {
	return strings.Join(err.Errors, "；")
}

var supportedTypes = map[string]bool{
	"null": true, "boolean": true, "object": true, "array": true,
	"number": true, "integer": true, "string": true,
}

var annotationKeywords = map[string]bool{
	"$schema": true, "$id": true, "$comment": true, "title": true, "description": true,
	"default": true, "examples": true, "readOnly": true, "writeOnly": true, "deprecated": true,
}

// CompileSchema 解析并静态检查一份 JSON Schema。任何语法或关键字结构问题都在这里失败。
func CompileSchema(data []byte) (*Schema, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var root any
	if err := decoder.Decode(&root); err != nil {
		return nil, fmt.Errorf("schema 不是合法 JSON: %w", err)
	}
	if decoder.More() {
		return nil, fmt.Errorf("schema 含多余内容")
	}
	if err := inspectSchema(root, root, "#"); err != nil {
		return nil, err
	}
	return &Schema{root: root}, nil
}

// Validate 校验一个已解码的 JSON 值；成功返回 nil。
func (schema *Schema) Validate(value any) error {
	if schema == nil {
		return fmt.Errorf("schema 不可用")
	}
	var problems []string
	validateSchemaNode(schema.root, value, schema.root, "", &problems)
	if len(problems) > 0 {
		return &SchemaValidationError{Errors: problems}
	}
	return nil
}

func inspectSchema(node any, root any, at string) error {
	switch schema := node.(type) {
	case bool:
		return nil
	case map[string]any:
		if refValue, present := schema["$ref"]; present {
			ref, ok := refValue.(string)
			if !ok {
				return fmt.Errorf("%s/$ref 必须是字符串", at)
			}
			// draft-07：$ref 的兄弟关键字被忽略，因此只校验引用目标存在。
			if _, err := resolveRef(root, ref); err != nil {
				return fmt.Errorf("%s: %w", at, err)
			}
			return nil
		}
		for keyword, value := range schema {
			if annotationKeywords[keyword] {
				continue
			}
			switch keyword {
			case "definitions":
				definitions, ok := value.(map[string]any)
				if !ok {
					return fmt.Errorf("%s/definitions 必须是对象", at)
				}
				for name, child := range definitions {
					if err := inspectSchema(child, root, at+"/definitions/"+name); err != nil {
						return err
					}
				}
			case "type":
				if err := inspectTypeKeyword(value); err != nil {
					return fmt.Errorf("%s/type: %w", at, err)
				}
			case "properties":
				properties, ok := value.(map[string]any)
				if !ok {
					return fmt.Errorf("%s/properties 必须是对象", at)
				}
				for name, child := range properties {
					if err := inspectSchema(child, root, at+"/properties/"+name); err != nil {
						return err
					}
				}
			case "additionalProperties":
				if err := inspectSchemaOrBool(value, root, at+"/additionalProperties"); err != nil {
					return err
				}
			case "items":
				// 只支持「所有元素同一 schema」；tuple 形式（数组）未实现，直接拒绝。
				if err := inspectSubschema(value); err != nil {
					return fmt.Errorf("%s/items: %w", at, err)
				}
				if err := inspectSchema(value, root, at+"/items"); err != nil {
					return err
				}
			case "additionalItems":
				if _, ok := value.(bool); !ok {
					return fmt.Errorf("%s/additionalItems 只支持布尔值", at)
				}
			case "required":
				if _, ok := stringArray(value); !ok {
					return fmt.Errorf("%s/required 必须是字符串数组", at)
				}
			case "enum":
				values, ok := value.([]any)
				if !ok || len(values) == 0 {
					return fmt.Errorf("%s/enum 必须是非空数组", at)
				}
			case "const":
				// 任意 JSON 值。
			case "pattern":
				pattern, ok := value.(string)
				if !ok {
					return fmt.Errorf("%s/pattern 必须是字符串", at)
				}
				if _, err := regexp.Compile(pattern); err != nil {
					return fmt.Errorf("%s/pattern 无法编译: %w", at, err)
				}
			case "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties":
				count, ok := nonNegativeInteger(value)
				if !ok {
					return fmt.Errorf("%s/%s 必须是非负整数", at, keyword)
				}
				_ = count
			case "uniqueItems":
				if _, ok := value.(bool); !ok {
					return fmt.Errorf("%s/uniqueItems 必须是布尔值", at)
				}
			case "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum":
				if _, ok := numberValue(value); !ok {
					return fmt.Errorf("%s/%s 必须是数字", at, keyword)
				}
			case "multipleOf":
				number, ok := numberValue(value)
				if !ok || number <= 0 {
					return fmt.Errorf("%s/multipleOf 必须是正数", at)
				}
			case "allOf", "anyOf", "oneOf":
				children, ok := value.([]any)
				if !ok || len(children) == 0 {
					return fmt.Errorf("%s/%s 必须是非空数组", at, keyword)
				}
				for index, child := range children {
					if err := inspectSubschema(child); err != nil {
						return fmt.Errorf("%s/%s/%d: %w", at, keyword, index, err)
					}
					if err := inspectSchema(child, root, fmt.Sprintf("%s/%s/%d", at, keyword, index)); err != nil {
						return err
					}
				}
			case "not":
				if err := inspectSubschema(value); err != nil {
					return fmt.Errorf("%s/not: %w", at, err)
				}
				if err := inspectSchema(value, root, at+"/not"); err != nil {
					return err
				}
			default:
				return fmt.Errorf("%s 含未实现的 JSON Schema 关键字 %q", at, keyword)
			}
		}
		return nil
	default:
		return fmt.Errorf("%s 必须是对象或布尔值", at)
	}
}

func inspectSubschema(value any) error {
	switch value.(type) {
	case bool, map[string]any:
		return nil
	default:
		return fmt.Errorf("子 schema 必须是对象或布尔值")
	}
}

func inspectSchemaOrBool(value any, root any, at string) error {
	switch value.(type) {
	case bool:
		return nil
	case map[string]any:
		return inspectSchema(value, root, at)
	default:
		return fmt.Errorf("%s 必须是对象或布尔值", at)
	}
}

func inspectTypeKeyword(value any) error {
	switch typed := value.(type) {
	case string:
		if !supportedTypes[typed] {
			return fmt.Errorf("未知类型 %q", typed)
		}
		return nil
	case []any:
		if len(typed) == 0 {
			return fmt.Errorf("类型数组不能为空")
		}
		for _, item := range typed {
			name, ok := item.(string)
			if !ok || !supportedTypes[name] {
				return fmt.Errorf("未知类型 %v", item)
			}
		}
		return nil
	default:
		return fmt.Errorf("必须是字符串或字符串数组")
	}
}

func validateSchemaNode(node any, value any, root any, path string, problems *[]string) {
	switch schema := node.(type) {
	case bool:
		if !schema {
			*problems = append(*problems, pathOrRoot(path)+" 不允许任何值")
		}
	case map[string]any:
		if refValue, present := schema["$ref"]; present {
			ref, ok := refValue.(string)
			if !ok {
				*problems = append(*problems, pathOrRoot(path)+" $ref 无效")
				return
			}
			target, err := resolveRef(root, ref)
			if err != nil {
				*problems = append(*problems, pathOrRoot(path)+" $ref 无法解析")
				return
			}
			validateSchemaNode(target, value, root, path, problems)
			return
		}
		if typeValue, present := schema["type"]; present {
			if !matchesType(typeValue, value) {
				*problems = append(*problems, pathOrRoot(path)+" 类型不符合要求")
				return
			}
		}
		if constValue, present := schema["const"]; present && !jsonEqual(constValue, value) {
			*problems = append(*problems, pathOrRoot(path)+" 不等于 const")
		}
		if enumValue, present := schema["enum"]; present {
			values, ok := enumValue.([]any)
			if ok {
				matched := false
				for _, candidate := range values {
					if jsonEqual(candidate, value) {
						matched = true
						break
					}
				}
				if !matched {
					*problems = append(*problems, pathOrRoot(path)+" 不在 enum 中")
				}
			}
		}
		switch typed := value.(type) {
		case string:
			validateString(schema, typed, path, problems)
		case json.Number, float64:
			validateNumber(schema, value, path, problems)
		case []any:
			validateArray(schema, typed, root, path, problems)
		case map[string]any:
			validateObject(schema, typed, root, path, problems)
		}
		validateCombinators(schema, value, root, path, problems)
	}
}

func validateString(schema map[string]any, value string, path string, problems *[]string) {
	length := utf16Length(value)
	if limit, ok := nonNegativeInteger(schema["minLength"]); ok && length < limit {
		*problems = append(*problems, pathOrRoot(path)+" 长度小于 minLength")
	}
	if limit, ok := nonNegativeInteger(schema["maxLength"]); ok && length > limit {
		*problems = append(*problems, pathOrRoot(path)+" 长度超过 maxLength")
	}
	if patternValue, present := schema["pattern"]; present {
		if pattern, ok := patternValue.(string); ok {
			if compiled, err := regexp.Compile(pattern); err == nil && !compiled.MatchString(value) {
				*problems = append(*problems, pathOrRoot(path)+" 不匹配 pattern")
			}
		}
	}
}

func validateNumber(schema map[string]any, value any, path string, problems *[]string) {
	number, ok := numberValue(value)
	if !ok {
		return
	}
	if minimum, ok := numberValue(schema["minimum"]); ok && number < minimum {
		*problems = append(*problems, pathOrRoot(path)+" 小于 minimum")
	}
	if maximum, ok := numberValue(schema["maximum"]); ok && number > maximum {
		*problems = append(*problems, pathOrRoot(path)+" 大于 maximum")
	}
	if minimum, ok := numberValue(schema["exclusiveMinimum"]); ok && number <= minimum {
		*problems = append(*problems, pathOrRoot(path)+" 不大于 exclusiveMinimum")
	}
	if maximum, ok := numberValue(schema["exclusiveMaximum"]); ok && number >= maximum {
		*problems = append(*problems, pathOrRoot(path)+" 不小于 exclusiveMaximum")
	}
	if multiple, ok := numberValue(schema["multipleOf"]); ok && multiple > 0 {
		quotient := number / multiple
		if math.Abs(quotient-math.Round(quotient)) > 1e-9 {
			*problems = append(*problems, pathOrRoot(path)+" 不是 multipleOf 的整数倍")
		}
	}
}

func validateArray(schema map[string]any, value []any, root any, path string, problems *[]string) {
	if limit, ok := nonNegativeInteger(schema["minItems"]); ok && len(value) < limit {
		*problems = append(*problems, pathOrRoot(path)+" 元素少于 minItems")
	}
	if limit, ok := nonNegativeInteger(schema["maxItems"]); ok && len(value) > limit {
		*problems = append(*problems, pathOrRoot(path)+" 元素超过 maxItems")
	}
	if unique, ok := schema["uniqueItems"].(bool); ok && unique {
		for index := 0; index < len(value); index++ {
			for other := index + 1; other < len(value); other++ {
				if jsonEqual(value[index], value[other]) {
					*problems = append(*problems, pathOrRoot(path)+" 存在重复元素")
					index = len(value)
					break
				}
			}
		}
	}
	if items, present := schema["items"]; present {
		for index, item := range value {
			validateSchemaNode(items, item, root, path+"/"+strconv.Itoa(index), problems)
		}
	}
}

func validateObject(schema map[string]any, value map[string]any, root any, path string, problems *[]string) {
	if required, ok := stringArray(schema["required"]); ok {
		for _, name := range required {
			if _, present := value[name]; !present {
				*problems = append(*problems, pathOrRoot(path)+" 缺少必需字段 "+name)
			}
		}
	}
	if limit, ok := nonNegativeInteger(schema["minProperties"]); ok && len(value) < limit {
		*problems = append(*problems, pathOrRoot(path)+" 属性少于 minProperties")
	}
	if limit, ok := nonNegativeInteger(schema["maxProperties"]); ok && len(value) > limit {
		*problems = append(*problems, pathOrRoot(path)+" 属性超过 maxProperties")
	}
	properties, _ := schema["properties"].(map[string]any)
	for name, child := range properties {
		if propertyValue, present := value[name]; present {
			validateSchemaNode(child, propertyValue, root, path+"/"+name, problems)
		}
	}
	if additional, present := schema["additionalProperties"]; present {
		for name, propertyValue := range value {
			if _, known := properties[name]; known {
				continue
			}
			switch rule := additional.(type) {
			case bool:
				if !rule {
					*problems = append(*problems, pathOrRoot(path)+" 不允许字段 "+name)
				}
			default:
				validateSchemaNode(rule, propertyValue, root, path+"/"+name, problems)
			}
		}
	}
}

func validateCombinators(schema map[string]any, value any, root any, path string, problems *[]string) {
	if allOf, ok := schema["allOf"].([]any); ok {
		for _, child := range allOf {
			validateSchemaNode(child, value, root, path, problems)
		}
	}
	if anyOf, ok := schema["anyOf"].([]any); ok {
		matched := false
		for _, child := range anyOf {
			var childProblems []string
			validateSchemaNode(child, value, root, path, &childProblems)
			if len(childProblems) == 0 {
				matched = true
				break
			}
		}
		if !matched {
			*problems = append(*problems, pathOrRoot(path)+" 不满足 anyOf")
		}
	}
	if oneOf, ok := schema["oneOf"].([]any); ok {
		matches := 0
		for _, child := range oneOf {
			var childProblems []string
			validateSchemaNode(child, value, root, path, &childProblems)
			if len(childProblems) == 0 {
				matches++
			}
		}
		if matches != 1 {
			*problems = append(*problems, pathOrRoot(path)+" 不满足 oneOf")
		}
	}
	if not, present := schema["not"]; present {
		var childProblems []string
		validateSchemaNode(not, value, root, path, &childProblems)
		if len(childProblems) == 0 {
			*problems = append(*problems, pathOrRoot(path)+" 命中了 not")
		}
	}
}

func matchesType(typeValue any, value any) bool {
	switch typed := typeValue.(type) {
	case string:
		return matchesSingleType(typed, value)
	case []any:
		for _, item := range typed {
			if name, ok := item.(string); ok && matchesSingleType(name, value) {
				return true
			}
		}
	}
	return false
}

func matchesSingleType(name string, value any) bool {
	switch name {
	case "null":
		return value == nil
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "object":
		_, ok := value.(map[string]any)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	case "string":
		_, ok := value.(string)
		return ok
	case "number":
		_, ok := numberValue(value)
		return ok
	case "integer":
		number, ok := numberValue(value)
		return ok && math.Trunc(number) == number
	}
	return false
}

func resolveRef(root any, ref string) (any, error) {
	if ref == "#" {
		return root, nil
	}
	if !strings.HasPrefix(ref, "#/") {
		return nil, fmt.Errorf("只支持本地 $ref")
	}
	current := root
	for _, token := range strings.Split(strings.TrimPrefix(ref, "#/"), "/") {
		name := strings.ReplaceAll(strings.ReplaceAll(token, "~1", "/"), "~0", "~")
		object, ok := current.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("$ref 路径不存在")
		}
		next, present := object[name]
		if !present {
			return nil, fmt.Errorf("$ref 路径不存在")
		}
		current = next
	}
	return current, nil
}

func stringArray(value any) ([]string, bool) {
	items, ok := value.([]any)
	if !ok {
		return nil, false
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			return nil, false
		}
		result = append(result, text)
	}
	return result, true
}

func nonNegativeInteger(value any) (int, bool) {
	number, ok := numberValue(value)
	if !ok || number < 0 || math.Trunc(number) != number || number > math.MaxInt32 {
		return 0, false
	}
	return int(number), true
}

func numberValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return 0, false
		}
		return parsed, true
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	}
	return 0, false
}

func jsonEqual(left any, right any) bool {
	leftNumber, leftIsNumber := numberValue(left)
	rightNumber, rightIsNumber := numberValue(right)
	if leftIsNumber || rightIsNumber {
		return leftIsNumber && rightIsNumber && leftNumber == rightNumber
	}
	switch typed := left.(type) {
	case nil:
		return right == nil
	case bool:
		other, ok := right.(bool)
		return ok && typed == other
	case string:
		other, ok := right.(string)
		return ok && typed == other
	case []any:
		other, ok := right.([]any)
		if !ok || len(typed) != len(other) {
			return false
		}
		for index := range typed {
			if !jsonEqual(typed[index], other[index]) {
				return false
			}
		}
		return true
	case map[string]any:
		other, ok := right.(map[string]any)
		if !ok || len(typed) != len(other) {
			return false
		}
		for key, item := range typed {
			otherItem, present := other[key]
			if !present || !jsonEqual(item, otherItem) {
				return false
			}
		}
		return true
	}
	return false
}

func utf16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func pathOrRoot(path string) string {
	if path == "" {
		return "/"
	}
	return path
}
