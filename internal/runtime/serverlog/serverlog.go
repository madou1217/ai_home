// Package serverlog 提供按天滚动、默认保留 30 天的服务器日志文件。
//
// 进程的标准日志和结构化事件都写入 ~/.ai_home/logs/server/YYYY-MM-DD.log：
// 标准日志是原有的文本行，结构化事件是单行 JSON（以 "evt" 区分类型），
// 便于用 jq / grep 按账号、模型、语义检索。跨天时自动切换文件，并在启动
// 与切换时清理超保留期的旧文件。
//
// 设计边界：
//   - 写入失败不改变请求语义：日志是观测面，不是业务依赖；
//   - 只接收低敏字段（账号引用、模型、错误语义、上游 code），不接收提示词、
//     响应正文、请求头或凭据；
//   - 未安装时 Emit 静默丢弃，测试或 CLI 子命令不必初始化日志。
package serverlog

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultRetentionDays 是日志文件的默认保留天数。
	DefaultRetentionDays = 30
	// DirName 是相对 AIH_HOME 的日志目录名。
	DirName = "server"
	// fileLayout 是天文件名格式；按字符串比较即可判断过期。
	fileLayout = "2006-01-02"
)

// Sink 是「按天一个文件」的日志写入器。
type Sink struct {
	dir           string
	retentionDays int
	now           func() time.Time

	mu   sync.Mutex
	file *os.File
	day  string
}

// Write 实现 io.Writer：写入当天的日志文件，跨天时切换。
func (sink *Sink) Write(p []byte) (int, error) {
	if sink == nil {
		return len(p), nil
	}
	sink.mu.Lock()
	defer sink.mu.Unlock()
	if err := sink.ensureLocked(); err != nil {
		return 0, err
	}
	return sink.file.Write(p)
}

// emit 写一条结构化事件（单行 JSON），失败时静默忽略。
func (sink *Sink) emit(event string, payload any) {
	if sink == nil {
		return
	}
	line, err := formatEvent(event, payload, sink.now())
	if err != nil {
		return
	}
	sink.mu.Lock()
	defer sink.mu.Unlock()
	if err := sink.ensureLocked(); err != nil {
		return
	}
	_, _ = sink.file.Write(line)
}

// ensureLocked 保证当天文件已打开，并在切换时裁剪过期文件。
func (sink *Sink) ensureLocked() error {
	now := sink.now()
	day := now.Format(fileLayout)
	if sink.file != nil && sink.day == day {
		return nil
	}
	if sink.file != nil {
		_ = sink.file.Close()
		sink.file = nil
	}
	if err := os.MkdirAll(sink.dir, 0o755); err != nil {
		return err
	}
	file, err := os.OpenFile(
		filepath.Join(sink.dir, day+".log"),
		os.O_CREATE|os.O_WRONLY|os.O_APPEND,
		0o644,
	)
	if err != nil {
		return err
	}
	sink.file, sink.day = file, day
	sink.pruneLocked(now)
	return nil
}

// pruneLocked 删除超过保留期的 day 文件（只认 YYYY-MM-DD.log 命名）。
func (sink *Sink) pruneLocked(now time.Time) {
	entries, err := os.ReadDir(sink.dir)
	if err != nil {
		return
	}
	cutoff := now.AddDate(0, 0, -sink.retentionDays).Format(fileLayout)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".log") {
			continue
		}
		day := strings.TrimSuffix(name, ".log")
		if len(day) != len(fileLayout) {
			continue
		}
		if day < cutoff {
			_ = os.Remove(filepath.Join(sink.dir, name))
		}
	}
}

// formatEvent 把事件名与载荷拼成单行 JSON：{"ts":...,"evt":...,<payload 字段>}。
//
// payload 是 JSON 对象时字段直接展开，便于 grep；其他形态退回只写事件名。
func formatEvent(event string, payload any, now time.Time) ([]byte, error) {
	head := fmt.Sprintf(`{"ts":%q,"evt":%q`, now.Format(time.RFC3339), event)
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) >= 2 && trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}' {
		inner := bytes.TrimSpace(trimmed[1 : len(trimmed)-1])
		if len(inner) > 0 {
			line := make([]byte, 0, len(head)+len(inner)+4)
			line = append(line, head...)
			line = append(line, ',')
			line = append(line, inner...)
			line = append(line, '}', '\n')
			return line, nil
		}
	}
	return []byte(head + "}\n"), nil
}

var (
	defaultMu   sync.RWMutex
	defaultSink *Sink
)

// Install 打开当天日志文件，把标准日志同时写到文件与 mirror，并启用事件输出。
//
// mirror 为 nil 时只写文件；launchd 的重定向文件不应作为主日志，避免无界增长。
// 重复调用是幂等的：已经安装过时直接返回 nil，不再叠加输出目标。
func Install(homeDir string, retentionDays int, mirror io.Writer) error {
	if strings.TrimSpace(homeDir) == "" {
		return fmt.Errorf("serverlog: home dir is required")
	}
	if retentionDays <= 0 || retentionDays > 3650 {
		retentionDays = DefaultRetentionDays
	}
	defaultMu.Lock()
	installed := defaultSink != nil
	defaultMu.Unlock()
	if installed {
		return nil
	}
	sink := &Sink{
		dir:           filepath.Join(homeDir, "logs", DirName),
		retentionDays: retentionDays,
		now:           time.Now,
	}
	// 立即打开一次：目录不可写要在启动时暴露，而不是等到第一条日志。
	if err := func() error {
		sink.mu.Lock()
		defer sink.mu.Unlock()
		return sink.ensureLocked()
	}(); err != nil {
		return err
	}
	writers := []io.Writer{sink}
	if mirror != nil {
		writers = append(writers, mirror)
	}
	log.SetOutput(io.MultiWriter(writers...))
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	defaultMu.Lock()
	defaultSink = sink
	defaultMu.Unlock()
	return nil
}

// Writer 返回「当天文件（可选 mirror）」的写入器，供自带前缀的 logger 复用。
func Writer(mirror io.Writer) io.Writer {
	defaultMu.RLock()
	sink := defaultSink
	defaultMu.RUnlock()
	if sink == nil {
		if mirror == nil {
			return io.Discard
		}
		return mirror
	}
	if mirror == nil {
		return sink
	}
	return io.MultiWriter(sink, mirror)
}

// Emit 写一条结构化事件；未安装时静默丢弃。
func Emit(event string, payload any) {
	defaultMu.RLock()
	sink := defaultSink
	defaultMu.RUnlock()
	if sink == nil {
		return
	}
	sink.emit(event, payload)
}
