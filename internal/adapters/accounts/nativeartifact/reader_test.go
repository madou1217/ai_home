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
		"/home/user/.claude/.credentials.json": `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-x"}}`,
		"/home/user/.claude.json": `{"oauthAccount":{"accountUuid":"u","emailAddress":"e@x"},` +
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
		"/opt/claude-config/.credentials.json": `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-x"}}`,
		"/opt/claude-config/.claude.json":      `{"oauthAccount":{"accountUuid":"in-config-dir"}}`,
		"/home/user/.claude.json":              `{"oauthAccount":{"accountUuid":"in-home"}}`,
	}
	reader := nativeartifact.New(fakeOptions(files, map[string]string{
		"CLAUDE_CONFIG_DIR": "/opt/claude-config",
	}))

	artifacts, err := reader.Read("claude")
	if err != nil {
		t.Fatalf("Read(claude) error = %v", err)
	}
	if !strings.Contains(string(artifacts.Envelope), "in-config-dir") ||
		strings.Contains(string(artifacts.Envelope), "in-home") {
		t.Fatalf("envelope 使用了错误的全局配置: %s", artifacts.Envelope)
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
	}
}
