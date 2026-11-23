package main

import (
	"errors"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/mcpselection"
)

func applyCodexMCPFlags(args []string) ([]string, error) {
	kept := make([]string, 0, len(args))
	noMCP := false
	onlySet := false
	only := make([]string, 0, 4)
	addOnly := func(value string) {
		onlySet = true
		only = append(only, mcpselection.SplitList(value)...)
	}
	for index := 0; index < len(args); index++ {
		argument := args[index]
		if argument == "--" {
			kept = append(kept, args[index:]...)
			break
		}
		switch {
		case argument == "--no-mcp":
			noMCP = true
		case argument == "--mcp":
			if index+1 >= len(args) {
				return nil, errors.New("--mcp 需要 MCP 名单")
			}
			index++
			addOnly(args[index])
		case strings.HasPrefix(argument, "--mcp="):
			addOnly(strings.TrimPrefix(argument, "--mcp="))
		default:
			kept = append(kept, argument)
		}
	}
	if noMCP && onlySet {
		return nil, errors.New("--no-mcp 与 --mcp 不能同时使用")
	}
	if noMCP {
		return append([]string{"-c", "mcp_servers={}"}, kept...), nil
	}
	if !onlySet {
		return kept, nil
	}
	if len(only) == 0 {
		return nil, mcpselection.ErrNoSelection
	}
	names, err := mcpselection.CodexNames()
	if err != nil {
		return nil, err
	}
	disabled, err := disabledMCPNames(names, only)
	if err != nil {
		return nil, err
	}
	if len(disabled) == 0 {
		return kept, nil
	}
	pairs := make([]string, 0, len(disabled)*2)
	for _, name := range disabled {
		pairs = append(pairs, "-c", "mcp_servers."+name+".enabled=false")
	}
	return append(pairs, kept...), nil
}

// disabledMCPNames 校验名单并返回「未选中」的名字；名单事实来自 mcpselection。
func disabledMCPNames(all, only []string) ([]string, error) {
	if missing := mcpselection.Missing(all, only); len(missing) > 0 {
		return nil, fmt.Errorf("未配置的 Codex MCP: %s", strings.Join(missing, ","))
	}
	return mcpselection.Remaining(all, only), nil
}
