package storagepolicy

import (
	"path/filepath"
	"strings"
)

// readableResource is the fs allowlist entry for one provider: provider-owned
// conversation artifacts the WebUI file API may expose. Credentials and
// configuration are intentionally absent, so this list stays independent from
// projection/storage mappings.
type readableResource struct {
	provider string
	subdirs  [][]string
}

var readableResources = []readableResource{
	{provider: "codex", subdirs: [][]string{{"attachments"}}},
	{provider: "claude", subdirs: [][]string{{"artifacts"}, {"image-cache"}, {"projects"}}},
	{provider: "gemini", subdirs: [][]string{{"history"}, {"tmp"}}},
	{provider: "agy", subdirs: [][]string{{"brain"}, {"scratch"}}},
	{provider: "opencode", subdirs: [][]string{{"storage"}}},
}

// ReadableResourceRoots returns the provider directories under homeDir that the
// file API may read, deduplicated in declaration order. For each provider the
// attachment root comes first, then the resource subdirectories.
func ReadableResourceRoots(homeDir string) []string {
	home := strings.TrimSpace(homeDir)
	if home == "" {
		return []string{}
	}
	roots := []string{}
	seen := map[string]struct{}{}
	add := func(candidate string) {
		if _, ok := seen[candidate]; ok {
			return
		}
		seen[candidate] = struct{}{}
		roots = append(roots, candidate)
	}
	for _, resource := range readableResources {
		policy := Get(resource.provider)
		if policy == nil {
			continue
		}
		nativeRoot := absJoin(home, policy.NativeRoot)
		add(absJoin(nativeRoot, policy.AttachmentSubdir))
		for _, subdir := range resource.subdirs {
			add(filepath.Join(nativeRoot, filepath.Join(subdir...)))
		}
	}
	return roots
}
