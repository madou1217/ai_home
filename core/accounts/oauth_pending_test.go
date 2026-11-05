package accounts

import (
	"testing"
	"time"
)

func TestResolveOauthPendingState(t *testing.T) {
	now := time.UnixMilli(1_000_000).UTC()
	for _, tc := range []struct {
		name       string
		configured bool
		apiKeyMode bool
		authMode   string
		pending    bool
	}{
		{name: "oauth pending", authMode: "oauth", pending: true},
		{name: "browser pending", authMode: "oauth-browser", pending: true},
		{name: "configured", configured: true, authMode: "oauth"},
		{name: "api key", apiKeyMode: true, authMode: "oauth"},
		{name: "api-key mode", authMode: "api-key"},
		{name: "empty", authMode: ""},
	} {
		state := ResolveOauthPendingState(tc.configured, tc.apiKeyMode, tc.authMode, now.Add(-time.Minute), now, 0)
		if state.Pending != tc.pending {
			t.Fatalf("%s: pending = %v", tc.name, state.Pending)
		}
	}
}

func TestOauthPendingBecomesStale(t *testing.T) {
	now := time.UnixMilli(1_000_000).UTC()
	fresh := ResolveOauthPendingState(false, false, "oauth", now.Add(-time.Minute), now, 0)
	if fresh.Stale {
		t.Fatalf("1m old must not be stale")
	}
	old := ResolveOauthPendingState(false, false, "oauth", now.Add(-6*time.Minute), now, 0)
	if !old.Stale {
		t.Fatalf("6m old must be stale")
	}
}

func TestOauthJobDeadlinePrefersExplicitExpiry(t *testing.T) {
	created := time.UnixMilli(1_000_000).UTC()
	explicit := created.Add(2 * time.Hour)
	if got := ResolveOauthJobDeadline(created, "oauth-browser", explicit, 0); !got.Equal(explicit) {
		t.Fatalf("explicit expiry = %s", got)
	}
	if got := ResolveOauthJobDeadline(created, "oauth-browser", time.Time{}, 0); !got.Equal(created.Add(OauthBrowserJobTTL)) {
		t.Fatalf("browser ttl = %s", got)
	}
	if got := ResolveOauthJobDeadline(created, "oauth", time.Time{}, 0); !got.Equal(created.Add(OauthPendingFallbackStale)) {
		t.Fatalf("fallback ttl = %s", got)
	}
}
