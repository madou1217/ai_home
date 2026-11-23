package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

func applyCodexMCPFlags(args []string) ([]string, error) {
	kept := make([]string, 0, len(args))
	noMCP := false
	onlySet := false
	only := make([]string, 0, 4)
	addOnly := func(value string) {
		onlySet = true
		for _, item := range strings.Split(value, ",") {
			if item = strings.TrimSpace(item); item != "" {
				only = append(only, item)
			}
		}
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
		return nil, errors.New("--mcp 名单为空")
	}
	names, err := listCodexMCPNames()
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

func listCodexMCPNames() ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
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

func disabledMCPNames(all []string, only []string) ([]string, error) {
	allowed := make(map[string]bool, len(all))
	for _, name := range all {
		allowed[name] = true
	}
	selected := make(map[string]bool, len(only))
	for _, name := range only {
		if !allowed[name] {
			return nil, fmt.Errorf("未配置的 Codex MCP: %s", name)
		}
		selected[name] = true
	}
	disabled := make([]string, 0, len(all))
	for _, name := range all {
		if !selected[name] {
			disabled = append(disabled, name)
		}
	}
	return disabled, nil
}
