package completion

import (
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/core/harnesses"
)

// valueKind 声明一个位置/选项的取值来源。新增命令时只写数据，不再写分支。
type valueKind string

const (
	kindNone            valueKind = ""
	kindEnum            valueKind = "enum"
	kindProvider        valueKind = "provider"
	kindAccount         valueKind = "account"
	kindAccountTarget   valueKind = "account_target"
	kindSession         valueKind = "session"
	kindResume          valueKind = "resume"
	kindPersistent      valueKind = "persistent"
	kindModel           valueKind = "model"
	kindAlias           valueKind = "alias"
	kindMCP             valueKind = "mcp"
	kindProxy           valueKind = "proxy"
	kindPeerTarget      valueKind = "peer_target"
	kindPeerMessage     valueKind = "peer_message"
	kindShell           valueKind = "shell"
	kindHarness         valueKind = "harness"
	kindRemoteServer    valueKind = "remote_server"
	kindRemoteWorkspace valueKind = "remote_workspace"
	kindClipboardItem   valueKind = "clipboard_item"
	kindClientKey       valueKind = "client_key"
	kindBackupTarget    valueKind = "backup_target"
	kindFailureSignal   valueKind = "failure_signal"
	kindFailureKind     valueKind = "failure_kind"
	kindTypo            valueKind = "typo_correction"
	kindNativePlugin    valueKind = "native_plugin"
	kindSkill           valueKind = "skill"
	kindFile            valueKind = "file"
	kindFree            valueKind = "free"
)

// optionSpec 是一个命令选项；Kind 非空时表示它需要取值。
type optionSpec struct {
	Name    string
	Aliases []string
	Summary string
	Kind    valueKind
	Values  []string
	Multi   bool
}

// positionalSpec 描述命令的自由参数位；Repeat 表示可以连续出现。
type positionalSpec struct {
	Kind   valueKind
	Values []string
	Repeat bool
}

// commandNode 是补全命令树的唯一节点类型。Children 是子命令，Options 是
// 该层可用的选项，Positionals 是子命令之后的自由参数。
type commandNode struct {
	Name        string
	Aliases     []string
	Summary     string
	Children    []commandNode
	Options     []optionSpec
	Positionals []positionalSpec
	// AlwaysOptions 表示即使当前词为空也要展示选项（例如 ss 的 --list/--detail）。
	AlwaysOptions bool
}

func (node *commandNode) findChild(token string) *commandNode {
	name := strings.ToLower(strings.TrimSpace(token))
	for index := range node.Children {
		child := &node.Children[index]
		if strings.ToLower(child.Name) == name {
			return child
		}
		for _, alias := range child.Aliases {
			if strings.ToLower(alias) == name {
				return child
			}
		}
	}
	return nil
}

func (node *commandNode) findOption(token string) *optionSpec {
	name := strings.TrimSpace(token)
	for index := range node.Options {
		option := &node.Options[index]
		if option.Name == name {
			return option
		}
		for _, alias := range option.Aliases {
			if alias == name {
				return option
			}
		}
	}
	return nil
}

func (node *commandNode) positionalAt(index int) *positionalSpec {
	if index < 0 || len(node.Positionals) == 0 {
		return nil
	}
	if index < len(node.Positionals) {
		return &node.Positionals[index]
	}
	last := &node.Positionals[len(node.Positionals)-1]
	if last.Repeat {
		return last
	}
	return nil
}

type treeState struct {
	node       *commandNode
	provider   string
	account    string
	server     string
	pending    *optionSpec
	positional int
	escaped    bool
}

func splitOptionToken(token string) (string, string, bool) {
	if !strings.HasPrefix(token, "-") {
		return token, "", false
	}
	if index := strings.Index(token, "="); index > 0 {
		return token[:index], token[index+1:], true
	}
	return token, "", false
}

func consumeTreeValue(state *treeState, spec *optionSpec, value string) {
	value = strings.TrimSpace(value)
	switch spec.Kind {
	case kindProvider:
		if knownProvider(value) {
			state.provider = normalizeProviderID(value)
		}
	case kindAccount, kindAccountTarget:
		state.account = value
		if spec.Kind == kindAccountTarget {
			if provider, _, found := strings.Cut(value, ":"); found && knownProvider(provider) {
				state.provider = normalizeProviderID(provider)
			}
		}
	case kindRemoteServer:
		state.server = value
	}
}

func consumeTreePositional(state *treeState, spec *positionalSpec, value string) {
	value = strings.TrimSpace(value)
	switch spec.Kind {
	case kindProvider:
		if knownProvider(value) {
			state.provider = normalizeProviderID(value)
		}
	case kindAccount, kindAccountTarget:
		state.account = value
		if spec.Kind == kindAccountTarget {
			if provider, _, found := strings.Cut(value, ":"); found && knownProvider(provider) {
				state.provider = normalizeProviderID(provider)
			}
		}
	}
}

func walkCommandTree(root *commandNode, words []string) treeState {
	state := treeState{node: root}
	for index := 0; index < len(words); index++ {
		token := words[index]
		if token == "--" {
			state.escaped = true
			break
		}
		if state.pending != nil {
			if state.pending.Multi && strings.HasPrefix(token, "-") {
				state.pending = nil
			} else {
				consumeTreeValue(&state, state.pending, token)
				if !state.pending.Multi {
					state.pending = nil
				}
				continue
			}
		}
		if strings.HasPrefix(token, "-") {
			name, inline, hasInline := splitOptionToken(token)
			spec := state.node.findOption(name)
			if spec == nil {
				continue
			}
			if spec.Kind != kindNone {
				if hasInline {
					consumeTreeValue(&state, spec, inline)
				} else {
					state.pending = spec
				}
			}
			continue
		}
		if child := state.node.findChild(token); child != nil {
			state.node = child
			state.positional = 0
			continue
		}
		if spec := state.node.positionalAt(state.positional); spec != nil {
			consumeTreePositional(&state, spec, token)
			if !spec.Repeat {
				state.positional++
			}
		}
	}
	return state
}

// resolveCommandTree 是唯一的命令树遍历入口。
func resolveCommandTree(root *commandNode, words []string, current string, context *resolverContext, target *collector) []Candidate {
	state := walkCommandTree(root, words)
	if state.escaped {
		return target.items
	}
	if state.pending != nil && state.pending.Kind != kindNone {
		emitTreeValues(target, context, &state, state.pending.Kind, state.pending.Values, current)
		return target.items
	}
	showOptions := strings.HasPrefix(current, "-") || state.node.AlwaysOptions || optionsArePrimary(state.node)
	if showOptions {
		for index := range state.node.Options {
			option := &state.node.Options[index]
			target.add(option.Name, optionSummary(option), groupFlag, "")
			for _, alias := range option.Aliases {
				target.add(alias, optionSummary(option), groupFlag, "")
			}
		}
		target.add("--help", describeFlag("--help"), groupFlag, "")
		if state.node.findOption("-h") == nil {
			target.add("-h", describeFlag("--help"), groupFlag, "")
		}
		// AlwaysOptions 只保证旗标不退场，不代表位置参数没有候选。
		// aih ss 就是典型：空词既要给 --list，也要给会话名/有会话的路径。
		if !strings.HasPrefix(current, "-") {
			if spec := state.node.positionalAt(state.positional); spec != nil && spec.Kind != kindNone {
				emitTreeValues(target, context, &state, spec.Kind, spec.Values, current)
			}
		}
		return target.items
	}
	for index := range state.node.Children {
		child := &state.node.Children[index]
		target.add(child.Name, child.Summary, groupSubcommand, "")
		for _, alias := range child.Aliases {
			target.add(alias, child.Summary, groupSubcommand, "")
		}
	}
	if spec := state.node.positionalAt(state.positional); spec != nil {
		emitTreeValues(target, context, &state, spec.Kind, spec.Values, current)
		return target.items
	}
	// 纯子命令位：历史整句作为最低优先级候选排在真实子命令之后。
	// 路径/自由文本位不注入历史，否则会抢掉真正的文件补全。
	if len(state.node.Children) > 0 {
		priorText := strings.TrimSpace(root.Name + " " + strings.Join(words, " "))
		addHistoryCandidates(target, context, current, priorText)
	}
	return target.items
}

// optionsArePrimary 判断一个叶子命令除了选项之外没有更好的候选（例如 update、
// desktop status、account list），此时空词也直接给选项，避免 TAB 看起来“没有反应”。
func optionsArePrimary(node *commandNode) bool {
	if len(node.Children) > 0 {
		return false
	}
	for _, positional := range node.Positionals {
		switch positional.Kind {
		case kindNone, kindFree, kindFile:
			continue
		default:
			return false
		}
	}
	return len(node.Options) > 0
}

func optionSummary(option *optionSpec) string {
	if summary := strings.TrimSpace(option.Summary); summary != "" {
		return summary
	}
	return describeFlag(option.Name)
}

func emitTreeValues(target *collector, context *resolverContext, state *treeState, kind valueKind, values []string, current string) {
	switch kind {
	case kindEnum:
		for _, value := range values {
			target.add(value, "允许的取值", groupFlag, "")
		}
	case kindProvider:
		addRegisteredProviders(target)
	case kindAccount:
		addAccountValues(target, context, state.provider, false)
	case kindAccountTarget:
		addAccountTargets(target, context, state.provider, current)
	case kindSession:
		if state.provider != "" {
			addSessionIds(target, context, state.provider, state.account, current)
		}
	case kindResume:
		if context.resumeLister != nil {
			for _, session := range context.resumeLister(current) {
				title := strings.TrimSpace(session.Title)
				if title == "" {
					title = "(无标题)"
				}
				parts := make([]string, 0, 3)
				for _, part := range []string{title, strings.TrimSpace(session.Provider), formatSessionTime(fmt.Sprintf("%d", session.UpdatedAt))} {
					if part != "" {
						parts = append(parts, part)
					}
				}
				target.add(session.ID, strings.Join(parts, " · "), groupSession, title)
			}
		}
	case kindPersistent:
		if context.persistentLister != nil {
			for _, row := range context.persistentLister(current) {
				name := strings.TrimSpace(row.Name)
				if name == "" {
					continue
				}
				target.add(name, persistentDetail(row, context.now), groupSession, strings.TrimSpace(row.MatchText))
			}
		}
	case kindModel, kindAlias:
		if context.modelLister != nil {
			mode := "model"
			if kind == kindAlias {
				mode = "alias"
			}
			accountRef := ""
			if state.account != "" && state.provider != "" && context.accountLister != nil {
				for _, account := range context.accountLister(state.provider) {
					if account.CLIAccountID == state.account || account.AccountRef == state.account {
						accountRef = account.AccountRef
						break
					}
				}
			}
			for _, model := range context.modelLister(modelRequest{Provider: state.provider, AccountRef: accountRef, AccountToken: state.account, Current: current, Mode: mode}) {
				group := groupModel
				if strings.TrimSpace(model.Group) != "" {
					group = model.Group
				}
				target.add(model.Value, model.Description, group, model.Value)
			}
		}
	case kindMCP:
		if state.provider != "" {
			addMCPChoices(target, context, state.provider, state.account, current)
		}
	case kindProxy:
		if context.proxyLister != nil {
			for _, row := range context.proxyLister() {
				if !proxyChoiceAllowed(row, current) {
					continue
				}
				target.add(row.Value, row.Description, groupFlag, row.Description)
			}
		}
	case kindPeerTarget:
		if context.peerLister != nil {
			for _, row := range context.peerLister(current) {
				detail := strings.TrimSpace(row.Detail)
				if detail == "" {
					detail = "最近消息"
				}
				target.add(row.Value, detail, groupSession, detail)
			}
		}
	case kindPeerMessage:
		addPeerMessageIds(target, context, current)
	case kindShell:
		for _, shell := range shellValueCandidates {
			target.add(shell, "目标 shell", groupFlag, "")
		}
	case kindHarness:
		for _, item := range harnesses.List() {
			target.add(item.ID, item.Label, groupSubcommand, "")
		}
	case kindRemoteServer:
		for _, profile := range listCompletionServerProfiles(context, current) {
			target.add(profile.Value, profile.Description, groupOther, profile.Description)
		}
	case kindRemoteWorkspace:
		if context.workspaceLister != nil {
			for _, choice := range context.workspaceLister(workspaceRequest{Action: "list", Server: state.server, Current: current}) {
				target.add(choice.Value, choice.Description, groupOther, choice.Description)
			}
		}
	case kindClipboardItem:
		if context.clipboardLister != nil {
			for _, item := range context.clipboardLister(current) {
				target.add(item.Value, item.Description, groupOther, item.Description)
			}
		}
	case kindClientKey:
		if context.clientKeyLister != nil {
			for _, item := range context.clientKeyLister() {
				target.add(item.Value, item.Description, groupOther, item.Description)
			}
		}
	case kindBackupTarget:
		if context.backupTargetLister != nil {
			for _, item := range context.backupTargetLister() {
				target.add(item.Value, item.Description, groupOther, item.Description)
			}
		}
	case kindFailureSignal:
		if context.failureSignalLister != nil {
			for _, item := range context.failureSignalLister() {
				target.add(item.Value, item.Description, groupOther, item.Description)
			}
		}
	case kindFailureKind:
		if context.failureKindLister != nil {
			for _, kind := range context.failureKindLister() {
				target.add(kind, "失败分类", groupOther, "")
			}
		}
	case kindTypo:
		if context.typoLister != nil {
			for _, item := range context.typoLister() {
				target.add(item.Value, item.Description, groupOther, item.Description)
			}
		}
	case kindNativePlugin:
		if context.nativePluginLister != nil {
			for _, item := range context.nativePluginLister() {
				target.add(item.Value, item.Description, groupOther, item.Description)
			}
		}
	case kindSkill:
		if context.skillLister != nil {
			for _, item := range context.skillLister() {
				target.add(item.Value, item.Description, groupOther, item.Description)
			}
		}
	case kindFile, kindFree, kindNone:
		// 交给 shell 的路径补全或保持自由输入。
	}
}

func addAccountValues(target *collector, context *resolverContext, provider string, includeProfile bool) {
	if provider != "" {
		addAccounts(target, context, provider, includeProfile)
		return
	}
	addAccountTargets(target, context, "", "")
}

func addAccountTargets(target *collector, context *resolverContext, provider, current string) {
	if provider != "" && context.accountLister != nil {
		for _, account := range context.accountLister(provider) {
			id := strings.TrimSpace(account.CLIAccountID)
			if id == "" {
				continue
			}
			target.add(provider+":"+id, "账号 "+shortRef(account.AccountRef), groupAccount, "")
			if strings.TrimSpace(account.AccountRef) != "" {
				target.add(account.AccountRef, provider+" 账号", groupAccount, "")
			}
		}
		return
	}
	if context.allAccountLister == nil {
		return
	}
	for _, account := range context.allAccountLister() {
		if strings.TrimSpace(account.Provider) == "" || strings.TrimSpace(account.CLIAccountID) == "" {
			continue
		}
		value := account.Provider + ":" + account.CLIAccountID
		target.add(value, "账号 "+shortRef(account.AccountRef), groupAccount, "")
		if strings.TrimSpace(account.AccountRef) != "" {
			target.add(account.AccountRef, account.Provider+" 账号", groupAccount, "")
		}
	}
}
