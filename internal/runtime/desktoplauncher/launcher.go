// Package desktoplauncher owns a single versioned native-helper process, not its UI/business logic.
package desktoplauncher

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/desktopprotocol"
)

var ErrClosed = errors.New("desktop_launcher_closed")
var ErrUnavailable = errors.New("desktop_helper_unavailable")
var ErrBackpressure = errors.New("desktop_helper_backpressure")

type LaunchSpec struct {
	File      string
	Args, Env []string
}
type Status struct {
	State      string `json:"status"`
	Generation uint64 `json:"generation"`
	PID        int    `json:"pid,omitempty"`
	Handshake  bool   `json:"handshake"`
	Retries    int    `json:"retries"`
	Error      string `json:"error,omitempty"`
}
type Options struct {
	Build            func(context.Context) (LaunchSpec, error)
	OnEvent          func(context.Context, map[string]any)
	OnStatus         func(Status)
	Mode             string
	HandshakeTimeout time.Duration
	RestartDelay     time.Duration
	MaxRestarts      int
}
type outbound struct {
	raw []byte
	ctx context.Context
}

type process struct {
	cmd                 *exec.Cmd
	input               io.WriteCloser
	output, errorOutput io.ReadCloser
	ctx                 context.Context
	cancel              context.CancelFunc
	ready               chan struct{}
	readyOnce           sync.Once
	exited              chan struct{}
	stopped             bool   // launcher.mu
	handshake           bool   // launcher.mu
	fail                string // launcher.mu
	generation          uint64
	watermark           int64 // reader-owned
	out                 chan outbound
	in                  chan map[string]any
	queueMu             sync.Mutex
	outBytes, inBytes   int
	waitDone            chan struct{}
	waitErr             error // read after waitDone
}
type startFlight struct {
	done   chan struct{}
	err    error
	cancel context.CancelFunc
}
type Launcher struct {
	options    Options
	mu         sync.Mutex
	current    *process
	starting   *startFlight
	generation uint64
	closed     bool
	state      Status
	restart    *time.Timer
	retries    int
	workers    int
}

func New(options Options) (*Launcher, error) {
	if options.Build == nil {
		return nil, ErrUnavailable
	}
	if options.HandshakeTimeout <= 0 {
		options.HandshakeTimeout = 5 * time.Second
	}
	if options.RestartDelay <= 0 {
		options.RestartDelay = 2 * time.Second
	}
	if options.MaxRestarts <= 0 {
		options.MaxRestarts = 3
	}
	return &Launcher{options: options, state: Status{State: "idle"}}, nil
}
func (l *Launcher) Status() Status { l.mu.Lock(); defer l.mu.Unlock(); return l.state }
func (l *Launcher) publishStatus(state Status) {
	if l.options.OnStatus != nil {
		l.options.OnStatus(state)
	}
}
func (l *Launcher) setStateLocked(state, code string) Status {
	l.state = Status{State: state, Generation: l.generation, Retries: l.retries, Error: code}
	if p := l.current; p != nil {
		l.state.PID = p.cmd.Process.Pid
		l.state.Handshake = p.handshake
	}
	return l.state
}
func (l *Launcher) Start(ctx context.Context) error {
	if ctx == nil {
		return ErrUnavailable
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return ErrClosed
	}
	if l.current != nil && (l.current.stopped || l.current.fail != "") {
		old := l.current
		l.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-old.exited:
			return l.Start(ctx)
		}
	}
	if l.current != nil && l.current.handshake {
		l.mu.Unlock()
		return nil
	}
	if flight := l.starting; flight != nil {
		l.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-flight.done:
			return flight.err
		}
	}
	if l.workers >= 2 {
		l.mu.Unlock()
		return ErrBackpressure
	}
	if l.restart != nil {
		l.restart.Stop()
		l.restart = nil
	}
	l.generation++
	generation := l.generation
	buildCtx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	flight := &startFlight{done: make(chan struct{}), cancel: cancel}
	l.starting = flight
	status := l.setStateLocked("starting", "")
	l.mu.Unlock()
	l.publishStatus(status)
	go func() {
		err := l.start(buildCtx, generation)
		cancel()
		l.mu.Lock()
		flight.err = err
		if l.starting == flight {
			l.starting = nil
		}
		close(flight.done)
		l.mu.Unlock()
	}()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-flight.done:
		return flight.err
	}
}
func (l *Launcher) start(ctx context.Context, generation uint64) error {
	spec, err := l.options.Build(ctx)
	if err != nil {
		l.startFailure(generation, "desktop_build_failed")
		return err
	}
	if spec.File == "" {
		l.startFailure(generation, "desktop_build_invalid")
		return ErrUnavailable
	}
	l.mu.Lock()
	stale := l.closed || l.generation != generation
	l.mu.Unlock()
	if stale || ctx.Err() != nil {
		return context.Canceled
	}
	cmd := exec.Command(spec.File, spec.Args...)
	prepareProcess(cmd)
	cmd.Env = append([]string(nil), spec.Env...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		stdin.Close()
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		stdin.Close()
		stdout.Close()
		return err
	}
	if err = cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		stderr.Close()
		l.startFailure(generation, "desktop_spawn_failed")
		return err
	}
	runCtx, cancel := context.WithCancel(context.Background())
	p := &process{cmd: cmd, input: stdin, output: stdout, errorOutput: stderr, ctx: runCtx, cancel: cancel, ready: make(chan struct{}), exited: make(chan struct{}), waitDone: make(chan struct{}), generation: generation, out: make(chan outbound, 64), in: make(chan map[string]any, 64)}
	l.mu.Lock()
	if l.closed || l.generation != generation {
		l.mu.Unlock()
		cancel()
		stdin.Close()
		stdout.Close()
		stderr.Close()
		cmd.Process.Kill()
		cmd.Wait()
		return context.Canceled
	}
	l.current = p
	l.workers++
	status := l.setStateLocked("handshaking", "")
	l.mu.Unlock()
	l.publishStatus(status)
	go l.writeLoop(p)
	go l.eventLoop(p)
	go func() { _, _ = io.Copy(io.Discard, stderr) }()
	go l.readLoop(p)
	go func() { p.waitErr = cmd.Wait(); close(p.waitDone); p.output.Close(); p.errorOutput.Close() }()
	if err := l.sendTo(p, map[string]any{"version": 1, "type": "hello"}); err != nil {
		l.fail(p, "desktop_write_failed", true)
		return err
	}
	timer := time.NewTimer(l.options.HandshakeTimeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		l.fail(p, "desktop_start_cancelled", true)
		return ctx.Err()
	case <-p.ready:
		l.mu.Lock()
		ok := p.handshake
		code := p.fail
		l.mu.Unlock()
		if ok {
			return nil
		}
		if code == "" {
			return ErrUnavailable
		}
		return errors.New(code)
	case <-p.exited:
		return ErrUnavailable
	case <-timer.C:
		l.fail(p, "desktop_protocol_handshake_timeout", true)
		return ErrUnavailable
	}
}
func (l *Launcher) startFailure(generation uint64, code string) {
	l.mu.Lock()
	if l.generation != generation || l.closed {
		l.mu.Unlock()
		return
	}
	status := l.setStateLocked("error", code)
	l.mu.Unlock()
	l.publishStatus(status)
}
func (l *Launcher) Send(event map[string]any) error {
	return l.SendContext(context.Background(), event)
}
func (l *Launcher) SendContext(ctx context.Context, event map[string]any) error {
	l.mu.Lock()
	p := l.current
	l.mu.Unlock()
	if p == nil {
		return ErrUnavailable
	}
	return l.sendWithContext(ctx, p, event)
}
func (l *Launcher) sendTo(p *process, event map[string]any) error {
	return l.sendWithContext(p.ctx, p, event)
}
func (l *Launcher) sendWithContext(ctx context.Context, p *process, event map[string]any) error {
	if ctx == nil {
		return ErrUnavailable
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	raw, err := desktopprotocol.Encode(event)
	if err != nil {
		return err
	}
	l.mu.Lock()
	valid := l.current == p && !p.stopped && !l.closed
	l.mu.Unlock()
	if !valid {
		return ErrUnavailable
	}
	p.queueMu.Lock()
	if len(raw) > 1<<20-p.outBytes {
		p.queueMu.Unlock()
		l.fail(p, "desktop_output_overflow", true)
		return ErrBackpressure
	}
	p.outBytes += len(raw)
	select {
	case p.out <- outbound{raw: raw, ctx: ctx}:
		p.queueMu.Unlock()
		return nil
	default:
		p.outBytes -= len(raw)
		p.queueMu.Unlock()
		l.fail(p, "desktop_output_overflow", true)
		return ErrBackpressure
	}
}
func (l *Launcher) Stop(ctx context.Context) error { return l.stop(ctx, false) }
func (l *Launcher) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return l.stop(ctx, true)
}
func (l *Launcher) stop(ctx context.Context, permanent bool) error {
	if ctx == nil {
		ctx = context.Background()
	}
	l.mu.Lock()
	if permanent {
		l.closed = true
	}
	l.generation++
	if l.restart != nil {
		l.restart.Stop()
		l.restart = nil
	}
	flight := l.starting
	if flight != nil {
		flight.cancel()
	}
	p := l.current
	if p != nil {
		p.stopped = true
		p.fail = ""
	}
	status := l.setStateLocked("stopping", "")
	l.mu.Unlock()
	l.publishStatus(status)
	if p == nil {
		if flight != nil {
			select {
			case <-flight.done:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		l.mu.Lock()
		status = l.setStateLocked("stopped", "")
		l.mu.Unlock()
		l.publishStatus(status)
		return nil
	}
	p.cancel()
	p.input.Close()
	terminateProcess(p.cmd, false)
	p.output.Close()
	p.errorOutput.Close()
	killTimer := time.AfterFunc(2*time.Second, func() { terminateProcess(p.cmd, true) })
	defer killTimer.Stop()
	select {
	case <-p.exited:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (l *Launcher) fail(p *process, code string, retry bool) {
	l.mu.Lock()
	if l.current != p || p.stopped || p.fail != "" {
		l.mu.Unlock()
		return
	}
	p.fail = code
	if !retry {
		p.stopped = true
		l.closed = true
	}
	status := l.setStateLocked("error", code)
	l.mu.Unlock()
	l.publishStatus(status)
	p.cancel()
	p.input.Close()
	terminateProcess(p.cmd, false)
	p.output.Close()
	p.errorOutput.Close()
	p.readyOnce.Do(func() { close(p.ready) })
}
func (l *Launcher) finished(p *process) {
	// EOF does not guarantee process exit (a child may close stdout but keep reading).
	p.input.Close()
	select {
	case <-p.waitDone:
	case <-time.After(200 * time.Millisecond):
		terminateProcess(p.cmd, false)
		select {
		case <-p.waitDone:
		case <-time.After(2 * time.Second):
			terminateProcess(p.cmd, true)
			<-p.waitDone
		}
	}
	p.cancel()
	p.input.Close()
	p.errorOutput.Close()
	l.mu.Lock()
	same := l.current == p
	if same {
		l.current = nil
	}
	permanent := l.closed || p.stopped || l.generation != p.generation
	normal := p.waitErr == nil && p.fail == ""
	status := l.state
	if same {
		if permanent || normal {
			status = l.setStateLocked("stopped", "")
		} else {
			code := p.fail
			if code == "" {
				code = "desktop_helper_exited"
			}
			status = l.setStateLocked("error", code)
		}
	}
	if same && !permanent && l.options.Mode != "full-app" && l.retries < l.options.MaxRestarts {
		l.retries++
		l.restart = time.AfterFunc(l.options.RestartDelay, func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
			defer cancel()
			_ = l.Start(ctx)
		})
	}
	l.mu.Unlock()
	p.readyOnce.Do(func() { close(p.ready) })
	close(p.exited)
	if same {
		l.publishStatus(status)
	}
}

// Wait waits for the current child to exit without changing lifecycle ownership.
func (l *Launcher) Wait(ctx context.Context) error {
	l.mu.Lock()
	p := l.current
	state := l.state
	l.mu.Unlock()
	if p == nil {
		if state.Error != "" {
			return errors.New(state.Error)
		}
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-p.exited:
	}
	l.mu.Lock()
	code := p.fail
	intentional := p.stopped || l.closed
	l.mu.Unlock()
	if intentional {
		return nil
	}
	if code != "" {
		return errors.New(code)
	}
	if p.waitErr != nil {
		return ErrUnavailable
	}
	return nil
}
