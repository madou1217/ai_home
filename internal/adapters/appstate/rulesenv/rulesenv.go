// Package rulesenv 写 app-state.db 的 account_credentials.env_json 中「调度规则」
// 两个键：AIH_UPSTREAM_ERROR_RULES / AIH_UPSTREAM_ERROR_GROUP_IDS。
//
// 这是 routing-rules 单一写者的存储前置：写入必须读改写（保留同一 env 里的其它
// 凭据键），并保留 env_updated_at —— 规则是调度元数据，不是凭据本身，改规则不能
// 制造「凭据刚刚刷新过」的证据（与 Node preserveCredentialTimestamp 同口径）。
package rulesenv

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const (
	// RulesEnvKey 是账号自定义上游错误规则的 env 键，值本身是 JSON 数组字符串。
	RulesEnvKey = "AIH_UPSTREAM_ERROR_RULES"
	// GroupIDsEnvKey 是账号挂载的异常映射分组 env 键，值本身是 JSON 数组字符串。
	GroupIDsEnvKey = "AIH_UPSTREAM_ERROR_GROUP_IDS"
	maxGroupIDs    = 20
	busyTimeoutMS  = 5000
)

var (
	// ErrInvalidAccountRef 表示 account_ref 为空。
	ErrInvalidAccountRef = errors.New("account_ref 不能为空")
	// ErrAccountNotFound 表示 account_credentials 中没有该账号。
	ErrAccountNotFound = errors.New("account_credentials 中没有该账号")
	// ErrInvalidEnvJSON 表示已存的 env_json 不是 JSON 对象；此时拒绝写入，避免
	// 用一份空对象覆盖掉未知数据。
	ErrInvalidEnvJSON = errors.New("env_json 不是 JSON 对象")
	// ErrInvalidRules 表示规则不是 JSON 对象数组。
	ErrInvalidRules = errors.New("调度规则必须是 JSON 对象数组")
	// ErrInvalidGroupIDs 表示分组 ID 不合规、超量或为空。
	ErrInvalidGroupIDs = errors.New("调度规则分组 ID 无效")

	groupIDPattern = regexp.MustCompile("^[A-Za-z0-9_-]{1,64}$")
)

// Change 描述一次写入。字段为 nil 表示保留该键不动；空切片表示删除该键。
// 两个字段都是 nil 时是一次无写入的读取。
type Change struct {
	Rules    []json.RawMessage
	GroupIDs []string
}

// State 是账号当前的规则状态。
type State struct {
	Rules        []json.RawMessage
	GroupIDs     []string
	EnvUpdatedAt int64
}

// Result 描述写入结果。
type Result struct {
	// Changed 为 false 表示内容没有变化，未产生任何写入（updated_at 也未动）。
	Changed bool
	// EnvUpdatedAt 是写入前后都未改动的凭据时间戳。
	EnvUpdatedAt int64
}

// Store 是 app-state 的规则写入口。连接以 BEGIN IMMEDIATE 串行化读改写，
// 避免与另一个写者互相覆盖同一行 env_json 的不同键。
type Store struct {
	db  *sql.DB
	now func() time.Time
}

// Open 打开 databasePath 指向的 app-state.db。文件不存在时按 rwc 创建；
// account_credentials 表由调用方保证已存在。
func Open(ctx context.Context, databasePath string) (*Store, error) {
	db, err := sql.Open("sqlite", buildWritableDSN(databasePath))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db, now: time.Now}, nil
}

// Close 释放数据库连接。
func (store *Store) Close() error {
	if store == nil || store.db == nil {
		return nil
	}
	return store.db.Close()
}

// Read 返回账号当前的规则与未改动的 env_updated_at。
func (store *Store) Read(ctx context.Context, accountRef string) (State, error) {
	reference, err := normalizeAccountRef(accountRef)
	if err != nil {
		return State{}, err
	}
	var raw string
	var envUpdatedAt int64
	err = store.db.QueryRowContext(ctx,
		"SELECT env_json, env_updated_at FROM account_credentials WHERE account_ref = ?",
		reference).Scan(&raw, &envUpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return State{}, ErrAccountNotFound
	}
	if err != nil {
		return State{}, err
	}
	env, err := decodeEnv(raw)
	if err != nil {
		return State{}, err
	}
	return State{
		Rules:        decodeRuleValues(env[RulesEnvKey]),
		GroupIDs:     decodeGroupIDsValue(env[GroupIDsEnvKey]),
		EnvUpdatedAt: envUpdatedAt,
	}, nil
}

// Update 在 BEGIN IMMEDIATE 事务里读改写 env_json：只替换 Change 指定的两个
// 规则键，其余 env 键原样保留；env_updated_at 不做任何更新。
func (store *Store) Update(ctx context.Context, accountRef string, change Change) (Result, error) {
	reference, err := normalizeAccountRef(accountRef)
	if err != nil {
		return Result{}, err
	}
	var encodedRules []byte
	if len(change.Rules) > 0 {
		encodedRules, err = encodeRules(change.Rules)
		if err != nil {
			return Result{}, err
		}
	}
	var encodedGroupIDs []byte
	if len(change.GroupIDs) > 0 {
		encodedGroupIDs, err = encodeGroupIDs(change.GroupIDs)
		if err != nil {
			return Result{}, err
		}
	}

	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var raw string
	var envUpdatedAt int64
	err = tx.QueryRowContext(ctx,
		"SELECT env_json, env_updated_at FROM account_credentials WHERE account_ref = ?",
		reference).Scan(&raw, &envUpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Result{}, ErrAccountNotFound
	}
	if err != nil {
		return Result{}, err
	}
	env, err := decodeEnv(raw)
	if err != nil {
		return Result{}, err
	}
	current, err := json.Marshal(env)
	if err != nil {
		return Result{}, err
	}
	if change.Rules != nil {
		if len(change.Rules) == 0 {
			delete(env, RulesEnvKey)
		} else {
			env[RulesEnvKey] = encodeStringValue(encodedRules)
		}
	}
	if change.GroupIDs != nil {
		if len(change.GroupIDs) == 0 {
			delete(env, GroupIDsEnvKey)
		} else {
			env[GroupIDsEnvKey] = encodeStringValue(encodedGroupIDs)
		}
	}
	next, err := json.Marshal(env)
	if err != nil {
		return Result{}, err
	}
	if bytes.Equal(current, next) {
		return Result{Changed: false, EnvUpdatedAt: envUpdatedAt}, nil
	}
	result, err := tx.ExecContext(ctx,
		"UPDATE account_credentials SET env_json = ?, updated_at = ? WHERE account_ref = ?",
		string(next), store.clockNow().UnixMilli(), reference)
	if err != nil {
		return Result{}, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return Result{}, err
	}
	if affected != 1 {
		return Result{}, ErrAccountNotFound
	}
	if err := tx.Commit(); err != nil {
		return Result{}, err
	}
	return Result{Changed: true, EnvUpdatedAt: envUpdatedAt}, nil
}

func (store *Store) clockNow() time.Time {
	if store.now != nil {
		return store.now()
	}
	return time.Now()
}

func normalizeAccountRef(accountRef string) (string, error) {
	reference := strings.TrimSpace(accountRef)
	if reference == "" {
		return "", ErrInvalidAccountRef
	}
	return reference, nil
}

func decodeEnv(raw string) (map[string]json.RawMessage, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return map[string]json.RawMessage{}, nil
	}
	var env map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &env); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidEnvJSON, err)
	}
	if env == nil {
		return nil, fmt.Errorf("%w: null", ErrInvalidEnvJSON)
	}
	return env, nil
}

// encodeRules 把非空规则数组序列化成 env 值的字符串内容。
func encodeRules(rules []json.RawMessage) ([]byte, error) {
	for index, rule := range rules {
		trimmed := bytes.TrimSpace(rule)
		var object map[string]json.RawMessage
		if len(trimmed) == 0 || json.Unmarshal(trimmed, &object) != nil || object == nil {
			return nil, fmt.Errorf("%w：第 %d 条不是 JSON 对象", ErrInvalidRules, index+1)
		}
	}
	encoded, err := json.Marshal(rules)
	if err != nil {
		return nil, fmt.Errorf("%w：%v", ErrInvalidRules, err)
	}
	return encoded, nil
}

// encodeGroupIDs 按 Node 读侧口径归一：去空白、去重、保持顺序、最多 20 个。
func encodeGroupIDs(groupIDs []string) ([]byte, error) {
	if len(groupIDs) > maxGroupIDs {
		return nil, fmt.Errorf("%w：最多 %d 个", ErrInvalidGroupIDs, maxGroupIDs)
	}
	normalized := make([]string, 0, len(groupIDs))
	seen := make(map[string]struct{}, len(groupIDs))
	for _, groupID := range groupIDs {
		trimmed := strings.TrimSpace(groupID)
		if !groupIDPattern.MatchString(trimmed) {
			return nil, fmt.Errorf("%w：%q", ErrInvalidGroupIDs, groupID)
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		normalized = append(normalized, trimmed)
	}
	return json.Marshal(normalized)
}

// encodeStringValue 把 JSON 数组序列化成 env 值的形态（JSON 字符串），
// 与 Node 的 JSON.stringify(数组) 一致。
func encodeStringValue(payload []byte) json.RawMessage {
	encoded, _ := json.Marshal(string(payload))
	return encoded
}

func decodeRuleValues(raw json.RawMessage) []json.RawMessage {
	payload, ok := decodeStringPayload(raw)
	if !ok {
		return nil
	}
	var rules []json.RawMessage
	if err := json.Unmarshal(payload, &rules); err != nil {
		return nil
	}
	return rules
}

func decodeGroupIDsValue(raw json.RawMessage) []string {
	payload, ok := decodeStringPayload(raw)
	if !ok {
		return nil
	}
	var groupIDs []string
	if err := json.Unmarshal(payload, &groupIDs); err != nil {
		return nil
	}
	return groupIDs
}

func decodeStringPayload(raw json.RawMessage) ([]byte, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, false
	}
	var payload string
	if err := json.Unmarshal(trimmed, &payload); err != nil {
		return nil, false
	}
	return []byte(payload), true
}

func buildWritableDSN(databasePath string) string {
	fileURL := &url.URL{Scheme: "file", Path: filepath.ToSlash(databasePath)}
	query := fileURL.Query()
	query.Set("mode", "rwc")
	query.Set("_txlock", "immediate")
	query.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", busyTimeoutMS))
	fileURL.RawQuery = query.Encode()
	return fileURL.String()
}
