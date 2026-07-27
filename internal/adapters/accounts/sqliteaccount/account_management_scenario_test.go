package sqliteaccount

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// TestAccountManagementScenario 验证注册、列表、详情和停用组成的真实应用链路。
func TestAccountManagementScenario(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	registeredAt := time.Date(2026, time.July, 27, 10, 0, 0, 0, time.UTC)
	registrar, err := accountapp.NewRegistrar(
		store.catalog,
		store,
		func() time.Time { return registeredAt },
	)
	if err != nil {
		t.Fatalf("NewRegistrar() error = %v", err)
	}

	codexAccount, err := registrar.Register(
		ctx,
		newTestCodexOAuth(t),
		newTestCodexAccountProfile(t),
	)
	if err != nil {
		t.Fatalf("Register(codex oauth) error = %v", err)
	}
	claudeAccount, err := registrar.Register(
		ctx,
		mustClaudeAPIKey(t, "synthetic-claude-api-key-for-scenario"),
		nil,
	)
	if err != nil {
		t.Fatalf("Register(claude api key) error = %v", err)
	}
	if codexAccount.CLIAccountID().Int64() != 1 ||
		claudeAccount.CLIAccountID().Int64() != 1 {
		t.Fatalf(
			"Provider 内别名错误: codex=%d claude=%d",
			codexAccount.CLIAccountID().Int64(),
			claudeAccount.CLIAccountID().Int64(),
		)
	}

	disabledAt := registeredAt.Add(5 * time.Minute)
	management, err := accountapp.NewManagement(
		store,
		store,
		func() time.Time { return disabledAt },
	)
	if err != nil {
		t.Fatalf("NewManagement() error = %v", err)
	}
	query, err := accountapp.NewOverviewQuery("", 50)
	if err != nil {
		t.Fatalf("NewOverviewQuery() error = %v", err)
	}
	t.Logf(
		"账号列表输入:\n%s",
		marshalScenarioJSON(t, map[string]any{"after_ref": "", "limit": 50}),
	)
	overviews, err := management.ListAccountOverviews(ctx, query)
	if err != nil {
		t.Fatalf("ListAccountOverviews() error = %v", err)
	}
	if len(overviews) != 2 {
		t.Fatalf("ListAccountOverviews() count = %d, want 2", len(overviews))
	}
	t.Logf(
		"账号列表输出:\n%s",
		marshalScenarioJSON(t, newScenarioAccountViews(overviews)),
	)

	t.Logf(
		"账号详情输入:\n%s",
		marshalScenarioJSON(
			t,
			map[string]any{"account_ref": codexAccount.Ref().String()},
		),
	)
	codexOverview, err := management.GetAccountOverview(ctx, codexAccount.Ref())
	if err != nil {
		t.Fatalf("GetAccountOverview() error = %v", err)
	}
	if codexOverview.AuthKind() != "oauth" ||
		codexOverview.SubscriptionKind() != "plus" ||
		codexOverview.Email() != "codex@example.com" {
		t.Fatalf("Codex 详情错误: %#v", newScenarioAccountView(codexOverview))
	}
	t.Logf(
		"账号详情输出:\n%s",
		marshalScenarioJSON(t, newScenarioAccountView(codexOverview)),
	)

	t.Logf(
		"停用输入:\n%s",
		marshalScenarioJSON(t, map[string]any{
			"account_ref": codexAccount.Ref().String(),
			"enabled":     false,
		}),
	)
	disabled, err := management.SetAccountEnabled(ctx, codexAccount.Ref(), false)
	if err != nil {
		t.Fatalf("SetAccountEnabled(false) error = %v", err)
	}
	if disabled.Enabled() || !disabled.UpdatedAt().Equal(disabledAt) {
		t.Fatalf("停用结果错误: %#v", disabled)
	}
	disabledOverview, err := management.GetAccountOverview(ctx, codexAccount.Ref())
	if err != nil {
		t.Fatalf("GetAccountOverview(disabled) error = %v", err)
	}
	t.Logf(
		"停用后详情输出:\n%s",
		marshalScenarioJSON(t, newScenarioAccountView(disabledOverview)),
	)
}

// scenarioAccountView 是场景日志允许输出的无敏感账号投影。
type scenarioAccountView struct {
	AccountRef       string `json:"account_ref"`
	ProviderID       string `json:"provider_id"`
	CLIAccountID     int64  `json:"cli_account_id"`
	Enabled          bool   `json:"enabled"`
	HasCredential    bool   `json:"has_credential"`
	AuthKind         string `json:"auth_kind"`
	AuthMode         string `json:"auth_mode"`
	HasProfile       bool   `json:"has_profile"`
	DisplayName      string `json:"display_name"`
	Email            string `json:"email"`
	SubscriptionKind string `json:"subscription_kind"`
	SubscriptionRaw  string `json:"subscription_raw"`
	CreatedAt        string `json:"created_at"`
	UpdatedAt        string `json:"updated_at"`
}

// newScenarioAccountViews 将管理列表映射为可安全展示的场景结果。
func newScenarioAccountViews(
	overviews []accountapp.AccountOverview,
) []scenarioAccountView {
	views := make([]scenarioAccountView, 0, len(overviews))
	for _, overview := range overviews {
		views = append(views, newScenarioAccountView(overview))
	}
	return views
}

// newScenarioAccountView 只选择账号管理公开字段，不读取凭据或 Provider JSON。
func newScenarioAccountView(
	overview accountapp.AccountOverview,
) scenarioAccountView {
	account := overview.Account()
	return scenarioAccountView{
		AccountRef:       account.Ref().String(),
		ProviderID:       account.ProviderID(),
		CLIAccountID:     account.CLIAccountID().Int64(),
		Enabled:          account.Enabled(),
		HasCredential:    overview.HasCredential(),
		AuthKind:         overview.AuthKind(),
		AuthMode:         overview.AuthMode(),
		HasProfile:       overview.HasProfile(),
		DisplayName:      overview.DisplayName(),
		Email:            overview.Email(),
		SubscriptionKind: overview.SubscriptionKind(),
		SubscriptionRaw:  overview.SubscriptionRaw(),
		CreatedAt:        formatScenarioTime(account.CreatedAt()),
		UpdatedAt:        formatScenarioTime(account.UpdatedAt()),
	}
}

// formatScenarioTime 将领域时间转换为稳定的 UTC 文本。
func formatScenarioTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

// marshalScenarioJSON 生成便于人工核对的稳定缩进 JSON。
func marshalScenarioJSON(t *testing.T, value any) string {
	t.Helper()

	document, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatalf("json.MarshalIndent() error = %v", err)
	}
	return string(document)
}
