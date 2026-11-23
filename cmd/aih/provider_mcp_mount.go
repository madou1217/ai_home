package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/application/mcpscope"
	"github.com/madou1217/ai_home/internal/runtime/mcpselection"
)

var (
	mcpAccountTokenPattern = regexp.MustCompile(`^(?:\d+|acct_[a-f0-9]{20})$`)
	errMCPSelfUnavailable  = errors.New("aih executable unavailable")
)

// accountTokenFromProviderArgs finds an explicit CLI account token before the
// provider separator. The first positional word decides: an action such as
// "resume" is not an account, and a trailing session id must not be mistaken
// for one.
func accountTokenFromProviderArgs(args []string) string {
	for _, argument := range args {
		if argument == "--" {
			return ""
		}
		if strings.HasPrefix(argument, "-") {
			continue
		}
		if mcpAccountTokenPattern.MatchString(argument) {
			return argument
		}
		return ""
	}
	return ""
}

// maybePrintMCPStatus handles `--mcp-status` before any provider launch.
func maybePrintMCPStatus(provider string, args []string) (bool, int) {
	found := false
	for _, argument := range args {
		if argument == "--" {
			break
		}
		if argument == "--mcp-status" {
			found = true
			break
		}
	}
	if !found {
		return false, 0
	}
	status, err := mcpselection.BuildStatus(bareLaunchHomeDir(), provider, accountTokenFromProviderArgs(args))
	if err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "aih:", err)
		return true, 1
	}
	_, _ = fmt.Fprint(os.Stdout, status.Text())
	return true, 0
}

// selectedRegistryServers splits an explicit --mcp selection into native names
// (owned by the provider's own config) and registry definitions to mount.
func selectedRegistryServers(aiHomeDir, provider, label, accountToken string, selected []string) (native []string, mounted []mcpscope.Definition, err error) {
	nativeNames, err := mcpselection.Names(provider)
	if err != nil {
		return nil, nil, err
	}
	isNative := make(map[string]bool, len(nativeNames))
	for _, name := range nativeNames {
		isNative[name] = true
	}
	all, err := mcpselection.RegistryServers(aiHomeDir, provider, accountToken)
	if err != nil {
		return nil, nil, err
	}
	byID := make(map[string]mcpselection.RegistryServer, len(all))
	for _, server := range all {
		byID[server.Definition.ID] = server
	}
	for _, id := range selected {
		if isNative[id] {
			native = append(native, id)
			continue
		}
		server, known := byID[id]
		if !known || server.Definition.ID == mcpscope.IDRemoteTools {
			return nil, nil, fmt.Errorf("未配置的 %s MCP: %s", label, id)
		}
		if !server.Allowed {
			return nil, nil, fmt.Errorf("MCP %q 不被账号策略允许（%s）", id, server.Reason)
		}
		if server.Definition.Transport != "stdio" || strings.TrimSpace(server.Definition.Command) == "" {
			return nil, nil, fmt.Errorf("MCP %q 目前只支持本地 stdio 挂载", id)
		}
		mounted = append(mounted, server.Definition)
	}
	return native, mounted, nil
}

// codexRegistryArgs builds Codex -c overrides that launch each registry MCP
// through the prefix proxy, so its tools appear as <id>.<tool>.
func codexRegistryArgs(definitions []mcpscope.Definition) ([]string, error) {
	self, err := os.Executable()
	if err != nil || strings.TrimSpace(self) == "" {
		return nil, errMCPSelfUnavailable
	}
	pairs := make([]string, 0, len(definitions)*6)
	for _, definition := range definitions {
		command := append([]string{definition.Command}, definition.Args...)
		argv := mcpselection.PrefixedArgv(self, definition.ID, command)
		prefix := "mcp_servers." + definition.ID + "."
		pairs = append(pairs, "-c", prefix+"command="+tomlString(argv[0]))
		pairs = append(pairs, "-c", prefix+"args="+tomlStringArray(argv[1:]))
		if len(definition.Env) > 0 {
			pairs = append(pairs, "-c", prefix+"env="+tomlInlineTable(definition.Env))
		}
	}
	return pairs, nil
}

// claudeRegistryServers builds the mcpServers entries for the same proxy launch.
func claudeRegistryServers(definitions []mcpscope.Definition) (map[string]any, error) {
	self, err := os.Executable()
	if err != nil || strings.TrimSpace(self) == "" {
		return nil, errMCPSelfUnavailable
	}
	servers := make(map[string]any, len(definitions))
	for _, definition := range definitions {
		command := append([]string{definition.Command}, definition.Args...)
		argv := mcpselection.PrefixedArgv(self, definition.ID, command)
		entry := map[string]any{
			"command": argv[0],
			"args":    argv[1:],
		}
		if len(definition.Env) > 0 {
			entry["env"] = definition.Env
		}
		servers[definition.ID] = entry
	}
	return servers, nil
}

func tomlString(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func tomlStringArray(values []string) string {
	encoded, _ := json.Marshal(values)
	return string(encoded)
}

func tomlInlineTable(values map[string]string) string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, tomlString(key)+" = "+tomlString(values[key]))
	}
	return "{" + strings.Join(parts, ", ") + "}"
}
