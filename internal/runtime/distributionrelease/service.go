// Package distributionrelease checks and downloads AI Home distribution releases.
// It never schedules, executes, extracts, or installs an artifact. Its contract
// is scripts/package/build-release.js and .github/workflows/release-artifacts.yml.
package distributionrelease

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"
)

const (
	DefaultRepository = "madou1217/ai_home"
	MaxArtifactBytes  = int64(2 << 30)
	checkTimeout      = time.Minute
	downloadTimeout   = 15 * time.Minute
)

var (
	ErrInvalidRelease     = errors.New("invalid distribution release")
	ErrNoUpdate           = errors.New("no newer stable distribution release")
	ErrDownloadInProgress = errors.New("distribution download already in progress")
)

// Options are trusted composition settings, not public HTTP request fields.
// Repository may be empty or DefaultRepository; custom repositories are rejected.
// HTTPClient is optional. Its cookie jar and redirect policy are not inherited.
// CacheFile optionally stores a private, ten-minute hint cache without URLs,
// headers, release notes, credentials, or HTTP response bodies. Cache failures
// do not prevent an online check; Download never trusts this cache.
type Options struct {
	CurrentVersion string
	Target         string // scripts/package/targets.js key, e.g. darwin-arm64
	Repository     string
	HTTPClient     *http.Client
	CacheFile      string
}

type ArtifactInfo struct {
	File   string `json:"file"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

// ReleaseInfo is a displayable hint, not download authority. There is deliberately
// no download URL field. Available is false for equal/older stable releases;
// Artifact is populated only for a newer, validated single-file release.
type ReleaseInfo struct {
	Repository     string       `json:"repository"`
	CurrentVersion string       `json:"currentVersion"`
	Version        string       `json:"version"`
	Target         string       `json:"target"`
	Tag            string       `json:"tag"`
	Available      bool         `json:"available"`
	PublishedAt    time.Time    `json:"publishedAt"`
	CheckedAt      time.Time    `json:"checkedAt"`
	Artifact       ArtifactInfo `json:"artifact"`
}

// Service is safe for concurrent use; downloads into one directory are serialized
// by an exclusive per-artifact .partial file, not by scheduler state.
type Service struct {
	current   version
	target    string
	client    *http.Client
	cacheFile string
}

func New(options Options) (*Service, error) {
	current, err := parseVersion(options.CurrentVersion, true)
	if err != nil {
		return nil, fmt.Errorf("current version: %w", err)
	}
	if options.Repository != "" && options.Repository != DefaultRepository {
		return nil, fmt.Errorf("distribution releases require repository %s", DefaultRepository)
	}
	if !validTarget(options.Target) {
		return nil, fmt.Errorf("unsupported distribution target %q", options.Target)
	}
	return &Service{
		current: current, target: options.Target,
		client: releaseHTTPClient(options.HTTPClient), cacheFile: options.CacheFile,
	}, nil
}

// Check returns the latest stable release. Without CacheFile it performs no disk
// writes. Errors never fall back to stale cached success. CurrentVersion comes
// from the caller's installed package version, not a second version registry.
func (s *Service) Check(ctx context.Context) (ReleaseInfo, error) {
	if err := ctx.Err(); err != nil {
		return ReleaseInfo{}, err
	}
	if info, ok := s.readCache(); ok {
		return info, nil
	}
	ctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	release, err := s.fetchRelease(ctx, "latest")
	if err != nil {
		return ReleaseInfo{}, err
	}
	info, err := s.releaseInfo(release)
	if err != nil {
		return ReleaseInfo{}, err
	}
	if info.Available {
		info.Artifact, err = s.fetchArtifactInfo(ctx, release, info.Version)
		if err != nil {
			return ReleaseInfo{}, err
		}
	}
	info.CheckedAt = time.Now().UTC()
	s.writeCache(info)
	return info, nil
}

func (s *Service) releaseInfo(release githubRelease) (ReleaseInfo, error) {
	if release.Draft == nil || release.Prerelease == nil || *release.Draft || *release.Prerelease || release.PublishedAt.IsZero() {
		return ReleaseInfo{}, fmt.Errorf("%w: only published stable releases are accepted", ErrInvalidRelease)
	}
	if len(release.Tag) < 2 || release.Tag[0] != 'v' {
		return ReleaseInfo{}, fmt.Errorf("%w: expected a v<version> tag", ErrInvalidRelease)
	}
	v, err := parseVersion(release.Tag[1:], false)
	if err != nil || v.prerelease != "" {
		return ReleaseInfo{}, fmt.Errorf("%w: release tag must be stable semver", ErrInvalidRelease)
	}
	return ReleaseInfo{
		Repository: DefaultRepository, CurrentVersion: s.current.text,
		Version: v.text, Target: s.target, Tag: release.Tag,
		Available: newerStable(v, s.current), PublishedAt: release.PublishedAt.UTC(),
	}, nil
}

func validTarget(target string) bool {
	// Exactly the targetKey values in scripts/package/targets.js (not GOOS/GOARCH).
	switch target {
	case "darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64", "win32-arm64":
		return true
	}
	return false
}

func artifactName(version, target string) string {
	extension := ".run"
	if target == "win32-x64" || target == "win32-arm64" {
		extension = ".exe"
	}
	return "aih-" + version + "-" + target + extension
}
