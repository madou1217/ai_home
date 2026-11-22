package accountbrowserhost

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"sync"
	"time"
)

// Supervisor owns a single dedicated stable browser process. It is not wired
// to account Open or exposed through HTTP before frame/input support exists.
type Supervisor struct {
	dir         string
	interactive bool
	proxyURL    string
	gate        chan struct{}
	mu          sync.Mutex
	status      Status
	current     *hostProcess
	stranded    *hostStorage
}

type hostProcess struct {
	cmd             *exec.Cmd
	identity        processIdentity
	family          *processFamily
	storage         *hostStorage
	done            chan struct{}
	resumeAttempted bool
}

// New validates a pre-existing private directory without modifying it.
func New(options Options) (*Supervisor, error) {
	if !platformSupported() {
		return nil, ErrUnsupported
	}
	if err := validateSessionDir(options.SessionDir); err != nil {
		return nil, err
	}
	proxyURL, err := NormalizeProxyURL(options.ProxyURL)
	if err != nil {
		return nil, err
	}
	return &Supervisor{dir: options.SessionDir, interactive: options.Interactive, proxyURL: proxyURL, gate: make(chan struct{}, 1), status: Status{State: "stopped"}}, nil
}

func (s *Supervisor) enter(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case s.gate <- struct{}{}:
		if err := ctx.Err(); err != nil {
			<-s.gate
			return err
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Status is path-free process metadata, never a browser/account readiness claim.
func (s *Supervisor) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

func (s *Supervisor) state(state string, pid int, browser BrowserIdentity, started ...uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.setStateLocked(state, pid, browser, started...)
}

func (s *Supervisor) setStateLocked(state string, pid int, browser BrowserIdentity, started ...uint64) {
	marker := uint64(0)
	if len(started) > 0 {
		marker = started[0]
	} else if s.status.PID == pid {
		marker = s.status.Started
	}
	s.status = Status{State: state, PID: pid, Browser: browser, Started: marker}
}

// startupState refuses to resurrect a process that observe has already
// confirmed exited. The check and state write share s.mu with observe, so a
// terminal transition cannot be overwritten by a late startup step.
func (s *Supervisor) startupState(p *hostProcess, state string, pid int, browser BrowserIdentity, started uint64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p != nil {
		select {
		case <-p.done:
			return false
		default:
		}
	}
	s.setStateLocked(state, pid, browser, started)
	return true
}

func (s *Supervisor) promoteRunning(p *hostProcess) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p == nil || s.current != p {
		return false
	}
	select {
	case <-p.done:
		return false
	default:
	}
	s.status.State = "running"
	return true
}

// Start serializes concurrent launches. Once spawned, the process belongs to
// the supervisor, not an individual request; cancelling a waiter cannot kill it.
// A cancelled initiating request can therefore return both a PID and ctx.Err().
func (s *Supervisor) Start(ctx context.Context) (Status, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := s.enter(ctx); err != nil {
		return s.Status(), err
	}
	defer func() { <-s.gate }()
	if s.current != nil {
		select {
		case <-s.current.done:
			return s.Status(), ErrRecoveryRequired
		default:
			if s.Status().State != "running" {
				return s.Status(), ErrRecoveryRequired
			}
			return s.Status(), nil
		}
	}
	if s.stranded != nil {
		return s.Status(), ErrRecoveryRequired
	}
	s.state("starting", 0, BrowserIdentity{})
	installed, err := discover(ctx)
	if err != nil {
		s.state("failed", 0, BrowserIdentity{})
		return s.Status(), err
	}
	storage, err := acquireStorage(s.dir)
	if err != nil {
		s.state("failed", 0, installed.identity)
		return s.Status(), err
	}
	dataDir, err := storage.prepare()
	if err == nil {
		err = ctx.Err()
	}
	if err == nil {
		err = storage.markActive()
	}
	if err != nil {
		if cleanup := storage.release(false); cleanup != nil {
			s.stranded = storage
		}
		s.state("failed", 0, installed.identity)
		return s.Status(), err
	}
	args := []string{"--user-data-dir=" + dataDir, "--no-first-run", "--no-default-browser-check"}
	if s.proxyURL != "" {
		// A required account egress must not be bypassed by QUIC or non-proxied
		// WebRTC UDP. These are ordinary network-policy flags, not developer tooling.
		args = append(args, "--proxy-server="+s.proxyURL, "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp")
	}
	if s.interactive {
		args = append(args, "--new-window", "--window-size=1200,900", "about:blank")
	} else {
		args = append(args, "--no-startup-window")
	}
	command := exec.Command(installed.executable, args...)
	prepareCommand(command)
	if err := ctx.Err(); err != nil {
		cleanup := storage.release(true)
		s.state("failed", 0, installed.identity)
		if cleanup != nil {
			s.stranded = storage
			return s.Status(), cleanup
		}
		return s.Status(), err
	}
	if err := command.Start(); err != nil {
		cleanup := storage.release(true)
		s.state("failed", 0, installed.identity)
		if cleanup != nil {
			s.stranded = storage
			return s.Status(), cleanup
		}
		return s.Status(), ErrUnavailable
	}
	p := &hostProcess{cmd: command, storage: storage, done: make(chan struct{})}
	s.current = p
	go s.observe(p)
	p.identity, err = identifyProcess(command.Process.Pid)
	// A spawned process is never forgotten even if ownership inspection fails.
	// In that case retain the disk marker/lock and require explicit recovery.
	if err != nil {
		_ = s.abortStart(p, installed.identity)
		return s.Status(), ErrRecoveryRequired
	}
	p.family = trackFamily(p.identity)
	if err := p.family.attach(command); err != nil {
		_ = s.abortStart(p, installed.identity)
		return s.Status(), ErrRecoveryRequired
	}
	if !s.startupState(p, "starting", command.Process.Pid, installed.identity, processStartMarker(p.identity)) {
		_ = s.abortStart(p, installed.identity)
		return s.Status(), ErrHostExited
	}
	p.resumeAttempted = true
	if err := p.family.resume(command); err != nil {
		_ = s.abortStart(p, installed.identity)
		return s.Status(), ErrRecoveryRequired
	}
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case <-p.done:
		return s.Status(), ErrHostExited
	case <-timer.C:
		// promoteRunning shares the same lock as observe so an exited process
		// cannot be reported as running after the observer won the race.
		if !s.promoteRunning(p) {
			return s.Status(), ErrHostExited
		}
	}
	return s.Status(), ctx.Err()
}

// abortStart terminates a process that was launched during a failed startup
// before the normal running-state shutdown path can take ownership. It keeps
// the profile marker/lock when process or storage identity cannot be proved
// clean, so a later explicit recovery remains the only way to reuse it.
func (s *Supervisor) abortStart(p *hostProcess, browser BrowserIdentity) error {
	if p == nil {
		return ErrRecoveryRequired
	}
	if p.family == nil {
		if p.canReleaseWithoutFamily() {
			// Windows has not resumed the suspended root, so its Process handle
			// is the complete owned family and cleanup can be proved directly.
			return s.cleanupUncontained(context.Background(), p, browser, "failed")
		}
		// On Darwin, retain a live unclassified root and let RetryCleanup
		// re-validate it. Killing an unclassified root could leave descendants
		// behind while falsely suggesting the profile is safe to reuse.
		if err := p.recoverFamily(); err != nil {
			pid := 0
			if p.cmd != nil && p.cmd.Process != nil {
				pid = p.cmd.Process.Pid
			}
			s.state("failed", pid, browser)
			return ErrRecoveryRequired
		}
	}
	pid := 0
	if p.cmd != nil && p.cmd.Process != nil {
		pid = p.cmd.Process.Pid
	}
	terminated := false
	select {
	case <-p.done:
		terminated = true
	default:
	}
	if !terminated && p.family != nil {
		terminated = p.family.terminate() == nil
	}
	if !terminated && pid > 1 {
		terminated = p.identity.signal(true) == nil
	}
	if !terminated && p.cmd != nil && p.cmd.Process != nil {
		err := p.cmd.Process.Kill()
		terminated = err == nil || errors.Is(err, os.ErrProcessDone)
	}
	if !terminated {
		s.state("failed", pid, browser)
		return ErrRecoveryRequired
	}
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	select {
	case <-p.done:
	case <-deadline.C:
		s.state("failed", pid, browser)
		return ErrRecoveryRequired
	}
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	deadline.Reset(3 * time.Second)
	for {
		empty, err := p.family.empty()
		if err != nil {
			s.state("failed", pid, browser)
			return err
		}
		if empty {
			break
		}
		select {
		case <-deadline.C:
			s.state("failed", pid, browser)
			return ErrRecoveryRequired
		case <-ticker.C:
		}
	}
	p.family.close()
	if err := p.storage.release(true); err != nil {
		s.stranded = p.storage
		s.current = nil
		s.state("failed", 0, browser)
		return err
	}
	s.current = nil
	s.state("failed", 0, browser)
	return nil
}

func (s *Supervisor) cleanupUncontained(ctx context.Context, p *hostProcess, browser BrowserIdentity, finalState string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if p == nil || !p.canReleaseWithoutFamily() {
		s.state("failed", 0, browser)
		return ErrRecoveryRequired
	}
	select {
	case <-p.done:
	default:
		if p.cmd == nil || p.cmd.Process == nil {
			s.state("failed", 0, browser)
			return ErrRecoveryRequired
		}
		err := p.cmd.Process.Kill()
		if err != nil && !errors.Is(err, os.ErrProcessDone) {
			s.state("failed", p.cmd.Process.Pid, browser)
			return ErrRecoveryRequired
		}
	}
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	select {
	case <-p.done:
	case <-ctx.Done():
		s.state("failed", p.cmd.Process.Pid, browser)
		return ctx.Err()
	case <-deadline.C:
		s.state("failed", p.cmd.Process.Pid, browser)
		return ErrRecoveryRequired
	}
	if err := p.storage.release(true); err != nil {
		s.stranded = p.storage
		s.current = nil
		s.state("failed", 0, browser)
		return err
	}
	s.current = nil
	s.state(finalState, 0, browser)
	return nil
}

func (s *Supervisor) observe(p *hostProcess) {
	_ = p.cmd.Wait()
	s.mu.Lock()
	if s.status.State != "stopping" {
		s.status.State = "failed"
	}
	close(p.done)
	s.mu.Unlock()
}
