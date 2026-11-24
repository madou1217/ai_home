package completion

import (
	"strings"

	"github.com/madou1217/ai_home/core/harnesses"
)

// namedSummary 是「名字 + 一句话说明」的通用条目，供 Provider 动作复用。
type namedSummary struct {
	Name    string
	Summary string
}

func harnessSubcommands() []namedSummary {
	items := harnesses.List()
	result := make([]namedSummary, 0, len(items))
	for _, item := range items {
		summary := strings.TrimSpace(item.Label)
		if summary == "" {
			summary = strings.TrimSpace(item.Description)
		}
		result = append(result, namedSummary{Name: item.ID, Summary: summary})
	}
	return result
}

// topLevelCommands 是补全/建议消费的唯一命令树；数据在 catalog.go。
var topLevelCommands = buildCommandCatalog()

var topLevelCommandIndex = buildTopLevelCommandIndex()

func buildTopLevelCommandIndex() map[string]int {
	index := make(map[string]int, len(topLevelCommands)*2)
	for position := range topLevelCommands {
		command := &topLevelCommands[position]
		index[strings.ToLower(command.Name)] = position
		for _, alias := range command.Aliases {
			index[strings.ToLower(alias)] = position
		}
	}
	return index
}

// findTopLevelCommand 返回命令（含别名）的节点；未知命令返回 false。
func findTopLevelCommand(token string) (commandNode, bool) {
	position, found := topLevelCommandIndex[strings.ToLower(strings.TrimSpace(token))]
	if !found {
		return commandNode{}, false
	}
	return topLevelCommands[position], true
}

func listTopLevelCommandNames() []string {
	names := make([]string, 0, len(topLevelCommands)*2)
	for _, command := range topLevelCommands {
		names = append(names, command.Name)
		names = append(names, command.Aliases...)
	}
	return names
}
