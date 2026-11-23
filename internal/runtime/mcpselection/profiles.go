package mcpselection

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ProfilesPath is the user-editable named MCP selections file.
func ProfilesPath(aiHomeDir string) string {
	return filepath.Join(aiHomeDir, "mcp", "profiles.json")
}

type profilesDocument struct {
	Profiles map[string][]string `json:"profiles"`
}

// LoadProfile returns the ids of one named profile. An unknown name is an error
// so a typo never silently launches with the default set.
func LoadProfile(aiHomeDir, name string) ([]string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, fmt.Errorf("--mcp-profile 需要名称")
	}
	raw, err := os.ReadFile(ProfilesPath(aiHomeDir))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("没有 MCP 配置集文件: %s", ProfilesPath(aiHomeDir))
		}
		return nil, err
	}
	var document profilesDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return nil, fmt.Errorf("MCP 配置集文件格式无效: %w", err)
	}
	ids, ok := document.Profiles[name]
	if !ok {
		return nil, fmt.Errorf("未定义的 MCP 配置集: %s", name)
	}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if id = strings.TrimSpace(id); id != "" {
			out = append(out, id)
		}
	}
	return out, nil
}

// ListProfiles returns the defined profile names in stable order.
func ListProfiles(aiHomeDir string) []string {
	raw, err := os.ReadFile(ProfilesPath(aiHomeDir))
	if err != nil {
		return nil
	}
	var document profilesDocument
	if json.Unmarshal(raw, &document) != nil {
		return nil
	}
	names := make([]string, 0, len(document.Profiles))
	for name := range document.Profiles {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
