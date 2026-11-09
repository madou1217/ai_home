package webuitoolsettingsapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	_ "modernc.org/sqlite"
)

// 工具启动权限设置存在 Node 的 app-state.db（app_kv）里，与 CLI 启动时读的是同一行。
// 这里只读，不建库、不建表、不写回：写入口仍在 Node（PUT /v0/webui/toolkit/apps/:id/settings）。
const (
	appStateDatabaseFileName  = "app-state.db"
	toolPermissionSettingsKey = "toolkit:tool-permission-settings"
	databaseBusyTimeoutMS     = 5000
)

// ErrInvalidSettingsSource 表示缺少 AIH 数据根目录。
var ErrInvalidSettingsSource = errors.New("工具启动权限设置读取配置无效")

// ToolPermissionSettings 是单个 Provider 的启动权限设置（camelCase，与 Node 逐字段一致）。
type ToolPermissionSettings struct {
	MaxPermission  bool     `json:"maxPermission"`
	ApplyToHost    bool     `json:"applyToHost"`
	PermissionArgs []string `json:"permissionArgs"`
	UpdatedAt      int64    `json:"updatedAt"`
}

// DefaultToolPermissionSettings 与 Node 的 DEFAULT_APP_PERMISSION_SETTINGS 同值：
// 新会话默认授予最大权限，因此没有记录时 maxPermission=true。
func DefaultToolPermissionSettings() ToolPermissionSettings {
	return ToolPermissionSettings{
		MaxPermission:  true,
		ApplyToHost:    false,
		PermissionArgs: []string{},
		UpdatedAt:      0,
	}
}

// SettingsSource 只读 app-state.db 里的 toolkit:tool-permission-settings。
type SettingsSource struct {
	databasePath string
}

// OpenSettingsSource 创建只读读取器；不要求数据库已存在（全新数据根返回默认值）。
func OpenSettingsSource(aiHomeDir string) (*SettingsSource, error) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil, ErrInvalidSettingsSource
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, ErrInvalidSettingsSource
	}
	return &SettingsSource{databasePath: filepath.Join(absolute, appStateDatabaseFileName)}, nil
}

// Read 返回某 Provider 的设置记录。
//
// 读失败一律返回默认值而不是错误：Node 侧 readJsonValue 走 bestEffort，数据库损坏或
// 被占用时 GET 仍然可用（只是显示默认设置）。把它变成 500 会让权限面板整页打不开，
// 而默认值本身就是合法状态。
func (source *SettingsSource) Read(ctx context.Context, provider string) ToolPermissionSettings {
	fallback := DefaultToolPermissionSettings()
	normalized := strings.ToLower(strings.TrimSpace(provider))
	if source == nil || source.databasePath == "" || normalized == "" || ctx == nil {
		return fallback
	}
	info, err := os.Stat(source.databasePath)
	if errors.Is(err, os.ErrNotExist) {
		return fallback
	}
	if err != nil || !info.Mode().IsRegular() {
		return fallback
	}
	db, err := openReadOnly(ctx, source.databasePath)
	if err != nil {
		return fallback
	}
	defer func() { _ = db.Close() }()

	var value string
	err = db.QueryRowContext(ctx,
		`SELECT value FROM app_kv WHERE key = ?`, toolPermissionSettingsKey,
	).Scan(&value)
	if err != nil {
		// 表不存在（sql.ErrNoRows / no such table）与从未保存过设置同义。
		return fallback
	}
	return parseSettingsRecord(value, normalized, fallback)
}

// parseSettingsRecord 复刻 Node normalizeStore + normalizeRecord 的语义。
func parseSettingsRecord(value string, provider string, fallback ToolPermissionSettings) ToolPermissionSettings {
	decoder := json.NewDecoder(strings.NewReader(value))
	decoder.UseNumber()
	var store map[string]any
	if err := decoder.Decode(&store); err != nil {
		return fallback
	}
	apps, ok := store["apps"].(map[string]any)
	if !ok {
		return fallback
	}
	var record any
	found := false
	for key, candidate := range apps {
		if strings.ToLower(strings.TrimSpace(key)) != provider {
			continue
		}
		record = candidate
		found = true
	}
	if !found {
		return fallback
	}
	fields, ok := record.(map[string]any)
	if !ok {
		return fallback
	}
	settings := fallback
	// Node：source.maxPermission !== false —— 只有显式 false 才关闭。
	if flag, present := fields["maxPermission"]; present {
		if boolean, isBool := flag.(bool); isBool {
			settings.MaxPermission = boolean
		}
	}
	settings.ApplyToHost = fields["applyToHost"] == true
	settings.PermissionArgs = normalizePermissionArgs(fields["permissionArgs"])
	settings.UpdatedAt = normalizeUpdatedAt(fields["updatedAt"])
	return settings
}

func normalizePermissionArgs(value any) []string {
	list, ok := value.([]any)
	if !ok {
		return []string{}
	}
	args := make([]string, 0, len(list))
	for _, item := range list {
		text := strings.TrimSpace(stringifyJSONValue(item))
		if text == "" {
			continue
		}
		args = append(args, text)
	}
	return args
}

// stringifyJSONValue 对齐 JS String(item)：只用于设置文件里的标量数组。
func stringifyJSONValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case json.Number:
		return typed.String()
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		return fmt.Sprint(typed)
	}
}

func normalizeUpdatedAt(value any) int64 {
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Int64()
		if err != nil {
			floating, floatErr := typed.Float64()
			if floatErr != nil {
				return 0
			}
			return int64(floating)
		}
		return parsed
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil {
			return 0
		}
		return int64(parsed)
	case float64:
		return int64(typed)
	case bool:
		// JS Number(true) === 1；Node 的 Number.isFinite(Number(value)) 会接受它。
		if typed {
			return 1
		}
		return 0
	default:
		return 0
	}
}

func openReadOnly(ctx context.Context, databasePath string) (*sql.DB, error) {
	db, err := openAndPing(ctx, databasePath, false)
	if err == nil {
		return db, nil
	}
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
	// query_only 是第二道保险：即使驱动忽略 mode=ro，也不允许本连接写入。
	query.Add("_pragma", "query_only(1)")
	if immutable {
		query.Set("immutable", "1")
	}
	fileURL.RawQuery = query.Encode()
	return fileURL.String()
}
