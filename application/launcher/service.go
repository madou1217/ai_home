package launcher

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Service orchestrates application catalog lookup, ranking, launching, and usage recording.
type Service struct {
	catalog  Catalog
	launcher Launcher
	usage    UsageStore
	clock    func() time.Time

	usageErrMu     sync.RWMutex
	lastUsageError string
}

// NewService constructs a launcher application service.
func NewService(catalog Catalog, opener Launcher, usage UsageStore, clock func() time.Time) (*Service, error) {
	if catalog == nil || opener == nil {
		return nil, errors.New("launcher_service_dependencies_invalid")
	}
	if clock == nil {
		clock = time.Now
	}
	return &Service{
		catalog:  catalog,
		launcher: opener,
		usage:    usage,
		clock:    clock,
	}, nil
}

// List returns ranked installed applications matching opts.
func (s *Service) List(ctx context.Context, opts ListOptions) (ListResult, error) {
	if s == nil || s.catalog == nil {
		return ListResult{}, ErrUnavailable
	}
	snap, err := s.catalog.List(ctx, opts.Refresh)
	if err != nil {
		return ListResult{}, err
	}
	usageApps := s.loadUsageApps(ctx)
	query := TruncateRunes(opts.Query, MaxQueryRunes)
	ranked := Rank(snap.Apps, query, usageApps, s.clock())

	limit := opts.Limit
	if limit <= 0 || limit > MaxLimit {
		limit = DefaultLimit
	}
	truncated := false
	if len(ranked) > limit {
		ranked = ranked[:limit]
		truncated = true
	}
	if ranked == nil {
		ranked = []App{}
	}
	return ListResult{
		Platform:    snap.Platform,
		GeneratedAt: snap.GeneratedAt,
		Apps:        ranked,
		Truncated:   truncated,
	}, nil
}

// Open launches the application with the given ID and records usage on success.
func (s *Service) Open(ctx context.Context, id string) (App, error) {
	if s == nil || s.catalog == nil || s.launcher == nil {
		return App{}, ErrUnavailable
	}
	targetID := strings.TrimSpace(id)
	if targetID == "" {
		return App{}, ErrInvalidInput
	}
	snap, err := s.catalog.List(ctx, false)
	if err != nil {
		return App{}, err
	}
	var target App
	found := false
	for _, app := range snap.Apps {
		if app.ID == targetID {
			target = app
			found = true
			break
		}
	}
	if !found {
		return App{}, ErrNotFound
	}
	if err := s.launcher.Open(ctx, target); err != nil {
		return App{}, err
	}
	if s.usage != nil {
		if recErr := s.usage.RecordOpen(ctx, target.ID, s.clock().UnixMilli()); recErr != nil {
			s.setLastUsageError(fmt.Sprintf("usage record failed: %v", recErr))
		} else {
			s.setLastUsageError("")
		}
	}
	return target, nil
}

// ResolveSelector resolves an exact app ID, unique ID prefix, or 1-based `#N` index
// from the default ranked list.
func (s *Service) ResolveSelector(ctx context.Context, selector string) (App, error) {
	if s == nil || s.catalog == nil {
		return App{}, ErrUnavailable
	}
	raw := strings.TrimSpace(selector)
	if raw == "" {
		return App{}, ErrInvalidInput
	}
	if strings.HasPrefix(raw, "#") {
		idx, err := strconv.Atoi(strings.TrimPrefix(raw, "#"))
		if err != nil || idx <= 0 {
			return App{}, fmt.Errorf("%w: invalid index %q", ErrInvalidInput, raw)
		}
		listed, err := s.List(ctx, ListOptions{})
		if err != nil {
			return App{}, err
		}
		if idx > len(listed.Apps) {
			return App{}, ErrNotFound
		}
		return listed.Apps[idx-1], nil
	}

	snap, err := s.catalog.List(ctx, false)
	if err != nil {
		return App{}, err
	}
	var prefixMatches []App
	lowerRaw := strings.ToLower(raw)
	for _, app := range snap.Apps {
		if app.ID == raw || strings.EqualFold(app.ID, raw) {
			return app, nil
		}
		if len(lowerRaw) >= 4 && strings.HasPrefix(strings.ToLower(app.ID), lowerRaw) {
			prefixMatches = append(prefixMatches, app)
		}
	}
	if len(prefixMatches) == 1 {
		return prefixMatches[0], nil
	}
	if len(prefixMatches) > 1 {
		return App{}, fmt.Errorf("%w: ambiguous id prefix %q", ErrInvalidInput, raw)
	}
	return App{}, ErrNotFound
}

// Status returns catalog status, performing an initial scan if none has run yet.
func (s *Service) Status(ctx context.Context) Status {
	if s == nil || s.catalog == nil {
		return Status{LastError: ErrUnavailable.Error()}
	}
	snap := s.catalog.Status(ctx)
	if snap.GeneratedAt == 0 && snap.LastError == "" && snap.Supported {
		if listed, err := s.catalog.List(ctx, false); err == nil {
			snap = listed
		} else {
			snap = s.catalog.Status(ctx)
		}
	}
	lastError := snap.LastError
	if usageErr := s.getLastUsageError(); usageErr != "" {
		if lastError == "" {
			lastError = usageErr
		} else {
			lastError = lastError + "; " + usageErr
		}
	}
	return Status{
		Platform:    snap.Platform,
		Supported:   snap.Supported,
		Count:       len(snap.Apps),
		GeneratedAt: snap.GeneratedAt,
		LastError:   lastError,
	}
}

func (s *Service) setLastUsageError(msg string) {
	s.usageErrMu.Lock()
	s.lastUsageError = msg
	s.usageErrMu.Unlock()
}

func (s *Service) getLastUsageError() string {
	s.usageErrMu.RLock()
	defer s.usageErrMu.RUnlock()
	return s.lastUsageError
}

func (s *Service) loadUsageApps(ctx context.Context) map[string]UsageEntry {
	if s.usage == nil {
		return nil
	}
	snap, err := s.usage.Load(ctx)
	if err != nil {
		return nil
	}
	return snap.Apps
}
