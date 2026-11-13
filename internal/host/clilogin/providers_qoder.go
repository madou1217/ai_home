package clilogin

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/qodercred"
)

// qoder / qodercn 的登录产物是机器绑定的 opaque blob（.auth/user + machine_id），
// 身份只能由 CLI 内嵌 wasm 解密得到；登录流程用 QODER_CONFIG_DIR 指定一次性配置根。

func init() {
	providerSpecs["qoder"] = providerSpec{layout: qoderLoginLayout, readCredential: qoderLoginCredential}
	providerSpecs["qodercn"] = providerSpec{layout: qoderLoginLayout, readCredential: qoderLoginCredential}
}

// qoderDecrypt 是测试注入点；生产直接调用 wasm 解密。
var qoderDecrypt = qodercred.DecryptBlob

func qoderLoginLayout(_ *providers.Catalog, hostHomeDir, runtimeDir string) (string, map[string]string, error) {
	env := baseEnvironment(hostHomeDir)
	env["QODER_CONFIG_DIR"] = runtimeDir
	delete(env, "QODER_PERSONAL_ACCESS_TOKEN")
	return runtimeDir, env, nil
}

func qoderLoginCredential(configDir string) ([]byte, error) {
	blob, err := os.ReadFile(filepath.Join(configDir, ".auth", "user"))
	if err != nil || len(strings.TrimSpace(string(blob))) == 0 || len(blob) > 256*1024 {
		return nil, ErrCredentialMissing
	}
	machineID, err := os.ReadFile(filepath.Join(configDir, ".auth", "machine_id"))
	if err != nil || len(strings.TrimSpace(string(machineID))) < 16 {
		return nil, ErrCredentialMissing
	}
	providerID := "qoder"
	if strings.Contains(strings.ToLower(configDir), "qoder-cn") || strings.Contains(strings.ToLower(configDir), "qodercn") {
		providerID = "qodercn"
	}
	plaintext, err := qoderDecrypt(providerID, strings.TrimSpace(string(blob)), strings.TrimSpace(string(machineID)), qodercred.Options{
		HostHomeDir: os.Getenv("AIH_HOST_HOME"),
	})
	if err != nil {
		return nil, fmt.Errorf("解密 Qoder 登录凭据失败: %w", err)
	}
	var identity map[string]any
	if err := json.Unmarshal([]byte(plaintext), &identity); err != nil {
		return nil, fmt.Errorf("解析 Qoder 登录凭据失败: %w", err)
	}
	uid := ""
	for _, key := range []string{"uid", "user_id", "userId", "account_id", "accountId", "id"} {
		if value, ok := identity[key].(string); ok && strings.TrimSpace(value) != "" {
			uid = strings.TrimSpace(value)
			break
		}
	}
	if uid == "" {
		return nil, ErrCredentialMissing
	}
	userInfo := map[string]any{"uid": uid}
	for _, key := range []string{"email", "username"} {
		if value, ok := identity[key].(string); ok && strings.TrimSpace(value) != "" {
			userInfo[key] = strings.TrimSpace(value)
		}
	}
	payload, err := json.Marshal(map[string]any{
		"credentials": strings.TrimSpace(string(blob)),
		"machineId":   strings.TrimSpace(string(machineID)),
		"userInfo":    userInfo,
	})
	if err != nil {
		return nil, err
	}
	return json.Marshal(map[string]json.RawMessage{"native_auth_json": payload})
}
