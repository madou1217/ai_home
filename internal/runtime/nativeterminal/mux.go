package nativeterminal

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type multiplexer struct {
	path string
	env  []string
}

func detectMux(ctx context.Context, env []string) (*multiplexer, error) {
	candidates := []string{"tmux"}
	if runtime.GOOS == "windows" {
		candidates = windowsMuxCandidates(env)
	}
	for _, candidate := range candidates {
		found, err := resolveExecutable(candidate, env)
		if err != nil {
			continue
		}
		probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		cmd := exec.CommandContext(probeCtx, found, "-V")
		cmd.Env = env
		err = cmd.Run()
		cancel()
		if err == nil {
			if resolved, resolveErr := filepath.EvalSymlinks(found); resolveErr == nil {
				found = resolved
			}
			return &multiplexer{path: found, env: env}, nil
		}
	}
	return nil, fmt.Errorf("native_terminal_multiplexer_unavailable")
}
func (mux *multiplexer) command(ctx context.Context, socket string, args ...string) (string, error) {
	if mux == nil || !filepath.IsAbs(mux.path) || !safePart.MatchString(socket) {
		return "", ErrInvalid
	}
	runCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(runCtx, mux.path, append([]string{"-u", "-L", socket}, args...)...)
	cmd.Env = withoutEnv(mux.env, "TMUX", "TMUX_PANE")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return string(output), fmt.Errorf("native_terminal_mux_command_failed: %w", err)
	}
	return string(output), nil
}
func (mux *multiplexer) alive(ctx context.Context, entry Entry) bool {
	_, err := mux.command(ctx, entry.Socket, "has-session", "-t", "="+entry.Session)
	return err == nil
}
func (mux *multiplexer) panePID(ctx context.Context, entry Entry) int {
	out, err := mux.command(ctx, entry.Socket, "display-message", "-p", "-t", entry.Session, "#{pane_pid}")
	if err != nil {
		return 0
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(out))
	return pid
}
func (mux *multiplexer) kill(ctx context.Context, entry Entry) error {
	_, err := mux.command(ctx, entry.Socket, "kill-session", "-t", "="+entry.Session)
	if err != nil && !mux.alive(ctx, entry) {
		return nil
	}
	return err
}

func muxConfig(home, provider, path string) (string, error) {
	dir := filepath.Join(home, "run", "tmux")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	lines := []string{"# AIH Go native terminal; separate from user tmux configuration.", "set -g status off", "set -g window-size latest", "set -g aggressive-resize off", "set -g escape-time 0", "set -gq allow-passthrough on", "set -gq extended-keys on", "set -gq extended-keys-format csi-u", "set -g mouse on", "set -g history-limit 50000", "set -g remain-on-exit off", "set -g destroy-unattached off", "set -g detach-on-destroy on", "set -g set-titles on", "set -g set-titles-string '#{pane_title}'", "set -g allow-rename off"}
	features := "xterm*:clipboard:ccolour:cstyle:focus:title:extkeys:sync"
	if provider == "codex" {
		features = "xterm*:clipboard:ccolour:cstyle:focus:title:extkeys"
		lines = append(lines, `set -s terminal-overrides[99] "*:Sync@"`)
	}
	lines = append(lines, `set -g terminal-features[0] "`+features+`"`)
	if runtime.GOOS == "windows" && strings.EqualFold(filepath.Base(path), "psmux.exe") {
		compatible := make([]string, 0, len(lines)+3)
		for _, line := range lines {
			if strings.HasPrefix(line, "set -gq extended-keys") {
				continue
			}
			compatible = append(compatible, line)
		}
		executable := "'" + strings.ReplaceAll(strings.ReplaceAll(path, `\`, "/"), "'", "''") + "'"
		lines = append(compatible, "set -g default-shell powershell", `run-shell "& `+executable+` set -gq extended-keys on"`, `run-shell "& `+executable+` set -gq extended-keys-format csi-u"`)
	}
	target := filepath.Join(dir, "native-"+provider+".conf")
	content := []byte(strings.Join(lines, "\n") + "\n")
	if existing, err := os.ReadFile(target); err == nil && string(existing) == string(content) {
		return target, nil
	}
	temp, err := os.CreateTemp(dir, ".native-conf-")
	if err != nil {
		return "", err
	}
	defer os.Remove(temp.Name())
	_, err = temp.Write(content)
	err = joinClose(err, temp)
	if err != nil {
		return "", err
	}
	if err = os.Rename(temp.Name(), target); err != nil {
		return "", err
	}
	return target, nil
}
func joinClose(err error, file *os.File) error {
	closeErr := file.Close()
	if err != nil {
		return err
	}
	return closeErr
}

// create is strictly fresh. Never use new-session -A -d: it may attach and hang
// when another process already created the same target.
func (mux *multiplexer) create(ctx context.Context, home, executable, envelopeID string, entry Entry) error {
	conf, err := muxConfig(home, entry.Provider, mux.path)
	if err != nil {
		return err
	}
	args := []string{"-f", conf, "new-session", "-d", "-s", entry.Session, "-c", entry.CWD, "-x", "120", "-y", "30", "--", executable, Command, "inner", "--home", home, "--envelope", envelopeID, "--provider", entry.Provider, "--account-ref", entry.AccountRef, "--account-id", strconv.FormatInt(entry.CLIAccountID, 10)}
	_, err = mux.command(ctx, entry.Socket, args...)
	return err
}

// recordedMux never re-detects a different psmux/tmux from the closer's PATH.
// Both the canonical path and launch-time file signature must still match.
func recordedMux(ctx context.Context, entry Entry, env []string) (*multiplexer, error) {
	if entry.Mux == "" {
		return nil, nil
	}
	if !filepath.IsAbs(entry.Mux) {
		return nil, ErrInvalid
	}
	path, err := resolveExecutable(entry.Mux, env)
	if err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil || resolved != entry.Mux {
		return nil, fmt.Errorf("native_terminal_mux_changed")
	}
	if entry.MuxSignature == "" || fileSignature(path) != entry.MuxSignature {
		return nil, fmt.Errorf("native_terminal_mux_changed")
	}
	return &multiplexer{path: path, env: env}, nil
}
