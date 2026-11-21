package providercli

import (
	"errors"
	"os"
	"os/exec"
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
