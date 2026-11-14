package nativeterminal

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/madou1217/ai_home/internal/runtime/persistent"
)

func launch(ctx context.Context, home string, spec Spec, detached bool, rt Runtime) (int, error) {
	environment := os.Environ()
	if err := validateIdentity(ctx, home, spec, environment); err != nil {
		return 1, err
	}
	intent := envValue(environment, "AIH_SESSION_INTENT")
	socket, err := persistent.DeriveSocket(spec.Provider, spec.AccountRef)
	if err != nil {
		return 1, err
	}
	mux, muxErr := detectMux(ctx, environment)
	disabled := envValue(environment, "AIH_NO_PERSIST") == "1" || intentField(intent, "active") == "1"
	id, err := token()
	if err != nil {
		return 1, err
	}
	session := "p-" + sanitize(filepath.Base(spec.CWD)) + "-" + shortHash(spec.CWD) + "-" + strconv.FormatInt(time.Now().UnixMilli(), 36) + "-" + id[:6]
	spec.Label = intentField(intent, "label")
	target := intentField(intent, "target")
	resume := intentField(intent, "resume") == "1"
	mirror := intentField(intent, "mirror") == "1"
	detached = detached || intentField(intent, "detached") == "1"
	if target != "" {
		if !safePart.MatchString(target) {
			return 1, ErrInvalid
		}
		session = target
	} else if spec.Label != "" {
		session = "s-" + sanitize(spec.Label)
	}
	entry := Entry{Spec: spec, Owner: Owner, RuntimeScope: spec.AccountRef, Socket: socket, Session: session, CorrelationID: id, SupervisorManaged: true, ForwardArgs: forwardArgs(spec), CreatedAt: time.Now().UnixMilli()}
	if muxErr == nil && !disabled {
		entry.Mux = mux.path
		entry.MuxSignature = fileSignature(mux.path)
		chosen, existing, chooseErr := selectSession(ctx, home, mux, entry, target != "", resume, mirror, detached)
		if chooseErr != nil {
			return 1, chooseErr
		}
		entry = chosen
		if existing {
			if detached {
				return 0, nil
			}
			return attach(ctx, mux, entry, mirror, rt)
		}
	}
	if err = writeEntry(ctx, home, entry, true); err != nil {
		return 1, err
	}
	environment = setEnv(environment, "AIH_HOME_DIR", home)
	environment = setEnv(environment, "AIH_ACCOUNT_APP", "1")
	environment = setEnv(environment, "AIH_PROVIDER_ACCOUNT_REF", spec.AccountRef)
	intent = setIntent(intent, "active", "1")
	intent = setIntent(intent, "correlation", entry.CorrelationID)
	environment = setEnv(environment, "AIH_SESSION_INTENT", intent)
	marker := envValue(environment, "AIH_RUNTIME_MARKER")
	marker = setIntent(marker, "utf8", "2026-06-utf8")
	marker = setIntent(marker, "supervisor", "2026-07-provider-supervisor-v1")
	if spec.Provider == "claude" {
		marker = setIntent(marker, "claude", "2026-06-render-v2")
	}
	environment = setEnv(environment, "AIH_RUNTIME_MARKER", marker)
	value := launchEnvelope{Entry: entry, Env: environment}
	if muxErr != nil || disabled {
		return supervise(home, value, rt), nil
	}
	envelope, err := writeEnvelope(home, value)
	if err != nil {
		_ = removeEntry(ctx, home, entry)
		return 1, err
	}
	exe, err := os.Executable()
	if err != nil {
		_ = os.Remove(filepath.Join(home, "run", "native-terminal-launches", envelope+".json"))
		_ = removeEntry(ctx, home, entry)
		return 1, err
	}
	if err = mux.create(ctx, home, exe, envelope, entry); err != nil {
		_ = os.Remove(filepath.Join(home, "run", "native-terminal-launches", envelope+".json"))
		_ = removeEntry(ctx, home, entry)
		return 1, err
	}
	if detached {
		_, _ = fmt.Fprintf(rt.Stdout, "%s %s\n", entry.Socket, entry.Session)
		return 0, nil
	}
	return attach(ctx, mux, entry, mirror, rt)
}

func attach(ctx context.Context, mux *multiplexer, entry Entry, share bool, rt Runtime) (int, error) {
	args := []string{"-u", "-L", entry.Socket, "attach-session"}
	if !share {
		args = append(args, "-d")
	}
	args = append(args, "-t", "="+entry.Session)
	command := exec.CommandContext(ctx, mux.path, args...)
	command.Env = withoutEnv(mux.env, "TMUX", "TMUX_PANE")
	command.Stdin = rt.Stdin
	command.Stdout = rt.Stdout
	command.Stderr = rt.Stderr
	err := command.Run()
	return processExit(err), nil
}

func selectSession(ctx context.Context, home string, mux *multiplexer, entry Entry, exact, resume, mirror, detached bool) (Entry, bool, error) {
	if !exact && entry.Label == "" && !resume && !mirror {
		return entry, false, nil
	}
	// Same socket and exact identity only. Never attach a similarly named session
	// belonging to a different account/environment.
	dir, _ := registryDir(home)
	files, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		return entry, false, err
	}
	candidates := []Entry{}
	for _, file := range files {
		if !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		candidate, _, err := readEntry(filepath.Join(dir, file.Name()))
		if err != nil || candidate.Socket != entry.Socket || candidate.Provider != entry.Provider || candidate.AccountRef != entry.AccountRef {
			continue
		}
		if exact || entry.Label != "" {
			if candidate.Session != entry.Session {
				continue
			}
		} else if filepath.Clean(candidate.CWD) != filepath.Clean(entry.CWD) {
			continue
		}
		if candidate.Owner == Owner && candidate.Mux != "" {
			if candidate.Mux != mux.path || candidate.MuxSignature != fileSignature(mux.path) {
				return entry, false, errors.New("native_terminal_mux_changed")
			}
		}
		if mux.alive(ctx, candidate) {
			candidates = append(candidates, candidate)
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].CreatedAt > candidates[j].CreatedAt })
	if len(candidates) > 0 {
		return candidates[0], true, nil
	}
	if exact && !detached {
		return entry, false, errors.New("native_terminal_target_unavailable")
	}
	path, _ := entryPath(home, entry.Socket, entry.Session)
	if old, _, readErr := readEntry(path); readErr == nil {
		if old.Owner != Owner || old.CleanupError != "" || old.Unrecoverable != "" {
			return entry, false, errors.New("native_terminal_recovery_required")
		}
		if !detached {
			return entry, false, errors.New("native_terminal_named_session_unavailable")
		}
		if err = removeEntry(ctx, home, old); err != nil {
			return entry, false, err
		}
	}
	return entry, false, nil
}
func forwardArgs(spec Spec) []string {
	intent, err := specIntent(spec)
	if err != nil {
		return nil
	}
	return intent.Arguments()
}
func sanitize(value string) string {
	var b strings.Builder
	for _, r := range value {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	s := strings.Trim(b.String(), "-")
	if len(s) > 60 {
		s = s[:60]
	}
	if s == "" {
		return "default"
	}
	return s
}
func shortHash(value string) string {
	var hash uint32
	for _, r := range utf16.Encode([]rune(value)) {
		hash = hash*31 + uint32(r)
	}
	encoded := strconv.FormatUint(uint64(hash), 36)
	if len(encoded) > 6 {
		encoded = encoded[:6]
	}
	for len(encoded) < 6 {
		encoded = "0" + encoded
	}
	return encoded
}
