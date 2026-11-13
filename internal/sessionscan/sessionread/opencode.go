package sessionread

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const openCodeToolOutputMaxChars = 32000

var (
	openCodeRolePrefixRe     = regexp.MustCompile(`^(?:User|Assistant):\s*`)
	openCodeTaskTagWrapperRe = regexp.MustCompile(`<\/?task(?:_result)?\b[^>]*>`)
)

type openCodeLayout struct {
	sessionTable string
	messageTable string
	partTable    string
	contentModel string // "inline" or "parts"
}

var openCodeLayouts = []openCodeLayout{
	{sessionTable: "session_v2", messageTable: "session_message", partTable: "", contentModel: "inline"},
	{sessionTable: "session", messageTable: "message", partTable: "part", contentModel: "parts"},
}

func collectOpenCodeDBPaths(hostHome string) []string {
	home := strings.TrimSpace(hostHome)
	if home == "" {
		return nil
	}
	dataRoot := filepath.Join(home, ".local", "share", "opencode")
	canonical := filepath.Join(dataRoot, "opencode.db")
	resolvedRoot, err := filepath.EvalSymlinks(dataRoot)
	if err != nil {
		return nil
	}

	var out []string
	seenReal := make(map[string]bool)
	tryAdd := func(candidate string) {
		resolved, evalErr := filepath.EvalSymlinks(candidate)
		if evalErr != nil {
			return
		}
		rel, relErr := filepath.Rel(resolvedRoot, resolved)
		if relErr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
			return
		}
		if seenReal[resolved] || !fileExistsRegular(resolved) {
			return
		}
		seenReal[resolved] = true
		out = append(out, resolved)
	}

	tryAdd(canonical)
	if entries, readErr := os.ReadDir(dataRoot); readErr == nil {
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			name := entry.Name()
			if strings.HasSuffix(name, ".db") {
				tryAdd(filepath.Join(dataRoot, name))
			}
		}
	}
	return out
}

// ResolveOpenCodeSessionDB 挑选包含该 sessionId 且 updatedAt 最新的 opencode.db 路径。
func ResolveOpenCodeSessionDB(ctx context.Context, hostHome, sessionID string) string {
	sid := strings.TrimSpace(sessionID)
	if sid == "" {
		return ""
	}
	bestDB := ""
	bestUpdated := int64(-1)
	for _, dbPath := range collectOpenCodeDBPaths(hostHome) {
		db, exists, err := openReadOnlySQLite(ctx, dbPath)
		if err != nil || !exists {
			continue
		}
		found := false
		var updatedAt int64
		for _, layout := range openCodeLayouts {
			if !sqliteTableExists(ctx, db, layout.sessionTable) {
				continue
			}
			var upd sql.NullFloat64
			qErr := db.QueryRowContext(
				ctx,
				`SELECT time_updated FROM `+layout.sessionTable+` WHERE id = ? LIMIT 1`,
				sid,
			).Scan(&upd)
			if qErr == nil {
				found = true
				ms := normalizeEpochNumber(upd.Float64)
				if ms > updatedAt {
					updatedAt = ms
				}
			}
		}
		_ = db.Close()
		if found && (bestDB == "" || updatedAt > bestUpdated) {
			bestDB = dbPath
			bestUpdated = updatedAt
		}
	}
	return bestDB
}

// ListOpenCodeProjects 扫描 OpenCode session_v2 与 session 双布局构造项目与会话列表。
func ListOpenCodeProjects(ctx context.Context, hostHome string) []Project {
	dbPaths := collectOpenCodeDBPaths(hostHome)
	if len(dbPaths) == 0 {
		return []Project{}
	}

	type mergedRow struct {
		id           string
		directory    string
		title        string
		updatedAt    int64
		timeArchived bool
		parentID     string
	}
	mergedByID := make(map[string]mergedRow)

	for _, dbPath := range dbPaths {
		db, exists, err := openReadOnlySQLite(ctx, dbPath)
		if err != nil || !exists {
			continue
		}
		for _, layout := range openCodeLayouts {
			if !sqliteTableExists(ctx, db, layout.sessionTable) {
				continue
			}
			cols := getSQLiteTableColumns(ctx, db, layout.sessionTable)
			if !cols["id"] || !cols["directory"] {
				continue
			}
			titleCol := "'' AS title"
			if cols["title"] {
				titleCol = "COALESCE(title, '') AS title"
			}
			createdCol := "0 AS time_created"
			if cols["time_created"] {
				createdCol = "COALESCE(time_created, 0) AS time_created"
			}
			updatedCol := "0 AS time_updated"
			if cols["time_updated"] {
				updatedCol = "COALESCE(time_updated, 0) AS time_updated"
			}
			archivedCol := "NULL AS time_archived"
			if cols["time_archived"] {
				archivedCol = "time_archived"
			}
			parentCol := "'' AS parent_id"
			if cols["parent_id"] {
				parentCol = "COALESCE(parent_id, '') AS parent_id"
			}

			rows, qErr := db.QueryContext(
				ctx,
				`SELECT id, directory, `+titleCol+`, `+createdCol+`, `+updatedCol+`, `+archivedCol+`, `+parentCol+` FROM `+layout.sessionTable,
			)
			if qErr != nil {
				continue
			}
			for rows.Next() {
				var id, dir, title, parentID string
				var createdRaw, updatedRaw sql.NullFloat64
				var archivedVal sql.NullString
				if scanErr := rows.Scan(&id, &dir, &title, &createdRaw, &updatedRaw, &archivedVal, &parentID); scanErr != nil {
					continue
				}
				cleanID := strings.TrimSpace(id)
				if cleanID == "" {
					continue
				}
				upd := normalizeEpochNumber(updatedRaw.Float64)
				if upd == 0 {
					upd = normalizeEpochNumber(createdRaw.Float64)
				}
				archived := archivedVal.Valid && strings.TrimSpace(archivedVal.String) != "" && archivedVal.String != "0"
				next := mergedRow{
					id:           cleanID,
					directory:    NormalizeProjectPath(dir),
					title:        firstNonEmpty(strings.TrimSpace(title), cleanID),
					updatedAt:    upd,
					timeArchived: archived,
					parentID:     strings.TrimSpace(parentID),
				}
				prev, ok := mergedByID[cleanID]
				if !ok || next.updatedAt > prev.updatedAt {
					mergedByID[cleanID] = next
				}
			}
			_ = rows.Close()
		}
		_ = db.Close()
	}

	byProjectPath := make(map[string][]Session)
	for _, row := range mergedByID {
		if row.timeArchived || row.parentID != "" || row.directory == "" {
			continue
		}
		byProjectPath[row.directory] = append(byProjectPath[row.directory], Session{
			ID:        row.id,
			Title:     row.title,
			UpdatedAt: row.updatedAt,
			Provider:  "opencode",
		})
	}

	projects := make([]Project, 0, len(byProjectPath))
	for projPath, sessions := range byProjectPath {
		sort.SliceStable(sessions, func(i, j int) bool {
			return sessions[i].UpdatedAt > sessions[j].UpdatedAt
		})
		projects = append(projects, Project{
			ID:       "opencode-" + encodeBase64StdUnderscore(projPath),
			Name:     projectBaseName(projPath),
			Path:     projPath,
			Sessions: sessions,
			Provider: "opencode",
		})
	}
	return projects
}

// ReadOpenCodeSessionModel 读取 opencode DB session_v2 / session 的 model 列。
func ReadOpenCodeSessionModel(ctx context.Context, hostHome, sessionID string) string {
	sid := strings.TrimSpace(sessionID)
	dbPath := ResolveOpenCodeSessionDB(ctx, hostHome, sid)
	if dbPath == "" {
		return ""
	}
	db, exists, err := openReadOnlySQLite(ctx, dbPath)
	if err != nil || !exists {
		return ""
	}
	defer db.Close()

	for _, layout := range openCodeLayouts {
		if !sqliteTableExists(ctx, db, layout.sessionTable) {
			continue
		}
		cols := getSQLiteTableColumns(ctx, db, layout.sessionTable)
		if !cols["model"] {
			continue
		}
		var rawModel sql.NullString
		if db.QueryRowContext(ctx, `SELECT model FROM `+layout.sessionTable+` WHERE id = ? LIMIT 1`, sid).Scan(&rawModel) != nil {
			continue
		}
		raw := strings.TrimSpace(rawModel.String)
		if raw == "" {
			continue
		}
		if strings.HasPrefix(raw, "{") {
			var parsed map[string]any
			if json.Unmarshal([]byte(raw), &parsed) == nil {
				if norm := NormalizeModelReference(parsed); norm != "" {
					return norm
				}
			}
			continue
		}
		return raw
	}
	return ""
}

// ReadOpenCodeMessages 从 OpenCode DB 读取并合入子代理/工具/思考内容，返回规范消息列表。
func ReadOpenCodeMessages(ctx context.Context, hostHome, sessionID string) ([]Message, int64, bool, error) {
	sid := strings.TrimSpace(sessionID)
	dbPath := ResolveOpenCodeSessionDB(ctx, hostHome, sid)
	if dbPath == "" {
		return nil, 0, false, nil
	}
	size, _, _ := fileSizeAndMtimeMs(dbPath)
	db, exists, err := openReadOnlySQLite(ctx, dbPath)
	if err != nil || !exists {
		return nil, 0, false, err
	}
	defer db.Close()

	type orderedMsg struct {
		msgID       string
		timeCreated int64
		message     Message
	}
	mergedByID := make(map[string]orderedMsg)

	for _, layout := range openCodeLayouts {
		if !sqliteTableExists(ctx, db, layout.messageTable) {
			continue
		}
		if layout.contentModel == "inline" {
			rows, qErr := db.QueryContext(
				ctx,
				`SELECT id, type, time_created, data FROM `+layout.messageTable+` WHERE session_id = ? ORDER BY time_created ASC, id ASC`,
				sid,
			)
			if qErr != nil {
				continue
			}
			for rows.Next() {
				var msgID, msgType, dataStr string
				var timeCreatedRaw sql.NullFloat64
				if rows.Scan(&msgID, &msgType, &timeCreatedRaw, &dataStr) != nil {
					continue
				}
				var data map[string]any
				_ = json.Unmarshal([]byte(dataStr), &data)
				role := normalizeOpenCodeRole(firstNonEmpty(msgType, stringFromAny(data["role"])))
				if role == "" {
					continue
				}
				tc := normalizeEpochNumber(timeCreatedRaw.Float64)
				var content string
				if role == "user" {
					content = normalizeOpenCodeMessageText(firstNonEmpty(stringFromAny(data["text"]), stringFromAny(data["content"])))
				} else {
					content = renderOpenCodeInlineContent(ctx, db, data)
				}
				content = strings.TrimSpace(content)
				if content == "" {
					continue
				}
				model := NormalizeModelReference(firstNonNil(data["model"], data))
				if _, exists := mergedByID[msgID]; !exists {
					mergedByID[msgID] = orderedMsg{
						msgID:       msgID,
						timeCreated: tc,
						message: Message{
							Role:      role,
							Content:   content,
							Model:     model,
							Timestamp: formatOpenCodeTimestampISO(tc),
						},
					}
				}
			}
			_ = rows.Close()
		} else if sqliteTableExists(ctx, db, layout.partTable) {
			rows, qErr := db.QueryContext(
				ctx,
				`SELECT m.id, m.time_created, m.data, p.data
				 FROM `+layout.messageTable+` m
				 LEFT JOIN `+layout.partTable+` p ON p.message_id = m.id
				 WHERE m.session_id = ?
				 ORDER BY m.time_created ASC, m.id ASC, p.time_created ASC, p.id ASC`,
				sid,
			)
			if qErr != nil {
				continue
			}
			type partsMsgAcc struct {
				role        string
				model       string
				timeCreated int64
				chunks      []string
			}
			accs := make(map[string]*partsMsgAcc)
			order := make([]string, 0, 16)
			for rows.Next() {
				var msgID string
				var tcRaw sql.NullFloat64
				var msgDataStr string
				var partDataNull sql.NullString
				if rows.Scan(&msgID, &tcRaw, &msgDataStr, &partDataNull) != nil {
					continue
				}
				acc, exists := accs[msgID]
				if !exists {
					var mdata map[string]any
					_ = json.Unmarshal([]byte(msgDataStr), &mdata)
					role := normalizeOpenCodeRole(stringFromAny(mdata["role"]))
					if role == "" {
						continue
					}
					acc = &partsMsgAcc{
						role:        role,
						model:       NormalizeModelReference(firstNonNil(mdata["model"], mdata)),
						timeCreated: normalizeEpochNumber(tcRaw.Float64),
					}
					accs[msgID] = acc
					order = append(order, msgID)
				}
				if partDataNull.Valid && strings.TrimSpace(partDataNull.String) != "" {
					var pdata map[string]any
					if json.Unmarshal([]byte(partDataNull.String), &pdata) == nil {
						if chunk := renderOpenCodePart(ctx, db, pdata); chunk != "" {
							acc.chunks = append(acc.chunks, chunk)
						}
					}
				}
			}
			_ = rows.Close()

			for _, msgID := range order {
				acc := accs[msgID]
				content := normalizeOpenCodeMessageText(strings.Join(acc.chunks, ""))
				if content == "" {
					continue
				}
				if _, exists := mergedByID[msgID]; !exists {
					mergedByID[msgID] = orderedMsg{
						msgID:       msgID,
						timeCreated: acc.timeCreated,
						message: Message{
							Role:      acc.role,
							Content:   content,
							Model:     acc.model,
							Timestamp: formatOpenCodeTimestampISO(acc.timeCreated),
						},
					}
				}
			}
		}
	}

	sorted := make([]orderedMsg, 0, len(mergedByID))
	for _, item := range mergedByID {
		sorted = append(sorted, item)
	}
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].timeCreated != sorted[j].timeCreated {
			return sorted[i].timeCreated < sorted[j].timeCreated
		}
		return sorted[i].msgID < sorted[j].msgID
	})
	out := make([]Message, len(sorted))
	for i, item := range sorted {
		out[i] = item.message
	}
	return out, size, true, nil
}

func firstNonNil(values ...any) any {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}

func normalizeOpenCodeRole(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "assistant":
		return "assistant"
	case "user", "synthetic":
		return "user"
	default:
		return ""
	}
}

func normalizeOpenCodeMessageText(text string) string {
	return strings.TrimSpace(openCodeRolePrefixRe.ReplaceAllString(strings.TrimSpace(text), ""))
}

func formatOpenCodeTimestampISO(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

func renderOpenCodeInlineContent(ctx context.Context, db *sql.DB, data map[string]any) string {
	items, ok := data["content"].([]any)
	if !ok {
		return normalizeOpenCodeMessageText(stringFromAny(data["text"]))
	}
	var chunks []string
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if chunk := renderOpenCodePart(ctx, db, item); chunk != "" {
			chunks = append(chunks, chunk)
		}
	}
	return normalizeOpenCodeMessageText(strings.Join(chunks, ""))
}

func renderOpenCodePart(ctx context.Context, db *sql.DB, part map[string]any) string {
	pType := strings.ToLower(strings.TrimSpace(stringFromAny(part["type"])))
	switch pType {
	case "text":
		return stringFromAny(part["text"])
	case "reasoning":
		text := strings.TrimSpace(stringFromAny(part["text"]))
		if text == "" {
			return ""
		}
		return "\n:::thinking\n" + text + "\n:::\n"
	case "tool":
		return renderOpenCodeToolPart(ctx, db, part)
	default:
		return ""
	}
}

func renderOpenCodeToolPart(ctx context.Context, db *sql.DB, part map[string]any) string {
	toolName := firstNonEmpty(stringFromAny(part["tool"]), stringFromAny(part["name"]), "tool")
	state, _ := part["state"].(map[string]any)
	var inputVal any
	if state != nil && state["input"] != nil {
		inputVal = state["input"]
	} else if part["input"] != nil {
		inputVal = part["input"]
	} else {
		inputVal = map[string]any{}
	}
	inputPretty, _ := json.MarshalIndent(inputVal, "", "  ")
	inputText := capOpenCodeText(string(inputPretty))

	outputText := ""
	if state != nil {
		if out := stringFromAny(state["output"]); strings.TrimSpace(out) != "" {
			outputText = out
		} else if items, ok := state["content"].([]any); ok {
			var lines []string
			for _, c := range items {
				if obj, ok := c.(map[string]any); ok {
					if t := stringFromAny(obj["text"]); t != "" {
						lines = append(lines, t)
					}
				}
			}
			outputText = strings.Join(lines, "\n")
		}
	}
	outputText = capOpenCodeText(outputText)

	if strings.EqualFold(toolName, "task") {
		outputText = strings.TrimSpace(openCodeTaskTagWrapperRe.ReplaceAllString(outputText, ""))
		if outputText == "" && state != nil {
			if meta, ok := state["metadata"].(map[string]any); ok {
				childID := firstNonEmpty(stringFromAny(meta["sessionId"]), stringFromAny(meta["sessionID"]))
				if childID != "" {
					childText := readOpenCodeChildFinalText(ctx, db, childID)
					if childText != "" {
						outputText = "[子代理会话 " + childID + " 的产出]\n\n" + capOpenCodeText(childText)
					} else {
						outputText = "(子代理会话 " + childID + " 无产出——任务被中断或仍在运行)"
					}
				}
			}
		}
	}

	rendered := "\n:::tool{name=\"" + toolName + "\"}\n" + inputText + "\n:::\n"
	if outputText != "" {
		rendered += "\n:::tool-result\n" + outputText + "\n:::\n"
	}
	return rendered
}

func capOpenCodeText(text string) string {
	runes := []rune(text)
	if len(runes) <= openCodeToolOutputMaxChars {
		return text
	}
	return string(runes[:openCodeToolOutputMaxChars])
}

func readOpenCodeChildFinalText(ctx context.Context, db *sql.DB, childSessionID string) string {
	if db == nil || strings.TrimSpace(childSessionID) == "" {
		return ""
	}
	for _, layout := range openCodeLayouts {
		if !sqliteTableExists(ctx, db, layout.messageTable) {
			continue
		}
		if layout.contentModel == "inline" {
			rows, err := db.QueryContext(
				ctx,
				`SELECT type, data FROM `+layout.messageTable+` WHERE session_id = ? ORDER BY time_created DESC, id DESC`,
				childSessionID,
			)
			if err != nil {
				continue
			}
			var found string
			for rows.Next() {
				var msgType, dataStr string
				if rows.Scan(&msgType, &dataStr) != nil {
					continue
				}
				var data map[string]any
				_ = json.Unmarshal([]byte(dataStr), &data)
				if normalizeOpenCodeRole(firstNonEmpty(msgType, stringFromAny(data["role"]))) != "assistant" {
					continue
				}
				if items, ok := data["content"].([]any); ok {
					var texts []string
					for _, item := range items {
						if obj, ok := item.(map[string]any); ok && obj["type"] == "text" {
							if t := strings.TrimSpace(stringFromAny(obj["text"])); t != "" {
								texts = append(texts, t)
							}
						}
					}
					if len(texts) > 0 {
						found = strings.Join(texts, "\n")
						break
					}
				}
			}
			_ = rows.Close()
			if found != "" {
				return found
			}
		} else if sqliteTableExists(ctx, db, layout.partTable) {
			rows, err := db.QueryContext(
				ctx,
				`SELECT p.data FROM `+layout.messageTable+` m
				 JOIN `+layout.partTable+` p ON p.message_id = m.id
				 WHERE m.session_id = ? AND json_extract(m.data, '$.role') = 'assistant'
				 ORDER BY m.time_created DESC, p.time_created ASC, p.id ASC`,
				childSessionID,
			)
			if err != nil {
				continue
			}
			var texts []string
			for rows.Next() {
				var pStr string
				if rows.Scan(&pStr) != nil {
					continue
				}
				var pdata map[string]any
				if json.Unmarshal([]byte(pStr), &pdata) == nil && pdata["type"] == "text" {
					if t := strings.TrimSpace(stringFromAny(pdata["text"])); t != "" {
						texts = append(texts, t)
					}
				}
			}
			_ = rows.Close()
			if len(texts) > 0 {
				return strings.Join(texts, "\n")
			}
		}
	}
	return ""
}
