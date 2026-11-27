// Package appproxyserve provides temporary, per-selector local proxy entries
// for app launches.
//
// An app that asks for `us,jp,exclude:cn` or a specific node cannot share the
// single resident 6152 entry, because that entry has one upstream. This package
// owns a proxyserve.Pool: each selector gets its own local HTTP entry on an
// OS-assigned port, with the selector's own rotation/self-heal semantics.
package appproxyserve

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/appsessions"
	"github.com/madou1217/ai_home/internal/runtime/proxyendpoints"
	"github.com/madou1217/ai_home/internal/runtime/proxyregion"
	"github.com/madou1217/ai_home/internal/runtime/proxyserve"
)

// Entry is the launch-facing view of one temporary proxy entry.
type Entry struct {
	URL      string `json:"url"`
	Name     string `json:"name,omitempty"`
	Selector string `json:"selector"`
	Country  string `json:"country,omitempty"`
	CityCode string `json:"cityCode,omitempty"`
	Region   string `json:"region,omitempty"`
	PID      int    `json:"pid,omitempty"`
}

// Provider wraps a proxy entry pool.
type Provider struct {
	pool      *proxyserve.Pool
	aiHomeDir string
}

// New creates a provider that will start `aih proxy serve` children.
func New(options proxyserve.Options) *Provider {
	return &Provider{pool: proxyserve.NewPool(options), aiHomeDir: options.AIHomeDir}
}

// NewWithPool wraps an existing pool (the server shares one across launches).
func NewWithPool(pool *proxyserve.Pool, aiHomeDir string) *Provider {
	return &Provider{pool: pool, aiHomeDir: aiHomeDir}
}

// Ensure returns a live entry for selector, starting it on a random port if
// this is the first app using that selection.
func (provider *Provider) Ensure(ctx context.Context, selector string) (Entry, error) {
	selector = strings.TrimSpace(selector)
	if provider == nil || provider.pool == nil {
		return Entry{}, proxyserve.ErrStartFailed
	}
	view, err := provider.pool.Ensure(ctx, selector)
	if err != nil {
		return Entry{}, err
	}
	return entryFor(selector, view), nil
}

// Restore runs after a server start: every active app whose temporary proxy
// entry died is restarted on the port recorded in its launch. Server restarts
// must not leave already-open browsers without an upstream.
func (provider *Provider) Restore(ctx context.Context, aiHomeDir string) {
	if provider == nil || provider.pool == nil || strings.TrimSpace(aiHomeDir) == "" {
		return
	}
	store := appsessions.New(aiHomeDir)
	instances, err := store.List(ctx)
	if err != nil {
		return
	}
	for _, instance := range instances {
		if !instance.Proxied || !instance.ActiveNow() || strings.TrimSpace(instance.ProxyURL) == "" {
			continue
		}
		selector := strings.TrimSpace(instance.ProxySelector)
		if selector == "" {
			if info, ok := proxyendpoints.Lookup(aiHomeDir, instance.ProxyURL); ok {
				selector = strings.TrimSpace(info.Selector)
			}
		}
		switch strings.ToLower(selector) {
		case "", "auto", "pool":
			continue
		}
		port := proxyPort(instance.ProxyURL)
		if port <= 0 || endpointAlive(instance.ProxyURL) {
			continue
		}
		entry, ensureErr := provider.EnsureOnPort(ctx, selector, port)
		if ensureErr != nil {
			continue
		}
		_ = store.SetProxyEntry(ctx, instance.ID, appsessions.ProxyEntry{
			URL:      entry.URL,
			Selector: selector,
			Country:  entry.Country,
			City:     entry.CityCode,
			Region:   entry.Region,
			PID:      entry.PID,
		})
	}
}

func proxyPort(rawURL string) int {
	endpoint, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || endpoint == nil || endpoint.Port() == "" {
		return 0
	}
	port := 0
	_, _ = fmt.Sscanf(endpoint.Port(), "%d", &port)
	return port
}

func endpointAlive(rawURL string) bool {
	endpoint, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || endpoint == nil || endpoint.Host == "" {
		return false
	}
	connection, err := net.DialTimeout("tcp", endpoint.Host, 300*time.Millisecond)
	if err != nil {
		return false
	}
	_ = connection.Close()
	return true
}

// RestartOnPort force-replaces the entry on the app's existing port.
func (provider *Provider) RestartOnPort(ctx context.Context, selector string, port int) (Entry, error) {
	selector = strings.TrimSpace(selector)
	if provider == nil || provider.pool == nil {
		return Entry{}, proxyserve.ErrStartFailed
	}
	view, err := provider.pool.RestartOnPort(ctx, selector, port)
	if err == nil {
		return entryFor(selector, view), nil
	}
	// The entry may belong to a process this server does not own (for example
	// a 6156 launched from a terminal). If its port is still served and the
	// published metadata is present, leave it alone and report it as running.
	proxyURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	if info, ok := proxyendpoints.Lookup(provider.aiHomeDir, proxyURL); ok && endpointAlive(proxyURL) {
		return Entry{
			URL:      info.HTTPURL,
			Name:     info.Name,
			Selector: firstNonEmpty(info.Selector, selector),
			Country:  info.Country,
			CityCode: info.CityCode,
			Region:   info.Region,
			PID:      info.PID,
		}, nil
	}
	return Entry{}, err
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// EnsureOnPort restarts the entry on the port the running app already uses.
func (provider *Provider) EnsureOnPort(ctx context.Context, selector string, port int) (Entry, error) {
	selector = strings.TrimSpace(selector)
	if provider == nil || provider.pool == nil {
		return Entry{}, proxyserve.ErrStartFailed
	}
	view, err := provider.pool.EnsureOnPort(ctx, selector, port)
	if err != nil {
		return Entry{}, err
	}
	return entryFor(selector, view), nil
}

func entryFor(selector string, view proxyserve.View) Entry {
	country, cityCode := proxyregion.ParseNodeLabel(view.Name)
	return Entry{
		URL:      view.HTTPURL,
		Name:     view.Name,
		Selector: selector,
		Country:  country,
		CityCode: cityCode,
		Region:   proxyregion.RegionLabel(country, cityCode),
		PID:      view.PID,
	}
}

// Stop terminates the entry for selector.
func (provider *Provider) Stop(selector string) {
	if provider == nil || provider.pool == nil {
		return
	}
	provider.pool.Stop(selector)
}

// StopAll terminates every temporary entry owned by this provider.
func (provider *Provider) StopAll() {
	if provider == nil || provider.pool == nil {
		return
	}
	provider.pool.StopAll()
}
