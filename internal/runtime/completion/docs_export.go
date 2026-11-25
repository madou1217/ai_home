package completion

// 本文件把补全命令树导出成稳定的文档条目，供 `aih man` 页面渲染。
// 页面只消费这里的数据：命令面变化时页面自动跟随，不维护第二份清单。

// DocEntry 是手册页的一行：分组 + 命令路径 + 说明 + 可选旗标/别名。
type DocEntry struct {
	Group       string   `json:"group"`
	Path        string   `json:"path"`
	Description string   `json:"description"`
	Flags       []string `json:"flags,omitempty"`
	Alias       []string `json:"alias,omitempty"`
}

// DocumentationEntries 返回完整命令文档条目（命令树 + Provider 动作 + 启动语法）。
func DocumentationEntries() []DocEntry {
	entries := make([]DocEntry, 0, 256)
	for index := range topLevelCommands {
		command := &topLevelCommands[index]
		entries = append(entries, docEntryForNode("顶层命令", "", command))
		appendChildDocEntries(&entries, "aih "+command.Name, command)
	}
	for _, provider := range providerNames() {
		entries = append(entries, DocEntry{
			Group:       "Provider",
			Path:        "aih " + provider,
			Description: describeProvider(provider),
		})
		for _, action := range listProviderActions(provider) {
			entries = append(entries, DocEntry{
				Group:       "Provider 动作",
				Path:        "aih " + provider + " " + action.Name,
				Description: action.Summary,
				Flags:       listProviderActionFlags(action.Name),
			})
		}
	}
	entries = append(entries, launchGrammarDocEntries()...)
	return entries
}

func docEntryForNode(group, parentPath string, node *commandNode) DocEntry {
	path := "aih " + node.Name
	if parentPath != "" {
		path = parentPath + " " + node.Name
	}
	entry := DocEntry{Group: group, Path: path, Description: node.Summary}
	for _, option := range node.Options {
		entry.Flags = append(entry.Flags, option.Name)
	}
	for _, alias := range node.Aliases {
		if parentPath == "" {
			entry.Alias = append(entry.Alias, "aih "+alias)
			continue
		}
		entry.Alias = append(entry.Alias, parentPath+" "+alias)
	}
	return entry
}

func appendChildDocEntries(entries *[]DocEntry, parentPath string, node *commandNode) {
	for index := range node.Children {
		child := &node.Children[index]
		*entries = append(*entries, docEntryForNode(parentPath, parentPath, child))
		appendChildDocEntries(entries, parentPath+" "+child.Name, child)
	}
}

// launchGrammarDocEntries 描述不在命令树里的启动位语法（Provider 裸启动/relay/跨 Provider）。
func launchGrammarDocEntries() []DocEntry {
	return []DocEntry{
		{Group: "启动语法", Path: "aih <provider>", Description: "裸启动：按健康度自动选号（Native Direct）"},
		{Group: "启动语法", Path: "aih <provider> <cliID> [原生参数...]", Description: "指定账号启动（伪 HOME 投影）"},
		{Group: "启动语法", Path: "aih <provider> relay [<cliID>] [原生参数...]", Description: "网关档：经 AIH Server，固定账号不换号"},
		{Group: "启动语法", Path: "aih <client> relay <provider> <cliID> [原生参数...]", Description: "跨 Provider：Codex/Claude 客户端跑别的 Provider 账号"},
		{Group: "启动语法", Path: "aih <cliID> [原生参数...]", Description: "裸数字：编号只在一个 Provider 内唯一时才解释"},
		{Group: "启动语法", Path: "aih <provider> -m|--model {ModelID}", Description: "指定本次会话模型（TAB 按账号模型目录补全）"},
		{Group: "启动语法", Path: "aih <provider> --model-alias {AliasID}", Description: "临时转发：请求 A 实际用 B（不落库）"},
		{Group: "启动语法", Path: "aih <provider> -- {原生参数...}", Description: "逃生门：之后的参数原样交给原生 CLI"},
	}
}
