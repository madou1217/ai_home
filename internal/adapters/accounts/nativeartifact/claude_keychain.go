package nativeartifact

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"os/user"
	"runtime"
	"strings"
	"time"
)

const (
	// claudeKeychainService 是 Claude Code 正式环境 OAuth secure storage 的 service。
	claudeKeychainService = "Claude Code-credentials"
	// claudeKeychainTimeout 限制系统 Keychain 读取，避免锁定状态永久阻塞 CLI。
	claudeKeychainTimeout = 5 * time.Second
)

// errClaudeKeychainUnavailable 表示当前平台或当前用户没有可读的官方 Keychain 登录态。
var errClaudeKeychainUnavailable = errors.New("Claude macOS Keychain 登录态不可读取")

// keychainCommand 只抽象 security 子进程输出，供单测验证精确参数而不读取真实 Keychain。
type keychainCommand func(context.Context, string, ...string) ([]byte, error)

// readClaudeKeychain 从 Claude Code 官方 macOS Keychain 槽位读取 secure storage JSON。
//
// 凭据只通过 security 的 stdout 进入内存；命令参数只包含用户名和 service，绝不包含 Token。
func readClaudeKeychain(configDir string, scoped bool) ([]byte, string, error) {
	username := resolveClaudeKeychainUsername()
	return readClaudeKeychainWith(
		configDir,
		scoped,
		runtime.GOOS,
		username,
		func(ctx context.Context, name string, arguments ...string) ([]byte, error) {
			return exec.CommandContext(ctx, name, arguments...).Output()
		},
	)
}

// readClaudeKeychainWith 承载可验证的平台、寻址、超时和输出上限不变量。
func readClaudeKeychainWith(
	configDir string,
	scoped bool,
	goos string,
	username string,
	run keychainCommand,
) ([]byte, string, error) {
	if goos != "darwin" || strings.TrimSpace(username) == "" || run == nil {
		return nil, "", errClaudeKeychainUnavailable
	}
	ctx, cancel := context.WithTimeout(context.Background(), claudeKeychainTimeout)
	defer cancel()

	for _, service := range claudeKeychainServices(configDir, scoped) {
		data, err := run(
			ctx,
			"security",
			"find-generic-password",
			"-a",
			username,
			"-w",
			"-s",
			service,
		)
		if err != nil || !validClaudeKeychainPayload(data) {
			clear(data)
			continue
		}
		return data, "macOS Keychain: " + service, nil
	}
	return nil, "", errClaudeKeychainUnavailable
}

// claudeKeychainServices 与官方 Claude Code 的读取顺序一致：显式配置目录
// 先读 scoped service，再回退默认 service；未显式配置时只读默认 service。
func claudeKeychainServices(configDir string, scoped bool) []string {
	defaultService := claudeKeychainService
	if !scoped {
		return []string{defaultService}
	}
	scopedService := buildClaudeKeychainService(configDir, true)
	if scopedService == defaultService {
		return []string{defaultService}
	}
	return []string{scopedService, defaultService}
}

// validClaudeKeychainPayload 只接受官方 secure storage 中含 OAuth token 的对象；
// 坏条目必须继续尝试下一个 service 或文件回退，不能阻断正常登录态导入。
func validClaudeKeychainPayload(data []byte) bool {
	if len(data) == 0 || len(data) > maxArtifactFileBytes {
		return false
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(data, &document); err != nil || document == nil {
		return false
	}
	var oauth map[string]json.RawMessage
	for _, key := range []string{"claudeAiOauth", "claude_ai_oauth"} {
		if raw, found := document[key]; found && json.Unmarshal(raw, &oauth) == nil && oauth != nil {
			for _, tokenKey := range []string{
				"accessToken", "access_token", "refreshToken", "refresh_token",
			} {
				var token string
				if json.Unmarshal(oauth[tokenKey], &token) == nil && strings.TrimSpace(token) != "" {
					return true
				}
			}
		}
	}
	return false
}

// buildClaudeKeychainService 复现 Claude Code 当前源码的 service 寻址规则。
func buildClaudeKeychainService(configDir string, scoped bool) string {
	if !scoped {
		return claudeKeychainService
	}
	sum := sha256.Sum256([]byte(configDir))
	return claudeKeychainService + "-" + hex.EncodeToString(sum[:])[:8]
}

// resolveClaudeKeychainUsername 复现 Claude Code 的 USER -> 系统用户 -> 固定兜底顺序。
func resolveClaudeKeychainUsername() string {
	if value := strings.TrimSpace(os.Getenv("USER")); value != "" {
		return value
	}
	if current, err := user.Current(); err == nil {
		if value := strings.TrimSpace(current.Username); value != "" {
			return value
		}
	}
	return "claude-code-user"
}
