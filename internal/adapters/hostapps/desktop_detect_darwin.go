package hostapps

import (
	"bytes"
	"context"
	"encoding/binary"
	"runtime"
	"syscall"
	"unsafe"
)

func init() {
	readDesktopProcessIdentity = ReadDesktopProcessIdentity
}

// ReadDesktopProcessIdentity uses the Darwin proc_info kernel interface. It
// never inspects argv, environments or file mappings. PID identity and image
// must remain equal across both reads; this is not a later stop authorization.
func ReadDesktopProcessIdentity(ctx context.Context, pid int) (DesktopProcessIdentity, error) {
	if ctx == nil || ctx.Err() != nil || pid <= 0 {
		return DesktopProcessIdentity{}, errDesktopIdentity
	}
	before, err := readDesktopBSDInfo(pid)
	if err != nil {
		return DesktopProcessIdentity{}, err
	}
	image, err := readDesktopPIDPath(pid)
	if err != nil {
		return DesktopProcessIdentity{}, err
	}
	after, err := readDesktopBSDInfo(pid)
	if err != nil || before != after || ctx.Err() != nil {
		return DesktopProcessIdentity{}, errDesktopIdentity
	}
	imageAgain, err := readDesktopPIDPath(pid)
	if err != nil || imageAgain != image || ctx.Err() != nil {
		return DesktopProcessIdentity{}, errDesktopIdentity
	}
	before.ExecutablePath = image
	return before, nil
}

// These sizes/offsets are proc_bsdinfo from the macOS SDK sys/proc_info.h.
// Both supported Darwin Go architectures use the same layout.
func readDesktopBSDInfo(pid int) (DesktopProcessIdentity, error) {
	var buffer [136]byte
	if count, err := readDesktopProcInfo(pid, 3, buffer[:]); err != nil || count != len(buffer) {
		return DesktopProcessIdentity{}, errDesktopIdentity
	}
	word := func(offset int) int { return int(binary.LittleEndian.Uint32(buffer[offset : offset+4])) }
	name := buffer[48:64]
	end := bytes.IndexByte(name, 0)
	if end < 0 || word(12) != pid || word(4) == 5 { // SZOMB
		return DesktopProcessIdentity{}, errDesktopIdentity
	}
	return DesktopProcessIdentity{
		PID: pid, PPID: word(16), UID: word(20), RealUID: word(28), Name: string(name[:end]),
		StartSeconds: binary.LittleEndian.Uint64(buffer[120:128]),
		StartMicros:  binary.LittleEndian.Uint64(buffer[128:136]),
	}, nil
}

func readDesktopPIDPath(pid int) (string, error) {
	var buffer [4096]byte // PROC_PIDPATHINFO_MAXSIZE
	// PIDPATHINFO fills the buffer but returns zero on success. libproc's
	// proc_pidpath wrapper also derives the length from its NUL terminator.
	if _, err := readDesktopProcInfo(pid, 11, buffer[:]); err != nil {
		return "", errDesktopIdentity
	}
	end := bytes.IndexByte(buffer[:], 0)
	if end < 1 {
		return "", errDesktopIdentity
	}
	return string(buffer[:end]), nil
}

func readDesktopProcInfo(pid, flavor int, buffer []byte) (int, error) {
	// PROC_INFO_CALL_PIDINFO=2, PROC_PIDTBSDINFO=3, PROC_PIDPATHINFO=11.
	count, _, errno := syscall.Syscall6(syscall.SYS_PROC_INFO, 2, uintptr(pid), uintptr(flavor), 0, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)))
	runtime.KeepAlive(buffer)
	if errno != 0 || count > uintptr(len(buffer)) {
		return 0, errDesktopIdentity
	}
	return int(count), nil
}
