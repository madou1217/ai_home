package mcpscope

import (
	"fmt"
	"sort"
	"strings"
)

// Mode is the account-level MCP policy.
type Mode string

const (
	// ModeAuto enables the registry defaults (plus context requirements).
	ModeAuto Mode = "auto"
	// ModeAllowlist enables exactly the listed MCP ids.
	ModeAllowlist Mode = "allowlist"
	// ModeDisabled is a hard account ceiling: no MCP is available.
	ModeDisabled Mode = "disabled"
)

// Policy is the account-level MCP selection.
type Policy struct {
	Mode  Mode     `json:"mode"`
	Allow []string `json:"allow"`
}

// Context describes the session that is resolving MCPs.
type Context struct {
	Provider       string
	WorkspaceBound bool
}

// Resolved is one effective MCP entry.
type Resolved struct {
	Definition
	Source string
	Reason string
}

// Resolve applies the account policy to the registry and returns the effective
// set. It never widens beyond the account policy; session-level narrowing is a
// later phase and operates on this result.
func Resolve(definitions []Definition, policy Policy, context Context) ([]Resolved, error) {
	if policy.Mode == "" {
		policy.Mode = ModeAuto
	}
	switch policy.Mode {
	case ModeDisabled:
		return nil, nil
	case ModeAuto, ModeAllowlist:
	default:
		return nil, fmt.Errorf("unknown mcp policy mode %q", policy.Mode)
	}

	byID := make(map[string]Definition, len(definitions))
	for _, definition := range definitions {
		byID[definition.ID] = definition
	}

	ids := make([]string, 0, len(definitions))
	source := "全局默认"
	if policy.Mode == ModeAllowlist {
		source = "账号允许列表"
		for _, raw := range policy.Allow {
			id := strings.TrimSpace(raw)
			if id == "" {
				continue
			}
			if _, ok := byID[id]; !ok {
				return nil, fmt.Errorf("unknown mcp %q", id)
			}
			ids = append(ids, id)
		}
	} else {
		for _, definition := range definitions {
			if definition.Default {
				ids = append(ids, definition.ID)
			}
		}
	}

	sort.Strings(ids)
	seen := make(map[string]bool, len(ids))
	resolved := make([]Resolved, 0, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		definition := byID[id]
		if !providerAllowed(definition, context.Provider) {
			continue
		}
		reason := source
		if policy.Mode == ModeAuto && context.WorkspaceBound && definition.ID == IDRemoteTools {
			reason = "workspace 绑定"
		}
		resolved = append(resolved, Resolved{Definition: definition, Source: source, Reason: reason})
	}
	return resolved, nil
}

// Validate checks a policy against the built-in registry.
func Validate(policy Policy) error {
	return ValidateWith(Builtins(), policy)
}

// ValidateWith checks a policy against an explicit registry.
func ValidateWith(definitions []Definition, policy Policy) error {
	mode := policy.Mode
	if mode == "" {
		mode = ModeAuto
	}
	switch mode {
	case ModeAuto, ModeDisabled:
		return nil
	case ModeAllowlist:
	default:
		return fmt.Errorf("unknown mcp policy mode %q", policy.Mode)
	}
	known := make(map[string]bool)
	for _, definition := range definitions {
		known[definition.ID] = true
	}
	for _, raw := range policy.Allow {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if !known[id] {
			return fmt.Errorf("unknown mcp %q", id)
		}
	}
	return nil
}

func providerAllowed(definition Definition, provider string) bool {
	if len(definition.Providers) == 0 || strings.TrimSpace(provider) == "" {
		return true
	}
	for _, candidate := range definition.Providers {
		if strings.EqualFold(strings.TrimSpace(candidate), strings.TrimSpace(provider)) {
			return true
		}
	}
	return false
}
