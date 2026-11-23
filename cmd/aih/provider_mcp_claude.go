package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/mcpselection"
)

func applyClaudeMCPFlags(args []string) ([]string, error) {
	aiHomeDir := bareLaunchHomeDir()
	accountToken := accountTokenFromProviderArgs(args)
	kept := make([]string, 0, len(args))
	noMCP := false
	onlySet := false
	only := make([]string, 0, 4)
	addOnly := func(value string) {
		onlySet = true
		only = append(only, mcpselection.SplitList(value)...)
	}
	addProfile := func(name string) error {
		ids, err := mcpselection.LoadProfile(aiHomeDir, name)
		if err != nil {
			return err
		}
		addOnly(strings.Join(ids, ","))
		return nil
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
		case argument == "--mcp-profile":
			if index+1 >= len(args) {
				return nil, errors.New("--mcp-profile 需要名称")
			}
			index++
			if err := addProfile(args[index]); err != nil {
				return nil, err
			}
		case strings.HasPrefix(argument, "--mcp-profile="):
			if err := addProfile(strings.TrimPrefix(argument, "--mcp-profile=")); err != nil {
				return nil, err
			}
		case argument == "--mcp-status":
			return nil, errors.New("--mcp-status 不能与启动参数一起使用")
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
		nativeSelected, mounted, err := selectedRegistryServers(aiHomeDir, mcpselection.ProviderClaude, "Claude", accountToken, only)
		if err != nil {
			return nil, err
		}
		for _, id := range nativeSelected {
			servers[id] = all[id]
		}
		registryServers, err := claudeRegistryServers(mounted)
		if err != nil {
			return nil, err
		}
		for id, definition := range registryServers {
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
	pruneStaleMCPConfigs(dir)
	path := filepath.Join(dir, fmt.Sprintf("claude-%d.json", os.Getpid()))
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return nil, err
	}
	return append([]string{"--strict-mcp-config", "--mcp-config", path}, kept...), nil
}

// staleMCPConfigAge bounds how long a generated Claude MCP config may linger.
// Claude reads the config during startup, so anything older is dead weight from
// earlier launches (and was previously never cleaned up).
const staleMCPConfigAge = 60 * 60 // seconds

// pruneStaleMCPConfigs removes generated claude-<pid>.json files that are old
// enough to be abandoned. The current process's file (written after pruning) is
// never touched.
func pruneStaleMCPConfigs(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	now := time.Now().Unix()
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "claude-") || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if now-info.ModTime().Unix() < staleMCPConfigAge {
			continue
		}
		_ = os.Remove(filepath.Join(dir, entry.Name()))
	}
}
