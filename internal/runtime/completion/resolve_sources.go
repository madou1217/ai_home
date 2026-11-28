package completion

import (
	"fmt"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/harnesses"
)

func addHistoryCandidates(target *collector, context *resolverContext, current, priorText string) {
	if len(context.historyEntries) == 0 {
		return
	}
	limit := context.historyLimit
	if limit <= 0 {
		limit = 8
	}
	trimmed := strings.TrimSpace(current)
	for _, entry := range listHistoryRemainders(context.historyEntries, priorText, current, limit) {
		// 和当前词一模一样的整行没有补全价值，只会占位置。
		if entry.Suffix == trimmed {
			continue
		}
		target.add(entry.Suffix, fmt.Sprintf("用过 %d 次", entry.Count), groupHistory, "")
	}
}

func addSessionFlags(target *collector, provider string) {
	for _, flag := range providerSessionFlags(provider) {
		target.add(flag.Name, flag.Summary, groupFlag, "")
	}
	target.add(escapeHatchValue, escapeHatchSummary, groupOther, "")
}

// addMCPNames 补全 --mcp 的取值：Provider 原生 MCP + 账号允许的注册表 MCP。
// 当前词里的逗号表示「继续追加」：`--mcp demo,` 的候选会保留已敲的前缀，
// 并排除已经选中的名字。
func addMCPNames(target *collector, context *resolverContext, prior []string, provider, current string) {
	addMCPChoices(target, context, provider, accountTokenBefore(prior), current)
}

// addMCPChoices 是 --mcp 取值补全的公共实现：账号 token 已由调用方解析。
func addMCPChoices(target *collector, context *resolverContext, provider, accountToken, current string) {
	if context.mcpLister == nil {
		return
	}
	prefix := ""
	if index := strings.LastIndex(current, ","); index >= 0 {
		prefix = current[:index+1]
	}
	selected := make(map[string]bool)
	for _, name := range strings.Split(strings.TrimSuffix(prefix, ","), ",") {
		if name = strings.TrimSpace(name); name != "" {
			selected[name] = true
		}
	}
	for _, choice := range context.mcpLister(provider, accountToken) {
		if selected[choice.Value] {
			continue
		}
		target.add(prefix+choice.Value, choice.Description, groupMCP, "")
	}
}

// accountTokenBefore returns the explicit CLI account token in front of the
// current flag, matching the launch path's "first positional word" rule.
func accountTokenBefore(prior []string) string {
	for index := 1; index < len(prior); index++ {
		token := prior[index]
		if token == "--" {
			return ""
		}
		if strings.HasPrefix(token, "-") {
			continue
		}
		if accountTokenPattern.MatchString(token) {
			return token
		}
		return ""
	}
	return ""
}

func addPeerMessageIds(target *collector, context *resolverContext, current string) {
	if context.peerMessageLister == nil {
		return
	}
	for _, row := range context.peerMessageLister(current) {
		detail := strings.TrimSpace(row.Detail)
		if detail == "" {
			detail = "最近消息"
		}
		target.add(row.Value, detail, groupSession, detail)
	}
}

func addAccounts(target *collector, context *resolverContext, provider string, includeAihServerProfile bool) {
	if context.accountLister != nil {
		for _, account := range context.accountLister(provider) {
			id := strings.TrimSpace(account.CLIAccountID)
			if id == "" {
				continue
			}
			target.add(id, "账号 "+shortRef(account.AccountRef), groupAccount, "")
		}
	}
	if includeAihServerProfile && context.aihServerProfileID != "" {
		target.add(context.aihServerProfileID, "AIH Server（内置网关档）", groupAccount, "")
	}
}

func addSessionIds(target *collector, context *resolverContext, provider, accountToken, current string) {
	if context.sessionLister == nil {
		return
	}
	accountRef := resolveAccountRef(context, provider, accountToken)
	for _, session := range context.sessionLister(provider, accountRef, current) {
		id := strings.TrimSpace(session.ID)
		if id == "" {
			continue
		}
		title := strings.TrimSpace(session.Title)
		when := formatSessionTime(session.UpdatedAt)
		live := ""
		if session.Live {
			live = "● 活跃"
		}
		displayTitle := title
		if displayTitle == "" {
			displayTitle = "(无标题)"
		}
		parts := make([]string, 0, 3)
		for _, part := range []string{live, displayTitle, when} {
			if part != "" {
				parts = append(parts, part)
			}
		}
		target.add(id, strings.Join(parts, " · "), groupSession, title)
	}
}

func addTopLevelCommands(target *collector) {
	for _, command := range topLevelCommands {
		target.add(command.Name, command.Summary, groupCommand, "")
		for _, alias := range command.Aliases {
			target.add(alias, command.Summary, groupCommand, "")
		}
	}
	for _, provider := range allProviderNames() {
		target.add(provider, describeProvider(provider), groupProvider, "")
	}
}

func persistentDetail(row persistentChoice, now time.Time) string {
	parts := make([]string, 0, 5)
	if row.Here {
		parts = append(parts, "◆ 当前目录")
	}
	for _, part := range []string{
		strings.TrimSpace(row.Title),
		strings.TrimSpace(row.Provider),
	} {
		if part != "" {
			parts = append(parts, part)
		}
	}
	if relative := formatRelativeMoment(row.CreatedAt, now); relative != "" {
		parts = append(parts, relative)
	}
	if row.Live {
		parts = append(parts, "● 运行中")
	}
	detail := strings.Join(parts, " · ")
	if detail == "" {
		return "持久会话"
	}
	return detail
}

func resolveProviderCompletion(target *collector, context *resolverContext, prior []string, head, current string) []Candidate {
	if len(prior) == 1 {
		for _, action := range listProviderActions(head) {
			target.add(action.Name, action.Summary, groupAction, "")
		}
		addAccounts(target, context, head, false)
		// 桌面端 Provider 没有可透传参数的原生 CLI：不给逃生门与启动旗标，避免误导。
		if providerHasCLI(head) {
			target.add(escapeHatchValue, escapeHatchSummary, groupOther, "")
			if strings.HasPrefix(current, "-") {
				addSessionFlags(target, head)
			}
		}
		addHistoryCandidates(target, context, current, head)
		return target.items
	}
	action := at(prior, 1)
	// Codex 专属动作的取值面：模型名、推理强度、沙箱策略、machine-only 旗标。
	if head == "codex" {
		switch action {
		case "model":
			target.add("show", "查看当前默认模型", groupSubcommand, "")
			if context.modelLister != nil {
				for _, model := range context.modelLister(modelRequest{Provider: "codex", Current: current, Mode: "model"}) {
					target.add(model.Value, model.Description, groupModel, model.Value)
				}
			}
			return target.items
		case "effort":
			for _, value := range []string{"show", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "fast"} {
				target.add(value, "推理强度 / fast 快速模式", groupSubcommand, "")
			}
			if len(prior) == 3 && at(prior, 2) == "fast" {
				target.add("on", "开启 fast", groupSubcommand, "")
				target.add("off", "关闭 fast", groupSubcommand, "")
			}
			return target.items
		case "policy":
			if len(prior) == 2 {
				target.add("show", "查看 exec 沙箱策略", groupSubcommand, "")
				target.add("set", "设置 exec 沙箱策略", groupSubcommand, "")
				return target.items
			}
			if at(prior, 2) == "set" {
				for _, value := range []string{"workspace-write", "read-only", "danger-full-access"} {
					target.add(value, "沙箱策略", groupSubcommand, "")
				}
				return target.items
			}
		case "gateway-auth":
			target.add("--ai-home", "本机 AIH 数据目录（绝对路径）", groupFlag, "")
			return target.items
		}
	}
	if action == "install" || action == "update" {
		for _, flag := range listProviderActionFlags(action) {
			target.add(flag, describeFlag(flag), groupFlag, "")
		}
		return target.items
	}
	actionSubcommands, hasActionSubcommands := providerActionSubcommands[strings.ToLower(strings.TrimSpace(action))]
	if hasActionSubcommands && len(prior) == 2 {
		for _, name := range actionSubcommands {
			target.add(name, describeNestedSubcommand(name), groupSubcommand, "")
		}
		for _, flag := range listProviderActionFlags(action) {
			target.add(flag, describeFlag(flag), groupFlag, "")
		}
		return target.items
	}
	if hasActionSubcommands && len(prior) == 3 {
		for _, flag := range listProviderActionFlags(action) {
			target.add(flag, describeFlag(flag), groupFlag, "")
		}
		return target.items
	}
	// relay 的第一个位置既可以是账号，也可以是跨 Provider 的目标 Provider；
	// 选定 Provider 后再补它的账号。
	if action == "relay" && len(prior) == 2 {
		addAccounts(target, context, head, false)
		addRegisteredProviders(target)
		for _, flag := range listProviderActionFlags(action) {
			target.add(flag, describeFlag(flag), groupFlag, "")
		}
		return target.items
	}
	if action == "relay" && len(prior) == 3 && knownProvider(prior[2]) {
		addAccounts(target, context, prior[2], false)
		return target.items
	}
	if accountPositionActions[action] && len(prior) == 2 {
		includeProfile := (action == "set-default" || action == "sessions") && supportsAihServerProfile(head)
		addAccounts(target, context, head, includeProfile)
		for _, flag := range listProviderActionFlags(action) {
			target.add(flag, describeFlag(flag), groupFlag, "")
		}
		return target.items
	}
	if sessionPositionActions[action] && len(prior) == 2 {
		addSessionIds(target, context, head, "", current)
		for _, flag := range listProviderActionFlags(action) {
			target.add(flag, describeFlag(flag), groupFlag, "")
		}
		return target.items
	}
	if len(prior) == 2 && (isAllDigits(action) || accountTokenPattern.MatchString(action)) {
		if isAllDigits(action) {
			supported := map[string]bool{"resume": true, "fork": true, "usage": true, "home": true}
			for _, next := range listProviderActions(head) {
				if supported[next.Name] {
					target.add(next.Name, next.Summary, groupAction, "")
				}
			}
		}
		addSessionFlags(target, head)
		return target.items
	}
	if len(prior) == 3 && sessionPositionActions[at(prior, 2)] && !strings.HasPrefix(at(prior, 1), "-") {
		addSessionIds(target, context, head, prior[1], current)
		return target.items
	}
	if len(prior) == 2 {
		for _, flag := range listProviderActionFlags(action) {
			target.add(flag, describeFlag(flag), groupFlag, "")
		}
	}
	// codex takeover 的参数是 thread id（原生会话 id），不是账号。
	if head == "codex" && action == "takeover" && len(prior) == 2 {
		addSessionIds(target, context, head, "", current)
		for _, flag := range listProviderActionFlags(action) {
			target.add(flag, describeFlag(flag), groupFlag, "")
		}
		return target.items
	}
	// agy acp / session 有自己的旗标面，不能被 Provider 启动旗标覆盖。
	if head == "agy" && (action == "acp" || action == "session") && len(prior) >= 3 {
		for _, flag := range listProviderActionFlags(action) {
			target.add(flag, describeFlag(flag), groupFlag, "")
		}
		return target.items
	}
	addSessionFlags(target, head)
	return target.items
}

func addRegisteredProviders(target *collector) {
	for _, definition := range loadProviderSnapshot().definitions {
		target.add(definition.ID, describeProvider(definition.ID), groupProvider, "")
	}
}

func isAllDigits(value string) bool {
	if value == "" {
		return false
	}
	for index := 0; index < len(value); index++ {
		if value[index] < '0' || value[index] > '9' {
			return false
		}
	}
	return true
}

func listCompletionServerProfiles(context *resolverContext, current string) []remoteTargetChoice {
	// Server profile values are intentionally resolved by the remote lister only;
	// a nil result is the observable fail-closed state when no remote catalog is available.
	if context.remoteTargetLister == nil {
		return nil
	}
	return context.remoteTargetLister(remoteTargetRequest{Action: "profiles", Current: current})
}

// addCommandPositionCandidates 处理命令位（还没敲空格），按优先级分层：
//
//  1. 精确命中一个命令/Provider：它必须是唯一的可插入候选，shell 才会自动补空格；
//     下一层用提示列出，历史命中也降级成提示（看得见，但不和命令抢位置）。
//  2. 只是前缀命中：真实命令排在前面，历史整句作为低优先级候选跟在其后，
//     仍然可以选中并补完整行。
//  3. 什么都没命中：给出"没有这条命令，你可能要 …"的可执行建议。
//
// 只打了 aih 还没敲任何字符时不注入历史：那会把整份历史摊到命令菜单里。
func addCommandPositionCandidates(target *collector, context *resolverContext, current string) {
	trimmed := strings.TrimSpace(current)
	if trimmed != "" {
		if node, ok := findTopLevelCommand(trimmed); ok {
			target.add(node.Name, node.Summary, groupCommand, "")
			target.addHint(nextLevelHintForNode(&node))
			addHistoryHints(target, context, trimmed)
			return
		}
		if knownProvider(trimmed) {
			provider := normalizeProviderID(trimmed)
			target.add(provider, describeProvider(provider), groupProvider, "")
			target.addHint(nextLevelHintForProvider(provider))
			addHistoryHints(target, context, trimmed)
			return
		}
	}
	for index := range topLevelCommands {
		command := &topLevelCommands[index]
		target.add(command.Name, command.Summary, groupCommand, "")
		for _, alias := range command.Aliases {
			target.add(alias, command.Summary, groupCommand, "")
		}
	}
	for _, provider := range allProviderNames() {
		target.add(provider, describeProvider(provider), groupProvider, "")
	}
	if trimmed != "" {
		// 历史放在真实命令之后：同一个词既能补成命令，也能补成用过的整行，
		// 但命令永远先出现（zsh 按分组顺序展示，组内再按字母序）。
		addHistoryCandidates(target, context, trimmed, "")
	}
	if len(target.items) == 0 && trimmed != "" {
		addUnknownCommandHint(target, trimmed)
	}
}

// addHistoryHints 把历史命中降级成"看得见、插不进"的提示。
// 只用于精确命中命令的位置：那里必须只有唯一可插入候选，否则 shell 不会补空格。
func addHistoryHints(target *collector, context *resolverContext, current string) {
	if context == nil || len(context.historyEntries) == 0 {
		return
	}
	trimmed := strings.TrimSpace(current)
	for _, entry := range listHistoryRemainders(context.historyEntries, "", current, 3) {
		if entry.Suffix == trimmed {
			continue
		}
		target.addHint(fmt.Sprintf("历史 · aih %s（用过 %d 次）", entry.Suffix, entry.Count))
	}
}

// nextLevelHintForNode 汇总一个命令的下一层子命令。
func nextLevelHintForNode(node *commandNode) string {
	if node == nil || len(node.Children) == 0 {
		return ""
	}
	names := make([]string, 0, len(node.Children))
	for _, child := range node.Children {
		names = append(names, child.Name)
	}
	return "下一层：" + joinLimited(names, 12) + "（再按 TAB 展开）"
}

// nextLevelHintForProvider 汇总 Provider 的可用动作。
func nextLevelHintForProvider(provider string) string {
	actions := listProviderActions(provider)
	if len(actions) == 0 {
		return ""
	}
	names := make([]string, 0, len(actions))
	for _, action := range actions {
		names = append(names, action.Name)
	}
	return "可用动作：" + joinLimited(names, 12) + "（再按 TAB 展开）"
}

func joinLimited(values []string, limit int) string {
	if limit > 0 && len(values) > limit {
		return strings.Join(values[:limit], " / ") + " / …"
	}
	return strings.Join(values, " / ")
}

// addUnknownCommandHint 在命令位或命令后给出可执行的近似建议。
func addUnknownCommandHint(target *collector, input string) {
	suggestions := suggestCommandNames(input, 3)
	if len(suggestions) == 0 {
		target.addHint("没有 aih " + input + " 这条命令；输入 aih help 查看全部命令")
		return
	}
	prefixed := make([]string, 0, len(suggestions))
	for _, suggestion := range suggestions {
		prefixed = append(prefixed, "aih "+suggestion)
	}
	target.addHint("没有 aih " + input + " 这条命令；你可能要：" + strings.Join(prefixed, " / "))
}

// suggestCommandNames 优先取前缀命中，其次按编辑距离取近似命令。
// isHarnessShorthand 判断 aih <id> 是否是外部 harness 简写（pi / dsh / dsh-tui）。
func isHarnessShorthand(value string) bool {
	_, found := harnesses.Get(strings.ToLower(strings.TrimSpace(value)))
	return found
}

func suggestCommandNames(input string, limit int) []string {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return nil
	}
	names := listTopLevelCommandNames()
	names = append(names, allProviderNames()...)
	seen := make(map[string]bool, len(names))
	prefixMatches := make([]string, 0, 4)
	others := make([]string, 0, 4)
	allowed := allowedDistance(len([]rune(trimmed)))
	for _, name := range names {
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		if strings.HasPrefix(strings.ToLower(name), strings.ToLower(trimmed)) {
			prefixMatches = append(prefixMatches, name)
			continue
		}
		if allowed > 0 && damerauLevenshtein(strings.ToLower(trimmed), strings.ToLower(name)) <= allowed {
			others = append(others, name)
		}
	}
	result := append(prefixMatches, others...)
	if limit > 0 && len(result) > limit {
		result = result[:limit]
	}
	return result
}
