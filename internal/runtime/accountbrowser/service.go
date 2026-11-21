package accountbrowser

import (
	"context"
	"fmt"
	"sync"
)

// Host abstracts an attached browser runtime host. The dataDir passed to Open
// is a validated absolute directory path scoped to Profile and is strictly
// internal (never exposed over HTTP). Close must be idempotent and must not
// delete durable profile data.
type Host interface {
	Open(ctx context.Context, profile Profile, dataDir string) error
	Close(ctx context.Context, profile Profile) error
}

// Options configures a Stage 1 account browser foundation Service.
type Options struct {
	AIHomeDir string
	Host      Host
}

// Service manages durable account-scoped browser profile registrations and
// delegates lifecycle calls to an optional single attached Host.
type Service struct {
	store         *profileStore
	host          Host
	registryLocks *keyedLocker
	hostLocks     *keyedLocker
}

// NewService constructs a Service without performing any filesystem writes.
// Disk access is deferred until Get or Ensure/Open is called.
func NewService(options Options) (*Service, error) {
	aiHomeDir, err := validateAIHomeDir(options.AIHomeDir)
	if err != nil {
		return nil, err
	}
	return &Service{
		store:         &profileStore{aiHomeDir: aiHomeDir},
		host:          options.Host,
		registryLocks: newKeyedLocker(),
		hostLocks:     newKeyedLocker(),
	}, nil
}

// HostAvailable reports whether a concrete Host runtime is attached.
func (s *Service) HostAvailable() bool {
	return s != nil && s.host != nil
}

// Ensure idempotently creates or validates the durable profile registry and
// private data directory for identity. The boolean return reports whether this
// call published the profile metadata for the first time.
func (s *Service) Ensure(ctx context.Context, identity Identity) (Profile, bool, error) {
	profile, _, created, err := s.ensureWithDataDir(ctx, identity)
	return profile, created, err
}

// EnsureDataDir ensures the durable profile and returns its private data
// directory for an attached runtime. The path stays inside the runtime
// boundary and is never serialized into an HTTP response.
func (s *Service) EnsureDataDir(ctx context.Context, identity Identity) (Profile, string, bool, error) {
	return s.ensureWithDataDir(ctx, identity)
}

func (s *Service) ensureWithDataDir(ctx context.Context, identity Identity) (Profile, string, bool, error) {
	if s == nil || s.store == nil {
		return Profile{}, "", false, fmt.Errorf("service is not initialized: %w", ErrUnsafePath)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return Profile{}, "", false, err
	}
	if err := identity.Validate(); err != nil {
		return Profile{}, "", false, err
	}

	profileID := deriveProfileID(identity)
	unlock, err := s.registryLocks.acquire(ctx, profileID)
	if err != nil {
		return Profile{}, "", false, err
	}
	defer unlock()

	return s.store.ensure(ctx, identity)
}

// Get reads and validates an existing profile registration without creating or
// mutating any filesystem state. Missing profiles return ErrProfileNotFound.
func (s *Service) Get(ctx context.Context, identity Identity) (Profile, error) {
	if s == nil || s.store == nil {
		return Profile{}, fmt.Errorf("service is not initialized: %w", ErrUnsafePath)
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return Profile{}, err
	}
	if err := identity.Validate(); err != nil {
		return Profile{}, err
	}
	return s.store.get(ctx, identity)
}

// Open ensures the durable profile exists and then invokes the attached Host
// with the validated private data directory. If no Host is attached, Open
// returns ErrHostUnavailable without fabricating an open state. Registry locks
// are released before invoking Host.Open.
func (s *Service) Open(ctx context.Context, identity Identity) (Profile, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	profile, dataDir, _, err := s.ensureWithDataDir(ctx, identity)
	if err != nil {
		return Profile{}, err
	}
	if s.host == nil {
		return Profile{}, ErrHostUnavailable
	}

	unlock, err := s.hostLocks.acquire(ctx, profile.ID)
	if err != nil {
		return Profile{}, err
	}
	defer unlock()

	if err := ctx.Err(); err != nil {
		return Profile{}, err
	}
	if err := s.host.Open(ctx, profile, dataDir); err != nil {
		return Profile{}, err
	}
	return profile, nil
}

// Close looks up an existing profile without creating one and invokes
// Host.Close when a Host is attached; when no Host is attached, Close succeeds
// idempotently without removing or clearing durable profile storage.
func (s *Service) Close(ctx context.Context, identity Identity) (Profile, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	profile, err := s.Get(ctx, identity)
	if err != nil {
		return Profile{}, err
	}
	if s.host == nil {
		return profile, nil
	}

	unlock, err := s.hostLocks.acquire(ctx, profile.ID)
	if err != nil {
		return Profile{}, err
	}
	defer unlock()

	if err := ctx.Err(); err != nil {
		return Profile{}, err
	}
	if err := s.host.Close(ctx, profile); err != nil {
		return Profile{}, err
	}
	return profile, nil
}

type keyedLockEntry struct {
	ch   chan struct{}
	refs int
}

// keyedLocker provides context-cancellable per-profile synchronization without
// holding a global lock across filesystem or Host I/O.
type keyedLocker struct {
	mu      sync.Mutex
	entries map[string]*keyedLockEntry
}

func newKeyedLocker() *keyedLocker {
	return &keyedLocker{entries: make(map[string]*keyedLockEntry)}
}

func (l *keyedLocker) acquire(ctx context.Context, key string) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	l.mu.Lock()
	entry, ok := l.entries[key]
	if !ok {
		entry = &keyedLockEntry{ch: make(chan struct{}, 1)}
		l.entries[key] = entry
	}
	entry.refs++
	l.mu.Unlock()

	select {
	case entry.ch <- struct{}{}:
		var once sync.Once
		return func() {
			once.Do(func() {
				<-entry.ch
				l.releaseRef(key, entry)
			})
		}, nil
	case <-ctx.Done():
		l.releaseRef(key, entry)
		return nil, ctx.Err()
	}
}

func (l *keyedLocker) releaseRef(key string, entry *keyedLockEntry) {
	l.mu.Lock()
	entry.refs--
	if entry.refs == 0 && l.entries[key] == entry {
		delete(l.entries, key)
	}
	l.mu.Unlock()
}
