// Package launcher owns the AIH Launch application domain: model, ranking, usage, and orchestration.
package launcher

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"unicode"
)

const (
	// MaxNameRunes bounds an application's display name length.
	MaxNameRunes = 120
	// MaxSubtitleRunes bounds an application's subtitle length.
	MaxSubtitleRunes = 160
	// MaxAliases caps the number of alternate search names per app.
	MaxAliases = 4
	// MaxQueryRunes caps search query length for API and ranker safety.
	MaxQueryRunes = 256
	// DefaultLimit is the default and maximum number of apps returned by List (§5).
	DefaultLimit = 2000
	// MaxLimit caps the limit parameter accepted by List and management API.
	MaxLimit = DefaultLimit

	// UsageVersion is the on-disk schema version for usage.json.
	UsageVersion = 1
	// MaxUsageEntries caps persisted usage records (most recently opened kept).
	MaxUsageEntries = 500
)

var (
	ErrNotFound     = errors.New("launcher_app_not_found")
	ErrInvalidInput = errors.New("launcher_invalid_input")
	ErrUnsupported  = errors.New("launcher_unsupported")
	ErrUnavailable  = errors.New("launcher_unavailable")
)

// Kind identifies the platform packaging source of an installed application.
type Kind string

const (
	KindApp     Kind = "app"
	KindUWP     Kind = "uwp"
	KindFlatpak Kind = "flatpak"
	KindSnap    Kind = "snap"
	KindDesktop Kind = "desktop"
)

// App describes an installed desktop application exposed by AIH Launch.
type App struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Subtitle string   `json:"subtitle"`
	Path     string   `json:"path"`
	Kind     Kind     `json:"kind"`
	Icon     string   `json:"icon"`
	Terminal bool     `json:"terminal"`
	Aliases  []string `json:"aliases,omitempty"`

	// Platform-internal launch metadata omitted from wire JSON.
	DesktopID string `json:"-"`
	Exec      string `json:"-"`
}

// UsageEntry tracks open recency and frequency for a single app ID.
type UsageEntry struct {
	OpenedAtMs int64 `json:"openedAtMs"`
	Count      int   `json:"count"`
}

// UsageSnapshot is the persisted usage document schema.
type UsageSnapshot struct {
	Version int                   `json:"version"`
	Apps    map[string]UsageEntry `json:"apps"`
}

// CatalogSnapshot captures a point-in-time platform application scan.
type CatalogSnapshot struct {
	Platform    string
	Supported   bool
	GeneratedAt int64
	Apps        []App
	LastError   string
}

// ListOptions controls application listing, filtering, and catalog refresh.
type ListOptions struct {
	Query   string
	Refresh bool
	Limit   int
}

// ListResult is the ranked application list returned by management API and CLI.
type ListResult struct {
	Platform    string `json:"platform"`
	GeneratedAt int64  `json:"generatedAt"`
	Apps        []App  `json:"apps"`
	Truncated   bool   `json:"truncated"`
}

// Status reports launcher catalog health and readiness.
type Status struct {
	Platform    string `json:"platform"`
	Supported   bool   `json:"supported"`
	Count       int    `json:"count"`
	GeneratedAt int64  `json:"generatedAt"`
	LastError   string `json:"lastError"`
}

// AppID computes the stable deterministic ID: first 16 bytes of sha256(platform + "\x00" + sourceKey) as hex.
func AppID(platform, sourceKey string) string {
	sum := sha256.Sum256([]byte(platform + "\x00" + sourceKey))
	return hex.EncodeToString(sum[:16])
}

// NormalizeApp trims control whitespace and enforces name/subtitle/alias length caps.
func NormalizeApp(app App) App {
	app.ID = strings.TrimSpace(app.ID)
	app.Name = TruncateRunes(sanitizeInlineText(app.Name), MaxNameRunes)
	app.Subtitle = TruncateRunes(sanitizeInlineText(app.Subtitle), MaxSubtitleRunes)
	app.Path = strings.TrimSpace(app.Path)
	app.Icon = strings.TrimSpace(app.Icon)
	app.DesktopID = strings.TrimSpace(app.DesktopID)
	app.Exec = strings.TrimSpace(app.Exec)
	app.Aliases = normalizeAliases(app.Name, app.Aliases)
	return app
}

func normalizeAliases(name string, raw []string) []string {
	if len(raw) == 0 {
		return nil
	}
	nameKey := strings.ToLower(strings.TrimSpace(name))
	seen := make(map[string]struct{}, len(raw)+1)
	if nameKey != "" {
		seen[nameKey] = struct{}{}
	}
	out := make([]string, 0, min(len(raw), MaxAliases))
	for _, entry := range raw {
		clean := TruncateRunes(sanitizeInlineText(entry), MaxNameRunes)
		if clean == "" {
			continue
		}
		key := strings.ToLower(clean)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, clean)
		if len(out) >= MaxAliases {
			break
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// TruncateRunes caps s to at most maxRunes Unicode code points.
func TruncateRunes(s string, maxRunes int) string {
	if maxRunes <= 0 {
		return ""
	}
	runes := []rune(s)
	if len(runes) <= maxRunes {
		return s
	}
	return string(runes[:maxRunes])
}

func sanitizeInlineText(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(s))
	prevSpace := false
	for _, r := range s {
		if r == '\r' || r == '\n' || r == '\t' || unicode.IsControl(r) {
			if !prevSpace {
				b.WriteByte(' ')
				prevSpace = true
			}
			continue
		}
		if r == ' ' {
			if prevSpace {
				continue
			}
			prevSpace = true
		} else {
			prevSpace = false
		}
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}
