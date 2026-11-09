package webuiquotaresetapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

// 数据源与 Node 的 quota-reset-store 完全一致：app-state.db 的同名表。
const (
	appStateDatabaseFileName = "app-state.db"
	resetEventsTable         = "account_quota_reset_events"
	databaseBusyTimeoutMS    = 5000
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("额度重置历史接口依赖无效")

// ErrInvalidSource 表示没有可用的数据根目录。
var ErrInvalidSource = errors.New("额度重置历史数据源无效")

// Source 只读 app-state.db 的 account_quota_reset_events。
type Source struct {
	databasePath string
}

// OpenSource 创建只读数据源；数据库不存在不报错（全新数据根返回空历史）。
func OpenSource(aiHomeDir string) (*Source, error) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil, ErrInvalidSource
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, ErrInvalidSource
	}
	return &Source{databasePath: filepath.Join(absolute, appStateDatabaseFileName)}, nil
}

// Read 返回某账号最近的重置事件（按 occurred_at_ms、id 倒序）。
//
// 表不存在与「从未发生过重置」同义：Node 的 withDatabase(createIfMissing:false)
// 同样返回空数组，不把首次启动当成错误。
func (source *Source) Read(
	ctx context.Context,
	accountRef string,
	limit int,
	beforeID int64,
) ([]Event, error) {
	reference := strings.TrimSpace(accountRef)
	if source == nil || source.databasePath == "" || reference == "" || ctx == nil {
		return nil, nil
	}
	info, err := os.Stat(source.databasePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil || !info.Mode().IsRegular() {
		return nil, nil
	}
	db, err := openReadOnly(ctx, source.databasePath)
	if err != nil {
		return nil, fmt.Errorf("打开 app-state.db 失败: %w", err)
	}
	defer func() { _ = db.Close() }()

	statement := `
		SELECT id, event_key, account_ref, provider, quota_key, window_label,
		       window_minutes, event_kind, classification, cause,
		       previous_remaining_pct, current_remaining_pct,
		       previous_expected_reset_at_ms, exhausted_at_ms,
		       occurred_at_ms, detected_at_ms, early_duration_ms,
		       previous_plan_type, current_plan_type
		FROM account_quota_reset_events
		WHERE account_ref = ?`
	arguments := []any{reference}
	if beforeID > 0 {
		statement += " AND id < ?"
		arguments = append(arguments, beforeID)
	}
	statement += " ORDER BY occurred_at_ms DESC, id DESC LIMIT ?"
	arguments = append(arguments, limit)

	rows, err := db.QueryContext(ctx, statement, arguments...)
	if err != nil {
		// 表不存在（no such table）与从未写入同义。
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return nil, nil
		}
		return nil, fmt.Errorf("读取额度重置历史失败: %w", err)
	}
	defer func() { _ = rows.Close() }()

	events := make([]Event, 0, limit)
	for rows.Next() {
		var event Event
		var windowMinutes sql.NullInt64
		var previousRemaining sql.NullFloat64
		var currentRemaining sql.NullFloat64
		var previousExpected sql.NullInt64
		var exhaustedAt sql.NullInt64
		var occurredAt sql.NullInt64
		var detectedAt sql.NullInt64
		var earlyDuration sql.NullInt64
		var previousPlan sql.NullString
		var currentPlan sql.NullString
		var windowLabel sql.NullString
		if err := rows.Scan(
			&event.ID,
			&event.EventKey,
			&event.AccountRef,
			&event.Provider,
			&event.QuotaKey,
			&windowLabel,
			&windowMinutes,
			&event.EventKind,
			&event.Classification,
			&event.Cause,
			&previousRemaining,
			&currentRemaining,
			&previousExpected,
			&exhaustedAt,
			&occurredAt,
			&detectedAt,
			&earlyDuration,
			&previousPlan,
			&currentPlan,
		); err != nil {
			return nil, fmt.Errorf("解析额度重置历史失败: %w", err)
		}
		event.WindowLabel = windowLabel.String
		event.WindowMinutes = nullableInt(windowMinutes.Valid, windowMinutes.Int64)
		event.PreviousRemainingPct = nullableFloat(previousRemaining.Valid, previousRemaining.Float64)
		event.CurrentRemainingPct = nullableFloat(currentRemaining.Valid, currentRemaining.Float64)
		event.PreviousExpectedResetAtMS = nullableInt(previousExpected.Valid, previousExpected.Int64)
		event.ExhaustedAtMS = nullableInt(exhaustedAt.Valid, exhaustedAt.Int64)
		event.DetectedAtMS = detectedAt.Int64
		// Node：occurred_at_ms 缺失时回落到 detected_at_ms。
		event.OccurredAtMS = occurredAt.Int64
		if event.OccurredAtMS == 0 {
			event.OccurredAtMS = event.DetectedAtMS
		}
		event.EarlyDurationMS = earlyDuration.Int64
		event.PreviousPlanType = nullableText(previousPlan.Valid, previousPlan.String)
		event.CurrentPlanType = nullableText(currentPlan.Valid, currentPlan.String)
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历额度重置历史失败: %w", err)
	}
	return events, nil
}

func nullableInt(valid bool, value int64) *int64 {
	if !valid {
		return nil
	}
	copied := value
	return &copied
}

func nullableFloat(valid bool, value float64) *float64 {
	if !valid {
		return nil
	}
	copied := value
	return &copied
}

// nullableText 与 Node 的 text(row)||null 一致：空串按缺失处理。
func nullableText(valid bool, value string) *string {
	if !valid || strings.TrimSpace(value) == "" {
		return nil
	}
	copied := value
	return &copied
}

func openReadOnly(ctx context.Context, databasePath string) (*sql.DB, error) {
	db, err := openAndPing(ctx, databasePath, false)
	if err == nil {
		return db, nil
	}
	// 有 -wal 时不能按 immutable 打开：会读不到未合并的页。
	if _, statErr := os.Stat(databasePath + "-wal"); statErr == nil {
		return nil, err
	}
	return openAndPing(ctx, databasePath, true)
}

func openAndPing(ctx context.Context, databasePath string, immutable bool) (*sql.DB, error) {
	db, err := sql.Open("sqlite", buildReadOnlyDSN(databasePath, immutable))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func buildReadOnlyDSN(databasePath string, immutable bool) string {
	fileURL := &url.URL{Scheme: "file", Path: filepath.ToSlash(databasePath)}
	query := fileURL.Query()
	query.Set("mode", "ro")
	query.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", databaseBusyTimeoutMS))
	query.Add("_pragma", "query_only(1)")
	if immutable {
		query.Set("immutable", "1")
	}
	fileURL.RawQuery = query.Encode()
	return fileURL.String()
}

// LookupProvider 从同一份 app-state.db 的 account_refs 读取账号归属。
//
// 为什么不用 Go 的 accounts 表：额度重置历史是 Node 的检测器写的，事件里的
// account_ref 也来自 Node 的账号台账；Go 的账号投影可能缺少已停用/未同步的账号
// （真机 13 个事件账号里有 4 个不在 Go 的 accounts 表），拿 Go 表做存在性校验会把
// 真实历史判成 404。account_refs 与写入方是同一份数据，才是正确证据源。
func (source *Source) LookupProvider(
	ctx context.Context,
	accountRef string,
) (string, bool, error) {
	reference := strings.TrimSpace(accountRef)
	if source == nil || source.databasePath == "" || reference == "" || ctx == nil {
		return "", false, nil
	}
	info, err := os.Stat(source.databasePath)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil || !info.Mode().IsRegular() {
		return "", false, nil
	}
	db, err := openReadOnly(ctx, source.databasePath)
	if err != nil {
		return "", false, fmt.Errorf("打开 app-state.db 失败: %w", err)
	}
	defer func() { _ = db.Close() }()
	var provider string
	err = db.QueryRowContext(ctx,
		`SELECT provider FROM account_refs WHERE account_ref = ?`,
		reference,
	).Scan(&provider)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return "", false, nil
		}
		return "", false, fmt.Errorf("读取账号归属失败: %w", err)
	}
	return provider, true, nil
}
