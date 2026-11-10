// Package accountstate 维护 Node app-state.db 的 account_state 展示投影。
//
// 账号启停的真值在 Go 的 accounts.enabled；本包只把展示投影写回 Node WebUI
// 读取的 account_state，供账号状态/更新响应使用。此前 Go 没有这个写入口，
// internal/transport/http/webuiaccountstatusapi 只能返回 partial。
//
// 表结构归 Node 所有（lib/account/state-index.js）。本包不做兼容性迁移：
// Open/OpenDatabase 用 exact-schema 校验（列顺序 + 主键），不匹配立即返回
// ErrSchemaInvalid；建表只发生在显式调用 EnsureSchema 时。两个进程因此不会
// 各自演化出不同的列。
//
// 刻意不写 runtime_state：Go 的运行态文档在 aih.db 的 account_runtime_states，
// Node 的 runtime_state 只是迁移期兜底；Go 一并写会制造两份互相覆盖的真值。
//
// account_state 的 updated_at 是投影自身的更新时间，不是账号页行的 updatedAt
// （Node 明确保留后者，两者实测相差数分钟），因此 Projection 不携带它。
package accountstate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// StatusUp 表示账号启用。
	StatusUp = "up"
	// StatusDown 表示账号停用。
	StatusDown = "down"

	maxAuthModeRunes    = 64
	maxDisplayNameRunes = 255
)

var (
	// ErrDatabaseMissing 表示数据根下没有 Node 创建的 app-state.db。
	ErrDatabaseMissing = errors.New("app-state.db 不存在")
	// ErrInvalidDatabase 表示传入的数据库句柄无效。
	ErrInvalidDatabase = errors.New("account_state 投影库句柄无效")
	// ErrUnavailable 表示 Store 未初始化或已关闭。
	ErrUnavailable = errors.New("account_state 投影库不可用")
	// ErrSchemaInvalid 表示 account_state 表缺失或列/主键与 Node 合同不一致。
	ErrSchemaInvalid = errors.New("account_state 表结构与 Node 合同不一致")
	// ErrInvalidProvider 表示 Provider 为空。
	ErrInvalidProvider = errors.New("账号 Provider 无效")
	// ErrInvalidStatus 表示状态词无法归一为 up/down。
	ErrInvalidStatus = errors.New("账号状态无效")
	// ErrAccountUnknown 表示 account_refs 台账里没有该账号（Node 由外键拦截）。
	ErrAccountUnknown = errors.New("账号不在 account_refs 台账中")
)

// State 是 account_state 一行的 Go 表示；单词与 Node mapStateRow 对齐。
type State struct {
	AccountRef   string
	Provider     string
	Status       string
	Configured   bool
	APIKeyMode   bool
	AuthMode     string
	RemainingPct *float64
	DisplayName  string
	UpdatedAtMS  int64
}

// Projection 是账号状态/更新响应需要的字段，JSON 键与 WebUI 账号行一致。
//
// apiKeyMode 与 updatedAt 不在其中：前者是 Node 的凭据展示词汇，后者是
// 账号行时间，两者都不能由 account_state 伪装。
type Projection struct {
	AccountRef  string `json:"accountRef"`
	Provider    string `json:"provider"`
	Status      string `json:"status"`
	Configured  bool   `json:"configured"`
	DisplayName string `json:"displayName"`
}

// UpsertInput 是 Node upsertAccountState 的入参。
//
// 指针字段区分「不提供」与「显式空值」：nil 保持旧值（Node 的 null →
// COALESCE），非 nil 覆盖。Status 为 nil 时保留已有行，插入时默认 up。
type UpsertInput struct {
	AccountRef   string
	Provider     string
	Status       *string
	Configured   bool
	APIKeyMode   bool
	AuthMode     *string
	RemainingPct *float64
	DisplayName  *string
}

// Store 是 account_state 的读写句柄。
type Store struct {
	db     *sql.DB
	ownsDB bool
	now    func() time.Time
}

const selectStateColumns = `account_ref, provider, status, configured, api_key_mode,
	auth_mode, remaining_pct, display_name, updated_at`

const upsertSQL = `
INSERT INTO account_state (
	account_ref, provider, status, configured, api_key_mode,
	auth_mode, remaining_pct, display_name, updated_at
)
SELECT ?, ?, COALESCE(?, 'up'), ?, ?, ?, ?, ?, ?
 WHERE EXISTS (SELECT 1 FROM account_refs WHERE account_ref = ?)
ON CONFLICT(account_ref) DO UPDATE SET
	provider = excluded.provider,
	status = CASE WHEN ? IS NULL THEN account_state.status ELSE excluded.status END,
	configured = excluded.configured,
	api_key_mode = excluded.api_key_mode,
	auth_mode = COALESCE(excluded.auth_mode, account_state.auth_mode),
	remaining_pct = excluded.remaining_pct,
	display_name = COALESCE(excluded.display_name, account_state.display_name),
	updated_at = excluded.updated_at`

// Open 打开数据根下的 app-state.db 并校验 Node 的 account_state 结构。
//
// 数据库不存在时返回 ErrDatabaseMissing，绝不代 Node 创建空库。
func Open(ctx context.Context, aiHomeDir string) (*Store, error) {
	path, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrDatabaseMissing
		}
		return nil, fmt.Errorf("检查 app-state.db 失败: %w", err)
	}
	db, err := appstate.OpenWritable(ctx, path)
	if err != nil {
		return nil, fmt.Errorf("打开 app-state.db 失败: %w", err)
	}
	store := &Store{db: db, ownsDB: true, now: time.Now}
	if err := store.validateSchema(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

// OpenDatabase 复用调用方的数据库句柄，只校验结构，不接管关闭。
//
// 句柄必须是可写连接；只读连接能通过校验但写入会由 SQLite 拒绝。
func OpenDatabase(ctx context.Context, db *sql.DB) (*Store, error) {
	if db == nil {
		return nil, ErrInvalidDatabase
	}
	store := &Store{db: db, now: time.Now}
	if err := store.validateSchema(ctx); err != nil {
		return nil, err
	}
	return store, nil
}

// Close 关闭 Open 创建的连接；OpenDatabase 的句柄仍归调用方所有。
func (store *Store) Close() error {
	if store == nil || store.db == nil {
		return nil
	}
	if !store.ownsDB {
		return nil
	}
	err := store.db.Close()
	store.db = nil
	return err
}

// Get 读取单个账号的投影；不存在时返回 found=false。
func (store *Store) Get(ctx context.Context, accountRef string) (State, bool, error) {
	if err := store.available(); err != nil {
		return State{}, false, err
	}
	reference, err := accountcore.ParseAccountRef(strings.TrimSpace(accountRef))
	if err != nil {
		return State{}, false, err
	}
	row := store.db.QueryRowContext(
		ctx,
		"SELECT "+selectStateColumns+" FROM account_state WHERE account_ref = ? LIMIT 1",
		reference.String(),
	)
	state, err := scanState(row)
	if errors.Is(err, sql.ErrNoRows) {
		return State{}, false, nil
	}
	if err != nil {
		return State{}, false, fmt.Errorf("读取 account_state 失败: %w", err)
	}
	return state, true, nil
}

// List 返回某 Provider 的投影，排序与 Node 一致：updated_at DESC, account_ref。
// 账号引用损坏的行按 Node 的读侧口径丢弃，不让单个坏行拖垮整页。
func (store *Store) List(ctx context.Context, provider string) ([]State, error) {
	if err := store.available(); err != nil {
		return nil, err
	}
	normalizedProvider := normalizeProvider(provider)
	if normalizedProvider == "" {
		return nil, ErrInvalidProvider
	}
	rows, err := store.db.QueryContext(
		ctx,
		"SELECT "+selectStateColumns+` FROM account_state
		  WHERE provider = ? ORDER BY updated_at DESC, account_ref`,
		normalizedProvider,
	)
	if err != nil {
		return nil, fmt.Errorf("查询 account_state 失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()
	states := make([]State, 0, 16)
	for rows.Next() {
		state, err := scanState(rows)
		if err != nil {
			return nil, fmt.Errorf("读取 account_state 失败: %w", err)
		}
		if _, err := accountcore.ParseAccountRef(state.AccountRef); err != nil {
			continue
		}
		states = append(states, state)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历 account_state 失败: %w", err)
	}
	return states, nil
}

// Project 返回账号状态/更新响应用的窄投影；不存在时 found=false。
func (store *Store) Project(ctx context.Context, accountRef string) (Projection, bool, error) {
	state, found, err := store.Get(ctx, accountRef)
	if err != nil || !found {
		return Projection{}, found, err
	}
	return state.Projection(), true, nil
}

// Projection 从完整状态裁出响应字段。
func (state State) Projection() Projection {
	return Projection{
		AccountRef:  state.AccountRef,
		Provider:    state.Provider,
		Status:      state.Status,
		Configured:  state.Configured,
		DisplayName: state.DisplayName,
	}
}

// SetStatus 只更新 status 与 updated_at，其余列保持原值（Node setStatus）。
// 行不存在时返回 false；状态词无效时返回 ErrInvalidStatus，不写库。
func (store *Store) SetStatus(ctx context.Context, accountRef string, status string) (bool, error) {
	if err := store.available(); err != nil {
		return false, err
	}
	reference, err := accountcore.ParseAccountRef(strings.TrimSpace(accountRef))
	if err != nil {
		return false, err
	}
	normalized := accountcore.NormalizeAccountStatus(status)
	if normalized == "" {
		return false, ErrInvalidStatus
	}
	result, err := store.db.ExecContext(
		ctx,
		"UPDATE account_state SET status = ?, updated_at = ? WHERE account_ref = ?",
		normalized, store.nowMS(), reference.String(),
	)
	if err != nil {
		return false, fmt.Errorf("更新 account_state 状态失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("读取 account_state 更新结果失败: %w", err)
	}
	return affected > 0, nil
}

// Upsert 复刻 Node upsertAccountState 的投影写入语义：
//   - status 为 nil 时保留旧值，插入时默认 up；
//   - auth_mode 为 nil 或空串时保留旧值（Node 把空串归一为 null）；
//   - display_name 为 nil 时保留旧值，显式空串则清空；
//   - remaining_pct 每次覆盖，null/非有限值写 NULL，数值截到 0..100；
//   - runtime_state 永不写入。
//
// 账号不在 account_refs 台账时返回 ErrAccountUnknown（对应 Node 的外键失败）。
func (store *Store) Upsert(ctx context.Context, input UpsertInput) (bool, error) {
	if err := store.available(); err != nil {
		return false, err
	}
	reference, err := accountcore.ParseAccountRef(strings.TrimSpace(input.AccountRef))
	if err != nil {
		return false, err
	}
	provider := normalizeProvider(input.Provider)
	if provider == "" {
		return false, ErrInvalidProvider
	}
	status, err := normalizeOptionalStatus(input.Status)
	if err != nil {
		return false, err
	}
	result, err := store.db.ExecContext(
		ctx,
		upsertSQL,
		reference.String(),
		provider,
		nullableText(status),
		boolToInt(input.Configured),
		boolToInt(input.APIKeyMode),
		nullableText(normalizeOptionalAuthMode(input.AuthMode)),
		nullableReal(normalizeOptionalRemainingPct(input.RemainingPct)),
		nullableText(normalizeOptionalDisplayName(input.DisplayName)),
		store.nowMS(),
		reference.String(),
		nullableText(status),
	)
	if err != nil {
		return false, fmt.Errorf("写入 account_state 失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("读取 account_state 写入结果失败: %w", err)
	}
	if affected == 0 {
		return false, ErrAccountUnknown
	}
	return true, nil
}

func (store *Store) available() error {
	if store == nil || store.db == nil {
		return ErrUnavailable
	}
	return nil
}

func (store *Store) nowMS() int64 {
	if store == nil || store.now == nil {
		return time.Now().UnixMilli()
	}
	return store.now().UnixMilli()
}

func scanState(scanner interface{ Scan(...any) error }) (State, error) {
	var (
		accountRef  string
		provider    string
		status      string
		configured  int64
		apiKeyMode  int64
		authMode    sql.NullString
		remaining   sql.NullFloat64
		displayName sql.NullString
		updatedAtMS int64
	)
	if err := scanner.Scan(
		&accountRef, &provider, &status, &configured, &apiKeyMode,
		&authMode, &remaining, &displayName, &updatedAtMS,
	); err != nil {
		return State{}, err
	}
	return State{
		AccountRef:   accountRef,
		Provider:     normalizeProvider(provider),
		Status:       accountcore.ResolveEffectiveAccountStatus(status),
		Configured:   configured == 1,
		APIKeyMode:   apiKeyMode == 1,
		AuthMode:     strings.TrimSpace(authMode.String),
		RemainingPct: remainingPct(remaining),
		DisplayName:  strings.TrimSpace(displayName.String),
		UpdatedAtMS:  updatedAtMS,
	}, nil
}

func normalizeProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}

func normalizeOptionalStatus(value *string) (*string, error) {
	if value == nil {
		return nil, nil
	}
	normalized := accountcore.NormalizeAccountStatus(*value)
	if normalized == "" {
		return nil, ErrInvalidStatus
	}
	return &normalized, nil
}

// normalizeOptionalAuthMode 与 Node 一致：空串等价于 null（保留旧值）。
func normalizeOptionalAuthMode(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := truncateRunes(strings.TrimSpace(*value), maxAuthModeRunes)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// normalizeOptionalDisplayName 与 Node 一致：空串会被真正写空，不清成 null。
func normalizeOptionalDisplayName(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := truncateRunes(strings.TrimSpace(*value), maxDisplayNameRunes)
	return &trimmed
}

func normalizeOptionalRemainingPct(value *float64) *float64 {
	if value == nil {
		return nil
	}
	remaining := *value
	if math.IsNaN(remaining) || math.IsInf(remaining, 0) {
		return nil
	}
	remaining = math.Max(0, math.Min(100, remaining))
	return &remaining
}

func remainingPct(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	raw := value.Float64
	return normalizeOptionalRemainingPct(&raw)
}

func nullableText(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableReal(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}

func truncateRunes(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	return string([]rune(value)[:limit])
}

func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
