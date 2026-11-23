//go:build windows

package tuningress

import (
	"syscall"
	"unsafe"
)

func processElevated() bool {
	token, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return false
	}
	defer func() { _ = token.Close() }()

	var elevated int32
	var returned uint32
	if err := syscall.GetTokenInformation(
		token,
		syscall.TokenElevation,
		(*byte)(unsafe.Pointer(&elevated)),
		uint32(unsafe.Sizeof(elevated)),
		&returned,
	); err != nil {
		return false
	}
	return elevated != 0
}
