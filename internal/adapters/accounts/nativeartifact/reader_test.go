package nativeartifact_test

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeartifact"
)

// TestReadClaudeCombinesOfficialArtifactsAndTrimsGlobalConfig 验证 Claude envelope
// 只携带 Decoder 契约要求的两个字段，并且全局配置只保留官方身份段。
func TestReadClaudeCombinesOfficialArtifactsAndTrimsGlobalConfig(t *testing.T) {
	t.Parallel()

	files := map[string]string{
		"/home/user/.claude/.credentials.json": claudeCredentials("sk-ant-oat01-x", "sk-ant-ort01-x"),
		"/home/user/.claude.json": `{"oauthAccount":{"accountUuid":"123e4567-e89b-12d3-a456-426614174001","emailAddress":"e@x"},` +
			`"projects":{"/tmp":{"history":["机密会话内容"]}},"numStartups":42}`,
	}
	reader := nativeartifact.New(fakeOptions(files, nil))

	artifacts, err := reader.Read("claude")
	if err != nil {
		t.Fatalf("Read(claude) error = %v", err)
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(artifacts.Envelope, &envelope); err != nil {
		t.Fatalf("envelope 不是 JSON 对象: %v", err)
	}
	if len(envelope) != 2 ||
		len(envelope["credentials_json"]) == 0 ||
		len(envelope["global_config_json"]) == 0 {
		t.Fatalf("envelope 顶层字段 = %v", envelope)
	}
	globalConfig := string(envelope["global_config_json"])
	if strings.Contains(globalConfig, "机密会话内容") ||
		strings.Contains(globalConfig, "numStartups") ||
		!strings.Contains(globalConfig, "oauthAccount") {
		t.Fatalf("全局配置未裁剪到身份字段: %s", globalConfig)
	}
	if !strings.Contains(string(envelope["credentials_json"]), "claudeAiOauth") {
		t.Fatalf("凭据 artifact 未原样透传: %s", envelope["credentials_json"])
	}
	expectedSources := []string{
		"/home/user/.claude/.credentials.json",
		"/home/user/.claude.json",
	}
	if len(artifacts.Sources) != len(expectedSources) {
		t.Fatalf("sources = %v", artifacts.Sources)
	}
	for index, source := range expectedSources {
		if artifacts.Sources[index] != source {
			t.Fatalf("sources = %v", artifacts.Sources)
		}
	}
}

// TestReadClaudePrefersConfigDirGlobalConfig 验证官方把全局配置放在 CLAUDE_CONFIG_DIR
// 内时优先使用该文件，而不是回落到用户主目录的同名文件。
func TestReadClaudePrefersConfigDirGlobalConfig(t *testing.T) {
	t.Parallel()

	files := map[string]string{
		"/opt/claude-config/.credentials.json": claudeCredentials("sk-ant-oat01-x", "sk-ant-ort01-x"),
		"/opt/claude-config/.claude.json":      claudeIdentity("123e4567-e89b-12d3-a456-426614174002", "config@example.invalid"),
		"/home/user/.claude.json":              claudeIdentity("123e4567-e89b-12d3-a456-426614174003", "home@example.invalid"),
	}
	reader := nativeartifact.New(fakeOptions(files, map[string]string{
		"CLAUDE_CONFIG_DIR": "/opt/claude-config",
	}))

	artifacts, err := reader.Read("claude")
	if err != nil {
		t.Fatalf("Read(claude) error = %v", err)
	}
	if !strings.Contains(string(artifacts.Envelope), "config@example.invalid") ||
		strings.Contains(string(artifacts.Envelope), "home@example.invalid") {
		t.Fatalf("envelope 使用了错误的全局配置: %s", artifacts.Envelope)
	}
}

// TestReadClaudePrefersOfficialKeychain 验证 macOS secure storage 可读时不会回退
// 到可能过期的 .credentials.json，并且仍与 oauthAccount 原子组合。
func TestReadClaudePrefersOfficialKeychain(t *testing.T) {
	t.Parallel()

	files := map[string]string{
		"/home/user/.claude/.credentials.json": `{"stale":true}`,
		"/home/user/.claude.json":              claudeIdentity("123e4567-e89b-12d3-a456-426614174004", "user@example.invalid"),
	}
	options := fakeOptions(files, nil)
	options.ReadClaudeSecureStorage = func(
		configDir string,
		scoped bool,
	) (nativeartifact.ClaudeSecureStorageRecord, error) {
		if configDir != "/home/user/.claude" || scoped {
			t.Fatalf("config_dir=%q scoped=%v", configDir, scoped)
		}
		return nativeartifact.ClaudeSecureStorageRecord{
			Data:         []byte(claudeCredentials("from-keychain", "keychain-refresh")),
			Source:       "macOS Keychain: Claude Code-credentials",
			ModifiedAtMS: 200,
		}, nil
	}
	artifacts, err := nativeartifact.New(options).Read("claude")
	if err != nil {
		t.Fatalf("Read(claude) error = %v", err)
	}
	if strings.Contains(string(artifacts.Envelope), "stale") ||
		!strings.Contains(string(artifacts.Envelope), "from-keychain") {
		t.Fatalf("envelope 未使用 Keychain: %s", artifacts.Envelope)
	}
	if artifacts.Sources[0] != "macOS Keychain: Claude Code-credentials" {
		t.Fatalf("sources = %v", artifacts.Sources)
	}
}

// TestReadClaudeFallsBackToCompleteFileWhenKeychainIsIncomplete 验证 Keychain
// 残留的半份 OAuth 信封不会遮蔽同一官方配置目录内可用的凭据文件。
func TestReadClaudeFallsBackToCompleteFileWhenKeychainIsIncomplete(t *testing.T) {
	t.Parallel()

	files := map[string]string{
		"/home/user/.claude/.credentials.json": claudeCredentials("from-file", "file-refresh"),
		"/home/user/.claude.json":              claudeIdentity("123e4567-e89b-12d3-a456-426614174005", "current@example.invalid"),
	}
	options := fakeOptions(files, nil)
	options.ReadClaudeSecureStorage = func(string, bool) (nativeartifact.ClaudeSecureStorageRecord, error) {
		return nativeartifact.ClaudeSecureStorageRecord{
			Data:         []byte(`{"claudeAiOauth":{"accessToken":"incomplete-keychain"}}`),
			Source:       "macOS Keychain: Claude Code-credentials",
			ModifiedAtMS: 200,
		}, nil
	}

	artifacts, err := nativeartifact.New(options).Read("claude")
	if err != nil {
		t.Fatalf("Read(claude) error = %v", err)
	}
	if artifacts.Sources[0] != "/home/user/.claude/.credentials.json" ||
		!strings.Contains(string(artifacts.Envelope), "from-file") ||
		strings.Contains(string(artifacts.Envelope), "incomplete-keychain") {
		t.Fatalf("未回退到完整凭据文件: sources=%v", artifacts.Sources)
	}
}

// TestReadClaudeChoosesTheNewerCompleteSource 验证 Keychain 与凭据文件都完整但
// 内容不同时，只采用可由两个来源时间戳证明更新的登录态。
func TestReadClaudeChoosesTheNewerCompleteSource(t *testing.T) {
	t.Parallel()

	credentialsPath := "/home/user/.claude/.credentials.json"
	files := map[string]string{
		credentialsPath:           claudeCredentials("new-file", "new-file-refresh"),
		"/home/user/.claude.json": claudeIdentity("123e4567-e89b-12d3-a456-426614174006", "fresh@example.invalid"),
	}
	options := fakeOptions(files, nil)
	options.ReadClaudeSecureStorage = func(string, bool) (nativeartifact.ClaudeSecureStorageRecord, error) {
		return nativeartifact.ClaudeSecureStorageRecord{
			Data:         []byte(claudeCredentials("old-keychain", "old-keychain-refresh")),
			Source:       "macOS Keychain: Claude Code-credentials",
			ModifiedAtMS: 100,
		}, nil
	}
	options.FileModifiedAt = func(path string) (int64, error) {
		if path != credentialsPath {
			t.Fatalf("FileModifiedAt(%q)", path)
		}
		return 200, nil
	}

	artifacts, err := nativeartifact.New(options).Read("claude")
	if err != nil {
		t.Fatalf("Read(claude) error = %v", err)
	}
	if artifacts.Sources[0] != credentialsPath ||
		!strings.Contains(string(artifacts.Envelope), "new-file") ||
		strings.Contains(string(artifacts.Envelope), "old-keychain") {
		t.Fatalf("没有选择更新的文件凭据: sources=%v", artifacts.Sources)
	}
}

// TestReadClaudeRejectsDifferentSourcesWithoutComparableFreshness 验证两个完整但
// 不同的登录态缺少可比较时间时不会按读取顺序猜测谁更新。
func TestReadClaudeRejectsDifferentSourcesWithoutComparableFreshness(t *testing.T) {
	t.Parallel()

	files := map[string]string{
		"/home/user/.claude/.credentials.json": claudeCredentials("file-token", "file-refresh"),
		"/home/user/.claude.json":              claudeIdentity("123e4567-e89b-12d3-a456-426614174007", "unknown@example.invalid"),
	}
	options := fakeOptions(files, nil)
	options.ReadClaudeSecureStorage = func(string, bool) (nativeartifact.ClaudeSecureStorageRecord, error) {
		return nativeartifact.ClaudeSecureStorageRecord{
			Data:   []byte(claudeCredentials("keychain-token", "keychain-refresh")),
			Source: "macOS Keychain: Claude Code-credentials",
		}, nil
	}
	options.FileModifiedAt = func(string) (int64, error) { return 0, nil }

	artifacts, err := nativeartifact.New(options).Read("claude")
	if !errors.Is(err, nativeartifact.ErrInvalidArtifactSource) {
		t.Fatalf("Read(claude) error = %v", err)
	}
	if artifacts.Envelope != nil || artifacts.Sources != nil {
		t.Fatalf("无法证明新鲜度时不得返回 artifact: %v", artifacts)
	}
}

// TestReadClaudeRejectsNewerCredentialsFromAnotherIdentity 验证来源自身携带的
// 账号 UUID 与当前 oauthAccount 冲突时，不能仅凭时间更新就采纳。
func TestReadClaudeRejectsNewerCredentialsFromAnotherIdentity(t *testing.T) {
	t.Parallel()

	credentialsPath := "/home/user/.claude/.credentials.json"
	currentUUID := "123e4567-e89b-12d3-a456-426614174008"
	files := map[string]string{
		credentialsPath: claudeCredentialsForIdentity(
			"current-file",
			"current-file-refresh",
			currentUUID,
			"current@example.invalid",
		),
		"/home/user/.claude.json": claudeIdentity(currentUUID, "current@example.invalid"),
	}
	options := fakeOptions(files, nil)
	options.ReadClaudeSecureStorage = func(string, bool) (nativeartifact.ClaudeSecureStorageRecord, error) {
		return nativeartifact.ClaudeSecureStorageRecord{
			Data: []byte(claudeCredentialsForIdentity(
				"other-keychain",
				"other-keychain-refresh",
				"123e4567-e89b-12d3-a456-426614174099",
				"other@example.invalid",
			)),
			Source:       "macOS Keychain: Claude Code-credentials",
			ModifiedAtMS: 200,
		}, nil
	}
	options.FileModifiedAt = func(string) (int64, error) { return 100, nil }

	artifacts, err := nativeartifact.New(options).Read("claude")
	if err != nil {
		t.Fatalf("Read(claude) error = %v", err)
	}
	if artifacts.Sources[0] != credentialsPath ||
		!strings.Contains(string(artifacts.Envelope), "current-file") ||
		strings.Contains(string(artifacts.Envelope), "other-keychain") {
		t.Fatalf("采纳了其他身份的 Keychain 凭据: sources=%v", artifacts.Sources)
	}
}

// TestReadCodexUsesCodexHome 验证 Codex envelope 只包含官方 auth.json 单字段。
func TestReadCodexUsesCodexHome(t *testing.T) {
	t.Parallel()

	files := map[string]string{
		"/opt/codex-home/auth.json": `{"OPENAI_API_KEY":null,"tokens":{"id_token":"x"}}`,
	}
	reader := nativeartifact.New(fakeOptions(files, map[string]string{
		"CODEX_HOME": "/opt/codex-home",
	}))

	artifacts, err := reader.Read("codex")
	if err != nil {
		t.Fatalf("Read(codex) error = %v", err)
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(artifacts.Envelope, &envelope); err != nil {
		t.Fatalf("envelope 不是 JSON 对象: %v", err)
	}
	if len(envelope) != 1 || len(envelope["auth_json"]) == 0 {
		t.Fatalf("envelope 顶层字段 = %v", envelope)
	}
	if len(artifacts.Sources) != 1 ||
		artifacts.Sources[0] != "/opt/codex-home/auth.json" {
		t.Fatalf("sources = %v", artifacts.Sources)
	}
}

// TestReadRejectsUnsupportedAndMissingArtifacts 验证缺登录态时给出明确错误，
// 并且错误文本不携带任何文件内容。
func TestReadRejectsUnsupportedAndMissingArtifacts(t *testing.T) {
	t.Parallel()

	secret := "sk-ant-oat01-must-not-leak"
	cases := map[string]struct {
		providerID string
		files      map[string]string
	}{
		"未注册 Provider": {providerID: "gemini"},
		"缺少官方文件":       {providerID: "claude"},
		"全局配置缺少身份": {
			providerID: "claude",
			files: map[string]string{
				"/home/user/.claude/.credentials.json": `{"claudeAiOauth":{"accessToken":"` + secret + `"}}`,
				"/home/user/.claude.json":              `{"numStartups":1}`,
			},
		},
		"凭据不是合法 JSON": {
			providerID: "claude",
			files: map[string]string{
				"/home/user/.claude/.credentials.json": secret,
				"/home/user/.claude.json":              `{"oauthAccount":{"accountUuid":"u"}}`,
			},
		},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			reader := nativeartifact.New(fakeOptions(testCase.files, nil))
			artifacts, err := reader.Read(testCase.providerID)
			if !errors.Is(err, nativeartifact.ErrInvalidArtifactSource) {
				t.Fatalf("Read(%s) error = %v", testCase.providerID, err)
			}
			if artifacts.Envelope != nil || artifacts.Sources != nil {
				t.Fatalf("失败时不得返回 artifact: %v", artifacts)
			}
			if strings.Contains(err.Error(), secret) {
				t.Fatal("错误文本泄露了凭据内容")
			}
		})
	}
}

// fakeOptions 用内存文件表替换真实用户目录，测试永不触碰官方登录态。
func fakeOptions(
	files map[string]string,
	environment map[string]string,
) nativeartifact.Options {
	return nativeartifact.Options{
		LookupEnv: func(name string) (string, bool) {
			value, found := environment[name]
			return value, found
		},
		UserHomeDir: func() (string, error) { return "/home/user", nil },
		ReadFile: func(path string) ([]byte, error) {
			content, found := files[path]
			if !found {
				return nil, os.ErrNotExist
			}
			return []byte(content), nil
		},
		ReadClaudeSecureStorage: func(string, bool) (nativeartifact.ClaudeSecureStorageRecord, error) {
			return nativeartifact.ClaudeSecureStorageRecord{}, errors.New("测试未提供 Keychain 登录态")
		},
		FileModifiedAt: func(string) (int64, error) { return 0, nil },
	}
}

// claudeCredentials 创建不含真实凭据的完整官方 secure storage 文档。
func claudeCredentials(accessToken string, refreshToken string) string {
	return `{"claudeAiOauth":{` +
		`"accessToken":"` + accessToken + `",` +
		`"refreshToken":"` + refreshToken + `",` +
		`"expiresAt":4102444800000,` +
		`"scopes":["user:inference","user:profile"]}}`
}

// claudeCredentialsForIdentity 创建显式携带官方账号字段的完整凭据。
func claudeCredentialsForIdentity(
	accessToken string,
	refreshToken string,
	accountUUID string,
	email string,
) string {
	return strings.TrimSuffix(claudeCredentials(accessToken, refreshToken), "}}") +
		`,"account":{"uuid":"` + accountUUID + `","emailAddress":"` + email + `"}}}`
}

// claudeIdentity 创建导入测试使用的完整官方 oauthAccount 配置。
func claudeIdentity(accountUUID string, email string) string {
	return `{"oauthAccount":{` +
		`"accountUuid":"` + accountUUID + `",` +
		`"emailAddress":"` + email + `"}}`
}
