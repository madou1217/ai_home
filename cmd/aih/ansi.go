package main

import "io"

// ANSI SGR 颜色，与 Node `aih ls` 的既有配色保持一致：标题青、Provider 黄、
// Account ID 青、身份洋红、套餐蓝、次要状态灰。
const (
	ansiReset   = "\x1b[0m"
	ansiCyan    = "\x1b[36m"
	ansiYellow  = "\x1b[33m"
	ansiMagenta = "\x1b[35m"
	ansiBlue    = "\x1b[34m"
	ansiGreen   = "\x1b[32m"
	ansiRed     = "\x1b[31m"
	ansiGray    = "\x1b[90m"
)

// terminalPalette 只在真实终端上色；管道/重定向保持纯文本，脚本解析不受影响。
type terminalPalette struct {
	enabled bool
}

func paletteFor(output io.Writer) terminalPalette {
	return terminalPalette{enabled: terminalWriterIsTTY(output)}
}

func (palette terminalPalette) paint(code string, text string) string {
	if !palette.enabled || text == "" {
		return text
	}
	return code + text + ansiReset
}

func (palette terminalPalette) gray(text string) string    { return palette.paint(ansiGray, text) }
func (palette terminalPalette) cyan(text string) string    { return palette.paint(ansiCyan, text) }
func (palette terminalPalette) yellow(text string) string  { return palette.paint(ansiYellow, text) }
func (palette terminalPalette) magenta(text string) string { return palette.paint(ansiMagenta, text) }
func (palette terminalPalette) blue(text string) string    { return palette.paint(ansiBlue, text) }
