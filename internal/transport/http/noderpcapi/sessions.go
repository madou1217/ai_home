package noderpcapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const canonicalSessionLimit = 500

type deviceSessionItem struct {
	SessionRef  string `json:"sessionRef"`
	ProjectRef  string `json:"projectRef"`
	Provider    string `json:"provider"`
	Title       string `json:"title"`
	ProjectName string `json:"projectName"`
	Status      string `json:"status"`
	UpdatedAt   int64  `json:"updatedAt"`
	StartedAt   int64  `json:"startedAt"`
}

type deviceSessionsSummary struct {
	Total             int            `json:"total"`
	Returned          int            `json:"returned"`
	ByProvider        map[string]int `json:"byProvider"`
	ByStatus          map[string]int `json:"byStatus"`
	ByProject         map[string]int `json:"byProject"`
	RecentlyUpdatedAt int64          `json:"recentlyUpdatedAt"`
}

type deviceSessionsResult struct {
	Sessions []deviceSessionItem   `json:"sessions"`
	Summary  deviceSessionsSummary `json:"summary"`
}

type deviceMessageItem struct {
	Role      string `json:"role"`
	Content   string `json:"content"`
	Timestamp int64  `json:"timestamp"`
}

type deviceMessagesSummary struct {
	Total     int  `json:"total"`
	Returned  int  `json:"returned"`
	Truncated bool `json:"truncated"`
	Cursor    int  `json:"cursor"`
}

type deviceMessagesDebug struct {
	ItemCount int      `json:"itemCount"`
	Kinds     []string `json:"kinds"`
	KeyShapes []string `json:"keyShapes"`
}

type deviceMessagesResult struct {
	Session  deviceSessionItem     `json:"session"`
	Messages []deviceMessageItem   `json:"messages"`
	Summary  deviceMessagesSummary `json:"summary"`
	Debug    *deviceMessagesDebug  `json:"debug,omitempty"`
}

func emptyDeviceSessionsResult() deviceSessionsResult {
	return deviceSessionsResult{
		Sessions: []deviceSessionItem{},
		Summary: deviceSessionsSummary{
			ByProvider: map[string]int{},
			ByStatus:   map[string]int{},
			ByProject:  map[string]int{},
		},
	}
}

func (handler *Handler) chatSessionDirs() []string {
	dirs := make([]string, 0, 2)
	seen := make(map[string]struct{}, 2)
	add := func(dir string) {
		trimmed := strings.TrimSpace(dir)
		if trimmed == "" {
			return
		}
		clean := filepath.Clean(trimmed)
		if _, ok := seen[clean]; ok {
			return
		}
		seen[clean] = struct{}{}
		dirs = append(dirs, clean)
	}
	if handler.aiHomeDir != "" {
		add(filepath.Join(handler.aiHomeDir, "chat-sessions"))
	}
	if handler.hostHomeDir != "" {
		add(filepath.Join(handler.hostHomeDir, ".ai_home", "chat-sessions"))
	}
	return dirs
}

func (handler *Handler) buildDeviceSessions(ctx context.Context) deviceSessionsResult {
	merged := make([]deviceSessionItem, 0)
	merged = append(merged, handler.readCanonicalSessions(ctx)...)
	merged = append(merged, handler.readLegacyChatSessions()...)

	sort.SliceStable(merged, func(left, right int) bool {
		return merged[left].UpdatedAt > merged[right].UpdatedAt
	})

	byProvider := make(map[string]int)
	byStatus := make(map[string]int)
	byProject := make(map[string]int)
	for _, s := range merged {
		prov := s.Provider
		if prov == "" {
			prov = "unknown"
		}
		byProvider[prov] = byProvider[prov] + 1
		byStatus[s.Status] = byStatus[s.Status] + 1
		byProject[s.ProjectRef] = byProject[s.ProjectRef] + 1
	}

	recent := int64(0)
	if len(merged) > 0 {
		recent = merged[0].UpdatedAt
	}

	return deviceSessionsResult{
		Sessions: merged,
		Summary: deviceSessionsSummary{
			Total:             len(merged),
			Returned:          len(merged),
			ByProvider:        byProvider,
			ByStatus:          byStatus,
			ByProject:         byProject,
			RecentlyUpdatedAt: recent,
		},
	}
}

func (handler *Handler) openAppStateReadOnly(ctx context.Context) (*sql.DB, bool) {
	if handler.aiHomeDir == "" {
		return nil, false
	}
	dbPath, err := appstate.DatabasePath(handler.aiHomeDir)
	if err != nil {
		return nil, false
	}
	if _, statErr := os.Stat(dbPath); errors.Is(statErr, os.ErrNotExist) {
		return nil, false
	}
	db, err := appstate.OpenReadOnly(ctx, dbPath)
	if err != nil {
		return nil, false
	}
	return db, true
}

func sqliteTableExists(ctx context.Context, db *sql.DB, name string) bool {
	var cnt int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(1) FROM sqlite_master WHERE type = 'table' AND name = ?`, name,
	).Scan(&cnt); err != nil {
		return false
	}
	return cnt > 0
}

func (handler *Handler) readCanonicalSessions(ctx context.Context) []deviceSessionItem {
	db, ok := handler.openAppStateReadOnly(ctx)
	if !ok {
		return nil
	}
	defer func() { _ = db.Close() }()
	if !sqliteTableExists(ctx, db, "chat_runtime_sessions") {
		return nil
	}
	rows, err := db.QueryContext(ctx, `
		SELECT session_id, provider, project_path, policy_json, created_at, updated_at
		FROM chat_runtime_sessions
		WHERE project_path = ''
		ORDER BY updated_at DESC, session_id ASC
		LIMIT ?
	`, canonicalSessionLimit)
	if err != nil {
		return nil
	}
	defer func() { _ = rows.Close() }()

	items := make([]deviceSessionItem, 0)
	for rows.Next() {
		var (
			sessionID   string
			provider    string
			projectPath string
			policyJSON  string
			createdAt   int64
			updatedAt   int64
		)
		if err := rows.Scan(&sessionID, &provider, &projectPath, &policyJSON, &createdAt, &updatedAt); err != nil {
			continue
		}
		if strings.TrimSpace(sessionID) == "" {
			continue
		}
		var policy struct {
			Title string `json:"title"`
		}
		_ = json.Unmarshal([]byte(policyJSON), &policy)
		projectRef := strings.TrimSpace(projectPath)
		if projectRef == "" {
			projectRef = "local"
		}
		startedAt := createdAt
		if startedAt == 0 {
			startedAt = updatedAt
		}
		items = append(items, deviceSessionItem{
			SessionRef:  sessionID,
			ProjectRef:  projectRef,
			Provider:    provider,
			Title:       policy.Title,
			ProjectName: filepath.Base(projectRef),
			Status:      "idle",
			UpdatedAt:   updatedAt,
			StartedAt:   startedAt,
		})
	}
	return items
}

func (handler *Handler) readLegacyChatSessions() []deviceSessionItem {
	items := make([]deviceSessionItem, 0)
	seen := make(map[string]struct{})
	for _, dir := range handler.chatSessionDirs() {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
			if err != nil {
				continue
			}
			var decoded map[string]any
			if err := json.Unmarshal(raw, &decoded); err != nil {
				continue
			}
			item, ok := mapLegacySessionMeta(decoded)
			if !ok {
				continue
			}
			if _, dup := seen[item.SessionRef]; dup {
				continue
			}
			seen[item.SessionRef] = struct{}{}
			items = append(items, item)
		}
	}
	return items
}

func mapLegacySessionMeta(decoded map[string]any) (deviceSessionItem, bool) {
	id := stringFromAny(decoded["id"])
	if id == "" {
		return deviceSessionItem{}, false
	}
	projectRef := firstNonEmpty(stringFromAny(decoded["project"]), stringFromAny(decoded["cwd"]), "local")
	return deviceSessionItem{
		SessionRef:  id,
		ProjectRef:  projectRef,
		Provider:    stringFromAny(decoded["provider"]),
		Title:       stringFromAny(decoded["title"]),
		ProjectName: filepath.Base(projectRef),
		Status:      "idle",
		UpdatedAt:   int64FromAny(decoded["updatedAt"]),
		StartedAt:   int64FromAny(decoded["createdAt"]),
	}, true
}

func (handler *Handler) buildSessionMessages(ctx context.Context, sessionRef string, limit int, debug bool) (*deviceMessagesResult, bool) {
	wanted := strings.TrimSpace(sessionRef)
	if wanted == "" {
		return nil, false
	}

	if sessionMeta, sourceItems, found := handler.readCanonicalSessionAndItems(ctx, wanted, limit); found {
		return formatSessionMessages(sessionMeta, sourceItems, limit, debug), true
	}

	legacyDecoded, ok := handler.findLegacySession(wanted)
	if !ok {
		return nil, false
	}
	meta, valid := mapLegacySessionMeta(legacyDecoded)
	if !valid {
		meta = deviceSessionItem{
			SessionRef:  wanted,
			ProjectRef:  "local",
			ProjectName: "local",
			Status:      "idle",
		}
	}
	sourceItems := extractLegacyMessageItems(legacyDecoded)
	return formatSessionMessages(meta, sourceItems, limit, debug), true
}

func (handler *Handler) readCanonicalSessionAndItems(
	ctx context.Context,
	sessionRef string,
	limit int,
) (deviceSessionItem, []map[string]any, bool) {
	db, ok := handler.openAppStateReadOnly(ctx)
	if !ok {
		return deviceSessionItem{}, nil, false
	}
	defer func() { _ = db.Close() }()
	if !sqliteTableExists(ctx, db, "chat_runtime_sessions") {
		return deviceSessionItem{}, nil, false
	}

	var (
		provider    string
		projectPath string
		policyJSON  string
		createdAt   int64
		updatedAt   int64
	)
	err := db.QueryRowContext(ctx, `
		SELECT provider, project_path, policy_json, created_at, updated_at
		FROM chat_runtime_sessions
		WHERE session_id = ?
	`, sessionRef).Scan(&provider, &projectPath, &policyJSON, &createdAt, &updatedAt)
	if err != nil {
		return deviceSessionItem{}, nil, false
	}

	var policy struct {
		Title string `json:"title"`
	}
	_ = json.Unmarshal([]byte(policyJSON), &policy)
	projectRef := strings.TrimSpace(projectPath)
	if projectRef == "" {
		projectRef = "local"
	}
	startedAt := createdAt
	if startedAt == 0 {
		startedAt = updatedAt
	}
	meta := deviceSessionItem{
		SessionRef:  sessionRef,
		ProjectRef:  projectRef,
		Provider:    provider,
		Title:       policy.Title,
		ProjectName: filepath.Base(projectRef),
		Status:      "idle",
		UpdatedAt:   updatedAt,
		StartedAt:   startedAt,
	}

	cappedLimit := 50
	if limit > 50 {
		if limit < 100 {
			cappedLimit = limit
		} else {
			cappedLimit = 100
		}
	}

	timelineItems := readTimelineEventsFromSQLite(ctx, db, sessionRef, cappedLimit)
	if len(timelineItems) > 0 {
		return meta, timelineItems, true
	}
	if fallback := readNativeOrSeedItemsFromSQLite(ctx, db, sessionRef); len(fallback) > 0 {
		return meta, fallback, true
	}
	return meta, []map[string]any{}, true
}

func readTimelineEventsFromSQLite(ctx context.Context, db *sql.DB, sessionRef string, cappedLimit int) []map[string]any {
	if !sqliteTableExists(ctx, db, "chat_runtime_events") {
		return nil
	}
	idRows, err := db.QueryContext(ctx, `
		SELECT item_id, MIN(seq) AS first_seq
		FROM chat_runtime_events
		WHERE session_id = ? AND item_id IS NOT NULL AND type LIKE 'timeline.item.%'
		GROUP BY item_id
		ORDER BY first_seq DESC
		LIMIT ?
	`, sessionRef, cappedLimit)
	if err != nil {
		return nil
	}
	itemIDs := make([]string, 0, cappedLimit)
	for idRows.Next() {
		var itemID string
		var firstSeq int64
		if scanErr := idRows.Scan(&itemID, &firstSeq); scanErr == nil && strings.TrimSpace(itemID) != "" {
			itemIDs = append(itemIDs, itemID)
		}
	}
	_ = idRows.Close()
	if len(itemIDs) == 0 {
		return nil
	}

	placeholders := make([]string, len(itemIDs))
	args := make([]any, 0, len(itemIDs)+1)
	args = append(args, sessionRef)
	for i, id := range itemIDs {
		placeholders[i] = "?"
		args = append(args, id)
	}

	evRows, err := db.QueryContext(ctx, `
		SELECT type, payload_json
		FROM chat_runtime_events
		WHERE session_id = ? AND item_id IN (`+strings.Join(placeholders, ", ")+`) AND type LIKE 'timeline.item.%'
		ORDER BY seq ASC
	`, args...)
	if err != nil {
		return nil
	}
	defer func() { _ = evRows.Close() }()

	order := make([]string, 0, len(itemIDs))
	itemsByID := make(map[string]map[string]any, len(itemIDs))
	for evRows.Next() {
		var evType, payloadJSON string
		if scanErr := evRows.Scan(&evType, &payloadJSON); scanErr != nil {
			continue
		}
		var payload map[string]any
		if json.Unmarshal([]byte(payloadJSON), &payload) != nil {
			continue
		}
		switch evType {
		case "timeline.item.delta":
			id := stringFromAny(payload["itemId"])
			chunk, _ := payload["chunk"].(string)
			if cur, exists := itemsByID[id]; exists && cur != nil {
				curContent, _ := cur["content"].(string)
				cur["content"] = curContent + chunk
			}
		case "timeline.item.started", "timeline.item.updated", "timeline.item.completed":
			rawItem, ok := payload["item"].(map[string]any)
			if !ok || rawItem == nil {
				continue
			}
			id := stringFromAny(rawItem["id"])
			if id == "" {
				continue
			}
			if _, exists := itemsByID[id]; !exists {
				order = append(order, id)
			}
			itemsByID[id] = rawItem
		}
	}

	out := make([]map[string]any, 0, len(order))
	for _, id := range order {
		if item := itemsByID[id]; item != nil {
			out = append(out, item)
		}
	}
	return out
}

func readNativeOrSeedItemsFromSQLite(ctx context.Context, db *sql.DB, sessionRef string) []map[string]any {
	if sqliteTableExists(ctx, db, "chat_runtime_native_thread_items") {
		if items := queryJSONColumnItems(ctx, db,
			`SELECT item_json FROM chat_runtime_native_thread_items WHERE session_id = ? ORDER BY ordinal ASC`,
			sessionRef,
		); len(items) > 0 {
			return items
		}
	}
	if sqliteTableExists(ctx, db, "chat_runtime_native_response_items") {
		if items := queryJSONColumnItems(ctx, db,
			`SELECT response_item_json FROM chat_runtime_native_response_items WHERE session_id = ? ORDER BY COALESCE(ordinal, 0) ASC, item_id ASC`,
			sessionRef,
		); len(items) > 0 {
			return items
		}
	}
	if sqliteTableExists(ctx, db, "chat_runtime_history_seeds") {
		var raw string
		if err := db.QueryRowContext(ctx,
			`SELECT response_items_json FROM chat_runtime_history_seeds WHERE session_id = ?`,
			sessionRef,
		).Scan(&raw); err == nil && strings.TrimSpace(raw) != "" {
			var decoded []map[string]any
			if json.Unmarshal([]byte(raw), &decoded) == nil && len(decoded) > 0 {
				return decoded
			}
		}
	}
	return nil
}

func queryJSONColumnItems(ctx context.Context, db *sql.DB, query string, sessionRef string) []map[string]any {
	rows, err := db.QueryContext(ctx, query, sessionRef)
	if err != nil {
		return nil
	}
	defer func() { _ = rows.Close() }()
	out := make([]map[string]any, 0)
	for rows.Next() {
		var raw string
		if rows.Scan(&raw) != nil {
			continue
		}
		var item map[string]any
		if json.Unmarshal([]byte(raw), &item) == nil && item != nil {
			out = append(out, item)
		}
	}
	return out
}

func (handler *Handler) findLegacySession(sessionRef string) (map[string]any, bool) {
	if !strings.ContainsAny(sessionRef, "/\\\x00") && !strings.Contains(sessionRef, "..") {
		for _, dir := range handler.chatSessionDirs() {
			raw, err := os.ReadFile(filepath.Join(dir, sessionRef+".json"))
			if err != nil {
				continue
			}
			var decoded map[string]any
			if json.Unmarshal(raw, &decoded) == nil && decoded != nil {
				return decoded, true
			}
		}
	}
	for _, dir := range handler.chatSessionDirs() {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
				continue
			}
			raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
			if err != nil {
				continue
			}
			var decoded map[string]any
			if json.Unmarshal(raw, &decoded) == nil && stringFromAny(decoded["id"]) == sessionRef {
				return decoded, true
			}
		}
	}
	return nil, false
}

func extractLegacyMessageItems(session map[string]any) []map[string]any {
	rawSlice, ok := session["messages"].([]any)
	if !ok {
		rawSlice, _ = session["items"].([]any)
	}
	items := make([]map[string]any, 0, len(rawSlice))
	for _, entry := range rawSlice {
		if m, ok := entry.(map[string]any); ok && m != nil {
			items = append(items, m)
		}
	}
	return items
}

func formatSessionMessages(meta deviceSessionItem, source []map[string]any, limit int, debug bool) *deviceMessagesResult {
	normalized := make([]deviceMessageItem, 0, len(source))
	for _, item := range source {
		if item == nil {
			continue
		}
		kind := strings.ToLower(stringFromAny(item["kind"]))
		declared := strings.ToLower(stringFromAny(item["role"]))
		if declared == "" {
			if detail, ok := item["detail"].(map[string]any); ok && detail != nil {
				declared = strings.ToLower(stringFromAny(detail["role"]))
			}
		}
		role := ""
		switch {
		case declared == "user" || declared == "assistant":
			role = declared
		case strings.Contains(kind, "user"):
			role = "user"
		case strings.Contains(kind, "assistant"):
			role = "assistant"
		}
		if role == "" {
			continue
		}
		content := extractItemContent(item)
		if content == "" {
			continue
		}
		ts := int64FromAny(item["timestamp"])
		if ts == 0 {
			ts = int64FromAny(item["at"])
		}
		if ts == 0 {
			ts = int64FromAny(item["createdAt"])
		}
		normalized = append(normalized, deviceMessageItem{
			Role:      role,
			Content:   content,
			Timestamp: ts,
		})
	}

	capped := normalized
	if limit > 0 && len(normalized) > limit {
		capped = normalized[len(normalized)-limit:]
	}
	if capped == nil {
		capped = []deviceMessageItem{}
	}

	res := &deviceMessagesResult{
		Session:  meta,
		Messages: capped,
		Summary: deviceMessagesSummary{
			Total:     len(normalized),
			Returned:  len(capped),
			Truncated: len(capped) < len(normalized),
			Cursor:    0,
		},
	}
	if debug {
		res.Debug = describeTimeline(source)
	}
	return res
}

func extractItemContent(item map[string]any) string {
	if s, ok := item["content"].(string); ok && s != "" {
		return s
	}
	if s, ok := item["text"].(string); ok && s != "" {
		return s
	}
	if blocks, ok := item["content"].([]any); ok {
		parts := make([]string, 0, len(blocks))
		for _, blk := range blocks {
			m, ok := blk.(map[string]any)
			if !ok || m == nil {
				continue
			}
			if txt, ok := m["text"].(string); ok && txt != "" {
				parts = append(parts, txt)
			}
		}
		if len(parts) > 0 {
			return strings.Join(parts, "\n")
		}
	}
	return ""
}

func describeTimeline(items []map[string]any) *deviceMessagesDebug {
	kinds := make([]string, 0)
	kindSeen := make(map[string]struct{})
	keyShapes := make([]string, 0, 5)
	shapeSeen := make(map[string]struct{})
	for _, item := range items {
		if item == nil {
			continue
		}
		if kind := stringFromAny(item["kind"]); kind != "" {
			if _, ok := kindSeen[kind]; !ok {
				kindSeen[kind] = struct{}{}
				kinds = append(kinds, kind)
			}
		}
		shape := strings.Join(sortedMapKeys(item), ",")
		if _, ok := shapeSeen[shape]; !ok {
			shapeSeen[shape] = struct{}{}
			if len(keyShapes) < 5 {
				keyShapes = append(keyShapes, shape)
			}
		}
	}
	return &deviceMessagesDebug{
		ItemCount: len(items),
		Kinds:     kinds,
		KeyShapes: keyShapes,
	}
}

func stringFromAny(raw any) string {
	switch v := raw.(type) {
	case string:
		return strings.TrimSpace(v)
	default:
		return ""
	}
}

func int64FromAny(raw any) int64 {
	switch v := raw.(type) {
	case float64:
		return int64(v)
	case int64:
		return v
	case int:
		return int64(v)
	case string:
		if parsed, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
			return parsed
		}
	}
	return 0
}
