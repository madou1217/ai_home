// Package agymodelnames 是 agy 内部模型 id ↔ CLI 显示名的唯一真值表。
//
// Node 来源：lib/runtime/agy-model-names.js（CLI_NAME_BY_ID / CLI_NAMES）。
// 表放在应用层契约里，是因为它被多个入站方向共用：agy 设置自愈、CLI 会话启动、
// 以及额度快照的模型窗口门禁（快照按显示名记录，调度按内部 id 查询）。
// 任何一层需要 id↔显示名转换时都依赖本契约，不再各自持有副本。
//
// 为什么两套命名必须在一处转换：
//   - agy `--model <x>` 只认显示名，写内部 id 会报 "not recognized as a known model"；
//   - aih 内部与额度快照用的是内部 id。
package agymodelnames

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

// namesOnly 是 CLI 已确认接受、但本仓库还没有内部 id 映射的显示名。
//
// 来源是本机 antigravity-cli 的设置变更记录与运行日志（2026-11-11/12）：
// 用户在这些会话里切换到过这些模型，设置文件也保存过 Claude Opus 5.5 (High)。
// 它们只作为配置候选项使用，不参与 id 反查；拿到新版本 CLI 的 `agy models`
// 输出后应把它们补成完整的 id↔显示名映射。
var namesOnly = []string{
	"Gemini 4 Carbon (High)",
	"Gemini 4 Carbon (Medium)",
	"Gemini 4 Argon (High)",
	"Gemini 4 Argon (Medium)",
	"Claude Opus 5.5 (High)",
}

var nameByID = func() map[string]string {
	names := make(map[string]string, len(aliases))
	for _, item := range aliases {
		names[item.ID] = item.Name
	}
	return names
}()

// names 是按声明顺序去重的显示名列表（对应 Node CLI_NAMES，再追加 namesOnly）。
var names = func() []string {
	list := make([]string, 0, len(aliases)+len(namesOnly))
	seen := make(map[string]bool, len(aliases)+len(namesOnly))
	add := func(name string) {
		if name == "" || seen[name] {
			return
		}
		seen[name] = true
		list = append(list, name)
	}
	for _, item := range aliases {
		add(item.Name)
	}
	for _, name := range namesOnly {
		add(name)
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
//
// 这里包含 CLI 已确认接受、但当前尚未建立内部 id 映射的 namesOnly；
// Provider 配置目录需要展示这些真实可接受的值。
func List() []string {
	return append([]string(nil), names...)
}

// ListMapped 返回已有内部 id 映射的显示名。
//
// 旧的设置自愈接口只应从可做 id↔显示名闭环的集合中选默认值；
// namesOnly 可以作为人工配置候选，但不能成为没有内部 id 反查的自愈默认值。
func ListMapped() []string {
	list := make([]string, 0, len(aliases))
	seen := make(map[string]struct{}, len(aliases))
	for _, item := range aliases {
		if _, exists := seen[item.Name]; exists {
			continue
		}
		seen[item.Name] = struct{}{}
		list = append(list, item.Name)
	}
	return list
}

// Default 返回 Provider 配置目录使用的首个合法显示名。
func Default() string {
	if len(names) == 0 {
		return ""
	}
	return names[0]
}

// DefaultMapped 返回设置自愈使用的首个已映射显示名。
func DefaultMapped() string {
	mapped := ListMapped()
	if len(mapped) == 0 {
		return ""
	}
	return mapped[0]
}
