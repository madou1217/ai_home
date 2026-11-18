// Package proxypoollease owns an isolated mihomo process for one selected pool
// node. It never reads or changes the shared pool's selection or runtime state.
package proxypoollease

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/egress"
)

const (
	maxStartAttempts = 4
	stopGrace        = 2 * time.Second
)

var errPortCollision = errors.New("proxy_pool_lease_port_collision")

// Runtime belongs to a single task. Close is safe to call concurrently and more
// than once; cancelling the context supplied to Start also closes the runtime.
type Runtime struct {
	proxyURL  string
	dir       string
	process   *os.Process
	exited    chan struct{}
	collision <-chan struct{}
	closing   chan struct{}
	once      sync.Once
	closeErr  error
}

// Available only resolves an existing core; it does not start or download one.
func Available(aiHome string) bool {
	core, err := egress.ResolveMihomoCorePath(egress.CoreResolverOptions{AIHomeDir: aiHome})
	return err == nil && core != nil && core.Path != ""
}

// Start renders exactly node and starts a task-owned, loopback-only core. The
// caller must keep ctx alive for the lease's lifetime, not just acquisition.
func Start(ctx context.Context, aiHome string, node egress.ProxyNode) (*Runtime, error) {
	if ctx == nil {
		return nil, errors.New("proxy_pool_lease_context_required")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(aiHome) == "" {
		return nil, errors.New("proxy_pool_lease_home_required")
	}
	home, err := filepath.Abs(aiHome)
	if err != nil {
		return nil, errors.New("proxy_pool_lease_home_invalid")
	}
	core, err := egress.ResolveMihomoCorePath(egress.CoreResolverOptions{AIHomeDir: home})
	if err != nil || core == nil || core.Path == "" {
		return nil, errors.New("proxy_pool_lease_core_unavailable")
	}
	corePath, err := filepath.Abs(core.Path)
	if err != nil {
		return nil, errors.New("proxy_pool_lease_core_unavailable")
	}
	runDir := filepath.Join(home, "run")
	if err := os.MkdirAll(runDir, 0700); err != nil {
		return nil, errors.New("proxy_pool_lease_run_directory_unavailable")
	}

	startupCtx, cancel := context.WithTimeout(ctx, egress.DefaultStartupTimeout)
	defer cancel()
	for attempt := 0; attempt < maxStartAttempts; attempt++ {
		if err := startupCtx.Err(); err != nil {
			return nil, err
		}
		runtime, err := startAttempt(startupCtx, runDir, corePath, node)
		if err != nil {
			if errors.Is(err, errPortCollision) {
				continue
			}
			return nil, err
		}
		if err := startupCtx.Err(); err != nil {
			return nil, errors.Join(err, runtime.Close())
		}
		go func() {
			select {
			case <-ctx.Done():
			case <-runtime.exited:
			case <-runtime.collision:
			case <-runtime.closing:
			}
			_ = runtime.Close()
		}()
		return runtime, nil
	}
	return nil, errPortCollision
}

func startAttempt(ctx context.Context, runDir, corePath string, node egress.ProxyNode) (_ *Runtime, err error) {
	ports, err := reservePorts()
	if err != nil {
		return nil, err
	}
	defer ports.close()
	dir, err := os.MkdirTemp(runDir, "proxy-pool-lease-")
	if err != nil {
		return nil, errors.New("proxy_pool_lease_directory_unavailable")
	}
	runtime := &Runtime{dir: dir, exited: make(chan struct{}), closing: make(chan struct{})}
	defer func() {
		if err != nil {
			if closeErr := runtime.Close(); closeErr != nil {
				// Never retry while cleanup of a previous attempt is incomplete.
				err = closeErr
			}
		}
	}()
	configPath, controlSecret, proxyToken, err := writeConfig(dir, ports, node)
	if err != nil {
		return nil, err
	}
	runtime.proxyURL = "http://aih:" + proxyToken + "@" + ports.proxyAddress()
	output := newCoreOutput()
	runtime.collision = output.collision
	cmd := exec.Command(corePath, "-d", dir, "-f", configPath)
	cmd.Dir = dir
	cmd.Stdout = output
	cmd.Stderr = output
	cmd.WaitDelay = stopGrace
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// mihomo does not accept inherited listener FDs. Keep both TCP listeners
	// (and mixed-port UDP) reserved until the last moment, then authenticate
	// both endpoints and classify bind races rather than trusting an open port.
	ports.close()
	if err := cmd.Start(); err != nil {
		return nil, errors.New("proxy_pool_lease_core_start_failed")
	}
	runtime.process = cmd.Process
	go func() {
		_ = cmd.Wait() // Never retain or expose the core's raw error/output.
		close(runtime.exited)
	}()
	if err := waitReady(ctx, runtime, ports, controlSecret, proxyToken, output); err != nil {
		return nil, err
	}
	return runtime, nil
}

// ProxyURL is empty after closure or process exit, so a dead lease cannot be
// mistaken for a reusable global proxy endpoint.
func (r *Runtime) ProxyURL() string {
	if r == nil {
		return ""
	}
	select {
	case <-r.closing:
		return ""
	case <-r.exited:
		return ""
	case <-r.collision:
		return ""
	default:
		return r.proxyURL
	}
}

// Close only signals the process handle created by this lease. It never looks
// up a PID, kills a process group, or removes any shared pool files.
func (r *Runtime) Close() error {
	if r == nil {
		return nil
	}
	r.once.Do(func() {
		close(r.closing)
		if r.process != nil {
			r.closeErr = r.stop()
		}
		if err := os.RemoveAll(r.dir); err != nil {
			r.closeErr = errors.Join(r.closeErr, errors.New("proxy_pool_lease_cleanup_failed"))
		}
	})
	return r.closeErr
}

func (r *Runtime) stop() error {
	select {
	case <-r.exited:
		return nil
	default:
	}
	if err := r.process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
		// Platforms without SIGTERM support go straight to killing this child.
		_ = r.process.Kill()
	}
	timer := time.NewTimer(stopGrace)
	defer timer.Stop()
	select {
	case <-r.exited:
		return nil
	case <-timer.C:
	}
	_ = r.process.Kill()
	timer.Reset(stopGrace)
	select {
	case <-r.exited:
		return nil
	case <-timer.C:
		return errors.New("proxy_pool_lease_core_stop_timeout")
	}
}
