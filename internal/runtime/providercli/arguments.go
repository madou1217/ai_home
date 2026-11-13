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
		case "codebuddy", "codebuddycn", "workbuddy", "workbuddycn":
			// CodeBuddy 家族没有能覆盖账号的官方参数：账号边界由投影后的
			// HOME / CODEBUDDY_CONFIG_DIR 决定，参数原样交给官方 CLI。
		case "gemini":
			// Gemini 的账号边界由 GEMINI_CLI_HOME 投影决定；官方参数里没有能
			// 改写凭据目录的开关，原样交给 CLI。
		case "agy":
			// Antigravity 的账号边界由伪 HOME 投影决定（$HOME/.gemini/antigravity-cli），
			// 官方参数没有能覆盖它的开关。
		case "grok":
			// Grok 的账号边界由 GROK_HOME 投影决定，官方参数没有能覆盖它的开关。
		case "cline":
			// Cline 的账号边界由 CLINE_DIR/CLINE_DATA_DIR 投影决定。
		case "kimi":
			// Kimi 的账号边界由 KIMI_CODE_HOME 投影决定。
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
