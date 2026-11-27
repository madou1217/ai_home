// Package proxyendpoints publishes geo metadata for local `aih proxy serve`
// entries.
//
// The resident control file (`run/proxy/control.json`) exposes one entry with
// its control API. Every foreground entry may sit on a different port and
// selector, and consumers such as the app desk still need its country/city for
// display. Each serve process therefore publishes a small, credential-free
// record under `run/proxy/endpoints/<port>.json`. Readers treat missing or
// stale files as "unknown geo" and never guess.
package proxyendpoints

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/proxyregion"
)

// Version is the on-disk schema version.
const Version = 1

// Info is one local proxy entry's display metadata. It contains no lease
// credentials: only the loopback endpoint, lease name, and derived geo.
type Info struct {
	Version   int    `json:"version"`
	PID       int    `json:"pid"`
	Name      string `json:"name,omitempty"`
	HTTPURL   string `json:"httpUrl"`
	Country   string `json:"country,omitempty"`
	CityCode  string `json:"cityCode,omitempty"`
	Region    string `json:"region,omitempty"`
	UpdatedAt string `json:"updatedAt"`
}

// Dir returns the per-entry metadata directory.
func Dir(aiHomeDir string) string {
	return filepath.Join(strings.TrimSpace(aiHomeDir), "run", "proxy", "endpoints")
}

// Publish writes (or refreshes) the metadata for lease.name. The returned
// cleanup only removes the record if it still belongs to this process.
func Publish(aiHomeDir, httpURL, name string) (func(), error) {
	noop := func() {}
	home := strings.TrimSpace(aiHomeDir)
	httpURL = strings.TrimSpace(httpURL)
	if home == "" || httpURL == "" {
		return noop, nil
	}
	port := portOf(httpURL)
	if port == "" {
		return noop, errors.New("代理入口缺少端口")
	}
	country, cityCode := proxyregion.ParseNodeLabel(name)
	info := Info{
		Version:   Version,
		PID:       os.Getpid(),
		Name:      strings.TrimSpace(name),
		HTTPURL:   httpURL,
		Country:   country,
		CityCode:  cityCode,
		Region:    proxyregion.RegionLabel(country, cityCode),
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	payload, err := json.Marshal(info)
	if err != nil {
		return noop, err
	}
	dir := Dir(home)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return noop, err
	}
	path := filepath.Join(dir, port+".json")
	temporary, err := os.CreateTemp(dir, "."+port+"-*.json")
	if err != nil {
		return noop, err
	}
	temporaryName := temporary.Name()
	if _, err := temporary.Write(payload); err != nil {
		_ = temporary.Close()
		_ = os.Remove(temporaryName)
		return noop, err
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryName)
		return noop, err
	}
	_ = os.Chmod(temporaryName, 0o600)
	if err := os.Rename(temporaryName, path); err != nil {
		_ = os.Remove(temporaryName)
		return noop, err
	}
	return func() { removeOwned(path, info.PID) }, nil
}

// Lookup returns the metadata record whose HTTP endpoint matches proxyURL.
// A record older than 7 days is ignored: a stale port must not label a new
// entry with an old country.
func Lookup(aiHomeDir, proxyURL string) (Info, bool) {
	port := portOf(proxyURL)
	if port == "" {
		return Info{}, false
	}
	raw, err := os.ReadFile(filepath.Join(Dir(aiHomeDir), port+".json"))
	if err != nil {
		return Info{}, false
	}
	var info Info
	if json.Unmarshal(raw, &info) != nil || info.Version != Version || info.HTTPURL == "" {
		return Info{}, false
	}
	if portOf(info.HTTPURL) != port || !MatchesEndpoint(info.HTTPURL, proxyURL) {
		return Info{}, false
	}
	if updated, err := time.Parse(time.RFC3339, info.UpdatedAt); err == nil && time.Since(updated) > 7*24*time.Hour {
		return Info{}, false
	}
	if info.Country == "" && info.CityCode == "" {
		info.Region = ""
	} else {
		info.Region = proxyregion.RegionLabel(info.Country, info.CityCode)
	}
	return info, true
}

func removeOwned(path string, pid int) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var info Info
	if json.Unmarshal(raw, &info) != nil || info.PID != pid {
		return
	}
	_ = os.Remove(path)
}

func portOf(rawURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed == nil {
		return ""
	}
	return parsed.Port()
}

// MatchesEndpoint reports whether two URLs point at the same host:port.
func MatchesEndpoint(left, right string) bool {
	a, err := url.Parse(strings.TrimSpace(left))
	if err != nil || a == nil {
		return false
	}
	b, err := url.Parse(strings.TrimSpace(right))
	if err != nil || b == nil {
		return false
	}
	return strings.EqualFold(a.Host, b.Host) && a.Port() == b.Port()
}

// Describe returns a human-readable endpoint summary for diagnostics.
func (info Info) Describe() string {
	label := info.Region
	if label == "" {
		label = "未知地区"
	}
	return fmt.Sprintf("%s · %s", info.HTTPURL, label)
}
