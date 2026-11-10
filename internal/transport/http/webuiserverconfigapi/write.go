package webuiserverconfigapi

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
)

// writeConfig 处理 POST：把 payload.config 合并进当前配置，按 Node
// mergeServerConfigPatch/sanitizeServerConfig 的规则归一化后整份写回。
func (handler *Handler) writeConfig(response http.ResponseWriter, request *http.Request) {
	var payload map[string]any
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, 1024*1024))
	if err := decoder.Decode(&payload); err != nil || payload == nil {
		writeError(response, http.StatusBadRequest, "invalid_payload", "")
		return
	}
	rawPatch, exists := payload["config"]
	if !exists || rawPatch == nil {
		writeError(response, http.StatusBadRequest, "invalid_payload", "")
		return
	}
	patch, ok := rawPatch.(map[string]any)
	if !ok {
		writeError(response, http.StatusBadRequest, "invalid_payload", "")
		return
	}
	if value, has := patch["managementKey"]; has && strings.TrimSpace(jsString(value)) != "" {
		writeError(response, http.StatusBadRequest, "management_key_rotation_required", "请使用专用 Management Key 轮换操作。")
		return
	}

	var saved ConfigView
	err := handler.store.UpdateServerConfig(request.Context(), func(current string, found bool) (string, error) {
		base, err := sanitizeFullServerConfigFromJSON(current, found)
		if err != nil {
			return "", err
		}
		merged := mergeServerConfigPatch(base, patch)
		saved = sanitizeServerConfig(merged)
		stored := configToMap(saved)
		delete(stored, "apiKeyConfigured")
		delete(stored, "managementKeyConfigured")
		encoded, err := json.Marshal(stored)
		if err != nil {
			return "", err
		}
		return string(encoded), nil
	})
	if err != nil {
		writeError(response, http.StatusInternalServerError, "set_server_config_failed", "")
		return
	}
	writeJSON(response, http.StatusOK, responseView{OK: true, Config: publicServerConfig(saved)})
}

// mergeServerConfigPatch 复刻 Node：只认已知键；apiKey/managementKey 的空串不覆盖；
// openNetwork=false 且未显式给 host 时，把现存 0.0.0.0 收回默认 host。
func mergeServerConfigPatch(base ConfigView, patch map[string]any) map[string]any {
	merged := configToMap(base)
	for _, key := range serverConfigKeys() {
		value, exists := patch[key]
		if !exists || value == nil {
			continue
		}
		if key == "apiKey" || key == "managementKey" {
			if strings.TrimSpace(jsString(value)) == "" {
				continue
			}
		}
		merged[key] = value
	}
	openNetwork, hasOpen := patch["openNetwork"]
	_, hasHost := patch["host"]
	if hasOpen && openNetwork == false && !hasHost && jsString(merged["host"]) == "0.0.0.0" {
		merged["host"] = defaultServerHost
	}
	return merged
}

func configToMap(config ConfigView) map[string]any {
	encoded, _ := json.Marshal(config)
	var result map[string]any
	_ = json.Unmarshal(encoded, &result)
	if result == nil {
		result = map[string]any{}
	}
	return result
}

func publicServerConfig(config ConfigView) ConfigView {
	public := config
	public.APIKeyConfigured = strings.TrimSpace(config.APIKey) != ""
	public.ManagementKeyConfigured = strings.TrimSpace(config.ManagementKey) != ""
	public.APIKey = ""
	public.ManagementKey = ""
	return public
}

// serverConfigKeys 从 ConfigView 的 json tag 派生，新增字段不会漏。
func serverConfigKeys() []string {
	configType := reflect.TypeOf(ConfigView{})
	keys := make([]string, 0, configType.NumField())
	for index := 0; index < configType.NumField(); index++ {
		tag := configType.Field(index).Tag.Get("json")
		name := strings.Split(tag, ",")[0]
		if name != "" && name != "-" {
			keys = append(keys, name)
		}
	}
	return keys
}
