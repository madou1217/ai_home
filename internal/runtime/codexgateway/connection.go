// Package codexgateway reads the local gateway connection used by native Codex.
// Authentication is read on demand, not embedded into generated host config.
package codexgateway

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/application/serverconfig"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/aihhome"
)

// serverConfig 只保留网关连接需要的字段。
type serverConfig struct {
	Host   string `json:"host"`
	Port   int    `json:"port"`
	APIKey string `json:"apiKey"`
}

// readServerConfig 读取指定 AIH 数据根的 config:server；缺失时 found=false。
func readServerConfig(ctx context.Context, aiHomeDir string) (serverConfig, bool, error) {
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return serverConfig{}, false, err
	}
	raw, found, err := appstate.ReadKV(ctx, databasePath, appstate.KeyServerConfig)
	if err != nil {
		return serverConfig{}, false, fmt.Errorf("codex_gateway_config_read_failed")
	}
	if !found {
		return serverConfig{}, false, nil
	}
	var config serverConfig
	if json.Unmarshal([]byte(raw), &config) != nil {
		return serverConfig{}, false, fmt.Errorf("codex_gateway_config_invalid")
	}
	return config, true, nil
}

// Connection intentionally redacts its credential when formatted.
type Connection struct {
	BaseURL string
	apiKey  string
}

func (connection Connection) APIKey() string { return connection.apiKey }
func (connection Connection) String() string {
	return fmt.Sprintf("codexgateway.Connection{base_url=%s,api_key=<redacted>}", connection.BaseURL)
}
func (connection Connection) GoString() string { return connection.String() }
func (connection Connection) Format(state fmt.State, _ rune) {
	_, _ = state.Write([]byte(connection.String()))
}

// Read preserves the local gateway defaults and explicit API-key environment
// fallback. An account's OPENAI_API_KEY must never override gateway authentication.
func Read(ctx context.Context, aiHomeDir string, lookupEnv func(string) (string, bool)) (Connection, error) {
	if ctx == nil || strings.TrimSpace(aiHomeDir) == "" {
		return Connection{}, fmt.Errorf("codex_gateway_home_required")
	}
	config, found, err := readServerConfig(ctx, aiHomeDir)
	if err != nil {
		return Connection{}, err
	}
	key := ""
	if found {
		key = strings.TrimSpace(config.APIKey)
	}
	if lookupEnv != nil {
		for _, name := range []string{"AIH_GATEWAY_API_KEY", "AIH_SERVER_API_KEY"} {
			if key == "" {
				value, _ := lookupEnv(name)
				key = strings.TrimSpace(value)
			}
		}
	}
	// 账号投影的数据根没有网关配置时回退宿主；与 CLI 的 withLocalGatewayDefaults
	// 使用同一条 aihhome 规则，保证 `aih codex` 启动与 Codex 认证命令取到同一连接。
	if key == "" {
		if hostAIHome := aihhome.ProjectedHostAIHome(aiHomeDir); hostAIHome != "" &&
			filepath.Clean(hostAIHome) != filepath.Clean(aiHomeDir) {
			if hostConfig, hostFound, hostErr := readServerConfig(ctx, hostAIHome); hostErr == nil && hostFound {
				config = hostConfig
				key = strings.TrimSpace(config.APIKey)
			}
		}
	}
	if key == "" {
		key = "dummy"
	}
	host := serverconfig.NormalizeLoopbackHost(strings.Trim(strings.TrimSpace(config.Host), "[]"))
	// 端口归一与 URL 拼接只在 application/serverconfig 定义一次。
	port := serverconfig.NormalizePort(config.Port)
	if strings.ContainsAny(key, "\r\n\x00") {
		return Connection{}, fmt.Errorf("codex_gateway_key_invalid")
	}
	endpoint := serverconfig.BaseURL(host, port, "/v1")
	return Connection{BaseURL: endpoint, apiKey: key}, nil
}
