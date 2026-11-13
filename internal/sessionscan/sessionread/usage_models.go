package sessionread

import (
	"context"
	"encoding/json"
	"strings"
)

// GetLastSessionModel 从 app-state.db model_usage_records 查询某会话最近一次使用的模型。
// codebuddy/workbuddy 家族跳过 native_session_done 占位记录以防止覆盖真实代理用模。
func GetLastSessionModel(ctx context.Context, opts Options, provider, sessionID string) string {
	normProvider := NormalizeProvider(provider)
	sid := strings.TrimSpace(sessionID)
	if normProvider == "" || sid == "" {
		return ""
	}
	dbPath := ResolveAppStateDBPath(opts)
	db, exists, err := openReadOnlySQLite(ctx, dbPath)
	if err != nil || !exists {
		return ""
	}
	defer db.Close()

	excludeNativeDone := 0
	if IsCodebuddyFamilyProvider(normProvider) {
		excludeNativeDone = 1
	}

	var model string
	queryErr := db.QueryRowContext(
		ctx,
		`SELECT model FROM model_usage_records
		 WHERE provider = ? AND session_id = ? AND model != ''
		   AND (? = 0 OR source_kind != 'native_session_done')
		 ORDER BY timestamp_ms DESC
		 LIMIT 1`,
		normProvider,
		sid,
		excludeNativeDone,
	).Scan(&model)
	if queryErr != nil {
		return ""
	}
	return NormalizeMessageModel(model)
}

// GetNativeSessionModelTimeline 读取 app-state.db 中该会话按时间升序排列的原生完成用模点位。
func GetNativeSessionModelTimeline(ctx context.Context, opts Options, provider, sessionID string) []ModelTimelineEntry {
	normProvider := NormalizeProvider(provider)
	sid := strings.TrimSpace(sessionID)
	if normProvider == "" || sid == "" {
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
		`SELECT model, timestamp_ms FROM model_usage_records
		 WHERE provider = ? AND session_id = ? AND source_kind = 'native_session_done' AND model != ''
		 ORDER BY timestamp_ms ASC, id ASC`,
		normProvider,
		sid,
	)
	if err != nil {
		return nil
	}
	defer rows.Close()

	timeline := make([]ModelTimelineEntry, 0, 8)
	for rows.Next() {
		var model string
		var ts int64
		if scanErr := rows.Scan(&model, &ts); scanErr != nil {
			continue
		}
		cleanModel := NormalizeMessageModel(model)
		if cleanModel != "" && ts > 0 {
			timeline = append(timeline, ModelTimelineEntry{Model: cleanModel, TimestampMs: ts})
		}
	}
	return timeline
}

// ApplyCanonicalAgyTurnModels 在 provider == "agy" 时使用持久化模型时间线修正各轮模型标签。
func ApplyCanonicalAgyTurnModels(ctx context.Context, opts Options, provider, sessionID string, messages []json.RawMessage) []json.RawMessage {
	if NormalizeProvider(provider) != "agy" || len(messages) == 0 {
		return messages
	}
	timeline := GetNativeSessionModelTimeline(ctx, opts, provider, sessionID)
	if len(timeline) == 0 {
		return messages
	}
	return DecorateMessagesWithRecordedTurnModels(messages, timeline)
}
