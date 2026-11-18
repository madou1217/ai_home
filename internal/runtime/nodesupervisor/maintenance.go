package nodesupervisor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"time"
)

// DirectChildDrain is rooted only in this Supervisor's actual Cmd.Wait joins.
// Its private fields prevent a decoded bool/participant message from minting it.
// It is NOT a full maintenance epoch or an adoption/lease-release capability:
// unknown descendants, independent hosts/Node and DB incarnation remain outside
// this receipt's population. No PID scan or new lock expands that population.
type DirectChildDrain struct {
	supervisor  *Supervisor
	generations uint64
}

// Inhibit irreversibly closes this instance's start/restart admission. It does
// not close the Go server's admission, signal an arbitrary process, or establish
// that any child has already exited. It may wait for an in-flight Start to
// publish the exact command; it has no claimed hard syscall cancellation bound.
func (supervisor *Supervisor) Inhibit() {
	if supervisor == nil {
		return
	}
	supervisor.mu.Lock()
	supervisor.inhibitLocked()
	neverStarted := !supervisor.started
	supervisor.mu.Unlock()
	if neverStarted {
		supervisor.finish()
	}
}

func (supervisor *Supervisor) inhibitLocked() {
	if !supervisor.stopping {
		supervisor.stopping = true
		close(supervisor.halt)
	}
}

func (supervisor *Supervisor) finish() {
	supervisor.doneOnce.Do(func() { close(supervisor.done) })
}

func (supervisor *Supervisor) recordDrainUnknown() {
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	supervisor.drainErr = fmt.Errorf("node_supervisor_direct_child_unknown")
	supervisor.inhibitLocked()
}

// A nonzero native exit is a known outcome, not a missing Wait. WaitDelay is
// fixed at zero, so Cmd.Wait has actually joined its pump goroutines, including
// when the process outcome is ExitError. Other Wait/pump failures stay UNKNOWN.
func directChildWaitJoined(command *exec.Cmd, err error) bool {
	if command.ProcessState == nil {
		return false
	}
	if err == nil {
		return true
	}
	var exited *exec.ExitError
	return errors.As(err, &exited) && exited.ProcessState == command.ProcessState
}

func (supervisor *Supervisor) waitRestart(delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-supervisor.halt:
		return false
	case <-timer.C:
		return true
	}
}

// Drain's cancellation only stops this caller waiting. It retains inhibit and
// the original background drain; no receipt is returned on timeout/uncertainty.
// Every subsequent Stop/Drain waits the same result, not merely a stopping bool.
func (supervisor *Supervisor) Drain(ctx context.Context) (DirectChildDrain, error) {
	if supervisor == nil || ctx == nil {
		return DirectChildDrain{}, fmt.Errorf("node_supervisor_direct_child_scope_required")
	}
	supervisor.Inhibit()
	supervisor.drainOnce.Do(func() { go supervisor.drainOriginalChild() })
	select {
	case <-ctx.Done():
		return DirectChildDrain{}, ctx.Err()
	case <-supervisor.drained:
	}
	if err := ctx.Err(); err != nil {
		return DirectChildDrain{}, err
	}
	supervisor.mu.Lock()
	defer supervisor.mu.Unlock()
	if supervisor.drainErr != nil {
		return DirectChildDrain{}, supervisor.drainErr
	}
	if supervisor.joined != supervisor.generation {
		return DirectChildDrain{}, fmt.Errorf("node_supervisor_direct_child_join_incomplete")
	}
	return DirectChildDrain{supervisor: supervisor, generations: supervisor.generation}, nil
}

// The original os.Process handle is the only signal target. Stop's timeout may
// escalate that direct child, not a group or descendant. Completion still waits
// the real watcher/Cmd.Wait; a stuck inherited pump never becomes a fake join.
func (supervisor *Supervisor) drainOriginalChild() {
	defer close(supervisor.drained)
	supervisor.mu.Lock()
	command := supervisor.command
	supervisor.mu.Unlock()
	if command == nil || command.Process == nil {
		<-supervisor.done
		return
	}
	// Signal may race a known exit; the sole Cmd.Wait, not signal success or
	// PID absence, determines the final direct-child proof.
	signalErr := command.Process.Signal(os.Interrupt)
	if signalErr != nil && !errors.Is(signalErr, os.ErrProcessDone) {
		supervisor.mu.Lock()
		supervisor.drainErr = fmt.Errorf("node_supervisor_direct_child_signal_unknown")
		supervisor.mu.Unlock()
	}
	timer := time.NewTimer(stopTimeout)
	defer timer.Stop()
	select {
	case <-supervisor.done:
		return
	case <-timer.C:
	}
	if err := command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		supervisor.mu.Lock()
		supervisor.drainErr = fmt.Errorf("node_supervisor_direct_child_kill_unknown")
		supervisor.mu.Unlock()
	}
	<-supervisor.done
}
