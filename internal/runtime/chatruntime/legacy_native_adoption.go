package chatruntime

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const legacyNativeExitMarker = "__AIH_RUN_EXIT:"

// LegacyNativeAdoptionOptions is deliberately explicit. Without a cross-process
// owner and a strict backend the manager rejects before any manifest/log I/O.
type LegacyNativeAdoptionOptions struct {
	AIHomeDir              string
	Owner                  LegacyNativeRunOwner
	Multiplexer            LegacyNativeMultiplexer
	MaxRuns                int
	PollInterval           time.Duration
	MaxObservationDuration time.Duration
}

type legacyNativeClaim struct {
	identity      AdoptedNativeRunRequest
	mu            sync.Mutex
	cleanupErr    error
	terminal      NativeRunExit
	terminalSet   bool
	processExited bool
}

// LegacyNativeAdoptionManager owns a bounded number of canonical claims, not a
// directory scanner. Claims remain tombstoned until Close to prevent a second
// consumer from acquiring Done, including after termination or failed adoption.
type LegacyNativeAdoptionManager struct {
	opts   LegacyNativeAdoptionOptions
	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.Mutex
	closed bool
	claims map[string]*legacyNativeClaim
	wg     sync.WaitGroup
}

func NewLegacyNativeAdoptionManager(ctx context.Context, opts LegacyNativeAdoptionOptions) *LegacyNativeAdoptionManager {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithCancel(ctx)
	if opts.MaxRuns <= 0 {
		opts.MaxRuns = 32
	}
	if opts.MaxRuns > 128 {
		opts.MaxRuns = 128
	}
	if opts.PollInterval < 100*time.Millisecond {
		opts.PollInterval = 200 * time.Millisecond
	}
	if opts.PollInterval > 2*time.Second {
		opts.PollInterval = 2 * time.Second
	}
	if opts.MaxObservationDuration <= 0 || opts.MaxObservationDuration > 24*time.Hour {
		opts.MaxObservationDuration = 24 * time.Hour
	}
	return &LegacyNativeAdoptionManager{opts: opts, ctx: ctx, cancel: cancel, claims: make(map[string]*legacyNativeClaim)}
}

func (m *LegacyNativeAdoptionManager) Close() error {
	m.mu.Lock()
	m.closed = true
	m.cancel()
	m.mu.Unlock()
	m.wg.Wait()
	m.mu.Lock()
	defer m.mu.Unlock()
	var closeErrors []error
	for _, claim := range m.claims {
		claim.mu.Lock()
		closeErrors = append(closeErrors, claim.cleanupErr)
		claim.mu.Unlock()
	}
	return errors.Join(closeErrors...)
}

func (m *LegacyNativeAdoptionManager) GetOrAdopt(ctx context.Context, request AdoptedNativeRunRequest) (*NativeRunHandle, error) {
	if ctx == nil {
		return nil, fmt.Errorf("legacy_native_context_required")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := request.validate(); err != nil {
		return nil, err
	}
	if m.opts.Owner == nil || m.opts.Multiplexer == nil || m.opts.Multiplexer.Backend() != "tmux" {
		return nil, fmt.Errorf("legacy_native_owner_backend_unavailable")
	}
	m.mu.Lock()
	if m.closed || m.ctx.Err() != nil {
		m.mu.Unlock()
		return nil, fmt.Errorf("legacy_native_manager_closed")
	}
	if claim := m.claims[request.EngineRunID]; claim != nil {
		m.mu.Unlock()
		if claim.identity != request {
			return nil, fmt.Errorf("legacy_native_claim_identity_conflict")
		}
		return nil, fmt.Errorf("legacy_native_done_already_claimed")
	}
	if len(m.claims) >= m.opts.MaxRuns {
		m.mu.Unlock()
		return nil, fmt.Errorf("legacy_native_claim_limit")
	}
	claim := &legacyNativeClaim{identity: request}
	m.claims[request.EngineRunID] = claim
	m.wg.Add(1)
	m.mu.Unlock()

	watchCtx, cancel := context.WithTimeout(m.ctx, m.opts.MaxObservationDuration)
	stopCaller := context.AfterFunc(ctx, cancel)
	var lease LegacyNativeRunLease
	var log *os.File
	launched := false
	defer func() {
		if launched {
			return
		}
		cancel()
		stopCaller()
		var cleanupErrors []error
		if log != nil {
			cleanupErrors = append(cleanupErrors, log.Close())
		}
		if lease != nil {
			cleanupErrors = append(cleanupErrors, lease.Close())
		}
		claim.mu.Lock()
		claim.cleanupErr = errors.Join(cleanupErrors...)
		claim.mu.Unlock()
		m.wg.Done()
	}()
	ref, err := readLegacyNativeManifest(watchCtx, m.opts.AIHomeDir, request)
	if err != nil {
		return nil, err
	}
	lease, err = m.opts.Owner.Acquire(watchCtx, ref)
	if err != nil || lease == nil {
		return nil, fmt.Errorf("legacy_native_exclusive_owner_unavailable")
	}
	if err := lease.Check(watchCtx); err != nil {
		return nil, fmt.Errorf("legacy_native_owner_invalid")
	}
	binding := lease.Binding()
	if binding.Identity != request {
		return nil, fmt.Errorf("legacy_native_owner_identity_mismatch")
	}
	state, inspectErr := m.opts.Multiplexer.Inspect(watchCtx, ref, binding)
	exited, proofErr := lease.Exited(watchCtx)
	if proofErr != nil || (state == LegacyNativeRunAlive && exited) ||
		((inspectErr != nil || state != LegacyNativeRunAlive) && !exited) {
		return nil, fmt.Errorf("legacy_native_process_state_unknown")
	}
	log, err = openLegacyNativeFile(m.opts.AIHomeDir, filepath.Join("logs", "webui-runs", request.EngineRunID+".log"))
	if err != nil {
		return nil, err
	}
	identity, err := log.Stat()
	const maxLogBytes = 64 << 20
	if err != nil || identity.Size() > maxLogBytes {
		return nil, fmt.Errorf("legacy_native_log_limit")
	}
	if binding.LogIdentity == nil || !os.SameFile(binding.LogIdentity, identity) {
		return nil, fmt.Errorf("legacy_native_log_identity_unknown")
	}
	if err := watchCtx.Err(); err != nil {
		return nil, err
	}
	done := make(chan NativeRunExit, 1)
	quiesced := make(chan struct{})
	released := make(chan struct{})
	events := make(chan NativeRunEvent)
	sessionIDs := make(chan string)
	close(events)
	close(sessionIDs) // Recovery imports history after the true exit.
	handle := &NativeRunHandle{RunID: request.EngineRunID, Done: done, Quiesced: quiesced, ObserverReleased: released,
		Events: events, SessionIDs: sessionIDs, InteractionMode: ref.InteractionMode,
		CleanupError: func() error { claim.mu.Lock(); defer claim.mu.Unlock(); return claim.cleanupErr },
	}
	// No implicit input, abort, cleanup or replay. These callbacks require the
	// existing control entry and revalidate owner + actual socket/pane generation.
	var controlMu sync.Mutex
	control := func(input string, newline, abort bool) error {
		controlMu.Lock()
		defer controlMu.Unlock()
		if err := watchCtx.Err(); err != nil {
			return err
		}
		if err := lease.Check(watchCtx); err != nil {
			return fmt.Errorf("legacy_native_owner_invalid")
		}
		if abort {
			return m.opts.Multiplexer.Abort(watchCtx, ref, binding)
		}
		return m.opts.Multiplexer.WriteInput(watchCtx, ref, binding, input, newline)
	}
	handle.WriteInput = func(input string, newline bool) error { return control(input, newline, false) }
	handle.Abort = func() error { return control("", false, true) }
	launched = true
	go func() {
		defer m.wg.Done()
		exit, processExited := m.observe(watchCtx, ref, binding, lease, log, identity)
		// Stop controls before resource release. Quiesced means real exit AND this
		// observer's resources released, never just caller cancellation or Done.
		cancel()
		stopCaller()
		controlMu.Lock()
		cleanupErr := errors.Join(log.Close(), lease.Close())
		controlMu.Unlock()
		if cleanupErr != nil {
			exit.Err = errors.Join(exit.Err, fmt.Errorf("legacy_native_release_failed"))
		}
		claim.mu.Lock()
		claim.cleanupErr = cleanupErr
		claim.terminal = exit
		claim.terminalSet = true
		claim.processExited = processExited
		claim.mu.Unlock()
		// Release completion is observable on cancellation without claiming exit.
		close(released)
		if processExited && cleanupErr == nil {
			close(quiesced)
		}
		done <- exit
		close(done)
	}()
	return handle, nil
}

func (m *LegacyNativeAdoptionManager) observe(ctx context.Context, ref LegacyNativeRunRef, binding LegacyNativeRunBinding,
	lease LegacyNativeRunLease, log *os.File, identity os.FileInfo) (NativeRunExit, bool) {
	exit := NativeRunExit{ExitCode: -1, SessionID: ref.Identity.NativeSessionID}
	var offset int64
	var partial []byte
	marker := -1
	provedExited := false
	buffer := make([]byte, 32<<10)
	timer := time.NewTicker(m.opts.PollInterval)
	defer timer.Stop()
	fail := func(err error) (NativeRunExit, bool) { exit.Err = err; return exit, provedExited }
	for {
		if err := ctx.Err(); err != nil {
			return fail(err)
		}
		if err := lease.Check(ctx); err != nil {
			return fail(fmt.Errorf("legacy_native_owner_lost"))
		}
		// Open by canonical path each tick and verify the same file generation. Never
		// reset offset on truncation or follow a replacement/symlink into another log.
		current, err := openLegacyNativeFile(m.opts.AIHomeDir, filepath.Join("logs", "webui-runs", ref.Identity.EngineRunID+".log"))
		if err != nil {
			return fail(err)
		}
		info, statErr := current.Stat()
		closeErr := current.Close()
		if statErr != nil || closeErr != nil || !os.SameFile(identity, info) || info.Size() < offset || info.Size() > 64<<20 {
			return fail(fmt.Errorf("legacy_native_log_generation_unknown"))
		}
		n, readErr := log.ReadAt(buffer, offset)
		if readErr != nil && readErr != io.EOF {
			return fail(fmt.Errorf("legacy_native_log_read_failed"))
		}
		offset += int64(n) // Count actual bytes, preserving incomplete UTF-8 in partial.
		if offset > 64<<20 {
			return fail(fmt.Errorf("legacy_native_log_limit"))
		}
		partial = append(partial, buffer[:n]...)
		for {
			newline := bytes.IndexByte(partial, '\n')
			if newline < 0 {
				break
			}
			lineBytes := bytes.TrimSuffix(partial[:newline], []byte{'\r'})
			if len(lineBytes) > 1<<20 || !utf8.Valid(lineBytes) {
				return fail(fmt.Errorf("legacy_native_log_line_invalid"))
			}
			line := string(lineBytes)
			partial = partial[newline+1:]
			if marker >= 0 && line != "" {
				return fail(fmt.Errorf("legacy_native_exit_marker_not_final"))
			}
			if strings.HasPrefix(line, legacyNativeExitMarker) {
				suffix := strings.TrimPrefix(line, legacyNativeExitMarker)
				if len(suffix) == 0 || len(suffix) > 3 {
					return fail(fmt.Errorf("legacy_native_exit_marker_invalid"))
				}
				for _, char := range suffix {
					if char < '0' || char > '9' {
						return fail(fmt.Errorf("legacy_native_exit_marker_invalid"))
					}
				}
				value, err := strconv.Atoi(suffix)
				if err != nil || value > 255 || marker >= 0 {
					return fail(fmt.Errorf("legacy_native_exit_marker_invalid"))
				}
				marker = value
			}
		}
		if len(partial) > 1<<20 {
			return fail(fmt.Errorf("legacy_native_log_line_limit"))
		}
		state, inspectErr := m.opts.Multiplexer.Inspect(ctx, ref, binding)
		dead, proofErr := lease.Exited(ctx)
		if proofErr != nil {
			return fail(fmt.Errorf("legacy_native_exit_proof_unknown"))
		}
		if dead {
			provedExited = true
			if state == LegacyNativeRunAlive {
				return fail(fmt.Errorf("legacy_native_exit_proof_conflict"))
			}
		} else if inspectErr != nil || state != LegacyNativeRunAlive {
			return fail(fmt.Errorf("legacy_native_process_state_unknown"))
		}
		if provedExited {
			final, err := log.Stat()
			if err != nil || final.Size() < offset || final.Size() > 64<<20 {
				return fail(fmt.Errorf("legacy_native_log_generation_unknown"))
			}
			if offset >= final.Size() {
				if marker < 0 || len(partial) != 0 {
					return fail(fmt.Errorf("legacy_native_exit_unknown"))
				}
				exit.ExitCode = marker
				return exit, true
			}
			continue // Bounded chunks drain after a proved real exit.
		}
		select {
		case <-ctx.Done():
			return fail(ctx.Err())
		case <-timer.C:
		}
	}
}
