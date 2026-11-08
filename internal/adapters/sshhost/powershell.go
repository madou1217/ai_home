package sshhost

import (
	"encoding/base64"
	"strings"
	"unicode/utf16"
)

// PSQuote 是 PowerShell 单引号引用：内部单引号写成两个。
func PSQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// EncodePowerShellScript 把脚本编码成远端 work 用的 -EncodedCommand 命令行。
//
// Windows 命令行上限 32767 字符，UTF-16LE base64 会把脚本放大约 2.7 倍；这里只负责
// 编码，超长脚本改用 stdin 引导（remote-workspace 的 psScript）不在本包范围内。
func EncodePowerShellScript(script string) string {
	return "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand " + utf16LEBase64(script)
}

// UTF16LEBase64 暴露给需要自行拼命令的调用方（探测命令使用不带 -NonInteractive 的形式）。
func UTF16LEBase64(text string) string {
	return utf16LEBase64(text)
}

// utf16LEBase64 把 UTF-8 文本编码成 UTF-16LE 的 base64，与 Node 的
// Buffer.from(script, 'utf16le').toString('base64') 等价。
func utf16LEBase64(text string) string {
	units := utf16.Encode([]rune(text))
	raw := make([]byte, 0, len(units)*2)
	for _, unit := range units {
		raw = append(raw, byte(unit), byte(unit>>8))
	}
	return base64.StdEncoding.EncodeToString(raw)
}
