package sessionread

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
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
	"unicode/utf8"
)

const codexMaxFunctionArgChars = 500

var (
	codexStateDBPattern       = regexp.MustCompile(`^state_(\d+)\.sqlite$`)
	codexMobilePreambleRegex  = regexp.MustCompile(`^\[Attachments sent from mobile\](?:\s*-\s*[^\r\n]+)*\s*`)
	codexImagePlaceholderRe   = regexp.MustCompile(`^<image[^>]*>\s*</image>$`)
	codexAttachedImagePathRe  = regexp.MustCompile(`(?i)\[Image:\s*([^\]]+)\]`)
	codexChunkIDLineRegex     = regexp.MustCompile(`^Chunk ID:\s*`)
	codexOutputLineRegex      = regexp.MustCompile(`^Output:\s*(.*)$`)
	codexConfigProjectHeader  = regexp.MustCompile(`^\[projects\."([^"]+)"\]`)
)

// ListCodexStateDBPaths 发现 ~/.codex 及 ~/.codex/sqlite 下的 state_<N>.sqlite 并按版本降序返回。
func ListCodexStateDBPaths(codexDir string) []string {
	type candidate struct {
		path    string
		version int
	}
	var all []candidate
	for _, dir := range []string{codexDir, filepath.Join(codexDir, "sqlite")} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			m := codexStateDBPattern.FindStringSubmatch(entry.Name())
			if len(m) < 2 {
				continue
			}
			ver, err := strconv.Atoi(m[1])
			if err != nil {
				continue
			}
			all = append(all, candidate{
				path:    filepath.Join(dir, entry.Name()),
				version: ver,
			})
		}
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].version != all[j].version {
			return all[i].version > all[j].version
		}
		return all[i].path < all[j].path
	})
	paths := make([]string, len(all))
	for i, item := range all {
		paths[i] = item.path
	}
	return paths
}

// ResolveCodexSessionPath 优先从 state_*.sqlite threads.rollout_path 查找，再回落递归扫描 ~/.codex/sessions。
func ResolveCodexSessionPath(ctx context.Context, hostHome, sessionID string) string {
	home := strings.TrimSpace(hostHome)
	sid := strings.TrimSpace(sessionID)
	if home == "" || !IsSafePathSegment(sid) {
		return ""
	}
	codexDir := filepath.Join(home, ".codex")
	for _, stateDBPath := range ListCodexStateDBPaths(codexDir) {
		if resolved := resolveCodexPathFromStateDB(ctx, codexDir, stateDBPath, sid); resolved != "" {
			return resolved
		}
	}
	sessionsDir := filepath.Join(codexDir, "sessions")
	if !dirExists(sessionsDir) {
		return ""
	}
	found := ""
	_ = filepath.WalkDir(sessionsDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		name := entry.Name()
		if strings.Contains(name, sid) && strings.HasSuffix(name, ".jsonl") {
			found = path
			return filepath.SkipAll
		}
		return nil
	})
	return found
}

func resolveCodexPathFromStateDB(ctx context.Context, codexDir, dbPath, sessionID string) string {
	db, exists, err := openReadOnlySQLite(ctx, dbPath)
	if err != nil || !exists {
		return ""
	}
	defer db.Close()

	if !sqliteTableExists(ctx, db, "threads") {
		return ""
	}
	cols := getSQLiteTableColumns(ctx, db, "threads")
	if !cols["id"] || !cols["rollout_path"] {
		return ""
	}
	var rolloutPath sql.NullString
	if err := db.QueryRowContext(ctx, `SELECT rollout_path FROM threads WHERE id = ? LIMIT 1`, sessionID).Scan(&rolloutPath); err != nil {
		return ""
	}
	raw := strings.TrimSpace(rolloutPath.String)
	if raw == "" {
		return ""
	}
	candidates := []string{raw}
	if !filepath.IsAbs(raw) {
		candidates = append(candidates, filepath.Join(codexDir, raw))
	}
	for _, candidate := range candidates {
		if fileExistsRegular(candidate) && strings.Contains(filepath.Base(candidate), sessionID) {
			return candidate
		}
	}
	return ""
}

// codexChildDescriptor 描述从 thread_spawn_edges + threads 查到的子代理线程摘要。
type codexChildDescriptor struct {
	SessionID     string `json:"sessionId"`
	Status        string `json:"status"`
	AgentPath     string `json:"agentPath"`
	TaskName      string `json:"taskName"`
	AgentNickname string `json:"agentNickname"`
	AgentRole     string `json:"agentRole"`
	CreatedAt     int64  `json:"createdAt"`
	UpdatedAt     int64  `json:"updatedAt"`
}

func (d codexChildDescriptor) toMap() map[string]any {
	return map[string]any{
		"sessionId":     d.SessionID,
		"status":        d.Status,
		"agentPath":     d.AgentPath,
		"taskName":      d.TaskName,
		"agentNickname": d.AgentNickname,
		"agentRole":     d.AgentRole,
		"createdAt":     d.CreatedAt,
		"updatedAt":     d.UpdatedAt,
	}
}

func readCodexChildThreadDescriptors(ctx context.Context, codexDir, parentThreadID string) []codexChildDescriptor {
	parentID := strings.TrimSpace(parentThreadID)
	if parentID == "" {
		return nil
	}
	for _, stateDBPath := range ListCodexStateDBPaths(codexDir) {
		db, exists, err := openReadOnlySQLite(ctx, stateDBPath)
		if err != nil || !exists {
			continue
		}
		descriptors, ok := queryCodexChildDescriptors(ctx, db, parentID)
		_ = db.Close()
		if ok {
			return descriptors
		}
	}
	return nil
}

func queryCodexChildDescriptors(ctx context.Context, db *sql.DB, parentID string) ([]codexChildDescriptor, bool) {
	edgeCols := getSQLiteTableColumns(ctx, db, "thread_spawn_edges")
	if !edgeCols["parent_thread_id"] || !edgeCols["child_thread_id"] {
		return nil, false
	}
	threadCols := getSQLiteTableColumns(ctx, db, "threads")
	canJoin := threadCols["id"]

	selThreadCol := func(col string) string {
		if canJoin && threadCols[col] {
			return "t." + col + " AS " + col
		}
		return "NULL AS " + col
	}
	statusExpr := "'' AS status"
	if edgeCols["status"] {
		statusExpr = "e.status AS status"
	}
	joinClause := ""
	if canJoin {
		joinClause = "LEFT JOIN threads t ON t.id = e.child_thread_id"
	}
	query := `SELECT e.child_thread_id, ` + statusExpr + `, ` +
		selThreadCol("source") + `, ` +
		selThreadCol("agent_path") + `, ` +
		selThreadCol("agent_nickname") + `, ` +
		selThreadCol("agent_role") + `, ` +
		selThreadCol("created_at") + `, ` +
		selThreadCol("created_at_ms") + `, ` +
		selThreadCol("updated_at") + `, ` +
		selThreadCol("updated_at_ms") +
		` FROM thread_spawn_edges e ` + joinClause + ` WHERE e.parent_thread_id = ?`

	rows, err := db.QueryContext(ctx, query, parentID)
	if err != nil {
		return nil, false
	}
	defer rows.Close()

	var descriptors []codexChildDescriptor
	for rows.Next() {
		var childID, status string
		var srcRaw, agentPathRaw, nicknameRaw, roleRaw sql.NullString
		var createdAtRaw, createdAtMsRaw, updatedAtRaw, updatedAtMsRaw sql.NullFloat64
		if scanErr := rows.Scan(&childID, &status, &srcRaw, &agentPathRaw, &nicknameRaw, &roleRaw,
			&createdAtRaw, &createdAtMsRaw, &updatedAtRaw, &updatedAtMsRaw); scanErr != nil {
			continue
		}
		cid := strings.TrimSpace(childID)
		if cid == "" {
			continue
		}
		meta := parseCodexSubagentSourceMeta(srcRaw.String)
		agentPath := firstNonEmpty(strings.TrimSpace(agentPathRaw.String), meta.agentPath)
		descriptors = append(descriptors, codexChildDescriptor{
			SessionID:     cid,
			Status:        strings.TrimSpace(status),
			AgentPath:     agentPath,
			TaskName:      codexSubagentTaskName(agentPath),
			AgentNickname: firstNonEmpty(strings.TrimSpace(nicknameRaw.String), meta.agentNickname),
			AgentRole:     firstNonEmpty(strings.TrimSpace(roleRaw.String), meta.agentRole),
			CreatedAt:     pickCodexEpochMs(createdAtMsRaw, createdAtRaw),
			UpdatedAt:     pickCodexEpochMs(updatedAtMsRaw, updatedAtRaw),
		})
	}
	sort.SliceStable(descriptors, func(i, j int) bool {
		if descriptors[i].CreatedAt != descriptors[j].CreatedAt {
			return descriptors[i].CreatedAt < descriptors[j].CreatedAt
		}
		return descriptors[i].SessionID < descriptors[j].SessionID
	})
	return descriptors, true
}

type codexSourceMeta struct {
	agentPath     string
	agentNickname string
	agentRole     string
}

func parseCodexSubagentSourceMeta(raw string) codexSourceMeta {
	trimmed := strings.TrimSpace(raw)
	if !strings.HasPrefix(trimmed, "{") {
		return codexSourceMeta{}
	}
	var doc map[string]any
	if json.Unmarshal([]byte(trimmed), &doc) != nil {
		return codexSourceMeta{}
	}
	subagent, _ := doc["subagent"].(map[string]any)
	if subagent == nil {
		return codexSourceMeta{}
	}
	spawn, _ := subagent["thread_spawn"].(map[string]any)
	if spawn == nil {
		return codexSourceMeta{}
	}
	return codexSourceMeta{
		agentPath:     strings.TrimSpace(stringFromAny(spawn["agent_path"])),
		agentNickname: strings.TrimSpace(stringFromAny(spawn["agent_nickname"])),
		agentRole:     strings.TrimSpace(stringFromAny(spawn["agent_role"])),
	}
}

func codexSubagentTaskName(agentPath string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(agentPath), "/")
	if trimmed == "" {
		return ""
	}
	parts := strings.Split(trimmed, "/")
	for i := len(parts) - 1; i >= 0; i-- {
		if parts[i] != "" {
			return parts[i]
		}
	}
	return ""
}

func pickCodexEpochMs(msVal, secVal sql.NullFloat64) int64 {
	if msVal.Valid && msVal.Float64 > 0 {
		return int64(math.Round(msVal.Float64))
	}
	if secVal.Valid && secVal.Float64 > 0 {
		return normalizeEpochNumber(secVal.Float64)
	}
	return 0
}

type codexSubagentResolver struct {
	descriptors   []codexChildDescriptor
	byTaskName    map[string][]*codexChildDescriptor
	usedSessionID map[string]bool
	byCallID      map[string]*codexChildDescriptor
}

func newCodexSubagentResolver(descriptors []codexChildDescriptor) *codexSubagentResolver {
	r := &codexSubagentResolver{
		descriptors:   make([]codexChildDescriptor, len(descriptors)),
		byTaskName:    make(map[string][]*codexChildDescriptor),
		usedSessionID: make(map[string]bool),
		byCallID:      make(map[string]*codexChildDescriptor),
	}
	copy(r.descriptors, descriptors)
	for i := range r.descriptors {
		desc := &r.descriptors[i]
		taskName := codexSubagentTaskName(firstNonEmpty(desc.TaskName, desc.AgentPath))
		if taskName != "" {
			r.byTaskName[taskName] = append(r.byTaskName[taskName], desc)
		}
	}
	return r
}

func (r *codexSubagentResolver) resolve(callID, taskName string) *codexChildDescriptor {
	cid := strings.TrimSpace(callID)
	if cid != "" {
		if existing, ok := r.byCallID[cid]; ok {
			return existing
		}
	}
	normalizedName := codexSubagentTaskName(taskName)
	var chosen *codexChildDescriptor
	if normalizedName != "" {
		for _, candidate := range r.byTaskName[normalizedName] {
			if !r.usedSessionID[candidate.SessionID] {
				chosen = candidate
				break
			}
		}
	}
	if chosen == nil && normalizedName == "" {
		for i := range r.descriptors {
			candidate := &r.descriptors[i]
			if candidate.TaskName == "" && !r.usedSessionID[candidate.SessionID] {
				chosen = candidate
				break
			}
		}
	}
	if chosen != nil {
		r.usedSessionID[chosen.SessionID] = true
		if cid != "" {
			r.byCallID[cid] = chosen
		}
	}
	return chosen
}

func (r *codexSubagentResolver) fromOutput(callID, output string) *codexChildDescriptor {
	cid := strings.TrimSpace(callID)
	if cid != "" {
		if existing, ok := r.byCallID[cid]; ok {
			return existing
		}
	}
	trimmed := strings.TrimSpace(output)
	if !strings.HasPrefix(trimmed, "{") {
		return nil
	}
	var parsed struct {
		AgentID string `json:"agent_id"`
	}
	if json.Unmarshal([]byte(trimmed), &parsed) != nil {
		return nil
	}
	agentID := strings.TrimSpace(parsed.AgentID)
	if agentID == "" {
		return nil
	}
	for i := range r.descriptors {
		if r.descriptors[i].SessionID == agentID {
			desc := &r.descriptors[i]
			r.usedSessionID[desc.SessionID] = true
			if cid != "" {
				r.byCallID[cid] = desc
			}
			return desc
		}
	}
	desc := &codexChildDescriptor{SessionID: agentID}
	r.usedSessionID[agentID] = true
	if cid != "" {
		r.byCallID[cid] = desc
	}
	return desc
}

func (r *codexSubagentResolver) unmatched() []codexChildDescriptor {
	var out []codexChildDescriptor
	for _, desc := range r.descriptors {
		if !r.usedSessionID[desc.SessionID] {
			out = append(out, desc)
		}
	}
	return out
}

type codexCallResultInfo struct {
	output    string
	parsedCmd []any
	cwd       string
}

type codexAssistantPart struct {
	text    string
	isTool  bool
	payload map[string]any
}

type codexAssistantState struct {
	parts        []*codexAssistantPart
	timestamp    string
	model        string
	messageIndex int
}

type codexParsedUserMsg struct {
	content   string
	images    []string
	timestamp string
	source    string
}

type codexMsgEntry struct {
	role      string
	content   string
	images    []string
	timestamp string
	model     string
	source    string
}

// ReadCodexMessagesSnapshot 解析 Codex rollout JSONL（含子代理与工具输出）返回完整消息与字节光标。
func ReadCodexMessagesSnapshot(ctx context.Context, hostHome, sessionID string) ([]json.RawMessage, int64, bool, error) {
	filePath := ResolveCodexSessionPath(ctx, hostHome, sessionID)
	if filePath == "" {
		return nil, 0, false, nil
	}
	info, err := os.Stat(filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, 0, false, nil
		}
		return nil, 0, true, err
	}
	if !info.Mode().IsRegular() {
		return nil, 0, false, nil
	}

	codexDir := filepath.Join(strings.TrimSpace(hostHome), ".codex")
	resolver := newCodexSubagentResolver(readCodexChildThreadDescriptors(ctx, codexDir, sessionID))

	var messages []codexMsgEntry
	var currentAssistant *codexAssistantState
	activeModel := ""
	callResultMap := make(map[string]*codexCallResultInfo)
	toolCallPartMap := make(map[string]struct {
		part  *codexAssistantPart
		owner *codexAssistantState
	})

	serializeAssistant := func(a *codexAssistantState) string {
		if a == nil {
			return ""
		}
		var parts []string
		for _, p := range a.parts {
			if t := strings.TrimSpace(p.text); t != "" {
				parts = append(parts, t)
			}
		}
		return strings.TrimSpace(strings.Join(parts, "\n\n"))
	}

	flushAssistant := func() {
		if currentAssistant == nil {
			return
		}
		content := serializeAssistant(currentAssistant)
		if content != "" {
			currentAssistant.messageIndex = len(messages)
			messages = append(messages, codexMsgEntry{
				role:      "assistant",
				content:   content,
				timestamp: currentAssistant.timestamp,
				model:     currentAssistant.model,
			})
		}
		currentAssistant = nil
	}

	ensureAssistant := func(ts string) *codexAssistantState {
		if currentAssistant == nil {
			currentAssistant = &codexAssistantState{
				timestamp:    ts,
				model:        activeModel,
				messageIndex: -1,
			}
		}
		if currentAssistant.timestamp == "" {
			currentAssistant.timestamp = ts
		}
		if currentAssistant.model == "" && activeModel != "" {
			currentAssistant.model = activeModel
		}
		return currentAssistant
	}

	upsertUser := func(u codexParsedUserMsg) {
		rawImages := mergeUniqueCodexStrings(nil, u.images)
		stripped, source := stripCodexMobilePreamble(u.content)
		cleaned := cleanCodexUserContent(stripped, len(rawImages) > 0)
		msgKey := compactWhitespace(cleaned)
		images := mergeCodexUserImages(nil, rawImages)
		if isSyntheticCodexUserContent(cleaned) || (cleaned == "" && len(images) == 0) {
			return
		}
		existingIdx := -1
		for i := len(messages) - 1; i >= 0; i-- {
			if messages[i].role != "user" {
				continue
			}
			if !areCloseCodexTimestamps(messages[i].timestamp, u.timestamp) {
				continue
			}
			if compactWhitespace(messages[i].content) == msgKey {
				existingIdx = i
				break
			}
		}
		if existingIdx >= 0 {
			existing := &messages[existingIdx]
			if len(cleaned) > len(strings.TrimSpace(existing.content)) {
				existing.content = cleaned
			}
			existing.images = mergeCodexUserImages(existing.images, images)
			if existing.source == "" && source != "" {
				existing.source = source
			}
			return
		}
		messages = append(messages, codexMsgEntry{
			role:      "user",
			content:   cleaned,
			images:    images,
			timestamp: u.timestamp,
			source:    source,
		})
	}

	updateToolCall := func(callID string) {
		entry, ok := toolCallPartMap[callID]
		if !ok {
			return
		}
		rendered, keep := formatCodexFunctionCall(entry.part.payload, callResultMap[callID])
		if !keep {
			return
		}
		entry.part.text = rendered
		if entry.owner != nil && entry.owner.messageIndex >= 0 && entry.owner.messageIndex < len(messages) {
			content := serializeAssistant(entry.owner)
			if content != "" {
				messages[entry.owner.messageIndex].content = content
			}
		}
	}

	appendToolCall := func(payload map[string]any, ts string) {
		name := strings.TrimSpace(stringFromAny(payload["name"]))
		if name == "spawn_agent" && payload["subagent"] == nil {
			var args map[string]any
			_ = json.Unmarshal([]byte(stringFromAny(payload["arguments"])), &args)
			taskName := stringFromAny(args["task_name"])
			if desc := resolver.resolve(stringFromAny(payload["call_id"]), taskName); desc != nil {
				clone := make(map[string]any, len(payload)+1)
				for k, v := range payload {
					clone[k] = v
				}
				clone["subagent"] = desc.toMap()
				payload = clone
			}
		}
		rendered, keep := formatCodexFunctionCall(payload, callResultMap[stringFromAny(payload["call_id"])])
		if !keep {
			return
		}
		owner := ensureAssistant(ts)
		part := &codexAssistantPart{text: rendered, isTool: true, payload: payload}
		owner.parts = append(owner.parts, part)
		if callID := stringFromAny(payload["call_id"]); callID != "" {
			toolCallPartMap[callID] = struct {
				part  *codexAssistantPart
				owner *codexAssistantState
			}{part: part, owner: owner}
		}
	}

	// 读取 rollout JSONL 并记录合法结尾行后的字节偏移作为 snapshot cursor
	file, err := os.Open(filePath)
	if err != nil {
		return nil, 0, true, err
	}
	defer file.Close()

	reader := bufio.NewReaderSize(file, 64*1024)
	var offset int64
	cursor := int64(0)
	for {
		line, readErr := reader.ReadBytes('\n')
		lineLen := int64(len(line))
		isEOF := errors.Is(readErr, io.EOF)
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) > 0 {
			var record map[string]any
			if json.Unmarshal(trimmed, &record) == nil {
				cursor = offset + lineLen
				recType := stringFromAny(record["type"])
				ts := stringFromAny(record["timestamp"])
				payload, _ := record["payload"].(map[string]any)
				if payload == nil {
					payload = map[string]any{}
				}
				switch recType {
				case "turn_context":
					if m := NormalizeMessageModel(stringFromAny(payload["model"])); m != "" {
						activeModel = m
						if currentAssistant != nil && currentAssistant.model == "" {
							currentAssistant.model = activeModel
						}
					}
				case "response_item":
					pType := stringFromAny(payload["type"])
					pRole := stringFromAny(payload["role"])
					switch {
					case pType == "message" && pRole == "user":
						flushAssistant()
						content, imgs := extractCodexUserResponse(payload)
						upsertUser(codexParsedUserMsg{content: content, images: imgs, timestamp: ts})
					case pRole == "assistant":
						if blocks, ok := payload["content"].([]any); ok {
							var texts []string
							for _, b := range blocks {
								obj, ok := b.(map[string]any)
								if ok && obj["type"] == "output_text" {
									if t := stringFromAny(obj["text"]); t != "" {
										texts = append(texts, t)
									}
								}
							}
							if joined := strings.TrimSpace(strings.Join(texts, "\n")); joined != "" {
								ensureAssistant(ts).parts = append(ensureAssistant(ts).parts, &codexAssistantPart{text: joined})
							}
						}
					case pType == "function_call":
						appendToolCall(payload, ts)
					case pType == "function_call_output":
						callID := stringFromAny(payload["call_id"])
						if callID != "" {
							if _, exists := callResultMap[callID]; !exists {
								toolName := firstNonEmpty(stringFromAny(payload["name"]), stringFromAny(payload["tool_name"]))
								outText := extractCodexFunctionOutput(payload["output"])
								if toolName == "exec_command" || toolName == "shell" {
									outText = cleanCodexExecOutput(outText)
								}
								if entry, ok := toolCallPartMap[callID]; ok && stringFromAny(entry.part.payload["name"]) == "spawn_agent" {
									if desc := resolver.fromOutput(callID, outText); desc != nil {
										clone := make(map[string]any, len(entry.part.payload)+1)
										for k, v := range entry.part.payload {
											clone[k] = v
										}
										clone["subagent"] = desc.toMap()
										entry.part.payload = clone
									}
								}
								callResultMap[callID] = &codexCallResultInfo{output: trimCodexOutput(outText, 300)}
								updateToolCall(callID)
							}
						}
					}
				case "event_msg":
					pType := stringFromAny(payload["type"])
					switch {
					case pType == "user_message" && stringFromAny(payload["message"]) != "":
						flushAssistant()
						imgs := mergeUniqueCodexStrings(payload["images"], payload["local_images"])
						renderImgs := make([]string, len(imgs))
						for idx, img := range imgs {
							renderImgs[idx] = toRenderableCodexImage(img)
						}
						upsertUser(codexParsedUserMsg{
							content:   stringFromAny(payload["message"]),
							images:    renderImgs,
							timestamp: ts,
						})
					case pType == "exec_command_end":
						if callID := stringFromAny(payload["call_id"]); callID != "" {
							agg := firstNonEmpty(
								strings.TrimSpace(stringFromAny(payload["aggregated_output"])),
								strings.TrimSpace(stringFromAny(payload["formatted_output"])),
								strings.TrimSpace(stringFromAny(payload["stdout"])),
								strings.TrimSpace(stringFromAny(payload["stderr"])),
							)
							var parsedCmd []any
							if items, ok := payload["parsed_cmd"].([]any); ok {
								parsedCmd = items
							}
							callResultMap[callID] = &codexCallResultInfo{
								output:    trimCodexOutput(cleanCodexExecOutput(agg), 300),
								parsedCmd: parsedCmd,
								cwd:       strings.TrimSpace(stringFromAny(payload["cwd"])),
							}
							updateToolCall(callID)
						}
					}
				}
			}
		} else {
			cursor = offset + lineLen
		}
		offset += lineLen
		if readErr != nil {
			if isEOF {
				break
			}
			return nil, 0, true, readErr
		}
	}

	for _, desc := range resolver.unmatched() {
		taskName := firstNonEmpty(desc.TaskName, "subagent")
		argsJSON, _ := json.Marshal(map[string]string{"task_name": taskName})
		ts := formatISOFromMs(desc.CreatedAt)
		appendToolCall(map[string]any{
			"type":      "function_call",
			"name":      "spawn_agent",
			"call_id":   "unlinked-subagent:" + desc.SessionID,
			"arguments": string(argsJSON),
			"subagent":  desc.toMap(),
		}, ts)
	}
	flushAssistant()

	encoded := make([]json.RawMessage, 0, len(messages))
	for _, msg := range messages {
		obj := map[string]any{
			"role":      msg.role,
			"content":   msg.content,
			"timestamp": msg.timestamp,
		}
		if msg.role == "user" {
			if msg.images == nil {
				obj["images"] = []string{}
			} else {
				obj["images"] = msg.images
			}
			if msg.source != "" {
				obj["source"] = msg.source
			}
		}
		if msg.model != "" {
			obj["model"] = msg.model
		}
		raw, err := json.Marshal(obj)
		if err == nil {
			encoded = append(encoded, raw)
		}
	}
	return encoded, cursor, true, nil
}

func extractCodexUserResponse(payload map[string]any) (string, []string) {
	blocks, _ := payload["content"].([]any)
	var texts []string
	var imgs []string
	for _, item := range blocks {
		obj, ok := item.(map[string]any)
		if !ok {
			continue
		}
		switch stringFromAny(obj["type"]) {
		case "input_text":
			if t := strings.TrimSpace(stringFromAny(obj["text"])); t != "" {
				texts = append(texts, t)
			}
		case "input_image":
			src := firstNonEmpty(stringFromAny(obj["image_url"]), stringFromAny(obj["url"]))
			if src != "" {
				imgs = append(imgs, toRenderableCodexImage(src))
			}
		}
	}
	return strings.TrimSpace(strings.Join(texts, "\n")), imgs
}

func stripCodexMobilePreamble(raw string) (string, string) {
	if strings.HasPrefix(raw, "[Attachments sent from mobile]") {
		return strings.TrimSpace(codexMobilePreambleRegex.ReplaceAllString(raw, "")), "codex-mobile"
	}
	return raw, ""
}

func cleanCodexUserContent(raw string, hasImages bool) string {
	trimmed := strings.TrimSpace(raw)
	if !hasImages || trimmed == "" {
		return trimmed
	}
	if codexImagePlaceholderRe.MatchString(trimmed) {
		return ""
	}
	return trimmed
}

func isSyntheticCodexUserContent(content string) bool {
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return false
	}
	if strings.HasPrefix(trimmed, "# AGENTS.md instructions for ") ||
		strings.HasPrefix(trimmed, "<INSTRUCTIONS>") ||
		strings.HasPrefix(trimmed, "<environment_context>") ||
		strings.HasPrefix(trimmed, "<permissions instructions>") ||
		strings.HasPrefix(trimmed, "<app-context>") ||
		strings.HasPrefix(trimmed, "<collaboration_mode>") ||
		strings.HasPrefix(trimmed, "<turn_aborted>") {
		return true
	}
	return strings.HasPrefix(trimmed, "<user_instructions>") && strings.Contains(trimmed, "</user_instructions>")
}

func areCloseCodexTimestamps(left, right string) bool {
	lm := parseISOTimestampMs(left)
	rm := parseISOTimestampMs(right)
	if lm == 0 || rm == 0 {
		return left != "" && left == right
	}
	diff := lm - rm
	if diff < 0 {
		diff = -diff
	}
	return diff <= 1000
}

func mergeUniqueCodexStrings(primary any, secondary any) []string {
	seen := make(map[string]bool)
	var out []string
	addVal := func(v any) {
		switch typed := v.(type) {
		case []string:
			for _, item := range typed {
				if trimmed := strings.TrimSpace(item); trimmed != "" && !seen[trimmed] {
					seen[trimmed] = true
					out = append(out, trimmed)
				}
			}
		case []any:
			for _, raw := range typed {
				if trimmed := strings.TrimSpace(stringFromAny(raw)); trimmed != "" && !seen[trimmed] {
					seen[trimmed] = true
					out = append(out, trimmed)
				}
			}
		}
	}
	addVal(primary)
	addVal(secondary)
	return out
}

func toRenderableCodexImage(source string) string {
	trimmed := strings.TrimSpace(source)
	if trimmed == "" {
		return ""
	}
	if strings.HasPrefix(trimmed, "data:image/") ||
		strings.HasPrefix(trimmed, "http://") ||
		strings.HasPrefix(trimmed, "https://") {
		return trimmed
	}
	if !filepath.IsAbs(trimmed) {
		return trimmed
	}
	mimeType := guessCodexImageMime(trimmed)
	if mimeType == "" {
		return trimmed
	}
	data, err := os.ReadFile(trimmed)
	if err != nil {
		return trimmed
	}
	return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data)
}

func guessCodexImageMime(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	case ".bmp":
		return "image/bmp"
	case ".svg":
		return "image/svg+xml"
	case ".avif":
		return "image/avif"
	default:
		return ""
	}
}

func mergeCodexUserImages(existing, incoming []string) []string {
	merged := make([]string, 0, len(existing)+len(incoming))
	for _, src := range append(append([]string(nil), existing...), incoming...) {
		s := strings.TrimSpace(src)
		if s == "" {
			continue
		}
		found := false
		for _, prev := range merged {
			if prev == s {
				found = true
				break
			}
		}
		if !found {
			merged = append(merged, s)
		}
	}
	return merged
}

func extractCodexFunctionOutput(output any) string {
	if s, ok := output.(string); ok {
		return s
	}
	if items, ok := output.([]any); ok {
		var parts []string
		for _, item := range items {
			obj, ok := item.(map[string]any)
			if !ok {
				continue
			}
			t := stringFromAny(obj["type"])
			switch t {
			case "input_text", "output_text", "text":
				if txt := strings.TrimSpace(stringFromAny(obj["text"])); txt != "" {
					parts = append(parts, txt)
				}
			case "input_image", "output_image":
				src := firstNonEmpty(stringFromAny(obj["image_url"]), stringFromAny(obj["url"]), stringFromAny(obj["path"]))
				if src != "" {
					parts = append(parts, "[Image: "+src+"]")
				}
			}
		}
		return strings.Join(parts, "\n")
	}
	if output == nil {
		return ""
	}
	raw, _ := json.Marshal(output)
	return string(raw)
}

func cleanCodexExecOutput(output string) string {
	if output == "" {
		return ""
	}
	lines := strings.Split(output, "\n")
	if len(lines) > 0 && codexChunkIDLineRegex.MatchString(lines[0]) {
		idx := -1
		for i, line := range lines {
			if codexOutputLineRegex.MatchString(line) {
				idx = i
				break
			}
		}
		if idx >= 0 {
			m := codexOutputLineRegex.FindStringSubmatch(lines[idx])
			first := ""
			if len(m) >= 2 {
				first = m[1]
			}
			var rest []string
			if first != "" {
				rest = append(rest, first)
			}
			rest = append(rest, lines[idx+1:]...)
			return strings.TrimSpace(strings.Join(rest, "\n"))
		}
	}
	return strings.TrimSpace(output)
}

func trimCodexOutput(text string, maxLen int) string {
	trimmed := strings.TrimSpace(text)
	if len(trimmed) <= maxLen {
		return trimmed
	}
	return trimmed[:maxLen] + "... (truncated)"
}

func formatCodexFunctionCall(payload map[string]any, result *codexCallResultInfo) (string, bool) {
	name := firstNonEmpty(strings.TrimSpace(stringFromAny(payload["name"])), "Unknown")
	switch name {
	case "write_stdin", "send_input", "resize_run_terminal", "read_thread_terminal":
		return "", false
	}

	rawArgs := stringFromAny(payload["arguments"])
	args := make(map[string]any)
	_ = json.Unmarshal([]byte(rawArgs), &args)

	toolName := name
	body := ""
	switch name {
	case "exec_command", "shell":
		var primary map[string]any
		if result != nil && len(result.parsedCmd) > 0 {
			primary, _ = result.parsedCmd[0].(map[string]any)
		}
		pType := strings.TrimSpace(stringFromAny(primary["type"]))
		switch pType {
		case "read":
			toolName = "Read"
			body = firstNonEmpty(stringFromAny(primary["path"]), stringFromAny(primary["name"]), stringFromAny(args["cmd"]), stringFromAny(args["command"]))
		case "write":
			toolName = "Write"
			body = firstNonEmpty(stringFromAny(primary["path"]), stringFromAny(primary["name"]), stringFromAny(args["cmd"]), stringFromAny(args["command"]))
		case "edit":
			toolName = "Edit"
			body = firstNonEmpty(stringFromAny(primary["path"]), stringFromAny(primary["name"]), stringFromAny(args["cmd"]), stringFromAny(args["command"]))
		default:
			toolName = "Terminal"
			body = firstNonEmpty(stringFromAny(args["cmd"]), stringFromAny(args["command"]))
			cwd := ""
			if result != nil && result.cwd != "" {
				cwd = result.cwd
			} else {
				cwd = strings.TrimSpace(stringFromAny(args["workdir"]))
			}
			if cwd != "" {
				body += "\n# cwd: " + cwd
			}
		}
	case "create_file", "write_file":
		toolName = "Write"
		body = firstNonEmpty(stringFromAny(args["path"]), stringFromAny(args["file_path"]))
	case "read_file":
		toolName = "Read"
		body = firstNonEmpty(stringFromAny(args["path"]), stringFromAny(args["file_path"]))
	case "apply_diff", "edit_file", "apply_patch":
		toolName = "Edit"
		body = firstNonEmpty(stringFromAny(args["path"]), stringFromAny(args["file_path"]))
	case "TodoWrite":
		if todos, ok := args["todos"].([]any); ok {
			raw, _ := json.Marshal(todos)
			body = string(raw)
		} else {
			body = sliceRunes(rawArgs, codexMaxFunctionArgChars)
		}
	case "Task", "update_plan":
		planKey := "tasks"
		var items any
		if v, ok := args["tasks"].([]any); ok {
			items = v
		} else if v, ok := args["plan"].([]any); ok {
			items = v
			planKey = "plan"
			toolName = "update_plan"
		} else if v, ok := args["items"].([]any); ok {
			items = v
		}
		if items != nil {
			obj := map[string]any{
				"explanation": stringFromAny(args["explanation"]),
				planKey:       items,
			}
			raw, _ := json.Marshal(obj)
			body = string(raw)
		} else {
			body = sliceRunes(rawArgs, codexMaxFunctionArgChars)
		}
	case "request_user_input":
		q, _ := args["questions"].([]any)
		if q == nil {
			q = []any{}
		}
		raw, _ := json.Marshal(map[string]any{"questions": q})
		body = string(raw)
	case "spawn_agent":
		sub, _ := payload["subagent"].(map[string]any)
		obj := map[string]any{
			"task_name":        strings.TrimSpace(stringFromAny(args["task_name"])),
			"child_session_id": strings.TrimSpace(stringFromAny(sub["sessionId"])),
			"agent_path":       strings.TrimSpace(stringFromAny(sub["agentPath"])),
			"agent_nickname":   strings.TrimSpace(stringFromAny(sub["agentNickname"])),
			"agent_role":       strings.TrimSpace(stringFromAny(sub["agentRole"])),
			"status":           strings.TrimSpace(stringFromAny(sub["status"])),
			"created_at":       sub["createdAt"],
			"updated_at":       sub["updatedAt"],
		}
		raw, _ := json.Marshal(obj)
		body = string(raw)
	default:
		if name == "create_goal" || name == "update_goal" || name == "get_goal" {
			if json.Valid([]byte(rawArgs)) && rawArgs != "" {
				var compact bytes.Buffer
				if json.Compact(&compact, []byte(rawArgs)) == nil {
					body = compact.String()
				} else {
					body = rawArgs
				}
			} else {
				body = "{}"
			}
		} else {
			body = sliceRunes(rawArgs, codexMaxFunctionArgChars)
		}
	}

	hasChildSession := false
	if name == "spawn_agent" {
		if sub, ok := payload["subagent"].(map[string]any); ok {
			hasChildSession = strings.TrimSpace(stringFromAny(sub["sessionId"])) != ""
		}
	}
	resText := ""
	if !hasChildSession && result != nil {
		resText = result.output
	}
	out := "\n:::tool{name=\"" + toolName + "\"}\n" + body + "\n:::\n"
	if resText != "" {
		out += "\n:::tool-result\n" + resText + "\n:::\n"
	}
	return out, true
}

func sliceRunes(s string, maxChars int) string {
	if utf8.RuneCountInString(s) <= maxChars {
		return s
	}
	runes := []rune(s)
	return string(runes[:maxChars])
}

// CollectCodexWorkspaceRoots 从 ~/.codex/config.toml 读取已信任/配置的工作区路径列表。
func CollectCodexWorkspaceRoots(hostHome string) []string {
	home := strings.TrimSpace(hostHome)
	if home == "" {
		return nil
	}
	raw, err := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if err != nil {
		return nil
	}
	var roots []string
	seen := make(map[string]bool)
	for _, line := range strings.Split(string(raw), "\n") {
		if m := codexConfigProjectHeader.FindStringSubmatch(strings.TrimSpace(line)); len(m) >= 2 {
			p := NormalizeProjectPath(m[1])
			if p != "" && !seen[p] {
				seen[p] = true
				roots = append(roots, p)
			}
		}
	}
	return roots
}

// IsCodexTopLevelInteractiveThread 判断国家数据库行/会话是否属于顶级可显示交互会话。
func IsCodexTopLevelInteractiveThread(sessionID, cwd, source, threadSource, parentThreadID string, spawnedChildIDs map[string]bool) bool {
	sid := strings.TrimSpace(sessionID)
	if sid != "" && spawnedChildIDs[sid] {
		return false
	}
	if strings.EqualFold(strings.TrimSpace(threadSource), "subagent") {
		return false
	}
	if strings.TrimSpace(parentThreadID) != "" {
		return false
	}
	srcTrimmed := strings.TrimSpace(source)
	if strings.HasPrefix(srcTrimmed, "{") {
		var parsed map[string]any
		if json.Unmarshal([]byte(srcTrimmed), &parsed) == nil {
			if v, ok := parsed["subagent"]; ok && v != nil {
				return false
			}
		}
	}
	normCwd := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(cwd), `\`, "/"))
	if strings.Contains(normCwd, "/.codex/worktrees/") {
		return false
	}
	if srcTrimmed != "" && !strings.HasPrefix(srcTrimmed, "{") {
		lower := strings.ToLower(srcTrimmed)
		if lower != "cli" && lower != "vscode" {
			return false
		}
	}
	return true
}


// ReadCodexExcludedThreadIDs 从 ~/.codex/state_*.sqlite 提取已归档或非顶层交互线程（如子代理）ID 集合。
func ReadCodexExcludedThreadIDs(ctx context.Context, hostHome string) map[string]bool {
	excluded := make(map[string]bool)
	home := strings.TrimSpace(hostHome)
	if home == "" {
		return excluded
	}
	codexDir := filepath.Join(home, ".codex")
	dbPaths := ListCodexStateDBPaths(codexDir)
	if len(dbPaths) == 0 {
		return excluded
	}
	spawned := make(map[string]bool)
	for _, dbPath := range dbPaths {
		db, exists, err := openReadOnlySQLite(ctx, dbPath)
		if err != nil || !exists {
			continue
		}
		if sqliteTableExists(ctx, db, "thread_spawn_edges") {
			if rows, qErr := db.QueryContext(ctx, `SELECT child_thread_id FROM thread_spawn_edges`); qErr == nil {
				for rows.Next() {
					var cid string
					if rows.Scan(&cid) == nil && strings.TrimSpace(cid) != "" {
						spawned[strings.TrimSpace(cid)] = true
						excluded[strings.TrimSpace(cid)] = true
					}
				}
				_ = rows.Close()
			}
		}
		if sqliteTableExists(ctx, db, "threads") {
			cols := getSQLiteTableColumns(ctx, db, "threads")
			if cols["id"] {
				selectArchived := "0"
				if cols["archived"] {
					selectArchived = "COALESCE(archived, 0)"
				}
				selectSource := "''"
				if cols["source"] {
					selectSource = "COALESCE(source, '')"
				}
				selectCwd := "''"
				if cols["cwd"] {
					selectCwd = "COALESCE(cwd, '')"
				}
				selectParent := "''"
				if cols["parent_thread_id"] {
					selectParent = "COALESCE(parent_thread_id, '')"
				}
				q := `SELECT id, ` + selectArchived + `, ` + selectSource + `, ` + selectCwd + `, ` + selectParent + ` FROM threads`
				if rows, qErr := db.QueryContext(ctx, q); qErr == nil {
					for rows.Next() {
						var tid, src, cwd, parent string
						var archived int
						if rows.Scan(&tid, &archived, &src, &cwd, &parent) != nil {
							continue
						}
						tid = strings.TrimSpace(tid)
						if tid == "" {
							continue
						}
						if archived != 0 || !IsCodexTopLevelInteractiveThread(tid, cwd, src, "", parent, spawned) {
							excluded[tid] = true
						}
					}
					_ = rows.Close()
				}
			}
		}
		_ = db.Close()
	}
	return excluded
}
