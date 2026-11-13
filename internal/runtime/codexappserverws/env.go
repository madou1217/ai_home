package codexappserverws

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/host/aihdefault"
	"github.com/madou1217/ai_home/internal/runtime/codexhooks"
)

const (
	defaultServerHost      = "127.0.0.1"
	defaultServerPort      = 9527
	defaultServerAPIKey    = "dummy"
	defaultCodexAPIBaseURL = "https://api.openai.com/v1"

	providerDefaultCodexKey = "provider:default:codex"
	accountDefaultCodexKey  = "account:default:codex"
	serverConfigKey         = "config:server"
	codexProviderID         = "codex"
)

// AccountStore 为环境变量构建提供可选的 Go 账号与默认关系只读回落端口（当 app-state.db 尚未同步时使用）。
type AccountStore interface {
	GetProviderDefault(ctx context.Context, providerID string) (accountcore.ProviderDefault, error)
	GetCredential(ctx context.Context, accountRef accountcore.AccountRef) (accountapp.Credential, error)
}

// SpawnEnvOptions 配置 Codex app-server 子进程环境变量构造参数。
type SpawnEnvOptions struct {
	AIHomeDir    string
	HostHomeDir  string
	BaseEnv      []string
	AccountStore AccountStore
}

// BuildSpawnEnv 1:1 复刻 Node buildCodexDefaultCliEnv + buildSpawnEnv：
//  1. 检查 AIH_CODEX_FLAGS 中的 managedLaunch=1 一次性托管标记，命中时跳过默认账号/网关注入；
//  2. 读取 provider:default:codex，若为 ".aih-server"（或 "aih-server"），则读取 config:server 注入本地网关环境变量；
//  3. 否则读取 account:default:codex 对应账号凭据（优先读取 app-state.db，未命中时回落到 AccountStore）：
//     - API Key 账号：设置 OPENAI_API_KEY / OPENAI_BASE_URL，清理 AIH_CODEX_GATEWAY_ACCOUNT_REF / AIH_CODEX_REMOTE_AUTH_TOKEN；
//     - OAuth / 其他账号：清理 OPENAI_API_KEY / OPENAI_BASE_URL / AIH_CODEX_GATEWAY_ACCOUNT_REF；
//  4. 叠加 HostHomeDir（HOME、USERPROFILE、CODEX_HOME、CODEX_SQLITE_HOME、XDG_*_HOME）及桌面启动器覆盖；
//  5. 设置 AIH_CODEX_APP_SERVER_PASSTHROUGH=1，并在 AIH_CODEX_FLAGS 中写入 remoteProxy=1。
func BuildSpawnEnv(ctx context.Context, opts SpawnEnvOptions) ([]string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	baseEnv := opts.BaseEnv
	if baseEnv == nil {
		baseEnv = os.Environ()
	}
	envMap := envSliceToMap(baseEnv)

	if err := applyCodexDefaultCliEnv(ctx, envMap, opts); err != nil {
		return nil, err
	}

	homeDir := strings.TrimSpace(opts.HostHomeDir)
	if homeDir != "" {
		codexHome := filepath.Join(homeDir, ".codex")
		envMap["HOME"] = homeDir
		envMap["USERPROFILE"] = homeDir
		envMap["CODEX_HOME"] = codexHome
		envMap["CODEX_SQLITE_HOME"] = codexHome
		envMap["XDG_CONFIG_HOME"] = homeDir
		envMap["XDG_DATA_HOME"] = filepath.Join(homeDir, ".local", "share")
		envMap["XDG_STATE_HOME"] = filepath.Join(homeDir, ".local", "state")
	}

	aiHomeDir := strings.TrimSpace(opts.AIHomeDir)
	if aiHomeDir != "" {
		for k, v := range codexhooks.ReadDesktopLaunchEnv(aiHomeDir) {
			envMap[k] = v
		}
	}

	envMap[codexhooks.CodexAppServerPassthroughEnv] = "1"
	SetCodexFlagInEnv(envMap, "remoteProxy", "1")
	return envMapToSlice(envMap), nil
}

func applyCodexDefaultCliEnv(ctx context.Context, envMap map[string]string, opts SpawnEnvOptions) error {
	if ConsumeCodexManagedLaunch(envMap) {
		return nil
	}

	aiHomeDir := strings.TrimSpace(opts.AIHomeDir)
	if aiHomeDir == "" {
		return nil
	}

	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return err
	}

	if fileExistsRegular(dbPath) {
		profileRaw, ok, err := appstate.ReadKV(ctx, dbPath, providerDefaultCodexKey)
		if err != nil {
			return fmt.Errorf("读取 %s 失败: %w", providerDefaultCodexKey, err)
		}
		if ok {
			var profile string
			if err := json.Unmarshal([]byte(profileRaw), &profile); err == nil {
				trimmedProfile := strings.TrimSpace(profile)
				if trimmedProfile == aihdefault.ServerProfileID || trimmedProfile == "aih-server" {
					cfg, err := readServerConfigFromAppState(ctx, dbPath)
					if err != nil {
						return err
					}
					applyGatewayConnectionEnv(envMap, cfg)
					return nil
				}
			}
		}

		defaultAccountRaw, ok, err := appstate.ReadKV(ctx, dbPath, accountDefaultCodexKey)
		if err != nil {
			return fmt.Errorf("读取 %s 失败: %w", accountDefaultCodexKey, err)
		}
		if ok {
			var accountRef string
			if err := json.Unmarshal([]byte(defaultAccountRaw), &accountRef); err == nil {
				accountRef = strings.TrimSpace(accountRef)
				if accountRef != "" {
					provider, foundProvider, err := appstate.LookupAccountProvider(ctx, dbPath, accountRef)
					if err != nil {
						return fmt.Errorf("查询默认账号 Provider 失败: %w", err)
					}
					if foundProvider && provider == codexProviderID {
						apiKey, baseURL, hasRecord, err := readAppStateCodexCredential(ctx, dbPath, accountRef)
						if err != nil {
							return err
						}
						if !hasRecord && opts.AccountStore != nil {
							apiKey, baseURL, _ = readGoStoreCodexCredential(ctx, opts.AccountStore, accountRef)
						}
						applyAccountCredentialEnv(envMap, apiKey, baseURL)
						return nil
					}
				}
			}
		}
	}

	if opts.AccountStore != nil {
		def, err := opts.AccountStore.GetProviderDefault(ctx, codexProviderID)
		if err == nil && def.AccountRef().IsValid() {
			apiKey, baseURL, _ := readGoStoreCodexCredential(ctx, opts.AccountStore, def.AccountRef().String())
			applyAccountCredentialEnv(envMap, apiKey, baseURL)
		}
	}
	return nil
}

type serverConfigRecord struct {
	Host   string `json:"host"`
	Port   any    `json:"port"`
	APIKey string `json:"apiKey"`
}

func readServerConfigFromAppState(ctx context.Context, dbPath string) (serverConfigRecord, error) {
	raw, ok, err := appstate.ReadKV(ctx, dbPath, serverConfigKey)
	if err != nil {
		return serverConfigRecord{}, fmt.Errorf("读取 %s 失败: %w", serverConfigKey, err)
	}
	if !ok || strings.TrimSpace(raw) == "" {
		return serverConfigRecord{}, nil
	}
	var cfg serverConfigRecord
	_ = json.Unmarshal([]byte(raw), &cfg)
	return cfg, nil
}

func applyGatewayConnectionEnv(envMap map[string]string, cfg serverConfigRecord) {
	baseURL := buildServerBaseURL(cfg.Host, cfg.Port)
	apiKey := strings.TrimSpace(cfg.APIKey)
	if apiKey == "" {
		apiKey = strings.TrimSpace(envMap["AIH_GATEWAY_API_KEY"])
	}
	if apiKey == "" {
		apiKey = strings.TrimSpace(envMap["AIH_SERVER_API_KEY"])
	}
	if apiKey == "" {
		apiKey = defaultServerAPIKey
	}
	envMap["OPENAI_BASE_URL"] = baseURL
	envMap["OPENAI_API_KEY"] = apiKey
	envMap["AIH_CODEX_GATEWAY_ACCOUNT_REF"] = ""
}

func buildServerBaseURL(rawHost string, rawPort any) string {
	host := strings.TrimSpace(rawHost)
	if host == "" || host == "0.0.0.0" {
		host = defaultServerHost
	}
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	port := normalizeServerPort(rawPort)
	return (&url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("%s:%d", host, port),
		Path:   "/v1",
	}).String()
}

func normalizeServerPort(raw any) int {
	switch v := raw.(type) {
	case float64:
		n := int(v)
		if float64(n) == v && n >= 1 && n <= 65535 {
			return n
		}
	case int:
		if v >= 1 && v <= 65535 {
			return v
		}
	case int64:
		if v >= 1 && v <= 65535 {
			return int(v)
		}
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n >= 1 && n <= 65535 {
			return n
		}
	}
	return defaultServerPort
}

func readAppStateCodexCredential(ctx context.Context, dbPath string, accountRef string) (apiKey string, baseURL string, found bool, err error) {
	db, err := appstate.OpenReadOnly(ctx, dbPath)
	if err != nil {
		return "", "", false, fmt.Errorf("打开 app-state.db 失败: %w", err)
	}
	defer func() {
		_ = db.Close()
	}()

	const query = `
		SELECT r.provider, c.env_json
		FROM account_credentials c
		INNER JOIN account_refs r ON r.account_ref = c.account_ref
		WHERE c.account_ref = ?
		LIMIT 1`

	var provider string
	var envJSON string
	scanErr := db.QueryRowContext(ctx, query, accountRef).Scan(&provider, &envJSON)
	if scanErr != nil {
		if errors.Is(scanErr, sql.ErrNoRows) || isMissingSQLiteTableError(scanErr) {
			return "", "", false, nil
		}
		return "", "", false, fmt.Errorf("查询账号凭据失败: %w", scanErr)
	}
	if provider != codexProviderID {
		return "", "", false, nil
	}
	var credEnv map[string]any
	if err := json.Unmarshal([]byte(envJSON), &credEnv); err != nil || credEnv == nil {
		return "", "", true, nil
	}
	if rawKey, ok := credEnv["OPENAI_API_KEY"].(string); ok {
		apiKey = strings.TrimSpace(rawKey)
	}
	if rawBase, ok := credEnv["OPENAI_BASE_URL"].(string); ok {
		baseURL = strings.TrimSpace(rawBase)
	}
	return apiKey, baseURL, true, nil
}

func readGoStoreCodexCredential(ctx context.Context, store AccountStore, rawRef string) (apiKey string, baseURL string, ok bool) {
	if store == nil {
		return "", "", false
	}
	ref, err := accountcore.ParseAccountRef(rawRef)
	if err != nil {
		return "", "", false
	}
	cred, err := store.GetCredential(ctx, ref)
	if err != nil || cred == nil {
		return "", "", false
	}
	if keyAuth, isAPIKey := cred.(*codex.APIKeyAuth); isAPIKey && keyAuth != nil {
		return strings.TrimSpace(keyAuth.APIKey()), strings.TrimSpace(keyAuth.BaseURL()), true
	}
	return "", "", true
}

func applyAccountCredentialEnv(envMap map[string]string, apiKey string, baseURL string) {
	trimmedKey := strings.TrimSpace(apiKey)
	if trimmedKey != "" {
		envMap["OPENAI_API_KEY"] = trimmedKey
		resolvedBase := strings.TrimSpace(baseURL)
		if resolvedBase == "" {
			resolvedBase = defaultCodexAPIBaseURL
		}
		envMap["OPENAI_BASE_URL"] = resolvedBase
		delete(envMap, "AIH_CODEX_GATEWAY_ACCOUNT_REF")
		delete(envMap, "AIH_CODEX_REMOTE_AUTH_TOKEN")
		return
	}
	delete(envMap, "OPENAI_API_KEY")
	delete(envMap, "OPENAI_BASE_URL")
	delete(envMap, "AIH_CODEX_GATEWAY_ACCOUNT_REF")
}

func fileExistsRegular(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func isMissingSQLiteTableError(err error) bool {
	return err != nil && strings.Contains(err.Error(), "no such table")
}

func envSliceToMap(entries []string) map[string]string {
	out := make(map[string]string, len(entries))
	for _, entry := range entries {
		key, val, ok := strings.Cut(entry, "=")
		if !ok || key == "" {
			continue
		}
		out[key] = val
	}
	return out
}

func envMapToSlice(envMap map[string]string) []string {
	keys := make([]string, 0, len(envMap))
	for k := range envMap {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+envMap[k])
	}
	return out
}
