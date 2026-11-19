// Package harnessrun 在 Go 中实现 `aih harness`：按 Node 的
// lib/cli/commands/harness/router.js 与 lib/harness/* 语义解析参数、选账号、
// 准备外部 harness 投影（pi / dsh / dsh-tui）并启动。
//
// 为什么单独成包：CLI 派发（cmd/aih）只应做组合，不承载投影文件、模型目录与
// 子进程生命周期。本包不依赖 Node，运行时也不会调用 Node 脚本以外的任何
// Node 模块。
package harnessrun

import (
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/core/harnesses"
)

// helpText 与 Node lib/cli/commands/harness/router.js 的 HELP 逐字一致。
const helpText = `aih harness — 用某个 Provider 的某个账号跑外部 harness（请求经本地网关转发）

用法：
  aih harness                                   列出可用的 harness
  aih harness <id> [选项] [-- 原生参数...]        启动

选项：
  --provider <p>    身份 Provider（codex / claude / codebuddycn …）
  --account <n|ref> 账号：CLI 账号 id（1、2…）或 accountRef（acct_…）
  --model <m>       模型别名或原名（默认取该账号的默认模型）
  --model-alias <m> 本次启动的临时改写：--model 给的模型改用 <m>（不落库）
  --json            只打印解析结果（harness / provider / accountRef / model）
  --list            同 aih harness
  -h, --help        本帮助

例：
  aih harness pi --provider codex --account 2
  aih harness dsh-tui --provider codebuddycn --account 1 --model sonnet
`

// displayDescriptions 覆盖 core/harnesses 与 Node 描述文案的差异。
//
// Node 的 EXTERNAL_HARNESSES 描述是列表输出的一部分；Go 注册表目前只保留
// 简短版（dsh 少了「终端 TUI 为树外 profile…」）。列表面向用户且需要与 Node
// 逐字一致，因此在展示层覆盖；后续把该字段合并回 core/harnesses 后可删除。
var displayDescriptions = map[string]string{
	"dsh": "DeepSeek 官方开源 Agent Harness（web profile；终端 TUI 为树外 profile，与 web 共享同一安装与升级）",
}

type harnessView struct {
	ID          string
	Label       string
	Description string
}

// harnessViews 返回按注册表顺序排列的展示条目。
func harnessViews() []harnessView {
	items := harnesses.List()
	views := make([]harnessView, 0, len(items))
	for _, item := range items {
		description := item.Description
		if override, ok := displayDescriptions[item.ID]; ok {
			description = override
		}
		views = append(views, harnessView{
			ID:          item.ID,
			Label:       item.Label,
			Description: description,
		})
	}
	return views
}

// formatHarnessList 与 Node formatHarnessList 逐字一致（末尾无换行）。
func formatHarnessList(views []harnessView) string {
	lines := []string{"外部 harness（通过本地 AIH 网关使用 Provider 账号）：", ""}
	for _, view := range views {
		suffix := ""
		if view.Description != "" {
			suffix = " — " + view.Description
		}
		lines = append(lines, fmt.Sprintf("  %-10s %s%s", view.ID, view.Label, suffix))
	}
	lines = append(lines, "")
	lines = append(lines, "用法：aih harness <id> --provider <p> [--account <n|ref>] [--model <m>]")
	return strings.Join(lines, "\n")
}

// parsedArgs 是 parseHarnessArgs 的结果。
type parsedArgs struct {
	HarnessID  string
	Provider   string
	Account    string
	Model      string
	ModelAlias string
	JSON       bool
	List       bool
	Help       bool
	NativeArgs []string
}

// parseHarnessArgs 复刻 Node 的纯解析函数（不读盘）。
//
// 关键细节（与 Node 保持一致，补全与用户脚本可能依赖这些边界）：
//   - `--` 之后一律原样进入 nativeArgs；
//   - `--list` / `--json` 只摘第一个；
//   - `--provider value` 会吞掉下一个 token（即使它以 `--` 开头）；
//   - `--provider=value` 移除所有逐字相同的 inline token；
//   - 两者同时出现时，空格形式优先。
func parseHarnessArgs(argv []string) parsedArgs {
	rest := append([]string(nil), argv...)
	result := parsedArgs{NativeArgs: []string{}}

	if separator := indexOfToken(rest, "--"); separator >= 0 {
		result.NativeArgs = append(result.NativeArgs, rest[separator+1:]...)
		rest = rest[:separator]
	}

	if containsToken(rest, "-h") || containsToken(rest, "--help") ||
		(len(rest) > 0 && rest[0] == "help") {
		result.Help = true
	}
	var present bool
	rest, present = takeFlag(rest, "--list")
	result.List = present
	rest, present = takeFlag(rest, "--json")
	result.JSON = present

	for _, name := range []string{"--provider", "--account", "--model", "--model-alias"} {
		var value string
		rest, value = takeValue(rest, name)
		var inlineValue string
		rest, inlineValue = takeInlineValue(rest, name)
		if value == "" {
			value = inlineValue
		}
		switch name {
		case "--provider":
			result.Provider = strings.ToLower(value)
		case "--account":
			result.Account = value
		case "--model":
			result.Model = value
		case "--model-alias":
			result.ModelAlias = value
		}
	}

	// `--account codex:2` 简写：省掉 --provider，账号自带身份。
	if result.Provider == "" && strings.Contains(result.Account, ":") {
		parts := strings.Split(result.Account, ":")
		providerPart := strings.TrimSpace(parts[0])
		accountPart := strings.TrimSpace(strings.Join(parts[1:], ":"))
		if providerPart != "" && accountPart != "" {
			result.Provider = strings.ToLower(providerPart)
			result.Account = accountPart
		}
	}

	if len(rest) > 0 {
		result.HarnessID = strings.ToLower(strings.TrimSpace(rest[0]))
	}
	return result
}

func indexOfToken(tokens []string, name string) int {
	for index, token := range tokens {
		if token == name {
			return index
		}
	}
	return -1
}

func containsToken(tokens []string, name string) bool {
	return indexOfToken(tokens, name) >= 0
}

// takeValue 摘掉第一个 `name` 及其后一个 token，返回剩余参数与值。
func takeValue(tokens []string, name string) ([]string, string) {
	index := indexOfToken(tokens, name)
	if index < 0 {
		return tokens, ""
	}
	value := ""
	if index+1 < len(tokens) {
		value = tokens[index+1]
	}
	next := make([]string, 0, len(tokens)-1)
	next = append(next, tokens[:index]...)
	if index+2 <= len(tokens) {
		next = append(next, tokens[index+2:]...)
	}
	return next, value
}

// takeInlineValue 摘掉第一个 `name=value` 形式及其全部逐字重复项。
func takeInlineValue(tokens []string, name string) ([]string, string) {
	prefix := name + "="
	inlineIndex := -1
	for index, token := range tokens {
		if strings.HasPrefix(token, prefix) {
			inlineIndex = index
			break
		}
	}
	if inlineIndex < 0 {
		return tokens, ""
	}
	inline := tokens[inlineIndex]
	value := strings.TrimPrefix(inline, prefix)
	next := make([]string, 0, len(tokens))
	for _, token := range tokens {
		if token != inline {
			next = append(next, token)
		}
	}
	return next, value
}

// takeFlag 摘掉第一个 `name`。
func takeFlag(tokens []string, name string) ([]string, bool) {
	index := indexOfToken(tokens, name)
	if index < 0 {
		return tokens, false
	}
	next := make([]string, 0, len(tokens)-1)
	next = append(next, tokens[:index]...)
	next = append(next, tokens[index+1:]...)
	return next, true
}
