// Package outboundproxy owns the process-wide upstream proxy pool.
//
// The pool is updated from config:server.proxyUrl at runtime: entries are
// comma/newline separated, requests rotate across healthy entries, and a proxy
// that cannot be dialed is skipped for a short cooldown. When the pool is empty
// the manager uses a direct transport, so clearing the setting means "no proxy"
// instead of silently falling back to an unrelated environment proxy.
package outboundproxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// DefaultFailureCooldown keeps a broken proxy out of rotation briefly.
	DefaultFailureCooldown = 30 * time.Second
	// DefaultWatchInterval is the config:server polling cadence for CLI writes.
	DefaultWatchInterval = 2 * time.Second
)

var (
	// baseHTTPTransport is captured before the process replaces DefaultTransport.
	baseHTTPTransport = func() *http.Transport {
		if transport, ok := http.DefaultTransport.(*http.Transport); ok && transport != nil {
			return transport.Clone()
		}
		return &http.Transport{Proxy: http.ProxyFromEnvironment}
	}()
)

// BaseTransport returns a clone of the standard transport without proxy
// selection. Callers that need a private transport should start here.
func BaseTransport() *http.Transport {
	return baseHTTPTransport.Clone()
}

// ProxyStatus is the credential-free view of one pool entry.
type ProxyStatus struct {
	Address        string `json:"address"`
	Healthy        bool   `json:"healthy"`
	UnhealthyUntil int64  `json:"unhealthyUntil,omitempty"`
	LastError      string `json:"lastError,omitempty"`
}

// Status is the credential-free view of the active pool.
type Status struct {
	ProxyURL string        `json:"proxyUrl"`
	Count    int           `json:"count"`
	Healthy  int           `json:"healthy"`
	Proxies  []ProxyStatus `json:"proxies"`
}

type proxyEntry struct {
	raw       string
	address   string
	transport *http.Transport

	mu             sync.Mutex
	unhealthyUntil time.Time
	lastError      string
}

func (entry *proxyEntry) available(now time.Time) bool {
	entry.mu.Lock()
	defer entry.mu.Unlock()
	return entry.unhealthyUntil.IsZero() || !now.Before(entry.unhealthyUntil)
}

func (entry *proxyEntry) markFailure(err error) {
	entry.mu.Lock()
	entry.unhealthyUntil = time.Now().Add(DefaultFailureCooldown)
	if err != nil {
		entry.lastError = err.Error()
	}
	entry.mu.Unlock()
}

func (entry *proxyEntry) markSuccess() {
	entry.mu.Lock()
	entry.unhealthyUntil = time.Time{}
	entry.lastError = ""
	entry.mu.Unlock()
}

func (entry *proxyEntry) status(now time.Time) ProxyStatus {
	entry.mu.Lock()
	defer entry.mu.Unlock()
	available := entry.unhealthyUntil.IsZero() || !now.Before(entry.unhealthyUntil)
	status := ProxyStatus{Address: entry.address, Healthy: available}
	if !available {
		status.UnhealthyUntil = entry.unhealthyUntil.UnixMilli()
		status.LastError = entry.lastError
	}
	return status
}

type snapshot struct {
	raw     string
	entries []*proxyEntry
	direct  *http.Transport
}

// Manager is an http.RoundTripper backed by a dynamically replaceable pool.
type Manager struct {
	mu       sync.Mutex
	snapshot atomic.Pointer[snapshot]
	next     atomic.Uint64
	closed   atomic.Bool
}

// NewManager creates a direct-only manager. Call Update to install a pool.
func NewManager() *Manager {
	manager := &Manager{}
	direct := BaseTransport()
	direct.Proxy = nil
	manager.snapshot.Store(&snapshot{direct: direct})
	return manager
}

// Update atomically replaces the pool. Invalid input leaves the old pool intact.
func (manager *Manager) Update(raw string) error {
	if manager == nil {
		return errors.New("outbound proxy manager is nil")
	}
	parsed, err := parseProxyList(raw)
	if err != nil {
		return err
	}
	next := &snapshot{raw: strings.TrimSpace(raw)}
	next.direct = BaseTransport()
	next.direct.Proxy = nil
	for _, item := range parsed {
		transport := BaseTransport()
		transport.Proxy = http.ProxyURL(item.proxyURL)
		next.entries = append(next.entries, &proxyEntry{
			raw:       item.raw,
			address:   item.display,
			transport: transport,
		})
	}

	manager.mu.Lock()
	previous := manager.snapshot.Swap(next)
	manager.mu.Unlock()
	if previous != nil {
		go closeSnapshot(previous)
	}
	return nil
}

// Count returns the number of configured proxies.
func (manager *Manager) Count() int {
	if manager == nil {
		return 0
	}
	snapshot := manager.snapshot.Load()
	if snapshot == nil {
		return 0
	}
	return len(snapshot.entries)
}

// Status returns a credential-free snapshot for diagnostics.
func (manager *Manager) Status() Status {
	if manager == nil {
		return Status{}
	}
	snapshot := manager.snapshot.Load()
	if snapshot == nil {
		return Status{}
	}
	now := time.Now()
	status := Status{ProxyURL: snapshot.raw, Count: len(snapshot.entries)}
	for _, entry := range snapshot.entries {
		item := entry.status(now)
		if item.Healthy {
			status.Healthy++
		}
		status.Proxies = append(status.Proxies, item)
	}
	return status
}

// RoundTrip routes one request through the pool.
func (manager *Manager) RoundTrip(request *http.Request) (*http.Response, error) {
	if manager == nil {
		return http.DefaultTransport.RoundTrip(request)
	}
	snapshot := manager.snapshot.Load()
	if snapshot == nil {
		direct := BaseTransport()
		direct.Proxy = nil
		return direct.RoundTrip(request)
	}
	if manager.closed.Load() {
		return snapshot.direct.RoundTrip(request)
	}
	if len(snapshot.entries) == 0 {
		return snapshot.direct.RoundTrip(request)
	}
	if request == nil || request.URL == nil {
		return nil, errors.New("outbound proxy: nil request")
	}

	now := time.Now()
	start := int(manager.next.Add(1)-1) % len(snapshot.entries)
	ordered := make([]*proxyEntry, 0, len(snapshot.entries))
	for pass := 0; pass < 2; pass++ {
		for offset := 0; offset < len(snapshot.entries); offset++ {
			entry := snapshot.entries[(start+offset)%len(snapshot.entries)]
			if (pass == 0) == entry.available(now) {
				ordered = append(ordered, entry)
			}
		}
	}

	var lastErr error
	for index, entry := range ordered {
		attempt := request
		if index > 0 {
			cloned, cloneErr := cloneForRetry(request)
			if cloneErr != nil {
				break
			}
			attempt = cloned
		}
		response, err := entry.transport.RoundTrip(attempt)
		if err == nil {
			entry.markSuccess()
			return response, nil
		}
		if request.Context().Err() != nil {
			return nil, err
		}
		if !isProxyConnectFailure(err) {
			return nil, err
		}
		entry.markFailure(err)
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("outbound proxy pool exhausted")
	}
	return nil, lastErr
}

// Close releases idle connections held by the pool.
func (manager *Manager) Close() error {
	if manager == nil || !manager.closed.CompareAndSwap(false, true) {
		return nil
	}
	manager.mu.Lock()
	snapshot := manager.snapshot.Load()
	manager.mu.Unlock()
	if snapshot != nil {
		closeSnapshot(snapshot)
	}
	return nil
}

func closeSnapshot(snapshot *snapshot) {
	if snapshot == nil {
		return
	}
	if snapshot.direct != nil {
		snapshot.direct.CloseIdleConnections()
	}
	for _, entry := range snapshot.entries {
		if entry.transport != nil {
			entry.transport.CloseIdleConnections()
		}
	}
}

func cloneForRetry(request *http.Request) (*http.Request, error) {
	if request.Body == nil || request.Body == http.NoBody {
		return request.Clone(request.Context()), nil
	}
	if request.GetBody == nil {
		return nil, errors.New("request body is not replayable")
	}
	body, err := request.GetBody()
	if err != nil {
		return nil, err
	}
	cloned := request.Clone(request.Context())
	cloned.Body = body
	return cloned, nil
}

func isProxyConnectFailure(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "proxyconnect") ||
		strings.Contains(message, "socks connect") ||
		strings.Contains(message, "proxy connect")
}

type parsedProxy struct {
	raw      string
	display  string
	proxyURL *url.URL
}

func parseProxyList(raw string) ([]parsedProxy, error) {
	fields := strings.FieldsFunc(raw, func(value rune) bool {
		switch value {
		case ',', ';', '\n', '\r', '\t', ' ':
			return true
		default:
			return false
		}
	})
	seen := make(map[string]struct{}, len(fields))
	result := make([]parsedProxy, 0, len(fields))
	for _, field := range fields {
		candidate := strings.TrimSpace(field)
		if candidate == "" {
			continue
		}
		parsed, err := url.Parse(candidate)
		if err != nil || parsed.Host == "" {
			return nil, fmt.Errorf("invalid proxy URL %q", candidate)
		}
		if parsed.User != nil {
			if _, hasPassword := parsed.User.Password(); !hasPassword && parsed.User.Username() == "" {
				return nil, fmt.Errorf("invalid proxy credentials in %q", candidate)
			}
		}
		switch strings.ToLower(parsed.Scheme) {
		case "http", "https":
		case "socks5", "socks5h":
			parsed.Scheme = "socks5"
		default:
			return nil, fmt.Errorf("unsupported proxy scheme %q", parsed.Scheme)
		}
		if parsed.Path != "" && parsed.Path != "/" {
			return nil, fmt.Errorf("proxy URL must not contain a path: %q", candidate)
		}
		if parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, fmt.Errorf("proxy URL must not contain query or fragment: %q", candidate)
		}
		key := parsed.String()
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, parsedProxy{
			raw:      candidate,
			display:  parsed.Scheme + "://" + parsed.Host,
			proxyURL: parsed,
		})
	}
	return result, nil
}

// Validate reports whether raw is a syntactically valid proxy pool.
func Validate(raw string) error {
	_, err := parseProxyList(raw)
	return err
}

// Watch polls config:server so CLI writes apply without a server restart.
func Watch(ctx context.Context, manager *Manager, aiHomeDir string, initialRaw string, interval time.Duration) {
	if manager == nil || strings.TrimSpace(aiHomeDir) == "" {
		return
	}
	if interval <= 0 {
		interval = DefaultWatchInterval
	}
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		log.Printf("outbound proxy watcher disabled: %v", err)
		return
	}
	last := strings.TrimSpace(initialRaw)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		raw, found, readErr := appstate.ReadKV(ctx, databasePath, "config:server")
		if readErr != nil || !found {
			continue
		}
		var stored struct {
			ProxyURL string `json:"proxyUrl"`
		}
		if json.Unmarshal([]byte(raw), &stored) != nil {
			continue
		}
		next := strings.TrimSpace(stored.ProxyURL)
		if next == last {
			continue
		}
		if updateErr := manager.Update(next); updateErr != nil {
			log.Printf("outbound proxy pool rejected: %v", updateErr)
			continue
		}
		last = next
		log.Printf("outbound proxy pool updated: %d proxies", manager.Count())
	}
}
