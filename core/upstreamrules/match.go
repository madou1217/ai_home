package upstreamrules

import (
	"math"
	"regexp"
	"strings"
)

// Match 返回第一条命中的生效规则。
//
// 与 Node matchUpstreamErrorRule 语义一致：先构造观察投影，再按顺序取第一条
// 「状态码白名单允许且全部匹配条件成立」的规则；没有失败证据时返回 false。
func Match(rules []Rule, statusCode int, body []byte) (Rule, bool) {
	index, matched := MatchIndex(rules, statusCode, body)
	if !matched {
		return Rule{}, false
	}
	return rules[index], true
}

// MatchIndex 返回第一条命中规则的下标，供诊断与一致性测试使用。
//
// 未编译的规则一律跳过：从 JSON 解出的规则必须先经 Validate 才能参与匹配，
// 否则「生效但未编译」的规则会静默失配。
func MatchIndex(rules []Rule, statusCode int, body []byte) (int, bool) {
	if len(rules) == 0 {
		return -1, false
	}
	observation, observed := Observe(statusCode, body)
	if !observed {
		return -1, false
	}
	for index, rule := range rules {
		if !rule.Enabled() || !rule.compiled {
			continue
		}
		if len(rule.statuses) > 0 && !containsStatus(rule.statuses, statusCode) {
			continue
		}
		if rule.matches(observation) {
			return index, true
		}
	}
	return -1, false
}

// matches 判断规则的每条匹配条件是否全部成立。
func (rule Rule) matches(observation Observation) bool {
	for index, matcher := range rule.matchers {
		var pattern = rule.patternAt(index)
		if !matcher.matches(observation, pattern) {
			return false
		}
	}
	return true
}

// patternAt 返回预编译正则；越界或未编译时返回 nil。
func (rule Rule) patternAt(index int) *regexp.Regexp {
	if index < 0 || index >= len(rule.pattern) {
		return nil
	}
	return rule.pattern[index]
}

// matches 判断单条匹配条件是否成立。
func (matcher Matcher) matches(observation Observation, pattern *regexp.Regexp) bool {
	if matcher.legacy {
		return pattern != nil && pattern.MatchString(observationField(observation, matcher.field))
	}
	value := matcher.observationValue(observation)
	switch matcher.operator {
	case OperatorEquals:
		return valuesEqual(value, matcher.value)
	case OperatorContains:
		return strings.Contains(TextOf(value), TextOf(matcher.value))
	case OperatorRegex:
		if pattern == nil {
			return false
		}
		return pattern.MatchString(TextOf(value))
	default:
		return false
	}
}

// observationValue 按来源取出参与匹配的值。
func (matcher Matcher) observationValue(observation Observation) any {
	switch matcher.source {
	case SourceHTTPCode:
		return observation.httpCode
	case SourceJSON:
		return ReadJSONPath(observation.payload, matcher.path)
	default:
		return observation.body
	}
}

// observationField 取出旧版字段对应的观察文本。
func observationField(observation Observation, field Field) string {
	switch field {
	case FieldCode:
		return observation.code
	case FieldType:
		return observation.typeName
	case FieldMessage:
		return observation.message
	default:
		return observation.body
	}
}

// ReadJSONPath 按点路径读取 JSON 值；缺失返回 nil。
func ReadJSONPath(value any, path string) any {
	segments, err := NormalizeJSONPath(path)
	if err != nil {
		return nil
	}
	current := value
	for _, segment := range segments {
		switch typed := current.(type) {
		case map[string]any:
			next, ok := typed[segment]
			if !ok {
				return nil
			}
			current = next
		case []any:
			index, ok := arrayIndex(segment)
			if !ok || index < 0 || index >= len(typed) {
				return nil
			}
			current = typed[index]
		default:
			return nil
		}
	}
	return current
}

// valuesEqual 复刻 Node valuesEqual 的比较语义。
func valuesEqual(actual any, expected any) bool {
	if actual == nil || expected == nil {
		return actual == nil && expected == nil
	}
	if expectedNumber, ok := jsNumber(expected); ok {
		actualNumber, actualOk := jsNumber(actual)
		return actualOk && actualNumber == expectedNumber
	}
	return TextOf(actual) == TextOf(expected)
}

// containsStatus 判断状态码是否在白名单内。
func containsStatus(statuses []int, statusCode int) bool {
	for _, status := range statuses {
		if status == statusCode {
			return true
		}
	}
	return false
}

// arrayIndex 把数组下标段解析为整数，与 JavaScript 的数字字符串下标一致。
func arrayIndex(segment string) (int, bool) {
	number, ok := jsNumber(segment)
	if !ok || number != math.Trunc(number) {
		return 0, false
	}
	return int(number), true
}
