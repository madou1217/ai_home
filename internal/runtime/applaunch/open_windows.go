//go:build windows

package applaunch

import (
	"context"
	"fmt"
	"strings"
	"syscall"
	"unsafe"

	"github.com/madou1217/ai_home/application/launcher"
)

const swShowNormal = 1

var (
	shell32DLL    = syscall.NewLazyDLL("shell32.dll")
	shellExecuteW = shell32DLL.NewProc("ShellExecuteW")
)

func openApp(ctx context.Context, app launcher.App) error {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return err
		}
	}
	target := strings.TrimSpace(app.Path)
	if target == "" {
		return fmt.Errorf("%w: missing application path", launcher.ErrInvalidInput)
	}

	verbPtr, err := syscall.UTF16PtrFromString("open")
	if err != nil {
		return fmt.Errorf("encode ShellExecuteW verb failed: %w", err)
	}
	filePtr, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return fmt.Errorf("encode application path %q failed: %w", target, err)
	}

	// ShellExecuteW invokes Windows Shell directly for both .lnk shortcuts and
	// shell:AppsFolder\<AppID> UWP targets without spawning cmd.exe (no console
	// window flash and no cmd metacharacter or %VAR% expansion).
	r1, _, callErr := shellExecuteW.Call(
		0,
		uintptr(unsafe.Pointer(verbPtr)),
		uintptr(unsafe.Pointer(filePtr)),
		0,
		0,
		uintptr(swShowNormal),
	)
	if r1 <= 32 {
		if errno, ok := callErr.(syscall.Errno); ok && errno != 0 {
			return fmt.Errorf("ShellExecuteW %q failed (code=%d, win32=%d): %w", target, r1, uint32(errno), errno)
		}
		return fmt.Errorf("ShellExecuteW %q failed (code=%d)", target, r1)
	}
	return nil
}
