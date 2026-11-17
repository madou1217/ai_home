package distributionupdate

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

// Service has no automatic side effects at construction beyond private state
// initialization/recovery. The host explicitly runs Run(ctx) for background
// checks/ticks and calls Close at shutdown. Do not share a Service after Close.
type Service struct {
	options     Options
	current     CurrentInfo
	directory   string
	downloadDir string
	lifecycle   context.Context
	shutdown    context.CancelFunc
	closed      atomic.Bool
	runMu       sync.Mutex
	workerMu    sync.Mutex
	handoff     *fileLease // held until receipt, explicit failure, or process exit
	handoffAt   time.Time
}

func New(options Options) (*Service, error) {
	if options.Home == "" || options.PackageRoot == "" {
		return nil, fmt.Errorf("Home and PackageRoot are required")
	}
	var err error
	options.Home, err = filepath.Abs(options.Home)
	if err != nil {
		return nil, err
	}
	options.PackageRoot, err = filepath.Abs(options.PackageRoot)
	if err != nil {
		return nil, err
	}
	for _, item := range []struct {
		value *time.Duration
		def   time.Duration
	}{
		{&options.StartupDelay, 30 * time.Second}, {&options.CheckInterval, 6 * time.Hour},
		{&options.TickInterval, time.Minute}, {&options.DeferInterval, 5 * time.Minute},
		{&options.ReceiptTimeout, 30 * time.Minute},
	} {
		if *item.value < 0 {
			return nil, fmt.Errorf("update intervals must be positive")
		}
		if *item.value == 0 {
			*item.value = item.def
		}
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	current, err := readCurrent(options)
	if err != nil {
		return nil, err
	}
	lifecycle, shutdown := context.WithCancel(context.Background())
	s := &Service{
		options: options, current: current, lifecycle: lifecycle, shutdown: shutdown,
		directory: filepath.Join(options.Home, "run", "distribution-update"),
	}
	s.downloadDir = filepath.Join(options.Home, "updates", "downloads")
	if s.options.ReadReceipt == nil {
		s.options.ReadReceipt = s.readInstallerReceipt
	}
	if s.options.VerifyRuntime == nil {
		s.options.VerifyRuntime = s.verifyInstalledRuntime
	}
	root, err := privateRoot(s.directory, true)
	if err != nil {
		shutdown()
		return nil, err
	}
	root.Close()
	ctx, cancel := context.WithTimeout(lifecycle, 5*time.Second)
	defer cancel()
	if _, err := s.get(ctx); err != nil {
		shutdown()
		return nil, err
	}
	return s, nil
}

func (s *Service) now() time.Time { return s.options.Now().UTC() }

func (s *Service) operation(ctx context.Context) (context.Context, func(), error) {
	if s.closed.Load() {
		return nil, nil, ErrClosed
	}
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(s.lifecycle, cancel)
	return ctx, func() { stop(); cancel() }, nil
}

// Close stops Run and cancels this service's in-process callbacks. It does not
// cancel a queued/deferred appointment on disk, nor kill a detached executor.
// A subsequent service reconciles receipts instead of reapplying interrupted work.
func (s *Service) Close() error {
	if s.closed.Swap(true) {
		return nil
	}
	s.shutdown()
	s.workerMu.Lock()
	defer s.workerMu.Unlock()
	return s.releaseHandoff()
}

func (s *Service) releaseHandoff() error {
	if s.handoff == nil {
		return nil
	}
	err := s.handoff.Close()
	s.handoff = nil
	s.handoffAt = time.Time{}
	return err
}

func (s *Service) currentSnapshot() CurrentInfo {
	current := s.current
	if current.Build != nil {
		build := *current.Build
		current.Build = &build
	}
	return current
}
