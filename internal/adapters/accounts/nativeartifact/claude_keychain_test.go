package nativeartifact

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"slices"
	"testing"
)

// TestBuildClaudeKeychainServiceMatchesOfficialAddressing 验证默认目录与显式
// CLAUDE_CONFIG_DIR 使用 Claude Code 源码定义的两种 service 名称。
func TestBuildClaudeKeychainServiceMatchesOfficialAddressing(t *testing.T) {
	t.Parallel()

	if actual := buildClaudeKeychainService("/Users/test/.claude", false); actual != claudeKeychainService {
		t.Fatalf("default service = %q", actual)
	}
	configDir := "/tmp/claude-login"
	sum := sha256.Sum256([]byte(configDir))
	expected := claudeKeychainService + "-" + hex.EncodeToString(sum[:])[:8]
	if actual := buildClaudeKeychainService(configDir, true); actual != expected {
		t.Fatalf("scoped service = %q, want %q", actual, expected)
	}
}

// TestReadClaudeKeychainUsesExactOfficialLookup 验证 security 参数只携带官方
// account/service 寻址，不把凭据放进 argv。
func TestReadClaudeKeychainUsesExactOfficialLookup(t *testing.T) {
	t.Parallel()

	credentialJSON := []byte(`{"claudeAiOauth":{"accessToken":"synthetic"}}`)
	var commandName string
	var commandArguments []string
	data, source, err := readClaudeKeychainWith(
		"/Users/test/.claude",
		false,
		"darwin",
		"test-user",
		func(_ context.Context, name string, arguments ...string) ([]byte, error) {
			commandName = name
			commandArguments = append([]string(nil), arguments...)
			return append([]byte(nil), credentialJSON...), nil
		},
	)
	if err != nil {
		t.Fatalf("readClaudeKeychainWith() error = %v", err)
	}
	expectedArguments := []string{
		"find-generic-password",
		"-a",
		"test-user",
		"-w",
		"-s",
		claudeKeychainService,
	}
	if commandName != "security" || !slices.Equal(commandArguments, expectedArguments) {
		t.Fatalf("command = %s %v", commandName, commandArguments)
	}
	if string(data) != string(credentialJSON) || source != "macOS Keychain: "+claudeKeychainService {
		t.Fatalf("source = %q data_length = %d", source, len(data))
	}
}

// TestReadClaudeKeychainFallsBackToDefaultService 验证显式配置目录下 scoped
// service 缺失时会按 Claude Code 源码回退默认 service。
func TestReadClaudeKeychainFallsBackToDefaultService(t *testing.T) {
	t.Parallel()

	configDir := "/tmp/claude-login"
	sum := sha256.Sum256([]byte(configDir))
	scopedService := claudeKeychainService + "-" + hex.EncodeToString(sum[:])[:8]
	var services []string
	data, source, err := readClaudeKeychainWith(
		configDir,
		true,
		"darwin",
		"test-user",
		func(_ context.Context, _ string, arguments ...string) ([]byte, error) {
			services = append(services, arguments[len(arguments)-1])
			if services[len(services)-1] == scopedService {
				return []byte("not-json"), errors.New("scoped item missing")
			}
			return []byte(`{"claudeAiOauth":{"accessToken":"default-token"}}`), nil
		},
	)
	if err != nil {
		t.Fatalf("readClaudeKeychainWith() error = %v", err)
	}
	if !slices.Equal(services, []string{scopedService, claudeKeychainService}) {
		t.Fatalf("services = %v", services)
	}
	if source != "macOS Keychain: "+claudeKeychainService ||
		!slices.Equal(data, []byte(`{"claudeAiOauth":{"accessToken":"default-token"}}`)) {
		t.Fatalf("source=%q data=%s", source, data)
	}
}

// TestReadClaudeKeychainRejectsMalformedPayload 验证 Keychain 中的空对象或坏
// JSON 不会被当成成功读取，从而允许上层回退 .credentials.json。
func TestReadClaudeKeychainRejectsMalformedPayload(t *testing.T) {
	t.Parallel()

	data, source, err := readClaudeKeychainWith(
		"/Users/test/.claude",
		false,
		"darwin",
		"test-user",
		func(context.Context, string, ...string) ([]byte, error) {
			return []byte(`{"claudeAiOauth":{}}`), nil
		},
	)
	if !errors.Is(err, errClaudeKeychainUnavailable) || data != nil || source != "" {
		t.Fatalf("data=%v source=%q error=%v", data, source, err)
	}
}

// TestReadClaudeKeychainFailsClosed 验证非 macOS、空用户和 security 失败均不返回内容。
func TestReadClaudeKeychainFailsClosed(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		goos     string
		username string
		run      keychainCommand
	}{
		{name: "非 macOS", goos: "linux", username: "test-user"},
		{name: "空用户", goos: "darwin"},
		{
			name:     "security 失败",
			goos:     "darwin",
			username: "test-user",
			run: func(context.Context, string, ...string) ([]byte, error) {
				return []byte("must-be-cleared"), errors.New("synthetic failure")
			},
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			data, source, err := readClaudeKeychainWith(
				"/Users/test/.claude",
				false,
				testCase.goos,
				testCase.username,
				testCase.run,
			)
			if !errors.Is(err, errClaudeKeychainUnavailable) || data != nil || source != "" {
				t.Fatalf("data=%v source=%q error=%v", data, source, err)
			}
		})
	}
}
