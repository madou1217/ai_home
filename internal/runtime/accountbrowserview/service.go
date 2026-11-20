package accountbrowserview

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/accountbrowserhost"
)

var errPermission = errors.New("browser_system_permission_required")

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
		return errors.New("browser_native_build_unavailable")
	}
	defer cleanup()
	if err = preflight(ctx, binary); err != nil {
		_ = t.Send(ctx, Event{Type: "error", Error: "browser_system_permission_required"})
		return errPermission
	}
	dir, err := s.sessionDir()
	if err != nil {
		return err
	}
	host, err := accountbrowserhost.New(accountbrowserhost.Options{SessionDir: dir, Interactive: true})
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
			resultErr = errors.New("browser_cleanup_required")
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
	command := exec.CommandContext(ctx, binary, strconv.Itoa(status.PID))
	output, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	input, err := command.StdinPipe()
	if err != nil {
		return err
	}
	if err = command.Start(); err != nil {
		return errors.New("browser_native_helper_unavailable")
	}
	done := make(chan struct{})
	go func() { _ = command.Wait(); close(done) }()
	defer func() {
		_ = input.Close()
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = command.Process.Kill()
			<-done
		}
	}()
	frames := make(chan Event, 1)
	events := make(chan Event, 4)
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		scan := bufio.NewScanner(output)
		scan.Buffer(make([]byte, 65536), 2*1024*1024)
		for scan.Scan() {
			e, decodeErr := decodeEvent(scan.Bytes())
			if decodeErr != nil {
				continue
			}
			if e.Type != "frame" && e.Type != "ready" && e.Type != "error" {
				continue
			}
			if e.Type == "frame" {
				select {
				case frames <- e:
				default:
					select {
					case <-frames:
					default:
					}
					select {
					case frames <- e:
					default:
					}
				}
			} else {
				select {
				case events <- e:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	errCh := make(chan error, 2)
	go func() {
		for {
			var e Event
			select {
			case <-ctx.Done():
				return
			case <-readDone:
				errCh <- errors.New("browser_native_helper_stopped")
				return
			case e = <-events:
			case e = <-frames:
			}
			if err := t.Send(ctx, e); err != nil {
				errCh <- err
				return
			}
		}
	}()
	go func() {
		enc := json.NewEncoder(input)
		for {
			var c Command
			select {
			case <-ctx.Done():
				return
			case c = <-commands:
			}
			if ctx.Err() != nil {
				return
			}
			if err := enc.Encode(c); err != nil {
				errCh <- err
				return
			}
		}
	}()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err = <-errCh:
		return err
	}
}
