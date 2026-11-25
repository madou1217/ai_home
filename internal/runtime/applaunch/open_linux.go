//go:build linux

package applaunch

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/application/launcher"
)

const linuxLauncherHelperTimeout = 5 * time.Second

func openApp(ctx context.Context, app launcher.App) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	var errs []string

	// Tier 1: gio launch <desktop-file>
	if app.Path != "" {
		if gioBin, err := exec.LookPath("gio"); err == nil {
			if runErr := runDetachedHelper(ctx, gioBin, "launch", app.Path); runErr == nil {
				return nil
			} else {
				if isCancelOrTimeout(ctx, runErr) {
					return fmt.Errorf("gio launch %q: %w", app.Name, runErr)
				}
				errs = append(errs, fmt.Sprintf("gio launch: %v", runErr))
			}
		}
	}

	if err := ctx.Err(); err != nil {
		return err
	}

	// Tier 2: gtk-launch -- <desktop-id>
	desktopID := strings.TrimSpace(app.DesktopID)
	if desktopID == "" && strings.HasSuffix(app.Path, ".desktop") {
		desktopID = filepath.Base(app.Path)
	}
	if desktopID != "" {
		if gtkBin, err := exec.LookPath("gtk-launch"); err == nil {
			if runErr := runDetachedHelper(ctx, gtkBin, "--", desktopID); runErr == nil {
				return nil
			} else {
				if isCancelOrTimeout(ctx, runErr) {
					return fmt.Errorf("gtk-launch %q: %w", app.Name, runErr)
				}
				errs = append(errs, fmt.Sprintf("gtk-launch: %v", runErr))
			}
		}
	}

	if err := ctx.Err(); err != nil {
		return err
	}

	// Tier 3: Parse Exec= directly (with terminal emulator wrapper for Terminal=true apps).
	execLine := strings.TrimSpace(app.Exec)
	if execLine == "" && app.Path != "" {
		execLine = readDesktopExecField(app.Path)
	}
	argv := parseDesktopExec(execLine)
	if len(argv) == 0 {
		if len(errs) > 0 {
			return fmt.Errorf("unable to open %q (%s; no Exec command)", app.Name, strings.Join(errs, "; "))
		}
		return fmt.Errorf("%w: no Exec command found for %q", launcher.ErrInvalidInput, app.Name)
	}

	// Validate the real target executable BEFORE wrapping in a terminal emulator so
	// broken Terminal=true desktop entries fail explicitly instead of silently succeeding.
	targetBin, err := resolveLinuxExecutable(argv[0])
	if err != nil {
		if len(errs) > 0 {
			return fmt.Errorf("unable to open %q (%s; %v)", app.Name, strings.Join(errs, "; "), err)
		}
		return err
	}
	argv[0] = targetBin

	if app.Terminal {
		wrapped, termErr := wrapLinuxTerminal(argv)
		if termErr != nil {
			if len(errs) > 0 {
				return fmt.Errorf("unable to open %q (%s; %v)", app.Name, strings.Join(errs, "; "), termErr)
			}
			return termErr
		}
		argv = wrapped
	}

	if err := ctx.Err(); err != nil {
		return err
	}

	// Use exec.Command (not CommandContext) so a subsequent ctx cancellation never
	// kills an already-launched user application.
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		if len(errs) > 0 {
			return fmt.Errorf("unable to open %q (%s; exec %q: %w)", app.Name, strings.Join(errs, "; "), argv[0], err)
		}
		return fmt.Errorf("exec %q failed: %w", argv[0], err)
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

func isCancelOrTimeout(ctx context.Context, err error) bool {
	if ctx != nil && ctx.Err() != nil {
		return true
	}
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}

func runDetachedHelper(ctx context.Context, bin string, args ...string) error {
	helperCtx, cancel := context.WithTimeout(ctx, linuxLauncherHelperTimeout)
	defer cancel()
	cmd := exec.CommandContext(helperCtx, bin, args...)
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Run(); err != nil {
		if helperCtx.Err() != nil {
			return helperCtx.Err()
		}
		return err
	}
	return nil
}

func wrapLinuxTerminal(argv []string) ([]string, error) {
	candidates := []struct {
		bin  string
		flag string
	}{
		{bin: "x-terminal-emulator", flag: "-e"},
		{bin: "gnome-terminal", flag: "--"},
		{bin: "konsole", flag: "-e"},
		{bin: "xfce4-terminal", flag: "-x"},
		{bin: "alacritty", flag: "-e"},
		{bin: "xterm", flag: "-e"},
	}
	for _, cand := range candidates {
		if path, err := exec.LookPath(cand.bin); err == nil {
			out := make([]string, 0, len(argv)+2)
			out = append(out, path, cand.flag)
			out = append(out, argv...)
			return out, nil
		}
	}
	return nil, errors.New("no terminal emulator found to launch terminal application")
}

func resolveLinuxExecutable(name string) (string, error) {
	return exec.LookPath(name)
}
