package nativeterminal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"time"
)

func supervise(home string, value launchEnvelope, rt Runtime) int {
	entry := value.Entry
	if entry.Owner != Owner || !validEntryAddress(entry) || validateSpec(entry.Spec) != nil {
		return report(rt.Stderr, ErrInvalid)
	}
	// This runs only in the dedicated CLI process. Do not inherit stale account
	// variables from an existing mux server which are absent from the envelope.
	os.Clearenv()
	for _, item := range value.Env {
		key, val, ok := strings.Cut(item, "=")
		if ok {
			if err := os.Setenv(key, val); err != nil {
				return report(rt.Stderr, err)
			}
		}
	}
	if err := validateIdentity(context.Background(), home, entry.Spec, value.Env); err != nil {
		entry.CleanupError = "native_terminal_identity_mismatch"
		entry.Unrecoverable = "native-terminal-identity-mismatch"
		_ = writeEntry(context.Background(), home, entry, false)
		return report(rt.Stderr, err)
	}
	if err := os.Chdir(entry.CWD); err != nil {
		return report(rt.Stderr, err)
	}
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, terminationSignals()...)
	defer signal.Stop(signals)
	entry.SupervisorPID = os.Getpid()
	if err := writeEntry(context.Background(), home, entry, false); err != nil {
		return report(rt.Stderr, err)
	}
	runCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	titleCtx, stopTitle := context.WithCancel(context.Background())
	titleDone := make(chan struct{})
	go func() { defer close(titleDone); runTitles(titleCtx, home, entry, rt.Stdout) }()
	done := make(chan error, 1)
	go func() { done <- rt.RunCLI(runCtx, append([]string(nil), entry.Args...)) }()
	closeTick := time.NewTicker(100 * time.Millisecond)
	defer closeTick.Stop()
	path, _ := entryPath(home, entry.Socket, entry.Session)
	var control cachedTitleFile
	var requested os.Signal
	interrupted := false
	var runErr error
wait:
	for {
		select {
		case runErr = <-done:
			break wait
		case received := <-signals:
			if !interrupted {
				requested = received
				interrupted = true
				cancel()
			}
		case <-closeTick.C:
			var latest Entry
			if json.Unmarshal(control.read(path), &latest) == nil && latest.CloseRequested && !interrupted {
				// Reading display JSON is cheap, but signaling requires both records under
				// the writer lock. A damaged/missing sidecar may not kill the live pane.
				trusted, trustErr := readTrustedEntry(context.Background(), path)
				if trustErr == nil && trusted.CloseRequested && trusted.CorrelationID == entry.CorrelationID {
					interrupted = true
					cancel()
				}
			}
		}
	}
	stopTitle()
	<-titleDone
	// RunCLI has returned after its sole credential capture. Check only shared
	// links here and retain any explicit capture failure, even for silent exits.
	// TODO: RunCLI and title-worker waits above are not globally time-bounded;
	// this 20s budget only covers the following resource check, never forced
	// termination of a still-running credential capture.
	cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cleanupCancel()
	cleanupErr := reconcile(cleanupCtx, home, entry, envValue(value.Env, "AIH_HOST_HOME"))
	var silent interface {
		ExitCode() int
		SilentExit()
	}
	var capture interface{ CaptureFailed() bool }
	captureFailed := errors.As(runErr, &capture) && capture.CaptureFailed()
	runtimeFailure := runErr != nil && !errors.As(runErr, &silent) && !errors.Is(runErr, context.Canceled)
	if cleanupErr != nil || runtimeFailure || captureFailed {
		switch {
		case captureFailed:
			entry.CleanupError = "native_terminal_capture_failed"
		case cleanupErr != nil:
			entry.CleanupError = "native_terminal_shared_resources_unreconciled"
		default:
			entry.CleanupError = "native_terminal_run_failed"
		}
		entry.Unrecoverable = "native-terminal-cleanup-required"
		retainCtx, retainCancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = writeEntry(retainCtx, home, entry, false)
		retainCancel()
		// Do not print raw provider errors: credential-bearing errors stay in their
		// owning runtime. Keep a stable repair signal and the registry for recovery.
		_, _ = fmt.Fprintln(rt.Stderr, "aih native terminal: cleanup incomplete; registry retained")
		if requested != nil {
			return signalExit(requested)
		}
		if interrupted {
			return 130
		}
		if captureFailed && errors.As(runErr, &silent) {
			return silent.ExitCode()
		}
		return 1
	}
	if err := removeEntry(cleanupCtx, home, entry); err != nil {
		return report(rt.Stderr, err)
	}
	if requested != nil {
		return signalExit(requested)
	}
	if interrupted {
		return 130
	}
	if runErr != nil && errors.As(runErr, &silent) {
		return silent.ExitCode()
	}
	return 0
}
