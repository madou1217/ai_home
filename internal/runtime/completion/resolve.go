package completion

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	inlineAssignmentPattern = regexp.MustCompile(`(?s)^(--[^=]+)=(.*)$`)
	accountTokenPattern     = regexp.MustCompile(`^(?:\d+|acct_[a-f0-9]{20})$`)
)

var accountPositionActions = map[string]bool{
	"usage": true, "home": true, "delete": true, "sessions": true, "set-default": true, "set-mobile": true,
}

var sessionPositionActions = map[string]bool{"resume": true, "fork": true}

var modelValueFlags = map[string]string{"--model": "model", "--model-alias": "alias"}

var peerStateCandidates = []namedSummary{
	{Name: "pending", Summary: "待投递"},
	{Name: "delivered", Summary: "已送达"},
	{Name: "read", Summary: "已读"},
	{Name: "failed", Summary: "投递失败"},
	{Name: "unread", Summary: "未读（已送达但未读）"},
	{Name: "all", Summary: "全部状态"},
}

var peerChannelCandidates = []namedSummary{
	{Name: "native", Summary: "claude 的本机 UDS 协议（有投递语义）"},
	{Name: "inject", Summary: "aih 代打进会话的 pane（等价用户手打）"},
	{Name: "webui-chat", Summary: "WebUI chat runtime 的命令总线"},
}

var shellValueCandidates = []string{"zsh", "bash", "fish", "powershell"}

func at(values []string, index int) string {
	if index < 0 || index >= len(values) {
		return ""
	}
	return values[index]
}

func lastIndexOf(values []string, wanted string) int {
	for index := len(values) - 1; index >= 0; index-- {
		if values[index] == wanted {
			return index
		}
	}
	return -1
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func isServerHead(head string) bool {
	return head == "server" || head == "daemon" || head == "serve"
}

// isManagedValueFlag 判断某个旗标的取值是否由 aih 自己解析。
func isManagedValueFlag(flag string, prior []string) bool {
	head := at(prior, 0)
	if flag == "--proxy" && isProviderName(head) {
		if action := at(prior, 1); action == "install" || action == "update" {
			return true
		}
	}
	switch flag {
	case "--provider", "--scope", "--account", "--model", "--model-alias":
		return true
	}
	if head == "shell" && flag == "--shell" {
		return true
	}
	if head == "peer" {
		switch flag {
		case "--channel", "--target", "--reply-to", "--state", "--mode":
			return true
		}
	}
	if isServerHead(head) && at(prior, 1) == "config" && at(prior, 2) == "set" {
		return true
	}
	return false
}

// normalizePriorValues 只归一化「已经敲下的词」，不碰当前词。
func normalizePriorValues(prior []string) []string {
	out := make([]string, 0, len(prior))
	for index := 0; index < len(prior); index++ {
		word := prior[index]
		if word == "--" {
			return append(out, prior[index:]...)
		}
		if match := inlineAssignmentPattern.FindStringSubmatch(word); match != nil && isManagedValueFlag(match[1], prior) {
			out = append(out, match[1], match[2])
			continue
		}
		if isManagedValueFlag(word, prior) && at(prior, index+1) == "=" {
			out = append(out, word)
			index++
			if index+1 < len(prior) {
				out = append(out, prior[index+1])
				index++
			}
			continue
		}
		out = append(out, word)
	}
	return out
}

// resolveModelTarget 从「旗标之前的词」里定位 provider 与账号位。
func resolveModelTarget(prior []string) (string, string) {
	providerIndex := lastIndexOf(prior, "--provider")
	provider := ""
	providerAt := -1
	if providerIndex >= 0 {
		provider = strings.ToLower(strings.TrimSpace(at(prior, providerIndex+1)))
		providerAt = providerIndex
	}
	if !isProviderName(provider) {
		provider = ""
		providerAt = -1
		for index := 0; index < len(prior); index++ {
			token := strings.ToLower(prior[index])
			if isProviderName(token) {
				provider = token
				providerAt = index
				break
			}
		}
	}
	if !isProviderName(provider) {
		return "", ""
	}
	if accountIndex := lastIndexOf(prior, "--account"); accountIndex >= 0 {
		explicit := strings.TrimSpace(at(prior, accountIndex+1))
		if accountTokenPattern.MatchString(explicit) {
			return provider, explicit
		}
		return provider, ""
	}
	if providerIndex >= 0 && providerAt == providerIndex {
		return provider, ""
	}
	next := strings.TrimSpace(at(prior, providerAt+1))
	if accountTokenPattern.MatchString(next) {
		return provider, next
	}
	return provider, ""
}

func resolveAccountRef(context *resolverContext, provider, accountToken string) string {
	if accountToken == "" || context.accountLister == nil {
		return ""
	}
	for _, account := range context.accountLister(provider) {
		if account.CLIAccountID == accountToken || account.AccountRef == accountToken {
			return account.AccountRef
		}
	}
	return ""
}

// resolveCompletion 把「已经敲下的词」映射成候选（值 + 说明 + 分组）。
func resolveCompletion(words []string, context *resolverContext) []Candidate {
	if len(words) == 0 {
		return nil
	}
	current := words[len(words)-1]
	prior := normalizePriorValues(words[:len(words)-1])
	target := newCollector(current)

	// `--` 之后是原生 CLI 的世界：一律不给候选。
	if containsString(prior, "--") {
		return nil
	}

	// Shells disagree on whether '=' is a word break; normalize the inline value here.
	if match := inlineAssignmentPattern.FindStringSubmatch(current); match != nil {
		head := at(prior, 0)
		flag := match[1]
		inlineValue := match[2]
		if !isManagedValueFlag(flag, prior) {
			return nil
		}
		if isServerHead(head) && at(prior, 1) == "config" && at(prior, 2) == "set" {
			values, present := serverConfigValues(flag)
			if !present {
				return nil
			}
			result := make([]Candidate, 0, len(values))
			for _, item := range values {
				if !matchesPrefix(item.Value, inlineValue) {
					continue
				}
				result = append(result, Candidate{
					Value:       flag + "=" + item.Value,
					Description: item.Description,
					Group:       groupFlag,
				})
			}
			return result
		}
		children := resolveCompletion(append(append([]string(nil), prior...), flag, inlineValue), context)
		result := make([]Candidate, 0, len(children))
		for _, child := range children {
			child.Value = flag + "=" + child.Value
			result = append(result, child)
		}
		return result
	}

	if len(prior) == 0 {
		addTopLevelCommands(target)
		addHistoryCandidates(target, context, current, "")
		return target.items
	}

	head := prior[0]
	lastPrior := prior[len(prior)-1]

	// 唯一的代理目录 IO 位置：后续旗标属于生命周期解析器，不是 --proxy 的值。
	if lastPrior == "--proxy" && isProviderName(head) &&
		(at(prior, 1) == "install" || at(prior, 1) == "update") && !strings.HasPrefix(current, "-") {
		if strings.Contains(current, "://") {
			return target.items
		}
		if context.proxyLister != nil {
			for _, row := range context.proxyLister() {
				target.add(row.Value, row.Description, groupFlag, row.Description)
			}
		}
		return target.items
	}

	switch lastPrior {
	case "--provider":
		for _, provider := range providerNames() {
			target.add(provider, describeProvider(provider), groupProvider, "")
		}
		return target.items
	case "--shell":
		if head == "shell" {
			for _, shell := range shellValueCandidates {
				target.add(shell, "目标 shell", groupFlag, "")
			}
			return target.items
		}
	case "--scope":
		for _, provider := range providerNames() {
			target.add(provider, describeProvider(provider), groupProvider, "")
		}
		return target.items
	case "--channel":
		if head == "peer" {
			for _, row := range peerChannelCandidates {
				target.add(row.Name, row.Summary, groupFlag, "")
			}
			return target.items
		}
	case "--target":
		if head == "peer" && context.peerLister != nil {
			for _, row := range context.peerLister(current) {
				detail := strings.TrimSpace(row.Detail)
				if detail == "" {
					detail = "收件箱消息"
				}
				target.add(row.Value, detail, groupSession, detail)
			}
			return target.items
		}
	case "--reply-to":
		if head == "peer" {
			addPeerMessageIds(target, context, current)
			return target.items
		}
	case "--state":
		if head == "peer" {
			for _, row := range peerStateCandidates {
				target.add(row.Name, row.Summary, groupFlag, "")
			}
			return target.items
		}
	case "--mode":
		if head == "peer" {
			target.add("bypass", "告诉收件方这是 bypass 来源（仅 native 信封携带）", groupFlag, "")
			return target.items
		}
	}

	if lastPrior == "--account" {
		providerIndex := lastIndexOf(prior, "--provider")
		provider := ""
		if providerIndex >= 0 {
			provider = strings.ToLower(strings.TrimSpace(at(prior, providerIndex+1)))
		}
		if !isProviderName(provider) {
			provider = ""
			for index := len(prior) - 1; index >= 0; index-- {
				if isProviderName(prior[index]) {
					provider = strings.ToLower(prior[index])
					break
				}
			}
		}
		if isProviderName(provider) {
			addAccounts(target, context, provider, false)
			return target.items
		}
	}

	if mode, found := modelValueFlags[lastPrior]; found && context.modelLister != nil {
		provider, accountToken := resolveModelTarget(prior)
		accountRef := resolveAccountRef(context, provider, accountToken)
		for _, model := range context.modelLister(modelRequest{
			Provider:     provider,
			AccountRef:   accountRef,
			AccountToken: accountToken,
			Current:      current,
			Mode:         mode,
		}) {
			target.add(model.Value, model.Description, groupModel, "")
		}
		return target.items
	}

	if isProviderName(head) {
		return resolveProviderCompletion(target, context, prior, head, current)
	}

	node, found := findTopLevelCommand(head)
	if !found {
		return nil
	}

	if len(prior) == 1 {
		if node.Name == "ss" && context.persistentLister != nil {
			for _, row := range context.persistentLister(current) {
				name := strings.TrimSpace(row.Name)
				if name == "" {
					continue
				}
				detail := persistentDetail(row, context.now)
				target.add(name, detail, groupSession, strings.TrimSpace(row.MatchText))
			}
			for _, sub := range node.Subcommands {
				target.add(sub.Name, sub.Summary, groupSubcommand, "")
			}
			return target.items
		}
		if node.Name == "resume" && context.resumeLister != nil {
			for _, session := range context.resumeLister(current) {
				title := strings.TrimSpace(session.Title)
				when := formatSessionTime(fmt.Sprintf("%d", session.UpdatedAt))
				displayTitle := title
				if displayTitle == "" {
					displayTitle = "(无标题)"
				}
				parts := make([]string, 0, 3)
				for _, part := range []string{displayTitle, strings.TrimSpace(session.Provider), when} {
					if part != "" {
						parts = append(parts, part)
					}
				}
				target.add(session.ID, strings.Join(parts, " · "), groupSession, title)
			}
			return target.items
		}
		if node.Name == "export" || node.Name == "import" {
			return target.items
		}
		for _, sub := range node.Subcommands {
			target.add(sub.Name, sub.Summary, groupSubcommand, "")
		}
		for _, flag := range node.Flags {
			target.add(flag, describeFlag(flag), groupFlag, "")
		}
		if len(node.Subcommands) == 0 {
			target.add("--help", "打印用法", groupFlag, "")
		}
		return target.items
	}

	if node.Name == "peer" && (at(prior, 1) == "read" || at(prior, 1) == "reply") && len(prior) == 2 {
		addPeerMessageIds(target, context, current)
		for _, flag := range node.Flags {
			target.add(flag, describeFlag(flag), groupFlag, "")
		}
		return target.items
	}

	if node.Name == "peer" && at(prior, 1) == "send" && len(prior) == 2 && context.peerLister != nil {
		for _, row := range context.peerLister(current) {
			detail := strings.TrimSpace(row.Detail)
			if detail == "" {
				detail = "收件箱消息"
			}
			target.add(row.Value, detail, groupSession, detail)
		}
		for _, flag := range node.Flags {
			target.add(flag, describeFlag(flag), groupFlag, "")
		}
		return target.items
	}

	nestedKey := strings.Join(append([]string{node.Name}, prior[1:]...), " ")
	if nested, exists := nestedSubcommandTables[nestedKey]; exists {
		for _, name := range nested {
			target.add(name, describeNestedSubcommand(name), groupSubcommand, "")
		}
		for _, flag := range node.Flags {
			target.add(flag, describeFlag(flag), groupFlag, "")
		}
		return target.items
	}

	if node.Name == "server" && at(prior, 1) == "config" && len(prior) >= 3 &&
		(at(prior, 2) == "set" || at(prior, 2) == "get") {
		if at(prior, 2) == "set" && strings.HasPrefix(lastPrior, "--") {
			values, present := serverConfigValues(lastPrior)
			if present {
				for _, item := range values {
					target.add(item.Value, item.Description, groupFlag, "")
				}
				return target.items
			}
		}
		for _, item := range listServerConfigFlags() {
			target.add(item.Value, item.Description, groupFlag, "")
		}
		return target.items
	}

	if node.Name == "export" || node.Name == "import" {
		return target.items
	}
	for _, flag := range node.Flags {
		target.add(flag, describeFlag(flag), groupFlag, "")
	}
	return target.items
}
