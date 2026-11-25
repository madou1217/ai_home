//go:build windows

package clipboardio

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/clipboard"
)

const windowsCommandTimeout = 3 * time.Second

var windowsPowerShellCandidates = []string{"powershell.exe", "powershell", "pwsh.exe", "pwsh"}

type windowsIO struct{}

func newSystemIO() IO {
	return &windowsIO{}
}

func findPowerShell() string {
	for _, candidate := range windowsPowerShellCandidates {
		if path, err := exec.LookPath(candidate); err == nil && path != "" {
			return path
		}
	}
	return ""
}

func (w *windowsIO) Probe() Capability {
	if findPowerShell() == "" {
		return Capability{Supported: false, Reason: "powershell not found"}
	}
	return Capability{Supported: true}
}

func (w *windowsIO) ReadText(ctx context.Context, maxBytes int) (string, bool, error) {
	ps := findPowerShell()
	if ps == "" {
		return "", false, ErrUnsupported
	}
	if maxBytes <= 0 {
		maxBytes = clipboard.MaxTextBytes
	}
	script := strings.Join([]string{
		"$ErrorActionPreference = 'Stop'",
		"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
		"$t = Get-Clipboard -Format Text -Raw",
		"if ($null -eq $t -or $t.Length -eq 0) { exit 3 }",
		"[Console]::Out.Write($t)",
	}, "; ")
	raw, ok, err := runPowerShellCapture(ctx, ps, script, maxBytes)
	if err != nil {
		return "", false, err
	}
	if !ok || len(raw) == 0 {
		return "", false, nil
	}
	return string(raw), true, nil
}

func (w *windowsIO) ReadFiles(ctx context.Context) ([]string, bool, error) {
	ps := findPowerShell()
	if ps == "" {
		return nil, false, ErrUnsupported
	}
	script := strings.Join([]string{
		"$ErrorActionPreference = 'Stop'",
		"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
		"$list = Get-Clipboard -Format FileDropList",
		"if ($null -eq $list -or $list.Count -eq 0) { exit 3 }",
		"foreach ($item in $list) { if ($item.FullName) { [Console]::Out.WriteLine($item.FullName) } else { [Console]::Out.WriteLine($item.ToString()) } }",
	}, "; ")
	raw, ok, err := runPowerShellCapture(ctx, ps, script, clipboard.MaxTextBytes)
	if err != nil {
		if errors.Is(err, clipboard.ErrItemTooLarge) {
			return nil, false, err
		}
		return nil, false, nil
	}
	if !ok || len(raw) == 0 {
		return nil, false, nil
	}
	lines := strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n")
	files := make([]string, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			files = append(files, filepath.Clean(trimmed))
		}
	}
	if len(files) == 0 {
		return nil, false, nil
	}
	return files, true, nil
}

func (w *windowsIO) ReadImage(ctx context.Context, maxBytes int) ([]byte, string, bool, error) {
	ps := findPowerShell()
	if ps == "" {
		return nil, "", false, ErrUnsupported
	}
	if maxBytes <= 0 {
		maxBytes = clipboard.MaxImageBytes
	}
	tmpPath, cleanup, err := tempClipboardFile("png")
	if err != nil {
		return nil, "", false, err
	}
	defer cleanup()

	escapedPath := escapePowerShellDoubleQuoted(tmpPath)
	script := strings.Join([]string{
		"$ErrorActionPreference = 'Stop'",
		"Add-Type -AssemblyName System.Windows.Forms",
		"Add-Type -AssemblyName System.Drawing",
		"if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }",
		"$img = [System.Windows.Forms.Clipboard]::GetImage()",
		"if ($null -eq $img) { exit 4 }",
		fmt.Sprintf(`try { $img.Save("%s", [System.Drawing.Imaging.ImageFormat]::Png) } finally { $img.Dispose() }`, escapedPath),
	}, "; ")
	if err := runPowerShell(ctx, ps, script); err != nil {
		return nil, "", false, nil
	}
	info, err := os.Stat(tmpPath)
	if err != nil || info.IsDir() || info.Size() == 0 {
		return nil, "", false, nil
	}
	if info.Size() > int64(maxBytes) {
		return nil, "", false, clipboard.ErrItemTooLarge
	}
	data, err := os.ReadFile(tmpPath)
	if err != nil || len(data) == 0 {
		return nil, "", false, nil
	}
	_, mime, ok := DetectImageMIME(data)
	if !ok {
		return nil, "", false, nil
	}
	return data, mime, true, nil
}

func (w *windowsIO) WriteText(ctx context.Context, text string) error {
	ps := findPowerShell()
	if ps == "" {
		return ErrUnsupported
	}
	tmpPath, cleanup, err := tempClipboardFile("txt")
	if err != nil {
		return err
	}
	defer cleanup()
	if err := os.WriteFile(tmpPath, []byte(text), 0o600); err != nil {
		return err
	}
	escapedPath := escapePowerShellDoubleQuoted(tmpPath)
	script := strings.Join([]string{
		"$ErrorActionPreference = 'Stop'",
		fmt.Sprintf(`$text = [System.IO.File]::ReadAllText("%s", [System.Text.Encoding]::UTF8)`, escapedPath),
		"Set-Clipboard -Value $text",
	}, "; ")
	return runPowerShell(ctx, ps, script)
}

func (w *windowsIO) WriteImage(ctx context.Context, data []byte, _ string) error {
	ps := findPowerShell()
	if ps == "" {
		return ErrUnsupported
	}
	if len(data) == 0 {
		return clipboard.ErrEmptyContent
	}
	pngBytes, err := ensurePNG(data)
	if err != nil {
		return fmt.Errorf("convert clipboard image to png: %w", err)
	}
	tmpPath, cleanup, err := tempClipboardFile("png")
	if err != nil {
		return err
	}
	defer cleanup()
	if err := os.WriteFile(tmpPath, pngBytes, 0o600); err != nil {
		return err
	}
	escapedPath := escapePowerShellDoubleQuoted(tmpPath)
	script := strings.Join([]string{
		"$ErrorActionPreference = 'Stop'",
		"Add-Type -AssemblyName System.Windows.Forms",
		"Add-Type -AssemblyName System.Drawing",
		fmt.Sprintf(`$img = [System.Drawing.Image]::FromFile("%s")`, escapedPath),
		"try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }",
	}, "; ")
	return runPowerShell(ctx, ps, script)
}

func (w *windowsIO) WriteFiles(ctx context.Context, files []string) error {
	ps := findPowerShell()
	if ps == "" {
		return ErrUnsupported
	}
	if len(files) == 0 {
		return clipboard.ErrEmptyContent
	}
	cleaned := make([]string, 0, len(files))
	for _, f := range files {
		if abs, err := filepath.Abs(strings.TrimSpace(f)); err == nil && abs != "" {
			cleaned = append(cleaned, abs)
		}
	}
	if len(cleaned) == 0 {
		return errors.New("no valid file paths")
	}
	tmpPath, cleanup, err := tempClipboardFile("txt")
	if err != nil {
		return err
	}
	defer cleanup()
	if err := os.WriteFile(tmpPath, []byte(strings.Join(cleaned, "\n")), 0o600); err != nil {
		return err
	}
	escapedPath := escapePowerShellDoubleQuoted(tmpPath)
	script := strings.Join([]string{
		"$ErrorActionPreference = 'Stop'",
		fmt.Sprintf(`$paths = [System.IO.File]::ReadAllLines("%s", [System.Text.Encoding]::UTF8)`, escapedPath),
		"Set-Clipboard -Path $paths",
	}, "; ")
	return runPowerShell(ctx, ps, script)
}

func runPowerShell(ctx context.Context, ps string, script string) error {
	cmdCtx, cancel := context.WithTimeout(ctx, windowsCommandTimeout)
	defer cancel()
	encoded := base64.StdEncoding.EncodeToString(utf16LE(script))
	cmd := exec.CommandContext(cmdCtx, ps, "-NoProfile", "-STA", "-EncodedCommand", encoded)
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Run()
}

func runPowerShellCapture(ctx context.Context, ps string, script string, maxBytes int) ([]byte, bool, error) {
	cmdCtx, cancel := context.WithTimeout(ctx, windowsCommandTimeout)
	defer cancel()
	encoded := base64.StdEncoding.EncodeToString(utf16LE(script))
	cmd := exec.CommandContext(cmdCtx, ps, "-NoProfile", "-STA", "-EncodedCommand", encoded)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, false, err
	}
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return nil, false, err
	}
	limit := int64(maxBytes) + 1
	raw, readErr := io.ReadAll(io.LimitReader(stdout, limit))
	if int64(len(raw)) > int64(maxBytes) {
		cancel()
		_ = stdout.Close()
		_ = cmd.Wait()
		return nil, false, clipboard.ErrItemTooLarge
	}
	waitErr := cmd.Wait()
	if readErr != nil || waitErr != nil {
		return nil, false, nil
	}
	return raw, true, nil
}

func escapePowerShellDoubleQuoted(s string) string {
	s = strings.ReplaceAll(s, "`", "``")
	s = strings.ReplaceAll(s, `"`, "`\"")
	s = strings.ReplaceAll(s, "$", "`$")
	return s
}
