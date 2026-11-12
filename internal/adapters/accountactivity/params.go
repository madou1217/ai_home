package accountactivity

// 活动参数的类型适配器（Go 侧唯一认识参数语义的地方）。
//
// 与 lib/account/activity-claim/params.js 逐条对应：
//   account-refs —— 账号引用列表；空数组 = 不过滤（全部账号）
//   enum         —— 枚举；取值来自声明里的 options 或 kinds
//   string       —— 自由文本（上限 128）
//   boolean      —— 开关
//
// 返回值一律结构化，不抛异常：调度层要把「参数非法」写成 400 响应，
// 而不是让请求崩成 500。未知 key 直接丢弃 —— 声明才是唯一真相。

import (
	"sort"
	"strings"
)

// MaxParamStringLength 与 Node 的 MAX_STRING_LENGTH 一致。
const MaxParamStringLength = 128

func textOf(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	default:
		return ""
	}
}

func isBlankParam(value any) bool {
	switch typed := value.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(typed) == ""
	case []any:
		return len(typed) == 0
	case []string:
		return len(typed) == 0
	default:
		return false
	}
}

func enumValuesOf(field ParamField, action Action) []string {
	if len(field.Options) > 0 {
		values := make([]string, 0, len(field.Options))
		for _, option := range field.Options {
			values = append(values, option.Value)
		}
		return values
	}
	if field.OptionsFrom == "kinds" {
		values := make([]string, 0, len(action.Kinds))
		for _, kind := range action.Kinds {
			values = append(values, kind.ID)
		}
		return values
	}
	return nil
}

// NormalizeParams 按声明归一参数；返回的错误码与 Node 完全同形。
func NormalizeParams(action Action, raw map[string]any) (map[string]any, string) {
	if len(action.Params) == 0 {
		return map[string]any{}, ""
	}
	params := make(map[string]any, len(action.Params))
	for _, field := range action.Params {
		incoming := raw[field.Key]
		if isBlankParam(incoming) && field.Required {
			return nil, "activity_param_required:" + field.Key
		}
		switch field.Type {
		case "account-refs":
			refs := normalizeAccountRefs(incoming)
			if field.MaxItems > 0 && len(refs) > field.MaxItems {
				return nil, "activity_param_too_many:" + field.Key
			}
			if len(refs) > 0 {
				params[field.Key] = refs
			}
		case "enum":
			value := textOf(incoming)
			if value != "" {
				allowed := enumValuesOf(field, action)
				if len(allowed) > 0 && !containsString(allowed, value) {
					return nil, "activity_param_value_invalid:" + field.Key
				}
				params[field.Key] = value
			}
		case "string":
			value := textOf(incoming)
			if len(value) > MaxParamStringLength {
				return nil, "activity_param_too_long:" + field.Key
			}
			if value != "" {
				params[field.Key] = value
			}
		case "boolean":
			if incoming == true {
				params[field.Key] = true
			}
		default:
			return nil, "activity_param_type_unknown:" + field.Key
		}
	}
	return params, ""
}

func normalizeAccountRefs(value any) []string {
	var raw []string
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			raw = append(raw, textOf(item))
		}
	case []string:
		raw = append(raw, typed...)
	default:
		return nil
	}
	seen := make(map[string]struct{}, len(raw))
	refs := make([]string, 0, len(raw))
	for _, item := range raw {
		ref := strings.TrimSpace(item)
		if ref == "" {
			continue
		}
		if _, duplicated := seen[ref]; duplicated {
			continue
		}
		seen[ref] = struct{}{}
		refs = append(refs, ref)
	}
	sort.Strings(refs)
	return refs
}

// ResolveTargets 把 account-refs 过滤器作用到账号清单上。
// 返回保留下来的账号与「请求里给了但账号不存在」的引用（调用方写成失败结果，不静默少跑）。
func ResolveTargets(action Action, params map[string]any, accountRefs []string) ([]string, []string) {
	current := append([]string(nil), accountRefs...)
	var unknown []string
	for _, field := range action.Params {
		if field.Type != "account-refs" {
			continue
		}
		wanted, ok := params[field.Key].([]string)
		if !ok || len(wanted) == 0 {
			continue
		}
		wantedSet := make(map[string]struct{}, len(wanted))
		for _, ref := range wanted {
			wantedSet[ref] = struct{}{}
		}
		kept := make([]string, 0, len(current))
		present := make(map[string]struct{}, len(current))
		for _, ref := range current {
			if _, ok := wantedSet[ref]; !ok {
				continue
			}
			kept = append(kept, ref)
			present[ref] = struct{}{}
		}
		for _, ref := range wanted {
			if _, ok := present[ref]; !ok {
				unknown = append(unknown, ref)
			}
		}
		current = kept
	}
	return current, dedupeStrings(unknown)
}

// DescribeParams 给 UI 用的字段清单：去掉执行细节，只留渲染需要的东西。
func DescribeParams(action Action) []map[string]any {
	fields := make([]map[string]any, 0, len(action.Params))
	for _, field := range action.Params {
		view := map[string]any{
			"key":         field.Key,
			"label":       field.Label,
			"type":        field.Type,
			"description": field.Description,
			"required":    field.Required,
			"emptyMeans":  emptyMeansOf(field),
		}
		if field.MaxItems > 0 {
			view["maxItems"] = field.MaxItems
		}
		if len(field.Options) > 0 {
			options := make([]map[string]any, 0, len(field.Options))
			for _, option := range field.Options {
				options = append(options, map[string]any{
					"value":       option.Value,
					"label":       option.Label,
					"description": option.Description,
				})
			}
			view["options"] = options
		}
		if field.OptionsFrom != "" {
			view["optionsFrom"] = field.OptionsFrom
		}
		fields = append(fields, view)
	}
	return fields
}

func emptyMeansOf(field ParamField) string {
	if field.EmptyMeans == "" {
		return "any"
	}
	return field.EmptyMeans
}

// DescribeKinds 把探测到的 plan 列表折算成「类型目录」。
//
// 每个 plan 只归一个类型（按声明顺序首个命中）：start_plan 的前缀规则会匹配到
// 周末活动那个 plan，逐个 kind 独立求值会让同一个 plan 出现在两个类型下。
func DescribeKinds(kinds []Kind, plans []map[string]any, hasPlans bool) []map[string]any {
	matchedByKind := make(map[string][]map[string]any, len(kinds))
	for _, kind := range kinds {
		matchedByKind[kind.ID] = nil
	}
	if hasPlans {
		for _, plan := range plans {
			kindID := ClassifyPlan(plan, kinds)
			if kindID == "" {
				continue
			}
			matchedByKind[kindID] = append(matchedByKind[kindID], plan)
		}
	}
	views := make([]map[string]any, 0, len(kinds))
	for _, kind := range kinds {
		view := map[string]any{
			"id":          kind.ID,
			"label":       kind.Label,
			"description": kind.Description,
			"planIds":     []string{},
		}
		if hasPlans {
			matched := matchedByKind[kind.ID]
			view["claimable"] = len(matched) > 0
			planIDs := make([]string, 0, len(matched))
			for _, plan := range matched {
				planID := textOf(plan["planId"])
				if planID == "" {
					planID = textOf(plan["plan_id"])
				}
				if planID != "" {
					planIDs = append(planIDs, planID)
				}
			}
			view["planIds"] = dedupeStrings(planIDs)
		}
		views = append(views, view)
	}
	return views
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func dedupeStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	deduped := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		deduped = append(deduped, value)
	}
	return deduped
}
