package providercli

import (
	"errors"
	"strings"
)

var (
	// ErrManagedArgumentConflict 表示用户参数试图覆盖 AIH 账号或路由边界。
	ErrManagedArgumentConflict = errors.New("Provider 参数试图覆盖 AIH 账号或路由边界")
)

// managedArgumentCheck 校验一个参数，返回需要额外跳过的参数个数。
//
// 例如 codex 的 `-c <key=value>` 会消费下一个参数；跳过的值不再做 NUL 检查，
// 与既有行为保持一致。
type managedArgumentCheck func(index int, arguments []string) (int, error)

// managedArgumentChecks 声明每个 Provider 的受管参数边界。
//
// 未登记的 Provider 明确不支持；没有可覆盖账号边界的官方参数的 Provider 使用
// allowManagedArgument，账号隔离由各自的投影环境变量保证：
//
//	codebuddy 家族  HOME / CODEBUDDY_CONFIG_DIR 投影
//	gemini        GEMINI_CLI_HOME 投影
//	agy           伪 HOME（$HOME/.gemini/antigravity-cli）投影
//	grok          GROK_HOME 投影
//	cline         CLINE_DIR / CLINE_DATA_DIR 投影
//	kimi          KIMI_CODE_HOME 投影
//	zcode         HOME / ZCODE_DATA_BASE_DIR 投影
//	qoder 两站    启动参数 --config-dir 指向投影根（providercli 注入）
//	kiro          KIRO_TEST_DB_PATH 指向投影凭据库
//	opencode      XDG_DATA_HOME / bridge 与 OPENCODE_API_KEY
var managedArgumentChecks = map[string]managedArgumentCheck{
	"codex":       checkCodexManagedArgument,
	"claude":      checkClaudeManagedArgument,
	"codebuddy":   allowManagedArgument,
	"codebuddycn": allowManagedArgument,
	"workbuddy":   allowManagedArgument,
	"workbuddycn": allowManagedArgument,
	"gemini":      allowManagedArgument,
	"agy":         allowManagedArgument,
	"grok":        allowManagedArgument,
	"cline":       allowManagedArgument,
	"kimi":        allowManagedArgument,
	"zcode":       allowManagedArgument,
	"qoder":       allowManagedArgument,
	"qodercn":     allowManagedArgument,
	"kiro":        allowManagedArgument,
	"opencode":    allowManagedArgument,
}

// validateManagedArguments 拒绝会绕过所选账号、Gateway 或共享状态的官方参数。
func validateManagedArguments(providerID string, arguments []string) error {
	for index := 0; index < len(arguments); index++ {
		argument := arguments[index]
		if strings.ContainsRune(argument, '\x00') {
			return ErrInvalidRunRequest
		}
		check, found := managedArgumentChecks[providerID]
		if !found {
			return ErrUnsupportedRuntime
		}
		advance, err := check(index, arguments)
		if err != nil {
			return err
		}
		index += advance
	}
	return nil
}

// allowManagedArgument 表示该 Provider 没有能覆盖账号边界的官方参数。
func allowManagedArgument(int, []string) (int, error) {
	return 0, nil
}

// checkCodexManagedArgument 拒绝 codex 的远程/本地上游开关与受保护的 -c 配置。
func checkCodexManagedArgument(index int, arguments []string) (int, error) {
	argument := arguments[index]
	switch {
	case argument == "--oss" ||
		argument == "--remote" ||
		strings.HasPrefix(argument, "--remote=") ||
		argument == "--remote-auth-token-env" ||
		strings.HasPrefix(argument, "--remote-auth-token-env=") ||
		argument == "--local-provider" ||
		strings.HasPrefix(argument, "--local-provider="):
		return 0, ErrManagedArgumentConflict
	case argument == "-c" || argument == "--config":
		if index+1 >= len(arguments) || protectedCodexConfig(arguments[index+1]) {
			return 0, ErrManagedArgumentConflict
		}
		return 1, nil
	case strings.HasPrefix(argument, "--config="):
		if protectedCodexConfig(strings.TrimPrefix(argument, "--config=")) {
			return 0, ErrManagedArgumentConflict
		}
	}
	return 0, nil
}

// checkClaudeManagedArgument 拒绝 claude 绕过登录态的 --bare。
func checkClaudeManagedArgument(index int, arguments []string) (int, error) {
	if arguments[index] == "--bare" {
		return 0, ErrManagedArgumentConflict
	}
	return 0, nil
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
