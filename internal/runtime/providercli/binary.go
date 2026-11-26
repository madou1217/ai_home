package providercli

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

var ErrProviderBinaryNotFound = errors.New("Provider 官方 CLI 不存在")

// binaryResolver 解析官方 CLI，并绕开当前安装中仍存在的旧 AIH Node hook。
type binaryResolver struct {
	lookupEnv func(string) (string, bool)
	lookPath  func(string) (string, error)
	// discover 用安装器认可的位置补充 PATH（例如 agy 落在 ~/.local/bin）。
	// 为空时保持纯 PATH 解析；Codex 始终使用自己的受管发现策略。
	discover func(providerID, binary string) string
}

// Resolve 优先使用显式官方路径，并拒绝执行无法安全绕过的旧 Node Hook。
func (resolver binaryResolver) Resolve(providerID string, binary string) (string, error) {
	if providerID == "codex" {
		return resolver.resolveCodexBinary(binary, "")
	}
	overrideName := "AIH_" + strings.ToUpper(providerID) + "_BINARY"
	candidate := binary
	override, hasOverride := resolver.lookupEnv(overrideName)
	if hasOverride {
		if override == "" || override != strings.TrimSpace(override) {
			return "", ErrProviderBinaryNotFound
		}
		candidate = override
	}
	if !hasOverride && resolver.discover != nil {
		if discovered := strings.TrimSpace(resolver.discover(providerID, candidate)); discovered != "" {
			return discovered, nil
		}
	}
	resolved, err := resolver.lookPath(candidate)
	if err != nil {
		if hasOverride {
			return "", err
		}
		return "", errors.Join(ErrProviderBinaryNotFound, err)
	}
	return resolved, nil
}

// defaultBinaryResolver 创建生产环境 PATH 解析器。
func defaultBinaryResolver() binaryResolver {
	return binaryResolver{lookupEnv: os.LookupEnv, lookPath: exec.LookPath}
}

// ResolveBinary 解析官方 CLI；Codex 共用 PATH 与常用安装目录的安全发现策略。
func ResolveBinary(providerID string, binary string) (string, error) {
	return defaultBinaryResolver().Resolve(providerID, binary)
}

// ResolveBinaryForHost 在 PATH 之外补充 CodeBuddy 家族的已知安装落点。
// Windows 托管服务的工作目录通常是 C:\Windows\System32，PATH 也不包含
// 用户安装目录；只靠 exec.LookPath 会把 codebuddy 解析成不存在的系统路径。
func ResolveBinaryForHost(providerID, binary, hostHomeDir string) (string, error) {
	resolver := defaultBinaryResolver()
	if isCodeBuddyFamilyProvider(providerID) {
		resolver.discover = func(_, _ string) string {
			return discoverCodeBuddyBinary(hostHomeDir)
		}
	}
	return resolver.Resolve(providerID, binary)
}

func isCodeBuddyFamilyProvider(providerID string) bool {
	switch strings.ToLower(strings.TrimSpace(providerID)) {
	case "codebuddy", "codebuddycn", "workbuddy", "workbuddycn":
		return true
	default:
		return false
	}
}

// discoverCodeBuddyBinary 返回 CodeBuddy 家族官方 CLI 的绝对路径。
// 只做存在性检查，不执行进程；找不到时返回空串，交给 LookPath 兜底。
func discoverCodeBuddyBinary(hostHomeDir string) string {
	home := strings.TrimSpace(hostHomeDir)
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	candidates := make([]string, 0, 10)
	if override := strings.TrimSpace(os.Getenv("AIH_CODEBUDDY_BINARY")); override != "" {
		candidates = append(candidates, override)
	}
	if local := strings.TrimSpace(os.Getenv("LOCALAPPDATA")); local != "" {
		candidates = append(candidates,
			filepath.Join(local, "codebuddy", "bin", "codebuddy.exe"),
			filepath.Join(local, "Programs", "CodeBuddy", "codebuddy.exe"),
		)
	}
	if home != "" {
		candidates = append(candidates,
			filepath.Join(home, ".local", "bin", "codebuddy"),
			filepath.Join(home, ".local", "bin", "codebuddy.exe"),
			filepath.Join(home, ".codebuddy", "bin", "codebuddy.exe"),
		)
	}
	candidates = append(candidates, "/opt/homebrew/bin/codebuddy", "/usr/local/bin/codebuddy")
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}
