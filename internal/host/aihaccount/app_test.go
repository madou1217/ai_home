package aihaccount

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeartifact"
)

const (
	// 合成凭据只用于本用例，格式与官方一致但不是任何真实账号。
	syntheticAccessToken  = "sk-ant-oat01-synthetic-import-access"
	syntheticRefreshToken = "sk-ant-ort01-synthetic-import-refresh"
	syntheticAccountUUID  = "123e4567-e89b-12d3-a456-426614174222"
	syntheticEmail        = "import-case@example.invalid"
)

// TestImportOfficialLoginRegistersAndReportsRealCatalog 验证导入用例把官方登录态
// 交给注册用例，并只回显公开账号信息与真实物化模型。
func TestImportOfficialLoginRegistersAndReportsRealCatalog(t *testing.T) {
	t.Parallel()

	registrar := &recordingRegistrar{t: t}
	models := &stubModelReader{
		t: t,
		specs: []modelSpec{
			{modelID: "claude-opus-4-1", upstreamAvailable: true},
			{modelID: "claude-retired-1", upstreamAvailable: false},
			{modelID: "claude-sonnet-4", upstreamAvailable: true},
		},
	}
	app, err := newApp(
		nativeaccount.NewDecoder(),
		syntheticClaudeReader(),
		registrar,
		models,
		models,
	)
	if err != nil {
		t.Fatalf("newApp() error = %v", err)
	}

	result, err := app.ImportOfficialLogin(context.Background(), "claude")
	if err != nil {
		t.Fatalf("ImportOfficialLogin() error = %v", err)
	}
	if result.ProviderID != "claude" ||
		result.CLIAccountID != 7 ||
		result.Email != syntheticEmail ||
		result.AccountRef == "" {
		t.Fatalf("result = %+v", result)
	}
	// 只有真实生效的模型才允许作为后续验收的候选模型。
	if len(result.Models) != 2 ||
		result.Models[0] != "claude-opus-4-1" ||
		result.Models[1] != "claude-sonnet-4" {
		t.Fatalf("models = %v", result.Models)
	}
	if len(result.Sources) != 2 ||
		!strings.HasSuffix(result.Sources[0], ".credentials.json") {
		t.Fatalf("sources = %v", result.Sources)
	}
	if registrar.credential == nil ||
		registrar.credential.ProviderID() != "claude" ||
		registrar.profile == nil ||
		registrar.profile.Email() != syntheticEmail {
		t.Fatal("注册用例没有收到官方登录态派生的凭据与公开资料")
	}
	if strings.Contains(strings.Join(result.Models, " "), syntheticAccessToken) ||
		strings.Contains(result.AccountRef, syntheticAccessToken) {
		t.Fatal("导入结果泄露了凭据")
	}
}

// TestListAccountsUsesBoundedKeysetAndReturnsNextCursor 验证 CLI Host 复用
// Management API 的有界公开投影，并通过多取一行准确计算下一页。
func TestListAccountsUsesBoundedKeysetAndReturnsNextCursor(t *testing.T) {
	t.Parallel()

	reader := &stubModelReader{t: t}
	reader.overviews = []accountapp.AccountOverview{
		newAccountOverview(t, "acct_10000000000000000000", "claude", 1, true),
		newAccountOverview(t, "acct_20000000000000000000", "codex", 2, true),
		newAccountOverview(t, "acct_30000000000000000000", "claude", 3, false),
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

	result, err := app.ListAccounts(context.Background(), ListOptions{
		AfterRef: "acct_00000000000000000000",
		Limit:    2,
	})
	if err != nil {
		t.Fatalf("ListAccounts() error = %v", err)
	}
	if reader.overviewQuery.AfterRef().String() != "acct_00000000000000000000" ||
		reader.overviewQuery.Limit() != 3 {
		t.Fatalf("query = after:%s limit:%d", reader.overviewQuery.AfterRef(), reader.overviewQuery.Limit())
	}
	if len(result.Accounts) != 2 ||
		!result.HasMore ||
		result.NextAfterRef != "acct_20000000000000000000" ||
		result.Limit != 2 ||
		result.Accounts[0].ProviderID != "claude" ||
		result.Accounts[0].AuthKind != "oauth" ||
		result.Accounts[1].CLIAccountID != 2 {
		t.Fatalf("result = %+v", result)
	}
}

// TestListAccountsRejectsInvalidBoundsBeforeQuery 验证无效游标或无界页大小
// 不会到达持久化端口。
func TestListAccountsRejectsInvalidBoundsBeforeQuery(t *testing.T) {
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
	for _, options := range []ListOptions{
		{AfterRef: "not-an-account-ref", Limit: 10},
		{Limit: -1},
		{Limit: MaxListLimit + 1},
	} {
		if _, err := app.ListAccounts(
			context.Background(),
			options,
		); !errors.Is(err, ErrInvalidListRequest) {
			t.Fatalf("ListAccounts(%+v) error = %v", options, err)
		}
	}
	if reader.overviewCalls != 0 {
		t.Fatalf("overview_calls = %d", reader.overviewCalls)
	}
}

// TestParseAccountTargetDistinguishesStableRefAndProviderAlias 验证详情目标只有
// 稳定 AccountRef 或 Provider 内规范数字别名两种无歧义表示。
func TestParseAccountTargetDistinguishesStableRefAndProviderAlias(t *testing.T) {
	t.Parallel()

	refTarget, err := ParseAccountTarget("acct_10000000000000000000")
	if err != nil || refTarget.AccountRef != "acct_10000000000000000000" ||
		refTarget.ProviderID != "" || refTarget.CLIAccountID != 0 {
		t.Fatalf("ref_target=%+v error=%v", refTarget, err)
	}
	aliasTarget, err := ParseAccountTarget("claude:9")
	if err != nil || aliasTarget.AccountRef != "" ||
		aliasTarget.ProviderID != "claude" || aliasTarget.CLIAccountID != 9 {
		t.Fatalf("alias_target=%+v error=%v", aliasTarget, err)
	}
	for _, value := range []string{
		"",
		"acct_invalid",
		"claude",
		"claude:",
		":1",
		"claude:01",
		"claude:1:2",
		" claude:1",
	} {
		if _, err := ParseAccountTarget(value); !errors.Is(err, ErrInvalidAccountTarget) {
			t.Fatalf("ParseAccountTarget(%q) error = %v", value, err)
		}
	}
}

// TestShowAccountResolvesStableRefAndProviderAlias 验证详情读取不会套用启动资格：
// 停用账号仍可查看，数字别名仅用于解析出稳定 AccountRef。
func TestShowAccountResolvesStableRefAndProviderAlias(t *testing.T) {
	t.Parallel()

	overview := newAccountOverview(t, "acct_10000000000000000000", "claude", 9, false)
	reader := &stubModelReader{t: t, overview: overview}
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

	byRef, err := app.ShowAccount(context.Background(), AccountTarget{
		AccountRef: "acct_10000000000000000000",
	})
	if err != nil || byRef.AccountRef != "acct_10000000000000000000" || byRef.Enabled {
		t.Fatalf("by_ref=%+v error=%v", byRef, err)
	}
	if reader.aliasCalls != 0 || reader.overviewRef.String() != byRef.AccountRef {
		t.Fatalf("alias_calls=%d overview_ref=%s", reader.aliasCalls, reader.overviewRef)
	}

	reader.accountByAlias = overview.Account()
	byAlias, err := app.ShowAccount(context.Background(), AccountTarget{
		ProviderID:   "claude",
		CLIAccountID: 9,
	})
	if err != nil || byAlias.AccountRef != byRef.AccountRef || reader.aliasCalls != 1 {
		t.Fatalf("by_alias=%+v alias_calls=%d error=%v", byAlias, reader.aliasCalls, err)
	}

	reader.accountByAlias = newAccountOverview(
		t,
		"acct_20000000000000000000",
		"codex",
		9,
		true,
	).Account()
	if _, err := app.ShowAccount(context.Background(), AccountTarget{
		ProviderID:   "claude",
		CLIAccountID: 9,
	}); !errors.Is(err, ErrInvalidShowRequest) || reader.detailCalls != 2 {
		t.Fatalf("mismatch_error=%v detail_calls=%d", err, reader.detailCalls)
	}
}

// TestImportOfficialLoginRejectsUnsupportedProvider 验证不支持的 Provider 不会
// 触发任何文件读取或注册。
func TestImportOfficialLoginRejectsUnsupportedProvider(t *testing.T) {
	t.Parallel()

	registrar := &recordingRegistrar{t: t}
	models := &stubModelReader{}
	app, err := newApp(
		nativeaccount.NewDecoder(),
		syntheticClaudeReader(),
		registrar,
		models,
		models,
	)
	if err != nil {
		t.Fatalf("newApp() error = %v", err)
	}
	if _, err := app.ImportOfficialLogin(
		context.Background(),
		"gemini",
	); !errors.Is(err, ErrInvalidImportRequest) {
		t.Fatalf("ImportOfficialLogin(gemini) error = %v", err)
	}
	if registrar.calls != 0 {
		t.Fatalf("registrar_calls = %d", registrar.calls)
	}
}

// TestImportOfficialLoginPropagatesMissingLogin 验证官方登录态缺失时导入失败，
// 并且错误不携带任何凭据内容。
func TestImportOfficialLoginPropagatesMissingLogin(t *testing.T) {
	t.Parallel()

	registrar := &recordingRegistrar{t: t}
	reader := nativeartifact.New(nativeartifact.Options{
		LookupEnv:   func(string) (string, bool) { return "", false },
		UserHomeDir: func() (string, error) { return "/home/import-case", nil },
		ReadFile:    func(string) ([]byte, error) { return nil, os.ErrNotExist },
		ReadClaudeSecureStorage: func(string, bool) ([]byte, string, error) {
			return nil, "", os.ErrNotExist
		},
	})
	models := &stubModelReader{}
	app, err := newApp(
		nativeaccount.NewDecoder(),
		reader,
		registrar,
		models,
		models,
	)
	if err != nil {
		t.Fatalf("newApp() error = %v", err)
	}
	_, err = app.ImportOfficialLogin(context.Background(), "claude")
	if !errors.Is(err, nativeartifact.ErrInvalidArtifactSource) ||
		registrar.calls != 0 {
		t.Fatalf("error = %v registrar_calls = %d", err, registrar.calls)
	}
}

// syntheticClaudeReader 用内存官方文件表构造读取器，测试不触碰真实登录态。
func syntheticClaudeReader() *nativeartifact.Reader {
	files := map[string]string{
		"/home/import-case/.claude/.credentials.json": `{"claudeAiOauth":{` +
			`"accessToken":"` + syntheticAccessToken + `",` +
			`"refreshToken":"` + syntheticRefreshToken + `",` +
			`"expiresAt":4102444800000,` +
			`"scopes":["user:inference","user:profile"],` +
			`"subscriptionType":"max",` +
			`"rateLimitTier":"default_claude_max_20x"}}`,
		"/home/import-case/.claude.json": `{"oauthAccount":{` +
			`"accountUuid":"` + syntheticAccountUUID + `",` +
			`"emailAddress":"` + syntheticEmail + `"}}`,
	}
	return nativeartifact.New(nativeartifact.Options{
		LookupEnv:   func(string) (string, bool) { return "", false },
		UserHomeDir: func() (string, error) { return "/home/import-case", nil },
		ReadFile: func(path string) ([]byte, error) {
			content, found := files[path]
			if !found {
				return nil, os.ErrNotExist
			}
			return []byte(content), nil
		},
		ReadClaudeSecureStorage: func(string, bool) ([]byte, string, error) {
			return nil, "", os.ErrNotExist
		},
	})
}

// recordingRegistrar 记录注册输入并返回固定别名账号，不触碰数据库或网络。
type recordingRegistrar struct {
	t          *testing.T
	credential accountapp.Credential
	profile    accountapp.PublicProfile
	calls      int
}

// Register 保存注册输入并返回一个别名固定的账号。
func (registrar *recordingRegistrar) Register(
	_ context.Context,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
) (accountcore.Account, error) {
	registrar.t.Helper()

	registrar.calls++
	registrar.credential = credential
	registrar.profile = profile
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return accountcore.Account{}, err
	}
	cliAccountID, err := accountcore.NewCLIAccountID(7)
	if err != nil {
		return accountcore.Account{}, err
	}
	return accountcore.NewAccount(catalog, accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: cliAccountID,
		CreatedAt:    time.Date(2026, 8, 6, 0, 0, 0, 0, time.UTC),
	})
}

// modelSpec 描述一条持久化层已经物化的账号模型关系。
type modelSpec struct {
	modelID           string
	upstreamAvailable bool
	manualPolicy      accountapp.ModelManualPolicy
	updatedAt         time.Time
}

// stubModelReader 按注册返回的真实账号身份回读已物化模型关系。
type stubModelReader struct {
	t              *testing.T
	specs          []modelSpec
	overviews      []accountapp.AccountOverview
	overview       accountapp.AccountOverview
	accountByAlias accountcore.Account
	overviewQuery  accountapp.OverviewQuery
	overviewRef    accountcore.AccountRef
	overviewCalls  int
	aliasCalls     int
	detailCalls    int
	modelCalls     int
	modelRef       accountcore.AccountRef
	modelErr       error
	refreshCalls   int
	refreshRef     accountcore.AccountRef
	refreshErr     error
	policyCalls    int
	policyRef      accountcore.AccountRef
	policyModelID  string
	policyValue    accountapp.ModelManualPolicy
	policyErr      error
}

// ListAccountModels 用调用方传入的账号身份构造模型关系，保持身份一致。
func (reader *stubModelReader) ListAccountModels(
	_ context.Context,
	accountRef accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	reader.modelCalls++
	reader.modelRef = accountRef
	if reader.modelErr != nil {
		return nil, reader.modelErr
	}
	models := make([]accountapp.AccountModel, 0, len(reader.specs))
	for _, spec := range reader.specs {
		policy := spec.manualPolicy
		if policy == "" {
			policy = accountapp.ModelPolicyInherit
		}
		updatedAt := spec.updatedAt
		if updatedAt.IsZero() {
			updatedAt = time.Date(2026, 8, 6, 0, 0, 0, 0, time.UTC)
		}
		model, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
			AccountRef:        accountRef,
			ModelID:           spec.modelID,
			UpstreamAvailable: spec.upstreamAvailable,
			ManualPolicy:      policy,
			UpdatedAt:         updatedAt,
		})
		if err != nil {
			reader.t.Fatalf("NewAccountModel(%s) error = %v", spec.modelID, err)
		}
		models = append(models, model)
	}
	return models, nil
}

// RefreshAccountModels 记录刷新目标并返回同一组预设物化模型关系。
func (reader *stubModelReader) RefreshAccountModels(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	reader.refreshCalls++
	reader.refreshRef = accountRef
	if reader.refreshErr != nil {
		return nil, reader.refreshErr
	}
	return reader.ListAccountModels(ctx, accountRef)
}

// SetManualModelPolicy 记录人工策略并返回同一组预设模型关系。
func (reader *stubModelReader) SetManualModelPolicy(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	modelID string,
	policy accountapp.ModelManualPolicy,
) ([]accountapp.AccountModel, error) {
	reader.policyCalls++
	reader.policyRef = accountRef
	reader.policyModelID = modelID
	reader.policyValue = policy
	if reader.policyErr != nil {
		return nil, reader.policyErr
	}
	return reader.ListAccountModels(ctx, accountRef)
}

// ListAccountOverviews 返回预设的公开投影，并记录应用层生成的稳定查询。
func (reader *stubModelReader) ListAccountOverviews(
	_ context.Context,
	query accountapp.OverviewQuery,
) ([]accountapp.AccountOverview, error) {
	reader.overviewCalls++
	reader.overviewQuery = query
	return append([]accountapp.AccountOverview(nil), reader.overviews...), nil
}

// GetAccountOverview 返回指定稳定身份的公开详情投影。
func (reader *stubModelReader) GetAccountOverview(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.AccountOverview, error) {
	reader.detailCalls++
	reader.overviewRef = accountRef
	return reader.overview, nil
}

// GetByCLIAccountID 返回 Provider 数字别名对应的基础账号。
func (reader *stubModelReader) GetByCLIAccountID(
	_ context.Context,
	_ string,
	_ accountcore.CLIAccountID,
) (accountcore.Account, error) {
	reader.aliasCalls++
	return reader.accountByAlias, nil
}

// newAccountOverview 构造不读取凭据正文的账号列表投影。
func newAccountOverview(
	t *testing.T,
	accountRef string,
	providerID string,
	cliAccountID int64,
	enabled bool,
) accountapp.AccountOverview {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	ref, err := accountcore.ParseAccountRef(accountRef)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(cliAccountID)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref:          ref,
		ProviderID:   providerID,
		CLIAccountID: alias,
		Enabled:      enabled,
		CreatedAt:    time.Date(2026, 8, 6, 0, 0, 0, 0, time.UTC),
		UpdatedAt:    time.Date(2026, 8, 6, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	overview, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{
		Account:          account,
		HasCredential:    true,
		AuthKind:         "oauth",
		AuthMode:         "subscription",
		HasProfile:       true,
		DisplayName:      "测试账号",
		Email:            "account@example.invalid",
		SubscriptionKind: "plus",
		SubscriptionRaw:  "plus",
		ProfileUpdatedAt: time.Date(2026, 8, 6, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("NewAccountOverview() error = %v", err)
	}
	return overview
}
