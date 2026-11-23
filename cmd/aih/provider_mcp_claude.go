package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/mcpselection"
)

func applyClaudeMCPFlags(args []string) ([]string, error) {
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
	if !noMCP && !onlySet {
		return kept, nil
	}
	servers := map[string]any{}
	if onlySet {
		if len(only) == 0 {
			return nil, mcpselection.ErrNoSelection
		}
		all, err := mcpselection.ClaudeServers()
		if err != nil {
			return nil, err
		}
		if missing := mcpselection.Missing(mcpselection.SortedKeys(all), only); len(missing) > 0 {
			return nil, fmt.Errorf("未配置的 Claude MCP: %s", strings.Join(missing, ","))
		}
		for _, id := range only {
			servers[id] = all[id]
		}
	}
	raw, err := json.Marshal(map[string]any{"mcpServers": servers})
	if err != nil {
		return nil, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(home, ".ai_home", "run", "mcp")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, fmt.Sprintf("claude-%d.json", os.Getpid()))
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return nil, err
	}
	return append([]string{"--strict-mcp-config", "--mcp-config", path}, kept...), nil
}
