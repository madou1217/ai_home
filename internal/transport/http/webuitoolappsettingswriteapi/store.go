package webuitoolappsettingswriteapi

import (
	"bytes"
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/transport/http/webuitoolsettingsapi"
)

// 存储口径与只读模型 webuitoolsettingsapi 完全一致：Node app-state.db 的 app_kv 里
// toolkit:tool-permission-settings 一行，值是 {version, apps: {provider: 记录}}。
// 键名在这里重复一次是必要的：那个包只导出读取能力，且本切片不允许改它。
const (
	toolPermissionSettingsKey     = "toolkit:tool-permission-settings"
	toolPermissionSettingsVersion = 1
)

// DatabaseStore 把 app-state.db 路径绑定成 SettingsStore。
type DatabaseStore struct {
	DatabasePath string
}

// Update 在 BEGIN IMMEDIATE 事务里合并写入单个 Provider 的设置。
//
// appstate.UpdateKV 以 _txlock=immediate 打开连接并在事务内回调，因此与 Node 及其它
// 并发写者串行化；mutate 返回错误时整笔回滚，不会留下半条记录。
//
// 其它 Provider 的记录按原始 JSON 原样保留：本包只对目标 Provider 做归一化，
// 不替别的应用重写字段（那会让一次写入带上与它无关的副作用）。
func (store DatabaseStore) Update(
	ctx context.Context,
	provider string,
	mutate func(current webuitoolsettingsapi.ToolPermissionSettings) (webuitoolsettingsapi.ToolPermissionSettings, error),
) (webuitoolsettingsapi.ToolPermissionSettings, error) {
	normalized := strings.ToLower(strings.TrimSpace(provider))
	if strings.TrimSpace(store.DatabasePath) == "" || normalized == "" {
		return webuitoolsettingsapi.ToolPermissionSettings{}, ErrStoreUnavailable
	}
	var saved webuitoolsettingsapi.ToolPermissionSettings
	err := appstate.UpdateKV(ctx, store.DatabasePath, toolPermissionSettingsKey, func(current string, found bool) (string, error) {
		document := parseSettingsDocument(current, found)
		next, err := mutate(document.settings(normalized))
		if err != nil {
			return "", err
		}
		next = normalizeSettings(next)
		next.UpdatedAt = time.Now().UnixMilli()
		encoded, err := document.withSettings(normalized, next)
		if err != nil {
			return "", err
		}
		saved = next
		return encoded, nil
	})
	if err != nil {
		return webuitoolsettingsapi.ToolPermissionSettings{}, err
	}
	return saved, nil
}

// settingsDocument 是 app_kv 里的设置文档；apps 的值保持原始 JSON。
type settingsDocument struct {
	apps map[string]json.RawMessage
}

// parseSettingsDocument 解析磁盘上的文档。
//
// 内容损坏时按空文档处理：Node 的读路径是 bestEffort，损坏时同样回落到默认值，
// 下一次保存会重建成合法文档。这里不返回错误，否则一个坏行会让权限面板永远写不进去。
func parseSettingsDocument(raw string, found bool) settingsDocument {
	document := settingsDocument{apps: map[string]json.RawMessage{}}
	if !found || strings.TrimSpace(raw) == "" {
		return document
	}
	var payload struct {
		Apps map[string]json.RawMessage `json:"apps"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil || payload.Apps == nil {
		return document
	}
	document.apps = payload.Apps
	return document
}

// settings 返回某个 Provider 的当前记录；没有记录时是默认值。
func (document settingsDocument) settings(provider string) webuitoolsettingsapi.ToolPermissionSettings {
	raw, ok := document.lookup(provider)
	if !ok {
		return webuitoolsettingsapi.DefaultToolPermissionSettings()
	}
	return parseStoredSettings(raw)
}

// withSettings 用新记录替换目标 Provider，并序列化整份文档。
func (document settingsDocument) withSettings(provider string, settings webuitoolsettingsapi.ToolPermissionSettings) (string, error) {
	encoded, err := json.Marshal(settings)
	if err != nil {
		return "", err
	}
	apps := make(map[string]json.RawMessage, len(document.apps)+1)
	for key, value := range document.apps {
		// 同一 Provider 的历史大小写变体一并收掉：Node 写回时也是按归一化 ID 落键，
		// 留着旧键会让同一条设置出现两份，读到的取决于遍历顺序。
		if key != provider && strings.ToLower(strings.TrimSpace(key)) == provider {
			continue
		}
		apps[key] = value
	}
	apps[provider] = encoded
	payload, err := json.Marshal(struct {
		Version int                        `json:"version"`
		Apps    map[string]json.RawMessage `json:"apps"`
	}{Version: toolPermissionSettingsVersion, Apps: apps})
	if err != nil {
		return "", err
	}
	return string(payload), nil
}

// lookup 按归一化 ID 查找记录：先精确匹配，再忽略大小写匹配。
func (document settingsDocument) lookup(provider string) (json.RawMessage, bool) {
	if raw, ok := document.apps[provider]; ok {
		return raw, true
	}
	for key, raw := range document.apps {
		if strings.ToLower(strings.TrimSpace(key)) == provider {
			return raw, true
		}
	}
	return nil, false
}

// parseStoredSettings 复刻 Node normalizeRecord 的语义：
// 只有显式 false 才关闭最大权限，applyToHost 只有 true 才算开启，参数列表去空。
func parseStoredSettings(raw json.RawMessage) webuitoolsettingsapi.ToolPermissionSettings {
	settings := webuitoolsettingsapi.DefaultToolPermissionSettings()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var fields map[string]any
	if err := decoder.Decode(&fields); err != nil {
		return settings
	}
	if flag, isBool := fields["maxPermission"].(bool); isBool {
		settings.MaxPermission = flag
	}
	if flag, isBool := fields["applyToHost"].(bool); isBool {
		settings.ApplyToHost = flag
	}
	settings.PermissionArgs = normalizePermissionArgs(fields["permissionArgs"])
	return settings
}

// normalizeSettings 保证落盘的记录形状稳定：参数列表不为 null，元素已去空白。
func normalizeSettings(settings webuitoolsettingsapi.ToolPermissionSettings) webuitoolsettingsapi.ToolPermissionSettings {
	args := make([]string, 0, len(settings.PermissionArgs))
	for _, item := range settings.PermissionArgs {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			args = append(args, trimmed)
		}
	}
	settings.PermissionArgs = args
	return settings
}

func normalizePermissionArgs(value any) []string {
	list, ok := value.([]any)
	if !ok {
		return []string{}
	}
	args := make([]string, 0, len(list))
	for _, item := range list {
		if text := strings.TrimSpace(scalarText(item)); text != "" {
			args = append(args, text)
		}
	}
	return args
}

// scalarText 对齐 JS String(item)：只用于设置文件里的标量数组。
func scalarText(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case json.Number:
		return typed.String()
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		return ""
	}
}
