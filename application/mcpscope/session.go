package mcpscope

import (
	"fmt"
	"strings"
)

// SessionSelection narrows the account's effective MCP set for one launch.
// The account policy remains the ceiling: a session can only remove MCPs.
type SessionSelection struct {
	NoMCP bool
	Only  []string
}

// ResolveSession applies a session selection on top of the account policy.
func ResolveSession(definitions []Definition, account Policy, session SessionSelection, context Context) ([]Resolved, error) {
	base, err := Resolve(definitions, account, context)
	if err != nil {
		return nil, err
	}
	if session.NoMCP {
		return nil, nil
	}
	if len(session.Only) == 0 {
		return base, nil
	}
	allowed := make(map[string]Resolved, len(base))
	for _, item := range base {
		allowed[item.ID] = item
	}
	seen := make(map[string]bool, len(session.Only))
	out := make([]Resolved, 0, len(session.Only))
	for _, raw := range session.Only {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		item, ok := allowed[id]
		if !ok {
			return nil, fmt.Errorf("mcp %q is not allowed by the account policy", id)
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, item)
	}
	return out, nil
}
