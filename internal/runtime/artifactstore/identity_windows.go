//go:build windows

package artifactstore

import (
	"fmt"
	"syscall"
)

func identityForPath(path string) (string, string, error) {
	pointer, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "", "", err
	}
	handle, err := syscall.CreateFile(
		pointer,
		0,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil,
		syscall.OPEN_EXISTING,
		syscall.FILE_FLAG_BACKUP_SEMANTICS,
		0,
	)
	if err != nil {
		return "", "", err
	}
	defer syscall.CloseHandle(handle)
	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(handle, &info); err != nil {
		return "", "", err
	}
	fileID := uint64(info.FileIndexHigh)<<32 | uint64(info.FileIndexLow)
	return fmt.Sprintf("%d", info.VolumeSerialNumber), fmt.Sprintf("%d", fileID), nil
}

func statfsFree(directory string) (int64, bool) {
	return 0, false
}
