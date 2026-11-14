package providercli

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
)

var ErrProviderBinaryNotFound = errors.New("Provider 官方 CLI 不存在")

const codexLegacyHookMarker = "aih-codex-cli-hook"

// binaryResolver 解析官方 CLI，并绕开当前安装中仍存在的旧 AIH Node hook。
type binaryResolver struct {
	lookupEnv func(string) (string, bool)
	lookPath  func(string) (string, error)
}

// Resolve 优先使用显式官方路径，并拒绝执行无法安全绕过的旧 Node Hook。
func (resolver binaryResolver) Resolve(providerID string, binary string) (string, error) {
	overrideName := "AIH_" + strings.ToUpper(providerID) + "_BINARY"
	candidate := binary
	override, hasOverride := resolver.lookupEnv(overrideName)
	if hasOverride {
		if override == "" || override != strings.TrimSpace(override) {
			return "", ErrProviderBinaryNotFound
		}
		candidate = override
	}
	resolved, err := resolver.lookPath(candidate)
	if err != nil {
		if hasOverride {
			return "", err
		}
		return "", errors.Join(ErrProviderBinaryNotFound, err)
	}
	if providerID != "codex" || !hasFileMarker(resolved, codexLegacyHookMarker) {
		return resolved, nil
	}
	return resolveCodexHook(resolved)
}

// hasFileMarker 只读取小段文本头，不会扫描或执行目标文件。
func hasFileMarker(path string, marker string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, 4096))
	return err == nil && strings.Contains(string(content), marker)
}

// defaultBinaryResolver 创建生产环境 PATH 解析器。
func defaultBinaryResolver() binaryResolver {
	return binaryResolver{lookupEnv: os.LookupEnv, lookPath: exec.LookPath}
}

// ResolveBinary 按生产 PATH 策略解析官方 CLI，绕开遗留 Node hook。
func ResolveBinary(providerID string, binary string) (string, error) {
	return defaultBinaryResolver().Resolve(providerID, binary)
}
