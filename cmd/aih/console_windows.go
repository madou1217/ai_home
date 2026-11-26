//go:build windows

package main

import "syscall"

// Configure the Windows console for UTF-8 before any command writes text.
// Windows consoles default to an OEM/ANSI code page (e.g. 936/1252), which
// renders UTF-8 Chinese as mojibake even though Go writes valid UTF-8 bytes.
func init() {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	if setOutput := kernel32.NewProc("SetConsoleOutputCP"); setOutput.Find() == nil {
		_, _, _ = setOutput.Call(65001)
	}
	if setInput := kernel32.NewProc("SetConsoleCP"); setInput.Find() == nil {
		_, _, _ = setInput.Call(65001)
	}
}