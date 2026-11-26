package sqliteaccount

// 本文件维护托管客户端 API Key 的持久化（aih.db 的 client_api_keys）。
//
// 只保存 SHA-256 摘要与前缀；明文只在创建/轮换时返回一次。读取路径分为两种：
// 鉴权用的活动 Key 快照（id + hash + 展示信息）与管理列表（含限流字段）。

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/clientkeys"
)

var (
	// ErrClientKeyNotFound 表示 key_id 不存在；与领域哨兵同源，管理面直接映射 404。
	ErrClientKeyNotFound = clientkeys.ErrNotFound
	// ErrClientKeyCollision 表示密钥摘要与已有 Key 冲突（极端情况，需重新生成）。
	ErrClientKeyCollision = errors.New("客户端 API Key 摘要冲突")
)

// ClientKeyAuthRecord 是鉴权快照的一行。
type ClientKeyAuthRecord = clientkeys.AuthRecord

const clientKeyColumns = `key_id, name, key_prefix, enabled, created_at_ms, updated_at_ms,
	last_used_at_ms, revoked_at_ms, allowed_providers_json, allowed_models_json,
	max_concurrency, rpm_limit, tpm_limit, daily_token_limit, notes`

// ListClientKeys 返回全部未删除的 Key（含已停用，供管理页展示）。
//
// 旧的软删除行（revoked_at_ms != 0）不再出现在列表里：删除是硬删除，但历史
// 数据库可能残留撤销行，这里统一隐藏，避免「删不掉」的错觉。
func (store *Store) ListClientKeys(ctx context.Context) ([]clientkeys.Key, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("账号数据库不可用")
	}
	rows, err := store.db.QueryContext(ctx, `SELECT `+clientKeyColumns+`
		FROM client_api_keys WHERE revoked_at_ms = 0 ORDER BY created_at_ms DESC`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	keys := make([]clientkeys.Key, 0, 16)
	for rows.Next() {
		key, scanErr := scanClientKey(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		keys = append(keys, key)
	}
	return keys, rows.Err()
}

// GetClientKey 读取单把 Key。
func (store *Store) GetClientKey(ctx context.Context, keyID string) (clientkeys.Key, bool, error) {
	if store == nil || store.db == nil {
		return clientkeys.Key{}, false, errors.New("账号数据库不可用")
	}
	row := store.db.QueryRowContext(ctx, `SELECT `+clientKeyColumns+`
		FROM client_api_keys WHERE key_id = ?`, strings.TrimSpace(keyID))
	key, err := scanClientKey(row)
	if errors.Is(err, sql.ErrNoRows) {
		return clientkeys.Key{}, false, nil
	}
	if err != nil {
		return clientkeys.Key{}, false, err
	}
	return key, true, nil
}

// CreateClientKey 插入一把新 Key。
func (store *Store) CreateClientKey(ctx context.Context, key clientkeys.Key, hash [32]byte) error {
	if store == nil || store.db == nil {
		return errors.New("账号数据库不可用")
	}
	providers, err := encodeStringList(key.Limits.AllowedProviders)
	if err != nil {
		return err
	}
	models, err := encodeStringList(key.Limits.AllowedModels)
	if err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	if key.CreatedAtMS == 0 {
		key.CreatedAtMS = now
	}
	if key.UpdatedAtMS == 0 {
		key.UpdatedAtMS = key.CreatedAtMS
	}
	_, err = store.db.ExecContext(ctx, `INSERT INTO client_api_keys (
		key_id, name, key_hash, key_prefix, enabled, created_at_ms, updated_at_ms,
		last_used_at_ms, revoked_at_ms, allowed_providers_json, allowed_models_json,
		max_concurrency, rpm_limit, tpm_limit, daily_token_limit, notes
	) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
		key.ID, key.Name, hash[:], key.Prefix, boolInt(key.Enabled),
		key.CreatedAtMS, key.UpdatedAtMS, providers, models,
		key.Limits.MaxConcurrency, key.Limits.RPMLimit, key.Limits.TPMLimit,
		key.Limits.DailyTokenLimit, key.Notes)
	if err != nil {
		if isUniqueConstraint(err) {
			return ErrClientKeyCollision
		}
		return err
	}
	return nil
}

// UpdateClientKey 在事务内读取-修改-写回；mutate 返回错误则回滚。
func (store *Store) UpdateClientKey(
	ctx context.Context,
	keyID string,
	mutate func(*clientkeys.Key) error,
) (clientkeys.Key, error) {
	if store == nil || store.db == nil {
		return clientkeys.Key{}, errors.New("账号数据库不可用")
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return clientkeys.Key{}, err
	}
	defer func() { _ = tx.Rollback() }()
	row := tx.QueryRowContext(ctx, `SELECT `+clientKeyColumns+`
		FROM client_api_keys WHERE key_id = ?`, strings.TrimSpace(keyID))
	key, err := scanClientKey(row)
	if errors.Is(err, sql.ErrNoRows) {
		return clientkeys.Key{}, ErrClientKeyNotFound
	}
	if err != nil {
		return clientkeys.Key{}, err
	}
	if err := mutate(&key); err != nil {
		return clientkeys.Key{}, err
	}
	key.UpdatedAtMS = time.Now().UnixMilli()
	providers, err := encodeStringList(key.Limits.AllowedProviders)
	if err != nil {
		return clientkeys.Key{}, err
	}
	models, err := encodeStringList(key.Limits.AllowedModels)
	if err != nil {
		return clientkeys.Key{}, err
	}
	_, err = tx.ExecContext(ctx, `UPDATE client_api_keys SET
		name = ?, enabled = ?, allowed_providers_json = ?, allowed_models_json = ?,
		max_concurrency = ?, rpm_limit = ?, tpm_limit = ?, daily_token_limit = ?,
		notes = ?, updated_at_ms = ?
		WHERE key_id = ?`,
		key.Name, boolInt(key.Enabled), providers, models,
		key.Limits.MaxConcurrency, key.Limits.RPMLimit, key.Limits.TPMLimit,
		key.Limits.DailyTokenLimit, key.Notes, key.UpdatedAtMS, key.ID)
	if err != nil {
		return clientkeys.Key{}, err
	}
	if err := tx.Commit(); err != nil {
		return clientkeys.Key{}, err
	}
	return key, nil
}

// DeleteClientKey 永久删除一把 Key。
//
// 只删 Key 本身：调用统计（client_key_*_minute/hour）是历史事实，保留下来不
// 影响鉴权与列表，删除后也没有入口再展示它们。软删除语义已由 enabled=0 承担。
func (store *Store) DeleteClientKey(ctx context.Context, keyID string) error {
	if store == nil || store.db == nil {
		return errors.New("账号数据库不可用")
	}
	result, err := store.db.ExecContext(ctx,
		`DELETE FROM client_api_keys WHERE key_id = ? AND revoked_at_ms = 0`,
		strings.TrimSpace(keyID))
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrClientKeyNotFound
	}
	return nil
}

// RotateClientKeySecret 原子替换密钥摘要。
func (store *Store) RotateClientKeySecret(ctx context.Context, keyID string, hash [32]byte) error {
	if store == nil || store.db == nil {
		return errors.New("账号数据库不可用")
	}
	now := time.Now().UnixMilli()
	result, err := store.db.ExecContext(ctx, `UPDATE client_api_keys
		SET key_hash = ?, updated_at_ms = ?
		WHERE key_id = ? AND revoked_at_ms = 0`,
		hash[:], now, strings.TrimSpace(keyID))
	if err != nil {
		if isUniqueConstraint(err) {
			return ErrClientKeyCollision
		}
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrClientKeyNotFound
	}
	return nil
}

// TouchClientKeyLastUsed 更新最后使用时间（只前进不后退）。
func (store *Store) TouchClientKeyLastUsed(ctx context.Context, keyID string, atMS int64) error {
	if store == nil || store.db == nil || atMS <= 0 {
		return nil
	}
	_, err := store.db.ExecContext(ctx, `UPDATE client_api_keys
		SET last_used_at_ms = ? WHERE key_id = ? AND last_used_at_ms < ?`,
		atMS, strings.TrimSpace(keyID), atMS)
	return err
}

// LoadActiveClientKeys 返回鉴权快照：启用且未撤销的 Key。
func (store *Store) LoadActiveClientKeys(ctx context.Context) ([]ClientKeyAuthRecord, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("账号数据库不可用")
	}
	rows, err := store.db.QueryContext(ctx, `SELECT key_id, name, key_prefix, key_hash,
		max_concurrency, rpm_limit, tpm_limit, daily_token_limit,
		allowed_providers_json, allowed_models_json
		FROM client_api_keys WHERE enabled = 1 AND revoked_at_ms = 0`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	records := make([]ClientKeyAuthRecord, 0, 8)
	for rows.Next() {
		var record ClientKeyAuthRecord
		var hash []byte
		var providersJSON, modelsJSON string
		if err := rows.Scan(
			&record.KeyID, &record.Name, &record.Prefix, &hash,
			&record.Limits.MaxConcurrency, &record.Limits.RPMLimit,
			&record.Limits.TPMLimit, &record.Limits.DailyTokenLimit,
			&providersJSON, &modelsJSON,
		); err != nil {
			return nil, err
		}
		if len(hash) != len(record.Hash) {
			continue
		}
		copy(record.Hash[:], hash)
		record.Limits.AllowedProviders = decodeStringList(providersJSON)
		record.Limits.AllowedModels = decodeStringList(modelsJSON)
		records = append(records, record)
	}
	return records, rows.Err()
}

// ClientKeyRevision 返回 (max(updated_at_ms), count)，供跨进程热更新短路判断。
func (store *Store) ClientKeyRevision(ctx context.Context) (int64, int64, error) {
	if store == nil || store.db == nil {
		return 0, 0, errors.New("账号数据库不可用")
	}
	var maxUpdated, count int64
	err := store.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(updated_at_ms), 0), COUNT(*)
		FROM client_api_keys`).Scan(&maxUpdated, &count)
	return maxUpdated, count, err
}

func scanClientKey(row interface{ Scan(dest ...any) error }) (clientkeys.Key, error) {
	var (
		key           clientkeys.Key
		enabled       int
		providersJSON string
		modelsJSON    string
	)
	err := row.Scan(
		&key.ID, &key.Name, &key.Prefix, &enabled, &key.CreatedAtMS, &key.UpdatedAtMS,
		&key.LastUsedAtMS, &key.RevokedAtMS, &providersJSON, &modelsJSON,
		&key.Limits.MaxConcurrency, &key.Limits.RPMLimit, &key.Limits.TPMLimit,
		&key.Limits.DailyTokenLimit, &key.Notes,
	)
	if err != nil {
		return clientkeys.Key{}, err
	}
	key.Enabled = enabled != 0
	key.Limits.AllowedProviders = decodeStringList(providersJSON)
	key.Limits.AllowedModels = decodeStringList(modelsJSON)
	return key, nil
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func encodeStringList(values []string) (string, error) {
	if len(values) == 0 {
		return "[]", nil
	}
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			normalized = append(normalized, trimmed)
		}
	}
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func decodeStringList(raw string) []string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed == "[]" {
		return nil
	}
	var values []string
	if err := json.Unmarshal([]byte(trimmed), &values); err != nil {
		return nil
	}
	return values
}

func isUniqueConstraint(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "unique")
}
