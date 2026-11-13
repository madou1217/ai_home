package hostsync

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/accounts/zcodecred"
)

// syncClineHost 把账号的 cline 槽位合并进宿主 providers.json。
//
// providers.json 是整库文档（还装着 anthropic/openrouter 等其它 Provider 的密钥），
// 不能整文件覆盖；只替换 cline / cline-pass 两个槽位，其余原样保留。
func syncClineHost(payload []byte, hostHomeDir string) (Result, error) {
	var document struct {
		Auth json.RawMessage `json:"auth"`
	}
	if err := json.Unmarshal(payload, &document); err != nil || len(document.Auth) == 0 {
		return Result{}, ErrMissingCredential
	}
	account := map[string]any{}
	if err := json.Unmarshal(document.Auth, &account); err != nil {
		return Result{}, ErrMissingCredential
	}
	accountProviders, _ := account["providers"].(map[string]any)
	if accountProviders == nil {
		return Result{}, ErrMissingCredential
	}
	target := filepath.Join(hostHomeDir, ".cline", "data", "settings", "providers.json")
	host := map[string]any{}
	if raw, err := os.ReadFile(target); err == nil && json.Valid(raw) {
		if json.Unmarshal(raw, &host) != nil {
			host = map[string]any{}
		}
	}
	hostProviders, _ := host["providers"].(map[string]any)
	if hostProviders == nil {
		hostProviders = map[string]any{}
	}
	for _, slot := range []string{"cline", "cline-pass"} {
		if value, exists := accountProviders[slot]; exists {
			hostProviders[slot] = value
		} else {
			delete(hostProviders, slot)
		}
	}
	host["providers"] = hostProviders
	lastUsed, _ := account["lastUsedProvider"].(string)
	if lastUsed != "cline" && lastUsed != "cline-pass" {
		if _, exists := hostProviders["cline-pass"]; exists {
			lastUsed = "cline-pass"
		} else {
			lastUsed = "cline"
		}
	}
	host["lastUsedProvider"] = lastUsed
	if version, exists := account["version"]; exists {
		host["version"] = version
	} else if _, exists := host["version"]; !exists {
		host["version"] = 1
	}
	if modes, exists := account["modes"]; exists {
		host["modes"] = modes
	}
	encoded, err := json.MarshalIndent(host, "", "  ")
	if err != nil {
		return Result{}, err
	}
	encoded = append(encoded, '\n')
	if err := writeFileAtomic(target, encoded); err != nil {
		return Result{}, err
	}
	return Result{Files: []string{target}}, nil
}

// syncZcodeHost 把账号凭据写回宿主 ~/.zcode/v2，并按宿主 HOME 重新加密。
//
// 账号库里的 zcode 凭据是明文（Go decoder 不接受密文）；宿主 CLI 的凭据库是
// enc:v1 密文，密钥由宿主 HOME 派生，所以这里必须逐值加密后再写。
func syncZcodeHost(payload []byte, hostHomeDir string) (Result, error) {
	var document struct {
		Credentials map[string]any  `json:"credentials"`
		Config      json.RawMessage `json:"config"`
	}
	if err := json.Unmarshal(payload, &document); err != nil || len(document.Credentials) == 0 {
		return Result{}, ErrMissingCredential
	}
	secret := zcodeHostSecret(hostHomeDir)
	if secret == "" {
		return Result{}, ErrMissingCredential
	}
	credentials := make(map[string]any, len(document.Credentials))
	for key, value := range document.Credentials {
		if text, ok := value.(string); ok && text != "" && !zcodecred.IsEncrypted(text) {
			encrypted, err := zcodecred.EncryptValue(text, secret)
			if err != nil {
				return Result{}, err
			}
			credentials[key] = encrypted
			continue
		}
		credentials[key] = value
	}
	root := filepath.Join(hostHomeDir, ".zcode", "v2")
	credentialsPath := filepath.Join(root, "credentials.json")
	encoded, err := json.MarshalIndent(credentials, "", "  ")
	if err != nil {
		return Result{}, err
	}
	if err := writeFileAtomic(credentialsPath, append(encoded, '\n')); err != nil {
		return Result{}, err
	}
	files := []string{credentialsPath}
	if len(document.Config) > 0 {
		configPath := filepath.Join(root, "config.json")
		if err := writeFileAtomic(configPath, document.Config); err != nil {
			return Result{}, err
		}
		files = append(files, configPath)
	}
	return Result{Files: files}, nil
}

// zcodeHostSecret 按宿主 HOME 派生 zcode 凭据密钥（与 CLI 的 fallback 同公式）。
func zcodeHostSecret(hostHomeDir string) string {
	platform := runtime.GOOS
	if platform == "windows" {
		platform = "win32"
	}
	username := os.Getenv("USER")
	if username == "" {
		username = os.Getenv("USERNAME")
	}
	if strings.TrimSpace(hostHomeDir) == "" {
		return ""
	}
	return zcodecred.ResolveSecret(os.Getenv(zcodecred.SecretEnv), platform, hostHomeDir, username)
}
