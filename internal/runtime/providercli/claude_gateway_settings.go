package providercli

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/application/providerlaunch"
)

var errClaudeGatewaySettings = errors.New("Claude Gateway 启动设置无效；无法安全隔离宿主认证")

// Claude settings.json env overrides process env. Publish the managed route as
// highest-priority --settings, merging user settings without exposing credentials
// on argv. This private directory lives exactly as long as the foreground CLI.
func prepareClaudeGatewaySettings(args, environment []string) ([]string, func(), error) {
	settings := make(map[string]json.RawMessage)
	forward := make([]string, 0, len(args)+2)
	var suffix []string
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if arg == "--" {
			suffix = args[index:]
			break
		}
		if arg != "--settings" && !strings.HasPrefix(arg, "--settings=") {
			forward = append(forward, arg)
			if providerlaunch.ClaudeOptionRequiresValue(arg) && index+1 < len(args) {
				index++
				forward = append(forward, args[index])
			}
			continue
		}
		value := strings.TrimPrefix(arg, "--settings=")
		if arg == "--settings" {
			index++
			if index >= len(args) {
				return nil, nil, errClaudeGatewaySettings
			}
			value = args[index]
		}
		data := []byte(value)
		if !strings.HasPrefix(strings.TrimSpace(value), "{") {
			file, err := os.Open(value)
			if err != nil {
				return nil, nil, errClaudeGatewaySettings
			}
			data, err = io.ReadAll(io.LimitReader(file, (4<<20)+1))
			_ = file.Close()
			if err != nil || len(data) > 4<<20 {
				return nil, nil, errClaudeGatewaySettings
			}
		}
		var incoming map[string]json.RawMessage
		if json.Unmarshal(data, &incoming) != nil || incoming == nil {
			return nil, nil, errClaudeGatewaySettings
		}
		for key, value := range incoming {
			settings[key] = value
		}
	}
	values := make(map[string]string)
	if raw, exists := settings["env"]; exists && json.Unmarshal(raw, &values) != nil {
		return nil, nil, errClaudeGatewaySettings
	}
	if values == nil {
		values = make(map[string]string)
	}
	managed := []string{
		"ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_UNIX_SOCKET", "CLAUDE_CODE_OAUTH_TOKEN",
		"CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
		"CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
		"CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_DISABLE_ADVISOR_TOOL",
	}
	for _, key := range managed {
		values[key] = ""
	}
	resolved := make(map[string]string, len(environment))
	for _, item := range environment {
		key, value, _ := strings.Cut(item, "=")
		resolved[key] = value
	}
	for _, key := range managed {
		values[key] = resolved[key]
	}
	var err error
	settings["env"], err = json.Marshal(values)
	if err != nil {
		return nil, nil, errClaudeGatewaySettings
	}
	encoded, err := json.Marshal(settings)
	if err != nil {
		return nil, nil, errClaudeGatewaySettings
	}
	directory, err := os.MkdirTemp("", "aih-claude-gateway-")
	if err != nil {
		return nil, nil, errClaudeGatewaySettings
	}
	cleanup := func() { _ = os.RemoveAll(directory) }
	path := filepath.Join(directory, "settings.json")
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		cleanup()
		return nil, nil, errClaudeGatewaySettings
	}
	// Put the managed option first: even a malformed trailing value-taking
	// option cannot swallow it and bypass the gateway's settings isolation.
	forward = append([]string{"--settings", path}, forward...)
	return append(forward, suffix...), cleanup, nil
}
