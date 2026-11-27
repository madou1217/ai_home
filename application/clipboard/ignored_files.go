package clipboard

import (
	"path/filepath"
	"strings"
)

// ignoredClipboardFilePrefix marks UU Remote's encrypted scratch files. They
// are transport internals, not user content, and must never enter history or
// sync.
const ignoredClipboardFilePrefix = ".uuremote_"

// IsIgnoredClipboardFile reports whether a file path is a UU Remote scratch
// file. The check is basename/case-insensitive so Windows and macOS paths both
// match.
func IsIgnoredClipboardFile(path string) bool {
	base := strings.ToLower(strings.TrimSpace(filepath.Base(strings.TrimSpace(path))))
	return strings.HasPrefix(base, ignoredClipboardFilePrefix)
}

// FilterIgnoredClipboardFiles removes UU Remote scratch files while preserving
// the order of genuine user files.
func FilterIgnoredClipboardFiles(files []string) []string {
	filtered := make([]string, 0, len(files))
	for _, path := range files {
		if IsIgnoredClipboardFile(path) {
			continue
		}
		filtered = append(filtered, path)
	}
	return filtered
}
