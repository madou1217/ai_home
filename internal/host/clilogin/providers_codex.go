package clilogin

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
)

func init() {
	providerSpecs["codex"] = providerSpec{
		layout:          codexLoginLayout,
		readCredential:  codexLoginCredential,
		networkProbeURL: "https://auth.openai.com/",
		loginArgs: func(args []string) []string {
			for _, arg := range args {
				if arg == "--device-auth" {
					return args
				}
			}
			return append(args, "--device-auth")
		},
	}
}

// codexLoginLayout 把 CODEX_HOME 指向一次性运行目录，避免写宿主真实登录态。
func codexLoginLayout(_ *providers.Catalog, hostHomeDir, runtimeDir string) (string, map[string]string, error) {
	env := baseEnvironment(hostHomeDir)
	configDir := filepath.Join(runtimeDir, providerroot.ConfigDir("codex"))
	env["HOME"] = runtimeDir
	env["USERPROFILE"] = runtimeDir
	env["CODEX_HOME"] = configDir
	for _, key := range []string{"OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_SQLITE_HOME"} {
		delete(env, key)
	}
	return configDir, env, nil
}

// codexLoginCredential 读取 CLI 写出的 auth.json，包成 nativeaccount 需要的 auth_json 构件。
func codexLoginCredential(configDir string) ([]byte, error) {
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
	return json.Marshal(map[string]json.RawMessage{"auth_json": raw})
}
