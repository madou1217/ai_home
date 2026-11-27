package providercli

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/application/providerlaunch"
	"github.com/madou1217/ai_home/application/providerruntime"
)

var (
	errClaudeGatewaySettings = errors.New("Claude Gateway 启动设置无效；无法安全隔离宿主认证")
	errClaudeLaunchSettings  = errors.New("Claude 会话启动设置无效；无法持久化账号路由")
)

// claudeManagedSettingsKeys 列出会改变 Claude Code Provider/认证路由的键。
// 每次生成会话 settings 时都从本次启动的最终环境取值；环境里没有的键写空，
// 防止用户级 settings.json 里的旧凭据或云 Provider 开关混入本账号会话。
var claudeManagedSettingsKeys = []string{
	"ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_UNIX_SOCKET", "CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
	"CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_DISABLE_ADVISOR_TOOL",
}

// prepareClaudeGatewaySettings 为进程内 Gateway/OAuth 代理生成前台专用 settings。
// 代理监听器随前台退出关闭，后台会话无法复用该地址，因此这里保持临时目录语义。
func prepareClaudeGatewaySettings(args, environment []string) ([]string, func(), error) {
	forward, suffix, settings, err := splitClaudeSettingsArguments(args)
	if err != nil {
		return nil, nil, err
	}
	values, err := claudeSettingsEnvironment(settings, environment)
	if err != nil {
		return nil, nil, err
	}
	encoded, err := marshalClaudeSettings(settings, values)
	if err != nil {
		return nil, nil, err
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

// PrepareClaudeLaunchSettings 为原生直连会话发布持久化 settings。
//
// 原生直连把账号凭据放在进程环境里；Claude Code 的 /bg 会把前台移交给 daemon，
// 子进程环境中的 Provider 凭据会被剥离，而后台 worker 又按会话凭据钉选拒绝换号。
// 因此账号路由必须写进会话级 settings 文件：前台与后台 worker 都以同一份
// --settings 启动，文件按“账号 + 非凭据设置”命名并在每次启动时用当前凭据覆盖。
// 文件位于 spacegc 受保护的 claude-launch-settings 目录，不能在前台退出时删除，
// 否则后台恢复会因 “Settings file not found” 直接失败。
func PrepareClaudeLaunchSettings(aiHomeDir string, args, environment []string) ([]string, error) {
	home := strings.TrimSpace(aiHomeDir)
	if home == "" {
		return nil, errClaudeLaunchSettings
	}
	forward, suffix, settings, err := splitClaudeSettingsArguments(args)
	if err != nil {
		return nil, err
	}
	values, err := claudeSettingsEnvironment(settings, environment)
	if err != nil {
		return nil, err
	}
	encoded, err := marshalClaudeSettings(settings, values)
	if err != nil {
		return nil, err
	}
	path, err := writePersistentClaudeSettings(
		filepath.Join(home, "run", "claude-launch-settings"),
		claudeLaunchSettingsName(settings, environment),
		encoded,
	)
	if err != nil {
		return nil, err
	}
	forward = append([]string{"--settings", path}, forward...)
	return append(forward, suffix...), nil
}

// splitClaudeSettingsArguments 提取并合并已有 --settings（文件或内联 JSON），
// 其余参数原样保留；`--` 之后的参数属于被启动命令，不能改写。
func splitClaudeSettingsArguments(
	args []string,
) (
	forward []string,
	suffix []string,
	settings map[string]json.RawMessage,
	err error,
) {
	settings = make(map[string]json.RawMessage)
	forward = make([]string, 0, len(args)+2)
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
				return nil, nil, nil, errClaudeGatewaySettings
			}
			value = args[index]
		}
		data := []byte(value)
		if !strings.HasPrefix(strings.TrimSpace(value), "{") {
			file, openErr := os.Open(value)
			if openErr != nil {
				return nil, nil, nil, errClaudeGatewaySettings
			}
			data, openErr = io.ReadAll(io.LimitReader(file, (4<<20)+1))
			_ = file.Close()
			if openErr != nil || len(data) > 4<<20 {
				return nil, nil, nil, errClaudeGatewaySettings
			}
		}
		var incoming map[string]json.RawMessage
		if json.Unmarshal(data, &incoming) != nil || incoming == nil {
			return nil, nil, nil, errClaudeGatewaySettings
		}
		for key, raw := range incoming {
			settings[key] = raw
		}
	}
	return forward, suffix, settings, nil
}

// claudeSettingsEnvironment 用本次启动的最终环境覆盖 settings.env 的托管键。
func claudeSettingsEnvironment(
	settings map[string]json.RawMessage,
	environment []string,
) (map[string]string, error) {
	values := make(map[string]string)
	if raw, exists := settings["env"]; exists && json.Unmarshal(raw, &values) != nil {
		return nil, errClaudeGatewaySettings
	}
	if values == nil {
		values = make(map[string]string)
	}
	resolved := make(map[string]string, len(environment))
	for _, item := range environment {
		key, value, found := strings.Cut(item, "=")
		if !found {
			continue
		}
		resolved[key] = value
	}
	for _, key := range claudeManagedSettingsKeys {
		values[key] = resolved[key]
	}
	return values, nil
}

// marshalClaudeSettings 输出稳定的 settings JSON；map 键由 encoding/json 排序。
func marshalClaudeSettings(
	settings map[string]json.RawMessage,
	values map[string]string,
) ([]byte, error) {
	encodedEnv, err := json.Marshal(values)
	if err != nil {
		return nil, errClaudeGatewaySettings
	}
	settings["env"] = encodedEnv
	encoded, err := json.Marshal(settings)
	if err != nil {
		return nil, errClaudeGatewaySettings
	}
	return append(encoded, '\n'), nil
}

// claudeLaunchSettingsName 用“账号 + 非凭据设置”生成稳定文件名：
// 同一账号的凭据轮换会覆盖同一文件，后台恢复总能读到当前凭据；
// 不同账号或不同账号级设置则互不覆盖。
func claudeLaunchSettingsName(
	settings map[string]json.RawMessage,
	environment []string,
) string {
	accountRef, _ := environmentValue(environment, providerruntime.ProviderAccountRefEnv)
	base := make(map[string]json.RawMessage, len(settings))
	for key, raw := range settings {
		if key == "env" {
			continue
		}
		base[key] = raw
	}
	encodedBase, err := json.Marshal(base)
	if err != nil {
		encodedBase = []byte("{}")
	}
	digest := sha256.Sum256(append([]byte(accountRef+"\n"), encodedBase...))
	return fmt.Sprintf("claude-launch-%x.json", digest[:8])
}

// writePersistentClaudeSettings 原子写入内容寻址的会话 settings。
// 已存在且内容一致时直接复用，避免每次启动都触碰 mtime。
func writePersistentClaudeSettings(directory, name string, data []byte) (string, error) {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", errClaudeLaunchSettings
	}
	path := filepath.Join(directory, name)
	if existing, readErr := os.ReadFile(path); readErr == nil && bytes.Equal(existing, data) {
		return path, nil
	}
	temporary, err := os.CreateTemp(directory, ".claude-launch-*.tmp")
	if err != nil {
		return "", errClaudeLaunchSettings
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(temporary.Name())
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return "", errClaudeLaunchSettings
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return "", errClaudeLaunchSettings
	}
	if err := temporary.Close(); err != nil {
		return "", errClaudeLaunchSettings
	}
	if err := os.Rename(temporary.Name(), path); err != nil {
		return "", errClaudeLaunchSettings
	}
	cleanup = false
	return path, nil
}
