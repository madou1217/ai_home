package accountbrowserview

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/accountbrowserhost"
)

var errPermission = surfaceFailure("browser_system_permission_required")

type ScopedOptions struct {
	DataDir  string
	ProxyURL string
}

type Service struct {
	home    string
	mu      sync.Mutex
	active  bool
	blocked bool
	pending *accountbrowserhost.Supervisor
}

func New(options Options) *Service { return &Service{home: options.AIHomeDir} }
func (s *Service) Supported() bool { return s != nil && platformSupported() && filepath.IsAbs(s.home) }

// Serve owns one controller and never accepts a client-supplied native PID.
// The explicit start command is the user consent boundary for foreground UI.
func (s *Service) Serve(ctx context.Context, t Transport) (resultErr error) {
	return s.serve(ctx, t, "", "")
}

// ServeScoped uses a server-validated durable account profile directory. The
// directory is never accepted from the browser client and is not exposed over
// HTTP. An empty directory keeps the project-studio task scope.
func (s *Service) ServeScoped(ctx context.Context, t Transport, dataDir string) (resultErr error) {
	return s.ServeScopedWithOptions(ctx, t, ScopedOptions{DataDir: dataDir})
}

func (s *Service) ServeScopedWithOptions(ctx context.Context, t Transport, options ScopedOptions) (resultErr error) {
	if options.DataDir == "" {
		return surfaceFailure("browser_storage_unavailable")
	}
	return s.serve(ctx, t, options.DataDir, options.ProxyURL)
}

func (s *Service) serve(ctx context.Context, t Transport, dataDir string, proxyURL string) (resultErr error) {
	if !s.Supported() {
		return ErrUnsupported
	}
	s.mu.Lock()
	if s.active || s.blocked || s.pending != nil {
		s.mu.Unlock()
		return ErrBusy
	}
	s.active = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.active = false; s.mu.Unlock() }()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if err := t.Send(ctx, Event{Type: "waiting-for-start"}); err != nil {
		return err
	}
	first, err := t.Receive(ctx)
	if err != nil {
		return err
	}
	if first.Type != "start" {
		return errors.New("browser_start_required")
	}
	// Continue reading as soon as Start is received: leaving the page or close
	// must cancel compilation/startup, not wait until a native helper exists.
	commands := make(chan Command, 8)
	receiveDone := make(chan struct{})
	go func() {
		defer close(receiveDone)
		defer cancel()
		for {
			c, err := t.Receive(ctx)
			if err != nil || ctx.Err() != nil {
				return
			}
			if !validCommand(c) || c.Type == "close" {
				return
			}
			if c.Type == "start" {
				continue
			}
			select {
			case commands <- c:
			default:
				return
			}
		}
	}()
	defer func() { cancel(); <-receiveDone }()
	if err = t.Send(ctx, Event{Type: "starting"}); err != nil {
		return err
	}
	binary, cleanup, err := buildHelper(ctx)
	if err != nil {
		_ = t.Send(ctx, Event{Type: "error", Error: "browser_native_build_unavailable"})
		return surfaceFailure("browser_native_build_unavailable")
	}
	defer cleanup()
	if err = preflight(ctx, binary); err != nil {
		_ = t.Send(ctx, Event{Type: "error", Error: "browser_system_permission_required"})
		return errPermission
	}
	dir := dataDir
	if dir == "" {
		dir, err = s.sessionDir()
		if err != nil {
			return err
		}
	}
	host, err := accountbrowserhost.New(accountbrowserhost.Options{SessionDir: dir, Interactive: true, ProxyURL: proxyURL})
	if err != nil {
		return err
	}
	defer func() {
		stop, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if e := host.Shutdown(stop); e != nil {
			s.mu.Lock()
			s.blocked = true
			s.pending = host
			resultErr = surfaceFailure("browser_cleanup_required")
			s.mu.Unlock()
			_ = t.Send(ctx, Event{Type: "error", Error: "browser_cleanup_required"})
		}
	}()
	status, err := host.Start(ctx)
	if err != nil {
		return err
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return serveNative(ctx, binary, status.PID, commands, t)
}
