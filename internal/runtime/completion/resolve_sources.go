package completion

import (
	"fmt"
	"strings"
	"time"
)

func addHistoryCandidates(target *collector, context *resolverContext, current, priorText string) {
	if len(context.historyEntries) == 0 {
		return
	}
	limit := context.historyLimit
	if limit <= 0 {
		limit = 8
	}
	for _, entry := range listHistoryRemainders(context.historyEntries, priorText, current, limit) {
		target.add(entry.Suffix, fmt.Sprintf("用过 %d 次", entry.Count), groupHistory, "")
	}
}

func addSessionFlags(target *collector, provider string) {
	for _, flag := range providerSessionFlags(provider) {
		target.add(flag.Name, flag.Summary, groupFlag, "")
	}
	target.add(escapeHatchValue, escapeHatchSummary, groupOther, "")
}

// addMCPNames 补全 --mcp 的取值。当前词里的逗号表示「继续追加」：
// `--mcp demo,` 的候选会保留已敲的前缀，并排除已经选中的名字。
func addMCPNames(target *collector, context *resolverContext, provider, current string) {
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
	for _, name := range context.mcpLister(provider) {
		if selected[name] {
			continue
		}
		target.add(prefix+name, "MCP 服务器", groupMCP, "")
	}
}

func addPeerMessageIds(target *collector, context *resolverContext, current string) {
	if context.peerMessageLister == nil {
		return
	}
	for _, row := range context.peerMessageLister(current) {
		detail := strings.TrimSpace(row.Detail)
		if detail == "" {
			detail = "收件箱消息"
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
	for _, provider := range providerNames() {
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
		target.add(escapeHatchValue, escapeHatchSummary, groupOther, "")
		// 用户已经开始敲旗标：直接给出本次启动可用的旗标，而不是只有动作名。
		if strings.HasPrefix(current, "-") {
			addSessionFlags(target, head)
		}
		addHistoryCandidates(target, context, current, head)
		return target.items
	}
	action := at(prior, 1)
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
	addSessionFlags(target, head)
	return target.items
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

func resolveRemoteCompletion(target *collector, context *resolverContext, prior []string, current string) []Candidate {
	if context.remoteTargetLister == nil {
		return target.items
	}
	if len(prior) == 1 {
		target.add("target", "解析远程执行目标", groupSubcommand, "")
		return target.items
	}
	if prior[1] != "target" {
		return target.items
	}
	if len(prior) == 2 {
		for _, action := range []namedSummary{
			{Name: "ls", Summary: "列出远程目标候选"},
			{Name: "resolve", Summary: "解析一个远程目标"},
			{Name: "doctor", Summary: "预检远程目标能力"},
		} {
			target.add(action.Name, action.Summary, groupSubcommand, "")
		}
		return target.items
	}
	action := prior[2]
	if action != "ls" && action != "list" && action != "resolve" && action != "doctor" && action != "preflight" {
		return target.items
	}
	if action != "ls" && action != "list" && len(prior) == 3 {
		for _, flag := range []string{"--server", "--server-id", "--workspace", "--connection", "--harness", "--provider", "--account", "--model", "--json"} {
			target.add(flag, describeFlag(flag), groupFlag, "")
		}
		return target.items
	}
	last := prior[len(prior)-1]
	if last == "--server" {
		for _, profile := range listCompletionServerProfiles(context, current) {
			target.add(profile.Value, profile.Description, groupOther, profile.Description)
		}
		return target.items
	}
	if last == "--server-id" || last == "--workspace" || last == "--connection" || last == "--harness" || last == "--provider" || last == "--account" || last == "--model" {
		request := remoteTargetRequest{Action: "list", Server: remoteOptionValue(prior, "--server"), ServerID: remoteOptionValue(prior, "--server-id"), Workspace: remoteOptionValue(prior, "--workspace"), Connection: remoteOptionValue(prior, "--connection"), Harness: remoteOptionValue(prior, "--harness"), Provider: remoteOptionValue(prior, "--provider"), Account: remoteOptionValue(prior, "--account"), Model: remoteOptionValue(prior, "--model"), Field: strings.TrimPrefix(last, "--"), Current: current}
		for _, choice := range context.remoteTargetLister(request) {
			group := choice.Group
			if group == "" {
				group = groupOther
			}
			target.add(choice.Value, choice.Description, group, choice.Description)
		}
		return target.items
	}
	for _, flag := range []string{"--server", "--server-id", "--workspace", "--connection", "--harness", "--provider", "--account", "--model", "--json"} {
		target.add(flag, describeFlag(flag), groupFlag, "")
	}
	return target.items
}

func remoteOptionValue(prior []string, flag string) string {
	for index := len(prior) - 1; index >= 0; index-- {
		if prior[index] == flag && index+1 < len(prior) {
			return strings.TrimSpace(prior[index+1])
		}
	}
	return ""
}

func listCompletionServerProfiles(context *resolverContext, current string) []remoteTargetChoice {
	// Server profile values are intentionally resolved by the remote lister only;
	// a nil result is the observable fail-closed state when no remote catalog is available.
	if context.remoteTargetLister == nil {
		return nil
	}
	return context.remoteTargetLister(remoteTargetRequest{Action: "profiles", Current: current})
}
