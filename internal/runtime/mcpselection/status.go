package mcpselection

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/serverconfig"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// Status is the resolved view behind `--mcp-status`.
type Status struct {
	Provider     string
	AccountToken string
	Native       []string
	Registry     []RegistryServer
	Sharing      string
	Profiles     []string
}

// BuildStatus resolves the local CLI catalog plus the server-side sharing mode.
func BuildStatus(aiHomeDir, provider, accountToken string) (Status, error) {
	native, err := Names(provider)
	if err != nil {
		return Status{}, err
	}
	registry, err := RegistryServers(aiHomeDir, provider, accountToken)
	if err != nil {
		return Status{}, err
	}
	return Status{
		Provider:     strings.ToLower(strings.TrimSpace(provider)),
		AccountToken: strings.TrimSpace(accountToken),
		Native:       native,
		Registry:     registry,
		Sharing:      SharingMode(aiHomeDir),
		Profiles:     ListProfiles(aiHomeDir),
	}, nil
}

// SharingMode reads config:server.mcpBridgeSharing and defaults to global.
func SharingMode(aiHomeDir string) string {
	path, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return serverconfig.MCPBridgeSharingGlobal
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	raw, found, err := appstate.ReadKV(ctx, path, appstate.KeyServerConfig)
	if err != nil || !found {
		return serverconfig.MCPBridgeSharingGlobal
	}
	return serverconfig.ParseMCPBridgeSharing(raw)
}

// Text renders a compact, terminal-friendly status report.
func (status Status) Text() string {
	var builder strings.Builder
	account := status.AccountToken
	if account == "" {
		account = "(默认/未指定)"
	}
	fmt.Fprintf(&builder, "Provider: %s    账号: %s\n", status.Provider, account)
	fmt.Fprintf(&builder, "共享桥: %s（服务端工作区会话；本地 CLI 自行挂载 MCP）\n", status.Sharing)
	if len(status.Native) == 0 {
		builder.WriteString("原生 MCP: (无)\n")
	} else {
		fmt.Fprintf(&builder, "原生 MCP: %s\n", strings.Join(status.Native, ", "))
	}
	if len(status.Registry) == 0 {
		builder.WriteString("注册表 MCP: (无)\n")
	} else {
		builder.WriteString("注册表 MCP:\n")
		for _, server := range status.Registry {
			flags := make([]string, 0, 2)
			if server.Default {
				flags = append(flags, "默认")
			}
			switch {
			case server.LocalMountable:
				flags = append(flags, "可本地选择")
			case server.Allowed:
				flags = append(flags, "仅服务端")
			default:
				flags = append(flags, "不可选")
			}
			fmt.Fprintf(&builder, "  - %s  [%s] %s\n", server.Definition.ID, strings.Join(flags, "/"), server.Reason)
		}
	}
	if len(status.Profiles) > 0 {
		fmt.Fprintf(&builder, "配置集: %s\n", strings.Join(status.Profiles, ", "))
	}
	builder.WriteString("本地默认: 原生 MCP 全部启用；注册表 MCP 需用 --mcp 显式选择\n")
	builder.WriteString("用法: --mcp a,b | --mcp-profile <名称> | --no-mcp\n")
	return builder.String()
}
