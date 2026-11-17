package distributionrelease

import (
	"crypto/rand"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"time"
)

const cacheMaxAge = 10 * time.Minute

// Cache is advisory only: it cannot authorize Download, and stale/corrupt data
// causes a fresh online check rather than an optimistic offline success.
func (s *Service) readCache() (ReleaseInfo, bool) {
	if s.cacheFile == "" {
		return ReleaseInfo{}, false
	}
	root, err := os.OpenRoot(filepath.Dir(s.cacheFile))
	if err != nil {
		return ReleaseInfo{}, false
	}
	defer root.Close()
	file, err := openRegular(root, filepath.Base(s.cacheFile))
	if err != nil {
		return ReleaseInfo{}, false
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, 16*1024+1))
	if err != nil || len(body) > 16*1024 {
		return ReleaseInfo{}, false
	}
	var info ReleaseInfo
	if decodeJSON(body, &info) != nil {
		return ReleaseInfo{}, false
	}
	age := time.Since(info.CheckedAt)
	v, err := parseVersion(info.Version, false)
	if err != nil || v.prerelease != "" || age < 0 || age >= cacheMaxAge || info.PublishedAt.IsZero() ||
		info.Repository != DefaultRepository || info.CurrentVersion != s.current.text || info.Target != s.target ||
		info.Tag != "v"+v.text || info.Available != newerStable(v, s.current) {
		return ReleaseInfo{}, false
	}
	if info.Available && !validArtifact(info.Artifact, v.text, s.target) {
		return ReleaseInfo{}, false
	}
	if !info.Available && info.Artifact != (ArtifactInfo{}) {
		return ReleaseInfo{}, false
	}
	return info, true
}

func (s *Service) writeCache(info ReleaseInfo) {
	if s.cacheFile == "" {
		return
	}
	// Encode only our normalized DTO; never serialize a request, response,
	// transport, GitHub release body, arbitrary URL, header or error.
	body, err := json.Marshal(info)
	if err != nil {
		return
	}
	parent := filepath.Dir(s.cacheFile)
	if os.MkdirAll(parent, 0o700) != nil {
		return
	}
	root, err := os.OpenRoot(parent)
	if err != nil {
		return
	}
	defer root.Close()
	partial := ".distribution-release-" + rand.Text() + ".partial"
	file, err := root.OpenFile(partial, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return
	}
	ownsPartial := true
	defer func() {
		file.Close()
		if ownsPartial {
			root.Remove(partial)
		}
	}()
	if _, err := file.Write(body); err != nil {
		return
	}
	if file.Sync() != nil || file.Close() != nil {
		return
	}
	if root.Rename(partial, filepath.Base(s.cacheFile)) == nil {
		ownsPartial = false
	}
}
