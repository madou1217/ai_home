package mcpscope

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// RegistryPath is the user-editable registry merged with the built-ins.
func RegistryPath(aiHomeDir string) string {
	return filepath.Join(aiHomeDir, "mcp", "registry.json")
}

type registryDocument struct {
	MCPServers []Definition `json:"mcpServers"`
}

// LoadRegistry returns the built-in MCPs plus entries from the registry file.
// A missing file is valid and yields the built-ins. Duplicate ids fail closed.
func LoadRegistry(aiHomeDir string) ([]Definition, error) {
	definitions := Builtins()
	raw, err := os.ReadFile(RegistryPath(aiHomeDir))
	if err != nil {
		if os.IsNotExist(err) {
			return definitions, nil
		}
		return nil, err
	}
	var document registryDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, fmt.Errorf("invalid mcp registry: %w", err)
	}
	seen := make(map[string]bool, len(definitions))
	for _, definition := range definitions {
		seen[definition.ID] = true
	}
	for index, entry := range document.MCPServers {
		entry.ID = strings.TrimSpace(entry.ID)
		if entry.ID == "" {
			return nil, fmt.Errorf("mcp registry entry %d has no id", index)
		}
		if seen[entry.ID] {
			return nil, fmt.Errorf("duplicate mcp id %q", entry.ID)
		}
		entry.Transport = strings.TrimSpace(entry.Transport)
		if entry.Transport == "" {
			entry.Transport = "stdio"
		}
		if entry.Transport == "stdio" && strings.TrimSpace(entry.Command) == "" {
			return nil, fmt.Errorf("mcp %q requires a command", entry.ID)
		}
		seen[entry.ID] = true
		definitions = append(definitions, entry)
	}
	return definitions, nil
}
