package codexdefault

import (
	"golang.org/x/sys/windows"
)

// Windows publication uses MoveFileEx WRITE_THROUGH. Directory fsync is not
// available through os.File.Sync on directories, so it is not emulated here.
func syncDirectory(string) error { return nil }

func publishRename(source, target string, replace bool) error {
	from, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	flags := uint32(windows.MOVEFILE_WRITE_THROUGH)
	if replace {
		flags |= windows.MOVEFILE_REPLACE_EXISTING
	}
	return windows.MoveFileEx(from, to, flags)
}
