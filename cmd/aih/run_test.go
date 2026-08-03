package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/internal/host/aihcli"
)

// TestRunPrintsRootUsageWithoutOpeningDatabase 验证根帮助不创建组合根或读取账号。
func TestRunPrintsRootUsageWithoutOpeningDatabase(t *testing.T) {
	output := &bytes.Buffer{}
	runtime := testCommandRuntime(t, nil)
	runtime.stdout = output
	runtime.newApp = func(context.Context, aihcli.Options) (providerApplication, error) {
		t.Fatal("帮助不得创建 App")
		return nil, nil
	}
	if err := run(context.Background(), nil, runtime); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if !bytes.Contains(output.Bytes(), []byte("Gateway 账号池")) ||
		!bytes.Contains(output.Bytes(), []byte("Native Direct")) ||
		!bytes.Contains(output.Bytes(), []byte("aih codex relay claude 9 --model claude-opus-5")) {
		t.Fatalf("usage = %q", output.String())
	}
}

// TestRunPassesNativeAndGatewayInputsWithoutModeGuessing 验证根命令保持双模式 token 合同。
func TestRunPassesNativeAndGatewayInputsWithoutModeGuessing(t *testing.T) {
	tests := []struct {
		name          string
		arguments     []string
		environment   map[string]string
		wantProvider  string
		wantArguments []string
		wantBaseURL   string
		wantKey       string
	}{
		{
			name:          "Native 无 Server Key",
			arguments:     []string{"codex", "9", "resume", "abc"},
			wantProvider:  "codex",
			wantArguments: []string{"9", "resume", "abc"},
			wantBaseURL:   defaultGatewayBaseURL,
		},
		{
			name:      "Gateway 跨 Provider 固定账号",
			arguments: []string{"codex", "relay", "claude", "9", "--model", "claude-opus-5"},
			environment: map[string]string{
				"AIH_SERVER_CLIENT_KEY": "client-key-with-at-least-thirty-two-characters",
			},
			wantProvider:  "codex",
			wantArguments: []string{"relay", "claude", "9", "--model", "claude-opus-5"},
			wantBaseURL:   defaultGatewayBaseURL,
			wantKey:       "client-key-with-at-least-thirty-two-characters",
		},
		{
			name:      "Gateway 固定账号",
			arguments: []string{"claude", "relay", "7", "--model", "opus"},
			environment: map[string]string{
				"AIH_SERVER_BASE_URL":   "http://127.0.0.1:19527",
				"AIH_SERVER_CLIENT_KEY": "client-key-with-at-least-thirty-two-characters",
			},
			wantProvider:  "claude",
			wantArguments: []string{"relay", "7", "--model", "opus"},
			wantBaseURL:   "http://127.0.0.1:19527",
			wantKey:       "client-key-with-at-least-thirty-two-characters",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			application := &recordingApplication{}
			runtime := testCommandRuntime(t, test.environment)
			runtime.newApp = func(_ context.Context, options aihcli.Options) (providerApplication, error) {
				application.options = options
				return application, nil
			}
			if err := run(context.Background(), test.arguments, runtime); err != nil {
				t.Fatalf("run() error = %v", err)
			}
			if application.providerID != test.wantProvider ||
				!equalStrings(application.arguments, test.wantArguments) ||
				application.gateway.BaseURL != test.wantBaseURL ||
				application.gateway.ClientKey != test.wantKey || application.closeCalls != 1 {
				t.Fatalf("application = %#v", application)
			}
			if application.options.AIHomeDir != filepath.Join("/test-user", ".ai_home") {
				t.Fatalf("AIHomeDir = %q", application.options.AIHomeDir)
			}
		})
	}
}

// TestRunJoinsExecutionAndCloseErrors 验证进程失败时仍释放数据库并保留两类错误。
func TestRunJoinsExecutionAndCloseErrors(t *testing.T) {
	runError := errors.New("run failed")
	closeError := errors.New("close failed")
	application := &recordingApplication{runErr: runError, closeErr: closeError}
	runtime := testCommandRuntime(t, nil)
	runtime.newApp = func(context.Context, aihcli.Options) (providerApplication, error) {
		return application, nil
	}
	err := run(context.Background(), []string{"codex", "9"}, runtime)
	if !errors.Is(err, runError) || !errors.Is(err, closeError) || application.closeCalls != 1 {
		t.Fatalf("run() error = %v, closeCalls=%d", err, application.closeCalls)
	}
}

// recordingApplication 记录根命令交给 Host 的原始双模式输入。
type recordingApplication struct {
	options    aihcli.Options
	providerID string
	arguments  []string
	gateway    aihcli.GatewayConfig
	runErr     error
	closeErr   error
	closeCalls int
}

// Run 保存调用参数并返回预设错误。
func (application *recordingApplication) Run(
	_ context.Context,
	providerID string,
	arguments []string,
	gateway aihcli.GatewayConfig,
) error {
	application.providerID = providerID
	application.arguments = append([]string(nil), arguments...)
	application.gateway = gateway
	return application.runErr
}

// Close 记录资源释放并返回预设错误。
func (application *recordingApplication) Close() error {
	application.closeCalls++
	return application.closeErr
}

// testCommandRuntime 创建不访问真实环境和用户目录的命令边界。
func testCommandRuntime(t *testing.T, environment map[string]string) commandRuntime {
	t.Helper()
	return commandRuntime{
		lookupEnv: func(name string) (string, bool) {
			value, found := environment[name]
			return value, found
		},
		userHomeDir: func() (string, error) { return "/test-user", nil },
		stdin:       bytes.NewReader(nil),
		stdout:      io.Discard,
		stderr:      io.Discard,
		newApp: func(context.Context, aihcli.Options) (providerApplication, error) {
			return &recordingApplication{}, nil
		},
	}
}

// equalStrings 比较 Provider 参数且不修改任一输入。
func equalStrings(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
