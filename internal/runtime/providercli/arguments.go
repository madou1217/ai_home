package providercli

import (
	"errors"
	"strings"
)

var (
	// ErrManagedArgumentConflict 表示用户参数试图覆盖 AIH 账号或路由边界。
	ErrManagedArgumentConflict = errors.New("Provider 参数试图覆盖 AIH 账号或路由边界")
)

// validateManagedArguments 拒绝会绕过所选账号、Gateway 或共享状态的官方参数。
func validateManagedArguments(providerID string, arguments []string) error {
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		if strings.ContainsRune(argument, '\x00') {
			return ErrInvalidRunRequest
		}
		switch providerID {
		case "codex":
			switch {
			case argument == "--oss" ||
				argument == "--remote" ||
				strings.HasPrefix(argument, "--remote=") ||
				argument == "--remote-auth-token-env" ||
				strings.HasPrefix(argument, "--remote-auth-token-env=") ||
				argument == "--local-provider" ||
				strings.HasPrefix(argument, "--local-provider="):
				return ErrManagedArgumentConflict
			case argument == "-c" || argument == "--config":
				if index+1 >= len(arguments) || protectedCodexConfig(arguments[index+1]) {
					return ErrManagedArgumentConflict
				}
				index++
			case strings.HasPrefix(argument, "--config="):
				if protectedCodexConfig(strings.TrimPrefix(argument, "--config=")) {
					return ErrManagedArgumentConflict
				}
			}
		case "claude":
			if argument == "--bare" {
				return ErrManagedArgumentConflict
			}
		default:
			return ErrUnsupportedRuntime
		}
	}
	return nil
}

// protectedCodexConfig 只保护账号和上游选择，模型、sandbox 等官方参数仍可使用。
func protectedCodexConfig(value string) bool {
	key, _, found := strings.Cut(value, "=")
	if !found {
		return true
	}
	key = strings.TrimSpace(key)
	return key == "model_provider" ||
		strings.HasPrefix(key, "model_providers.") ||
		key == "chatgpt_base_url" ||
		key == "openai_base_url" ||
		key == "preferred_auth_method" ||
		key == "forced_login_method"
}
