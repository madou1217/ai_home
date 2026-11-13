package retention

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	// DefaultMaxLogBytes 限制单个活跃日志文件保留的最大字节数（10 MB）。
	DefaultMaxLogBytes int64 = 10 * 1024 * 1024
	// DefaultKeepDays 是日志按天归档及保留周期的默认天数。
	DefaultKeepDays = 10
	// DayDuration 表示标准 24 小时跨度。
	DayDuration = 24 * time.Hour
	// DefaultMaxAge 是日志保留的最大年龄（与 DefaultKeepDays 保持一致）。
	DefaultMaxAge = DefaultKeepDays * DayDuration
)

var (
	logFilePattern    = regexp.MustCompile(`(?i)\.(log|jsonl)(?:\.1|\.\d{4}-\d{2}-\d{2})?$`)
	dateSuffixPattern = regexp.MustCompile(`\.(\d{4}-\d{2}-\d{2})$`)
)

// LogSweepOptions 配置 SweepLogs 的大小限制、保留天数与时钟。
type LogSweepOptions struct {
	MaxBytes int64
	KeepDays int
	MaxAge   time.Duration
	Now      func() time.Time
}

// LogSweepReport 记录一轮日志清扫的变更计数。
type LogSweepReport struct {
	Changed int `json:"changed"`
	Removed int `json:"removed"`
	Trimmed int `json:"trimmed"`
}

// ResolveMaxBytes 从 AIH_LOG_MAX_BYTES 解析单文件字节上限。
func ResolveMaxBytes(getenv func(string) string) int64 {
	if getenv == nil {
		getenv = os.Getenv
	}
	v, err := strconv.ParseInt(strings.TrimSpace(getenv("AIH_LOG_MAX_BYTES")), 10, 64)
	if err != nil || v <= 0 {
		return DefaultMaxLogBytes
	}
	return v
}

// ResolveKeepDays 从 AIH_LOG_KEEP_DAYS 解析按天归档保留天数。
func ResolveKeepDays(getenv func(string) string) int {
	if getenv == nil {
		getenv = os.Getenv
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(getenv("AIH_LOG_KEEP_DAYS")), 64)
	if err != nil || v <= 0 {
		return DefaultKeepDays
	}
	days := int(v)
	if days <= 0 {
		return DefaultKeepDays
	}
	return days
}

// ResolveMaxAge 从 AIH_LOG_MAX_AGE_DAYS 解析最大年龄；未覆盖时跟随 keepDays 保持一致策略。
func ResolveMaxAge(getenv func(string) string, keepDays int) time.Duration {
	if getenv == nil {
		getenv = os.Getenv
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(getenv("AIH_LOG_MAX_AGE_DAYS")), 64)
	if err == nil && v > 0 {
		ms := int64(v * float64(DayDuration.Milliseconds()))
		if ms > 0 {
			return time.Duration(ms) * time.Millisecond
		}
	}
	fallback := keepDays
	if fallback <= 0 {
		fallback = DefaultKeepDays
	}
	return time.Duration(fallback) * DayDuration
}

// LocalDateStamp 返回本地时区下的 YYYY-MM-DD 日期串。
func LocalDateStamp(t time.Time) string {
	return t.In(time.Local).Format("2006-01-02")
}

// TrimFileToRecentBytes 原地截断日志仅保留最近 maxBytes 内容（从第一条换行后开始），
// 以免改名断开守护进程/launchd 仍持有的 stdout/stderr 文件描述符。
func TrimFileToRecentBytes(filePath string, maxBytes int64) (bool, error) {
	sizeLimit := maxBytes
	if sizeLimit <= 0 {
		sizeLimit = DefaultMaxLogBytes
	}
	info, err := os.Stat(filePath)
	if err != nil {
		return false, nil
	}
	if info.Size() <= sizeLimit {
		return false, nil
	}

	start := info.Size() - sizeLimit
	if start < 0 {
		start = 0
	}
	f, err := os.Open(filePath)
	if err != nil {
		if truncErr := os.Truncate(filePath, sizeLimit); truncErr == nil {
			return true, nil
		}
		return false, err
	}
	buf := make([]byte, sizeLimit)
	totalRead := 0
	for totalRead < len(buf) {
		n, readErr := f.ReadAt(buf[totalRead:], start+int64(totalRead))
		totalRead += n
		if readErr != nil {
			break
		}
	}
	_ = f.Close()

	retained := buf[:totalRead]
	if start > 0 {
		if idx := bytes.IndexByte(retained, '\n'); idx >= 0 {
			retained = retained[idx+1:]
		}
	}
	if err := os.WriteFile(filePath, retained, 0o600); err != nil {
		if truncErr := os.Truncate(filePath, sizeLimit); truncErr == nil {
			return true, nil
		}
		return false, err
	}
	return true, nil
}

// RotateLogByDay 在文件最后修改日期早于今天时将其归档为 <file>.<YYYY-MM-DD>。
func RotateLogByDay(filePath string, now time.Time) (bool, error) {
	path := strings.TrimSpace(filePath)
	if path == "" {
		return false, nil
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() == 0 {
		return false, nil
	}
	fileDay := LocalDateStamp(info.ModTime())
	today := LocalDateStamp(now)
	if fileDay == today {
		return false, nil
	}
	archived := path + "." + fileDay
	if _, statErr := os.Stat(archived); statErr == nil {
		prev, err1 := os.ReadFile(archived)
		curr, err2 := os.ReadFile(path)
		if err1 != nil || err2 != nil {
			return false, nil
		}
		combined := make([]byte, 0, len(prev)+len(curr))
		combined = append(combined, prev...)
		combined = append(combined, curr...)
		if err := os.WriteFile(archived, combined, 0o600); err != nil {
			return false, err
		}
		if err := os.Truncate(path, 0); err != nil {
			return false, err
		}
		return true, nil
	}
	if err := os.Rename(path, archived); err != nil {
		return false, err
	}
	return true, nil
}

// PruneDatedLogs 删除超出 keepDays 的 <file>.<YYYY-MM-DD> 归档文件并返回删除数量。
func PruneDatedLogs(filePath string, keepDays int, now time.Time) int {
	trimmed := strings.TrimSpace(filePath)
	if trimmed == "" {
		return 0
	}
	if keepDays <= 0 {
		keepDays = DefaultKeepDays
	}
	dir := filepath.Dir(trimmed)
	base := filepath.Base(trimmed)
	cutoffDay := LocalDateStamp(now.Add(-time.Duration(keepDays) * DayDuration))
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	removed := 0
	prefix := base + "."
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		matches := dateSuffixPattern.FindStringSubmatch(name)
		if len(matches) != 2 || matches[1] >= cutoffDay {
			continue
		}
		if err := os.Remove(filepath.Join(dir, name)); err == nil {
			removed++
		}
	}
	return removed
}

// SweepLogs 递归清扫 logsDir 下所有 *.log / *.jsonl 及其轮转/按天归档文件。
func SweepLogs(logsDir string, opts LogSweepOptions) LogSweepReport {
	var report LogSweepReport
	root := strings.TrimSpace(logsDir)
	if root == "" {
		return report
	}
	maxBytes := opts.MaxBytes
	if maxBytes <= 0 {
		maxBytes = DefaultMaxLogBytes
	}
	keepDays := opts.KeepDays
	if keepDays <= 0 {
		keepDays = DefaultKeepDays
	}
	maxAge := opts.MaxAge
	if maxAge <= 0 {
		maxAge = time.Duration(keepDays) * DayDuration
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	now := nowFn()
	cutoffDay := LocalDateStamp(now.Add(-time.Duration(keepDays) * DayDuration))

	stack := []string{root}
	for len(stack) > 0 {
		currentDir := stack[len(stack)-1]
		stack = stack[:len(stack)-1]

		entries, err := os.ReadDir(currentDir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			name := entry.Name()
			entryPath := filepath.Join(currentDir, name)
			if entry.Type()&os.ModeSymlink != 0 {
				continue
			}
			if entry.IsDir() {
				stack = append(stack, entryPath)
				continue
			}
			if !logFilePattern.MatchString(name) {
				continue
			}
			if matches := dateSuffixPattern.FindStringSubmatch(name); len(matches) == 2 && matches[1] < cutoffDay {
				if err := os.Remove(entryPath); err == nil {
					report.Changed++
					report.Removed++
				}
				continue
			}
			if info, err := os.Stat(entryPath); err == nil && now.Sub(info.ModTime()) > maxAge {
				if err := os.Remove(entryPath); err == nil {
					report.Changed++
					report.Removed++
				}
				continue
			}
			_ = os.Chmod(entryPath, 0o600)
			if trimmed, _ := TrimFileToRecentBytes(entryPath, maxBytes); trimmed {
				report.Changed++
				report.Trimmed++
			}
		}
	}
	return report
}
