// Package accountlistread 只读读取 aih.db 中 `aih ls` 需要的账号、资料、额度、
// 运行态与默认关系。
//
// 为什么不复用 sqliteaccount.Store：CLI 的列表是只读命令，不应该为了画一行
// 账号列表付建库迁移、孤儿清理和路由索引装载的代价；同时列表需要读取凭据 JSON
// 做身份与 API Key 展示，Store 的公开投影刻意不暴露凭据正文。这里只做 SELECT，
// 连接以 mode=ro + query_only 打开，任何写操作都会失败。
package accountlistread

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const databaseFileName = "aih.db"

// ErrDatabaseMissing 表示当前 AIH 数据根还没有账号库。
var ErrDatabaseMissing = errors.New("账号库不存在")

// Snapshot 是一次列表读取的完整只读投影。
type Snapshot struct {
	Accounts []Account
}

// Account 是一个账号在列表里消费的全部只读事实。
type Account struct {
	AccountRef   string
	Provider     string
	CLIAccountID int64
	Enabled      bool
	CreatedAt    time.Time
	UpdatedAt    time.Time

	AuthKind       string
	AuthMode       string
	CredentialJSON []byte
	// NodeNativeAuth / NodeEnv 是 app-state.db 里同一身份的 Node 侧凭据；
	// 用于补全 Go 库没有落盘的展示身份（邮箱/手机号/API Key）和 zcode 过期判断。
	NodeNativeAuth []byte
	NodeEnv        []byte

	HasProfile       bool
	DisplayName      string
	Email            string
	SubscriptionKind string
	SubscriptionRaw  string

	Usage     []UsageEntry
	Snapshot  *UsageSnapshot
	Runtime   *RuntimeState
	Cooldowns []ModelCooldown
	IsDefault bool
}

// UsageEntry 是 account_usage 的一行；RemainingBPS 为空表示未知。
type UsageEntry struct {
	LimitID       string
	LimitName     string
	Bucket        string
	Kind          string
	Scope         string
	ScopeKey      string
	Availability  string
	RemainingBPS  *int64
	WindowSeconds int64
	ResetAtMS     int64
	CapturedAtMS  int64
	PlanType      string
}

// UsageSnapshot 是 account_usage_snapshots 的标量列与原始文档。
type UsageSnapshot struct {
	Kind                string
	Source              string
	CapturedAtMS        int64
	Payload             []byte
	QuotaStatus         string
	QuotaReason         string
	RemainingBPS        *int64
	HasNumericRemaining bool
}

// RuntimeState 是 account_runtime_states 的原始 JSON 文档。
type RuntimeState struct {
	Document  []byte
	UpdatedAt time.Time
}

// ModelCooldown 是 account_runtime_state 的一行模型冷却。
type ModelCooldown struct {
	ModelID         string
	StreakKind      string
	StreakCount     int64
	CooldownKind    string
	CooldownUntilMS int64
}

// Read 读取账号库的完整投影（含 Node 凭据身份补全）。
func Read(ctx context.Context, aiHomeDir string) (*Snapshot, error) {
	return read(ctx, aiHomeDir, true)
}

// ReadBasic 跳过 app-state 凭据镜像，只读 Go 账号库；用于 TTY 首帧快速出图。
func ReadBasic(ctx context.Context, aiHomeDir string) (*Snapshot, error) {
	return read(ctx, aiHomeDir, false)
}

// Read 读取账号库。数据库不存在时返回 ErrDatabaseMissing。
func read(ctx context.Context, aiHomeDir string, withNodeOverlay bool) (*Snapshot, error) {
	path := filepath.Join(strings.TrimSpace(aiHomeDir), databaseFileName)
	if strings.TrimSpace(aiHomeDir) == "" {
		return nil, ErrDatabaseMissing
	}
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrDatabaseMissing
		}
		return nil, fmt.Errorf("检查账号库失败: %w", err)
	}
	dsn, err := readOnlyDSN(path)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开账号库失败: %w", err)
	}
	db.SetMaxOpenConns(1)
	defer func() { _ = db.Close() }()
	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("连接账号库失败: %w", err)
	}

	snapshot := &Snapshot{Accounts: []Account{}}
	byRef := make(map[string]*Account)
	if err := readAccounts(ctx, db, &snapshot.Accounts, byRef); err != nil {
		return nil, err
	}
	if len(snapshot.Accounts) == 0 {
		return snapshot, nil
	}
	if err := readCredentials(ctx, db, byRef); err != nil {
		return nil, err
	}
	if err := readProfiles(ctx, db, byRef); err != nil {
		return nil, err
	}
	if err := readUsage(ctx, db, byRef); err != nil {
		return nil, err
	}
	if err := readUsageSnapshots(ctx, db, byRef); err != nil {
		return nil, err
	}
	if err := readRuntimeStates(ctx, db, byRef); err != nil {
		return nil, err
	}
	if err := readCooldowns(ctx, db, byRef); err != nil {
		return nil, err
	}
	if err := readDefaults(ctx, db, byRef); err != nil {
		return nil, err
	}
	_ = withNodeOverlay // Node 兼容凭据 overlay 已退役；只读 canonical 账号行。
	return snapshot, nil
}

func readOnlyDSN(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("解析账号库路径失败: %w", err)
	}
	fileURL := sqlitefile.URL(absolute)
	query := fileURL.Query()
	query.Set("mode", "ro")
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "query_only(1)")
	fileURL.RawQuery = query.Encode()
	return fileURL.String(), nil
}

func readAccounts(ctx context.Context, db *sql.DB, out *[]Account, byRef map[string]*Account) error {
	rows, err := db.QueryContext(ctx, `
		SELECT account_ref, provider_id, cli_account_id, enabled, created_at_ms, updated_at_ms
		  FROM accounts
		 ORDER BY provider_id, cli_account_id`)
	if err != nil {
		return fmt.Errorf("读取账号失败: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var account Account
		var createdMS, updatedMS int64
		if err := rows.Scan(
			&account.AccountRef, &account.Provider, &account.CLIAccountID,
			&account.Enabled, &createdMS, &updatedMS,
		); err != nil {
			return fmt.Errorf("读取账号失败: %w", err)
		}
		account.CreatedAt = time.UnixMilli(createdMS)
		account.UpdatedAt = time.UnixMilli(updatedMS)
		*out = append(*out, account)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("读取账号失败: %w", err)
	}
	for index := range *out {
		byRef[(*out)[index].AccountRef] = &(*out)[index]
	}
	return nil
}

func readCredentials(ctx context.Context, db *sql.DB, byRef map[string]*Account) error {
	rows, err := db.QueryContext(ctx, `
		SELECT account_ref, auth_kind, auth_mode, credential_json
		  FROM account_credentials`)
	if err != nil {
		// 老库没有凭据表时按无凭据处理。
		if isMissingTable(err) {
			return nil
		}
		return fmt.Errorf("读取账号凭据失败: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var ref, authKind, authMode, document string
		if err := rows.Scan(&ref, &authKind, &authMode, &document); err != nil {
			return fmt.Errorf("读取账号凭据失败: %w", err)
		}
		if account := byRef[ref]; account != nil {
			account.AuthKind = strings.TrimSpace(authKind)
			account.AuthMode = strings.TrimSpace(authMode)
			account.CredentialJSON = []byte(document)
		}
	}
	return rows.Err()
}

func readProfiles(ctx context.Context, db *sql.DB, byRef map[string]*Account) error {
	rows, err := db.QueryContext(ctx, `
		SELECT account_ref, display_name, email, subscription_kind, subscription_raw
		  FROM account_profiles`)
	if err != nil {
		if isMissingTable(err) {
			return nil
		}
		return fmt.Errorf("读取账号资料失败: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var ref, display, email, kind, raw string
		if err := rows.Scan(&ref, &display, &email, &kind, &raw); err != nil {
			return fmt.Errorf("读取账号资料失败: %w", err)
		}
		if account := byRef[ref]; account != nil {
			account.HasProfile = true
			account.DisplayName = strings.TrimSpace(display)
			account.Email = strings.TrimSpace(email)
			account.SubscriptionKind = strings.TrimSpace(kind)
			account.SubscriptionRaw = strings.TrimSpace(raw)
		}
	}
	return rows.Err()
}

func readUsage(ctx context.Context, db *sql.DB, byRef map[string]*Account) error {
	rows, err := db.QueryContext(ctx, `
		SELECT account_ref, limit_id, limit_name, bucket, kind, scope, scope_key,
		       remaining_bps, availability, window_seconds, reset_at_ms,
		       captured_at_ms, plan_type
		  FROM account_usage
		 ORDER BY account_ref, limit_id, bucket`)
	if err != nil {
		if isMissingTable(err) {
			return nil
		}
		return fmt.Errorf("读取账号额度失败: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var ref string
		var entry UsageEntry
		var remaining, windowSeconds, resetAtMS, capturedAtMS sql.NullInt64
		if err := rows.Scan(
			&ref, &entry.LimitID, &entry.LimitName, &entry.Bucket, &entry.Kind,
			&entry.Scope, &entry.ScopeKey, &remaining, &entry.Availability,
			&windowSeconds, &resetAtMS, &capturedAtMS, &entry.PlanType,
		); err != nil {
			return fmt.Errorf("读取账号额度失败: %w", err)
		}
		if remaining.Valid {
			value := remaining.Int64
			entry.RemainingBPS = &value
		}
		entry.WindowSeconds = windowSeconds.Int64
		entry.ResetAtMS = resetAtMS.Int64
		entry.CapturedAtMS = capturedAtMS.Int64
		if account := byRef[ref]; account != nil {
			entry.LimitID = strings.TrimSpace(entry.LimitID)
			entry.LimitName = strings.TrimSpace(entry.LimitName)
			entry.Bucket = strings.TrimSpace(entry.Bucket)
			entry.Kind = strings.TrimSpace(entry.Kind)
			entry.Scope = strings.TrimSpace(entry.Scope)
			entry.ScopeKey = strings.TrimSpace(entry.ScopeKey)
			entry.Availability = strings.TrimSpace(entry.Availability)
			entry.PlanType = strings.TrimSpace(entry.PlanType)
			account.Usage = append(account.Usage, entry)
		}
	}
	return rows.Err()
}

func readUsageSnapshots(ctx context.Context, db *sql.DB, byRef map[string]*Account) error {
	rows, err := db.QueryContext(ctx, `
		SELECT account_ref, kind, source, captured_at_ms, payload_json,
		       quota_status, quota_reason, remaining_bps, has_numeric_remaining
		  FROM account_usage_snapshots`)
	if err != nil {
		if isMissingTable(err) {
			return nil
		}
		return fmt.Errorf("读取账号额度快照失败: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var ref, kind, source, payload, status, reason string
		var capturedMS int64
		var remaining sql.NullInt64
		var hasNumeric int64
		if err := rows.Scan(
			&ref, &kind, &source, &capturedMS, &payload,
			&status, &reason, &remaining, &hasNumeric,
		); err != nil {
			return fmt.Errorf("读取账号额度快照失败: %w", err)
		}
		if account := byRef[ref]; account != nil {
			snapshot := &UsageSnapshot{
				Kind:                strings.TrimSpace(kind),
				Source:              strings.TrimSpace(source),
				CapturedAtMS:        capturedMS,
				Payload:             []byte(payload),
				QuotaStatus:         strings.TrimSpace(status),
				QuotaReason:         strings.TrimSpace(reason),
				HasNumericRemaining: hasNumeric == 1,
			}
			if remaining.Valid {
				value := remaining.Int64
				snapshot.RemainingBPS = &value
			}
			account.Snapshot = snapshot
		}
	}
	return rows.Err()
}

func readRuntimeStates(ctx context.Context, db *sql.DB, byRef map[string]*Account) error {
	rows, err := db.QueryContext(ctx, `
		SELECT account_ref, state_json, updated_at_ms
		  FROM account_runtime_states`)
	if err != nil {
		if isMissingTable(err) {
			return nil
		}
		return fmt.Errorf("读取账号运行态失败: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var ref, document string
		var updatedMS int64
		if err := rows.Scan(&ref, &document, &updatedMS); err != nil {
			return fmt.Errorf("读取账号运行态失败: %w", err)
		}
		if account := byRef[ref]; account != nil {
			account.Runtime = &RuntimeState{
				Document:  []byte(document),
				UpdatedAt: time.UnixMilli(updatedMS),
			}
		}
	}
	return rows.Err()
}

func readCooldowns(ctx context.Context, db *sql.DB, byRef map[string]*Account) error {
	rows, err := db.QueryContext(ctx, `
		SELECT account_ref, model_id, streak_kind, streak_count,
		       cooldown_kind, cooldown_until_ms
		  FROM account_runtime_state`)
	if err != nil {
		if isMissingTable(err) {
			return nil
		}
		return fmt.Errorf("读取模型冷却失败: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var ref string
		var entry ModelCooldown
		if err := rows.Scan(
			&ref, &entry.ModelID, &entry.StreakKind, &entry.StreakCount,
			&entry.CooldownKind, &entry.CooldownUntilMS,
		); err != nil {
			return fmt.Errorf("读取模型冷却失败: %w", err)
		}
		if account := byRef[ref]; account != nil {
			entry.ModelID = strings.TrimSpace(entry.ModelID)
			entry.StreakKind = strings.TrimSpace(entry.StreakKind)
			entry.CooldownKind = strings.TrimSpace(entry.CooldownKind)
			account.Cooldowns = append(account.Cooldowns, entry)
		}
	}
	return rows.Err()
}

func readDefaults(ctx context.Context, db *sql.DB, byRef map[string]*Account) error {
	rows, err := db.QueryContext(ctx, `SELECT provider_id, account_ref FROM account_defaults`)
	if err != nil {
		if isMissingTable(err) {
			return nil
		}
		return fmt.Errorf("读取默认账号失败: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var provider, ref string
		if err := rows.Scan(&provider, &ref); err != nil {
			return fmt.Errorf("读取默认账号失败: %w", err)
		}
		if account := byRef[ref]; account != nil && account.Provider == strings.TrimSpace(provider) {
			account.IsDefault = true
		}
	}
	return rows.Err()
}

func isMissingTable(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "no such table")
}
