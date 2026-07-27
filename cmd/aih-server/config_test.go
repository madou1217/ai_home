package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"io"
	"net"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/internal/host/aihserver"
)

const configTestManagementKey = "synthetic-config-management-key-2026"

// TestLoadCommandConfigUsesCanonicalDefaults 验证默认地址、数据目录和正式密钥环境名。
func TestLoadCommandConfigUsesCanonicalDefaults(t *testing.T) {
	t.Parallel()

	userHome := t.TempDir()
	runtime := newConfigTestRuntime(
		map[string]string{
			"AIH_SERVER_MANAGEMENT_KEY": configTestManagementKey,
			"AI_HOME":                   "/legacy-must-not-be-used",
		},
		userHome,
	)
	config, err := loadCommandConfig(nil, runtime)
	if err != nil {
		t.Fatalf("loadCommandConfig() error = %v", err)
	}
	if config.host != defaultServerHost ||
		config.port != defaultServerPort ||
		config.aiHomeDir != filepath.Join(userHome, ".ai_home") ||
		config.managementKey != configTestManagementKey {
		t.Fatalf(
			"默认配置错误: host=%q port=%d aiHomeDir=%q",
			config.host,
			config.port,
			config.aiHomeDir,
		)
	}
}

// TestLoadCommandConfigLetsCLIOverrideLoopbackEnvironment 验证显式参数只覆盖监听地址。
func TestLoadCommandConfigLetsCLIOverrideLoopbackEnvironment(t *testing.T) {
	t.Parallel()

	aiHomeDir := t.TempDir()
	runtime := newConfigTestRuntime(
		map[string]string{
			"AIH_HOME":                  aiHomeDir,
			"AIH_SERVER_HOST":           "127.0.0.2",
			"AIH_SERVER_PORT":           "9000",
			"AIH_SERVER_MANAGEMENT_KEY": configTestManagementKey,
		},
		t.TempDir(),
	)
	config, err := loadCommandConfig(
		[]string{"--host", "::1", "--port", "0"},
		runtime,
	)
	if err != nil {
		t.Fatalf("loadCommandConfig() error = %v", err)
	}
	if config.host != "::1" ||
		config.port != 0 ||
		config.aiHomeDir != aiHomeDir {
		t.Fatalf(
			"覆盖后配置错误: host=%q port=%d aiHomeDir=%q",
			config.host,
			config.port,
			config.aiHomeDir,
		)
	}
}

// TestLoadCommandConfigFailsClosed 验证不安全或不明确输入不会静默回退。
func TestLoadCommandConfigFailsClosed(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		env     map[string]string
		args    []string
		wantErr error
	}{
		{
			name:    "missing management key",
			env:     map[string]string{},
			wantErr: aihserver.ErrInvalidManagementKey,
		},
		{
			name: "weak management key",
			env: map[string]string{
				"AIH_SERVER_MANAGEMENT_KEY": "too-short",
			},
			wantErr: aihserver.ErrInvalidManagementKey,
		},
		{
			name: "management key with whitespace",
			env: map[string]string{
				"AIH_SERVER_MANAGEMENT_KEY": "synthetic management key that is long enough",
			},
			wantErr: aihserver.ErrInvalidManagementKey,
		},
		{
			name: "management key with surrounding whitespace",
			env: map[string]string{
				"AIH_SERVER_MANAGEMENT_KEY": " " + configTestManagementKey + " ",
			},
			wantErr: aihserver.ErrInvalidManagementKey,
		},
		{
			name: "wildcard host",
			env: map[string]string{
				"AIH_SERVER_MANAGEMENT_KEY": configTestManagementKey,
			},
			args:    []string{"--host", "0.0.0.0"},
			wantErr: errNonLoopbackHost,
		},
		{
			name: "lan host",
			env: map[string]string{
				"AIH_SERVER_MANAGEMENT_KEY": configTestManagementKey,
			},
			args:    []string{"--host", "192.168.1.10"},
			wantErr: errNonLoopbackHost,
		},
		{
			name: "invalid environment port",
			env: map[string]string{
				"AIH_SERVER_MANAGEMENT_KEY": configTestManagementKey,
				"AIH_SERVER_PORT":           " 9527 ",
			},
			wantErr: errInvalidCommandConfig,
		},
		{
			name: "port too large",
			env: map[string]string{
				"AIH_SERVER_MANAGEMENT_KEY": configTestManagementKey,
			},
			args:    []string{"--port", "65536"},
			wantErr: errInvalidCommandConfig,
		},
		{
			name: "positional argument",
			env: map[string]string{
				"AIH_SERVER_MANAGEMENT_KEY": configTestManagementKey,
			},
			args:    []string{"serve"},
			wantErr: errInvalidCommandConfig,
		},
		{
			name: "management key command flag",
			env: map[string]string{
				"AIH_SERVER_MANAGEMENT_KEY": configTestManagementKey,
			},
			args:    []string{"--management-key", configTestManagementKey},
			wantErr: nil,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			runtime := newConfigTestRuntime(test.env, t.TempDir())
			_, err := loadCommandConfig(test.args, runtime)
			if err == nil {
				t.Fatal("无效配置未被拒绝")
			}
			if test.wantErr != nil && !errors.Is(err, test.wantErr) {
				t.Fatalf("error = %v, want %v", err, test.wantErr)
			}
		})
	}
}

// TestLoadCommandConfigPrintsHelpWithoutManagementKey 验证帮助不会要求或输出密钥。
func TestLoadCommandConfigPrintsHelpWithoutManagementKey(t *testing.T) {
	t.Parallel()

	var output bytes.Buffer
	runtime := newConfigTestRuntime(nil, t.TempDir())
	runtime.stderr = &output
	_, err := loadCommandConfig([]string{"--help"}, runtime)
	if !errors.Is(err, flag.ErrHelp) {
		t.Fatalf("loadCommandConfig(--help) error = %v", err)
	}
	if output.String() == "" ||
		bytes.Contains(output.Bytes(), []byte(configTestManagementKey)) {
		t.Fatalf("帮助输出错误: %q", output.String())
	}
}

// newConfigTestRuntime 创建不访问真实环境的命令运行时。
func newConfigTestRuntime(
	values map[string]string,
	userHome string,
) commandRuntime {
	return commandRuntime{
		lookupEnv: func(name string) (string, bool) {
			value, found := values[name]
			return value, found
		},
		userHomeDir: func() (string, error) {
			return userHome, nil
		},
		listen: func(
			_ context.Context,
			_ string,
			_ string,
		) (net.Listener, error) {
			return nil, errors.New("配置测试不应监听端口")
		},
		stdout: io.Discard,
		stderr: io.Discard,
	}
}
