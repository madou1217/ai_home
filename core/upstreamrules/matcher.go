package upstreamrules

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Matcher 是一条匹配条件，只表达 Node 已公开的两种形态。
//
// 旧版形态使用 Field + Pattern；结构化形态使用 Source + Operator（+ Path）+ Value。
type Matcher struct {
	source   Source
	operator Operator
	path     string
	value    any
	field    Field
	pattern  string
	legacy   bool
}

// Source 返回结构化匹配来源；旧版形态返回空。
func (matcher Matcher) Source() Source { return matcher.source }

// Operator 返回匹配方式；旧版形态返回空。
func (matcher Matcher) Operator() Operator { return matcher.operator }

// Path 返回 JSON 点路径；非 json 来源返回空。
func (matcher Matcher) Path() string { return matcher.path }

// Value 返回匹配值。
func (matcher Matcher) Value() any { return matcher.value }

// Field 返回旧版匹配字段。
func (matcher Matcher) Field() Field { return matcher.field }

// Pattern 返回旧版正则文本。
func (matcher Matcher) Pattern() string { return matcher.pattern }

// IsLegacy 判断是否使用旧版 field/pattern 形态。
func (matcher Matcher) IsLegacy() bool { return matcher.legacy }

// decodeMatcher 解析单条匹配条件，并区分旧版与结构化形态。
func decodeMatcher(raw json.RawMessage) (Matcher, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || len(fields) == 0 {
		return Matcher{}, invalid("错误匹配条件格式无效")
	}
	if _, ok := fields["field"]; ok {
		return decodeLegacyMatcher(fields)
	}
	if _, ok := fields["pattern"]; ok {
		return decodeLegacyMatcher(fields)
	}
	return decodeStructuredMatcher(fields)
}

// decodeLegacyMatcher 解析旧版 field/pattern 形态。
func decodeLegacyMatcher(fields map[string]json.RawMessage) (Matcher, error) {
	for key := range fields {
		if key != "field" && key != "pattern" {
			return Matcher{}, invalid("错误匹配条件格式无效")
		}
	}
	field := ""
	pattern := ""
	if raw, ok := fields["field"]; ok {
		if err := json.Unmarshal(raw, &field); err != nil {
			return Matcher{}, invalid("错误字段须为 code、type、message 或 body")
		}
	}
	if raw, ok := fields["pattern"]; ok {
		if err := json.Unmarshal(raw, &pattern); err != nil {

			return Matcher{}, invalid("错误匹配条件格式无效")
		}
	}
	switch Field(field) {
	case FieldCode, FieldType, FieldMessage, FieldBody:
	default:
		return Matcher{}, invalid("错误字段须为 code、type、message 或 body")
	}
	if err := validatePattern(pattern); err != nil {
		return Matcher{}, err
	}
	return Matcher{field: Field(field), pattern: pattern, legacy: true}, nil
}

// decodeStructuredMatcher 解析 source/operator/value 形态。
func decodeStructuredMatcher(fields map[string]json.RawMessage) (Matcher, error) {
	for key := range fields {
		switch key {
		case "source", "operator", "value", "path":
		default:
			return Matcher{}, invalid("错误匹配条件格式无效")
		}
	}
	raw, ok := fields["value"]
	if !ok {
		return Matcher{}, invalid("请输入匹配值")
	}
	source := ""
	operator := ""
	path := ""
	if err := decodeOptionalString(fields, "source", &source); err != nil {
		return Matcher{}, err
	}
	if err := decodeOptionalString(fields, "operator", &operator); err != nil {
		return Matcher{}, err
	}
	if err := decodeOptionalString(fields, "path", &path); err != nil {
		return Matcher{}, err
	}
	normalizedSource := Source(strings.ToLower(strings.TrimSpace(source)))
	switch normalizedSource {
	case SourceHTTPCode, SourceBody, SourceJSON:
	default:
		return Matcher{}, invalid("匹配来源须为 http_code、body 或 json")
	}
	normalizedOperator := Operator(strings.ToLower(strings.TrimSpace(operator)))
	switch normalizedOperator {
	case OperatorRegex, OperatorContains, OperatorEquals:
	default:
		return Matcher{}, invalid("匹配方式须为 regex、contains 或 equals")
	}
	value, err := decodeMatcherValue(raw)
	if err != nil {
		return Matcher{}, err
	}
	matcher := Matcher{
		source:   normalizedSource,
		operator: normalizedOperator,
		value:    value,
	}
	if normalizedSource == SourceJSON {
		segments, pathErr := NormalizeJSONPath(path)
		if pathErr != nil {
			return Matcher{}, pathErr
		}
		matcher.path = strings.Join(segments, ".")
	}
	if normalizedOperator == OperatorRegex {
		// 只校验长度：正则编译发生在 Validate，Node 支持而 RE2 不支持的写法
		// 必须能通过解码，才能被逐账号丢弃而不是让整份投影推送失败。
		if patternErr := validatePattern(TextOf(value)); patternErr != nil {
			return Matcher{}, patternErr
		}
	}
	if normalizedSource == SourceHTTPCode && normalizedOperator == OperatorEquals {
		code, ok := jsNumber(value)
		if !ok || code != math.Trunc(code) || code < 100 || code > 599 {
			return Matcher{}, invalid("HTTP 状态码须为 100–599 的整数")
		}
		matcher.value = int(code)
	}
	return matcher, nil
}

// jsNumber 复刻 JavaScript Number() 对标量输入的转换。
//
// 空串与 null 为 0，数字字符串按十进制解析，复合值不可转换。十六进制字符串等
// JS 特例不在这里支持：规则表单不会产生这类匹配值。
func jsNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case nil:
		return 0, true
	case bool:
		if typed {
			return 1, true
		}
		return 0, true
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return typed, true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) {
			return 0, false
		}
		return parsed, true
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0, true
		}
		parsed, err := strconv.ParseFloat(trimmed, 64)
		if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

// decodeOptionalString 读取可缺省的字符串字段。
func decodeOptionalString(fields map[string]json.RawMessage, key string, destination *string) error {
	raw, ok := fields[key]
	if !ok {
		return nil
	}
	if err := json.Unmarshal(raw, destination); err != nil {
		return invalid("错误匹配条件格式无效")
	}
	return nil
}

// decodeStatus 解析状态码白名单项。
func decodeStatus(raw json.RawMessage) (int, error) {
	value, err := decodeScalar(raw)
	if err != nil {
		return 0, invalid("状态码须为 400–599 的整数数组")
	}
	code, ok := IntegerValue(value)
	if !ok {
		return 0, invalid("状态码须为 400–599 的整数数组")
	}
	return code, nil
}

// decodeMatcherValue 解析匹配值，只接受标量。
func decodeMatcherValue(raw json.RawMessage) (any, error) {
	value, err := decodeScalar(raw)
	if err != nil {
		return nil, invalid("匹配值必须是字符串、数字、布尔值或 null")
	}
	switch typed := value.(type) {
	case nil:
		return nil, nil
	case string:
		if len([]rune(typed)) > MaxValueLength {
			return nil, invalid("匹配值不能超过 %d 字符", MaxValueLength)
		}
		return typed, nil
	case bool:
		return typed, nil
	case json.Number:
		number, numberErr := typed.Float64()
		if numberErr != nil || math.IsInf(number, 0) || math.IsNaN(number) {
			return nil, invalid("匹配值必须是有限数字")
		}
		return number, nil
	default:
		return nil, invalid("匹配值必须是字符串、数字、布尔值或 null")
	}
}

// decodeScalar 用 json.Number 解析单个 JSON 标量，拒绝复合值。
func decodeScalar(raw json.RawMessage) (any, error) {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, ErrInvalidRules
	}
	switch value.(type) {
	case nil, string, bool, json.Number:
		return value, nil
	default:
		return nil, ErrInvalidRules
	}
}

// compile 编译一条匹配条件；旧版与结构化正则共用同一编译路径。
func (matcher Matcher) compile() (*regexp.Regexp, error) {
	if matcher.legacy {
		return compilePattern(matcher.pattern)
	}
	if matcher.operator != OperatorRegex {
		return nil, nil
	}
	return compilePattern(TextOf(matcher.value))
}

// compilePattern 编译大小写不敏感正则；Go RE2 保证线性匹配时间。
//
// Node 侧另有反灾难性回溯的白名单校验（禁分组、禁反向引用）；这里不再重复实现：
// RE2 不存在回溯，而 Node 拒绝过的规则永远不会被推送过来。
func compilePattern(pattern string) (*regexp.Regexp, error) {
	if err := validatePattern(pattern); err != nil {
		return nil, err
	}
	compiled, err := regexp.Compile("(?i)" + pattern)
	if err != nil {
		return nil, invalid("正则表达式无效")
	}
	return compiled, nil
}

// validatePattern 校验正则文本长度。
func validatePattern(pattern string) error {
	length := len([]rune(pattern))
	if length == 0 || length > MaxPatternLength {
		return invalid("正则长度须为 1–%d", MaxPatternLength)
	}
	return nil
}

// IntegerValue 把 JSON 标量转成整数，非整数标量返回 false。
func IntegerValue(value any) (int, bool) {
	switch typed := value.(type) {
	case int:
		return typed, true
	case int64:
		return int(typed), true
	case float64:
		if typed != math.Trunc(typed) || math.IsInf(typed, 0) || math.IsNaN(typed) {
			return 0, false
		}
		return int(typed), true
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			return 0, false
		}
		return int(parsed), true
	default:
		return 0, false
	}
}

// TextOf 把 JSON 标量渲染成与 JavaScript String() 一致的文本。
//
// 复合值（对象、数组）在 Node 侧会渲染为 "[object Object]" 或逗号连接，实际规则
// 表单不会产生这种匹配值；这里统一渲染为紧凑 JSON，只影响人工构造的病态配置。
func TextOf(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		return strconv.FormatFloat(typed, 'g', -1, 64)
	case json.Number:
		return typed.String()
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return ""
		}
		return string(encoded)
	}
}
