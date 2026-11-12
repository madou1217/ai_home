package webuisessioneventsapi

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultMaxEventBytes 与 Node 的 CODEX_SESSION_EVENTS_MAX_BYTES 一致。
	DefaultMaxEventBytes = 4 << 20
	// codexIndexTTL 是 codex 会话索引的复用窗口；未命中会立即重建。
	codexIndexTTL = 30 * time.Second
	// maxCodexIndexEntries 是索引遍历的文件数上限，防止超大宿主拖慢首帧。
	maxCodexIndexEntries = 50000
)

// FileReader 是 Reader 的默认实现：读取宿主 HOME 下的 codex rollout JSONL。
//
// 只承接 codex：其它 Provider 的增量事件在 Node 侧依赖各自的会话定位器
// （SQLite / 账号投影），本包显式返回 ErrUnsupportedProvider，由 Node 继续处理。
type FileReader struct {
	// HostHomeDir 是宿主用户目录（.codex 在它下面）。
	HostHomeDir string
	// MaxEventBytes 覆盖 DefaultMaxEventBytes；<=0 时使用默认值。
	MaxEventBytes int

	mu             sync.Mutex
	codexIndex     map[string]string
	codexIndexedAt time.Time
	now            func() time.Time
}

// ReadEvents 实现 Reader。
func (reader *FileReader) ReadEvents(ctx context.Context, request EventRequest) (EventResult, error) {
	if err := ctx.Err(); err != nil {
		return EventResult{}, err
	}
	provider := strings.ToLower(strings.TrimSpace(request.Provider))
	if provider != "codex" {
		return EventResult{}, ErrUnsupportedProvider
	}
	filePath, found := reader.resolveCodexTranscript(strings.TrimSpace(request.SessionID))
	if !found {
		// Node 的 state DB 可能定位到 sessions 目录之外的 rollout；Go 找不到时必须显式报
		// not_found，让 Node 代理回落，而不是用「空事件」把真实增量吞掉。
		return EventResult{}, ErrSessionNotFound
	}
	return reader.readCodexEvents(ctx, filePath, request.Cursor)
}

func (reader *FileReader) maxEventBytes() int {
	if reader.MaxEventBytes > 0 {
		return reader.MaxEventBytes
	}
	return DefaultMaxEventBytes
}

func (reader *FileReader) hostHome() string {
	return strings.TrimSpace(reader.HostHomeDir)
}

func (reader *FileReader) clock() time.Time {
	if reader.now != nil {
		return reader.now()
	}
	return time.Now()
}

// resolveCodexTranscript 在 ~/.codex/sessions 下按文件名里的会话 ID 定位 rollout 文件。
//
// 文件名形如 rollout-2026-11-04T20-31-00-<uuid>.jsonl。Node 先查 state DB，再递归
// 匹配文件名；本切片只做递归匹配 + 短 TTL 索引（与 sessions/previews 同口径），
// 找不到时返回 false，由 Node 代理回落到它自己的 state DB 解析。
func (reader *FileReader) resolveCodexTranscript(sessionID string) (string, bool) {
	if sessionID == "" {
		return "", false
	}
	if filePath, ok := reader.lookupCodexIndex(sessionID, false); ok {
		return filePath, true
	}
	// 未命中可能是新会话，也可能是索引过期；立即重建一次再判定。
	return reader.lookupCodexIndex(sessionID, true)
}

func (reader *FileReader) lookupCodexIndex(sessionID string, force bool) (string, bool) {
	reader.mu.Lock()
	defer reader.mu.Unlock()
	if !force && reader.codexIndex != nil && reader.clock().Sub(reader.codexIndexedAt) < codexIndexTTL {
		filePath, ok := reader.codexIndex[sessionID]
		return filePath, ok
	}
	reader.codexIndex = reader.buildCodexIndex()
	reader.codexIndexedAt = reader.clock()
	filePath, ok := reader.codexIndex[sessionID]
	return filePath, ok
}

func (reader *FileReader) buildCodexIndex() map[string]string {
	index := make(map[string]string)
	root := filepath.Join(reader.hostHome(), ".codex", "sessions")
	count := 0
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		count++
		if count > maxCodexIndexEntries {
			return filepath.SkipAll
		}
		if !strings.HasSuffix(entry.Name(), ".jsonl") {
			return nil
		}
		if sessionID := codexSessionIDFromFileName(entry.Name()); sessionID != "" {
			index[sessionID] = path
		}
		return nil
	})
	return index
}

// codexSessionIDFromFileName 从 rollout 文件名里取出末尾 UUID；不符合时返回空串。
func codexSessionIDFromFileName(name string) string {
	base := strings.TrimSuffix(name, ".jsonl")
	// rollout-<date>T<time>-<uuid>：UUID 是 36 个字符，前面一定是 '-'。
	if len(base) < 36 {
		return ""
	}
	candidate := base[len(base)-36:]
	if !isUUID(candidate) {
		return ""
	}
	return candidate
}

func isUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, char := range value {
		switch index {
		case 8, 13, 18, 23:
			if char != '-' {
				return false
			}
		default:
			if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
				return false
			}
		}
	}
	return true
}

func boolPointer(value bool) *bool {
	return &value
}
