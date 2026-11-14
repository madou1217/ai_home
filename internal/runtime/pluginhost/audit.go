package pluginhost

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultAuditMaxBytes 与 Node lib/plugins/control/audit.js 的 8MB 轮转阈值保持一致。
	DefaultAuditMaxBytes int64 = 8 * 1024 * 1024
	// DefaultAuditReadLimit 是未指定条数时默认读取的尾部审计行数。
	DefaultAuditReadLimit = 100
	// MaxAuditReadLimit 限制单次最多读取的审计行数，防止大日志撑爆响应。
	MaxAuditReadLimit = 1000
	auditTimeLayout   = "2006-01-02T15:04:05.000Z"
)

// AuditRecord 表示单条插件控制面或数据面生命周期审计记录。
type AuditRecord map[string]any

// AuditOption 配置 AuditLog 实例。
type AuditOption func(*AuditLog)

// WithAuditNow 覆盖审计日志时钟（测试使用）。
func WithAuditNow(now func() time.Time) AuditOption {
	return func(a *AuditLog) {
		if now != nil {
			a.now = now
		}
	}
}

// WithAuditMaxBytes 覆盖审计日志轮转字节上限（测试使用）。
func WithAuditMaxBytes(maxBytes int64) AuditOption {
	return func(a *AuditLog) {
		if maxBytes > 0 {
			a.maxBytes = maxBytes
		}
	}
}

// AuditLog 将插件控制与运行时关键操作追加到 <AIHomeDir>/plugins/audit.log，
// 语义与 Node lib/plugins/control/audit.js 逐字节兼容（0700 目录、0600 文件、8MB 轮转为 .1）。
type AuditLog struct {
	mu       sync.Mutex
	filePath string
	maxBytes int64
	now      func() time.Time
}

// NewAuditLog 构造插件审计日志读写器；aiHomeDir 为空时退化为仅返回记录、不落盘的空实现。
func NewAuditLog(aiHomeDir string, options ...AuditOption) *AuditLog {
	root := strings.TrimSpace(aiHomeDir)
	filePath := ""
	if root != "" {
		filePath = filepath.Join(root, "plugins", "audit.log")
	}
	log := &AuditLog{
		filePath: filePath,
		maxBytes: DefaultAuditMaxBytes,
		now:      time.Now,
	}
	for _, option := range options {
		if option != nil {
			option(log)
		}
	}
	return log
}

// Path 返回底层 audit.log 文件路径；未配置数据根时返回空字符串。
func (a *AuditLog) Path() string {
	if a == nil {
		return ""
	}
	return a.filePath
}

// Append 追加一条带 UTC 时间戳与事件名的扁平 JSONL 审计记录。
// 审计落盘失败会被静默吞掉，绝不阻断插件主操作。
func (a *AuditLog) Append(event string, details map[string]any) AuditRecord {
	record := make(AuditRecord, len(details)+2)
	for key, value := range details {
		record[key] = value
	}
	nowFn := time.Now
	if a != nil && a.now != nil {
		nowFn = a.now
	}
	record["at"] = nowFn().UTC().Format(auditTimeLayout)
	record["event"] = event

	if a == nil || a.filePath == "" {
		return record
	}

	line, err := json.Marshal(record)
	if err != nil {
		return record
	}
	line = append(line, '\n')

	a.mu.Lock()
	defer a.mu.Unlock()

	if mkErr := os.MkdirAll(filepath.Dir(a.filePath), 0o700); mkErr != nil {
		return record
	}
	if a.maxBytes > 0 {
		if info, statErr := os.Stat(a.filePath); statErr == nil && info.Size() >= a.maxBytes {
			_ = os.Rename(a.filePath, a.filePath+".1")
		}
	}
	file, openErr := os.OpenFile(a.filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if openErr != nil {
		return record
	}
	_, _ = file.Write(line)
	_ = file.Close()
	_ = os.Chmod(a.filePath, 0o600)
	return record
}

// Read 从 audit.log 尾部读取最多 limit 条审计记录；limit==0 默认 100，并裁剪到 [1, 1000]。
// 遇到损坏的 JSON 行时保留占位记录 {"at":"","event":"audit_record_invalid"}。
func (a *AuditLog) Read(limit int) []AuditRecord {
	effectiveLimit := clampAuditLimit(limit)
	if a == nil || a.filePath == "" {
		return []AuditRecord{}
	}

	a.mu.Lock()
	raw, err := os.ReadFile(a.filePath)
	a.mu.Unlock()
	if err != nil {
		return []AuditRecord{}
	}

	rawLines := strings.Split(string(raw), "\n")
	lines := make([]string, 0, len(rawLines))
	for _, line := range rawLines {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) > effectiveLimit {
		lines = lines[len(lines)-effectiveLimit:]
	}

	records := make([]AuditRecord, 0, len(lines))
	for _, line := range lines {
		var parsed AuditRecord
		if err := json.Unmarshal([]byte(line), &parsed); err != nil || parsed == nil {
			records = append(records, AuditRecord{
				"at":    "",
				"event": "audit_record_invalid",
			})
			continue
		}
		records = append(records, parsed)
	}
	return records
}

func clampAuditLimit(limit int) int {
	if limit == 0 {
		return DefaultAuditReadLimit
	}
	if limit < 0 {
		return 1
	}
	if limit > MaxAuditReadLimit {
		return MaxAuditReadLimit
	}
	return limit
}
