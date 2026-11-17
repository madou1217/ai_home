//go:build windows

package distributioninstall

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"os/exec"
	"strings"
	"unicode/utf16"
)

func startDetached(cmd *exec.Cmd, home string) error {
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	line := `"` + cmd.Path + `"`
	for _, arg := range cmd.Args[1:] {
		if strings.ContainsAny(arg, "\"\r\n") {
			return fmt.Errorf("update_worker_argument_invalid")
		}
		line += ` "` + arg + `"`
	}
	code := `$ErrorActionPreference='Stop';$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=` + quote(line) + `};if($r.ReturnValue -ne 0){throw 'update worker start failed'}`
	words := utf16.Encode([]rune(code))
	raw := make([]byte, len(words)*2)
	for i, w := range words {
		binary.LittleEndian.PutUint16(raw[i*2:], w)
	}
	_, err := command(context.Background(), "powershell.exe", "-NoProfile", "-EncodedCommand", base64.StdEncoding.EncodeToString(raw))
	return err
}
