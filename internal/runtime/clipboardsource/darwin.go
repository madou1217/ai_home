//go:build darwin

package clipboardsource

import (
	"context"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// darwinResolver uses LaunchServices through `lsappinfo`, which works without
// the Accessibility permission that System Events would require.
type darwinResolver struct {
	mu      sync.Mutex
	cached  App
	expires time.Time
}

func New() Resolver { return &darwinResolver{} }

func (r *darwinResolver) Frontmost(ctx context.Context) (App, bool) {
	r.mu.Lock()
	if time.Now().Before(r.expires) && r.cached.DisplayName() != "" {
		cached := r.cached
		r.mu.Unlock()
		return cached, true
	}
	r.mu.Unlock()

	app, ok := r.query(ctx)
	if !ok {
		return App{}, false
	}
	r.mu.Lock()
	r.cached = app
	r.expires = time.Now().Add(time.Second)
	r.mu.Unlock()
	return app, true
}

func (r *darwinResolver) query(parent context.Context) (App, bool) {
	ctx, cancel := withTimeout(parent)
	defer cancel()
	front := exec.CommandContext(ctx, "/usr/bin/lsappinfo", "front")
	out, err := front.Output()
	if err != nil {
		return App{}, false
	}
	asn := strings.TrimSpace(string(out))
	if !strings.HasPrefix(asn, "ASN:") {
		return App{}, false
	}

	infoCtx, infoCancel := withTimeout(parent)
	defer infoCancel()
	info := exec.CommandContext(infoCtx, "/usr/bin/lsappinfo", "info", "-only", "name", "-only", "bundleid", asn)
	raw, err := info.Output()
	if err != nil {
		return App{Name: asn}, false
	}
	text := string(raw)
	return App{
		Name:     quotedValue(text, "name"),
		BundleID: quotedValue(text, "bundleID"),
	}, true
}

// quotedValue extracts the first key="value" occurrence from lsappinfo output.
func quotedValue(text, key string) string {
	marker := key + "=\""
	idx := strings.Index(text, marker)
	if idx < 0 {
		return ""
	}
	rest := text[idx+len(marker):]
	end := strings.IndexByte(rest, '"')
	if end < 0 {
		return ""
	}
	return rest[:end]
}
