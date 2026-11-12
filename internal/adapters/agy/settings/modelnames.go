package settings

import "strings"

// agyCLIModelAliases 是 agy 内部模型 id 与 CLI 显示名的对照表。
//
// 唯一真值仍是 Node lib/runtime/agy-model-names.js 的 CLI_NAME_BY_ID；这里逐项同序复制，
// 因为 agy 的两套命名必须在一处转换：
//   - agy `--model <x>` 只认显示名，写内部 id 直接报 "not recognized as a known model"；
//   - aih 内部与额度快照（usageSnapshot.models[].model）用的是 id。
//
// 自愈写入的缺省值是显示名列表的第一项，所以**声明顺序就是默认优先级**，不要重排。
// 新增/变更模型 = 改这张表（需要时补别名），调用方不动。
var agyCLIModelAliases = []struct {
	ID   string
	Name string
}{
	{"gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"},
	{"gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"},
	// 别名：同一显示名对应两个内部 id（Node CLI_NAME_BY_ID 同款）。
	{"gemini-3.8-flash-tiered", "Gemini 3.8 Flash (Medium)"},
	{"gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"},
	{"claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"},
	{"claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"},
	{"gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"},
}

// agyCLINameByID 是「内部 id → 显示名」索表。
var agyCLINameByID = func() map[string]string {
	names := make(map[string]string, len(agyCLIModelAliases))
	for _, alias := range agyCLIModelAliases {
		names[alias.ID] = alias.Name
	}
	return names
}()

// agyCLINames 是按声明顺序去重的显示名列表（对应 Node CLI_NAMES）。
// healAgySettingsModel 的缺省值取 listAgyCliModelNames()[0]，即这里的第一项。
var agyCLINames = func() []string {
	names := make([]string, 0, len(agyCLIModelAliases))
	seen := make(map[string]bool, len(agyCLIModelAliases))
	for _, alias := range agyCLIModelAliases {
		if seen[alias.Name] {
			continue
		}
		seen[alias.Name] = true
		names = append(names, alias.Name)
	}
	return names
}()

// ResolveModelName 把内部模型 id 译成 CLI 显示名；已经是显示名则原样返回；都无法识别返回空串。
// 对应 Node resolveAgyCliModelName（含去首尾空白）。
func ResolveModelName(value string) string {
	text := strings.TrimSpace(value)
	if text == "" {
		return ""
	}
	if name, found := agyCLINameByID[text]; found {
		return name
	}
	for _, name := range agyCLINames {
		if name == text {
			return text
		}
	}
	return ""
}

// ListModelNames 返回全部合法显示名（按声明顺序）；返回副本，调用方修改不影响内部表。
// 对应 Node listAgyCliModelNames。
func ListModelNames() []string {
	return append([]string(nil), agyCLINames...)
}

// DefaultModelName 返回自愈时使用的缺省显示名，即 Node healAgySettingsModel 里的
// listAgyCliModelNames()[0]（注意不是 DEFAULT_PREFERENCE 的首项 "Gemini 3.8 Flash (Low)"）。
func DefaultModelName() string {
	if len(agyCLINames) == 0 {
		return ""
	}
	return agyCLINames[0]
}
