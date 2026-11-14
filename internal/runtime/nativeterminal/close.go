package nativeterminal

import (
	"context"
	"errors"
	"os"
	"time"
)

// CloseAccount closes only entries owned by this lifecycle and matching both
// harness and accountRef. Legacy Node windows remain the caller's responsibility.
func CloseAccount(ctx context.Context, home, provider, accountRef string) (CloseResult, error) {
	result := CloseResult{PIDs: []int{}}
	if ctx == nil || !safePart.MatchString(provider) || !accountRefPattern.MatchString(accountRef) {
		return result, ErrInvalid
	}
	entries, err := List(home)
	if err != nil {
		return result, err
	}
	var problems []error
	for _, entry := range entries {
		if entry.Provider != provider || entry.AccountRef != accountRef {
			continue
		}
		result.Matched++
		mux, muxErr := recordedMux(ctx, entry, os.Environ())
		if muxErr != nil {
			problems = append(problems, muxErr)
			continue
		}
		entry.CloseRequested = true
		if err = writeEntry(ctx, home, entry, false); err != nil {
			problems = append(problems, err)
			continue
		}
		pid := entry.SupervisorPID
		// A stale registry PID must never kill a reused unrelated process. tmux gives
		// the authoritative pane owner. Non-mux processes observe the close record.
		if mux != nil && mux.alive(ctx, entry) {
			livePID := mux.panePID(ctx, entry)
			if livePID > 0 && livePID == pid {
				_ = requestTermination(pid)
			}
		}
		path, _ := entryPath(home, entry.Socket, entry.Session)
		deadline := time.Now().Add(25 * time.Second)
		for time.Now().Before(deadline) {
			current, _, readErr := readEntry(path)
			if os.IsNotExist(readErr) {
				if pid > 0 {
					result.PIDs = append(result.PIDs, pid)
				}
				break
			}
			if readErr != nil {
				problems = append(problems, readErr)
				break
			}
			if current.CleanupError != "" {
				problems = append(problems, errors.New("native_terminal_cleanup_incomplete"))
				break
			}
			if pid == 0 && current.SupervisorPID > 0 {
				pid = current.SupervisorPID
			}
			if pid > 0 && !processAlive(pid) {
				problems = append(problems, errors.New("native_terminal_owner_exited_before_cleanup"))
				break
			}
			select {
			case <-ctx.Done():
				return result, ctx.Err()
			case <-time.After(50 * time.Millisecond):
			}
		}
		if _, _, readErr := readEntry(path); !os.IsNotExist(readErr) {
			problems = append(problems, errors.New("native_terminal_close_incomplete"))
			continue
		}
		if mux != nil {
			_ = mux.kill(context.WithoutCancel(ctx), entry)
		}
	}
	return result, errors.Join(problems...)
}
