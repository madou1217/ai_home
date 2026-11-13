package sessionactivity

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

const (
	// ScopeGraceMS 是持久会话注册表时间窗口与原生会话落盘时间的时钟余量。
	ScopeGraceMS int64 = 2 * 60 * 1000
	jsonlChunkSize     = 256 * 1024
)

var (
	accountRefPattern  = regexp.MustCompile(`^acct_[a-f0-9]{20}$`)
	kiroHashDirPattern = regexp.MustCompile(`^[0-9a-f]{16}$`)
)

// IsAccountRef 校验字符串是否为合法公开账号标识（acct_ + 20 位小写十六进制）。
func IsAccountRef(value string) bool {
	return accountRefPattern.MatchString(strings.TrimSpace(value))
}

// AccountRefRecord 描述一个已知账号作用域记录。
type AccountRefRecord struct {
	Provider   string
	AccountRef string
	Enabled    bool
}

// RegistryEntry 表示 $AI_HOME/run/persistent-sessions/*.json 中的持久会话注册项，
// 兼容 Node 侧 camelCase 与 Go 侧 snake_case 字段命名。
type RegistryEntry struct {
	Provider          string
	RuntimeScope      string
	AccountRef        string
	Gateway           bool
	Socket            string
	Session           string
	Label             string
	Cwd               string
	ForwardArgs       []string
	CorrelationID     string
	NativeSessionID   string
	SupervisorManaged bool
	CreatedAtMS       int64
	UpdatedAtMS       int64
	Unrecoverable     string
}

type rawRegistryEntry struct {
	Provider               string   `json:"provider"`
	RuntimeScopeCamel      string   `json:"runtimeScope"`
	RuntimeScopeSnake      string   `json:"runtime_scope"`
	AccountRefCamel        string   `json:"accountRef"`
	AccountRefSnake        string   `json:"account_ref"`
	Gateway                bool     `json:"gateway"`
	Socket                 string   `json:"socket"`
	Session                string   `json:"session"`
	Name                   string   `json:"name"`
	Label                  string   `json:"label"`
	Cwd                    string   `json:"cwd"`
	ForwardArgsCamel       []string `json:"forwardArgs"`
	ForwardArgsSnake       []string `json:"forward_args"`
	CorrelationIDCamel     string   `json:"correlationId"`
	CorrelationIDSnake     string   `json:"correlation_id"`
	NativeSessionIDCamel   string   `json:"nativeSessionId"`
	NativeSessionIDSnake   string   `json:"native_session_id"`
	SupervisorManagedCamel bool     `json:"supervisorManaged"`
	SupervisorManagedSnake bool     `json:"supervisor_managed"`
	CreatedAtCamel         int64    `json:"createdAt"`
	CreatedAtMS            int64    `json:"created_at_ms"`
	CreatedAtSnake         int64    `json:"created_at"`
	UpdatedAtCamel         int64    `json:"updatedAt"`
	UpdatedAtMS            int64    `json:"updated_at_ms"`
	UpdatedAtSnake         int64    `json:"updated_at"`
	Unrecoverable          string   `json:"unrecoverable"`
}

func firstNonEmptyText(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func firstPositiveInt64(values ...int64) int64 {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

// ListPersistentRegistryEntries 读取 <aiHomeDir>/run/persistent-sessions/*.json。
func ListPersistentRegistryEntries(aiHomeDir string) []RegistryEntry {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil
	}
	dir := filepath.Join(root, "run", "persistent-sessions")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	out := make([]RegistryEntry, 0, len(entries))
	for _, item := range entries {
		if item.IsDir() || !strings.HasSuffix(item.Name(), ".json") {
			continue
		}
		raw, readErr := os.ReadFile(filepath.Join(dir, item.Name()))
		if readErr != nil || len(raw) == 0 {
			continue
		}
		var doc rawRegistryEntry
		if json.Unmarshal(raw, &doc) != nil {
			continue
		}
		provider := strings.ToLower(strings.TrimSpace(doc.Provider))
		accountRef := firstNonEmptyText(doc.AccountRefCamel, doc.AccountRefSnake)
		runtimeScope := firstNonEmptyText(doc.RuntimeScopeCamel, doc.RuntimeScopeSnake)
		if runtimeScope == "" && accountRef != "" {
			runtimeScope = accountRef
		}
		forwardArgs := doc.ForwardArgsCamel
		if len(forwardArgs) == 0 {
			forwardArgs = doc.ForwardArgsSnake
		}
		out = append(out, RegistryEntry{
			Provider:          provider,
			RuntimeScope:      runtimeScope,
			AccountRef:        accountRef,
			Gateway:           doc.Gateway,
			Socket:            strings.TrimSpace(doc.Socket),
			Session:           firstNonEmptyText(doc.Session, doc.Name),
			Label:             strings.TrimSpace(doc.Label),
			Cwd:               strings.TrimSpace(doc.Cwd),
			ForwardArgs:       append([]string(nil), forwardArgs...),
			CorrelationID:     firstNonEmptyText(doc.CorrelationIDCamel, doc.CorrelationIDSnake),
			NativeSessionID:   firstNonEmptyText(doc.NativeSessionIDCamel, doc.NativeSessionIDSnake),
			SupervisorManaged: doc.SupervisorManagedCamel || doc.SupervisorManagedSnake,
			CreatedAtMS:       firstPositiveInt64(doc.CreatedAtCamel, doc.CreatedAtMS, doc.CreatedAtSnake),
			UpdatedAtMS:       firstPositiveInt64(doc.UpdatedAtCamel, doc.UpdatedAtMS, doc.UpdatedAtSnake),
			Unrecoverable:     strings.TrimSpace(doc.Unrecoverable),
		})
	}
	return out
}

// ListAccountRefsFromStores 从 Go 账号库 (aih.db) 与遗留 app-state.db 汇总已知账号标识。
// 仅读不写，库文件或表缺失时视为空集。
func ListAccountRefsFromStores(ctx context.Context, aiHomeDir string) []AccountRefRecord {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil
	}
	byKey := make(map[string]AccountRefRecord)

	if appStatePath, err := appstate.DatabasePath(root); err == nil {
		if db, err := appstate.OpenReadOnly(ctx, appStatePath); err == nil {
			rows, qErr := db.QueryContext(ctx, `SELECT account_ref, provider FROM account_refs`)
			if qErr == nil {
				for rows.Next() {
					var ref, prov string
					if rows.Scan(&ref, &prov) == nil {
						prov = strings.ToLower(strings.TrimSpace(prov))
						ref = strings.TrimSpace(ref)
						if prov != "" && ref != "" {
							byKey[prov+":"+ref] = AccountRefRecord{
								Provider:   prov,
								AccountRef: ref,
								Enabled:    true,
							}
						}
					}
				}
				_ = rows.Close()
			}
			_ = db.Close()
		}
	}

	aihDBPath := filepath.Join(root, "aih.db")
	if info, err := os.Stat(aihDBPath); err == nil && info.Mode().IsRegular() {
		if db, err := sql.Open("sqlite", "file:"+aihDBPath+"?mode=ro&_busy_timeout=5000"); err == nil {
			rows, qErr := db.QueryContext(ctx, `SELECT account_ref, provider_id, enabled FROM accounts`)
			if qErr == nil {
				for rows.Next() {
					var ref, prov string
					var enabled int
					if rows.Scan(&ref, &prov, &enabled) == nil {
						prov = strings.ToLower(strings.TrimSpace(prov))
						ref = strings.TrimSpace(ref)
						if prov != "" && ref != "" {
							byKey[prov+":"+ref] = AccountRefRecord{
								Provider:   prov,
								AccountRef: ref,
								Enabled:    enabled != 0,
							}
						}
					}
				}
				_ = rows.Close()
			}
			_ = db.Close()
		}
	}

	if len(byKey) == 0 {
		return nil
	}
	keys := make([]string, 0, len(byKey))
	for k := range byKey {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]AccountRefRecord, 0, len(keys))
	for _, k := range keys {
		out = append(out, byKey[k])
	}
	return out
}

type scopeWindow struct {
	accountRef string
	cwd        string
	from       int64
	to         int64
}

// RegistryScopeOwnership 按持久会话注册表中的 (cwd + 存活窗口) 为共享会话库判定唯一归属。
// 命中 0 个或多个候选账号时返回空 accountRef（诚实降级，绝不猜测）。
type RegistryScopeOwnership struct {
	scopes []scopeWindow
}

// NewRegistryScopeOwnership 为指定 provider 构造注册表作用域归属判定器。
func NewRegistryScopeOwnership(provider, aiHomeDir string, preloaded []RegistryEntry) *RegistryScopeOwnership {
	targetProvider := strings.ToLower(strings.TrimSpace(provider))
	entries := preloaded
	if entries == nil && strings.TrimSpace(aiHomeDir) != "" && targetProvider != "" {
		entries = ListPersistentRegistryEntries(aiHomeDir)
	}
	scopes := make([]scopeWindow, 0, len(entries))
	for _, entry := range entries {
		if targetProvider == "" || entry.Provider != targetProvider {
			continue
		}
		if entry.Gateway {
			continue
		}
		accountRef := strings.TrimSpace(entry.AccountRef)
		if !IsAccountRef(accountRef) {
			continue
		}
		createdAt := entry.CreatedAtMS
		if createdAt <= 0 {
			continue
		}
		updatedAt := max(createdAt, entry.UpdatedAtMS)
		live := entry.SupervisorManaged && entry.Unrecoverable == ""
		to := updatedAt + ScopeGraceMS
		if live {
			to = math.MaxInt64
		}
		scopes = append(scopes, scopeWindow{
			accountRef: accountRef,
			cwd:        normalizeScopePath(entry.Cwd),
			from:       createdAt - ScopeGraceMS,
			to:         to,
		})
	}
	return &RegistryScopeOwnership{scopes: scopes}
}

// ScopeCount 返回参与匹配的注册表作用域数量。
func (ownership *RegistryScopeOwnership) ScopeCount() int {
	if ownership == nil {
		return 0
	}
	return len(ownership.scopes)
}

// Resolve 根据 cwd 与时间点（优先 atMS，回退 startedAtMS）解析唯一账号。
func (ownership *RegistryScopeOwnership) Resolve(cwd string, startedAtMS, atMS int64) (string, string) {
	if ownership == nil {
		return "", "no_scope"
	}
	targetAt := atMS
	if targetAt <= 0 {
		targetAt = startedAtMS
	}
	if targetAt <= 0 {
		return "", "no_start_time"
	}
	normalizedCwd := normalizeScopePath(cwd)
	matches := make(map[string]struct{}, 2)
	for _, scope := range ownership.scopes {
		if scope.cwd != "" && normalizedCwd != "" && scope.cwd != normalizedCwd {
			continue
		}
		if targetAt < scope.from || targetAt > scope.to {
			continue
		}
		matches[scope.accountRef] = struct{}{}
	}
	if len(matches) == 1 {
		for ref := range matches {
			return ref, "scope"
		}
	}
	if len(matches) > 1 {
		return "", "ambiguous_scope"
	}
	return "", "no_scope"
}

func normalizeScopePath(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "/" {
		return "/"
	}
	return strings.TrimRight(trimmed, "/")
}

func parseTimestampMS(value any) int64 {
	switch v := value.(type) {
	case float64:
		if !math.IsNaN(v) && !math.IsInf(v, 0) && v > 0 {
			return int64(math.Round(v))
		}
	case int64:
		if v > 0 {
			return v
		}
	case int:
		if v > 0 {
			return int64(v)
		}
	case string:
		raw := strings.TrimSpace(v)
		if raw == "" {
			return 0
		}
		if numeric, err := strconv.ParseInt(raw, 10, 64); err == nil && numeric > 0 {
			return numeric
		}
		if f, err := strconv.ParseFloat(raw, 64); err == nil && !math.IsNaN(f) && f > 0 {
			return int64(math.Round(f))
		}
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
			if parsed, err := time.Parse(layout, raw); err == nil {
				if ms := parsed.UnixMilli(); ms > 0 {
					return ms
				}
			}
		}
	}
	return 0
}

// DiscoverClineSessionFiles 列出宿主 ~/.cline/data/sessions 下同时包含 manifest 与 messages 文件的记录路径。
func DiscoverClineSessionFiles(hostHomeDir string) []string {
	home := strings.TrimSpace(hostHomeDir)
	if home == "" {
		return nil
	}
	root := filepath.Join(home, ".cline", "data", "sessions")
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		recordPath := filepath.Join(root, name, name+".json")
		messagesPath := filepath.Join(root, name, name+".messages.json")
		if info, err := os.Stat(recordPath); err != nil || info.IsDir() {
			continue
		}
		if info, err := os.Stat(messagesPath); err != nil || info.IsDir() {
			continue
		}
		out = append(out, recordPath)
	}
	sort.Strings(out)
	return out
}

// DiscoverKiroSessionFiles 列出宿主 ~/.kiro/sessions/<16-hex>/sess_*/messages.jsonl。
func DiscoverKiroSessionFiles(hostHomeDir string) []string {
	home := strings.TrimSpace(hostHomeDir)
	if home == "" {
		return nil
	}
	root := filepath.Join(home, ".kiro", "sessions")
	groups, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	var out []string
	for _, group := range groups {
		if !group.IsDir() || !kiroHashDirPattern.MatchString(group.Name()) {
			continue
		}
		groupDir := filepath.Join(root, group.Name())
		sessions, sErr := os.ReadDir(groupDir)
		if sErr != nil {
			continue
		}
		for _, session := range sessions {
			if !session.IsDir() || !strings.HasPrefix(session.Name(), "sess_") {
				continue
			}
			messagesPath := filepath.Join(groupDir, session.Name(), "messages.jsonl")
			if info, err := os.Stat(messagesPath); err == nil && !info.IsDir() {
				out = append(out, messagesPath)
			}
		}
	}
	sort.Strings(out)
	return out
}

// KiroSessionMeta 表示 session.json 中的会话基础元数据。
type KiroSessionMeta struct {
	SessionID   string
	Model       string
	Cwd         string
	StartedAtMS int64
}

// ReadKiroSessionMeta 从与 messages.jsonl 同目录的 session.json 读取元信息。
func ReadKiroSessionMeta(messagesPath string) KiroSessionMeta {
	sessionDir := filepath.Dir(messagesPath)
	meta := KiroSessionMeta{
		SessionID: filepath.Base(sessionDir),
	}
	raw, err := os.ReadFile(filepath.Join(sessionDir, "session.json"))
	if err != nil {
		return meta
	}
	var doc struct {
		ID             string   `json:"id"`
		ModelID        string   `json:"modelId"`
		WorkspacePaths []string `json:"workspacePaths"`
		CreatedAt      any      `json:"createdAt"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return meta
	}
	if id := strings.TrimSpace(doc.ID); id != "" {
		meta.SessionID = id
	}
	meta.Model = strings.TrimSpace(doc.ModelID)
	if len(doc.WorkspacePaths) > 0 {
		meta.Cwd = strings.TrimSpace(doc.WorkspacePaths[0])
	}
	meta.StartedAtMS = parseTimestampMS(doc.CreatedAt)
	return meta
}

// JSONLReadResult 描述一次增量 JSONL 读取后的偏移状态。
type JSONLReadResult struct {
	Offset            int64
	TrailingLineStart int64
	HadTrailingLine   bool
}

// EffectiveOffset 返回下一次安全续读的起始字节偏移（存在未换行尾行时回退到尾行起点）。
func (r JSONLReadResult) EffectiveOffset() int64 {
	if r.HadTrailingLine {
		return r.TrailingLineStart
	}
	return r.Offset
}

// ReadJSONLFromOffset 从给定字节偏移增量读取 JSONL 完整行；若末尾行尚无换行符且解析失败或半截，
// 记录 TrailingLineStart 以便下一轮完整重读。
func ReadJSONLFromOffset(filePath string, offset int64, onLine func(line string, lineOffset int64)) JSONLReadResult {
	cursor := max(int64(0), offset)
	result := JSONLReadResult{
		Offset:            cursor,
		TrailingLineStart: cursor,
	}
	f, err := os.Open(filePath)
	if err != nil {
		return result
	}
	defer func() { _ = f.Close() }()

	if _, err := f.Seek(cursor, io.SeekStart); err != nil {
		return result
	}

	buf := make([]byte, jsonlChunkSize)
	var pending bytes.Buffer
	lineStart := cursor

	emit := func(raw []byte, startOff int64) {
		raw = bytes.TrimSuffix(raw, []byte{'\r'})
		if len(bytes.TrimSpace(raw)) > 0 && onLine != nil {
			onLine(string(raw), startOff)
		}
	}

	for {
		n, readErr := f.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			pos := 0
			for pos < len(chunk) {
				relNL := bytes.IndexByte(chunk[pos:], '\n')
				if relNL < 0 {
					pending.Write(chunk[pos:])
					cursor += int64(len(chunk) - pos)
					break
				}
				pending.Write(chunk[pos : pos+relNL])
				emit(pending.Bytes(), lineStart)
				pending.Reset()
				cursor += int64(relNL + 1)
				lineStart = cursor
				pos += relNL + 1
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			break
		}
	}

	result.Offset = cursor
	if pending.Len() > 0 {
		result.HadTrailingLine = true
		result.TrailingLineStart = lineStart
	}
	return result
}

// ReadLastJSONLine 从文件末尾最多向前读取 tailBytes 字节并返回最后一条合法 JSON 对象行。
func ReadLastJSONLine(filePath string, tailBytes int64) ([]byte, bool) {
	if tailBytes <= 0 {
		tailBytes = 16 * 1024
	}
	f, err := os.Open(filePath)
	if err != nil {
		return nil, false
	}
	defer func() { _ = f.Close() }()

	info, err := f.Stat()
	if err != nil {
		return nil, false
	}
	size := info.Size()
	if size <= 0 {
		return nil, false
	}
	start := max(int64(0), size-tailBytes)
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return nil, false
	}
	buf, err := io.ReadAll(f)
	if err != nil || len(buf) == 0 {
		return nil, false
	}
	lines := bytes.Split(buf, []byte{'\n'})
	for idx := len(lines) - 1; idx >= 0; idx-- {
		if idx == 0 && start > 0 {
			// 若起点并非文件开头，首行可能被截断，直接跳过。
			continue
		}
		trimmed := bytes.TrimSpace(bytes.TrimSuffix(lines[idx], []byte{'\r'}))
		if len(trimmed) == 0 {
			continue
		}
		if json.Valid(trimmed) {
			return trimmed, true
		}
	}
	return nil, false
}
