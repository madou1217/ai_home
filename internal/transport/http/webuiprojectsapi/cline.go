package webuiprojectsapi

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	clineProvider = "cline"
	// clineRecordLimit 与 Node 的 DEFAULT_RECORD_LIMIT 一致：每个会话库最多读 400 行。
	clineRecordLimit = 400
	// clineTitleMaxRunes 与 Node 的 TITLE_MAX_LENGTH 一致：超过 120 字符截断。
	clineTitleMaxRunes = 120
)

// clineSessionIDPattern 是 cline 原生会话 id 的形状（<epoch-ms>_<base36 后缀>）。
var clineSessionIDPattern = regexp.MustCompile("(?i)^[0-9]{10,}_[a-z0-9]{3,}$")

// clineUserInputPatterns 剥掉 prompt 里的 <user_input> 包装（Node compactTitle 同口径）。
var clineUserInputPatterns = []*regexp.Regexp{
	regexp.MustCompile("(?i)<user_input(?:\\s+[^>]*)?>"),
	regexp.MustCompile("(?i)</user_input>"),
}

// clineSessionRecordColumns 是读取会话库时关心的列；按实际存在的列裁剪，
// 版本增列/缺列不会让整段历史读不出来。
var clineSessionRecordColumns = []string{
	"session_id", "started_at", "updated_at", "cwd", "workspace_root",
	"status", "pid", "prompt", "model", "provider", "messages_path",
}

// clineRecord 是从会话库或单会话 JSON 读到的一条会话事实。
type clineRecord struct {
	SessionID   string
	StartedAtMs int64
	UpdatedAtMs int64
	Cwd         string
	Title       string
}

// clineProjects 扫描宿主与账号投影里的 cline 会话库，按 cwd 归项目。
func (scan *scanner) clineProjects() []rawProject {
	records := scan.readClineRecords()

	byPath := make(map[string]map[string]clineRecord, 16)
	order := make([]string, 0, 16)
	for _, record := range records {
		if scan.outOfTime() {
			break
		}
		projectPath := record.Cwd
		if projectPath == "" {
			continue
		}
		if _, exists := byPath[projectPath]; !exists {
			order = append(order, projectPath)
			byPath[projectPath] = make(map[string]clineRecord)
		}
		previous, exists := byPath[projectPath][record.SessionID]
		// 与 Node mergeAccountScopedProjects 一致：同 id 取 updatedAt 更新（含并列）的一份。
		if !exists || record.UpdatedAtMs >= previous.UpdatedAtMs {
			byPath[projectPath][record.SessionID] = record
		}
	}

	projects := make([]rawProject, 0, len(order))
	for _, projectPath := range order {
		sessions := make([]rawSession, 0, len(byPath[projectPath]))
		for _, record := range byPath[projectPath] {
			title := record.Title
			if title == "" {
				title = record.SessionID
			}
			sessions = append(sessions, rawSession{
				ID:             record.SessionID,
				Title:          title,
				UpdatedAt:      record.UpdatedAtMs,
				Provider:       clineProvider,
				ProjectDirName: projectPath,
			})
		}
		sort.SliceStable(sessions, func(left, right int) bool {
			return sessions[left].UpdatedAt > sessions[right].UpdatedAt
		})
		projects = append(projects, rawProject{
			ID:       clineProjectID(projectPath),
			Name:     projectBaseName(projectPath),
			Path:     projectPath,
			Provider: clineProvider,
			Sessions: sessions,
		})
	}
	return projects
}

// readClineRecords 跨账号归并 cline 会话事实。
//
// 数据面：宿主 <hostHome>/.cline/data 与账号投影
// <aiHome>/run/auth-projections/cline/<ref>/.cline/data。每个库各读各的（不合并库、
// 不复制行）；所有库都没有记录时，按 Node 口径回退宿主的单会话 JSON。
func (scan *scanner) readClineRecords() []clineRecord {
	records := make([]clineRecord, 0, 64)
	for _, databasePath := range scan.clineDatabasePaths() {
		if scan.outOfTime() {
			return records
		}
		records = append(records, readClineRecordsFromDatabase(scan.ctx, databasePath)...)
	}
	if len(records) > 0 {
		return records
	}
	return readClineRecordsFromJSON(filepath.Join(scan.hostHome, ".cline", "data", "sessions"))
}

// clineDatabasePaths 返回宿主与全部账号投影的 sessions.db（宿主在前）。
func (scan *scanner) clineDatabasePaths() []string {
	dataDirs := make([]string, 0, 8)
	seen := make(map[string]bool, 8)
	add := func(dataDir string) {
		if dataDir == "" || seen[dataDir] {
			return
		}
		seen[dataDir] = true
		dataDirs = append(dataDirs, dataDir)
	}

	if scan.hostHome != "" {
		add(filepath.Join(scan.hostHome, ".cline", "data"))
	}
	if scan.aiHome != "" {
		providerRoot := filepath.Join(scan.aiHome, "run", "auth-projections", "cline")
		for _, ref := range scan.subdirectories(providerRoot) {
			add(filepath.Join(providerRoot, ref, ".cline", "data"))
		}
	}

	paths := make([]string, 0, len(dataDirs))
	for _, dataDir := range dataDirs {
		paths = append(paths, filepath.Join(dataDir, "db", "sessions.db"))
	}
	return paths
}

// readClineRecordsFromDatabase 读取一个 sessions.db；表缺列或库打不开时返回空。
func readClineRecordsFromDatabase(ctx context.Context, databasePath string) []clineRecord {
	database, ok := openReadOnlySQLite(ctx, databasePath)
	if !ok {
		return nil
	}
	defer func() { _ = database.Close() }()

	columns, ok := sqliteTableColumns(ctx, database, "sessions")
	if !ok || !columns["session_id"] || !columns["started_at"] {
		return nil
	}
	selected := make([]string, 0, len(clineSessionRecordColumns))
	for _, column := range clineSessionRecordColumns {
		if columns[column] {
			selected = append(selected, column)
		}
	}
	query := fmt.Sprintf(
		"SELECT %s FROM sessions ORDER BY started_at DESC LIMIT %d",
		strings.Join(selected, ", "), clineRecordLimit,
	)
	rows, err := database.QueryContext(ctx, query)
	if err != nil {
		return nil
	}

	records := make([]clineRecord, 0, 64)
	for rows.Next() {
		values := make([]any, len(selected))
		pointers := make([]any, len(selected))
		for index := range values {
			pointers[index] = &values[index]
		}
		if rows.Scan(pointers...) != nil {
			continue
		}
		fields := make(map[string]any, len(selected))
		for index, column := range selected {
			fields[column] = values[index]
		}
		if record, ok := clineRecordFromFields(fields); ok {
			records = append(records, record)
		}
	}
	_ = rows.Err()
	_ = rows.Close()
	return records
}

// readClineRecordsFromJSON 是 sessions.db 不可用时的兜底：直接读
// sessions/<id>/<id>.json。
func readClineRecordsFromJSON(sessionsDir string) []clineRecord {
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		return nil
	}
	records := make([]clineRecord, 0, 16)
	for _, entry := range entries {
		if len(records) >= clineRecordLimit {
			break
		}
		if !entry.IsDir() || !clineSessionIDPattern.MatchString(entry.Name()) {
			continue
		}
		content, err := os.ReadFile(filepath.Join(sessionsDir, entry.Name(), entry.Name()+".json"))
		if err != nil {
			continue
		}
		var fields map[string]any
		if json.Unmarshal(content, &fields) != nil {
			continue
		}
		if record, ok := clineRecordFromFields(fields); ok {
			records = append(records, record)
		}
	}
	sort.SliceStable(records, func(left, right int) bool {
		return records[left].StartedAtMs > records[right].StartedAtMs
	})
	return records
}

// clineRecordFromFields 归一一条记录；不满足 cline 会话 id 形状时 ok=false。
func clineRecordFromFields(fields map[string]any) (clineRecord, bool) {
	sessionID := trimSpace(fieldString(fields, "session_id", "sessionId"))
	if !clineSessionIDPattern.MatchString(sessionID) {
		return clineRecord{}, false
	}
	title := fieldString(fields, "prompt", "title")
	return clineRecord{
		SessionID:   sessionID,
		StartedAtMs: clineEpochMillis(firstField(fields, "started_at", "startedAt")),
		UpdatedAtMs: clineEpochMillis(firstField(fields, "updated_at", "updatedAt")),
		Cwd:         trimSpace(fieldString(fields, "cwd", "workspace_root", "workspaceRoot")),
		Title:       compactClineTitle(title),
	}, true
}

// firstField 返回第一个存在且非 nil 的字段值。
func firstField(fields map[string]any, names ...string) any {
	for _, name := range names {
		if value, exists := fields[name]; exists && value != nil {
			return value
		}
	}
	return nil
}

// fieldString 返回第一个非空文本字段。
func fieldString(fields map[string]any, names ...string) string {
	for _, name := range names {
		if value := trimSpace(sqliteValueString(fields[name])); value != "" {
			return value
		}
	}
	return ""
}

// clineEpochMillis 复刻 Node toEpochMs：毫秒数字、秒数字、数字串与日期串。
func clineEpochMillis(value any) int64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case int64:
		return clineEpochFromNumber(float64(typed))
	case float64:
		return clineEpochFromNumber(typed)
	case json.Number:
		numeric, err := typed.Float64()
		if err != nil {
			return 0
		}
		return clineEpochFromNumber(numeric)
	case []byte:
		return clineEpochMillis(string(typed))
	case string:
		text := trimSpace(typed)
		if text == "" {
			return 0
		}
		if numeric, err := strconv.ParseFloat(text, 64); err == nil {
			return clineEpochFromNumber(numeric)
		}
		for _, layout := range []string{
			time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.999Z07:00",
			"2006-01-02 15:04:05", "2006-01-02",
		} {
			if parsed, err := time.Parse(layout, text); err == nil {
				return parsed.UnixMilli()
			}
		}
		return 0
	default:
		return 0
	}
}

// clineEpochFromNumber 按 Node 的量级判定：大于 1e11 视为毫秒，否则视为秒。
func clineEpochFromNumber(value float64) int64 {
	if value <= 0 {
		return 0
	}
	if value > 100000000000 {
		return int64(value)
	}
	return int64(value * 1000)
}

// compactClineTitle 复刻 Node compactTitle：剥 <user_input> 包装、折叠空白并截断。
func compactClineTitle(value string) string {
	text := value
	for _, pattern := range clineUserInputPatterns {
		text = pattern.ReplaceAllString(text, " ")
	}
	text = strings.NewReplacer("\r", " ", "\n", " ", "\t", " ").Replace(text)
	normalized := compactWhitespace(text)
	if utf8.RuneCountInString(normalized) <= clineTitleMaxRunes {
		return normalized
	}
	return string([]rune(normalized)[:clineTitleMaxRunes])
}

// clineProjectID 复刻 Node：cline- 前缀 + base64url(projectPath)。
func clineProjectID(projectPath string) string {
	return base64URLPathID("cline-", projectPath)
}
