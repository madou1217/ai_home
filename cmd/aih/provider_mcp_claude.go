package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func applyClaudeMCPFlags(args []string) ([]string, error) {
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
	if !noMCP && !onlySet {
		return kept, nil
	}
	servers := map[string]any{}
	if onlySet {
		all, err := claudeMCPServers()
		if err != nil {
			return nil, err
		}
		for _, id := range only {
			definition, ok := all[id]
			if !ok {
				return nil, fmt.Errorf("未配置的 Claude MCP: %s", id)
			}
			servers[id] = definition
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

func claudeMCPServers() (map[string]any, error) {
	merged := map[string]any{}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	sources := []string{filepath.Join(home, ".claude", ".claude.json")}
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
