package webuicontrolplanebootstrapapi

import (
	"context"
	"encoding/json"
	"net/url"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// profilesKey 是 Node 控制面 profile store 的 app_kv 键。
const profilesKey = "control-plane:profiles"

// profileStore 是 control-plane:profiles 的最小只读投影。
//
// 每条 profile 保持 map 形态原样透传：引导接口只补 id/name/endpoint/state 并剔除
// managementKey，不重算统计字段。归一化与写入归 webuicontrolplaneapi（唯一写入口），
// 在这里复制一份 normalizeProfile 会立刻变成第二套口径。
type profileStore struct {
	ActiveProfileID string           `json:"activeProfileId"`
	Profiles        []map[string]any `json:"profiles"`
}

// readProfileStore 读取 profile store；库或键不存在时返回空 store，不视为错误。
func (handler *Handler) readProfileStore(ctx context.Context) (profileStore, error) {
	databasePath, err := appstate.DatabasePath(handler.aiHomeDir)
	if err != nil {
		return profileStore{}, err
	}
	raw, found, err := appstate.ReadKV(ctx, databasePath, profilesKey)
	if err != nil {
		return profileStore{}, err
	}
	if !found || strings.TrimSpace(raw) == "" {
		return profileStore{}, nil
	}
	// UseNumber 保留原始数字字面量，避免 ms 时间戳与计数经过 float64 后失真。
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	var decoded profileStore
	if err := decoder.Decode(&decoded); err != nil {
		return profileStore{}, err
	}
	return decoded, nil
}

// profileByEndpoint 按归一化 endpoint 命中已存 profile；命中不到返回 nil。
func (store profileStore) profileByEndpoint(endpoint string) map[string]any {
	target := normalizeEndpoint(endpoint)
	if target == "" {
		return nil
	}
	for _, profile := range store.Profiles {
		if profile == nil {
			continue
		}
		if normalizeEndpoint(trimmedString(profile["endpoint"])) == target {
			return profile
		}
	}
	return nil
}

// activeProfileID 返回有效的 activeProfileId，无效时回落到 fallback。
//
// Node 的 normalizeStore 会把指向不存在 profile 的 activeProfileId 清空；这里只做同一件事，
// 不搬整套 store 归一化。
func (store profileStore) activeProfileID(fallback string) string {
	id := strings.TrimSpace(store.ActiveProfileID)
	if id == "" {
		return fallback
	}
	for _, profile := range store.Profiles {
		if profile == nil {
			continue
		}
		if trimmedString(profile["id"]) == id {
			return id
		}
	}
	return fallback
}

// normalizeEndpoint 复刻 Node control-plane-profile-store 的归一化口径：
// 去首尾空白与末尾斜杠、缺 scheme 时补 https、丢弃 query 与 fragment。
func normalizeEndpoint(value string) string {
	raw := strings.TrimRight(strings.TrimSpace(value), "/")
	if raw == "" {
		return ""
	}
	lower := strings.ToLower(raw)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		raw = "https://" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return ""
	}
	parsed.Fragment = ""
	parsed.RawQuery = ""
	return strings.TrimRight(parsed.String(), "/")
}
