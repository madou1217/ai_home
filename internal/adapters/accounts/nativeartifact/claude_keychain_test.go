package nativeartifact

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"slices"
	"testing"
	"time"
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

	credentialJSON := completeClaudeKeychainCredentials("synthetic")
	var commands [][]string
	record, err := readClaudeKeychainWith(
		"/Users/test/.claude",
		false,
		"darwin",
		"test-user",
		func(_ context.Context, name string, arguments ...string) ([]byte, error) {
			if name != "security" {
				t.Fatalf("command = %s", name)
			}
			commands = append(commands, append([]string(nil), arguments...))
			if slices.Contains(arguments, "-w") {
				return append([]byte(nil), credentialJSON...), nil
			}
			return []byte(`keychain: "mdat"<timedate>=0x32303236303732343134313031355A00 "20260724141015Z"`), nil
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
	if len(commands) != 2 || !slices.Equal(commands[0], expectedArguments) {
		t.Fatalf("commands = %v", commands)
	}
	if string(record.Data) != string(credentialJSON) ||
		record.Source != "macOS Keychain: "+claudeKeychainService {
		t.Fatalf("source = %q data_length = %d", record.Source, len(record.Data))
	}
	if record.ModifiedAtMS != time.Date(2026, 7, 24, 14, 10, 15, 0, time.UTC).UnixMilli() {
		t.Fatalf("modified_at_ms = %d", record.ModifiedAtMS)
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
	record, err := readClaudeKeychainWith(
		configDir,
		true,
		"darwin",
		"test-user",
		func(_ context.Context, _ string, arguments ...string) ([]byte, error) {
			service := arguments[len(arguments)-1]
			if slices.Contains(arguments, "-w") {
				services = append(services, service)
			}
			if service == scopedService {
				return []byte("not-json"), errors.New("scoped item missing")
			}
			if slices.Contains(arguments, "-w") {
				return completeClaudeKeychainCredentials("default-token"), nil
			}
			return nil, errors.New("metadata unavailable")
		},
	)
	if err != nil {
		t.Fatalf("readClaudeKeychainWith() error = %v", err)
	}
	if !slices.Equal(services, []string{scopedService, claudeKeychainService}) {
		t.Fatalf("services = %v", services)
	}
	if record.Source != "macOS Keychain: "+claudeKeychainService ||
		!slices.Equal(record.Data, completeClaudeKeychainCredentials("default-token")) {
		t.Fatalf("source=%q data=%s", record.Source, record.Data)
	}
}

// TestReadClaudeKeychainRejectsMalformedPayload 验证 Keychain 中的空对象或坏
// JSON 不会被当成成功读取，从而允许上层回退 .credentials.json。
func TestReadClaudeKeychainRejectsMalformedPayload(t *testing.T) {
	t.Parallel()

	invalidPayloads := map[string][]byte{
		"空 OAuth":         []byte(`{"claudeAiOauth":{}}`),
		"仅 Access Token":  []byte(`{"claudeAiOauth":{"accessToken":"access-only"}}`),
		"仅 Refresh Token": []byte(`{"claudeAiOauth":{"refreshToken":"refresh-only"}}`),
	}
	for name, payload := range invalidPayloads {
		name := name
		payload := payload
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			record, err := readClaudeKeychainWith(
				"/Users/test/.claude",
				false,
				"darwin",
				"test-user",
				func(context.Context, string, ...string) ([]byte, error) {
					return append([]byte(nil), payload...), nil
				},
			)
			if !errors.Is(err, errClaudeKeychainUnavailable) ||
				record.Data != nil || record.Source != "" || record.ModifiedAtMS != 0 {
				t.Fatalf("record=%v error=%v", record, err)
			}
		})
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

			record, err := readClaudeKeychainWith(
				"/Users/test/.claude",
				false,
				testCase.goos,
				testCase.username,
				testCase.run,
			)
			if !errors.Is(err, errClaudeKeychainUnavailable) ||
				record.Data != nil || record.Source != "" || record.ModifiedAtMS != 0 {
				t.Fatalf(
					"record=%v error=%v",
					record,
					err,
				)
			}
		})
	}
}

// completeClaudeKeychainCredentials 创建满足正式 secure storage 合同的测试信封。
func completeClaudeKeychainCredentials(accessToken string) []byte {
	return []byte(`{"claudeAiOauth":{` +
		`"accessToken":"` + accessToken + `",` +
		`"refreshToken":"refresh-` + accessToken + `",` +
		`"expiresAt":4102444800000,` +
		`"scopes":["user:inference","user:profile"]}}`)
}
