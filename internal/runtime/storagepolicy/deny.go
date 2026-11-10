package storagepolicy

import (
	"path/filepath"
	"strings"
)

// normalizeName trims and lowercases a provider name without validating it.
func normalizeName(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}

func trimSpace(value string) string { return strings.TrimSpace(value) }

func normalizeSegment(segment string) string {
	return strings.ToLower(strings.TrimSpace(segment))
}

// normalizeSegments lowercases and trims every segment, dropping empties.
func normalizeSegments(segments []string) []string {
	out := make([]string, 0, len(segments))
	for _, segment := range segments {
		if normalized := normalizeSegment(segment); normalized != "" {
			out = append(out, normalized)
		}
	}
	return out
}

// splitPathParts splits on both separators (the JS source accepts either) and
// normalizes each segment the same way policy segments are normalized.
func splitPathParts(value string) []string {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return nil
	}
	return normalizeSegments(strings.FieldsFunc(raw, func(r rune) bool {
		return r == '/' || r == '\\'
	}))
}

func joinPath(root string, segments []string) string {
	parts := make([]string, 0, len(segments)+1)
	parts = append(parts, root)
	parts = append(parts, segments...)
	return filepath.Join(parts...)
}

func hasPrefix(value, prefix string) bool { return strings.HasPrefix(value, prefix) }

func containsString(items []string, candidate string) bool {
	for _, item := range items {
		if item == candidate {
			return true
		}
	}
	return false
}

// hasSegmentPrefix reports whether candidate starts with every segment of prefix.
func hasSegmentPrefix(candidate, prefix []string) bool {
	if len(candidate) < len(prefix) {
		return false
	}
	for index, segment := range prefix {
		if candidate[index] != segment {
			return false
		}
	}
	return true
}

// matchesSuffix reports whether expected matches the tail of parts. The last
// segment also matches migration variants ("<name>.<suffix>").
func matchesSuffix(parts, expected []string) bool {
	if len(expected) == 0 || len(parts) < len(expected) {
		return false
	}
	offset := len(parts) - len(expected)
	for index, want := range expected {
		got := parts[offset+index]
		if index < len(expected)-1 {
			if got != want {
				return false
			}
			continue
		}
		if got != want && !hasPrefix(got, want+".") {
			return false
		}
	}
	return true
}

// IsAuthArtifactSegments reports whether segments identify a provider
// credential artifact exactly (same depth, same tail).
func IsAuthArtifactSegments(provider string, segments []string) bool {
	policy := Get(provider)
	if policy == nil {
		return false
	}
	candidate := normalizeSegments(segments)
	for _, artifact := range policy.AuthArtifacts {
		expected := normalizeSegments(artifact.Path)
		if len(candidate) != len(expected) {
			continue
		}
		if matchesSuffix(candidate, expected) {
			return true
		}
	}
	return false
}

// IsAuthArtifactPath reports whether an absolute or relative path points at a
// provider credential artifact. Any basename "credentials.json" is treated as
// a credential regardless of provider.
func IsAuthArtifactPath(filePath string) bool {
	parts := splitPathParts(filePath)
	if len(parts) == 0 {
		return false
	}
	for _, provider := range providerOrder {
		for _, artifact := range policies[provider].AuthArtifacts {
			if matchesSuffix(parts, normalizeSegments(artifact.Path)) {
				return true
			}
		}
	}
	return parts[len(parts)-1] == "credentials.json"
}

// IsPrivateArtifactPath reports whether a path points at account-private state
// (credentials included). The match is on the path tail, so a file inside a
// private directory is not private unless the artifact itself ends the path.
func IsPrivateArtifactPath(filePath string) bool {
	parts := splitPathParts(filePath)
	if len(parts) == 0 {
		return false
	}
	if IsAuthArtifactPath(filePath) {
		return true
	}
	for _, provider := range providerOrder {
		for _, artifact := range policies[provider].PrivateArtifacts {
			if matchesSuffix(parts, normalizeSegments(artifact.Path)) {
				return true
			}
		}
	}
	return false
}

// configLocation is one provider configuration path the file API must deny.
// recursive denies everything below the path; variants additionally denies
// "<name>.<suffix>" backups next to the original file.
type configLocation struct {
	path      []string
	recursive bool
	variants  bool
}

var configurationLocations = []configLocation{
	{path: []string{".config", "opencode"}, recursive: true},
	{path: []string{".gemini", "config"}, recursive: true},
	{path: []string{".codex", "config.toml"}, variants: true},
	{path: []string{".codex", "hooks.json"}, variants: true},
	{path: []string{".claude", "settings.json"}, variants: true},
	{path: []string{".claude", "settings.local.json"}, variants: true},
	{path: []string{".claude", "remote-settings.json"}, variants: true},
	{path: []string{".claude", ".mcp.json"}, variants: true},
	{path: []string{".claude", ".claude.json"}, variants: true},
	{path: []string{".mcp.json"}, variants: true},
	{path: []string{".claude.json"}, variants: true},
	{path: []string{".gemini", "settings.json"}, variants: true},
	{path: []string{".gemini", ".gemini", "settings.json"}, variants: true},
	{path: []string{".gemini", "antigravity-cli", "settings.json"}, variants: true},
	{path: []string{".gemini", "antigravity-cli", "settings.local.json"}, variants: true},
	{path: []string{".gemini", "antigravity-cli", "keybindings.json"}, variants: true},
	{path: []string{".gemini", "antigravity-cli", "mcp_config.json"}, variants: true},
}

// PathWithinRoot reports whether target is root itself or lives below it.
func PathWithinRoot(root, target string) bool {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(target))
	if err != nil {
		return false
	}
	if relative == "" {
		return true
	}
	return relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator)) &&
		!filepath.IsAbs(relative)
}

// IsConfigurationPath reports whether target is a provider configuration file
// that the file API must not expose, given the host home it belongs to.
func IsConfigurationPath(homeDir, target string) bool {
	home := strings.TrimSpace(homeDir)
	value := strings.TrimSpace(target)
	if home == "" || value == "" || !filepath.IsAbs(value) {
		return false
	}
	resolvedTarget := filepath.Clean(value)
	for _, location := range configurationLocations {
		resolvedLocation := absJoin(home, location.path)
		if location.recursive {
			if PathWithinRoot(resolvedLocation, resolvedTarget) {
				return true
			}
			continue
		}
		if !location.variants {
			if resolvedLocation == resolvedTarget {
				return true
			}
			continue
		}
		if filepath.Dir(resolvedLocation) != filepath.Dir(resolvedTarget) {
			continue
		}
		expected := filepath.Base(resolvedLocation)
		actual := filepath.Base(resolvedTarget)
		if actual == expected || hasPrefix(actual, expected+".") {
			return true
		}
	}
	return false
}

func absJoin(home string, segments []string) string {
	joined := joinPath(home, segments)
	if filepath.IsAbs(joined) {
		return joined
	}
	absolute, err := filepath.Abs(joined)
	if err != nil {
		return joined
	}
	return absolute
}
