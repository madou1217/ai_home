// Package codexgateway reads the local gateway connection used by native Codex.
// Authentication is read on demand, not embedded into generated host config.
package codexgateway

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/application/serverconfig"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

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
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return Connection{}, err
	}
	raw, found, err := appstate.ReadKV(ctx, databasePath, appstate.KeyServerConfig)
	if err != nil {
		return Connection{}, fmt.Errorf("codex_gateway_config_read_failed")
	}
	var config struct {
		Host   string `json:"host"`
		Port   int    `json:"port"`
		APIKey string `json:"apiKey"`
	}
	if found && json.Unmarshal([]byte(raw), &config) != nil {
		return Connection{}, fmt.Errorf("codex_gateway_config_invalid")
	}
	host := serverconfig.NormalizeLoopbackHost(strings.Trim(strings.TrimSpace(config.Host), "[]"))
	// 端口归一与 URL 拼接只在 application/serverconfig 定义一次。
	port := serverconfig.NormalizePort(config.Port)
	key := strings.TrimSpace(config.APIKey)
	if lookupEnv != nil {
		for _, name := range []string{"AIH_GATEWAY_API_KEY", "AIH_SERVER_API_KEY"} {
			if key == "" {
				value, _ := lookupEnv(name)
				key = strings.TrimSpace(value)
			}
		}
	}
	if key == "" {
		key = "dummy"
	}
	if strings.ContainsAny(key, "\r\n\x00") {
		return Connection{}, fmt.Errorf("codex_gateway_key_invalid")
	}
	endpoint := serverconfig.BaseURL(host, port, "/v1")
	return Connection{BaseURL: endpoint, apiKey: key}, nil
}
