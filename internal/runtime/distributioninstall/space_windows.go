//go:build windows

package distributioninstall

import "golang.org/x/sys/windows"

func freeSpace(path string) (uint64, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var free, total, all uint64
	err = windows.GetDiskFreeSpaceEx(p, &free, &total, &all)
	return free, err
}
