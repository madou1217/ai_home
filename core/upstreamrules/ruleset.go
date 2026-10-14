package upstreamrules

import (
	"encoding/json"
	"regexp"
	"strings"
)

// Rule 是一条已归一化并编译好的账号自定义上游错误规则。
type Rule struct {
	name     string
	kind     Kind
	enabled  bool
	statuses []int
	matchers []Matcher
	pattern  []*regexp.Regexp
	compiled bool
}

// Name 返回规则名称（仅用于诊断，不参与匹配）。
func (rule Rule) Name() string { return rule.name }

// Kind 返回命中后的目标状态。
func (rule Rule) Kind() Kind { return rule.kind }

// Enabled 返回规则是否生效。
func (rule Rule) Enabled() bool { return rule.enabled }

// Compiled 返回规则是否已通过编译，可直接参与匹配。
//
// 从 JSON 解出的规则在 Validate 之前一律视为未编译：未编译的规则绝不参与匹配
// （fail closed），避免「看起来生效但正则没编译」的静默失配。
func (rule Rule) Compiled() bool { return rule.compiled }

// Statuses 返回允许命中的 HTTP 状态码白名单；为空表示不限。
func (rule Rule) Statuses() []int {
	statuses := make([]int, len(rule.statuses))
	copy(statuses, rule.statuses)
	return statuses
}

// Matchers 返回规则的全部匹配条件。
func (rule Rule) Matchers() []Matcher {
	matchers := make([]Matcher, len(rule.matchers))
	copy(matchers, rule.matchers)
	return matchers
}

// NewRule 校验并编译一条规则。
func NewRule(
	name string,
	kind Kind,
	enabled bool,
	statuses []int,
	matchers []Matcher,
) (Rule, error) {
	return newRule(name, kind, enabled, statuses, matchers, true)
}

// newRule 统一构造规则：结构校验必做，正则编译可选。
//
// 编译可选是 Node 兼容的关键：Node 支持而 RE2 不支持的写法（如 lookbehind、命名
// 捕获组）必须在解码时通过，才能由 Validate 把它判成「本账号不可承接」并逐账号
// 丢弃，而不是让整份投影推送失败、所有账号一起退回 Node。
func newRule(
	name string,
	kind Kind,
	enabled bool,
	statuses []int,
	matchers []Matcher,
	compile bool,
) (Rule, error) {
	trimmedName := strings.TrimSpace(name)
	if len([]rune(trimmedName)) > MaxNameLength {
		return Rule{}, invalid("规则名称不能超过 %d 字", MaxNameLength)
	}
	if !validKind(kind) {
		return Rule{}, invalid("规则的目标状态无效")
	}
	normalizedStatuses, err := normalizeStatuses(statuses)
	if err != nil {
		return Rule{}, err
	}
	if len(matchers) == 0 || len(matchers) > MaxMatchers {
		return Rule{}, invalid("每条规则须有 1–%d 个错误匹配条件", MaxMatchers)
	}
	var compiled []*regexp.Regexp
	if compile {
		compiled = make([]*regexp.Regexp, len(matchers))
		for index, matcher := range matchers {
			pattern, compileErr := matcher.compile()
			if compileErr != nil {
				return Rule{}, compileErr
			}
			compiled[index] = pattern
		}
	}
	return Rule{
		name:     trimmedName,
		kind:     kind,
		enabled:  enabled,
		statuses: normalizedStatuses,
		matchers: matchers,
		pattern:  compiled,
		compiled: compile,
	}, nil
}

// Validate 校验规则集合并返回编译后的规则。
//
// 整体拒绝：任何一条生效规则非法时整份集合都不生效，避免部分应用让账号的异常
// 语义出现空洞（与 Node validateUpstreamErrorRules 的整体校验一致）。停用规则
// 不参与匹配，因此不要求能编译。
func Validate(rules []Rule) ([]Rule, error) {
	if len(rules) > MaxRules {
		return nil, invalid("异常规则最多 %d 条", MaxRules)
	}
	validated := make([]Rule, 0, len(rules))
	for _, rule := range rules {
		if !rule.Enabled() {
			validated = append(validated, Rule{
				name:     rule.name,
				kind:     rule.kind,
				enabled:  false,
				statuses: append([]int(nil), rule.statuses...),
				matchers: append([]Matcher(nil), rule.matchers...),
			})
			continue
		}
		compiled, err := NewRule(rule.name, rule.kind, true, rule.statuses, rule.matchers)
		if err != nil {
			return nil, err
		}
		validated = append(validated, compiled)
	}
	return validated, nil
}

// HasEnabledRule 判断规则集合里是否存在生效规则。
func HasEnabledRule(rules []Rule) bool {
	for _, rule := range rules {
		if rule.Enabled() {
			return true
		}
	}
	return false
}

// normalizeStatuses 去重并校验状态码白名单。
func normalizeStatuses(statuses []int) ([]int, error) {
	if len(statuses) > MaxStatuses {
		return nil, invalid("状态码须为 400–599 的整数数组")
	}
	seen := make(map[int]struct{}, len(statuses))
	normalized := make([]int, 0, len(statuses))
	for _, status := range statuses {
		if status < 400 || status > 599 {
			return nil, invalid("状态码须为 400–599 的整数数组")
		}
		if _, ok := seen[status]; ok {
			continue
		}
		seen[status] = struct{}{}
		normalized = append(normalized, status)
	}
	return normalized, nil
}

// UnmarshalJSON 严格解析 Node 归一化后的规则对象。
//
// 只做结构校验（字段、取值、长度、状态码、路径语法），不编译正则：编译发生在
// Validate，因此 Node 支持而 RE2 不支持的写法会变成「本账号不可承接」而不是
// 让整份投影推送失败。
func (rule *Rule) UnmarshalJSON(data []byte) error {
	var wire struct {
		Name     *string           `json:"name"`
		Kind     string            `json:"kind"`
		Enabled  *bool             `json:"enabled"`
		Statuses []json.RawMessage `json:"statuses"`
		Matchers []json.RawMessage `json:"matchers"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return invalid("规则格式无效")
	}
	name := ""
	if wire.Name != nil {
		name = *wire.Name
	}
	statuses := make([]int, 0, len(wire.Statuses))
	for _, raw := range wire.Statuses {
		status, err := decodeStatus(raw)
		if err != nil {
			return err
		}
		statuses = append(statuses, status)
	}
	matchers := make([]Matcher, 0, len(wire.Matchers))
	for _, raw := range wire.Matchers {
		matcher, err := decodeMatcher(raw)
		if err != nil {
			return err
		}
		matchers = append(matchers, matcher)
	}
	parsed, err := newRule(
		name,
		Kind(wire.Kind),
		wire.Enabled == nil || *wire.Enabled,
		statuses,
		matchers,
		false,
	)
	if err != nil {
		return err
	}
	*rule = parsed
	return nil
}

// MarshalJSON 输出与 Node 归一化格式一致的对象，供只读诊断使用。
func (rule Rule) MarshalJSON() ([]byte, error) {
	matchers := make([]map[string]any, 0, len(rule.matchers))
	for _, matcher := range rule.matchers {
		matchers = append(matchers, matcher.wire())
	}
	statuses := rule.statuses
	if statuses == nil {
		statuses = []int{}
	}
	return json.Marshal(map[string]any{
		"name":     rule.name,
		"kind":     string(rule.kind),
		"enabled":  rule.enabled,
		"statuses": statuses,
		"matchers": matchers,
	})
}

// wire 输出单个匹配条件的 Node 兼容对象。
func (matcher Matcher) wire() map[string]any {
	if matcher.legacy {
		return map[string]any{"field": string(matcher.field), "pattern": matcher.pattern}
	}
	value := map[string]any{
		"source":   string(matcher.source),
		"operator": string(matcher.operator),
		"value":    matcher.value,
	}
	if matcher.source == SourceJSON {
		value["path"] = matcher.path
	}
	return value
}

// NormalizeJSONPath 校验点路径并返回路径段。
func NormalizeJSONPath(path string) ([]string, error) {
	value := strings.TrimSpace(path)
	if value == "" || len([]rune(value)) > MaxPathLength ||
		strings.HasPrefix(value, ".") || strings.HasSuffix(value, ".") ||
		strings.Contains(value, "..") {
		return nil, invalid("JSON 路径须为 1–%d 字符的点路径", MaxPathLength)
	}
	bracketed := jsonIndexPattern.ReplaceAllString(value, ".$1")
	segments := strings.Split(bracketed, ".")
	if len(segments) > MaxPathSegments {
		return nil, invalid("JSON 路径只支持对象键和数组下标")
	}
	for _, segment := range segments {
		if !jsonPathSegmentPattern.MatchString(segment) {
			return nil, invalid("JSON 路径只支持对象键和数组下标")
		}
	}
	return segments, nil
}

// jsonIndexPattern 把 [0] 形式的下标规范成点路径段。
var jsonIndexPattern = regexp.MustCompile(`\[([0-9]+)\]`)

// jsonPathSegmentPattern 限定路径段只能是对象键或数组下标。
var jsonPathSegmentPattern = regexp.MustCompile(`^(?:[A-Za-z_$][A-Za-z0-9_$]*|[0-9]+)$`)
