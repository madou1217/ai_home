package artifactstore

import (
	"os"
	"path/filepath"
	"runtime"
)

// CreateDirLink creates a directory link at link pointing to target.
// Windows uses a junction (no developer mode/admin required); other platforms
// use a symlink. The helper is shared with the account skill views so the
// junction reparse-point implementation has one owner.
func CreateDirLink(target, link string) error {
	return createSkillDirLink(target, link, runtime.GOOS)
}

// IsDirLink reports whether path is a symlink or a Windows junction.
func IsDirLink(path string) bool {
	info, err := os.Lstat(path)
	if err != nil {
		return false
	}
	return isLinkEntry(info, path)
}

// DirLinkTarget returns the absolute target of a symlink or Windows junction.
func DirLinkTarget(path string) (string, bool) {
	link, err := os.Readlink(path)
	if err != nil {
		return "", false
	}
	if !filepath.IsAbs(link) {
		link = filepath.Join(filepath.Dir(path), link)
	}
	return filepath.Clean(link), true
}
