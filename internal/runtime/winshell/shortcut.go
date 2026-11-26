// Package winshell provides shared Windows Shell enumeration helpers executed
// via temporary VBS scripts and cscript.exe (avoiding child powershell.exe
// stalls under scheduled-task / helper contexts).
package winshell

import (
	"bytes"
	"errors"
	"unicode/utf16"
)

// ErrUnsupported indicates a Windows-only shell helper was invoked on a
// non-Windows platform.
var ErrUnsupported = errors.New("windows shell operations are only supported on windows")

// Shortcut describes a Windows .lnk shortcut file and its resolved target.
type Shortcut struct {
	LinkPath     string
	Name         string
	TargetPath   string
	TargetExists bool
}

// DecodeWindowsText converts UTF-16LE output (with BOM) written by a VBS script
// or UTF-8 output (with optional BOM) into a Go string.
func DecodeWindowsText(data []byte) string {
	if len(data) >= 2 && data[0] == 0xFF && data[1] == 0xFE {
		units := make([]uint16, 0, (len(data)-2)/2)
		for i := 2; i+1 < len(data); i += 2 {
			units = append(units, uint16(data[i])|uint16(data[i+1])<<8)
		}
		return string(utf16.Decode(units))
	}
	return string(bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF}))
}

func encodeScriptBytes(script string) []byte {
	for i := 0; i < len(script); i++ {
		if script[i] >= 0x80 {
			return encodeUTF16LEWithBOM(script)
		}
	}
	return []byte(script)
}

func encodeUTF16LEWithBOM(text string) []byte {
	units := utf16.Encode([]rune(text))
	buf := make([]byte, 2+len(units)*2)
	buf[0] = 0xFF
	buf[1] = 0xFE
	for i, u := range units {
		buf[2+i*2] = byte(u)
		buf[2+i*2+1] = byte(u >> 8)
	}
	return buf
}
