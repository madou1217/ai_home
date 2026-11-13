package sessionread

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/sessionscan/codebuddy"
)

var (
	codebuddySystemReminderRe = regexp.MustCompile(`(?is)<system-reminder>[\s\S]*?</system-reminder>`)
	codebuddyIdeHex32Re       = regexp.MustCompile(`^[a-f0-9]{32}$`)
	codebuddyUIDRe            = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	codebuddyUserQueryRe      = regexp.MustCompile(`(?is)<user_query>\s*([\s\S]*?)\s*</user_query>`)
	codebuddyAllowedIssuers   = map[string]string{
		"https://www.codebuddy.ai/auth/realms/copilot":  "codebuddy",
		"https://www.workbuddy.ai/auth/realms/copilot":  "codebuddy",
		"https://copilot.tencent.com/auth/realms/copilot": "codebuddy",
		"https://www.codebuddy.cn/auth/realms/copilot":  "codebuddycn",
		"https://www.workbuddy.cn/auth/realms/copilot":  "codebuddycn",
	}
)

func resolveCodebuddyConfigDirNames(provider string) []string {
	switch NormalizeProvider(provider) {
	case "codebuddy":
		return []string{".codebuddy", ".workbuddy-ai", ".codebuddy-cn", ".workbuddy"}
	case "workbuddy":
		return []string{".workbuddy-ai", ".codebuddy", ".workbuddy", ".codebuddy-cn"}
	case "codebuddycn":
		return []string{".codebuddy-cn", ".workbuddy", ".codebuddy", ".workbuddy-ai"}
	case "workbuddycn":
		return []string{".workbuddy", ".codebuddy-cn", ".workbuddy-ai", ".codebuddy"}
	default:
		return nil
	}
}

func resolveCodebuddyProjectsRoots(hostHome, provider string) []string {
	home := strings.TrimSpace(hostHome)
	if home == "" {
		return nil
	}
	dirNames := resolveCodebuddyConfigDirNames(provider)
	if len(dirNames) == 0 {
		return nil
	}
	seenReal := make(map[string]bool)
	roots := make([]string, 0, len(dirNames))
	for _, dirName := range dirNames {
		projectsRoot := filepath.Join(home, dirName, "projects")
		realRoot, err := filepath.EvalSymlinks(projectsRoot)
		if err != nil {
			continue
		}
		if seenReal[realRoot] {
			continue
		}
		seenReal[realRoot] = true
		roots = append(roots, projectsRoot)
	}
	return roots
}

type workbuddyDBMeta struct {
	cwd            string
	title          string
	customTitle    string
	updatedAtMs    int64
	lastActivityMs int64
}

func readWorkbuddyDBMetadata(ctx context.Context, projectsRoot string) map[string]workbuddyDBMeta {
	out := make(map[string]workbuddyDBMeta)
	dbPath := filepath.Join(filepath.Dir(projectsRoot), "workbuddy.db")
	db, exists, err := openReadOnlySQLite(ctx, dbPath)
	if err != nil || !exists {
		return out
	}
	defer db.Close()

	cols := getSQLiteTableColumns(ctx, db, "sessions")
	if !cols["id"] {
		return out
	}
	wanted := []string{"id", "cwd", "title", "custom_title", "updated_at", "last_activity_at"}
	selected := make([]string, 0, len(wanted))
	for _, col := range wanted {
		if cols[col] {
			selected = append(selected, col)
		}
	}
	rows, err := db.QueryContext(ctx, "SELECT "+strings.Join(selected, ", ")+" FROM sessions")
	if err != nil {
		return out
	}
	defer rows.Close()

	for rows.Next() {
		vals := make([]sql.NullString, len(selected))
		ptrs := make([]any, len(selected))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if scanErr := rows.Scan(ptrs...); scanErr != nil {
			continue
		}
		rowMap := make(map[string]string, len(selected))
		for i, col := range selected {
			if vals[i].Valid {
				rowMap[col] = vals[i].String
			}
		}
		id := strings.TrimSpace(rowMap["id"])
		if id == "" {
			continue
		}
		out[id] = workbuddyDBMeta{
			cwd:            strings.TrimSpace(rowMap["cwd"]),
			title:          strings.TrimSpace(rowMap["title"]),
			customTitle:    strings.TrimSpace(rowMap["custom_title"]),
			updatedAtMs:    ToTimestampMs(rowMap["updated_at"]),
			lastActivityMs: ToTimestampMs(rowMap["last_activity_at"]),
		}
	}
	return out
}

// ListCodebuddyProjects 读取 CodeBuddy/WorkBuddy 家族 CLI + workbuddy.db 元数据 + IDE 会话。
func ListCodebuddyProjects(ctx context.Context, opts Options, provider string) []Project {
	normProvider := NormalizeProvider(provider)
	if !IsCodebuddyFamilyProvider(normProvider) {
		return []Project{}
	}
	hostHome := strings.TrimSpace(opts.HostHomeDir)
	if hostHome == "" {
		return []Project{}
	}

	rawCLI := codebuddy.ReadProjects(hostHome, normProvider, cbCtxBudget{ctx: ctx})
	cliProjects := make([]Project, 0, len(rawCLI))
	for _, p := range rawCLI {
		sessions := make([]Session, 0, len(p.Sessions))
		for _, s := range p.Sessions {
			sessions = append(sessions, Session{
				ID:             s.ID,
				Title:          s.Title,
				UpdatedAt:      s.UpdatedAt,
				Provider:       s.Provider,
				ProjectDirName: s.ProjectDirName,
			})
		}
		cliProjects = append(cliProjects, Project{
			ID:       p.ID,
			Name:     p.Name,
			Path:     p.Path,
			Sessions: sessions,
			Provider: p.Provider,
		})
	}
	return EnrichCodebuddyProjects(ctx, opts, normProvider, cliProjects)
}

// EnrichCodebuddyProjects 叠加 workbuddy.db 元数据与 CodeBuddy IDE 历史项目。
func EnrichCodebuddyProjects(ctx context.Context, opts Options, provider string, baseProjects []Project) []Project {
	normProvider := NormalizeProvider(provider)
	hostHome := strings.TrimSpace(opts.HostHomeDir)
	if hostHome == "" || !IsCodebuddyFamilyProvider(normProvider) {
		return baseProjects
	}
	dbMetaByID := make(map[string]workbuddyDBMeta)
	for _, root := range resolveCodebuddyProjectsRoots(hostHome, normProvider) {
		for id, meta := range readWorkbuddyDBMetadata(ctx, root) {
			prev, ok := dbMetaByID[id]
			if !ok || meta.lastActivityMs > prev.lastActivityMs || meta.updatedAtMs > prev.updatedAtMs {
				dbMetaByID[id] = meta
			}
		}
	}

	projects := make([]Project, 0, len(baseProjects)+4)
	for _, p := range baseProjects {
		sessions := make([]Session, 0, len(p.Sessions))
		for _, s := range p.Sessions {
			title := s.Title
			updatedAt := s.UpdatedAt
			if meta, ok := dbMetaByID[s.ID]; ok {
				if custom := firstNonEmpty(meta.customTitle, meta.title); custom != "" {
					title = custom
				}
				bestAct := meta.lastActivityMs
				if updatedAt > bestAct {
					bestAct = updatedAt
				}
				if bestAct > 0 {
					updatedAt = bestAct
				} else if meta.updatedAtMs > updatedAt {
					updatedAt = meta.updatedAtMs
				}
			}
			sessions = append(sessions, Session{
				ID:             s.ID,
				Title:          title,
				UpdatedAt:      updatedAt,
				Provider:       s.Provider,
				ProjectDirName: s.ProjectDirName,
			})
		}
		projects = append(projects, Project{
			ID:       p.ID,
			Name:     p.Name,
			Path:     p.Path,
			Sessions: sessions,
			Provider: p.Provider,
		})
	}

	if normProvider == "codebuddy" || normProvider == "codebuddycn" {
		ideProjects := readCodebuddyIDEProjects(ctx, opts, normProvider)
		projects = append(projects, ideProjects...)
	}
	return projects
}

type codebuddyIDEAccount struct {
	provider   string
	accountRef string
	uid        string
}

type codebuddyIDESession struct {
	provider       string
	accountRef     string
	userID         string
	sessionID      string
	indexPath      string
	projectDirName string
	cwd            string
	title          string
	updatedAt      int64
}

func resolveCodebuddyExtensionDataRoot(home string) string {
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "CodeBuddyExtension", "Data")
	case "windows":
		return filepath.Join(home, "AppData", "Roaming", "CodeBuddyExtension", "Data")
	default:
		return filepath.Join(home, ".config", "CodeBuddyExtension", "Data")
	}
}

func discoverCodebuddyIDEAccounts(ctx context.Context, opts Options, targetProvider string) []codebuddyIDEAccount {
	normTarget := NormalizeProvider(targetProvider)
	if normTarget != "codebuddy" && normTarget != "codebuddycn" {
		return nil
	}
	dbPath := ResolveAppStateDBPath(opts)
	db, exists, err := openReadOnlySQLite(ctx, dbPath)
	if err != nil || !exists {
		return nil
	}
	defer db.Close()

	rows, err := db.QueryContext(
		ctx,
		`SELECT r.account_ref, r.provider, COALESCE(c.native_auth_json, '')
		 FROM account_refs r
		 LEFT JOIN account_credentials c ON c.account_ref = r.account_ref`,
	)
	if err != nil {
		return nil
	}
	defer rows.Close()

	wantCN := strings.HasSuffix(normTarget, "cn")
	var out []codebuddyIDEAccount
	for rows.Next() {
		var ref, prov, authJSON string
		if scanErr := rows.Scan(&ref, &prov, &authJSON); scanErr != nil {
			continue
		}
		normProv := NormalizeProvider(prov)
		if normProv != "codebuddy" && normProv != "codebuddycn" {
			continue
		}
		if strings.HasSuffix(normProv, "cn") != wantCN {
			continue
		}
		if strings.TrimSpace(opts.AccountRef) != "" && ref != strings.TrimSpace(opts.AccountRef) {
			continue
		}
		uid := inspectCodebuddyAuthUID(authJSON, normProv)
		if uid == "" {
			continue
		}
		out = append(out, codebuddyIDEAccount{
			provider:   normProv,
			accountRef: ref,
			uid:        uid,
		})
	}
	return out
}

func inspectCodebuddyAuthUID(nativeAuthJSON, expectedProvider string) string {
	var wrapper struct {
		Credentials json.RawMessage `json:"credentials"`
	}
	rawCreds := []byte(nativeAuthJSON)
	if json.Unmarshal([]byte(nativeAuthJSON), &wrapper) == nil && len(wrapper.Credentials) > 0 {
		rawCreds = wrapper.Credentials
	}
	var creds struct {
		Auth struct {
			AccessToken  string `json:"accessToken"`
			RefreshToken string `json:"refreshToken"`
		} `json:"auth"`
		Account struct {
			UID string `json:"uid"`
		} `json:"account"`
	}
	if json.Unmarshal(rawCreds, &creds) != nil {
		return ""
	}
	if strings.TrimSpace(creds.Auth.RefreshToken) == "" {
		return ""
	}
	uid := strings.TrimSpace(creds.Account.UID)
	if !codebuddyUIDRe.MatchString(uid) {
		return ""
	}
	parts := strings.Split(creds.Auth.AccessToken, ".")
	if len(parts) < 2 {
		return ""
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		Iss string `json:"iss"`
		Sub string `json:"sub"`
	}
	if json.Unmarshal(payloadBytes, &claims) != nil {
		return ""
	}
	realmProvider, ok := codebuddyAllowedIssuers[strings.TrimSpace(claims.Iss)]
	if !ok || realmProvider != expectedProvider {
		return ""
	}
	if strings.TrimSpace(claims.Sub) != uid {
		return ""
	}
	return uid
}

type codebuddyIDEMetaEntry struct {
	ConversationID string `json:"conversationId"`
	UserID         string `json:"userId"`
	Cwd            string `json:"cwd"`
	Title          string `json:"title"`
	UpdatedAt      any    `json:"updatedAt"`
	CreatedAt      any    `json:"createdAt"`
}

func readCodebuddyIDEVscdbMetadata(ctx context.Context, home string) map[string]codebuddyIDEMetaEntry {
	out := make(map[string]codebuddyIDEMetaEntry)
	dbPath := filepath.Join(home, "electron-user-data", "codebuddy-sessions.vscdb")
	db, exists, err := openReadOnlySQLite(ctx, dbPath)
	if err != nil || !exists {
		return out
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, `SELECT value FROM ItemTable WHERE key GLOB 'session:*'`)
	if err != nil {
		return out
	}
	defer rows.Close()

	for rows.Next() {
		var raw []byte
		if scanErr := rows.Scan(&raw); scanErr != nil {
			continue
		}
		var entry codebuddyIDEMetaEntry
		if json.Unmarshal(raw, &entry) != nil {
			continue
		}
		if codebuddyIdeHex32Re.MatchString(entry.ConversationID) {
			out[entry.ConversationID] = entry
		}
	}
	return out
}

func discoverCodebuddyIDESessions(ctx context.Context, opts Options, targetProvider, wantedSessionID string) []codebuddyIDESession {
	accounts := discoverCodebuddyIDEAccounts(ctx, opts, targetProvider)
	if len(accounts) == 0 {
		return nil
	}
	aiHome := ResolveAIHomeDir(opts)
	hostHome := strings.TrimSpace(opts.HostHomeDir)

	var sessions []codebuddyIDESession
	seen := make(map[string]bool)

	for _, acct := range accounts {
		var homes []string
		if rt := ResolveAccountRuntimeDir(aiHome, acct.provider, acct.accountRef); rt != "" {
			homes = append(homes, rt)
		}
		if hostHome != "" {
			homes = append(homes, hostHome)
		}
		for _, home := range homes {
			histRoot := filepath.Join(resolveCodebuddyExtensionDataRoot(home), acct.uid, "CodeBuddyIDE", acct.uid, "history")
			if !dirExists(histRoot) {
				continue
			}
			vscdbMeta := readCodebuddyIDEVscdbMetadata(ctx, home)
			projEntries, err := os.ReadDir(histRoot)
			if err != nil {
				continue
			}
			for _, projEntry := range projEntries {
				if !projEntry.IsDir() || !codebuddyIdeHex32Re.MatchString(projEntry.Name()) {
					continue
				}
				projRoot := filepath.Join(histRoot, projEntry.Name())
				var projIndex struct {
					Conversations []struct {
						ID            string `json:"id"`
						Name          string `json:"name"`
						LastMessageAt any    `json:"lastMessageAt"`
						CreatedAt     any    `json:"createdAt"`
					} `json:"conversations"`
				}
				if raw, err := os.ReadFile(filepath.Join(projRoot, "index.json")); err == nil {
					_ = json.Unmarshal(raw, &projIndex)
				}
				titleByID := make(map[string]struct {
					name          string
					lastMessageAt int64
				}, len(projIndex.Conversations))
				for _, c := range projIndex.Conversations {
					if codebuddyIdeHex32Re.MatchString(c.ID) {
						titleByID[c.ID] = struct {
							name          string
							lastMessageAt int64
						}{
							name:          c.Name,
							lastMessageAt: ToTimestampMs(c.LastMessageAt),
						}
					}
				}

				convEntries, err := os.ReadDir(projRoot)
				if err != nil {
					continue
				}
				for _, convEntry := range convEntries {
					if !convEntry.IsDir() || !codebuddyIdeHex32Re.MatchString(convEntry.Name()) {
						continue
					}
					if wantedSessionID != "" && convEntry.Name() != wantedSessionID {
						continue
					}
					indexPath := filepath.Join(projRoot, convEntry.Name(), "index.json")
					if !fileExistsRegular(indexPath) {
						continue
					}
					key := indexPath + ":" + acct.provider + ":" + acct.accountRef
					if seen[key] {
						continue
					}
					seen[key] = true
					native, hasNative := vscdbMeta[convEntry.Name()]
					if hasNative && native.UserID != "" && native.UserID != acct.uid {
						continue
					}
					titleInfo := titleByID[convEntry.Name()]
					upd := ToTimestampMs(native.UpdatedAt)
					if titleInfo.lastMessageAt > upd {
						upd = titleInfo.lastMessageAt
					}
					sessions = append(sessions, codebuddyIDESession{
						provider:       acct.provider,
						accountRef:     acct.accountRef,
						userID:         acct.uid,
						sessionID:      convEntry.Name(),
						indexPath:      indexPath,
						projectDirName: "ide-" + projEntry.Name(),
						cwd:            strings.TrimSpace(native.Cwd),
						title:          firstNonEmpty(native.Title, titleInfo.name),
						updatedAt:      upd,
					})
				}
			}
		}
	}
	return sessions
}

type codebuddyIDEMessageParsed struct {
	role        string
	content     string
	timestampMs int64
	modelID     string
}

func readCodebuddyIDESessionContent(indexPath string) ([]codebuddyIDEMessageParsed, int64, bool) {
	raw, err := os.ReadFile(indexPath)
	if err != nil {
		return nil, 0, false
	}
	var index struct {
		Messages []struct {
			ID string `json:"id"`
		} `json:"messages"`
		Requests []struct {
			StartedAt any `json:"startedAt"`
		} `json:"requests"`
	}
	if json.Unmarshal(raw, &index) != nil || index.Messages == nil || index.Requests == nil {
		return nil, 0, false
	}

	var latestAt int64
	for _, r := range index.Requests {
		if ts := ToTimestampMs(r.StartedAt); ts > latestAt {
			latestAt = ts
		}
	}

	msgsDir := filepath.Join(filepath.Dir(indexPath), "messages")
	var parsed []codebuddyIDEMessageParsed
	for _, ref := range index.Messages {
		if !codebuddyIdeHex32Re.MatchString(ref.ID) {
			continue
		}
		msgFile := filepath.Join(msgsDir, ref.ID+".json")
		msgBytes, err := os.ReadFile(msgFile)
		if err != nil {
			continue
		}
		var doc struct {
			ID        string `json:"id"`
			Role      string `json:"role"`
			Message   any    `json:"message"`
			CreatedAt any    `json:"createdAt"`
			Extra     any    `json:"extra"`
		}
		if json.Unmarshal(msgBytes, &doc) != nil || doc.ID != ref.ID {
			continue
		}
		if doc.Role != "user" && doc.Role != "assistant" {
			continue
		}
		var extraObj struct {
			SourceContentBlocks any    `json:"sourceContentBlocks"`
			ModelID             string `json:"modelId"`
		}
		switch typedExtra := doc.Extra.(type) {
		case string:
			_ = json.Unmarshal([]byte(typedExtra), &extraObj)
		case map[string]any:
			rawExtra, _ := json.Marshal(typedExtra)
			_ = json.Unmarshal(rawExtra, &extraObj)
		}
		text := extractCodebuddyIDEMessageText(doc.Role, doc.Message, extraObj.SourceContentBlocks)
		ts := ToTimestampMs(doc.CreatedAt)
		if ts > latestAt {
			latestAt = ts
		}
		parsed = append(parsed, codebuddyIDEMessageParsed{
			role:        doc.Role,
			content:     strings.TrimSpace(text),
			timestampMs: ts,
			modelID:     strings.TrimSpace(extraObj.ModelID),
		})
	}
	return parsed, latestAt, true
}

func extractCodebuddyIDEMessageText(role string, rawMessage any, sourceBlocks any) string {
	readBlocks := func(val any) string {
		if str, ok := val.(string); ok {
			return str
		}
		items, ok := val.([]any)
		if !ok {
			return ""
		}
		var lines []string
		for _, item := range items {
			obj, ok := item.(map[string]any)
			if ok && obj["type"] == "text" {
				lines = append(lines, stringFromAny(obj["text"]))
			}
		}
		return strings.Join(lines, "\n")
	}

	if role == "user" && sourceBlocks != nil {
		if srcText := readBlocks(sourceBlocks); strings.TrimSpace(srcText) != "" {
			return srcText
		}
	}

	text := ""
	switch typedMsg := rawMessage.(type) {
	case string:
		var parsed struct {
			Content any `json:"content"`
		}
		if json.Unmarshal([]byte(typedMsg), &parsed) == nil && parsed.Content != nil {
			text = readBlocks(parsed.Content)
		} else {
			text = typedMsg
		}
	case map[string]any:
		text = readBlocks(typedMsg["content"])
	}
	if role == "user" {
		if m := codebuddyUserQueryRe.FindStringSubmatch(text); len(m) >= 2 {
			return m[1]
		}
	}
	return text
}

func readCodebuddyIDEProjects(ctx context.Context, opts Options, targetProvider string) []Project {
	sessions := discoverCodebuddyIDESessions(ctx, opts, targetProvider, "")
	if len(sessions) == 0 {
		return nil
	}
	byProj := make(map[string]*Project)
	for _, s := range sessions {
		msgs, latestAt, ok := readCodebuddyIDESessionContent(s.indexPath)
		if !ok {
			continue
		}
		firstUserText := ""
		for _, m := range msgs {
			if m.role == "user" && strings.TrimSpace(m.content) != "" {
				firstUserText = m.content
				break
			}
		}
		updatedAt := s.updatedAt
		if latestAt > updatedAt {
			updatedAt = latestAt
		}
		proj, exists := byProj[s.projectDirName]
		if !exists {
			projPath := firstNonEmpty(s.cwd, s.projectDirName)
			proj = &Project{
				ID:       s.projectDirName,
				Name:     projectBaseName(projPath),
				Path:     projPath,
				Provider: targetProvider,
			}
			byProj[s.projectDirName] = proj
		}
		title := compactWhitespace(firstNonEmpty(s.title, firstUserText, proj.Name))
		if runes := []rune(title); len(runes) > 120 {
			title = string(runes[:120])
		}
		updated := false
		for i := range proj.Sessions {
			if proj.Sessions[i].ID == s.sessionID {
				if updatedAt > proj.Sessions[i].UpdatedAt {
					proj.Sessions[i] = Session{
						ID:             s.sessionID,
						Title:          title,
						UpdatedAt:      updatedAt,
						Provider:       targetProvider,
						ProjectDirName: s.projectDirName,
					}
				}
				updated = true
				break
			}
		}
		if !updated {
			proj.Sessions = append(proj.Sessions, Session{
				ID:             s.sessionID,
				Title:          title,
				UpdatedAt:      updatedAt,
				Provider:       targetProvider,
				ProjectDirName: s.projectDirName,
			})
		}
	}
	out := make([]Project, 0, len(byProj))
	for _, p := range byProj {
		sort.SliceStable(p.Sessions, func(i, j int) bool {
			return p.Sessions[i].UpdatedAt > p.Sessions[j].UpdatedAt
		})
		out = append(out, *p)
	}
	return out
}

// ResolveCodebuddySessionPath 在地区共享的 CLI projects 根与 IDE store 里查找会话文件。
func ResolveCodebuddySessionPath(ctx context.Context, opts Options, provider, sessionID, projectDirName string) string {
	normProvider := NormalizeProvider(provider)
	sid := strings.TrimSpace(sessionID)
	hostHome := strings.TrimSpace(opts.HostHomeDir)
	if !IsCodebuddyFamilyProvider(normProvider) || !IsSafePathSegment(sid) {
		return ""
	}
	projDir := strings.TrimSpace(projectDirName)
	if projDir != "" && !IsSafePathSegment(projDir) {
		return ""
	}

	if hostHome != "" {
		for _, root := range resolveCodebuddyProjectsRoots(hostHome, normProvider) {
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
	}

	if normProvider == "codebuddy" || normProvider == "codebuddycn" {
		candidates := discoverCodebuddyIDESessions(ctx, opts, normProvider, sid)
		sort.SliceStable(candidates, func(i, j int) bool {
			return candidates[i].updatedAt > candidates[j].updatedAt
		})
		for _, c := range candidates {
			if projDir != "" && c.projectDirName != projDir {
				continue
			}
			return c.indexPath
		}
	}
	return ""
}

// ReadCodebuddyMessages 解析 CodeBuddy/WorkBuddy 家族 CLI JSONL 与 IDE 消息。
func ReadCodebuddyMessages(ctx context.Context, opts Options, provider, sessionID, projectDirName string) ([]Message, int64, bool, error) {
	filePath := ResolveCodebuddySessionPath(ctx, opts, provider, sessionID, projectDirName)
	if filePath == "" {
		return nil, 0, false, nil
	}
	size, _, ok := fileSizeAndMtimeMs(filePath)
	if !ok {
		return nil, 0, false, nil
	}

	if filepath.Base(filePath) == "index.json" {
		parsed, _, ok := readCodebuddyIDESessionContent(filePath)
		if !ok {
			return nil, 0, false, nil
		}
		msgs := make([]Message, 0, len(parsed))
		for _, m := range parsed {
			if m.content == "" {
				continue
			}
			item := Message{
				Role:      m.role,
				Content:   m.content,
				Timestamp: formatISOFromMs(m.timestampMs),
			}
			if m.role == "assistant" && m.modelID != "" {
				item.Model = m.modelID
			}
			msgs = append(msgs, item)
		}
		return msgs, size, true, nil
	}

	var messages []Message
	callIDToMsgIdx := make(map[string]int)
	assistantIdx := -1

	ensureAssistant := func(rec map[string]any) int {
		if assistantIdx >= 0 && assistantIdx < len(messages) {
			if messages[assistantIdx].Model == "" {
				messages[assistantIdx].Model = readCodebuddyRecordModel(rec)
			}
			return assistantIdx
		}
		messages = append(messages, Message{
			Role:      "assistant",
			Content:   "",
			Timestamp: formatISOFromMs(ToTimestampMs(rec["timestamp"])),
			Model:     readCodebuddyRecordModel(rec),
		})
		assistantIdx = len(messages) - 1
		return assistantIdx
	}

	appendChunk := func(idx int, chunk string) {
		trimmed := strings.TrimSpace(chunk)
		if trimmed == "" || idx < 0 || idx >= len(messages) {
			return
		}
		if messages[idx].Content == "" {
			messages[idx].Content = trimmed
		} else {
			messages[idx].Content += "\n" + trimmed
		}
	}

	err := forEachJSONLLine(filePath, func(line []byte) bool {
		var rec map[string]any
		if json.Unmarshal(line, &rec) != nil {
			return true
		}
		recType := stringFromAny(rec["type"])
		switch recType {
		case "message":
			role := strings.TrimSpace(stringFromAny(rec["role"]))
			if role == "user" {
				assistantIdx = -1
				text := strings.TrimSpace(codebuddySystemReminderRe.ReplaceAllString(collectCodebuddyBlockText(rec["content"]), ""))
				if text != "" {
					messages = append(messages, Message{
						Role:      "user",
						Content:   text,
						Timestamp: formatISOFromMs(ToTimestampMs(rec["timestamp"])),
					})
				}
			} else if role == "assistant" {
				if text := strings.TrimSpace(collectCodebuddyBlockText(rec["content"])); text != "" {
					appendChunk(ensureAssistant(rec), text)
				}
			}
		case "reasoning":
			if thinking := collectCodebuddyReasoningText(rec); thinking != "" {
				appendChunk(ensureAssistant(rec), ":::thinking\n"+thinking+"\n:::")
			}
		case "function_call":
			toolName := firstNonEmpty(strings.TrimSpace(stringFromAny(rec["name"])), "tool")
			body := renderCodebuddyToolArgs(rec["arguments"])
			idx := ensureAssistant(rec)
			appendChunk(idx, ":::tool{name=\""+toolName+"\"}\n"+body+"\n:::")
			if callID := strings.TrimSpace(stringFromAny(rec["callId"])); callID != "" {
				callIDToMsgIdx[callID] = idx
			}
		case "function_call_result":
			resText := collectCodebuddyToolResult(rec["output"])
			if resText == "" {
				return true
			}
			if runes := []rune(resText); len(runes) > 300 {
				resText = string(runes[:300]) + "... (truncated)"
			}
			targetIdx := assistantIdx
			if callID := strings.TrimSpace(stringFromAny(rec["callId"])); callID != "" {
				if known, ok := callIDToMsgIdx[callID]; ok {
					targetIdx = known
				}
			}
			appendChunk(targetIdx, ":::tool-result\n"+resText+"\n:::")
		}
		return true
	})
	if err != nil {
		return nil, 0, true, err
	}
	return messages, size, true, nil
}

func readCodebuddyRecordModel(rec map[string]any) string {
	for _, key := range []string{"model", "modelId", "model_id"} {
		if m := NormalizeMessageModel(stringFromAny(rec[key])); m != "" {
			return m
		}
	}
	if meta, ok := rec["metadata"].(map[string]any); ok {
		for _, key := range []string{"model", "modelId", "model_id"} {
			if m := NormalizeMessageModel(stringFromAny(meta[key])); m != "" {
				return m
			}
		}
	}
	return ""
}

func collectCodebuddyBlockText(content any) string {
	if str, ok := content.(string); ok {
		return str
	}
	arr, ok := content.([]any)
	if !ok {
		return ""
	}
	var out []string
	for _, item := range arr {
		if str, ok := item.(string); ok {
			if strings.TrimSpace(str) != "" {
				out = append(out, str)
			}
			continue
		}
		obj, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if t := firstNonEmpty(stringFromAny(obj["text"]), stringFromAny(obj["thinking"])); t != "" {
			out = append(out, t)
		}
	}
	return strings.Join(out, "\n")
}

func collectCodebuddyReasoningText(rec map[string]any) string {
	for _, val := range []any{rec["summary"], rec["content"]} {
		if text := strings.TrimSpace(collectCodebuddyBlockText(val)); text != "" {
			return text
		}
	}
	return ""
}

func renderCodebuddyToolArgs(args any) string {
	if args == nil {
		return ""
	}
	if str, ok := args.(string); ok {
		if runes := []rune(str); len(runes) > 500 {
			return string(runes[:500])
		}
		return str
	}
	raw, _ := json.Marshal(args)
	s := string(raw)
	if runes := []rune(s); len(runes) > 500 {
		return string(runes[:500])
	}
	return s
}

func collectCodebuddyToolResult(output any) string {
	if output == nil {
		return ""
	}
	if str, ok := output.(string); ok {
		return strings.TrimSpace(str)
	}
	if arr, ok := output.([]any); ok {
		var parts []string
		for _, item := range arr {
			if str, ok := item.(string); ok {
				if strings.TrimSpace(str) != "" {
					parts = append(parts, strings.TrimSpace(str))
				}
				continue
			}
			if obj, ok := item.(map[string]any); ok {
				if t := firstNonEmpty(stringFromAny(obj["text"]), stringFromAny(obj["content"]), stringFromAny(obj["output"])); strings.TrimSpace(t) != "" {
					parts = append(parts, strings.TrimSpace(t))
				}
			}
		}
		return strings.Join(parts, "\n")
	}
	if obj, ok := output.(map[string]any); ok {
		if t := firstNonEmpty(stringFromAny(obj["text"]), stringFromAny(obj["content"]), stringFromAny(obj["output"])); strings.TrimSpace(t) != "" {
			return strings.TrimSpace(t)
		}
		raw, _ := json.Marshal(obj)
		return string(raw)
	}
	return ""
}

type cbCtxBudget struct{ ctx context.Context }
func (b cbCtxBudget) Take() bool { return b.ctx == nil || b.ctx.Err() == nil }
func (b cbCtxBudget) OutOfTime() bool { return b.ctx != nil && b.ctx.Err() != nil }
