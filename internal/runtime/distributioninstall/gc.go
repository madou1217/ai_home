package distributioninstall

import (
	"encoding/json"
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
	// DedupeSameVersion lets the installer drop same-version duplicate
	// directories even when they are younger than MinAge. Same-version builds
	// are not rollback targets (rolling back to the same version is
	// meaningless), so keeping them only accumulates pkg directories under
	// repeated deploys. Only set this while holding the install lock: a
	// concurrent .run may have extracted its directory before taking the lock.
	DedupeSameVersion bool
	// FailedTransactionMaxAge is how long a failed or rolled-back install
	// transaction is retained before the periodic GC removes it. Defaults to
	// 24 hours; pass a negative value to retain failed transactions forever.
	FailedTransactionMaxAge time.Duration
	DryRun                  bool
}

// packageDirPattern matches the managed package directory name produced by the
// installer: <version>-<os>-<arch>-<sha8>（单个文件包解包时取 payload sha 的
// 前 8 位）。只接受 12 位会让所有真实目录都匹配不上，GC 永远清不掉旧版本。
var packageDirPattern = regexp.MustCompile(`^([0-9]+\.[0-9]+\.[0-9]+)-[a-z0-9]+-[a-z0-9]+-[0-9a-f]{8,64}$`)

// artifactPattern matches downloaded single-file installers under
// updates/downloads, e.g. aih-1.0.6-linux-x64.run.
var artifactPattern = regexp.MustCompile(`^aih-([0-9]+\.[0-9]+\.[0-9]+)-([A-Za-z0-9_.-]+)\.(run|exe|dmg|zip)$`)

// legacyPackageDirPattern matches 1.0.0 时代的 pkg 目录布局
// （aih-<version>-<os>-<arch>，没有 payload hash），只在确认陈旧后删除。
var legacyPackageDirPattern = regexp.MustCompile(`^aih-([0-9]+\.[0-9]+\.[0-9]+)-(linux|win32|darwin)-(x64|arm64)$`)

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
	return pruneArtifacts(options, false)
}

// PruneArtifactsLocked 供已经持有 distribution-install.lock 的安装流程调用。
//
// Install 在持有安装锁时调用 PruneArtifacts 会因 LOCK_NB 失败而拿回
// Skipped=install_in_progress 且 err=nil，历史版本目录因此永远不会在安装结束时
// 回收；重复部署同一版本就会堆出多份 <version>-<os>-<arch>-<sha12> 目录。
func PruneArtifactsLocked(options PruneOptions) (PruneReport, error) {
	return pruneArtifacts(options, true)
}

func pruneArtifacts(options PruneOptions, lockHeld bool) (PruneReport, error) {
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
	failedMaxAge := options.FailedTransactionMaxAge
	if failedMaxAge == 0 {
		failedMaxAge = defaultFailedTransactionRetention
	}
	report.Current = filepath.Base(receipt.PackageRoot)

	if !lockHeld {
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
	}

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
	prunePackageVersions(home, report.Current, !options.DisablePrevious, minAge, options.DedupeSameVersion, now, protect, collector)
	pruneInstallHistoryInto(home, receipt.Transaction, collector)
	pruneStaleFailedTransactions(home, receipt.Transaction, now, failedMaxAge, collector)
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
//
// Windows 上旧版本的常驻助手（例如 codex app-server 的 Node 代理）会锁住包内
// 文件，直接 RemoveAll 可能删掉一半才失败，留下半残缺的旧包。先原子改名成
// .trash-* 再删：包目录立刻从 pkg/ 消失，锁住的部分留给下一次 GC 重试。
func (c *pruneCollector) drop(path string, size int64) {
	if c.dryRun {
		c.report.Removed = append(c.report.Removed, path)
		c.report.FreedBytes += size
		return
	}
	trashed := false
	trash := filepath.Join(filepath.Dir(path), ".trash-"+filepath.Base(path)+"-"+strconv.FormatInt(time.Now().UnixNano(), 10))
	if err := os.Rename(path, trash); err == nil {
		path = trash
		trashed = true
	}
	if err := os.RemoveAll(path); err != nil {
		if trashed {
			// 包目录已经换出 pkg/，剩余文件等下次 GC 再删。
			c.report.Removed = append(c.report.Removed, path)
			c.report.FreedBytes += size
			return
		}
		c.report.Failed = append(c.report.Failed, path)
		return
	}
	c.report.Removed = append(c.report.Removed, path)
	c.report.FreedBytes += size
}

// dropTrash 删除回收站目录本身，不再二次改名。
func (c *pruneCollector) dropTrash(path string, size int64) {
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

func prunePackageVersions(home, current string, keepPrevious bool, minAge time.Duration, dedupeSameVersion bool, now time.Time, protect map[string]bool, collector *pruneCollector) {
	root := filepath.Join(home, "pkg")
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	currentVersion := [3]int{}
	knownCurrentVersion := false
	if match := packageDirPattern.FindStringSubmatch(current); match != nil {
		currentVersion = parseVersion(match[1])
		knownCurrentVersion = true
	}
	var candidates []versionedDir
	for _, entry := range entries {
		name := entry.Name()
		match := packageDirPattern.FindStringSubmatch(name)
		if match == nil {
			path := filepath.Join(root, name)
			info, infoErr := entry.Info()
			if infoErr != nil || !entry.IsDir() {
				continue
			}
			// Interrupted staging directories and renamed trash are garbage
			// once they are cold.
			if strings.HasPrefix(name, ".portable-install-") || strings.HasPrefix(name, ".trash-") {
				if now.Sub(info.ModTime()) >= 10*time.Minute {
					collector.dropTrash(path, dirSize(path))
				}
				continue
			}
			// 1.0.0 时代的目录没有 hash，不会被回滚引用；陈旧即删。
			if legacyPackageDirPattern.MatchString(name) && now.Sub(info.ModTime()) >= minAge {
				collector.drop(path, dirSize(path))
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
		candidateVersion := parseVersion(match[1])
		if now.Sub(info.ModTime()) < minAge {
			// 安装流程持锁时可以立即回收同版本的重复构建；等待锁的并发 .run
			// 已经解包的同版本目录是唯一需要保护的场景，MinAge 仍然覆盖它。
			sameVersion := knownCurrentVersion && compareVersions(candidateVersion, currentVersion) == 0 && name != current
			if !(dedupeSameVersion && sameVersion) {
				collector.keep(path)
				continue
			}
		}
		candidates = append(candidates, versionedDir{name: name, path: path, version: candidateVersion, mod: info.ModTime()})
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

// neighbourRelease 选相邻的上一份发行版本作为唯一回滚目标。
//
// 只认同版本不同的目录：重复构建/重复部署同一版本会产出多个
// <version>-<os>-<arch>-<sha12> 目录，它们不能当回滚目标（版本相同，回滚没有
// 意义），必须回收，否则“一个版本多个目录”会一直累积。
func neighbourRelease(candidates []versionedDir, current string) *versionedDir {
	currentVersion := [3]int{}
	knownVersion := false
	if match := packageDirPattern.FindStringSubmatch(current); match != nil {
		currentVersion = parseVersion(match[1])
		knownVersion = true
	}
	var best *versionedDir
	for index := range candidates {
		candidate := &candidates[index]
		if candidate.name == current {
			continue
		}
		if knownVersion && compareVersions(candidate.version, currentVersion) == 0 {
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

const defaultFailedTransactionRetention = 24 * time.Hour

// pruneStaleFailedTransactions removes failed or rolled-back install transaction
// directories after their retention window. Successful transactions and the
// receipt's rollback backup are owned by pruneInstallHistoryInto and are never
// touched here. Unknown journals, symlinks and in-flight transactions are left
// alone.
func pruneStaleFailedTransactions(home, keep string, now time.Time, maxAge time.Duration, collector *pruneCollector) {
	if maxAge < 0 {
		return
	}
	root := transactionRoot(home)
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	pending := readPendingTransaction(home)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		path := filepath.Join(root, entry.Name())
		if filepath.Clean(path) == filepath.Clean(keep) || filepath.Clean(path) == filepath.Clean(pending) {
			collector.keep(path)
			continue
		}
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		if now.Sub(info.ModTime()) < maxAge {
			collector.keep(path)
			continue
		}
		raw, err := os.ReadFile(filepath.Join(path, "journal.json"))
		if err != nil || len(raw) > 4<<20 {
			continue
		}
		var previous journal
		if json.Unmarshal(raw, &previous) != nil || previous.Version != 1 || previous.ID != entry.Name() || previous.Home != home {
			continue
		}
		if previous.Phase != "failed" && previous.Phase != "rolled_back" {
			continue
		}
		collector.drop(path, dirSize(path))
	}
}

func readPendingTransaction(home string) string {
	raw, err := os.ReadFile(filepath.Join(home, "run", "distribution-install-pending.json"))
	if err != nil || len(raw) > 1<<20 {
		return ""
	}
	var pending struct {
		Journal string `json:"journal"`
	}
	if json.Unmarshal(raw, &pending) != nil {
		return ""
	}
	return strings.TrimSpace(pending.Journal)
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
