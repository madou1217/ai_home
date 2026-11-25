//go:build linux

package clipboardio

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/clipboard"
)

const linuxCommandTimeout = 1500 * time.Millisecond

type linuxBackend int

const (
	linuxBackendNone linuxBackend = iota
	linuxBackendWayland
	linuxBackendX11
)

type linuxIO struct{}

func newSystemIO() IO {
	return &linuxIO{}
}

func (l *linuxIO) detectBackend() (linuxBackend, Capability) {
	wayland := strings.TrimSpace(os.Getenv("WAYLAND_DISPLAY")) != ""
	x11 := strings.TrimSpace(os.Getenv("DISPLAY")) != ""
	if !wayland && !x11 {
		return linuxBackendNone, Capability{
			Supported: false,
			Reason:    "headless linux: neither WAYLAND_DISPLAY nor DISPLAY is set",
		}
	}
	if wayland {
		if hasCommand("wl-paste") && hasCommand("wl-copy") {
			return linuxBackendWayland, Capability{Supported: true}
		}
	}
	if x11 {
		if hasCommand("xclip") {
			return linuxBackendX11, Capability{Supported: true}
		}
	}
	if wayland {
		return linuxBackendNone, Capability{
			Supported: false,
			Reason:    "wayland session detected but wl-paste/wl-copy not found (and no xclip fallback)",
		}
	}
	return linuxBackendNone, Capability{
		Supported: false,
		Reason:    "x11 session detected but xclip not found",
	}
}

func (l *linuxIO) Probe() Capability {
	_, cap := l.detectBackend()
	return cap
}

func (l *linuxIO) ReadText(ctx context.Context, maxBytes int) (string, bool, error) {
	backend, _ := l.detectBackend()
	if backend == linuxBackendNone {
		return "", false, ErrUnsupported
	}
	if maxBytes <= 0 {
		maxBytes = clipboard.MaxTextBytes
	}
	var candidates [][]string
	if backend == linuxBackendWayland {
		candidates = [][]string{
			{"wl-paste", "--no-newline", "--type", "text/plain;charset=utf-8"},
			{"wl-paste", "--no-newline", "--type", "text/plain"},
		}
	} else {
		candidates = [][]string{
			{"xclip", "-selection", "clipboard", "-t", "UTF8_STRING", "-o"},
			{"xclip", "-selection", "clipboard", "-o"},
		}
	}
	for _, cmdArgs := range candidates {
		raw, ok, err := runLinuxRead(ctx, cmdArgs[0], cmdArgs[1:], maxBytes)
		if errors.Is(err, clipboard.ErrItemTooLarge) {
			return "", false, err
		}
		if ok && len(raw) > 0 {
			return string(raw), true, nil
		}
	}
	return "", false, nil
}

func (l *linuxIO) ReadFiles(ctx context.Context) ([]string, bool, error) {
	backend, _ := l.detectBackend()
	if backend == linuxBackendNone {
		return nil, false, ErrUnsupported
	}
	var cmdName string
	var args []string
	if backend == linuxBackendWayland {
		cmdName = "wl-paste"
		args = []string{"--no-newline", "--type", "text/uri-list"}
	} else {
		cmdName = "xclip"
		args = []string{"-selection", "clipboard", "-t", "text/uri-list", "-o"}
	}
	raw, ok, err := runLinuxRead(ctx, cmdName, args, clipboard.MaxTextBytes)
	if err != nil || !ok || len(raw) == 0 {
		return nil, false, nil
	}
	files := parseURIList(string(raw))
	if len(files) == 0 {
		return nil, false, nil
	}
	return files, true, nil
}

func (l *linuxIO) ReadImage(ctx context.Context, maxBytes int) ([]byte, string, bool, error) {
	backend, _ := l.detectBackend()
	if backend == linuxBackendNone {
		return nil, "", false, ErrUnsupported
	}
	if maxBytes <= 0 {
		maxBytes = clipboard.MaxImageBytes
	}
	mimes := []string{"image/png", "image/jpeg", "image/webp", "image/gif"}
	for _, declared := range mimes {
		var cmdName string
		var args []string
		if backend == linuxBackendWayland {
			cmdName = "wl-paste"
			args = []string{"--type", declared}
		} else {
			cmdName = "xclip"
			args = []string{"-selection", "clipboard", "-t", declared, "-o"}
		}
		raw, ok, err := runLinuxRead(ctx, cmdName, args, maxBytes)
		if errors.Is(err, clipboard.ErrItemTooLarge) {
			return nil, "", false, err
		}
		if !ok || len(raw) == 0 {
			continue
		}
		_, detectedMime, valid := DetectImageMIME(raw)
		if valid {
			return raw, detectedMime, true, nil
		}
	}
	return nil, "", false, nil
}

func (l *linuxIO) WriteText(ctx context.Context, text string) error {
	backend, _ := l.detectBackend()
	if backend == linuxBackendNone {
		return ErrUnsupported
	}
	if backend == linuxBackendWayland {
		return runLinuxWrite(ctx, "wl-copy", []string{"--type", "text/plain;charset=utf-8"}, []byte(text))
	}
	return runLinuxWrite(ctx, "xclip", []string{"-selection", "clipboard", "-in"}, []byte(text))
}

func (l *linuxIO) WriteImage(ctx context.Context, data []byte, mime string) error {
	backend, _ := l.detectBackend()
	if backend == linuxBackendNone {
		return ErrUnsupported
	}
	if len(data) == 0 {
		return clipboard.ErrEmptyContent
	}
	targetMIME := strings.TrimSpace(mime)
	if targetMIME == "" {
		if _, detected, ok := DetectImageMIME(data); ok {
			targetMIME = detected
		} else {
			targetMIME = "image/png"
		}
	}
	if backend == linuxBackendWayland {
		return runLinuxWrite(ctx, "wl-copy", []string{"--type", targetMIME}, data)
	}
	return runLinuxWrite(ctx, "xclip", []string{"-selection", "clipboard", "-t", targetMIME, "-in"}, data)
}

func (l *linuxIO) WriteFiles(ctx context.Context, files []string) error {
	backend, _ := l.detectBackend()
	if backend == linuxBackendNone {
		return ErrUnsupported
	}
	if len(files) == 0 {
		return clipboard.ErrEmptyContent
	}
	payload := []byte(formatURIList(files))
	if len(payload) == 0 {
		return clipboard.ErrEmptyContent
	}
	if backend == linuxBackendWayland {
		return runLinuxWrite(ctx, "wl-copy", []string{"--type", "text/uri-list"}, payload)
	}
	return runLinuxWrite(ctx, "xclip", []string{"-selection", "clipboard", "-t", "text/uri-list", "-in"}, payload)
}

func runLinuxRead(ctx context.Context, name string, args []string, maxBytes int) ([]byte, bool, error) {
	cmdCtx, cancel := context.WithTimeout(ctx, linuxCommandTimeout)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, name, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, false, err
	}
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return nil, false, nil
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

func runLinuxWrite(ctx context.Context, name string, args []string, payload []byte) error {
	cmdCtx, cancel := context.WithTimeout(ctx, linuxCommandTimeout)
	defer cancel()
	cmd := exec.CommandContext(cmdCtx, name, args...)
	cmd.Stdin = bytes.NewReader(payload)
	// Keep stdout/stderr nil so background selection holders (xclip/wl-copy) don't block Wait.
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Run()
}

func hasCommand(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}
