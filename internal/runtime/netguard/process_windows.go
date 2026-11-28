//go:build windows

package netguard

import (
	"syscall"
	"unsafe"
)

const processQueryLimitedInformation = 0x1000

var procGetProcessTimes = kernel32.NewProc("GetProcessTimes")

// processCreateTime returns the process creation time as a FILETIME value.
// The value is used to detect PID reuse: a later process with the same PID has
// a different creation time and must not inherit an instance's protection.
func processCreateTime(pid int) (uint64, bool) {
	if pid <= 0 {
		return 0, false
	}
	handle, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return 0, false
	}
	defer syscall.CloseHandle(handle)
	var creation, exit, kernel, user syscall.Filetime
	result, _, _ := procGetProcessTimes.Call(
		uintptr(handle),
		uintptr(unsafe.Pointer(&creation)),
		uintptr(unsafe.Pointer(&exit)),
		uintptr(unsafe.Pointer(&kernel)),
		uintptr(unsafe.Pointer(&user)),
	)
	if result == 0 {
		return 0, false
	}
	return uint64(creation.HighDateTime)<<32 | uint64(creation.LowDateTime), true
}

// processStillMatches reports whether pid still refers to the process observed
// at creationTime. An inaccessible process is treated as gone, which is the
// safe choice: failing to protect a reused PID is better than blocking an
// unrelated process.
func processStillMatches(pid int, creationTime uint64) bool {
	if creationTime == 0 {
		// The creation time could not be read when the PID was added (for
		// example a protected system process). Keep it only while the PID
		// still exists; this is best effort.
		_, ok := processCreateTime(pid)
		return ok
	}
	current, ok := processCreateTime(pid)
	return ok && current == creationTime
}
