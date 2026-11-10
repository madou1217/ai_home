package webuisessionpreviewsapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// 预览读取的错误分类。Handler 只把这些错误翻成稳定的 per-item 错误码，
// 底层 os 错误不会出现在响应里（避免把宿主路径泄漏给浏览器）。
var (
	// ErrUnsupportedProvider 表示该 Provider 的会话真相不在单个文本 transcript 里
	// （SQLite / 原生 DB 承载），本包不猜格式。
	ErrUnsupportedProvider = errors.New("该 Provider 的会话预览尚未由 Go 承接")
	// ErrSessionNotFound 表示按 provider + sessionId 找不到会话文件。
	ErrSessionNotFound = errors.New("会话文件不存在")
	// ErrInvalidSessionRef 表示 sessionId / projectDirName 不是安全的单段路径。
	ErrInvalidSessionRef = errors.New("会话引用不是安全的单段路径")
	// ErrReadFailed 表示文件存在但读取或解析失败。
	ErrReadFailed = errors.New("会话文件读取失败")
)

const (
	// DefaultMaxFileBytes 是单个 transcript 的读取上限（只读尾部窗口）。
	//
	// 预览只需要最后一条消息与最后出现的 model，读整个文件没有收益：
	// 一个长会话的 jsonl 可以到几十 MB，而列表展开一次就要读几十个。
	DefaultMaxFileBytes = int64(2 << 20)
	// previewMaxRunes 与 Node 的 slice(0, 140) 对齐；按 rune 截断避免切坏 UTF-8。
	previewMaxRunes = 140
	// maxTranscriptLineBytes 是单行 JSON 的上限；超长行（巨型工具输出）直接跳过。
	maxTranscriptLineBytes = 4 << 20
	// maxProjectDirs 是无 projectDirName 时允许扫描的项目目录数量上限。
	maxProjectDirs = 2000
	// codexIndexTTL 是 codex 会话索引的复用窗口；命中失败会立即重建。
	codexIndexTTL = 30 * time.Second
	// maxCodexIndexEntries 是 codex 索引遍历的文件数上限，防止超大宿主拖慢首帧。
	maxCodexIndexEntries = 50000
)

// PreviewRequest 是一条待读取的会话引用。
//
// AccountRef 只作为上层语义携带，文件布局按 provider + projectDirName 定位：
// 会话文件都在宿主 HOME 下，与账号归属无关。
type PreviewRequest struct {
	Provider       string
	SessionID      string
	ProjectDirName string
	AccountRef     string
}

// Preview 是一条会话的惰性富化结果；读取失败时两个字段都为空。
type Preview struct {
	Model   string
	Preview string
}

// Reader 是按会话读取「最后模型 + 最后消息预览」的端口。
//
// 它只做单会话定位与尾部读取，不做项目/会话列表扫描——列表事实仍由 Node 的
// projects 快照提供，避免出现第二套扫描口径。
type Reader interface {
	ReadPreview(ctx context.Context, request PreviewRequest) (Preview, error)
}

// FileReader 是 Reader 的默认实现：读取宿主 HOME 下的文本 transcript。
//
// 覆盖范围只包含能由「单个 jsonl/json 文件」证明的 Provider：
// claude、codebuddy 家族（codebuddy/codebuddycn/workbuddy/workbuddycn）、codex。
// opencode/zcode/kiro/cline/agy/gemini/qoder/grok 的会话真相在 SQLite 或
// 多文件目录里，这里显式返回 ErrUnsupportedProvider，由调用方决定回落，
// 不猜格式以免给出错的模型或预览。
type FileReader struct {
	// HostHomeDir 是宿主用户目录（会话文件都在它下面）。
	HostHomeDir string
	// MaxFileBytes 覆盖 DefaultMaxFileBytes；<=0 时使用默认值。
	MaxFileBytes int64

	mu             sync.Mutex
	codexIndex     map[string]string
	codexIndexedAt time.Time
	now            func() time.Time
}

// NewFileReader 创建读取宿主 HOME 下 transcript 的默认 Reader。
func NewFileReader(hostHomeDir string) *FileReader {
	return &FileReader{HostHomeDir: hostHomeDir}
}

// ReadPreview 实现 Reader。
func (reader *FileReader) ReadPreview(ctx context.Context, request PreviewRequest) (Preview, error) {
	if err := ctx.Err(); err != nil {
		return Preview{}, err
	}
	filePath, err := reader.resolveSessionFile(request)
	if err != nil {
		return Preview{}, err
	}
	return reader.readTranscriptTail(ctx, filePath)
}

// resolveSessionFile 按 Provider 的文件布局定位会话文件。
func (reader *FileReader) resolveSessionFile(request PreviewRequest) (string, error) {
	provider := strings.ToLower(strings.TrimSpace(request.Provider))
	sessionID := strings.TrimSpace(request.SessionID)
	if sessionID == "" {
		return "", ErrSessionNotFound
	}
	if !isSafePathSegment(sessionID) {
		return "", ErrInvalidSessionRef
	}
	projectDirName := strings.TrimSpace(request.ProjectDirName)
	if projectDirName != "" && !isSafePathSegment(projectDirName) {
		// projectDirName 来自请求体，直接拼进路径就是目录穿越。
		return "", ErrInvalidSessionRef
	}
	home := reader.hostHome()
	if home == "" {
		return "", ErrSessionNotFound
	}

	if provider == "claude" {
		return resolveProjectTranscript(filepath.Join(home, ".claude", "projects"), sessionID, projectDirName)
	}
	if roots := codebuddyProjectsRoots(provider); len(roots) > 0 {
		for _, dirName := range roots {
			filePath, err := resolveProjectTranscript(filepath.Join(home, dirName, "projects"), sessionID, projectDirName)
			if err == nil {
				return filePath, nil
			}
			// 目录穿越是请求本身的问题，不能因为换一个根目录就吞掉。
			if errors.Is(err, ErrInvalidSessionRef) {
				return "", err
			}
		}
		return "", ErrSessionNotFound
	}
	if provider == "codex" {
		return reader.resolveCodexTranscript(sessionID)
	}
	return "", ErrUnsupportedProvider
}

// resolveProjectTranscript 在 <root>/<projectDirName>/<sessionId>.jsonl 里定位会话。
//
// projectDirName 缺失时按目录名扫描（Node 的 codebuddy 读取器同样允许这种模糊定位），
// 目录数量有上限，避免在宿主 HOME 上做无界遍历。
func resolveProjectTranscript(projectsRoot, sessionID, projectDirName string) (string, error) {
	if projectDirName != "" {
		candidate := filepath.Join(projectsRoot, projectDirName, sessionID+".jsonl")
		if isRegularFile(candidate) {
			return candidate, nil
		}
		return "", ErrSessionNotFound
	}
	entries, err := os.ReadDir(projectsRoot)
	if err != nil {
		return "", ErrSessionNotFound
	}
	scanned := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		scanned++
		if scanned > maxProjectDirs {
			break
		}
		candidate := filepath.Join(projectsRoot, entry.Name(), sessionID+".jsonl")
		if isRegularFile(candidate) {
			return candidate, nil
		}
	}
	return "", ErrSessionNotFound
}

// resolveCodexTranscript 在 ~/.codex/sessions 下按文件名里的会话 ID 定位 rollout 文件。
//
// 文件名形如 rollout-2026-11-04T20-31-00-<uuid>.jsonl，会话 ID 是末尾 UUID。
// Node 会先查 state db 再回落到文件遍历；这里只做遍历 + 短 TTL 索引：
// 一次批量展开几十个会话时不能每个会话都重扫一遍目录。
func (reader *FileReader) resolveCodexTranscript(sessionID string) (string, error) {
	if filePath, ok := reader.lookupCodexIndex(sessionID, false); ok {
		return filePath, nil
	}
	// 未命中可能是新会话，也可能是索引过期；立即重建一次再判定。
	if filePath, ok := reader.lookupCodexIndex(sessionID, true); ok {
		return filePath, nil
	}
	return "", ErrSessionNotFound
}

func (reader *FileReader) lookupCodexIndex(sessionID string, force bool) (string, bool) {
	reader.mu.Lock()
	defer reader.mu.Unlock()
	if !force && reader.codexIndex != nil && reader.clock().Sub(reader.codexIndexedAt) < codexIndexTTL {
		if filePath, ok := reader.codexIndex[sessionID]; ok {
			return filePath, true
		}
		return "", false
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
			if !strings.ContainsRune("0123456789abcdefABCDEF", char) {
				return false
			}
		}
	}
	return true
}

var modelPattern = regexp.MustCompile(`"model"\s*:\s*"([^"]{1,80})"`)

// readTranscriptTail 只读文件尾部窗口，从中取最后一个 model 与最后一条助手/用户文本。
func (reader *FileReader) readTranscriptTail(ctx context.Context, filePath string) (Preview, error) {
	file, err := os.Open(filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Preview{}, ErrSessionNotFound
		}
		return Preview{}, ErrReadFailed
	}
	defer func() { _ = file.Close() }()

	info, err := file.Stat()
	if err != nil {
		return Preview{}, ErrReadFailed
	}
	if !info.Mode().IsRegular() {
		return Preview{}, ErrSessionNotFound
	}
	limit := reader.MaxFileBytes
	if limit <= 0 {
		limit = DefaultMaxFileBytes
	}
	offset := int64(0)
	if info.Size() > limit {
		offset = info.Size() - limit
	}
	section := io.NewSectionReader(file, offset, info.Size()-offset)
	tail, err := io.ReadAll(section)
	if err != nil {
		return Preview{}, ErrReadFailed
	}
	if offset > 0 {
		// 窗口起点可能落在行中间：丢掉第一段残行。
		if index := bytes.IndexByte(tail, '\n'); index >= 0 {
			tail = tail[index+1:]
		} else {
			tail = nil
		}
	}

	preview := Preview{}
	if matches := modelPattern.FindAllSubmatch(tail, -1); len(matches) > 0 {
		preview.Model = string(matches[len(matches)-1][1])
	}
	preview.Preview = extractPreviewFromTranscript(ctx, tail)
	return preview, nil
}

// extractPreviewFromTranscript 顺序扫描窗口内的 JSONL，保留最后一条助手文本
// （没有助手文本时回落到最后一条用户文本）。
func extractPreviewFromTranscript(ctx context.Context, tail []byte) string {
	lastAssistant := ""
	lastUser := ""
	scanner := bufio.NewScanner(strings.NewReader(string(tail)))
	scanner.Buffer(make([]byte, 0, 64<<10), maxTranscriptLineBytes)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return ""
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" || line[0] != '{' {
			continue
		}
		role, text := transcriptRecordText(line)
		if text == "" {
			continue
		}
		switch role {
		case "assistant":
			lastAssistant = text
		case "user":
			lastUser = text
		}
	}
	if lastAssistant != "" {
		return normalizePreviewText(lastAssistant)
	}
	return normalizePreviewText(lastUser)
}

// transcriptEnvelope 覆盖 claude/codebuddy（message）与 codex（payload）两种外壳。
type transcriptEnvelope struct {
	Type    string          `json:"type"`
	Role    string          `json:"role"`
	Message json.RawMessage `json:"message"`
	Payload json.RawMessage `json:"payload"`
}

type transcriptMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type transcriptPayload struct {
	Type    string          `json:"type"`
	Role    string          `json:"role"`
	Message string          `json:"message"`
	Content json.RawMessage `json:"content"`
}

type transcriptContentPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// transcriptRecordText 从一条记录里取出角色与可见文本；非对话记录返回空。
func transcriptRecordText(line string) (string, string) {
	var envelope transcriptEnvelope
	if err := json.Unmarshal([]byte(line), &envelope); err != nil {
		return "", ""
	}
	if len(envelope.Message) > 0 {
		var message transcriptMessage
		if err := json.Unmarshal(envelope.Message, &message); err != nil {
			return "", ""
		}
		role := strings.ToLower(strings.TrimSpace(message.Role))
		if role == "" {
			role = strings.ToLower(strings.TrimSpace(envelope.Type))
		}
		if role != "assistant" && role != "user" {
			return "", ""
		}
		return role, contentText(message.Content)
	}
	if len(envelope.Payload) > 0 {
		var payload transcriptPayload
		if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
			return "", ""
		}
		switch payload.Type {
		case "message":
			role := strings.ToLower(strings.TrimSpace(payload.Role))
			if role != "assistant" && role != "user" {
				return "", ""
			}
			return role, contentText(payload.Content)
		case "agent_message":
			return "assistant", payload.Message
		case "user_message":
			return "user", payload.Message
		}
		return "", ""
	}
	return "", ""
}

// contentText 把 content（字符串或分片数组）拍平成文本。
func contentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return text
	}
	var parts []transcriptContentPart
	if err := json.Unmarshal(raw, &parts); err != nil {
		return ""
	}
	builder := strings.Builder{}
	for _, part := range parts {
		if part.Text == "" {
			continue
		}
		if builder.Len() > 0 {
			builder.WriteByte(' ')
		}
		builder.WriteString(part.Text)
	}
	return builder.String()
}

// normalizePreviewText 与 Node 一致：折叠所有空白、去首尾，再截到 140 个字符。
func normalizePreviewText(text string) string {
	collapsed := strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(collapsed) <= previewMaxRunes {
		return collapsed
	}
	return string([]rune(collapsed)[:previewMaxRunes])
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

// codebuddyProjectsRoots 返回该 Provider 在宿主 HOME 下的候选配置根目录名。
//
// 同一地区的 CLI 与桌面端共用一份物理会话存储（软链接），按顺序取第一个命中的。
func codebuddyProjectsRoots(provider string) []string {
	switch provider {
	case "codebuddy":
		return []string{".codebuddy", ".workbuddy-ai"}
	case "workbuddy":
		return []string{".workbuddy-ai", ".codebuddy"}
	case "codebuddycn":
		return []string{".codebuddy-cn", ".workbuddy"}
	case "workbuddycn":
		return []string{".workbuddy", ".codebuddy-cn"}
	default:
		return nil
	}
}

// isSafePathSegment 拒绝空串、分隔符与上跳，保证拼进路径的值只有一段。
func isSafePathSegment(value string) bool {
	if value == "" || value == "." || value == ".." {
		return false
	}
	if strings.ContainsAny(value, `/\`) {
		return false
	}
	return filepath.Base(value) == value
}

func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}
