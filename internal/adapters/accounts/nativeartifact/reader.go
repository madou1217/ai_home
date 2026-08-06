// Package nativeartifact 从官方 CLI 的标准路径读取 Provider 原生认证 artifact。
//
// 该适配器只负责定位并原样读取官方文件，把 nativeaccount.Decoder 约定的 envelope
// 交给上层；它不解析凭据语义、不写回官方文件，也不把文件内容写进错误文本。
package nativeartifact

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// maxArtifactFileBytes 限制单个官方 artifact 文件大小，避免读入异常文件耗尽内存。
const maxArtifactFileBytes = 8 << 20

const (
	// claudeCredentialsFileName 是官方 Claude Code 的 secure storage 文件名。
	claudeCredentialsFileName = ".credentials.json"
	// claudeGlobalConfigFileName 是官方 Claude Code 携带 oauthAccount 的全局配置文件名。
	claudeGlobalConfigFileName = ".claude.json"
	// claudeOAuthAccountKey 是全局配置中唯一与账号身份相关的官方字段。
	claudeOAuthAccountKey = "oauthAccount"
	// codexAuthFileName 是官方 Codex CLI 的认证文件名。
	codexAuthFileName = "auth.json"
)

// ErrInvalidArtifactSource 表示官方 artifact 缺失、超限或结构不符合官方格式。
var ErrInvalidArtifactSource = errors.New("provider 官方 artifact 不可读取")

// Artifacts 是一次官方登录态读取结果。
type Artifacts struct {
	// Envelope 是 nativeaccount.Decoder 约定的顶层 JSON，含明文凭据。
	//
	// 调用方用完必须立即 clear，不得日志化、落盘或写入错误文本。
	Envelope []byte
	// Sources 是本次实际读取的官方文件路径，只用于向用户交代来源。
	Sources []string
}

// sourceStrategy 是单个 Provider 定位并组装官方 artifact envelope 的策略。
type sourceStrategy func(reader *Reader) (Artifacts, error)

// Options 只暴露文件系统与环境边界，供测试注入而不触碰真实用户目录。
type Options struct {
	// LookupEnv 读取 CLAUDE_CONFIG_DIR、CODEX_HOME 等官方环境变量。
	LookupEnv func(string) (string, bool)
	// UserHomeDir 返回当前用户主目录，用于官方默认路径。
	UserHomeDir func() (string, error)
	// ReadFile 读取官方 artifact 文件原始字节。
	ReadFile func(string) ([]byte, error)
}

// Reader 按 Provider 选择官方 artifact 定位策略。
type Reader struct {
	lookupEnv   func(string) (string, bool)
	userHomeDir func() (string, error)
	readFile    func(string) ([]byte, error)
	sources     map[string]sourceStrategy
}

// New 创建绑定真实操作系统边界或测试替身的官方 artifact 读取器。
func New(options Options) *Reader {
	reader := &Reader{
		lookupEnv:   options.LookupEnv,
		userHomeDir: options.UserHomeDir,
		readFile:    options.ReadFile,
	}
	if reader.lookupEnv == nil {
		reader.lookupEnv = os.LookupEnv
	}
	if reader.userHomeDir == nil {
		reader.userHomeDir = os.UserHomeDir
	}
	if reader.readFile == nil {
		reader.readFile = os.ReadFile
	}
	reader.sources = map[string]sourceStrategy{
		"claude": (*Reader).readClaude,
		"codex":  (*Reader).readCodex,
	}
	return reader
}

// Supports 判断 Provider 是否已经登记官方 artifact 定位策略。
func (reader *Reader) Supports(providerID string) bool {
	if reader == nil {
		return false
	}
	_, found := reader.sources[providerID]
	return found
}

// Read 返回该 Provider 官方登录态组装成的 Decoder envelope 和来源路径。
func (reader *Reader) Read(providerID string) (Artifacts, error) {
	if !reader.Supports(providerID) {
		return Artifacts{}, invalidSource("Provider 官方 artifact 策略不存在")
	}
	return reader.sources[providerID](reader)
}

// readClaude 组装官方 secure storage 与全局身份配置的双文件 envelope。
func (reader *Reader) readClaude() (Artifacts, error) {
	configDir, err := reader.claudeConfigDir()
	if err != nil {
		return Artifacts{}, err
	}
	credentialsPath := filepath.Join(configDir, claudeCredentialsFileName)
	credentials, err := reader.readArtifactFile(credentialsPath)
	if err != nil {
		return Artifacts{}, err
	}
	defer clear(credentials)

	globalConfigPath, globalConfig, err := reader.readClaudeGlobalConfig(configDir)
	if err != nil {
		return Artifacts{}, err
	}
	// 官方全局配置还保存历史会话等大量与账号无关的数据，只取身份字段进入 envelope。
	identity, err := extractOAuthAccount(globalConfig)
	if err != nil {
		return Artifacts{}, err
	}
	envelope, err := encodeEnvelope(map[string]json.RawMessage{
		"credentials_json":   json.RawMessage(credentials),
		"global_config_json": identity,
	})
	if err != nil {
		return Artifacts{}, err
	}
	return Artifacts{
		Envelope: envelope,
		Sources:  []string{credentialsPath, globalConfigPath},
	}, nil
}

// readCodex 组装官方 auth.json 单文件 envelope。
func (reader *Reader) readCodex() (Artifacts, error) {
	codexHome, err := reader.codexHomeDir()
	if err != nil {
		return Artifacts{}, err
	}
	authPath := filepath.Join(codexHome, codexAuthFileName)
	auth, err := reader.readArtifactFile(authPath)
	if err != nil {
		return Artifacts{}, err
	}
	defer clear(auth)

	envelope, err := encodeEnvelope(map[string]json.RawMessage{
		"auth_json": json.RawMessage(auth),
	})
	if err != nil {
		return Artifacts{}, err
	}
	return Artifacts{Envelope: envelope, Sources: []string{authPath}}, nil
}

// claudeConfigDir 遵循官方 CLAUDE_CONFIG_DIR，缺省回落到 ~/.claude。
func (reader *Reader) claudeConfigDir() (string, error) {
	if value, found := reader.lookupEnv("CLAUDE_CONFIG_DIR"); found &&
		strings.TrimSpace(value) != "" {
		return filepath.Clean(value), nil
	}
	home, err := reader.homeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude"), nil
}

// readClaudeGlobalConfig 兼容官方两种放置方式：配置目录内优先，其次用户主目录。
func (reader *Reader) readClaudeGlobalConfig(configDir string) (string, []byte, error) {
	candidates := []string{filepath.Join(configDir, claudeGlobalConfigFileName)}
	home, err := reader.homeDir()
	if err != nil {
		return "", nil, err
	}
	if inHome := filepath.Join(home, claudeGlobalConfigFileName); inHome != candidates[0] {
		candidates = append(candidates, inHome)
	}
	for _, candidate := range candidates {
		data, readErr := reader.readArtifactFile(candidate)
		if readErr == nil {
			return candidate, data, nil
		}
	}
	return "", nil, fmt.Errorf(
		"%w: 官方全局配置不可读取 %s",
		ErrInvalidArtifactSource,
		strings.Join(candidates, " 或 "),
	)
}

// codexHomeDir 遵循官方 CODEX_HOME，缺省回落到 ~/.codex。
func (reader *Reader) codexHomeDir() (string, error) {
	if value, found := reader.lookupEnv("CODEX_HOME"); found &&
		strings.TrimSpace(value) != "" {
		return filepath.Clean(value), nil
	}
	home, err := reader.homeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".codex"), nil
}

// homeDir 拒绝空主目录，避免把相对路径当成官方位置。
func (reader *Reader) homeDir() (string, error) {
	home, err := reader.userHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return "", invalidSource("无法确定用户主目录")
	}
	return home, nil
}

// readArtifactFile 有界读取官方文件，错误只携带路径不携带内容。
func (reader *Reader) readArtifactFile(path string) ([]byte, error) {
	data, err := reader.readFile(path)
	if err != nil {
		return nil, fmt.Errorf(
			"%w: 读取官方文件失败 %s",
			ErrInvalidArtifactSource,
			path,
		)
	}
	if len(data) == 0 || len(data) > maxArtifactFileBytes {
		clear(data)
		return nil, fmt.Errorf(
			"%w: 官方文件为空或超过安全上限 %s",
			ErrInvalidArtifactSource,
			path,
		)
	}
	return data, nil
}

// extractOAuthAccount 只保留官方 oauthAccount 字段，返回最小身份配置。
func extractOAuthAccount(globalConfig []byte) (json.RawMessage, error) {
	defer clear(globalConfig)

	var document map[string]json.RawMessage
	if err := json.Unmarshal(globalConfig, &document); err != nil {
		return nil, invalidSource("官方全局配置不是 JSON 对象")
	}
	account, found := document[claudeOAuthAccountKey]
	if !found || len(account) == 0 {
		return nil, invalidSource("官方全局配置缺少 oauthAccount，请先完成 claude 登录")
	}
	identity, err := json.Marshal(map[string]json.RawMessage{
		claudeOAuthAccountKey: account,
	})
	if err != nil {
		return nil, invalidSource("官方身份字段编码失败")
	}
	return identity, nil
}

// encodeEnvelope 按 Decoder 契约编码顶层字段，失败时不回显任何原始内容。
func encodeEnvelope(fields map[string]json.RawMessage) ([]byte, error) {
	envelope, err := json.Marshal(fields)
	if err != nil {
		return nil, invalidSource("官方 artifact 不是合法 JSON")
	}
	return envelope, nil
}

// invalidSource 使用代码内固定原因构造脱敏错误。
func invalidSource(reason string) error {
	return fmt.Errorf("%w: %s", ErrInvalidArtifactSource, reason)
}
