// Package mcpscope resolves which MCP servers an account or session may use.
package mcpscope

const (
	// IDRemoteTools is the built-in workspace tool bridge.
	IDRemoteTools = "aih_remote"
)

// Definition is one registered MCP server.
type Definition struct {
	ID           string
	DisplayName  string
	Default      bool
	Capabilities []string
	// Providers restricts the definition to specific harnesses. Empty means all.
	Providers []string
}

// Builtins returns the MCP servers registered by the core.
func Builtins() []Definition {
	return []Definition{{
		ID:           IDRemoteTools,
		DisplayName:  "Remote Workspace Tools",
		Default:      true,
		Capabilities: []string{"read", "write", "run"},
	}}
}
