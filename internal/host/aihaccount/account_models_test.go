package aihaccount

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

// TestListAccountModelsResolvesAliasAndReturnsMaterializedSnapshot 验证数字
// 别名只负责解析稳定身份，模型结果完全来自本地物化快照。
func TestListAccountModelsResolvesAliasAndReturnsMaterializedSnapshot(t *testing.T) {
	t.Parallel()

	overview := newAccountOverview(
		t,
		"acct_10000000000000000000",
		"claude",
		9,
		false,
	)
	reader := &stubModelReader{
		t:              t,
		accountByAlias: overview.Account(),
		specs: []modelSpec{
			{
				modelID:           "claude-opus-5",
				upstreamAvailable: true,
				manualPolicy:      accountapp.ModelPolicyInherit,
				updatedAt:         time.Date(2026, 8, 9, 8, 30, 0, 0, time.UTC),
			},
			{
				modelID:           "claude-retired",
				upstreamAvailable: false,
				manualPolicy:      accountapp.ModelPolicyForceEnable,
				updatedAt:         time.Date(2026, 8, 9, 8, 31, 0, 0, time.UTC),
			},
			{
				modelID:           "claude-sonnet-5",
				upstreamAvailable: true,
				manualPolicy:      accountapp.ModelPolicyForceDisable,
				updatedAt:         time.Date(2026, 8, 9, 8, 32, 0, 0, time.UTC),
			},
		},
	}
	app, err := newApp(
		nativeaccount.NewDecoder(),
		syntheticClaudeReader(),
		&recordingRegistrar{t: t},
		reader,
		reader,
	)
	if err != nil {
		t.Fatalf("newApp() error = %v", err)
	}

	result, err := app.ListAccountModels(context.Background(), AccountTarget{
		ProviderID:   "claude",
		CLIAccountID: 9,
	})
	if err != nil {
		t.Fatalf("ListAccountModels() error = %v", err)
	}
	if result.AccountRef != "acct_10000000000000000000" ||
		reader.aliasCalls != 1 ||
		reader.modelCalls != 1 ||
		reader.modelRef.String() != result.AccountRef ||
		len(result.Models) != 3 {
		t.Fatalf(
			"result=%+v alias_calls=%d model_calls=%d model_ref=%s",
			result,
			reader.aliasCalls,
			reader.modelCalls,
			reader.modelRef,
		)
	}
	if result.Models[0].ModelID != "claude-opus-5" ||
		!result.Models[0].UpstreamAvailable ||
		result.Models[0].ManualPolicy != "inherit" ||
		!result.Models[0].Effective ||
		result.Models[1].ModelID != "claude-retired" ||
		result.Models[1].UpstreamAvailable ||
		result.Models[1].ManualPolicy != "force_enable" ||
		!result.Models[1].Effective ||
		result.Models[2].Effective {
		t.Fatalf("models=%+v", result.Models)
	}
}

// TestListAccountModelsRejectsInvalidTargetBeforeRead 验证无效身份不会到达
// 账号解析或模型存储端口。
func TestListAccountModelsRejectsInvalidTargetBeforeRead(t *testing.T) {
	t.Parallel()

	reader := &stubModelReader{t: t}
	app, err := newApp(
		nativeaccount.NewDecoder(),
		syntheticClaudeReader(),
		&recordingRegistrar{t: t},
		reader,
		reader,
	)
	if err != nil {
		t.Fatalf("newApp() error = %v", err)
	}

	_, err = app.ListAccountModels(context.Background(), AccountTarget{
		ProviderID:   "Claude",
		CLIAccountID: 9,
	})
	if !errors.Is(err, ErrInvalidAccountModelsRequest) ||
		reader.aliasCalls != 0 ||
		reader.modelCalls != 0 {
		t.Fatalf(
			"error=%v alias_calls=%d model_calls=%d",
			err,
			reader.aliasCalls,
			reader.modelCalls,
		)
	}
}

// TestNewAccountModelViewsRejectsForeignAndUnsortedSnapshots 验证 Host 不会
// 把持久化端口返回的错账号关系或非稳定顺序静默展示给用户。
func TestNewAccountModelViewsRejectsForeignAndUnsortedSnapshots(t *testing.T) {
	t.Parallel()

	targetRef := mustParseAccountRef(t, "acct_10000000000000000000")
	foreignRef := mustParseAccountRef(t, "acct_20000000000000000000")
	foreign := mustBuildAccountModel(t, foreignRef, "claude-opus-5")
	if _, err := newAccountModelViews(
		targetRef.String(),
		[]accountapp.AccountModel{foreign},
	); !errors.Is(err, ErrInvalidAccountModelsSnapshot) {
		t.Fatalf("foreign snapshot error = %v", err)
	}

	unsorted := []accountapp.AccountModel{
		mustBuildAccountModel(t, targetRef, "claude-sonnet-5"),
		mustBuildAccountModel(t, targetRef, "claude-opus-5"),
	}
	if _, err := newAccountModelViews(
		targetRef.String(),
		unsorted,
	); !errors.Is(err, ErrInvalidAccountModelsSnapshot) {
		t.Fatalf("unsorted snapshot error = %v", err)
	}
}

// TestRefreshAccountModelsResolvesTargetAndReturnsFreshSnapshot 验证刷新只解析
// 一次账号身份，并把远端发现后的完整物化快照返回给 CLI。
func TestRefreshAccountModelsResolvesTargetAndReturnsFreshSnapshot(t *testing.T) {
	t.Parallel()

	overview := newAccountOverview(
		t,
		"acct_10000000000000000000",
		"claude",
		9,
		true,
	)
	reader := &stubModelReader{
		t:              t,
		accountByAlias: overview.Account(),
		specs: []modelSpec{{
			modelID:           "claude-opus-5",
			upstreamAvailable: true,
			manualPolicy:      accountapp.ModelPolicyInherit,
			updatedAt:         time.Date(2026, 8, 9, 9, 0, 0, 0, time.UTC),
		}},
	}
	app, err := newApp(
		nativeaccount.NewDecoder(),
		syntheticClaudeReader(),
		&recordingRegistrar{t: t},
		reader,
		reader,
	)
	if err != nil {
		t.Fatalf("newApp() error = %v", err)
	}

	result, err := app.RefreshAccountModels(context.Background(), AccountTarget{
		ProviderID:   "claude",
		CLIAccountID: 9,
	})
	if err != nil {
		t.Fatalf("RefreshAccountModels() error = %v", err)
	}
	if result.AccountRef != "acct_10000000000000000000" ||
		reader.aliasCalls != 1 ||
		reader.refreshCalls != 1 ||
		reader.refreshRef.String() != result.AccountRef ||
		reader.modelCalls != 1 ||
		len(result.Models) != 1 ||
		result.Models[0].ModelID != "claude-opus-5" {
		t.Fatalf(
			"result=%+v alias_calls=%d refresh_calls=%d refresh_ref=%s model_calls=%d",
			result,
			reader.aliasCalls,
			reader.refreshCalls,
			reader.refreshRef,
			reader.modelCalls,
		)
	}
}

// TestRefreshAccountModelsDoesNotFallbackToOldSnapshot 验证上游刷新失败时 Host
// 原样返回错误，不用旧快照伪装成刷新成功。
func TestRefreshAccountModelsDoesNotFallbackToOldSnapshot(t *testing.T) {
	t.Parallel()

	refreshErr := errors.New("synthetic refresh failure")
	reader := &stubModelReader{t: t, refreshErr: refreshErr}
	app, err := newApp(
		nativeaccount.NewDecoder(),
		syntheticClaudeReader(),
		&recordingRegistrar{t: t},
		reader,
		reader,
	)
	if err != nil {
		t.Fatalf("newApp() error = %v", err)
	}

	_, err = app.RefreshAccountModels(context.Background(), AccountTarget{
		AccountRef: "acct_10000000000000000000",
	})
	if !errors.Is(err, refreshErr) ||
		reader.refreshCalls != 1 ||
		reader.modelCalls != 0 {
		t.Fatalf(
			"error=%v refresh_calls=%d model_calls=%d",
			err,
			reader.refreshCalls,
			reader.modelCalls,
		)
	}
}

// TestNewWiresModelRefreshIntoSQLite 验证生产组合根使用真实注册、模型管理
// 和 SQLite 事务完成目录替换，而不是只在接口桩测试中成立。
func TestNewWiresModelRefreshIntoSQLite(t *testing.T) {
	t.Parallel()

	transport := &modelCatalogTransport{
		t: t,
		payloads: []string{
			modelCatalogPayload("claude-opus-4-6"),
			modelCatalogPayload("claude-opus-5", "claude-sonnet-5"),
		},
	}
	app, err := New(context.Background(), Options{
		AIHomeDir:              t.TempDir(),
		ArtifactReader:         syntheticClaudeReader(),
		ModelCatalogHTTPClient: &http.Client{Transport: transport},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	defer func() {
		if closeErr := app.Close(); closeErr != nil {
			t.Errorf("Close() error = %v", closeErr)
		}
	}()

	imported, err := app.ImportOfficialLogin(context.Background(), "claude")
	if err != nil {
		t.Fatalf("ImportOfficialLogin() error = %v", err)
	}
	refreshed, err := app.RefreshAccountModels(context.Background(), AccountTarget{
		AccountRef: imported.AccountRef,
	})
	if err != nil {
		t.Fatalf("RefreshAccountModels() error = %v", err)
	}
	listed, err := app.ListAccountModels(context.Background(), AccountTarget{
		AccountRef: imported.AccountRef,
	})
	if err != nil {
		t.Fatalf("ListAccountModels() error = %v", err)
	}
	disabled, err := app.SetAccountModelPolicy(
		context.Background(),
		AccountModelPolicyCommand{
			Target:       AccountTarget{AccountRef: imported.AccountRef},
			ModelID:      "claude-opus-5",
			ManualPolicy: "force_disable",
		},
	)
	if err != nil {
		t.Fatalf("SetAccountModelPolicy(force_disable) error = %v", err)
	}
	restored, err := app.SetAccountModelPolicy(
		context.Background(),
		AccountModelPolicyCommand{
			Target:       AccountTarget{AccountRef: imported.AccountRef},
			ModelID:      "claude-opus-5",
			ManualPolicy: "inherit",
		},
	)
	if err != nil {
		t.Fatalf("SetAccountModelPolicy(inherit) error = %v", err)
	}
	if transport.calls != 2 ||
		len(refreshed.Models) != 2 ||
		refreshed.Models[0].ModelID != "claude-opus-5" ||
		refreshed.Models[1].ModelID != "claude-sonnet-5" ||
		len(listed.Models) != len(refreshed.Models) ||
		listed.Models[0].ModelID != refreshed.Models[0].ModelID ||
		listed.Models[1].ModelID != refreshed.Models[1].ModelID ||
		len(disabled.Models) != 2 ||
		disabled.Models[0].ManualPolicy != "force_disable" ||
		disabled.Models[0].Effective ||
		len(restored.Models) != 2 ||
		restored.Models[0].ManualPolicy != "inherit" ||
		!restored.Models[0].Effective {
		t.Fatalf(
			"calls=%d refreshed=%+v listed=%+v disabled=%+v restored=%+v",
			transport.calls,
			refreshed,
			listed,
			disabled,
			restored,
		)
	}
}

// TestParseAccountModelPolicyCommandValidatesAllFields 验证 CLI 在打开数据库
// 前拒绝无效账号目标、模型 ID 和人工策略。
func TestParseAccountModelPolicyCommandValidatesAllFields(t *testing.T) {
	t.Parallel()

	command, err := ParseAccountModelPolicyCommand(
		"claude:9",
		"claude-opus-5",
		"force_disable",
	)
	if err != nil ||
		command.Target.ProviderID != "claude" ||
		command.Target.CLIAccountID != 9 ||
		command.ModelID != "claude-opus-5" ||
		command.ManualPolicy != "force_disable" {
		t.Fatalf("command=%+v error=%v", command, err)
	}
	for _, input := range [][3]string{
		{"claude:01", "claude-opus-5", "inherit"},
		{"claude:9", "bad model", "inherit"},
		{"claude:9", "claude-opus-5", "unknown"},
	} {
		if _, err := ParseAccountModelPolicyCommand(
			input[0],
			input[1],
			input[2],
		); !errors.Is(err, ErrInvalidAccountModelPolicyCommand) {
			t.Fatalf("ParseAccountModelPolicyCommand(%v) error = %v", input, err)
		}
	}
}

// TestSetAccountModelPolicyResolvesTargetAndDelegatesOnce 验证人工策略只作用于
// 解析后的稳定账号与精确模型，不触发 Provider 目录刷新。
func TestSetAccountModelPolicyResolvesTargetAndDelegatesOnce(t *testing.T) {
	t.Parallel()

	overview := newAccountOverview(
		t,
		"acct_10000000000000000000",
		"claude",
		9,
		true,
	)
	reader := &stubModelReader{
		t:              t,
		accountByAlias: overview.Account(),
		specs: []modelSpec{{
			modelID:           "claude-opus-5",
			upstreamAvailable: true,
			manualPolicy:      accountapp.ModelPolicyForceDisable,
			updatedAt:         time.Date(2026, 8, 9, 9, 30, 0, 0, time.UTC),
		}},
	}
	app, err := newApp(
		nativeaccount.NewDecoder(),
		syntheticClaudeReader(),
		&recordingRegistrar{t: t},
		reader,
		reader,
	)
	if err != nil {
		t.Fatalf("newApp() error = %v", err)
	}

	result, err := app.SetAccountModelPolicy(
		context.Background(),
		AccountModelPolicyCommand{
			Target: AccountTarget{
				ProviderID:   "claude",
				CLIAccountID: 9,
			},
			ModelID:      "claude-opus-5",
			ManualPolicy: "force_disable",
		},
	)
	if err != nil {
		t.Fatalf("SetAccountModelPolicy() error = %v", err)
	}
	if reader.aliasCalls != 1 ||
		reader.policyCalls != 1 ||
		reader.policyRef.String() != "acct_10000000000000000000" ||
		reader.policyModelID != "claude-opus-5" ||
		reader.policyValue != accountapp.ModelPolicyForceDisable ||
		reader.refreshCalls != 0 ||
		len(result.Models) != 1 ||
		result.Models[0].ManualPolicy != "force_disable" ||
		result.Models[0].Effective {
		t.Fatalf(
			"result=%+v alias=%d policy=%d ref=%s model=%s value=%s refresh=%d",
			result,
			reader.aliasCalls,
			reader.policyCalls,
			reader.policyRef,
			reader.policyModelID,
			reader.policyValue,
			reader.refreshCalls,
		)
	}
}

// modelCatalogTransport 顺序返回模型目录，不读取或记录认证 Header 正文。
type modelCatalogTransport struct {
	t        *testing.T
	payloads []string
	calls    int
}

// RoundTrip 验证目录请求形状并返回当前步骤的完整 JSON 快照。
func (transport *modelCatalogTransport) RoundTrip(
	request *http.Request,
) (*http.Response, error) {
	transport.t.Helper()
	if request == nil ||
		request.Method != http.MethodGet ||
		request.URL.Host != "api.anthropic.com" ||
		request.URL.Path != "/v1/models" ||
		request.Header.Get("Authorization") == "" ||
		transport.calls >= len(transport.payloads) {
		transport.t.Fatal("模型目录请求没有遵守 Claude OAuth 合同")
	}
	payload := transport.payloads[transport.calls]
	transport.calls++
	return &http.Response{
		StatusCode: http.StatusOK,
		Header: http.Header{
			"Content-Type": []string{"application/json"},
		},
		Body:    io.NopCloser(strings.NewReader(payload)),
		Request: request,
	}, nil
}

// modelCatalogPayload 构造单页完整 Claude 模型目录。
func modelCatalogPayload(models ...string) string {
	entries := make([]string, 0, len(models))
	for _, model := range models {
		entries = append(entries, `{"id":"`+model+`"}`)
	}
	return `{"data":[` + strings.Join(entries, ",") +
		`],"has_more":false,"first_id":"` + models[0] +
		`","last_id":"` + models[len(models)-1] + `"}`
}

// mustParseAccountRef 构造测试使用的稳定账号身份。
func mustParseAccountRef(t *testing.T, value string) accountcore.AccountRef {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef(value)
	if err != nil {
		t.Fatalf("ParseAccountRef(%q) error = %v", value, err)
	}
	return accountRef
}

// mustBuildAccountModel 构造测试使用的完整物化模型关系。
func mustBuildAccountModel(
	t *testing.T,
	accountRef accountcore.AccountRef,
	modelID string,
) accountapp.AccountModel {
	t.Helper()
	model, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        accountRef,
		ModelID:           modelID,
		UpstreamAvailable: true,
		ManualPolicy:      accountapp.ModelPolicyInherit,
		UpdatedAt:         time.Date(2026, 8, 9, 8, 30, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("NewAccountModel(%q) error = %v", modelID, err)
	}
	return model
}
