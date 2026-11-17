//go:build windows

package distributioninstall

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"path/filepath"
	"strings"
	"unicode/utf16"
)

func psQuote(x string) string { return "'" + strings.ReplaceAll(x, "'", "''") + "'" }
func startWindowsService(ctx context.Context, o Options) error {
	// WMI owns the process independently of an SSH session. The canonical script
	// and task metadata are created by the existing autostart adapter above.
	script := filepath.Join(o.Home, "run", "aih-server-serve.cmd")
	code := `$ErrorActionPreference='Stop';$p=` + psQuote(script) + `; $cmd='cmd.exe /d /s /c ""'+$p+'""';$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$cmd};if($r.ReturnValue -ne 0){throw 'AIH background start failed'}`
	words := utf16.Encode([]rune(code))
	raw := make([]byte, len(words)*2)
	for i, w := range words {
		binary.LittleEndian.PutUint16(raw[i*2:], w)
	}
	_, err := command(ctx, "powershell.exe", "-NoProfile", "-EncodedCommand", base64.StdEncoding.EncodeToString(raw))
	return err
}
