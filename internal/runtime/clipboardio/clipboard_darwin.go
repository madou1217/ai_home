//go:build darwin

package clipboardio

import (
	"context"
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

const darwinCommandTimeout = 2 * time.Second

type darwinIO struct{}

func newSystemIO() IO {
	return &darwinIO{}
}

func (d *darwinIO) Probe() Capability {
	if _, err := exec.LookPath("pbpaste"); err != nil {
		return Capability{Supported: false, Reason: "pbpaste not found"}
	}
	if _, err := exec.LookPath("pbcopy"); err != nil {
		return Capability{Supported: false, Reason: "pbcopy not found"}
	}
	return Capability{Supported: true}
}

// darwinClipboardEnv forces the UTF-8 locale that launchd omits; without it
// pbpaste/pbcopy fall back to MacRoman and corrupt non-ASCII text.
func darwinClipboardEnv() []string {
	return append(os.Environ(), "LC_ALL=en_US.UTF-8", "LC_CTYPE=UTF-8", "LANG=en_US.UTF-8")
}

func (d *darwinIO) ReadText(ctx context.Context, maxBytes int) (string, bool, error) {
	if maxBytes <= 0 {
		maxBytes = clipboard.MaxTextBytes
	}
	cmdCtx, cancel := context.WithTimeout(ctx, darwinCommandTimeout)
	defer cancel()

	cmd := exec.CommandContext(cmdCtx, "pbpaste", "-Prefer", "txt")
	cmd.Env = darwinClipboardEnv()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", false, err
	}
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return "", false, err
	}
	limit := int64(maxBytes) + 1
	raw, readErr := io.ReadAll(io.LimitReader(stdout, limit))
	if int64(len(raw)) > int64(maxBytes) {
		// Stop the producer before Wait: it blocks on the full pipe otherwise.
		cancel()
		_ = stdout.Close()
		_ = cmd.Wait()
		return "", false, clipboard.ErrItemTooLarge
	}
	waitErr := cmd.Wait()
	if readErr != nil || waitErr != nil {
		return "", false, nil
	}
	if len(raw) == 0 {
		return "", false, nil
	}
	return string(raw), true, nil
}

func (d *darwinIO) ReadFiles(ctx context.Context) ([]string, bool, error) {
	cmdCtx, cancel := context.WithTimeout(ctx, darwinCommandTimeout)
	defer cancel()

	script := []string{
		"try",
		"  return POSIX path of (the clipboard as «class furl»)",
		"on error",
		"  error number -128",
		"end try",
	}
	args := make([]string, 0, len(script)*2)
	for _, line := range script {
		args = append(args, "-e", line)
	}
	cmd := exec.CommandContext(cmdCtx, "osascript", args...)
	out, err := cmd.Output()
	if err != nil {
		return nil, false, nil
	}
	trimmed := strings.TrimSpace(string(out))
	if trimmed == "" {
		return nil, false, nil
	}
	return []string{filepath.Clean(trimmed)}, true, nil
}

func (d *darwinIO) ReadImage(ctx context.Context, maxBytes int) ([]byte, string, bool, error) {
	if maxBytes <= 0 {
		maxBytes = clipboard.MaxImageBytes
	}
	if pngpasteBin, err := exec.LookPath("pngpaste"); err == nil && pngpasteBin != "" {
		if data, mime, ok, imgErr := d.readImageViaPngpaste(ctx, pngpasteBin, maxBytes); ok || imgErr != nil {
			return data, mime, ok, imgErr
		}
	}
	return d.readImageViaOSAScript(ctx, maxBytes)
}

func (d *darwinIO) readImageViaPngpaste(ctx context.Context, bin string, maxBytes int) ([]byte, string, bool, error) {
	tmpPath, cleanup, err := tempClipboardFile("png")
	if err != nil {
		return nil, "", false, err
	}
	defer cleanup()

	cmdCtx, cancel := context.WithTimeout(ctx, darwinCommandTimeout)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, bin, tmpPath)
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Run(); err != nil {
		return nil, "", false, nil
	}
	return readValidatedImageFile(tmpPath, maxBytes)
}

func (d *darwinIO) readImageViaOSAScript(ctx context.Context, maxBytes int) ([]byte, string, bool, error) {
	tmpPath, cleanup, err := tempClipboardFile("png")
	if err != nil {
		return nil, "", false, err
	}
	defer cleanup()

	quotedPath := escapeAppleScriptString(tmpPath)
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
	cmdCtx, cancel := context.WithTimeout(ctx, darwinCommandTimeout)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, "osascript", args...)
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Run(); err != nil {
		return nil, "", false, nil
	}
	return readValidatedImageFile(tmpPath, maxBytes)
}

func (d *darwinIO) WriteText(ctx context.Context, text string) error {
	cmdCtx, cancel := context.WithTimeout(ctx, darwinCommandTimeout)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, "pbcopy")
	cmd.Env = darwinClipboardEnv()
	cmd.Stdin = strings.NewReader(text)
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Run()
}

func (d *darwinIO) WriteImage(ctx context.Context, data []byte, _ string) error {
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
	quotedPath := escapeAppleScriptString(tmpPath)
	cmdCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, "osascript", "-e", `set the clipboard to (read (POSIX file "`+quotedPath+`") as «class PNGf»)`)
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Run()
}

func (d *darwinIO) WriteFiles(ctx context.Context, files []string) error {
	if len(files) == 0 {
		return clipboard.ErrEmptyContent
	}
	abs, err := filepath.Abs(strings.TrimSpace(files[0]))
	if err != nil || abs == "" {
		return errors.New("invalid file path")
	}
	quotedPath := escapeAppleScriptString(abs)
	cmdCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, "osascript", "-e", `set the clipboard to (POSIX file "`+quotedPath+`")`)
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Run()
}

func readValidatedImageFile(path string, maxBytes int) ([]byte, string, bool, error) {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || info.Size() == 0 {
		return nil, "", false, nil
	}
	if info.Size() > int64(maxBytes) {
		return nil, "", false, clipboard.ErrItemTooLarge
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return nil, "", false, nil
	}
	_, mime, ok := DetectImageMIME(data)
	if !ok {
		return nil, "", false, nil
	}
	return data, mime, true, nil
}

func escapeAppleScriptString(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return s
}
