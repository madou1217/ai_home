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

func addSessionFlags(target *collector) {
	for _, flag := range sessionFlags {
		target.add(flag.Name, flag.Summary, groupFlag, "")
	}
	target.add(escapeHatchValue, escapeHatchSummary, groupOther, "")
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
		addSessionFlags(target)
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
	addSessionFlags(target)
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
