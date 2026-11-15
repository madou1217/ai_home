package fileexchange

import "golang.org/x/sys/windows"

// Keep the displaced file before a no-replace publication. Windows does not
// expose rename-exchange; never use replacing rename to discard an unverified
// native login. The journal blocks managed launches during this short interval.
func Exchange(source, target string) (string, error) {
	backup := source + ".displaced"
	if err := MoveAside(target, backup); err != nil {
		return "", err
	}
	return backup, MoveAside(source, target)
}

func MoveAside(source, target string) error {
	from, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(from, to, windows.MOVEFILE_WRITE_THROUGH)
}
