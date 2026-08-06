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

// TestImportOfficialLoginRejectsUnsupportedProvider 验证不支持的 Provider 不会
// 触发任何文件读取或注册。
func TestImportOfficialLoginRejectsUnsupportedProvider(t *testing.T) {
	t.Parallel()

	registrar := &recordingRegistrar{t: t}
	app, err := newApp(
		nativeaccount.NewDecoder(),
		syntheticClaudeReader(),
		registrar,
		&stubModelReader{},
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
	})
	app, err := newApp(nativeaccount.NewDecoder(), reader, registrar, &stubModelReader{})
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
}

// stubModelReader 按注册返回的真实账号身份回读已物化模型关系。
type stubModelReader struct {
	t     *testing.T
	specs []modelSpec
}

// ListAccountModels 用调用方传入的账号身份构造模型关系，保持身份一致。
func (reader *stubModelReader) ListAccountModels(
	_ context.Context,
	accountRef accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	models := make([]accountapp.AccountModel, 0, len(reader.specs))
	for _, spec := range reader.specs {
		model, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
			AccountRef:        accountRef,
			ModelID:           spec.modelID,
			UpstreamAvailable: spec.upstreamAvailable,
			ManualPolicy:      accountapp.ModelPolicyInherit,
			UpdatedAt:         time.Date(2026, 8, 6, 0, 0, 0, 0, time.UTC),
		})
		if err != nil {
			reader.t.Fatalf("NewAccountModel(%s) error = %v", spec.modelID, err)
		}
		models = append(models, model)
	}
	return models, nil
}
