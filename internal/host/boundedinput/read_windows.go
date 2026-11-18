//go:build windows

package boundedinput

import (
	"context"
	"errors"
	"os"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var queryInformationFile = windows.NewLazySystemDLL("ntdll.dll").NewProc("NtQueryInformationFile")

func readPlatform(ctx context.Context, input *os.File, max int64) (raw []byte, err error) {
	original, err := input.SyscallConn()
	if err != nil {
		return nil, err
	}
	var owned windows.Handle
	var duplicateErr error
	err = original.Control(func(inherited uintptr) {
		process := windows.CurrentProcess()
		duplicateErr = windows.DuplicateHandle(process, windows.Handle(inherited), process, &owned, 0, false, windows.DUPLICATE_SAME_ACCESS)
	})
	if err != nil || duplicateErr != nil {
		return nil, errors.Join(err, duplicateErr)
	}
	defer func() { err = errors.Join(err, windows.CloseHandle(owned)) }()
	kind, err := windows.GetFileType(owned)
	if err != nil {
		return nil, err
	}
	if kind != windows.FILE_TYPE_PIPE {
		return nil, ErrUnsupportedInput
	}
	var info uint32
	if err := windows.GetNamedPipeInfo(owned, &info, nil, nil, nil); err != nil {
		return nil, err
	}
	if info&windows.PIPE_TYPE_MESSAGE != 0 {
		return nil, ErrUnsupportedInput
	}
	// ReadFile with a nil OVERLAPPED is only used on a synchronous handle. A
	// duplicate cannot change this property; do not infer it from a Go wrapper.
	if err := queryInformationFile.Find(); err != nil {
		return nil, ErrUnsupportedInput
	}
	var status windows.IO_STATUS_BLOCK
	var modeInfo struct{ Mode uint32 }
	statusCode, _, _ := queryInformationFile.Call(uintptr(owned), uintptr(unsafe.Pointer(&status)), uintptr(unsafe.Pointer(&modeInfo)), unsafe.Sizeof(modeInfo), 16)
	if int32(statusCode) < 0 {
		return nil, windows.NTStatus(statusCode)
	}
	if modeInfo.Mode&(windows.FILE_SYNCHRONOUS_IO_ALERT|windows.FILE_SYNCHRONOUS_IO_NONALERT) == 0 {
		return nil, ErrUnsupportedInput
	}
	var originalMode uint32
	if err := windows.GetNamedPipeHandleState(owned, &originalMode, nil, nil, nil, nil, 0); err != nil {
		return nil, err
	}
	nonblockingMode := originalMode | windows.PIPE_NOWAIT
	if err := windows.SetNamedPipeHandleState(owned, &nonblockingMode, nil, nil); err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, windows.SetNamedPipeHandleState(owned, &originalMode, nil, nil)) }()
	var buffer [4096]byte
	defer clear(buffer[:])
	for {
		if err := ctx.Err(); err != nil {
			return raw, err
		}
		remaining := max + 1 - int64(len(raw))
		if remaining <= 0 {
			return raw, nil
		}
		chunk := buffer[:]
		if remaining < int64(len(chunk)) {
			chunk = chunk[:int(remaining)]
		}
		var count uint32
		readErr := windows.ReadFile(owned, chunk, &count, nil)
		if count > 0 {
			raw = append(raw, chunk[:count]...)
		}
		if readErr == windows.ERROR_BROKEN_PIPE || readErr == windows.ERROR_HANDLE_EOF {
			return raw, nil
		}
		if readErr != nil && readErr != windows.ERROR_NO_DATA {
			return raw, readErr
		}
		if count != 0 {
			continue
		}
		// PIPE_NOWAIT makes each synchronous ReadFile nonblocking; this is a
		// synchronous polling loop, not async I/O or a cancellation-by-Close race.
		timer := time.NewTimer(5 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return raw, ctx.Err()
		case <-timer.C:
		}
	}
}
