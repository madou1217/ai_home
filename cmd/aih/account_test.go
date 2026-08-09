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

// TestAccountListPassesStablePageAndPrintsPublicRows 验证账号列表只把稳定游标
// 和有界页大小交给 Host，并且输出不包含任何凭据内容。
func TestAccountListPassesStablePageAndPrintsPublicRows(t *testing.T) {
	output := &bytes.Buffer{}
	application := &recordingAccountApplication{
		listResult: aihaccount.ListResult{
			Accounts: []aihaccount.AccountView{
				{
					ProviderID:       "claude",
					CLIAccountID:     9,
					AccountRef:       "acct_11111111111111111111",
					Enabled:          true,
					HasCredential:    true,
					AuthKind:         "oauth",
					AuthMode:         "subscription",
					Email:            "someone@example.com",
					SubscriptionKind: "plus",
				},
			},
			Limit:        20,
			HasMore:      true,
			NextAfterRef: "acct_11111111111111111111",
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
		[]string{
			"account",
			"list",
			"--limit",
			"20",
			"--after",
			"acct_00000000000000000000",
		},
		runtime,
	); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if application.listOptions.AfterRef != "acct_00000000000000000000" ||
		application.listOptions.Limit != 20 ||
		application.options.AIHomeDir != "/test-user/.ai_home" ||
		application.closeCalls != 1 {
		t.Fatalf(
			"list_options=%+v ai_home=%s close_calls=%d",
			application.listOptions,
			application.options.AIHomeDir,
			application.closeCalls,
		)
	}
	rendered := output.String()
	for _, expected := range []string{
		"claude",
		"9",
		"oauth/subscription",
		"plus",
		"someone@example.com",
		"aih account list --limit 20 --after acct_11111111111111111111",
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("账号列表输出缺少 %q: %s", expected, rendered)
		}
	}
}

// TestAccountShowPassesExplicitTargetAndPrintsPublicDetail 验证详情命令支持
// Provider 数字别名，并且只输出账号管理公开投影。
func TestAccountShowPassesExplicitTargetAndPrintsPublicDetail(t *testing.T) {
	output := &bytes.Buffer{}
	application := &recordingAccountApplication{
		showResult: aihaccount.AccountView{
			ProviderID:       "claude",
			CLIAccountID:     9,
			AccountRef:       "acct_11111111111111111111",
			Enabled:          false,
			HasCredential:    true,
			AuthKind:         "oauth",
			AuthMode:         "refreshable",
			HasProfile:       true,
			DisplayName:      "测试账号",
			Email:            "someone@example.com",
			SubscriptionKind: "max",
			SubscriptionRaw:  "max_20x",
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
		[]string{"account", "show", "claude:9"},
		runtime,
	); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if application.showTarget.ProviderID != "claude" ||
		application.showTarget.CLIAccountID != 9 ||
		application.options.AIHomeDir != "/test-user/.ai_home" ||
		application.closeCalls != 1 {
		t.Fatalf(
			"show_target=%+v ai_home=%s close_calls=%d",
			application.showTarget,
			application.options.AIHomeDir,
			application.closeCalls,
		)
	}
	rendered := output.String()
	for _, expected := range []string{
		"账号详情:",
		"claude",
		"disabled",
		"oauth/refreshable",
		"测试账号",
		"someone@example.com",
		"max",
		"max_20x",
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("账号详情输出缺少 %q: %s", expected, rendered)
		}
	}
}

// TestAccountImportHelpDoesNotOpenDatabase 验证子命令帮助不创建组合根、不读凭据。
func TestAccountImportHelpDoesNotOpenDatabase(t *testing.T) {
	for _, arguments := range [][]string{
		{"account"},
		{"account", "--help"},
		{"account", "import", "--help"},
		{"account", "list", "--help"},
		{"account", "show", "--help"},
		{"account", "models"},
		{"account", "models", "--help"},
		{"account", "models", "list", "--help"},
		{"account", "models", "refresh", "--help"},
		{"account", "models", "set-policy", "--help"},
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
		if !strings.Contains(output.String(), "aih account") {
			t.Fatalf("run(%v) usage = %q", arguments, output.String())
		}
	}
}

// TestAccountRejectsUnknownSubcommandAndProvider 验证账号命令不猜测意图。
func TestAccountRejectsUnknownSubcommandAndProvider(t *testing.T) {
	for _, arguments := range [][]string{
		{"account", "remove"},
		{"account", "import"},
		{"account", "import", "gemini"},
		{"account", "import", "claude", "9"},
		{"account", "list", "--limit"},
		{"account", "list", "--limit", "0"},
		{"account", "list", "--limit", "10", "--limit", "20"},
		{"account", "list", "--after", ""},
		{"account", "list", "--unknown", "value"},
		{"account", "show"},
		{"account", "show", "claude:01"},
		{"account", "show", "claude:1", "extra"},
		{"account", "models", "remove", "claude:1"},
		{"account", "models", "list"},
		{"account", "models", "list", "claude:01"},
		{"account", "models", "list", "claude:1", "extra"},
		{"account", "models", "refresh"},
		{"account", "models", "refresh", "claude:01"},
		{"account", "models", "refresh", "claude:1", "extra"},
		{"account", "models", "set-policy"},
		{"account", "models", "set-policy", "claude:1"},
		{"account", "models", "set-policy", "claude:01", "claude-opus-5", "inherit"},
		{"account", "models", "set-policy", "claude:1", "bad model", "inherit"},
		{"account", "models", "set-policy", "claude:1", "claude-opus-5", "unknown"},
		{"account", "models", "set-policy", "claude:1", "claude-opus-5", "inherit", "extra"},
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

// TestAccountListJoinsListAndCloseErrors 验证列表失败也必须释放数据库资源，
// 并且调用方可以分别识别查询错误和关闭错误。
func TestAccountListJoinsListAndCloseErrors(t *testing.T) {
	listErr := errors.New("列表失败")
	closeErr := errors.New("关闭失败")
	application := &recordingAccountApplication{listErr: listErr, closeErr: closeErr}
	runtime := testCommandRuntime(t, nil)
	runtime.newAccountApp = func(
		context.Context,
		aihaccount.Options,
	) (accountApplication, error) {
		return application, nil
	}

	err := run(context.Background(), []string{"account", "list"}, runtime)
	if !errors.Is(err, listErr) ||
		!errors.Is(err, closeErr) ||
		application.closeCalls != 1 {
		t.Fatalf("error = %v close_calls=%d", err, application.closeCalls)
	}
}

// TestAccountShowJoinsShowAndCloseErrors 验证详情读取失败也必须释放数据库资源。
func TestAccountShowJoinsShowAndCloseErrors(t *testing.T) {
	showErr := errors.New("详情失败")
	closeErr := errors.New("关闭失败")
	application := &recordingAccountApplication{showErr: showErr, closeErr: closeErr}
	runtime := testCommandRuntime(t, nil)
	runtime.newAccountApp = func(
		context.Context,
		aihaccount.Options,
	) (accountApplication, error) {
		return application, nil
	}

	err := run(context.Background(), []string{"account", "show", "claude:1"}, runtime)
	if !errors.Is(err, showErr) ||
		!errors.Is(err, closeErr) ||
		application.closeCalls != 1 {
		t.Fatalf("error = %v close_calls=%d", err, application.closeCalls)
	}
}

// recordingAccountApplication 记录账号命令交给 Host 的原始输入。
type recordingAccountApplication struct {
	options       aihaccount.Options
	providerID    string
	result        aihaccount.ImportResult
	importErr     error
	listOptions   aihaccount.ListOptions
	listResult    aihaccount.ListResult
	listErr       error
	showTarget    aihaccount.AccountTarget
	showResult    aihaccount.AccountView
	showErr       error
	modelsTarget  aihaccount.AccountTarget
	modelsResult  aihaccount.AccountModelsResult
	modelsErr     error
	refreshTarget aihaccount.AccountTarget
	refreshResult aihaccount.AccountModelsResult
	refreshErr    error
	policyCommand aihaccount.AccountModelPolicyCommand
	policyResult  aihaccount.AccountModelsResult
	policyErr     error
	closeErr      error
	closeCalls    int
}

// ImportOfficialLogin 保存 Provider 并返回预设结果。
func (application *recordingAccountApplication) ImportOfficialLogin(
	_ context.Context,
	providerID string,
) (aihaccount.ImportResult, error) {
	application.providerID = providerID
	return application.result, application.importErr
}

// ListAccounts 保存分页输入并返回预设公开账号列表。
func (application *recordingAccountApplication) ListAccounts(
	_ context.Context,
	options aihaccount.ListOptions,
) (aihaccount.ListResult, error) {
	application.listOptions = options
	return application.listResult, application.listErr
}

// ShowAccount 保存显式账号目标并返回预设公开详情。
func (application *recordingAccountApplication) ShowAccount(
	_ context.Context,
	target aihaccount.AccountTarget,
) (aihaccount.AccountView, error) {
	application.showTarget = target
	return application.showResult, application.showErr
}

// ListAccountModels 保存显式账号目标并返回预设物化模型快照。
func (application *recordingAccountApplication) ListAccountModels(
	_ context.Context,
	target aihaccount.AccountTarget,
) (aihaccount.AccountModelsResult, error) {
	application.modelsTarget = target
	return application.modelsResult, application.modelsErr
}

// RefreshAccountModels 保存显式账号目标并返回预设刷新快照。
func (application *recordingAccountApplication) RefreshAccountModels(
	_ context.Context,
	target aihaccount.AccountTarget,
) (aihaccount.AccountModelsResult, error) {
	application.refreshTarget = target
	return application.refreshResult, application.refreshErr
}

// SetAccountModelPolicy 保存人工模型策略命令并返回预设快照。
func (application *recordingAccountApplication) SetAccountModelPolicy(
	_ context.Context,
	command aihaccount.AccountModelPolicyCommand,
) (aihaccount.AccountModelsResult, error) {
	application.policyCommand = command
	return application.policyResult, application.policyErr
}

// Close 记录资源释放并返回预设错误。
func (application *recordingAccountApplication) Close() error {
	application.closeCalls++
	return application.closeErr
}
