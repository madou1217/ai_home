package accountbrowserhost

import (
	"context"
	"os/exec"
	"sync"
	"time"
)

// Supervisor owns a single dedicated stable browser process. It is not wired
// to account Open or exposed through HTTP before frame/input support exists.
type Supervisor struct {
	dir         string
	interactive bool
	gate        chan struct{}
	mu          sync.Mutex
	status      Status
	current     *hostProcess
	stranded    *hostStorage
}

type hostProcess struct {
	cmd      *exec.Cmd
	identity processIdentity
	family   *processFamily
	storage  *hostStorage
	done     chan struct{}
}

// New validates a pre-existing private directory without modifying it.
func New(options Options) (*Supervisor, error) {
	if !platformSupported() {
		return nil, ErrUnsupported
	}
	if err := validateSessionDir(options.SessionDir); err != nil {
		return nil, err
	}
	return &Supervisor{dir: options.SessionDir, interactive: options.Interactive, gate: make(chan struct{}, 1), status: Status{State: "stopped"}}, nil
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

func (s *Supervisor) state(state string, pid int, browser BrowserIdentity) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status = Status{State: state, PID: pid, Browser: browser}
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
	p.identity, err = identifyProcess(command.Process.Pid)
	// A spawned process is never forgotten even if ownership inspection fails.
	// In that case retain the disk marker/lock and require explicit recovery.
	if err != nil {
		go s.observe(p)
		s.state("failed", command.Process.Pid, installed.identity)
		return s.Status(), ErrRecoveryRequired
	}
	p.family = trackFamily(p.identity)
	s.state("starting", command.Process.Pid, installed.identity)
	go s.observe(p)
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	select {
	case <-p.done:
		return s.Status(), ErrHostExited
	case <-timer.C:
		s.mu.Lock()
		// observe can race this timer; it owns the unexpected-exit transition.
		select {
		case <-p.done:
			s.mu.Unlock()
			return s.Status(), ErrHostExited
		default:
			s.status.State = "running"
		}
		s.mu.Unlock()
	}
	return s.Status(), ctx.Err()
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
