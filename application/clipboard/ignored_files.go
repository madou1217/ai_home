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
// when the same package is copied on two machines. Basenames plus each file's
// BLAKE3 content hash are stable across devices and exact; total size is kept
// only as a fallback when hashes are unavailable.
func FilePackageIdentity(files []string, hashes []string, totalBytes int64) []byte {
	if len(hashes) != len(files) {
		hashes = nil
	}
	type entry struct {
		name string
		hash string
	}
	entries := make([]entry, 0, len(files))
	for index, path := range files {
		name := strings.ToLower(strings.TrimSpace(filepath.Base(strings.TrimSpace(path))))
		if name == "" {
			continue
		}
		hash := ""
		if index < len(hashes) {
			hash = strings.ToLower(strings.TrimSpace(hashes[index]))
		}
		entries = append(entries, entry{name: name, hash: hash})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].name != entries[j].name {
			return entries[i].name < entries[j].name
		}
		return entries[i].hash < entries[j].hash
	})
	var builder strings.Builder
	builder.WriteString(strconv.FormatInt(totalBytes, 10))
	builder.WriteByte('\n')
	if len(hashes) == 0 {
		for _, item := range entries {
			builder.WriteString(item.name)
			builder.WriteByte('\n')
		}
		return []byte(builder.String())
	}
	// Content identity deliberately ignores file names: a remote tool may
	// copy the same files under temporary names. Sorted per-file hashes keep
	// both content and duplicate-file count meaningful across devices.
	sortedHashes := make([]string, 0, len(entries))
	for _, item := range entries {
		sortedHashes = append(sortedHashes, item.hash)
	}
	sort.Strings(sortedHashes)
	for _, hash := range sortedHashes {
		builder.WriteString(hash)
		builder.WriteByte('\n')
	}
	return []byte(builder.String())
}
