package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// TestAccountImportPassesProviderAndPrintsPublicResult 验证导入命令把 Provider
// 原样交给账号管理 Host，并且只回显公开账号信息与真实模型目录。
func TestAccountImportPassesProviderAndPrintsPublicResult(t *testing.T) {
	output := &bytes.Buffer{}
	application := &recordingAccountApplication{
		result: aihaccount.ImportResult{
			ProviderID:   "claude",
			CLIAccountID: 3,
			AccountRef:   "claude:11111111-2222-3333-4444-555555555555",
			Email:        "someone@example.com",
			Models:       []string{"claude-opus-4-1", "claude-sonnet-4"},
			Sources:      []string{"/test-user/.claude/.credentials.json", "/test-user/.claude.json"},
		},
	}
	runtime := testCommandRuntime(t, map[string]string{"AIH_HOME": "/test-user/.ai_home"})
	runtime.stdout = output
	runtime.newAccountApp = func(
		_ context.Context,
		options aihaccount.Options,
	) (accountApplication, error) {
		application.options = options
		return application, nil
	}

	if err := run(
		context.Background(),
		[]string{"account", "import", "claude"},
		runtime,
	); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if application.providerID != "claude" ||
		application.options.AIHomeDir != "/test-user/.ai_home" ||
		application.closeCalls != 1 {
		t.Fatalf(
			"provider=%s ai_home=%s close_calls=%d",
			application.providerID,
			application.options.AIHomeDir,
			application.closeCalls,
		)
	}
	rendered := output.String()
	for _, expected := range []string{
		"账号别名   3",
		"claude:11111111-2222-3333-4444-555555555555",
		"someone@example.com",
		"/test-user/.claude/.credentials.json",
		"claude-opus-4-1",
		"claude-sonnet-4",
		"aih claude 3 --model",
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("导入输出缺少 %q: %s", expected, rendered)
		}
	}
}

// TestAccountImportHelpDoesNotOpenDatabase 验证子命令帮助不创建组合根、不读凭据。
func TestAccountImportHelpDoesNotOpenDatabase(t *testing.T) {
	for _, arguments := range [][]string{
		{"account"},
		{"account", "--help"},
		{"account", "import", "--help"},
		{"help", "account"},
	} {
		output := &bytes.Buffer{}
		runtime := testCommandRuntime(t, nil)
		runtime.stdout = output
		runtime.newAccountApp = func(
			context.Context,
			aihaccount.Options,
		) (accountApplication, error) {
			t.Fatalf("帮助不得创建账号管理 App: %v", arguments)
			return nil, nil
		}
		if err := run(context.Background(), arguments, runtime); err != nil {
			t.Fatalf("run(%v) error = %v", arguments, err)
		}
		if !strings.Contains(output.String(), "aih account import") {
			t.Fatalf("run(%v) usage = %q", arguments, output.String())
		}
	}
}

// TestAccountRejectsUnknownSubcommandAndProvider 验证账号命令不猜测意图。
func TestAccountRejectsUnknownSubcommandAndProvider(t *testing.T) {
	for _, arguments := range [][]string{
		{"account", "list"},
		{"account", "import"},
		{"account", "import", "gemini"},
		{"account", "import", "claude", "9"},
	} {
		runtime := testCommandRuntime(t, nil)
		runtime.newAccountApp = func(
			context.Context,
			aihaccount.Options,
		) (accountApplication, error) {
			t.Fatalf("无效账号命令不得创建 App: %v", arguments)
			return nil, nil
		}
		if err := run(context.Background(), arguments, runtime); !errors.Is(err, errInvalidCommand) {
			t.Fatalf("run(%v) error = %v", arguments, err)
		}
	}
}

// TestAccountImportJoinsImportAndCloseErrors 验证导入失败也必须释放数据库资源。
func TestAccountImportJoinsImportAndCloseErrors(t *testing.T) {
	importErr := errors.New("导入失败")
	closeErr := errors.New("关闭失败")
	application := &recordingAccountApplication{importErr: importErr, closeErr: closeErr}
	runtime := testCommandRuntime(t, nil)
	runtime.newAccountApp = func(
		context.Context,
		aihaccount.Options,
	) (accountApplication, error) {
		return application, nil
	}

	err := run(context.Background(), []string{"account", "import", "codex"}, runtime)
	if !errors.Is(err, importErr) ||
		!errors.Is(err, closeErr) ||
		application.closeCalls != 1 {
		t.Fatalf("error = %v close_calls=%d", err, application.closeCalls)
	}
}

// recordingAccountApplication 记录账号命令交给 Host 的原始输入。
type recordingAccountApplication struct {
	options    aihaccount.Options
	providerID string
	result     aihaccount.ImportResult
	importErr  error
	closeErr   error
	closeCalls int
}

// ImportOfficialLogin 保存 Provider 并返回预设结果。
func (application *recordingAccountApplication) ImportOfficialLogin(
	_ context.Context,
	providerID string,
) (aihaccount.ImportResult, error) {
	application.providerID = providerID
	return application.result, application.importErr
}

// Close 记录资源释放并返回预设错误。
func (application *recordingAccountApplication) Close() error {
	application.closeCalls++
	return application.closeErr
}
