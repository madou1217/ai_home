//go:build !windows

package codexdefault

import "os"

func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func publishRename(source, target string, replace bool) error {
	if replace {
		return os.Rename(source, target)
	}
	// Link creates the journal atomically only if no prior operation owns it.
	return os.Link(source, target)
}
