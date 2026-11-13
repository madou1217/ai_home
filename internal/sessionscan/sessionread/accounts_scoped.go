package sessionread

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var (
	grokUserQueryRe    = regexp.MustCompile(`(?is)<user_query>\s*([\s\S]*?)\s*</user_query>`)
	kiroUUIDPattern    = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
	kiroHostGroupHexRe = regexp.MustCompile(`^[0-9a-f]{16}$`)
	clineSessionIDRe   = regexp.MustCompile(`^[0-9]{10,}_[a-z0-9]{3,}$`)
	clineUserInputRe   = regexp.MustCompile(`(?i)</?user_input(?:\s+[^>]*)?>`)
)

// ==================== Qoder / QoderCN ====================

func resolveQoderConfigDir(provider string) string {
	if NormalizeProvider(provider) == "qodercn" {
		return ".qoder-cn"
	}
	return ".qoder"
}

func resolveQoderProjectsRoots(opts Options, provider string) []string {
	norm := NormalizeProvider(provider)
	aiHome := ResolveAIHomeDir(opts)
	hostHome := strings.TrimSpace(opts.HostHomeDir)
	seen := make(map[string]bool)
	var roots []string
	addRoot := func(dir string) {
		if dir != "" && !seen[dir] && dirExists(dir) {
			seen[dir] = true
			roots = append(roots, dir)
		}
	}
	for _, ref := range ListProviderAccountRefs(opts, norm) {
		rt := ResolveAccountRuntimeDir(aiHome, norm, ref)
		if rt != "" {
			addRoot(filepath.Join(rt, "projects"))
		}
	}
	if hostHome != "" {
		addRoot(filepath.Join(hostHome, resolveQoderConfigDir(norm), "projects"))
	}
	return roots
}

// ListQoderProjects 读取 Qoder / QoderCN 在各账号投影与宿主的 projects 目录。
func ListQoderProjects(opts Options, provider string) []Project {
	norm := NormalizeProvider(provider)
	roots := resolveQoderProjectsRoots(opts, norm)
	byPath := make(map[string]map[string]Session)

	for _, root := range roots {
		projEntries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		sort.Slice(projEntries, func(i, j int) bool { return projEntries[i].Name() < projEntries[j].Name() })
		for _, projEntry := range projEntries {
			if !projEntry.IsDir() || !IsSafePathSegment(projEntry.Name()) {
				continue
			}
			projDir := filepath.Join(root, projEntry.Name())
			files, err := os.ReadDir(projDir)
			if err != nil {
				continue
			}
			for _, f := range files {
				if f.IsDir() || !strings.HasSuffix(f.Name(), ".jsonl") {
					continue
				}
				sid := strings.TrimSuffix(f.Name(), ".jsonl")
				fullPath := filepath.Join(projDir, f.Name())
				_, mtimeMs, ok := fileSizeAndMtimeMs(fullPath)
				if !ok {
					continue
				}
				cwd := ""
				title := ""
				var latestRecTs int64
				_ = forEachJSONLLine(fullPath, func(line []byte) bool {
					var rec struct {
						Type      string   `json:"type"`
						Cwd       string   `json:"cwd"`
						Workspace []string `json:"workspace-directories"`
						Timestamp any      `json:"timestamp"`
						IsSide    bool     `json:"isSidechain"`
						Message   struct {
							Content any `json:"content"`
						} `json:"message"`
					}
					if json.Unmarshal(line, &rec) != nil {
						return true
					}
					if cwd == "" {
						cwd = NormalizeProjectPath(rec.Cwd)
						if cwd == "" && len(rec.Workspace) > 0 {
							cwd = NormalizeProjectPath(rec.Workspace[0])
						}
					}
					if ts := ToTimestampMs(rec.Timestamp); ts > latestRecTs {
						latestRecTs = ts
					}
					if title == "" && !rec.IsSide && rec.Type == "user" {
						text := extractQoderContentText(rec.Message.Content)
						if text != "" {
							runes := []rune(compactWhitespace(text))
							if len(runes) > 80 {
								title = string(runes[:80])
							} else {
								title = string(runes)
							}
						}
					}
					return true
				})
				if cwd == "" {
					cwd = projEntry.Name()
				}
				if title == "" {
					title = sid
				}
				upd := mtimeMs
				if latestRecTs > upd {
					upd = latestRecTs
				}
				if byPath[cwd] == nil {
					byPath[cwd] = make(map[string]Session)
				}
				prev, exists := byPath[cwd][sid]
				if !exists || upd > prev.UpdatedAt {
					byPath[cwd][sid] = Session{
						ID:             sid,
						Title:          title,
						UpdatedAt:      upd,
						Provider:       norm,
						ProjectDirName: projEntry.Name(),
					}
				}
			}
		}
	}

	projects := make([]Project, 0, len(byPath))
	for cwd, sessMap := range byPath {
		sessions := make([]Session, 0, len(sessMap))
		for _, s := range sessMap {
			sessions = append(sessions, s)
		}
		sort.SliceStable(sessions, func(i, j int) bool { return sessions[i].UpdatedAt > sessions[j].UpdatedAt })
		projects = append(projects, Project{
			ID:       norm + "-" + encodeBase64RawURL(cwd),
			Name:     projectBaseName(cwd),
			Path:     cwd,
			Sessions: sessions,
			Provider: norm,
		})
	}
	return projects
}

func extractQoderContentText(content any) string {
	if str, ok := content.(string); ok {
		return str
	}
	arr, ok := content.([]any)
	if !ok {
		return ""
	}
	var out []string
	for _, item := range arr {
		if obj, ok := item.(map[string]any); ok && obj["type"] == "text" {
			if t := stringFromAny(obj["text"]); t != "" {
				out = append(out, t)
			}
		}
	}
	return strings.Join(out, "\n")
}

// ResolveQoderSessionPath 定位 Qoder / QoderCN JSONL 文件路径。
func ResolveQoderSessionPath(opts Options, provider, sessionID, projectDirName string) string {
	sid := strings.TrimSpace(sessionID)
	if !IsSafePathSegment(sid) {
		return ""
	}
	projDir := strings.TrimSpace(projectDirName)
	if projDir != "" && !IsSafePathSegment(projDir) {
		return ""
	}
	for _, root := range resolveQoderProjectsRoots(opts, provider) {
		if projDir != "" {
			candidate := filepath.Join(root, projDir, sid+".jsonl")
			if fileExistsRegular(candidate) {
				return candidate
			}
			continue
		}
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, entry := range entries {
			if !entry.IsDir() || !IsSafePathSegment(entry.Name()) {
				continue
			}
			candidate := filepath.Join(root, entry.Name(), sid+".jsonl")
			if fileExistsRegular(candidate) {
				return candidate
			}
		}
	}
	return ""
}

// ReadQoderMessages 解析 Qoder / QoderCN 会话记录，按 message.id 合并相邻 assistant 分段。
func ReadQoderMessages(opts Options, provider, sessionID, projectDirName string) ([]Message, int64, bool, error) {
	filePath := ResolveQoderSessionPath(opts, provider, sessionID, projectDirName)
	if filePath == "" {
		return nil, 0, false, nil
	}
	size, _, ok := fileSizeAndMtimeMs(filePath)
	if !ok {
		return nil, 0, false, nil
	}

	var messages []Message
	lastAssistantMsgID := ""
	err := forEachJSONLLine(filePath, func(line []byte) bool {
		var rec struct {
			Type        string `json:"type"`
			IsSidechain bool   `json:"isSidechain"`
			Timestamp   any    `json:"timestamp"`
			Message     struct {
				ID      string `json:"id"`
				Model   string `json:"model"`
				Content any    `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(line, &rec) != nil || rec.IsSidechain {
			return true
		}
		if rec.Type != "user" && rec.Type != "assistant" {
			return true
		}
		var textParts, thinkingParts []string
		if str, ok := rec.Message.Content.(string); ok {
			if str != "" {
				textParts = append(textParts, str)
			}
		} else if blocks, ok := rec.Message.Content.([]any); ok {
			for _, raw := range blocks {
				obj, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				switch stringFromAny(obj["type"]) {
				case "text":
					if t := stringFromAny(obj["text"]); t != "" {
						textParts = append(textParts, t)
					}
				case "thinking":
					if t := stringFromAny(obj["thinking"]); t != "" {
						thinkingParts = append(thinkingParts, t)
					}
				}
			}
		}
		text := strings.Join(textParts, "\n")
		thinking := strings.Join(thinkingParts, "\n")
		if text == "" && thinking == "" {
			return true
		}
		msgID := ""
		if rec.Type == "assistant" {
			msgID = strings.TrimSpace(rec.Message.ID)
		}
		model := NormalizeMessageModel(rec.Message.Model)
		if msgID != "" && msgID == lastAssistantMsgID && len(messages) > 0 && messages[len(messages)-1].Role == "assistant" {
			prev := &messages[len(messages)-1]
			if text != "" {
				if prev.Content == "" {
					prev.Content = text
				} else {
					prev.Content += "\n" + text
				}
			}
			if thinking != "" {
				if prev.Thinking == "" {
					prev.Thinking = thinking
				} else {
					prev.Thinking += "\n" + thinking
				}
			}
			if prev.Model == "" && model != "" {
				prev.Model = model
			}
			return true
		}
		messages = append(messages, Message{
			Role:      rec.Type,
			Content:   text,
			Thinking:  thinking,
			Model:     model,
			Timestamp: rec.Timestamp,
		})
		lastAssistantMsgID = msgID
		return true
	})
	if err != nil {
		return nil, 0, true, err
	}
	return messages, size, true, nil
}

// ==================== Grok ====================

func resolveGrokSessionsRoots(opts Options) []string {
	aiHome := ResolveAIHomeDir(opts)
	hostHome := strings.TrimSpace(opts.HostHomeDir)
	seen := make(map[string]bool)
	var roots []string
	addRoot := func(dir string) {
		if dir != "" && !seen[dir] && dirExists(dir) {
			seen[dir] = true
			roots = append(roots, dir)
		}
	}
	for _, ref := range ListProviderAccountRefs(opts, "grok") {
		rt := ResolveAccountRuntimeDir(aiHome, "grok", ref)
		if rt != "" {
			addRoot(filepath.Join(rt, ".grok", "sessions"))
			addRoot(filepath.Join(rt, "sessions"))
		}
	}
	if hostHome != "" {
		addRoot(filepath.Join(hostHome, ".grok", "sessions"))
	}
	return roots
}

// ListGrokProjects 读取 Grok summary.json 会话项目。
func ListGrokProjects(opts Options) []Project {
	byKey := make(map[string]*Project)
	for _, root := range resolveGrokSessionsRoots(opts) {
		projEntries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		sort.Slice(projEntries, func(i, j int) bool { return projEntries[i].Name() < projEntries[j].Name() })
		for _, projEntry := range projEntries {
			if !projEntry.IsDir() || !IsSafePathSegment(projEntry.Name()) {
				continue
			}
			projDir := filepath.Join(root, projEntry.Name())
			projPath := ""
			if rawCwd, err := os.ReadFile(filepath.Join(projDir, ".cwd")); err == nil {
				projPath = strings.TrimSpace(string(rawCwd))
			}
			if projPath == "" {
				if decoded, decErr := url.PathUnescape(projEntry.Name()); decErr == nil && strings.TrimSpace(decoded) != "" {
					projPath = decoded
				} else {
					projPath = projEntry.Name()
				}
			}
			projKey := NormalizeProjectPath(projPath)
			if projKey == "" {
				projKey = projEntry.Name()
			}

			sessEntries, err := os.ReadDir(projDir)
			if err != nil {
				continue
			}
			proj, exists := byKey[projKey]
			if !exists {
				proj = &Project{
					ID:       "grok-" + projEntry.Name(),
					Name:     projectBaseName(projPath),
					Path:     projPath,
					Provider: "grok",
				}
				byKey[projKey] = proj
			}
			bySessID := make(map[string]Session, len(proj.Sessions))
			for _, s := range proj.Sessions {
				bySessID[s.ID] = s
			}
			for _, sessEntry := range sessEntries {
				if !sessEntry.IsDir() || !IsSafePathSegment(sessEntry.Name()) {
					continue
				}
				sessDir := filepath.Join(projDir, sessEntry.Name())
				info, statErr := os.Stat(sessDir)
				if statErr != nil || !info.IsDir() {
					continue
				}
				var summary struct {
					Info struct {
						SessionID string `json:"session_id"`
						ID        string `json:"id"`
					} `json:"info"`
					GeneratedTitle string `json:"generated_title"`
					SessionSummary string `json:"session_summary"`
					UpdatedAt      any    `json:"updated_at"`
					CreatedAt      any    `json:"created_at"`
				}
				if rawSum, err := os.ReadFile(filepath.Join(sessDir, "summary.json")); err == nil {
					_ = json.Unmarshal(rawSum, &summary)
				}
				id := firstNonEmpty(summary.Info.SessionID, summary.Info.ID, sessEntry.Name())
				title := firstNonEmpty(summary.GeneratedTitle, summary.SessionSummary, sessEntry.Name())
				upd := ToTimestampMs(summary.UpdatedAt)
				if upd == 0 {
					upd = ToTimestampMs(summary.CreatedAt)
				}
				if upd == 0 {
					upd = info.ModTime().UnixMilli()
				}
				prev, hasPrev := bySessID[id]
				if !hasPrev || upd >= prev.UpdatedAt {
					bySessID[id] = Session{
						ID:             id,
						Title:          title,
						UpdatedAt:      upd,
						Provider:       "grok",
						ProjectDirName: projEntry.Name(),
					}
				}
			}
			proj.Sessions = proj.Sessions[:0]
			for _, s := range bySessID {
				proj.Sessions = append(proj.Sessions, s)
			}
		}
	}

	out := make([]Project, 0, len(byKey))
	for _, proj := range byKey {
		if len(proj.Sessions) == 0 {
			continue
		}
		sort.SliceStable(proj.Sessions, func(i, j int) bool { return proj.Sessions[i].UpdatedAt > proj.Sessions[j].UpdatedAt })
		out = append(out, *proj)
	}
	return out
}

// ResolveGrokSessionPath 定位 Grok 会话 chat_history.jsonl。
func ResolveGrokSessionPath(opts Options, sessionID, projectDirName string) string {
	sid := strings.TrimSpace(sessionID)
	if !IsSafePathSegment(sid) {
		return ""
	}
	projDir := strings.TrimSpace(projectDirName)
	if projDir != "" && !IsSafePathSegment(projDir) {
		return ""
	}
	for _, root := range resolveGrokSessionsRoots(opts) {
		if projDir != "" {
			candidate := filepath.Join(root, projDir, sid, "chat_history.jsonl")
			if fileExistsRegular(candidate) || dirExists(filepath.Join(root, projDir, sid)) {
				return candidate
			}
			continue
		}
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, entry := range entries {
			if !entry.IsDir() || !IsSafePathSegment(entry.Name()) {
				continue
			}
			dir := filepath.Join(root, entry.Name(), sid)
			if dirExists(dir) {
				return filepath.Join(dir, "chat_history.jsonl")
			}
		}
	}
	return ""
}

// ReadGrokMessages 解析 Grok chat_history.jsonl，过滤伪用户提示并解包 <user_query>。
func ReadGrokMessages(opts Options, sessionID, projectDirName string) ([]Message, int64, bool, error) {
	filePath := ResolveGrokSessionPath(opts, sessionID, projectDirName)
	if filePath == "" {
		return nil, 0, false, nil
	}
	size, _, ok := fileSizeAndMtimeMs(filePath)
	if !ok {
		return []Message{}, 0, true, nil
	}
	var messages []Message
	err := forEachJSONLLine(filePath, func(line []byte) bool {
		var rec map[string]any
		if json.Unmarshal(line, &rec) != nil {
			return true
		}
		msg, ok := rec["message"].(map[string]any)
		if !ok {
			msg = rec
		}
		role := firstNonEmpty(stringFromAny(msg["role"]), stringFromAny(msg["type"]))
		if role != "user" && role != "assistant" {
			return true
		}
		if role == "user" {
			if strings.TrimSpace(stringFromAny(msg["synthetic_reason"])) != "" {
				return true
			}
			if !isIntegerVal(msg["prompt_index"]) {
				return true
			}
		}
		content := normalizeGrokContent(msg["content"])
		if role == "user" {
			if m := grokUserQueryRe.FindStringSubmatch(content); len(m) >= 2 {
				content = compactMultilineText(m[1])
			}
		}
		if strings.TrimSpace(content) == "" {
			return true
		}
		messages = append(messages, Message{
			Role:      role,
			Content:   content,
			Model:     NormalizeMessageModel(firstNonEmpty(stringFromAny(msg["model"]), stringFromAny(rec["model"]))),
			Timestamp: firstNonNil(msg["timestamp"], rec["timestamp"]),
		})
		return true
	})
	if err != nil {
		return nil, 0, true, err
	}
	return messages, size, true, nil
}

func isIntegerVal(v any) bool {
	switch typed := v.(type) {
	case int, int64:
		return true
	case float64:
		return typed == float64(int64(typed))
	default:
		return false
	}
}

func normalizeGrokContent(content any) string {
	switch typed := content.(type) {
	case string:
		return strings.TrimSpace(typed)
	case []any:
		var lines []string
		for _, item := range typed {
			if obj, ok := item.(map[string]any); ok {
				if t := firstNonEmpty(stringFromAny(obj["text"]), stringFromAny(obj["thinking"])); strings.TrimSpace(t) != "" {
					lines = append(lines, t)
				}
			}
		}
		return strings.TrimSpace(strings.Join(lines, "\n"))
	default:
		return ""
	}
}

// ==================== Kiro ====================

func resolveKiroDBPaths(opts Options) []string {
	aiHome := ResolveAIHomeDir(opts)
	var dbPaths []string
	seen := make(map[string]bool)
	for _, ref := range ListProviderAccountRefs(opts, "kiro") {
		rt := ResolveAccountRuntimeDir(aiHome, "kiro", ref)
		if rt != "" {
			p := filepath.Join(rt, "data.sqlite3")
			if !seen[p] {
				seen[p] = true
				dbPaths = append(dbPaths, p)
			}
		}
	}
	hostHome := strings.TrimSpace(opts.HostHomeDir)
	if hostHome != "" {
		p := filepath.Join(hostHome, ".local", "share", "kiro-cli", "data.sqlite3")
		if !seen[p] {
			seen[p] = true
			dbPaths = append(dbPaths, p)
		}
	}
	return dbPaths
}

// ListKiroProjects 联合读取 Kiro projection data.sqlite3（conversations_v2）、.kiro/sessions/cli/*.json 与宿主 sess_* 目录。
func ListKiroProjects(ctx context.Context, opts Options) []Project {
	byPath := make(map[string]map[string]Session)
	addSession := func(projPath string, sess Session) {
		normPath := NormalizeProjectPath(projPath)
		if normPath == "" || sess.ID == "" {
			return
		}
		if byPath[normPath] == nil {
			byPath[normPath] = make(map[string]Session)
		}
		prev, ok := byPath[normPath][sess.ID]
		if !ok || sess.UpdatedAt > prev.UpdatedAt {
			byPath[normPath][sess.ID] = sess
		}
	}

	for _, dbPath := range resolveKiroDBPaths(opts) {
		if db, exists, err := openReadOnlySQLite(ctx, dbPath); err == nil && exists {
			if rows, qErr := db.QueryContext(ctx, `SELECT key, conversation_id, value, created_at, updated_at FROM conversations_v2`); qErr == nil {
				for rows.Next() {
					var key, convID, valStr string
					var createdAt, updatedAt sql.NullFloat64
					if rows.Scan(&key, &convID, &valStr, &createdAt, &updatedAt) != nil {
						continue
					}
					var val struct {
						ConversationID string `json:"conversation_id"`
						History        []struct {
							User struct {
								Content struct {
									Prompt struct {
										Prompt string `json:"prompt"`
									} `json:"Prompt"`
								} `json:"content"`
							} `json:"user"`
						} `json:"history"`
					}
					_ = json.Unmarshal([]byte(valStr), &val)
					sid := firstNonEmpty(strings.TrimSpace(convID), strings.TrimSpace(val.ConversationID))
					if sid == "" {
						continue
					}
					title := sid
					for _, h := range val.History {
						if p := strings.TrimSpace(h.User.Content.Prompt.Prompt); p != "" {
							if runes := []rune(p); len(runes) > 80 {
								title = string(runes[:80])
							} else {
								title = p
							}
							break
						}
					}
					upd := ToTimestampMs(updatedAt.Float64)
					if upd == 0 {
						upd = ToTimestampMs(createdAt.Float64)
					}
					projPath := NormalizeProjectPath(key)
					addSession(projPath, Session{
						ID:             sid,
						Title:          title,
						UpdatedAt:      upd,
						Provider:       "kiro",
						ProjectDirName: projPath,
					})
				}
				_ = rows.Close()
			}
			_ = db.Close()
		}

		cliRoot := filepath.Join(filepath.Dir(dbPath), ".kiro", "sessions", "cli")
		if entries, err := os.ReadDir(cliRoot); err == nil {
			for _, entry := range entries {
				name := entry.Name()
				if entry.IsDir() || !strings.HasSuffix(name, ".json") {
					continue
				}
				sid := strings.TrimSuffix(name, ".json")
				if !kiroUUIDPattern.MatchString(sid) {
					continue
				}
				metaPath := filepath.Join(cliRoot, name)
				transPath := filepath.Join(cliRoot, sid+".jsonl")
				_, metaMtime, metaOK := fileSizeAndMtimeMs(metaPath)
				_, transMtime, transOK := fileSizeAndMtimeMs(transPath)
				if !metaOK || !transOK {
					continue
				}
				var meta struct {
					SessionID string `json:"session_id"`
					Cwd       string `json:"cwd"`
					Title     string `json:"title"`
					UpdatedAt any    `json:"updated_at"`
				}
				if raw, err := os.ReadFile(metaPath); err != nil || json.Unmarshal(raw, &meta) != nil {
					continue
				}
				if meta.SessionID != sid || !filepath.IsAbs(meta.Cwd) {
					continue
				}
				upd := ToTimestampMs(meta.UpdatedAt)
				if metaMtime > upd {
					upd = metaMtime
				}
				if transMtime > upd {
					upd = transMtime
				}
				title := strings.TrimSpace(firstNonEmpty(meta.Title, sid))
				if runes := []rune(title); len(runes) > 120 {
					title = string(runes[:120])
				}
				projPath := NormalizeProjectPath(meta.Cwd)
				addSession(projPath, Session{
					ID:             sid,
					Title:          title,
					UpdatedAt:      upd,
					Provider:       "kiro",
					ProjectDirName: projPath,
				})
			}
		}
	}

	hostHome := strings.TrimSpace(opts.HostHomeDir)
	if hostHome != "" && strings.TrimSpace(opts.AccountRef) == "" {
		hostRoot := filepath.Join(hostHome, ".kiro", "sessions")
		if groups, err := os.ReadDir(hostRoot); err == nil {
			for _, g := range groups {
				if !g.IsDir() || !kiroHostGroupHexRe.MatchString(g.Name()) {
					continue
				}
				groupDir := filepath.Join(hostRoot, g.Name())
				sessDirs, _ := os.ReadDir(groupDir)
				for _, sd := range sessDirs {
					if !sd.IsDir() || !strings.HasPrefix(sd.Name(), "sess_") {
						continue
					}
					sessJsonPath := filepath.Join(groupDir, sd.Name(), "session.json")
					msgJsonlPath := filepath.Join(groupDir, sd.Name(), "messages.jsonl")
					raw, err := os.ReadFile(sessJsonPath)
					if err != nil {
						continue
					}
					var sjson struct {
						WorkspacePaths []string `json:"workspacePaths"`
						CreatedAt      any      `json:"createdAt"`
					}
					if json.Unmarshal(raw, &sjson) != nil || len(sjson.WorkspacePaths) == 0 {
						continue
					}
					projPath := NormalizeProjectPath(sjson.WorkspacePaths[0])
					if projPath == "" {
						continue
					}
					_, msgMtime, _ := fileSizeAndMtimeMs(msgJsonlPath)
					_, metaMtime, _ := fileSizeAndMtimeMs(sessJsonPath)
					upd := msgMtime
					if upd == 0 {
						upd = ToTimestampMs(sjson.CreatedAt)
					}
					if upd == 0 {
						upd = metaMtime
					}
					title := readKiroHostTitle(msgJsonlPath)
					if title == "" {
						title = sd.Name()
					}
					addSession(projPath, Session{
						ID:             sd.Name(),
						Title:          title,
						UpdatedAt:      upd,
						Provider:       "kiro",
						ProjectDirName: projPath,
					})
				}
			}
		}
	}

	projects := make([]Project, 0, len(byPath))
	for projPath, sessMap := range byPath {
		sessions := make([]Session, 0, len(sessMap))
		for _, s := range sessMap {
			sessions = append(sessions, s)
		}
		sort.SliceStable(sessions, func(i, j int) bool { return sessions[i].UpdatedAt > sessions[j].UpdatedAt })
		projects = append(projects, Project{
			ID:       "kiro-" + encodeBase64RawURL(projPath),
			Name:     projectBaseName(projPath),
			Path:     projPath,
			Sessions: sessions,
			Provider: "kiro",
		})
	}
	return projects
}

func readKiroHostTitle(msgPath string) string {
	tail, err := os.Open(msgPath)
	if err != nil {
		return ""
	}
	defer tail.Close()
	buf := make([]byte, 64*1024)
	n, _ := tail.Read(buf)
	for _, line := range strings.Split(string(buf[:n]), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		var rec struct {
			Payload map[string]any `json:"payload"`
		}
		if json.Unmarshal([]byte(trimmed), &rec) != nil || rec.Payload == nil {
			continue
		}
		if prompt := extractKiroHostPrompt(rec.Payload); prompt != "" {
			if runes := []rune(prompt); len(runes) > 80 {
				return string(runes[:80])
			}
			return prompt
		}
	}
	return ""
}

func extractKiroHostPrompt(payload map[string]any) string {
	if uim, ok := payload["userInputMessage"].(map[string]any); ok {
		if t := strings.TrimSpace(stringFromAny(uim["content"])); t != "" {
			return t
		}
	}
	if u, ok := payload["user"].(map[string]any); ok {
		if c, ok := u["content"].(map[string]any); ok {
			if p, ok := c["Prompt"].(map[string]any); ok {
				if t := strings.TrimSpace(stringFromAny(p["prompt"])); t != "" {
					return t
				}
			}
		}
	}
	return firstNonEmpty(stringFromAny(payload["content"]), stringFromAny(payload["prompt"]), stringFromAny(payload["message"]))
}

// ResolveKiroSessionPath 返回 Kiro 对应的 CLI JSONL、data.sqlite3 或 host messages.jsonl 路径。
func ResolveKiroSessionPath(ctx context.Context, opts Options, sessionID string) string {
	sid := strings.TrimSpace(sessionID)
	if !IsSafePathSegment(sid) {
		return ""
	}
	for _, dbPath := range resolveKiroDBPaths(opts) {
		cliTrans := filepath.Join(filepath.Dir(dbPath), ".kiro", "sessions", "cli", sid+".jsonl")
		cliMeta := filepath.Join(filepath.Dir(dbPath), ".kiro", "sessions", "cli", sid+".json")
		if kiroUUIDPattern.MatchString(sid) && fileExistsRegular(cliTrans) && fileExistsRegular(cliMeta) {
			return cliTrans
		}
	}
	for _, dbPath := range resolveKiroDBPaths(opts) {
		if db, exists, err := openReadOnlySQLite(ctx, dbPath); err == nil && exists {
			var found int
			qErr := db.QueryRowContext(ctx, `SELECT 1 FROM conversations_v2 WHERE conversation_id = ? LIMIT 1`, sid).Scan(&found)
			_ = db.Close()
			if qErr == nil && found == 1 {
				return dbPath
			}
		}
	}
	if hostHome := strings.TrimSpace(opts.HostHomeDir); hostHome != "" {
		hostRoot := filepath.Join(hostHome, ".kiro", "sessions")
		if groups, err := os.ReadDir(hostRoot); err == nil {
			for _, g := range groups {
				if !g.IsDir() || !kiroHostGroupHexRe.MatchString(g.Name()) {
					continue
				}
				candidate := filepath.Join(hostRoot, g.Name(), sid, "messages.jsonl")
				if fileExistsRegular(candidate) {
					return candidate
				}
			}
		}
	}
	return ""
}

// ReadKiroMessages 读取 Kiro CLI JSONL 或 conversations_v2 消息。
func ReadKiroMessages(ctx context.Context, opts Options, sessionID string) ([]Message, int64, bool, error) {
	sid := strings.TrimSpace(sessionID)
	if !IsSafePathSegment(sid) {
		return nil, 0, false, nil
	}
	for _, dbPath := range resolveKiroDBPaths(opts) {
		if msgs, size, ok, err := readKiroCliJsonlMessages(dbPath, sid); ok {
			return msgs, size, true, err
		}
		if db, exists, err := openReadOnlySQLite(ctx, dbPath); err == nil && exists {
			var valStr string
			qErr := db.QueryRowContext(ctx, `SELECT value FROM conversations_v2 WHERE conversation_id = ? LIMIT 1`, sid).Scan(&valStr)
			_ = db.Close()
			if qErr == nil {
				size, _, _ := fileSizeAndMtimeMs(dbPath)
				return parseKiroConversationMessages(valStr), size, true, nil
			}
		}
	}
	return nil, 0, false, nil
}

func readKiroCliJsonlMessages(dbPath, sid string) ([]Message, int64, bool, error) {
	if !kiroUUIDPattern.MatchString(sid) {
		return nil, 0, false, nil
	}
	root := filepath.Join(filepath.Dir(dbPath), ".kiro", "sessions", "cli")
	metaPath := filepath.Join(root, sid+".json")
	transPath := filepath.Join(root, sid+".jsonl")
	if !fileExistsRegular(metaPath) || !fileExistsRegular(transPath) {
		return nil, 0, false, nil
	}
	rawMeta, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, 0, false, nil
	}
	var meta struct {
		SessionID    string `json:"session_id"`
		Cwd          string `json:"cwd"`
		SessionState struct {
			ConversationMetadata struct {
				UserTurnMetadatas []struct {
					MessageIDs []string `json:"message_ids"`
					Model      string   `json:"model"`
					Result     struct {
						Ok struct {
							Meta struct {
								Timestamp any `json:"timestamp"`
							} `json:"meta"`
						} `json:"Ok"`
					} `json:"result"`
				} `json:"user_turn_metadatas"`
			} `json:"conversation_metadata"`
			RTSModelState struct {
				ModelInfo struct {
					ModelID string `json:"model_id"`
				} `json:"model_info"`
			} `json:"rts_model_state"`
		} `json:"session_state"`
	}
	if json.Unmarshal(rawMeta, &meta) != nil || meta.SessionID != sid || !filepath.IsAbs(meta.Cwd) {
		return nil, 0, false, nil
	}
	size, _, _ := fileSizeAndMtimeMs(transPath)
	turnModelByMsgID := make(map[string]string)
	turnTsByMsgID := make(map[string]any)
	for _, turn := range meta.SessionState.ConversationMetadata.UserTurnMetadatas {
		for _, mid := range turn.MessageIDs {
			if turn.Model != "" {
				turnModelByMsgID[mid] = turn.Model
			}
			if turn.Result.Ok.Meta.Timestamp != nil {
				turnTsByMsgID[mid] = turn.Result.Ok.Meta.Timestamp
			}
		}
	}
	fallbackModel := strings.TrimSpace(meta.SessionState.RTSModelState.ModelInfo.ModelID)
	var msgs []Message
	_ = forEachJSONLLine(transPath, func(line []byte) bool {
		var event struct {
			Version string `json:"version"`
			Kind    string `json:"kind"`
			Data    struct {
				MessageID string `json:"message_id"`
				Content   []struct {
					Kind string `json:"kind"`
					Data any    `json:"data"`
				} `json:"content"`
				Meta struct {
					Timestamp any `json:"timestamp"`
				} `json:"meta"`
			} `json:"data"`
		}
		if json.Unmarshal(line, &event) != nil || event.Version != "v1" {
			return true
		}
		if event.Kind != "Prompt" && event.Kind != "AssistantMessage" {
			return true
		}
		var textParts []string
		for _, block := range event.Data.Content {
			if block.Kind == "text" {
				if str, ok := block.Data.(string); ok {
					textParts = append(textParts, str)
				}
			}
		}
		text := strings.TrimSpace(strings.Join(textParts, "\n"))
		if text == "" {
			return true
		}
		role := "user"
		if event.Kind == "AssistantMessage" {
			role = "assistant"
		}
		model := firstNonEmpty(turnModelByMsgID[event.Data.MessageID], fallbackModel)
		ts := event.Data.Meta.Timestamp
		if ts == nil && role == "assistant" {
			ts = turnTsByMsgID[event.Data.MessageID]
		}
		msgs = append(msgs, Message{
			Role:      role,
			Content:   text,
			Model:     NormalizeMessageModel(model),
			Timestamp: formatISOFromMs(ToTimestampMs(ts)),
		})
		return true
	})
	return msgs, size, true, nil
}

func parseKiroConversationMessages(valStr string) []Message {
	var val struct {
		ModelInfo struct {
			ModelID string `json:"model_id"`
		} `json:"model_info"`
		History []struct {
			RequestMetadata struct {
				ModelID string `json:"model_id"`
			} `json:"request_metadata"`
			User struct {
				Content struct {
					Prompt struct {
						Prompt string `json:"prompt"`
					} `json:"Prompt"`
				} `json:"content"`
			} `json:"user"`
			Assistant struct {
				Response struct {
					Content string `json:"content"`
				} `json:"Response"`
			} `json:"assistant"`
		} `json:"history"`
	}
	if json.Unmarshal([]byte(valStr), &val) != nil {
		return nil
	}
	var msgs []Message
	for _, turn := range val.History {
		model := NormalizeMessageModel(firstNonEmpty(turn.RequestMetadata.ModelID, val.ModelInfo.ModelID))
		if p := strings.TrimSpace(turn.User.Content.Prompt.Prompt); p != "" {
			msgs = append(msgs, Message{Role: "user", Content: p, Model: model})
		}
		if r := strings.TrimSpace(turn.Assistant.Response.Content); r != "" {
			msgs = append(msgs, Message{Role: "assistant", Content: r, Model: model})
		}
	}
	return msgs
}

// ReadKiroSessionModel 读取 Kiro 会话的最后一次使用模型。
func ReadKiroSessionModel(ctx context.Context, opts Options, sessionID string) string {
	sid := strings.TrimSpace(sessionID)
	if !IsSafePathSegment(sid) {
		return ""
	}
	for _, dbPath := range resolveKiroDBPaths(opts) {
		if kiroUUIDPattern.MatchString(sid) {
			metaPath := filepath.Join(filepath.Dir(dbPath), ".kiro", "sessions", "cli", sid+".json")
			if raw, err := os.ReadFile(metaPath); err == nil {
				var meta struct {
					SessionID    string `json:"session_id"`
					Cwd          string `json:"cwd"`
					SessionState struct {
						ConversationMetadata struct {
							UserTurnMetadatas []struct {
								Model string `json:"model"`
							} `json:"user_turn_metadatas"`
						} `json:"conversation_metadata"`
						RTSModelState struct {
							ModelInfo struct {
								ModelID string `json:"model_id"`
							} `json:"model_info"`
						} `json:"rts_model_state"`
					} `json:"session_state"`
				}
				if json.Unmarshal(raw, &meta) == nil && meta.SessionID == sid && filepath.IsAbs(meta.Cwd) {
					turns := meta.SessionState.ConversationMetadata.UserTurnMetadatas
					for i := len(turns) - 1; i >= 0; i-- {
						if m := NormalizeMessageModel(turns[i].Model); m != "" {
							return m
						}
					}
					if m := NormalizeMessageModel(meta.SessionState.RTSModelState.ModelInfo.ModelID); m != "" {
						return m
					}
				}
			}
		}
		if db, exists, err := openReadOnlySQLite(ctx, dbPath); err == nil && exists {
			var valStr string
			qErr := db.QueryRowContext(ctx, `SELECT value FROM conversations_v2 WHERE conversation_id = ? LIMIT 1`, sid).Scan(&valStr)
			_ = db.Close()
			if qErr == nil {
				var val struct {
					ModelInfo struct {
						ModelID string `json:"model_id"`
					} `json:"model_info"`
					History []struct {
						RequestMetadata struct {
							ModelID string `json:"model_id"`
						} `json:"request_metadata"`
					} `json:"history"`
				}
				if json.Unmarshal([]byte(valStr), &val) == nil {
					for i := len(val.History) - 1; i >= 0; i-- {
						if m := NormalizeMessageModel(val.History[i].RequestMetadata.ModelID); m != "" {
							return m
						}
					}
					if m := NormalizeMessageModel(val.ModelInfo.ModelID); m != "" {
						return m
					}
				}
			}
		}
	}
	return ""
}

// ==================== Cline ====================

func resolveClineDataDirs(opts Options) []string {
	aiHome := ResolveAIHomeDir(opts)
	hostHome := strings.TrimSpace(opts.HostHomeDir)
	seen := make(map[string]bool)
	var dirs []string
	addDir := func(dir string) {
		if dir != "" && !seen[dir] && dirExists(dir) {
			seen[dir] = true
			dirs = append(dirs, dir)
		}
	}
	for _, ref := range ListProviderAccountRefs(opts, "cline") {
		if rt := ResolveAccountRuntimeDir(aiHome, "cline", ref); rt != "" {
			addDir(filepath.Join(rt, ".cline", "data"))
		}
	}
	if hostHome != "" {
		addDir(filepath.Join(hostHome, ".cline", "data"))
	}
	return dirs
}

type clineRecord struct {
	sessionID    string
	cwd          string
	title        string
	model        string
	startedAtMs  int64
	updatedAtMs  int64
	messagesPath string
}

func readClineRecords(ctx context.Context, opts Options) []clineRecord {
	byID := make(map[string]clineRecord)
	mergeRec := func(rec clineRecord) {
		if !clineSessionIDRe.MatchString(rec.sessionID) {
			return
		}
		prev, ok := byID[rec.sessionID]
		bestPrev := prev.updatedAtMs
		if bestPrev == 0 {
			bestPrev = prev.startedAtMs
		}
		bestCur := rec.updatedAtMs
		if bestCur == 0 {
			bestCur = rec.startedAtMs
		}
		if !ok || bestCur > bestPrev {
			byID[rec.sessionID] = rec
		}
	}

	for _, dataDir := range resolveClineDataDirs(opts) {
		dbPath := filepath.Join(dataDir, "db", "sessions.db")
		dbLoaded := false
		if db, exists, err := openReadOnlySQLite(ctx, dbPath); err == nil && exists {
			cols := getSQLiteTableColumns(ctx, db, "sessions")
			if cols["session_id"] {
				wanted := []string{"session_id", "started_at", "updated_at", "cwd", "workspace_root", "prompt", "model", "messages_path"}
				var selected []string
				for _, c := range wanted {
					if cols[c] {
						selected = append(selected, c)
					}
				}
				orderClause := ""
				if cols["started_at"] {
					orderClause = " ORDER BY started_at DESC"
				}
				if rows, qErr := db.QueryContext(ctx, "SELECT "+strings.Join(selected, ", ")+" FROM sessions"+orderClause+" LIMIT 400"); qErr == nil {
					dbLoaded = true
					for rows.Next() {
						vals := make([]sql.NullString, len(selected))
						ptrs := make([]any, len(selected))
						for i := range vals {
							ptrs[i] = &vals[i]
						}
						if rows.Scan(ptrs...) != nil {
							continue
						}
						m := make(map[string]string, len(selected))
						for i, col := range selected {
							if vals[i].Valid {
								m[col] = vals[i].String
							}
						}
						sid := strings.TrimSpace(m["session_id"])
						cwd := NormalizeProjectPath(firstNonEmpty(m["cwd"], m["workspace_root"]))
						title := cleanClineTitle(m["prompt"])
						if title == "" {
							title = sid
						}
						mergeRec(clineRecord{
							sessionID:    sid,
							cwd:          cwd,
							title:        title,
							model:        NormalizeMessageModel(m["model"]),
							startedAtMs:  ToTimestampMs(m["started_at"]),
							updatedAtMs:  ToTimestampMs(m["updated_at"]),
							messagesPath: strings.TrimSpace(m["messages_path"]),
						})
					}
					_ = rows.Close()
				}
			}
			_ = db.Close()
		}
		if dbLoaded {
			continue
		}
		sessionsRoot := filepath.Join(dataDir, "sessions")
		if entries, err := os.ReadDir(sessionsRoot); err == nil {
			for _, entry := range entries {
				if !entry.IsDir() || !clineSessionIDRe.MatchString(entry.Name()) {
					continue
				}
				metaFile := filepath.Join(sessionsRoot, entry.Name(), entry.Name()+".json")
				raw, err := os.ReadFile(metaFile)
				if err != nil {
					continue
				}
				var obj map[string]any
				if json.Unmarshal(raw, &obj) != nil {
					continue
				}
				sid := firstNonEmpty(strings.TrimSpace(stringFromAny(obj["session_id"])), entry.Name())
				cwd := NormalizeProjectPath(firstNonEmpty(stringFromAny(obj["cwd"]), stringFromAny(obj["workspace_root"])))
				title := cleanClineTitle(stringFromAny(obj["prompt"]))
				if title == "" {
					title = sid
				}
				mergeRec(clineRecord{
					sessionID:    sid,
					cwd:          cwd,
					title:        title,
					model:        NormalizeMessageModel(stringFromAny(obj["model"])),
					startedAtMs:  ToTimestampMs(obj["started_at"]),
					updatedAtMs:  ToTimestampMs(obj["updated_at"]),
					messagesPath: strings.TrimSpace(stringFromAny(obj["messages_path"])),
				})
			}
		}
	}

	out := make([]clineRecord, 0, len(byID))
	for _, r := range byID {
		out = append(out, r)
	}
	return out
}

func cleanClineTitle(raw string) string {
	stripped := clineUserInputRe.ReplaceAllString(raw, " ")
	compacted := compactWhitespace(stripped)
	if runes := []rune(compacted); len(runes) > 120 {
		return string(runes[:120])
	}
	return compacted
}

// ListClineProjects 扫描 Cline 跨账号及宿主 sessions.db 并返回项目列表。
func ListClineProjects(ctx context.Context, opts Options) []Project {
	byPath := make(map[string][]Session)
	for _, rec := range readClineRecords(ctx, opts) {
		if rec.cwd == "" {
			continue
		}
		upd := rec.updatedAtMs
		if upd == 0 {
			upd = rec.startedAtMs
		}
		byPath[rec.cwd] = append(byPath[rec.cwd], Session{
			ID:             rec.sessionID,
			Title:          firstNonEmpty(rec.title, rec.sessionID),
			UpdatedAt:      upd,
			Provider:       "cline",
			ProjectDirName: rec.cwd,
		})
	}
	out := make([]Project, 0, len(byPath))
	for projPath, sessions := range byPath {
		sort.SliceStable(sessions, func(i, j int) bool { return sessions[i].UpdatedAt > sessions[j].UpdatedAt })
		out = append(out, Project{
			ID:       "cline-" + encodeBase64RawURL(projPath),
			Name:     projectBaseName(projPath),
			Path:     projPath,
			Sessions: sessions,
			Provider: "cline",
		})
	}
	return out
}

// ResolveClineSessionPath 定位 Cline <id>/<id>.messages.json。
func ResolveClineSessionPath(opts Options, sessionID string) string {
	sid := strings.TrimSpace(sessionID)
	if !clineSessionIDRe.MatchString(sid) {
		return ""
	}
	for _, dataDir := range resolveClineDataDirs(opts) {
		candidate := filepath.Join(dataDir, "sessions", sid, sid+".messages.json")
		if fileExistsRegular(candidate) {
			return candidate
		}
	}
	return ""
}

// ReadClineMessages 读取 Cline <id>.messages.json 转换为通用消息列表。
func ReadClineMessages(opts Options, sessionID string) ([]Message, int64, bool, error) {
	filePath := ResolveClineSessionPath(opts, sessionID)
	if filePath == "" {
		return nil, 0, false, nil
	}
	size, _, ok := fileSizeAndMtimeMs(filePath)
	if !ok {
		return nil, 0, false, nil
	}
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return nil, 0, true, err
	}
	var payload struct {
		Messages []struct {
			Role    string           `json:"role"`
			Content []map[string]any `json:"content"`
			Ts      any              `json:"ts"`
		} `json:"messages"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return nil, 0, true, nil
	}
	var messages []Message
	for _, entry := range payload.Messages {
		role := strings.TrimSpace(entry.Role)
		if role != "user" && role != "assistant" {
			continue
		}
		legacyBlocks := make([]map[string]any, 0, len(entry.Content))
		for _, block := range entry.Content {
			bType := stringFromAny(block["type"])
			switch bType {
			case "text":
				legacyBlocks = append(legacyBlocks, map[string]any{"type": "text", "text": block["text"]})
			case "thinking":
				legacyBlocks = append(legacyBlocks, map[string]any{"type": "reasoning", "text": block["thinking"]})
			case "tool_use":
				legacyBlocks = append(legacyBlocks, map[string]any{"type": "tool_call", "name": block["name"], "args": block["input"]})
			case "tool_result":
				legacyBlocks = append(legacyBlocks, map[string]any{"type": "tool_result", "name": block["name"], "body": block["content"]})
			case "image":
				mt := strings.TrimSpace(stringFromAny(block["mediaType"]))
				txt := "[image]"
				if mt != "" {
					txt = "[image " + mt + "]"
				}
				legacyBlocks = append(legacyBlocks, map[string]any{"type": "text", "text": txt})
			}
		}
		rendered := renderProviderBlocks(legacyBlocks)
		if rendered == "" {
			continue
		}
		messages = append(messages, Message{
			Role:      role,
			Content:   rendered,
			Timestamp: formatISOFromMs(ToTimestampMs(entry.Ts)),
		})
	}
	return messages, size, true, nil
}

// ReadClineSessionModel 查询 Cline session 记录里的模型名。
func ReadClineSessionModel(ctx context.Context, opts Options, sessionID string) string {
	sid := strings.TrimSpace(sessionID)
	if !clineSessionIDRe.MatchString(sid) {
		return ""
	}
	for _, rec := range readClineRecords(ctx, opts) {
		if rec.sessionID == sid && rec.model != "" {
			return rec.model
		}
	}
	return ""
}

// ==================== ZCode ====================

func resolveZCodeDBPaths(hostHome string) (cliDBPath, tasksDBPath string) {
	home := strings.TrimSpace(hostHome)
	if home == "" {
		return "", ""
	}
	return filepath.Join(home, ".zcode", "cli", "db", "db.sqlite"),
		filepath.Join(home, ".zcode", "v2", "tasks-index.sqlite")
}

// ListZCodeProjects 合并 ~/.zcode/cli/db/db.sqlite 与 ~/.zcode/v2/tasks-index.sqlite。
func ListZCodeProjects(ctx context.Context, hostHome string) []Project {
	cliDBPath, tasksDBPath := resolveZCodeDBPaths(hostHome)
	type zSessRow struct {
		parentID    string
		directory   string
		path        string
		title       string
		timeCreated int64
		timeUpdated int64
		taskType    string
	}
	type zTaskRow struct {
		workspacePath string
		title         string
		createdAt     int64
		updatedAt     int64
		archived      bool
		deleted       bool
	}
	sessRows := make(map[string]zSessRow)
	taskRows := make(map[string]zTaskRow)

	if db, exists, err := openReadOnlySQLite(ctx, cliDBPath); err == nil && exists {
		if sqliteTableExists(ctx, db, "session") {
			cols := getSQLiteTableColumns(ctx, db, "session")
			if cols["id"] {
				sel := func(c string) string {
					if cols[c] {
						return "COALESCE(CAST(" + c + " AS TEXT), '')"
					}
					return "''"
				}
				if rows, qErr := db.QueryContext(
					ctx,
					`SELECT id, `+sel("parent_id")+`, `+sel("directory")+`, `+sel("path")+`, `+sel("title")+`, `+
						sel("time_created")+`, `+sel("time_updated")+`, `+sel("task_type")+` FROM session ORDER BY time_updated DESC`,
				); qErr == nil {
					for rows.Next() {
						var id, pid, dir, p, title, tc, tu, tt string
						if rows.Scan(&id, &pid, &dir, &p, &title, &tc, &tu, &tt) != nil {
							continue
						}
						cid := strings.TrimSpace(id)
						if cid == "" {
							continue
						}
						sessRows[cid] = zSessRow{
							parentID:    strings.TrimSpace(pid),
							directory:   strings.TrimSpace(dir),
							path:        strings.TrimSpace(p),
							title:       strings.TrimSpace(title),
							timeCreated: ToTimestampMs(tc),
							timeUpdated: ToTimestampMs(tu),
							taskType:    strings.TrimSpace(tt),
						}
					}
					_ = rows.Close()
				}
			}
		}
		_ = db.Close()
	}

	if db, exists, err := openReadOnlySQLite(ctx, tasksDBPath); err == nil && exists {
		if sqliteTableExists(ctx, db, "tasks") {
			cols := getSQLiteTableColumns(ctx, db, "tasks")
			if cols["task_id"] {
				sel := func(c string) string {
					if cols[c] {
						return "COALESCE(CAST(" + c + " AS TEXT), '')"
					}
					return "''"
				}
				if rows, qErr := db.QueryContext(
					ctx,
					`SELECT task_id, `+sel("workspace_path")+`, `+sel("title")+`, `+sel("created_at")+`, `+
						sel("updated_at")+`, `+sel("archived")+`, `+sel("deleted")+` FROM tasks`,
				); qErr == nil {
					for rows.Next() {
						var tid, wp, title, ca, ua, arch, del string
						if rows.Scan(&tid, &wp, &title, &ca, &ua, &arch, &del) != nil {
							continue
						}
						cid := strings.TrimSpace(tid)
						if cid == "" {
							continue
						}
						taskRows[cid] = zTaskRow{
							workspacePath: strings.TrimSpace(wp),
							title:         strings.TrimSpace(title),
							createdAt:     ToTimestampMs(ca),
							updatedAt:     ToTimestampMs(ua),
							archived:      isTruthyFlag(arch),
							deleted:       isTruthyFlag(del),
						}
					}
					_ = rows.Close()
				}
			}
		}
		_ = db.Close()
	}

	allIDs := make(map[string]bool, len(sessRows)+len(taskRows))
	for id := range sessRows {
		allIDs[id] = true
	}
	for id := range taskRows {
		allIDs[id] = true
	}

	byPath := make(map[string][]Session)
	for id := range allIDs {
		sRow := sessRows[id]
		tRow := taskRows[id]
		if sRow.parentID != "" || sRow.taskType == "subagent_child" || tRow.deleted || tRow.archived {
			continue
		}
		projPath := NormalizeProjectPath(firstNonEmpty(tRow.workspacePath, sRow.directory, sRow.path))
		if projPath == "" {
			continue
		}
		created := tRow.createdAt
		if created == 0 {
			created = sRow.timeCreated
		}
		upd := tRow.updatedAt
		if sRow.timeUpdated > upd {
			upd = sRow.timeUpdated
		}
		if upd == 0 {
			upd = created
		}
		title := firstNonEmpty(tRow.title, sRow.title, id)
		if runes := []rune(title); len(runes) > 80 {
			title = string(runes[:80])
		}
		byPath[projPath] = append(byPath[projPath], Session{
			ID:             id,
			Title:          title,
			UpdatedAt:      upd,
			Provider:       "zcode",
			ProjectDirName: projPath,
		})
	}

	out := make([]Project, 0, len(byPath))
	for projPath, sessions := range byPath {
		sort.SliceStable(sessions, func(i, j int) bool {
			if sessions[i].UpdatedAt != sessions[j].UpdatedAt {
				return sessions[i].UpdatedAt > sessions[j].UpdatedAt
			}
			return sessions[i].ID < sessions[j].ID
		})
		out = append(out, Project{
			ID:       "zcode-" + encodeBase64RawURL(projPath),
			Name:     projectBaseName(projPath),
			Path:     projPath,
			Sessions: sessions,
			Provider: "zcode",
		})
	}
	return out
}

func isTruthyFlag(val string) bool {
	switch strings.ToLower(strings.TrimSpace(val)) {
	case "1", "true", "yes":
		return true
	default:
		return false
	}
}

// ReadZCodeMessages 解析 ~/.zcode/cli/db/db.sqlite message + part 表。
func ReadZCodeMessages(ctx context.Context, hostHome, sessionID string) ([]Message, int64, bool, error) {
	cliDBPath, _ := resolveZCodeDBPaths(hostHome)
	db, exists, err := openReadOnlySQLite(ctx, cliDBPath)
	if err != nil || !exists {
		return nil, 0, false, nil
	}
	defer db.Close()

	size, _, _ := fileSizeAndMtimeMs(cliDBPath)

	msgRows, qErr := db.QueryContext(
		ctx,
		`SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY sequence`,
		sessionID,
	)
	if qErr != nil {
		return nil, size, true, nil
	}
	defer msgRows.Close()

	type zRawMsg struct {
		id          string
		timeCreated int64
		data        map[string]any
	}
	var rawMsgs []zRawMsg
	for msgRows.Next() {
		var id, dataStr string
		var tc sql.NullInt64
		if msgRows.Scan(&id, &tc, &dataStr) != nil {
			continue
		}
		var data map[string]any
		_ = json.Unmarshal([]byte(dataStr), &data)
		rawMsgs = append(rawMsgs, zRawMsg{id: id, timeCreated: tc.Int64, data: data})
	}
	if len(rawMsgs) == 0 {
		return []Message{}, size, true, nil
	}

	partsByMsg := make(map[string][]string)
	if partRows, pErr := db.QueryContext(
		ctx,
		`SELECT message_id, data FROM part WHERE session_id = ? ORDER BY sequence`,
		sessionID,
	); pErr == nil {
		for partRows.Next() {
			var msgID, pDataStr string
			if partRows.Scan(&msgID, &pDataStr) != nil {
				continue
			}
			var pdata map[string]any
			if json.Unmarshal([]byte(pDataStr), &pdata) != nil {
				continue
			}
			pType := strings.TrimSpace(stringFromAny(pdata["type"]))
			if pType != "" && pType != "text" {
				continue
			}
			if txt := strings.TrimSpace(stringFromAny(pdata["text"])); txt != "" {
				partsByMsg[msgID] = append(partsByMsg[msgID], txt)
			}
		}
		_ = partRows.Close()
	}

	var out []Message
	for _, m := range rawMsgs {
		role := strings.TrimSpace(stringFromAny(m.data["role"]))
		if role != "user" && role != "assistant" {
			continue
		}
		text := strings.Join(partsByMsg[m.id], "\n")
		if text == "" {
			continue
		}
		var ts any
		if m.timeCreated > 0 {
			ts = m.timeCreated
		}
		model := NormalizeModelReference(firstNonNil(m.data["model"], m.data))
		out = append(out, Message{
			Role:      role,
			Content:   text,
			Model:     model,
			Timestamp: ts,
		})
	}
	return out, size, true, nil
}

// ReadZCodeSessionModel 读取 ZCode 会话最后一条有效消息的模型引用。
func ReadZCodeSessionModel(ctx context.Context, hostHome, sessionID string) string {
	cliDBPath, _ := resolveZCodeDBPaths(hostHome)
	db, exists, err := openReadOnlySQLite(ctx, cliDBPath)
	if err != nil || !exists {
		return ""
	}
	defer db.Close()

	rows, err := db.QueryContext(
		ctx,
		`SELECT data FROM message WHERE session_id = ? ORDER BY sequence DESC`,
		sessionID,
	)
	if err != nil {
		return ""
	}
	defer rows.Close()

	for rows.Next() {
		var dataStr string
		if rows.Scan(&dataStr) != nil {
			continue
		}
		var data map[string]any
		if json.Unmarshal([]byte(dataStr), &data) != nil {
			continue
		}
		if model := NormalizeModelReference(firstNonNil(data["model"], data)); model != "" {
			return model
		}
	}
	return ""
}
