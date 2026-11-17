package distributionrelease

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"time"
)

var sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Do not decode browser_download_url, release body, or any other untrusted URL.
type githubRelease struct {
	Tag         string        `json:"tag_name"`
	Draft       *bool         `json:"draft"`
	Prerelease  *bool         `json:"prerelease"`
	PublishedAt time.Time     `json:"published_at"`
	Assets      []githubAsset `json:"assets"`
}

type githubAsset struct {
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	State string `json:"state"`
}

// Mirrors scripts/package/build-release.js. Unused build/node metadata remains
// owned by the producer; only the selected single-file artifact is consumed.
type releaseManifest struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Targets []struct {
		Target    string `json:"target"`
		Artifacts []struct {
			Kind string `json:"kind"`
			ArtifactInfo
		} `json:"artifacts"`
	} `json:"targets"`
}

func (s *Service) fetchRelease(ctx context.Context, selector string) (githubRelease, error) {
	endpoint := "https://api.github.com/repos/" + DefaultRepository + "/releases/"
	if selector == "latest" {
		endpoint += "latest"
	} else {
		endpoint += "tags/" + url.PathEscape(selector)
	}
	body, err := s.getBytes(ctx, endpoint, maxReleaseJSON, "application/vnd.github+json")
	if err != nil {
		return githubRelease{}, err
	}
	var release githubRelease
	if err := decodeJSON(body, &release); err != nil {
		return githubRelease{}, err
	}
	return release, nil
}

func (s *Service) fetchArtifactInfo(ctx context.Context, release githubRelease, version string) (ArtifactInfo, error) {
	manifestName := "aih-" + version + "-manifest.json"
	manifestAsset, err := findAsset(release, manifestName, maxManifest)
	if err != nil {
		return ArtifactInfo{}, err
	}
	body, err := s.getBytes(ctx, assetURL(release.Tag, manifestName), maxManifest, "application/octet-stream")
	if err != nil {
		return ArtifactInfo{}, err
	}
	if int64(len(body)) != manifestAsset.Size {
		return ArtifactInfo{}, fmt.Errorf("%w: manifest asset size mismatch", ErrInvalidRelease)
	}
	var manifest releaseManifest
	if err := decodeJSON(body, &manifest); err != nil {
		return ArtifactInfo{}, err
	}
	if manifest.Name != "ai-home" || manifest.Version != version {
		return ArtifactInfo{}, fmt.Errorf("%w: manifest identity mismatch", ErrInvalidRelease)
	}
	var selected ArtifactInfo
	targets, singles := 0, 0
	for _, target := range manifest.Targets {
		if target.Target != s.target {
			continue
		}
		targets++
		for _, artifact := range target.Artifacts {
			if artifact.Kind == "single-file" {
				singles++
				selected = artifact.ArtifactInfo
			}
		}
	}
	if targets != 1 || singles != 1 || !validArtifact(selected, version, s.target) {
		return ArtifactInfo{}, fmt.Errorf("%w: missing, duplicate or invalid single-file artifact", ErrInvalidRelease)
	}
	asset, err := findAsset(release, selected.File, MaxArtifactBytes)
	if err != nil {
		return ArtifactInfo{}, err
	}
	if asset.Size != selected.Bytes {
		return ArtifactInfo{}, fmt.Errorf("%w: artifact asset size disagrees with manifest", ErrInvalidRelease)
	}
	checksumAsset, err := findAsset(release, selected.File+".sha256", maxChecksum)
	if err != nil {
		return ArtifactInfo{}, err
	}
	checksum, err := s.getBytes(ctx, assetURL(release.Tag, checksumAsset.Name), maxChecksum, "application/octet-stream")
	if err != nil {
		return ArtifactInfo{}, err
	}
	// Exact format emitted by scripts/package/archives.js: hash, two spaces,
	// basename, newline. Neither a pathname nor multiple checksum lines is valid.
	if int64(len(checksum)) != checksumAsset.Size || string(checksum) != selected.SHA256+"  "+selected.File+"\n" {
		return ArtifactInfo{}, fmt.Errorf("%w: SHA-256 sidecar disagrees with manifest", ErrInvalidRelease)
	}
	return selected, nil
}

func findAsset(release githubRelease, name string, limit int64) (githubAsset, error) {
	var selected githubAsset
	matches := 0
	for _, asset := range release.Assets {
		if asset.Name == name {
			matches++
			selected = asset
		}
	}
	if matches != 1 || selected.State != "uploaded" || selected.Size <= 0 || selected.Size > limit {
		return githubAsset{}, fmt.Errorf("%w: missing, duplicate or oversized asset %s", ErrInvalidRelease, name)
	}
	return selected, nil
}

func validArtifact(artifact ArtifactInfo, version, target string) bool {
	return artifact.File == artifactName(version, target) && artifact.Bytes > 0 &&
		artifact.Bytes <= MaxArtifactBytes && sha256Pattern.MatchString(artifact.SHA256)
}
