// Package appsettings 是工具启动权限设置的共享读取层。
//
// 设置存在业务库（app_kv，key=toolkit:tool-permission-settings），WebUI 写入口与
// CLI 启动读的是同一行。放在这里而不是 transport 包：CLI 启动（providercli）与
// WebUI 读取（webuitoolsettingsapi）都必须依赖同一份解析语义，不能让启动路径
// 反向依赖 HTTP 传输层。
package appsettings

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// Key 是业务库里保存全部 Provider 权限设置的 app_kv 键。
	Key = "toolkit:tool-permission-settings"
)

// ErrInvalidRoot 表示缺少 AIH 数据根目录。
var ErrInvalidRoot = errors.New("工具启动权限设置读取配置无效")

// Settings 是单个 Provider 的启动权限设置（camelCase，与 Node 逐字段一致）。
type Settings struct {
	MaxPermission  bool     `json:"maxPermission"`
	ApplyToHost    bool     `json:"applyToHost"`
	PermissionArgs []string `json:"permissionArgs"`
	UpdatedAt      int64    `json:"updatedAt"`
}

// Default 与 Node 的 DEFAULT_APP_PERMISSION_SETTINGS 同值：
// 新会话默认授予最大权限，因此没有记录时 maxPermission=true。
func Default() Settings {
	return Settings{
		MaxPermission:  true,
		ApplyToHost:    false,
		PermissionArgs: []string{},
		UpdatedAt:      0,
	}
}

// Source 只读业务库里的权限设置。
type Source struct {
	databasePath string
}

// Open 创建只读读取器；不要求数据库已存在（全新数据根返回默认值）。
func Open(aiHomeDir string) (*Source, error) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil, ErrInvalidRoot
	}
	databasePath, err := appstate.DatabasePath(root)
	if err != nil {
		return nil, ErrInvalidRoot
	}
	return &Source{databasePath: databasePath}, nil
}

// Read 返回某 Provider 的设置记录。
//
// 读失败一律返回默认值而不是错误：Node 侧 readJsonValue 走 bestEffort，数据库损坏或
// 被占用时页面与启动都仍然可用（只是显示/应用默认设置）。把它变成错误会让权限面板
// 整页打不开、CLI 启动直接失败，而默认值本身就是合法状态。
func (source *Source) Read(ctx context.Context, provider string) Settings {
	fallback := Default()
	normalized := NormalizeProvider(provider)
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
	db, err := appstate.OpenReadOnly(ctx, source.databasePath)
	if err != nil {
		return fallback
	}
	defer func() { _ = db.Close() }()

	value, found, err := appstate.ReadRawKV(ctx, db, Key)
	if err != nil || !found {
		// 表不存在或键缺失，都与从未保存过设置同义。
		return fallback
	}
	return Parse(value, normalized, fallback)
}

// NormalizeProvider 与 Node normalizeProviderId 的匹配口径一致：小写、去空白。
func NormalizeProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}

// Parse 复刻 Node normalizeStore + normalizeRecord 的语义。
func Parse(value string, provider string, fallback Settings) Settings {
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
		if NormalizeProvider(key) != provider {
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
