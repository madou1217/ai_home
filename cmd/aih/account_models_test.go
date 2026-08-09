package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/host/aihaccount"
)

// TestAccountModelsListPrintsMaterializedSnapshot 验证模型命令只把显式账号
// 目标交给 Host，并完整展示已物化模型的来源、人工策略和最终有效性。
func TestAccountModelsListPrintsMaterializedSnapshot(t *testing.T) {
	output := &bytes.Buffer{}
	application := &recordingAccountApplication{
		modelsResult: aihaccount.AccountModelsResult{
			AccountRef: "acct_11111111111111111111",
			Models: []aihaccount.AccountModelView{
				{
					ModelID:           "claude-opus-5",
					UpstreamAvailable: true,
					ManualPolicy:      "inherit",
					Effective:         true,
					UpdatedAt:         time.Date(2026, 8, 9, 8, 30, 0, 0, time.UTC),
				},
				{
					ModelID:           "claude-retired",
					UpstreamAvailable: false,
					ManualPolicy:      "force_enable",
					Effective:         true,
					UpdatedAt:         time.Date(2026, 8, 9, 8, 31, 0, 0, time.UTC),
				},
			},
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
		[]string{"account", "models", "list", "claude:9"},
		runtime,
	); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if application.modelsTarget.ProviderID != "claude" ||
		application.modelsTarget.CLIAccountID != 9 ||
		application.options.AIHomeDir != "/test-user/.ai_home" ||
		application.closeCalls != 1 {
		t.Fatalf(
			"target=%+v ai_home=%s close_calls=%d",
			application.modelsTarget,
			application.options.AIHomeDir,
			application.closeCalls,
		)
	}
	rendered := output.String()
	for _, expected := range []string{
		"acct_11111111111111111111",
		"claude-opus-5",
		"available",
		"inherit",
		"enabled",
		"claude-retired",
		"missing",
		"force_enable",
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("账号模型输出缺少 %q: %s", expected, rendered)
		}
	}
}

// TestAccountModelsListJoinsQueryAndCloseErrors 验证模型读取失败时仍释放
// 单库资源，并保留查询错误与关闭错误两条因果链。
func TestAccountModelsListJoinsQueryAndCloseErrors(t *testing.T) {
	modelsErr := errors.New("模型读取失败")
	closeErr := errors.New("关闭失败")
	application := &recordingAccountApplication{
		modelsErr: modelsErr,
		closeErr:  closeErr,
	}
	runtime := testCommandRuntime(t, nil)
	runtime.newAccountApp = func(
		context.Context,
		aihaccount.Options,
	) (accountApplication, error) {
		return application, nil
	}

	err := run(
		context.Background(),
		[]string{"account", "models", "list", "acct_11111111111111111111"},
		runtime,
	)
	if !errors.Is(err, modelsErr) ||
		!errors.Is(err, closeErr) ||
		application.closeCalls != 1 {
		t.Fatalf("error=%v close_calls=%d", err, application.closeCalls)
	}
}

// TestAccountModelsRefreshPrintsFreshSnapshot 验证刷新命令把显式账号目标交给
// Host，并明确区分刷新成功与普通只读列表。
func TestAccountModelsRefreshPrintsFreshSnapshot(t *testing.T) {
	output := &bytes.Buffer{}
	application := &recordingAccountApplication{
		refreshResult: aihaccount.AccountModelsResult{
			AccountRef: "acct_11111111111111111111",
			Models: []aihaccount.AccountModelView{{
				ModelID:           "claude-opus-5",
				UpstreamAvailable: true,
				ManualPolicy:      "inherit",
				Effective:         true,
				UpdatedAt:         time.Date(2026, 8, 9, 9, 0, 0, 0, time.UTC),
			}},
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
			"models",
			"refresh",
			"acct_11111111111111111111",
		},
		runtime,
	); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	if application.refreshTarget.AccountRef != "acct_11111111111111111111" ||
		application.options.AIHomeDir != "/test-user/.ai_home" ||
		application.closeCalls != 1 {
		t.Fatalf(
			"target=%+v ai_home=%s close_calls=%d",
			application.refreshTarget,
			application.options.AIHomeDir,
			application.closeCalls,
		)
	}
	rendered := output.String()
	for _, expected := range []string{
		"模型刷新完成",
		"acct_11111111111111111111",
		"claude-opus-5",
		"available",
		"inherit",
		"enabled",
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("模型刷新输出缺少 %q: %s", expected, rendered)
		}
	}
}

// TestAccountModelsRefreshJoinsRefreshAndCloseErrors 验证远端刷新失败时仍释放
// 单库资源，并保留刷新错误与关闭错误两条因果链。
func TestAccountModelsRefreshJoinsRefreshAndCloseErrors(t *testing.T) {
	refreshErr := errors.New("模型刷新失败")
	closeErr := errors.New("关闭失败")
	application := &recordingAccountApplication{
		refreshErr: refreshErr,
		closeErr:   closeErr,
	}
	runtime := testCommandRuntime(t, nil)
	runtime.newAccountApp = func(
		context.Context,
		aihaccount.Options,
	) (accountApplication, error) {
		return application, nil
	}

	err := run(
		context.Background(),
		[]string{"account", "models", "refresh", "claude:1"},
		runtime,
	)
	if !errors.Is(err, refreshErr) ||
		!errors.Is(err, closeErr) ||
		application.closeCalls != 1 {
		t.Fatalf("error=%v close_calls=%d", err, application.closeCalls)
	}
}

// TestAccountModelsSetPolicyPrintsUpdatedSnapshot 验证人工策略命令使用规范
// 模型 ID 和策略，并在成功后展示最终路由有效性。
func TestAccountModelsSetPolicyPrintsUpdatedSnapshot(t *testing.T) {
	output := &bytes.Buffer{}
	application := &recordingAccountApplication{
		policyResult: aihaccount.AccountModelsResult{
			AccountRef: "acct_11111111111111111111",
			Models: []aihaccount.AccountModelView{{
				ModelID:           "claude-opus-5",
				UpstreamAvailable: true,
				ManualPolicy:      "force_disable",
				Effective:         false,
				UpdatedAt:         time.Date(2026, 8, 9, 9, 30, 0, 0, time.UTC),
			}},
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
			"models",
			"set-policy",
			"claude:9",
			"claude-opus-5",
			"force_disable",
		},
		runtime,
	); err != nil {
		t.Fatalf("run() error = %v", err)
	}
	command := application.policyCommand
	if command.Target.ProviderID != "claude" ||
		command.Target.CLIAccountID != 9 ||
		command.ModelID != "claude-opus-5" ||
		command.ManualPolicy != "force_disable" ||
		application.options.AIHomeDir != "/test-user/.ai_home" ||
		application.closeCalls != 1 {
		t.Fatalf(
			"command=%+v ai_home=%s close_calls=%d",
			command,
			application.options.AIHomeDir,
			application.closeCalls,
		)
	}
	rendered := output.String()
	for _, expected := range []string{
		"模型策略已更新",
		"claude-opus-5",
		"force_disable",
		"disabled",
	} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("模型策略输出缺少 %q: %s", expected, rendered)
		}
	}
}

// TestAccountModelsSetPolicyJoinsOperationAndCloseErrors 验证人工策略写入
// 失败时仍关闭单库，并保留操作错误与关闭错误。
func TestAccountModelsSetPolicyJoinsOperationAndCloseErrors(t *testing.T) {
	policyErr := errors.New("模型策略写入失败")
	closeErr := errors.New("关闭失败")
	application := &recordingAccountApplication{
		policyErr: policyErr,
		closeErr:  closeErr,
	}
	runtime := testCommandRuntime(t, nil)
	runtime.newAccountApp = func(
		context.Context,
		aihaccount.Options,
	) (accountApplication, error) {
		return application, nil
	}

	err := run(
		context.Background(),
		[]string{
			"account",
			"models",
			"set-policy",
			"claude:1",
			"claude-opus-5",
			"inherit",
		},
		runtime,
	)
	if !errors.Is(err, policyErr) ||
		!errors.Is(err, closeErr) ||
		application.closeCalls != 1 {
		t.Fatalf("error=%v close_calls=%d", err, application.closeCalls)
	}
}
