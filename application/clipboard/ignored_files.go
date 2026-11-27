package clipboard

import (
	"path/filepath"
	"sort"
	"strconv"
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

// FilePackageIdentity is a portable identity for a batch of files. Absolute
// paths differ between devices, so hashing them would create a duplicate row
// when the same package is copied on two machines. Basenames plus the total
// payload size are stable across devices and still distinguish normal batches.
func FilePackageIdentity(files []string, totalBytes int64) []byte {
	names := make([]string, 0, len(files))
	for _, path := range files {
		name := strings.ToLower(strings.TrimSpace(filepath.Base(strings.TrimSpace(path))))
		if name == "" {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	var builder strings.Builder
	builder.WriteString(strconv.FormatInt(totalBytes, 10))
	builder.WriteByte('\n')
	builder.WriteString(strings.Join(names, "\n"))
	return []byte(builder.String())
}
