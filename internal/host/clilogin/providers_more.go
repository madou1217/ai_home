package clilogin

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// 这里放「单文件凭据」Provider 的登录适配：CLI 在一次性运行目录里完成 OAuth 后
// 把 auth.json 落盘，直接包成 native_auth_json 交给 nativeaccount 解码。
// 多文件/整库 Provider（cline/kimi/qoder/kiro）仍需各自的槽位合并与证据构造，暂不在此列。

func init() {
	providerSpecs["grok"] = providerSpec{layout: grokLoginLayout, readCredential: jsonFieldCredential("auth")}
	providerSpecs["opencode"] = providerSpec{layout: openCodeLoginLayout, readCredential: jsonFieldCredential("auth")}
}

// grokLoginLayout：HOME 与 GROK_HOME 都指向一次性目录，宿主 XAI/GROK 变量全部剥掉。
func grokLoginLayout(_ *providers.Catalog, hostHomeDir, runtimeDir string) (string, map[string]string, error) {
	env := baseEnvironment(hostHomeDir)
	env["HOME"] = runtimeDir
	env["USERPROFILE"] = runtimeDir
	env["GROK_HOME"] = filepath.Join(runtimeDir, ".grok")
	for _, key := range []string{"XAI_API_KEY", "XAI_BASE_URL"} {
		delete(env, key)
	}
	return filepath.Join(runtimeDir, ".grok"), env, nil
}

// openCodeLoginLayout：只隔离 XDG 数据/配置根，HOME 保持宿主（与 launch 策略一致）。
func openCodeLoginLayout(_ *providers.Catalog, hostHomeDir, runtimeDir string) (string, map[string]string, error) {
	env := baseEnvironment(hostHomeDir)
	env["XDG_DATA_HOME"] = filepath.Join(runtimeDir, ".local", "share")
	env["XDG_CONFIG_HOME"] = filepath.Join(runtimeDir, ".config")
	env["XDG_STATE_HOME"] = filepath.Join(runtimeDir, ".local", "state")
	for _, key := range []string{
		"OPENCODE_API_KEY", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR",
		"OPENCODE_CONFIG_CONTENT", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME",
	} {
		delete(env, key)
	}
	return filepath.Join(runtimeDir, ".local", "share", "opencode"), env, nil
}

// jsonFieldCredential 读取 configDir/auth.json 并包成 { field: <document> }。
func jsonFieldCredential(field string) func(string) ([]byte, error) {
	return func(configDir string) ([]byte, error) {
		raw, err := os.ReadFile(filepath.Join(configDir, "auth.json"))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil, ErrCredentialMissing
			}
			return nil, err
		}
		if len(strings.TrimSpace(string(raw))) == 0 || len(raw) > 1024*1024 || !json.Valid(raw) {
			return nil, ErrCredentialMissing
		}
		payload, err := json.Marshal(map[string]json.RawMessage{field: raw})
		if err != nil {
			return nil, err
		}
		return json.Marshal(map[string]json.RawMessage{"native_auth_json": payload})
	}
}
