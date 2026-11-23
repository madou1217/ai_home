package mcpselection

import (
	"context"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/application/mcpscope"
	"github.com/madou1217/ai_home/internal/runtime/accountmcps"
)

// RegistryServer is one AIH-registry MCP that a local CLI can mount.
//
// Allowed is the account ceiling: a session may select it with --mcp, but an
// account policy of "disabled" or an allowlist that omits it is a hard no.
type RegistryServer struct {
	Definition     mcpscope.Definition
	Default        bool
	Allowed        bool
	LocalMountable bool
	Reason         string
}

type registryCeiling struct {
	allowAll bool
	ids      map[string]string
	reason   string
}

func accountCeiling(aiHomeDir, provider, accountToken string) registryCeiling {
	ceiling := registryCeiling{allowAll: true, reason: "未指定账号：注册表全部可用"}
	accountRef, ok := accountmcps.ResolveAccountRef(aiHomeDir, provider, accountToken)
	if !ok {
		return ceiling
	}
	store, err := accountmcps.NewStore(aiHomeDir)
	if err != nil {
		return ceiling
	}
	policy, err := store.Get(context.Background(), accountRef)
	if err != nil {
		return ceiling
	}
	switch policy.Mode {
	case mcpscope.ModeDisabled:
		return registryCeiling{allowAll: false, ids: map[string]string{}, reason: "账号策略：全部关闭"}
	case mcpscope.ModeAllowlist:
		ids := make(map[string]string, len(policy.Allow))
		for _, id := range policy.Allow {
			if id = strings.TrimSpace(id); id != "" {
				ids[id] = "账号允许列表"
			}
		}
		return registryCeiling{allowAll: false, ids: ids, reason: "账号允许列表"}
	default:
		// auto: the registry defaults are the effective set, but every
		// provider-compatible entry stays selectable per session.
		return registryCeiling{allowAll: true, reason: "账号策略：自动"}
	}
}

// RegistryServers returns the provider-compatible registry entries together
// with the account ceiling. Without an account token the ceiling is the whole
// compatible set; a resolved account narrows it by its saved policy.
func RegistryServers(aiHomeDir, provider, accountToken string) ([]RegistryServer, error) {
	definitions, err := mcpscope.LoadRegistry(aiHomeDir)
	if err != nil {
		return nil, err
	}
	ceiling := accountCeiling(aiHomeDir, provider, accountToken)
	servers := make([]RegistryServer, 0, len(definitions))
	for _, definition := range definitions {
		if !mcpscope.AllowsProvider(definition, provider) {
			continue
		}
		allowed := ceiling.allowAll
		itemReason := ceiling.reason
		if !ceiling.allowAll {
			if source, ok := ceiling.ids[definition.ID]; ok {
				allowed = true
				itemReason = source
			} else {
				allowed = false
				itemReason = "账号策略未允许"
			}
		}
		if definition.ID == mcpscope.IDRemoteTools {
			// The workspace bridge has no local CLI context; it stays visible for
			// status but cannot be mounted by `aih codex`/`aih claude`.
			itemReason = "仅服务端会话（工作区桥）"
		}
		servers = append(servers, RegistryServer{
			Definition:     definition,
			Default:        definition.Default,
			Allowed:        allowed,
			LocalMountable: allowed && definition.ID != mcpscope.IDRemoteTools && definition.Transport == "stdio" && strings.TrimSpace(definition.Command) != "",
			Reason:         itemReason,
		})
	}
	sort.SliceStable(servers, func(left, right int) bool {
		return servers[left].Definition.ID < servers[right].Definition.ID
	})
	return servers, nil
}

// MountableRegistryServers narrows RegistryServers to entries a local CLI can
// actually inject into the provider (stdio with a command).
func MountableRegistryServers(aiHomeDir, provider, accountToken string) ([]RegistryServer, error) {
	all, err := RegistryServers(aiHomeDir, provider, accountToken)
	if err != nil {
		return nil, err
	}
	mountable := make([]RegistryServer, 0, len(all))
	for _, server := range all {
		if server.LocalMountable {
			mountable = append(mountable, server)
		}
	}
	return mountable, nil
}
