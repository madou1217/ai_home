package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"syscall"

	"github.com/madou1217/ai_home/internal/runtime/codexhooks"
	"github.com/madou1217/ai_home/internal/runtime/codexpreferences"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
)

const codexCLIAppServerCapability = "aih-codex-cli-app-server-v1"

// runCodexCLIAppServer retires only the CLI-owned hook-disabled Node branch.
// Selection is observational and precedes execution; a failed launch never
// grants permission to fall back to the enabled compatibility implementation.
func runCodexCLIAppServer(ctx context.Context, args []string, runtime commandRuntime) error {
	if len(args) == 1 && args[0] == "--capabilities" {
		_, err := fmt.Fprintln(runtime.stdout, codexCLIAppServerCapability)
		return err
	}
	selectOnly := len(args) > 0 && args[0] == "--select"
	if selectOnly {
		args = args[1:]
	}
	if len(args) < 2 || args[0] != "--state-file" {
		return errors.New("codex_cli_app_server_arguments_invalid")
	}
	statePath := args[1]
	args = args[2:]
	if selectOnly {
		if len(args) != 0 {
			return errors.New("codex_cli_app_server_arguments_invalid")
		}
	} else if len(args) < 2 || args[0] != "--" || codexhooks.FindCodexSubcommand(args[1:]) != "app-server" {
		return errors.New("codex_cli_app_server_arguments_invalid")
	}
	enabled, err := readCodexCLIAppServerState(statePath)
	if err != nil {
		return err
	}
	if selectOnly {
		choice := "disabled-v1"
		if enabled {
			choice = "enabled-compat-v1"
		}
		_, err = fmt.Fprintln(runtime.stdout, choice)
		return err
	}
	if enabled {
		return errors.New("codex_cli_app_server_state_changed_retry")
	}
	if goruntime.GOOS == "windows" {
		return errors.New("codex_cli_app_server_posix_only")
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	// The wrapper supplies no executable override. Reuse authoritative managed
	// generations/admission; its cached backup is only a discovery hint.
	binary, err := providercli.ResolveBinary("codex", "codex")
	if err != nil {
		return err
	}
	home := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if home == "" {
		host := strings.TrimSpace(os.Getenv("HOME"))
		if host == "" {
			host = strings.TrimSpace(os.Getenv("USERPROFILE"))
		}
		if host != "" {
			home = filepath.Join(host, ".codex")
		}
	}
	if err = codexpreferences.CheckHostReady(home); err != nil {
		return err
	}
	// Recheck after discovery/admission too. State drift fails closed instead of
	// silently launching a disabled path after it was enabled by another writer.
	enabled, err = readCodexCLIAppServerState(statePath)
	if err != nil {
		return err
	}
	if enabled {
		return errors.New("codex_cli_app_server_state_changed_retry")
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	// POSIX replacement preserves native stdio, EOF, exit status and signals
	// without a second pipe pump, handshake consumer or process supervisor.
	signal.Reset(os.Interrupt, syscall.SIGTERM)
	return syscall.Exec(binary, append([]string{binary}, args[1:]...), os.Environ())
}

// readCodexCLIAppServerState reads the existing v1 CLIHookState, not a second
// source of hook policy. Missing means disabled as in the old helper; malformed
// or unavailable state is not a valid compatibility-selection result.
func readCodexCLIAppServerState(path string) (bool, error) {
	const limit = 64 << 10
	invalid := errors.New("codex_cli_app_server_state_invalid")
	if !filepath.IsAbs(path) || filepath.Base(path) != "cli-hook-state.json" {
		return false, invalid
	}
	before, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, errors.New("codex_cli_app_server_state_unavailable")
	}
	if !before.Mode().IsRegular() || before.Size() > limit {
		return false, invalid
	}
	// O_NONBLOCK prevents a raced special-file replacement from blocking Open.
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return false, errors.New("codex_cli_app_server_state_unavailable")
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(before, opened) {
		return false, invalid
	}
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return false, errors.New("codex_cli_app_server_state_unavailable")
	}
	if len(raw) > limit {
		return false, invalid
	}
	after, err := os.Lstat(path)
	if err != nil || !os.SameFile(opened, after) || after.Mode()&os.ModeSymlink != 0 || opened.Size() != after.Size() || !opened.ModTime().Equal(after.ModTime()) {
		return false, invalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return false, invalid
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return false, invalid
		}
		name, ok := token.(string)
		if !ok {
			return false, invalid
		}
		if _, exists := fields[name]; exists {
			return false, invalid
		}
		// encoding/json accepts case-insensitive struct keys, unlike the old
		// Node discriminator. Never let an alias override a validated exact key.
		if (strings.EqualFold(name, "enabled") && name != "enabled") || (strings.EqualFold(name, "version") && name != "version") {
			return false, invalid
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil {
			return false, invalid
		}
		fields[name] = value
	}
	if last, err := decoder.Token(); err != nil || last != json.Delim('}') {
		return false, invalid
	}
	if _, err = decoder.Token(); !errors.Is(err, io.EOF) {
		return false, invalid
	}
	version := bytes.TrimSpace(fields["version"])
	value := bytes.TrimSpace(fields["enabled"])
	if !bytes.Equal(version, []byte("1")) || (!bytes.Equal(value, []byte("true")) && !bytes.Equal(value, []byte("false"))) {
		return false, invalid
	}
	var state codexhooks.CLIHookState
	// Decode only the authoritative, exactly named discriminator fields.
	// Unknown v1 extension fields cannot affect compatibility selection.
	if json.Unmarshal(fields["version"], &state.Version) != nil || json.Unmarshal(fields["enabled"], &state.Enabled) != nil {
		return false, invalid
	}
	return state.Enabled, nil
}
