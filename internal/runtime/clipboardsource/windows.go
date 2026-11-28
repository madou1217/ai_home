//go:build windows

package clipboardsource

import (
	"context"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var (
	user32                       = syscall.NewLazyDLL("user32.dll")
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procGetForegroundWindow      = user32.NewProc("GetForegroundWindow")
	procGetWindowThreadProcessID = user32.NewProc("GetWindowThreadProcessId")
	procOpenProcess              = kernel32.NewProc("OpenProcess")
	procQueryFullProcessImage    = kernel32.NewProc("QueryFullProcessImageNameW")
	procCloseHandle              = kernel32.NewProc("CloseHandle")
)

const processQueryLimitedInformation = 0x1000

type windowsResolver struct{}

func New() Resolver { return &windowsResolver{} }

func (r *windowsResolver) Frontmost(ctx context.Context) (App, bool) {
	hwnd, _, _ := procGetForegroundWindow.Call()
	if hwnd == 0 {
		return App{}, false
	}
	var pid uint32
	procGetWindowThreadProcessID.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if pid == 0 {
		return App{}, false
	}
	handle, _, _ := procOpenProcess.Call(processQueryLimitedInformation, 0, uintptr(pid))
	if handle == 0 {
		return App{}, false
	}
	defer procCloseHandle.Call(handle)
	buf := make([]uint16, 512)
	size := uint32(len(buf))
	ok, _, _ := procQueryFullProcessImage.Call(handle, 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if ok == 0 {
		return App{}, false
	}
	exe := syscall.UTF16ToString(buf[:size])
	name := strings.TrimSuffix(filepath.Base(exe), filepath.Ext(exe))
	if name == "" {
		return App{}, false
	}
	return App{Name: name, BundleID: strings.ToLower(name)}, true
}
