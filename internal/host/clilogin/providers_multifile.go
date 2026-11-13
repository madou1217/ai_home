package clilogin

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

// cline / kimi 的登录产物是多文件（整库或 credentials+device_id），但仍能在
// 一次性目录里完整读取后注册，不需要 Node 的槽位/证据逻辑。

func init() {
	providerSpecs["cline"] = providerSpec{layout: clineLoginLayout, readCredential: clineLoginCredential}
	providerSpecs["kimi"] = providerSpec{layout: kimiLoginLayout, readCredential: kimiLoginCredential}
}

// clineLoginLayout：CLINE_DIR/CLINE_DATA_DIR 指向一次性目录，HOME 保持宿主。
func clineLoginLayout(_ *providers.Catalog, hostHomeDir, runtimeDir string) (string, map[string]string, error) {
	env := baseEnvironment(hostHomeDir)
	root := filepath.Join(runtimeDir, ".cline")
	env["CLINE_DIR"] = root
	env["CLINE_DATA_DIR"] = filepath.Join(root, "data")
	for _, key := range []string{"CLINE_API_KEY", "CLINE_API_BASE_URL"} {
		delete(env, key)
	}
	return root, env, nil
}

// clineLoginCredential 读取并收窄 providers.json（只留 cline 槽位）。
func clineLoginCredential(configDir string) ([]byte, error) {
	raw, err := os.ReadFile(filepath.Join(configDir, "data", "settings", "providers.json"))
	if err != nil || len(strings.TrimSpace(string(raw))) == 0 || len(raw) > 1024*1024 {
		return nil, ErrCredentialMissing
	}
	sanitized, err := nativeaccount.SanitizeClineProvidersDocument(raw)
	if err != nil {
		return nil, ErrCredentialMissing
	}
	payload, err := json.Marshal(map[string]json.RawMessage{"auth": sanitized})
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]json.RawMessage{"native_auth_json": payload})
}

// kimiLoginLayout：KIMI_CODE_HOME 指向一次性目录，HOME 保持宿主。
func kimiLoginLayout(_ *providers.Catalog, hostHomeDir, runtimeDir string) (string, map[string]string, error) {
	env := baseEnvironment(hostHomeDir)
	root := filepath.Join(runtimeDir, ".kimi-code")
	env["KIMI_CODE_HOME"] = root
	for _, key := range []string{"MOONSHOT_API_KEY", "KIMI_API_KEY", "KIMI_BASE_URL", "KIMI_CODE_CUSTOM_HEADERS"} {
		delete(env, key)
	}
	return root, env, nil
}

// kimiLoginCredential 读取 credentials/kimi-code.json 与可选 device_id。
func kimiLoginCredential(configDir string) ([]byte, error) {
	credentials, err := os.ReadFile(filepath.Join(configDir, "credentials", "kimi-code.json"))
	if err != nil || len(strings.TrimSpace(string(credentials))) == 0 || len(credentials) > 1024*1024 || !json.Valid(credentials) {
		return nil, ErrCredentialMissing
	}
	document := map[string]json.RawMessage{"credentials": credentials}
	if raw, readErr := os.ReadFile(filepath.Join(configDir, "device_id")); readErr == nil {
		if deviceID, marshalErr := json.Marshal(strings.TrimSpace(string(raw))); marshalErr == nil && len(deviceID) > 2 {
			document["deviceId"] = deviceID
		}
	}
	payload, err := json.Marshal(document)
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]json.RawMessage{"native_auth_json": payload})
}
