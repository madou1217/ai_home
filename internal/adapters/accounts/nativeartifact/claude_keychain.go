package nativeartifact

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"os/user"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/claude/securestorage"
)

const (
	// claudeKeychainService 是 Claude Code 正式环境 OAuth secure storage 的 service。
	claudeKeychainService = "Claude Code-credentials"
	// claudeKeychainTimeout 限制系统 Keychain 读取，避免锁定状态永久阻塞 CLI。
	claudeKeychainTimeout = 5 * time.Second
)

// errClaudeKeychainUnavailable 表示当前平台或当前用户没有可读的官方 Keychain 登录态。
var errClaudeKeychainUnavailable = errors.New("Claude macOS Keychain 登录态不可读取")

var claudeKeychainModifiedAtPattern = regexp.MustCompile(
	`"mdat"<timedate>=[^\r\n]*"(\d{14})Z"`,
)

// keychainCommand 只抽象 security 子进程输出，供单测验证精确参数而不读取真实 Keychain。
type keychainCommand func(context.Context, string, ...string) ([]byte, error)

// readClaudeKeychain 从 Claude Code 官方 macOS Keychain 槽位读取 secure storage JSON。
//
// 凭据只通过 security 的 stdout 进入内存；命令参数只包含用户名和 service，绝不包含 Token。
func readClaudeKeychain(
	configDir string,
	scoped bool,
) (ClaudeSecureStorageRecord, error) {
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
) (ClaudeSecureStorageRecord, error) {
	if goos != "darwin" || strings.TrimSpace(username) == "" || run == nil {
		return ClaudeSecureStorageRecord{}, errClaudeKeychainUnavailable
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
		metadata, metadataErr := run(
			ctx,
			"security",
			"find-generic-password",
			"-a",
			username,
			"-s",
			service,
		)
		modifiedAtMS := int64(0)
		if metadataErr == nil {
			modifiedAtMS = parseClaudeKeychainModifiedAt(metadata)
		}
		clear(metadata)
		return ClaudeSecureStorageRecord{
			Data:         data,
			Source:       "macOS Keychain: " + service,
			ModifiedAtMS: modifiedAtMS,
		}, nil
	}
	return ClaudeSecureStorageRecord{}, errClaudeKeychainUnavailable
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

// validClaudeKeychainPayload 只接受完整的官方 secure storage OAuth 对象；
// 坏条目必须继续尝试下一个 service 或文件回退，不能阻断正常登录态导入。
func validClaudeKeychainPayload(data []byte) bool {
	if len(data) == 0 || len(data) > maxArtifactFileBytes {
		return false
	}
	_, err := securestorage.Decode(data, securestorage.DecodeOptions{
		Identity: claude.OAuthIdentity{
			AccountUUID: "00000000-0000-4000-8000-000000000001",
		},
	})
	return err == nil
}

// parseClaudeKeychainModifiedAt 从 security 元数据的 mdat 字段读取 UTC 时间。
// 格式不认识时返回零，调用方必须把它视为“新鲜度不可证明”。
func parseClaudeKeychainModifiedAt(metadata []byte) int64 {
	match := claudeKeychainModifiedAtPattern.FindSubmatch(metadata)
	if len(match) != 2 {
		return 0
	}
	parsed, err := time.ParseInLocation("20060102150405", string(match[1]), time.UTC)
	if err != nil {
		return 0
	}
	return parsed.UnixMilli()
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
