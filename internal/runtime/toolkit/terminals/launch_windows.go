//go:build windows

package terminals

import (
	"os/exec"
	"syscall"
)

func applyPlatformLaunchAttrs(cmd *exec.Cmd, spec LaunchSpec) {
	hide := spec.WindowsHide == nil || *spec.WindowsHide
	attr := &syscall.SysProcAttr{
		HideWindow: hide,
	}
	if spec.WindowsVerbatimArguments && len(spec.Args) == 3 && spec.Args[0] == "/d" && spec.Args[1] == "/s" && spec.Args[2] != "" {
		// 保持与 Windows cmd /d /s /c <raw-line> 一致的原样命令行传递，避免 Go MSVCRT 转义损坏引号。
		attr.CmdLine = `cmd.exe /d /s /c ` + spec.Args[2]
	}
	cmd.SysProcAttr = attr
}
