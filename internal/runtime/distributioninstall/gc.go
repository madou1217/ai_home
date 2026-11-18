package distributioninstall

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// PruneReport summarises one distribution garbage-collection pass.
type PruneReport struct {
	Current    string   `json:"current,omitempty"`
	Kept       []string `json:"kept"`
	Removed    []string `json:"removed"`
	Failed     []string `json:"failed"`
	FreedBytes int64    `json:"freedBytes"`
	Skipped    string   `json:"skipped,omitempty"`
}

// PruneOptions configures retention of managed distribution artifacts.
//
// Policy: the installed version plus at most one neighbouring release are
// kept; anything older than one step back is garbage. The current install
// transaction backup is the only install-history snapshot retained, and only
// the newest artifact per platform is kept under updates/downloads.
type PruneOptions struct {
	Home string
	Now  time.Time
	// KeepPrevious keeps one neighbouring release directory next to the
	// installed one so an operator can roll back a bad upgrade. Defaults to
	// true; set DisablePrevious to keep only the installed version.
	DisablePrevious bool
	// MinAge protects directories touched by an in-flight install. Defaults
	// to one hour.
	MinAge time.Duration
	DryRun bool
}

// packageDirPattern matches the managed package directory name produced by the
// installer: <version>-<os>-<arch>-<sha12>.
var packageDirPattern = regexp.MustCompile(`^([0-9]+\.[0-9]+\.[0-9]+)-[a-z0-9]+-[a-z0-9]+-[0-9a-f]{12}$`)

// artifactPattern matches downloaded single-file installers under
// updates/downloads, e.g. aih-1.0.6-linux-x64.run.
var artifactPattern = regexp.MustCompile(`^aih-([0-9]+\.[0-9]+\.[0-9]+)-([A-Za-z0-9_.-]+)\.(run|exe|dmg|zip)$`)

type versionedDir struct {
	name    string
	path    string
	version [3]int
	mod     time.Time
}

// PruneArtifacts removes distribution garbage that is more than one release
// behind the installed version. It never touches the installed package, the
// current install transaction backup, or any artifact named by the receipt.
// It is safe to call concurrently with a running service: when an install is
// in progress the pass is skipped instead of racing the installer.
func PruneArtifacts(options PruneOptions) (PruneReport, error) {
	report := PruneReport{Kept: []string{}, Removed: []string{}, Failed: []string{}}
	if strings.TrimSpace(options.Home) == "" {
		return report, errors.New("distribution_prune_home_required")
	}
	home, err := canonical(options.Home)
	if err != nil {
		return report, err
	}
	receipt, err := ReadReceipt(home)
	if err != nil {
		return report, err
	}
	now := options.Now
	if now.IsZero() {
		now = time.Now()
	}
	minAge := options.MinAge
	if minAge <= 0 {
		minAge = time.Hour
	}
	report.Current = filepath.Base(receipt.PackageRoot)

	release, err := os.OpenFile(filepath.Join(home, "run", "distribution-install.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return report, err
	}
	defer release.Close()
	if err = lockFile(release); err != nil {
		report.Skipped = "install_in_progress"
		return report, nil
	}
	defer unlockFile(release)

	protect := map[string]bool{}
	if resolved, err := canonical(receipt.PackageRoot); err == nil {
		protect[resolved] = true
	}
	for _, field := range []string{receipt.Launcher, receipt.Executable} {
		if field == "" {
			continue
		}
		if resolved, err := canonical(field); err == nil {
			protect[resolved] = true
		}
	}

	collector := &pruneCollector{report: &report, dryRun: options.DryRun}
	prunePackageVersions(home, report.Current, !options.DisablePrevious, minAge, now, protect, collector)
	pruneInstallHistoryInto(home, receipt.Transaction, collector)
	pruneDownloads(home, minAge, now, protect, collector)
	return report, nil
}

type pruneCollector struct {
	report *PruneReport
	dryRun bool
}

// keep records a path as retained.
func (c *pruneCollector) keep(path string) { c.report.Kept = append(c.report.Kept, path) }

// drop removes a path and accounts for the reclaimed bytes.
func (c *pruneCollector) drop(path string, size int64) {
	if c.dryRun {
		c.report.Removed = append(c.report.Removed, path)
		c.report.FreedBytes += size
		return
	}
	if err := os.RemoveAll(path); err != nil {
		c.report.Failed = append(c.report.Failed, path)
		return
	}
	c.report.Removed = append(c.report.Removed, path)
	c.report.FreedBytes += size
}

func prunePackageVersions(home, current string, keepPrevious bool, minAge time.Duration, now time.Time, protect map[string]bool, collector *pruneCollector) {
	root := filepath.Join(home, "pkg")
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	var candidates []versionedDir
	for _, entry := range entries {
		name := entry.Name()
		match := packageDirPattern.FindStringSubmatch(name)
		if match == nil {
			// Interrupted staging directories are garbage once they are cold.
			if strings.HasPrefix(name, ".portable-install-") {
				path := filepath.Join(root, name)
				if info, err := entry.Info(); err == nil && entry.IsDir() && now.Sub(info.ModTime()) >= 6*time.Minute {
					collector.drop(path, dirSize(path))
				}
			}
			continue
		}
		path := filepath.Join(root, name)
		info, err := entry.Info()
		if err != nil || !entry.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		if protect[path] {
			collector.keep(path)
			continue
		}
		if now.Sub(info.ModTime()) < minAge {
			collector.keep(path)
			continue
		}
		candidates = append(candidates, versionedDir{name: name, path: path, version: parseVersion(match[1]), mod: info.ModTime()})
	}
	if len(candidates) == 0 {
		return
	}
	sort.Slice(candidates, func(i, j int) bool {
		order := compareVersions(candidates[i].version, candidates[j].version)
		if order != 0 {
			return order > 0
		}
		if !candidates[i].mod.Equal(candidates[j].mod) {
			return candidates[i].mod.After(candidates[j].mod)
		}
		return candidates[i].name > candidates[j].name
	})
	var installed *versionedDir
	for index := range candidates {
		if candidates[index].name == current {
			installed = &candidates[index]
			break
		}
	}
	retained := map[string]bool{}
	if installed != nil {
		retained[installed.name] = true
		collector.keep(installed.path)
	}
	if keepPrevious {
		if previous := neighbourRelease(candidates, current); previous != nil {
			retained[previous.name] = true
			collector.keep(previous.path)
		}
	}
	for _, candidate := range candidates {
		if retained[candidate.name] {
			continue
		}
		collector.drop(candidate.path, dirSize(candidate.path))
	}
}

// neighbourRelease picks the single rollback target kept next to the installed
// release: the most recently used release that is not the installed one. The
// installer copies each release into pkg/ at install time, so directory mtime
// orders releases and identifies the version the operator just left.
func neighbourRelease(candidates []versionedDir, current string) *versionedDir {
	var best *versionedDir
	for index := range candidates {
		candidate := &candidates[index]
		if candidate.name == current {
			continue
		}
		if best == nil || candidate.mod.After(best.mod) {
			best = candidate
			continue
		}
		if candidate.mod.Equal(best.mod) && compareVersions(candidate.version, best.version) > 0 {
			best = candidate
		}
	}
	return best
}

func parseVersion(raw string) [3]int {
	var version [3]int
	parts := strings.Split(raw, ".")
	for index := 0; index < len(parts) && index < 3; index++ {
		value, err := strconv.Atoi(parts[index])
		if err != nil {
			return version
		}
		version[index] = value
	}
	return version
}

func compareVersions(left, right [3]int) int {
	for index := 0; index < 3; index++ {
		if left[index] != right[index] {
			if left[index] < right[index] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// pruneDownloads keeps only the newest installer per platform under
// updates/downloads. Artifacts referenced by the receipt are never removed.
func pruneDownloads(home string, minAge time.Duration, now time.Time, protect map[string]bool, collector *pruneCollector) {
	root := filepath.Join(home, "updates", "downloads")
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	type artifact struct {
		path    string
		version [3]int
		mod     time.Time
	}
	groups := map[string][]artifact{}
	for _, entry := range entries {
		name := entry.Name()
		path := filepath.Join(root, name)
		if strings.HasPrefix(name, ".aih-publish-") {
			if info, infoErr := entry.Info(); infoErr == nil && now.Sub(info.ModTime()) >= 6*time.Minute {
				collector.drop(path, dirSize(path))
			}
			continue
		}
		match := artifactPattern.FindStringSubmatch(name)
		if match == nil {
			continue
		}
		info, infoErr := entry.Info()
		if infoErr != nil || !info.Mode().IsRegular() {
			continue
		}
		if protect[path] {
			collector.keep(path)
			continue
		}
		if now.Sub(info.ModTime()) < minAge {
			collector.keep(path)
			continue
		}
		groups[match[2]] = append(groups[match[2]], artifact{path: path, version: parseVersion(match[1]), mod: info.ModTime()})
	}
	if len(groups) == 0 {
		return
	}
	platforms := make([]string, 0, len(groups))
	for platform := range groups {
		platforms = append(platforms, platform)
	}
	sort.Strings(platforms)
	for _, platform := range platforms {
		items := groups[platform]
		sort.Slice(items, func(i, j int) bool {
			order := compareVersions(items[i].version, items[j].version)
			if order != 0 {
				return order > 0
			}
			return items[i].mod.After(items[j].mod)
		})
		collector.keep(items[0].path)
		for _, item := range items[1:] {
			collector.drop(item.path, dirSize(item.path))
		}
	}
}

func dirSize(path string) int64 {
	var total int64
	_ = filepath.WalkDir(path, func(_ string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		if info, infoErr := entry.Info(); infoErr == nil {
			total += info.Size()
		}
		return nil
	})
	return total
}
