package fileexchange

import "golang.org/x/sys/unix"

// Swap retains the exact displaced inode at source, allowing validation after
// publication without destroying a concurrent native editor's new version.
func Exchange(source, target string) (string, error) {
	if err := unix.RenameatxNp(unix.AT_FDCWD, source, unix.AT_FDCWD, target, unix.RENAME_SWAP); err != nil {
		return "", err
	}
	return source, nil
}

func MoveAside(source, target string) error {
	return unix.RenameatxNp(unix.AT_FDCWD, source, unix.AT_FDCWD, target, unix.RENAME_EXCL)
}
