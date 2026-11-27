//go:build windows

package distributioninstall

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"github.com/madou1217/ai_home/internal/runtime/autostart"
)

func psQuote(x string) string { return "'" + strings.ReplaceAll(x, "'", "''") + "'" }
func startWindowsService(ctx context.Context, o Options) error {
	// WMI owns the process independently of an SSH session. The autostart
	// adapter owns a VBS launcher; wscript.exe is a GUI-subsystem host and the
	// script starts the serve script with a hidden window, so WMI activation
	// never opens a console in the interactive session.
	launcher := autostart.WindowsServerLauncherScript(o.Home)
	commandLine := ""
	if _, err := os.Stat(launcher); err == nil {
		commandLine = `wscript.exe //nologo "` + launcher + `"`
	} else {
		// Pre-launcher installs only have the serve script; keep the fallback
		// (a command prompt window may flash) rather than failing to restart.
		commandLine = `cmd.exe /d /s /c ""` + filepath.Join(o.Home, "run", "aih-server-serve.cmd") + `""`
	}
	code := `$ErrorActionPreference='Stop';$cmd=` + psQuote(commandLine) + `;$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$cmd};if($r.ReturnValue -ne 0){throw 'AIH background start failed'}`
	words := utf16.Encode([]rune(code))
	raw := make([]byte, len(words)*2)
	for i, w := range words {
		binary.LittleEndian.PutUint16(raw[i*2:], w)
	}
	_, err := command(ctx, "powershell.exe", "-NoProfile", "-EncodedCommand", base64.StdEncoding.EncodeToString(raw))
	return err
}
