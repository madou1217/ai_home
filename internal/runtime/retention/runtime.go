package retention

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// DefaultRetentionDays 是运行期沙箱目录（login / chat-harness / verification）的默认保留天数。
const DefaultRetentionDays = 10

// RuntimeSweepOptions 配置运行期目录回收参数与现存账号集合。
type RuntimeSweepOptions struct {
	AIHomeDir         string
	ActiveAccountRefs []string
	// HasActiveRefs 为 false 时跳过 orphan-harness 回收，避免账本不可读时误删全部账号沙箱。
	HasActiveRefs bool
	CurrentHome   string
	Now           func() time.Time
	KeepDays      int
}

// RemovedEntry 描述单个被回收目录的路径、原因与释放字节数。
type RemovedEntry struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
	Bytes  int64  `json:"bytes"`
}

// RuntimeSweepReport 汇总单次运行期目录回收的扫描与释放统计。
type RuntimeSweepReport struct {
	Removed    []RemovedEntry `json:"removed"`
	FreedBytes int64          `json:"freedBytes"`
	Scanned    int            `json:"scanned"`
}

// ResolveRetentionDays 从 AIH_RUNTIME_RETENTION_DAYS 解析保留天数。
func ResolveRetentionDays(getenv func(string) string) int {
	if getenv == nil {
		getenv = os.Getenv
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(getenv("AIH_RUNTIME_RETENTION_DAYS")), 64)
	if err != nil || v <= 0 {
		return DefaultRetentionDays
	}
	days := int(v)
	if days <= 0 {
		return DefaultRetentionDays
	}
	return days
}

// LatestMtime 返回目录树内最近一次常规写入的时间（忽略符号链接），避免只看顶层目录时间误杀活跃沙箱。
func LatestMtime(dirPath string) (time.Time, bool) {
	topInfo, err := os.Stat(dirPath)
	if err != nil {
		return time.Time{}, false
	}
	newest := topInfo.ModTime()
	stack := []string{dirPath}
	for len(stack) > 0 {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		entries, err := os.ReadDir(current)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.Type()&os.ModeSymlink != 0 {
				continue
			}
			entryPath := filepath.Join(current, entry.Name())
			if entry.IsDir() {
				stack = append(stack, entryPath)
				continue
			}
			info, err := os.Stat(entryPath)
			if err != nil {
				continue
			}
			if info.ModTime().After(newest) {
				newest = info.ModTime()
			}
		}
	}
	return newest, true
}

func sizeOfTree(dirPath string) int64 {
	var total int64
	stack := []string{dirPath}
	for len(stack) > 0 {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		entries, err := os.ReadDir(current)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.Type()&os.ModeSymlink != 0 {
				continue
			}
			entryPath := filepath.Join(current, entry.Name())
			if entry.IsDir() {
				stack = append(stack, entryPath)
				continue
			}
			info, err := os.Stat(entryPath)
			if err == nil {
				total += info.Size()
			}
		}
	}
	return total
}

func removeTreeSafe(dirPath string) {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return
	}
	for _, entry := range entries {
		entryPath := filepath.Join(dirPath, entry.Name())
		if entry.Type()&os.ModeSymlink != 0 {
			_ = os.Remove(entryPath)
			continue
		}
		if entry.IsDir() {
			removeTreeSafe(entryPath)
			_ = os.Remove(entryPath)
			continue
		}
		_ = os.Remove(entryPath)
	}
}

func removeDirectory(dirPath, reason string, report *RuntimeSweepReport) {
	bytes := sizeOfTree(dirPath)
	removeTreeSafe(dirPath)
	if err := os.Remove(dirPath); err != nil {
		return
	}
	report.Removed = append(report.Removed, RemovedEntry{
		Path:   dirPath,
		Reason: reason,
		Bytes:  bytes,
	})
	report.FreedBytes += bytes
}

func listSubdirectories(dirPath string) []string {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return nil
	}
	dirs := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() {
			continue
		}
		dirs = append(dirs, entry.Name())
	}
	return dirs
}

func resolveAbsPath(p string) string {
	trimmed := strings.TrimSpace(p)
	if trimmed == "" {
		return ""
	}
	abs, err := filepath.Abs(trimmed)
	if err != nil {
		return filepath.Clean(trimmed)
	}
	return abs
}

func hasPrivateThreadStore(dirPath string) bool {
	storePath := filepath.Join(dirPath, ".codex", "thread_history_1.sqlite")
	info, err := os.Lstat(storePath)
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeSymlink == 0 && info.Size() > 0
}

// SweepRuntimeDirs 回收已删除账号与超期的 chat-harness / login / verification 运行态目录。
func SweepRuntimeDirs(opts RuntimeSweepOptions) RuntimeSweepReport {
	report := RuntimeSweepReport{Removed: []RemovedEntry{}}
	aiHome := strings.TrimSpace(opts.AIHomeDir)
	if aiHome == "" {
		return report
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	keepDays := opts.KeepDays
	if keepDays <= 0 {
		keepDays = DefaultRetentionDays
	}
	cutoff := nowFn().Add(-time.Duration(keepDays) * DayDuration)
	protectedAbs := resolveAbsPath(opts.CurrentHome)
	isProtected := func(dirPath string) bool {
		return protectedAbs != "" && resolveAbsPath(dirPath) == protectedAbs
	}
	isStale := func(dirPath string) bool {
		latest, ok := LatestMtime(dirPath)
		if !ok {
			return false
		}
		return latest.Before(cutoff)
	}

	var activeSet map[string]struct{}
	if opts.HasActiveRefs {
		activeSet = make(map[string]struct{}, len(opts.ActiveAccountRefs))
		for _, ref := range opts.ActiveAccountRefs {
			trimmed := strings.TrimSpace(ref)
			if trimmed != "" {
				activeSet[trimmed] = struct{}{}
			}
		}
	}

	runRoot := filepath.Join(aiHome, "run")

	// 1) chat-harness：已删除账号的孤儿目录立即回收；带私有 thread store 的保留；其余按最新写入超期回收。
	harnessRoot := filepath.Join(runRoot, "chat-harness")
	for _, name := range listSubdirectories(harnessRoot) {
		dirPath := filepath.Join(harnessRoot, name)
		report.Scanned++
		if isProtected(dirPath) {
			continue
		}
		if opts.HasActiveRefs && strings.HasPrefix(name, "acct_") {
			if _, ok := activeSet[name]; !ok {
				removeDirectory(dirPath, "orphan-harness", &report)
				continue
			}
		}
		if hasPrivateThreadStore(dirPath) {
			continue
		}
		if isStale(dirPath) {
			removeDirectory(dirPath, "stale-harness", &report)
		}
	}

	// 2) login：过期登录伪 HOME 沙箱。
	loginRoot := filepath.Join(runRoot, "login")
	for _, provider := range listSubdirectories(loginRoot) {
		providerDir := filepath.Join(loginRoot, provider)
		for _, authID := range listSubdirectories(providerDir) {
			dirPath := filepath.Join(providerDir, authID)
			report.Scanned++
			if isProtected(dirPath) {
				continue
			}
			if isStale(dirPath) {
				removeDirectory(dirPath, "stale-login", &report)
			}
		}
	}

	// 3) verification：验证产物。
	verificationRoot := filepath.Join(runRoot, "verification")
	for _, name := range listSubdirectories(verificationRoot) {
		dirPath := filepath.Join(verificationRoot, name)
		report.Scanned++
		if isProtected(dirPath) {
			continue
		}
		if isStale(dirPath) {
			removeDirectory(dirPath, "stale-verification", &report)
		}
	}

	return report
}
