// Package mcpselection 是「本次会话启用哪些 MCP」的唯一事实源：
// 名单读取、名单解析与 Provider 支持判定都在这里，CLI 参数注入与 TAB 补全共用。
//
// Codex 的名单只能由原生 `codex mcp list --json` 给出（版本/插件解析在它内部）；
// Claude 是用户级与项目级配置的合并。读取一律带超时，调用方按失败即空处理。
package mcpselection

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
)

const (
	// ProviderCodex 是 Codex CLI（原生 mcp_servers 配置）。
	ProviderCodex = "codex"
	// ProviderClaude 是 Claude Code（--mcp-config / --strict-mcp-config）。
	ProviderClaude = "claude"
)

// listTimeout 上限针对补全这种交互路径：超时就当没有候选，不能卡住 TAB。
const listTimeout = 2 * time.Second

// Supports 判断 Provider 是否实现了 MCP 选择入口。
func Supports(provider string) bool {
	switch normalize(provider) {
	case ProviderCodex, ProviderClaude:
		return true
	default:
		return false
	}
}

// SplitList 解析 --mcp 的逗号名单。
func SplitList(value string) []string {
	items := make([]string, 0, 4)
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			items = append(items, item)
		}
	}
	return items
}

// Names 返回 Provider 已配置的 MCP 名称；Codex 保持原生顺序，Claude 排序。
func Names(provider string) ([]string, error) {
	switch normalize(provider) {
	case ProviderCodex:
		return CodexNames()
	case ProviderClaude:
		servers, err := ClaudeServers()
		if err != nil {
			return nil, err
		}
		return SortedKeys(servers), nil
	default:
		return nil, fmt.Errorf("不支持 MCP 选择的 Provider: %s", provider)
	}
}

// CodexNames 读取原生 Codex MCP 名单。
func CodexNames() ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), listTimeout)
	defer cancel()
	output, err := exec.CommandContext(ctx, "codex", "mcp", "list", "--json").Output()
	if err != nil {
		return nil, fmt.Errorf("读取 Codex MCP 名单失败: %w", err)
	}
	var entries []any
	if err := json.Unmarshal(output, &entries); err != nil {
		return nil, fmt.Errorf("Codex MCP 名单格式无效: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		switch value := entry.(type) {
		case string:
			names = append(names, value)
		case map[string]any:
			if name, ok := value["name"].(string); ok && name != "" {
				names = append(names, name)
			}
		}
	}
	return names, nil
}

// ClaudeServers 合并用户级 ~/.claude/.claude.json 与当前目录 .mcp.json 的定义。
func ClaudeServers() (map[string]any, error) {
	merged := map[string]any{}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	sources := []string{filepath.Join(append([]string{home}, providerroot.ConfigPath(ProviderClaude, ".claude.json")...)...)}
	if cwd, err := os.Getwd(); err == nil {
		sources = append(sources, filepath.Join(cwd, ".mcp.json"))
	}
	for _, source := range sources {
		raw, err := os.ReadFile(source)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return nil, err
		}
		var document struct {
			MCPServers map[string]any `json:"mcpServers"`
		}
		if err := json.Unmarshal(raw, &document); err != nil {
			return nil, fmt.Errorf("读取 %s 失败: %w", source, err)
		}
		for id, definition := range document.MCPServers {
			merged[id] = definition
		}
	}
	return merged, nil
}

// SortedKeys 返回定义的名称（排序后），供候选与校验共用。
func SortedKeys(servers map[string]any) []string {
	names := make([]string, 0, len(servers))
	for name := range servers {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Remaining 返回 all 中未被 selected 选中的名字，保持 all 的顺序。
func Remaining(all, selected []string) []string {
	chosen := make(map[string]bool, len(selected))
	for _, name := range selected {
		chosen[name] = true
	}
	remaining := make([]string, 0, len(all))
	for _, name := range all {
		if !chosen[name] {
			remaining = append(remaining, name)
		}
	}
	return remaining
}

// Missing 返回 selected 中不在 all 里的名字，用于「未配置」校验。
func Missing(all, selected []string) []string {
	known := make(map[string]bool, len(all))
	for _, name := range all {
		known[name] = true
	}
	missing := make([]string, 0, len(selected))
	for _, name := range selected {
		if !known[name] {
			missing = append(missing, name)
		}
	}
	return missing
}

// ErrNoSelection 是名单为空时的统一错误，避免两个 Provider 各写一份。
var ErrNoSelection = errors.New("--mcp 名单为空")

func normalize(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}
