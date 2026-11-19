package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strconv"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// withClaudeGatewayConfig replaces the legacy Node bootstrap with a read-only
// local config lookup. An explicit remote endpoint never inherits local keys.
func withClaudeGatewayConfig(ctx context.Context, command commandRuntime) (commandRuntime, error) {
	explicit, hasEndpoint := command.lookupEnv("AIH_SERVER_BASE_URL")
	var endpoint *url.URL
	if hasEndpoint {
		parsed, err := url.Parse(explicit)
		if err != nil || parsed.Scheme != "http" || parsed.User != nil ||
			parsed.RawQuery != "" || parsed.Fragment != "" ||
			(parsed.Path != "" && parsed.Path != "/") {
			return command, nil
		}
		host := parsed.Hostname()
		ip := net.ParseIP(host)
		if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return command, nil
		}
		endpoint = parsed
	}
	home, err := resolveAIHomeDir(command)
	if err != nil {
		return command, err
	}
	path, err := appstate.DatabasePath(home)
	if err != nil {
		return command, err
	}
	raw, found, err := appstate.ReadKV(ctx, path, "config:server")
	if err != nil || !found {
		return command, nil
	}
	var config struct {
		Port          int    `json:"port"`
		APIKey        string `json:"apiKey"`
		ManagementKey string `json:"managementKey"`
	}
	if json.Unmarshal([]byte(raw), &config) != nil {
		if hasEndpoint {
			return command, nil
		}
		return command, fmt.Errorf("Claude Gateway 本地 Server 配置无效")
	}
	if config.Port == 0 {
		config.Port = 9527
	}
	if config.Port < 1 || config.Port > 65535 {
		if hasEndpoint {
			return command, nil
		}
		return command, fmt.Errorf("Claude Gateway 本地端口无效")
	}
	base := "http://127.0.0.1:" + strconv.Itoa(config.Port)
	if hasEndpoint {
		port := endpoint.Port()
		if port == "" {
			port = "80"
		}
		if port != strconv.Itoa(config.Port) {
			return command, nil
		}
		base = explicit
	}
	values := map[string]string{
		"AIH_SERVER_BASE_URL":       base,
		"AIH_SERVER_API_KEY":        config.APIKey,
		"AIH_SERVER_MANAGEMENT_KEY": config.ManagementKey,
	}
	original := command.lookupEnv
	command.lookupEnv = func(key string) (string, bool) {
		if value, present := original(key); present {
			return value, true
		}
		value, present := values[key]
		return value, present
	}
	return command, nil
}
