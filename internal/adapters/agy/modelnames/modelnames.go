// Package modelnames 是 agy 内部模型 id ↔ CLI 显示名的唯一真值表。
//
// Node 来源：lib/runtime/agy-model-names.js（CLI_NAME_BY_ID / CLI_NAMES）。
// 之前 settings 与 sessionchat 各存一份，已经出现漂移风险；两处统一引用本包。
//
// 为什么两套命名必须在一处转换：
//   - agy `--model <x>` 只认显示名，写内部 id 会报 "not recognized as a known model"；
//   - aih 内部与额度快照用的是内部 id。
package modelnames

import "strings"

// alias 是一条 id→显示名映射；声明顺序就是默认优先级。
type alias struct {
	ID   string
	Name string
}

// aliases 与 Node CLI_NAME_BY_ID 逐项同序。
var aliases = []alias{
	{"gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"},
	{"gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"},
	// 别名：同一显示名对应两个内部 id（Node CLI_NAME_BY_ID 同款）。
	{"gemini-3.8-flash-tiered", "Gemini 3.8 Flash (Medium)"},
	{"gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"},
	{"claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"},
	{"claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"},
	{"gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"},
}

var nameByID = func() map[string]string {
	names := make(map[string]string, len(aliases))
	for _, item := range aliases {
		names[item.ID] = item.Name
	}
	return names
}()

// names 是按声明顺序去重的显示名列表（对应 Node CLI_NAMES）。
var names = func() []string {
	list := make([]string, 0, len(aliases))
	seen := make(map[string]bool, len(aliases))
	for _, item := range aliases {
		if seen[item.Name] {
			continue
		}
		seen[item.Name] = true
		list = append(list, item.Name)
	}
	return list
}()

// Resolve 把内部 id 译成 CLI 显示名；已经是显示名则原样返回；无法识别返回空串。
func Resolve(value string) string {
	text := strings.TrimSpace(value)
	if text == "" {
		return ""
	}
	if name, found := nameByID[text]; found {
		return name
	}
	for _, name := range names {
		if name == text {
			return text
		}
	}
	return ""
}

// List 返回全部合法显示名（按声明顺序）的副本。
func List() []string {
	return append([]string(nil), names...)
}

// Default 返回自愈使用的缺省显示名（列表第一项，Node listAgyCliModelNames()[0]）。
func Default() string {
	if len(names) == 0 {
		return ""
	}
	return names[0]
}
