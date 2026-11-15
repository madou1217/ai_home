package fileexchange

import "golang.org/x/sys/unix"

func Exchange(source, target string) (string, error) {
	if err := unix.Renameat2(unix.AT_FDCWD, source, unix.AT_FDCWD, target, unix.RENAME_EXCHANGE); err != nil {
		return "", err
	}
	return source, nil
}

func MoveAside(source, target string) error {
	return unix.Renameat2(unix.AT_FDCWD, source, unix.AT_FDCWD, target, unix.RENAME_NOREPLACE)
}
