package sshbridge

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode/utf16"
)

func readExistingImage(file string, mimeType string, maxBytes int) (Image, bool) {
	if strings.TrimSpace(file) == "" {
		return Image{}, false
	}
	buffer, err := os.ReadFile(file)
	if err != nil {
		return Image{}, false
	}
	image, err := ValidateImage(buffer, mimeType, maxBytes)
	if err != nil {
		return Image{}, false
	}
	return image, true
}

func tempClipboardPath(extension string) (string, func()) {
	directory, err := os.MkdirTemp("", "aih-ssh-clipboard-")
	if err != nil {
		return "", func() {}
	}
	file := filepath.Join(directory, "clipboard."+extension)
	cleanup := func() { _ = os.RemoveAll(directory) }
	return file, cleanup
}

func readMacClipboard(maxBytes int) (Image, bool) {
	pngpastePath, cleanup := tempClipboardPath("png")
	defer cleanup()
	if pngpastePath != "" {
		command := exec.Command("pngpaste", pngpastePath)
		command.Stdout = nil
		command.Stderr = nil
		if err := command.Run(); err == nil {
			if image, ok := readExistingImage(pngpastePath, "image/png", maxBytes); ok {
				return image, true
			}
		}
	}
	osascriptPath, cleanupScript := tempClipboardPath("png")
	defer cleanupScript()
	if osascriptPath == "" {
		return Image{}, false
	}
	quotedPath := strings.ReplaceAll(strings.ReplaceAll(osascriptPath, `\`, `\\`), `"`, `\"`)
	script := []string{
		`set outPath to POSIX file "` + quotedPath + `"`,
		"try",
		"  set pngData to the clipboard as «class PNGf»",
		"  set fileRef to open for access outPath with write permission",
		"  set eof fileRef to 0",
		"  write pngData to fileRef",
		"  close access fileRef",
		"on error",
		"  try",
		"    close access outPath",
		"  end try",
		"  error number -128",
		"end try",
	}
	args := make([]string, 0, len(script)*2)
	for _, line := range script {
		args = append(args, "-e", line)
	}
	command := exec.Command("osascript", args...)
	command.Stdout = nil
	command.Stderr = nil
	if err := command.Run(); err == nil {
		if image, ok := readExistingImage(osascriptPath, "image/png", maxBytes); ok {
			return image, true
		}
	}
	return Image{}, false
}

type clipboardCandidate struct {
	command  string
	args     []string
	mimeType string
}

func readCommandClipboard(candidate clipboardCandidate, maxBytes int) (Image, bool) {
	contextValue, cancel := context.WithTimeout(context.Background(), 800*time.Millisecond)
	defer cancel()
	command := exec.CommandContext(contextValue, candidate.command, candidate.args...)
	pipe, err := command.StdoutPipe()
	if err != nil {
		return Image{}, false
	}
	command.Stderr = nil
	if err := command.Start(); err != nil {
		return Image{}, false
	}
	// 与历史实现一致：最多读 maxBytes+1024，超限即当作无图片，绝不无界缓冲。
	output, readErr := io.ReadAll(io.LimitReader(pipe, int64(maxBytes)+1024))
	waitErr := command.Wait()
	if readErr != nil || waitErr != nil || len(output) == 0 {
		return Image{}, false
	}
	image, validateErr := ValidateImage(output, candidate.mimeType, maxBytes)
	if validateErr != nil {
		return Image{}, false
	}
	return image, true
}

func readLinuxClipboard(maxBytes int) (Image, bool) {
	candidates := []clipboardCandidate{
		{"wl-paste", []string{"--type", "image/png"}, "image/png"},
		{"wl-paste", []string{"--type", "image/jpeg"}, "image/jpeg"},
		{"wl-paste", []string{"--type", "image/webp"}, "image/webp"},
		{"wl-paste", []string{"--type", "image/gif"}, "image/gif"},
		{"wl-paste", []string{"--type", "image/tiff"}, "image/tiff"},
		{"xclip", []string{"-selection", "clipboard", "-t", "image/png", "-o"}, "image/png"},
		{"xclip", []string{"-selection", "clipboard", "-t", "image/jpeg", "-o"}, "image/jpeg"},
		{"xclip", []string{"-selection", "clipboard", "-t", "image/webp", "-o"}, "image/webp"},
		{"xclip", []string{"-selection", "clipboard", "-t", "image/gif", "-o"}, "image/gif"},
		{"xclip", []string{"-selection", "clipboard", "-t", "image/tiff", "-o"}, "image/tiff"},
	}
	for _, candidate := range candidates {
		if image, ok := readCommandClipboard(candidate, maxBytes); ok {
			return image, true
		}
	}
	return Image{}, false
}

func readWindowsClipboard(maxBytes int) (Image, bool) {
	imagePath, cleanup := tempClipboardPath("png")
	defer cleanup()
	if imagePath == "" {
		return Image{}, false
	}
	escapedPath := strings.ReplaceAll(strings.ReplaceAll(imagePath, "`", "``"), `"`, "`\"")
	script := strings.Join([]string{
		"$ErrorActionPreference = 'Stop'",
		"Add-Type -AssemblyName System.Windows.Forms",
		"Add-Type -AssemblyName System.Drawing",
		"if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }",
		"$img = [System.Windows.Forms.Clipboard]::GetImage()",
		"if ($null -eq $img) { exit 4 }",
		fmt.Sprintf(`$file = "%s"`, escapedPath),
		"$img.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)",
		"Write-Output $file",
	}, "; ")
	encoded := base64.StdEncoding.EncodeToString(utf16LE(script))
	for _, commandName := range []string{"powershell.exe", "powershell", "pwsh.exe", "pwsh"} {
		command := exec.Command(commandName, "-NoProfile", "-STA", "-EncodedCommand", encoded)
		if err := command.Run(); err != nil {
			continue
		}
		if image, ok := readExistingImage(imagePath, "image/png", maxBytes); ok {
			return image, true
		}
	}
	return Image{}, false
}

func utf16LE(text string) []byte {
	units := utf16.Encode([]rune(text))
	bytes := make([]byte, 0, len(units)*2)
	for _, unit := range units {
		bytes = append(bytes, byte(unit), byte(unit>>8))
	}
	return bytes
}

// ReadClipboardImage 读取本机剪贴板图片；没有图片返回 (_, false)。
func ReadClipboardImage(maxBytes int) (Image, bool, error) {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBytes
	}
	var image Image
	var ok bool
	switch runtime.GOOS {
	case "darwin":
		image, ok = readMacClipboard(maxBytes)
	case "windows":
		image, ok = readWindowsClipboard(maxBytes)
	default:
		image, ok = readLinuxClipboard(maxBytes)
	}
	if !ok {
		return Image{}, false, nil
	}
	_, detectedMime, detected := DetectImageType(image.Buffer)
	if !detected {
		return Image{}, false, fmt.Errorf("ssh_clip_clipboard_image_unsupported")
	}
	image.MimeType = detectedMime
	return image, true, nil
}
