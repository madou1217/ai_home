// Package aihaccount 装配 AIH 账号管理命令使用的单库、注册用例与模型物化。
package aihaccount

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeartifact"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	claudemessages "github.com/madou1217/ai_home/internal/adapters/claude/messages"
	codexresponses "github.com/madou1217/ai_home/internal/adapters/codex/responses"
)

// modelCatalogHTTPTimeout 限制账号管理阶段一次模型目录请求的等待时间。
const modelCatalogHTTPTimeout = 60 * time.Second

var (
	// ErrInvalidOptions 表示账号管理组合根缺少唯一数据目录。
	ErrInvalidOptions = errors.New("AIH 账号管理组合配置无效")
	// ErrInvalidImportRequest 表示导入请求的 Context 或 Provider 无效。
	ErrInvalidImportRequest = errors.New("AIH 账号导入请求无效")
)

// Options 是账号管理组合根唯一允许的外部依赖。
type Options struct {
	// AIHomeDir 是唯一业务数据库 aih.db 的数据根，不是 Provider HOME。
	AIHomeDir string
	// ArtifactReader 仅供测试替换官方 artifact 文件边界。
	ArtifactReader *nativeartifact.Reader
	// ModelCatalogHTTPClient 仅供测试替换模型目录网络边界。
	ModelCatalogHTTPClient *http.Client
}

// accountRegistrar 隔离账号注册用例，便于 Host 只负责组合与生命周期。
type accountRegistrar interface {
	Register(
		ctx context.Context,
		credential accountapp.Credential,
		profile accountapp.PublicProfile,
	) (accountcore.Account, error)
}

// accountModelReader 隔离注册后回读真实物化模型目录的持久化端口。
type accountModelReader interface {
	ListAccountModels(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) ([]accountapp.AccountModel, error)
}

// ImportResult 是一次官方登录态导入的公开结果，绝不包含任何凭据。
type ImportResult struct {
	// ProviderID 是导入账号所属的规范 Provider。
	ProviderID string
	// CLIAccountID 是持久化层原子分配的 Provider 内数字别名。
	CLIAccountID int64
	// AccountRef 是由凭据派生的稳定账号身份。
	AccountRef string
	// Email 是官方公开资料中的登录邮箱，用于确认导入的是哪个登录。
	Email string
	// Models 是本次在账号管理阶段物化的真实可用模型。
	Models []string
	// Sources 是本次读取的官方 artifact 文件路径。
	Sources []string
}

// App 持有一次账号管理进程生命周期内的单库与用例装配。
type App struct {
	decoder   *nativeaccount.Decoder
	reader    *nativeartifact.Reader
	registrar accountRegistrar
	models    accountModelReader
	resources []io.Closer
}

// New 装配 Provider Catalog、aih.db、模型目录发现与账号注册用例。
func New(ctx context.Context, options Options) (*App, error) {
	if ctx == nil || strings.TrimSpace(options.AIHomeDir) == "" {
		return nil, ErrInvalidOptions
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil, fmt.Errorf("创建 Provider Catalog 失败: %w", err)
	}
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: options.AIHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		return nil, fmt.Errorf("打开账号数据库失败: %w", err)
	}
	fail := func(message string, cause error) (*App, error) {
		_ = store.Close()
		return nil, fmt.Errorf("%s: %w", message, cause)
	}

	catalogClient := options.ModelCatalogHTTPClient
	if catalogClient == nil {
		catalogClient = &http.Client{Timeout: modelCatalogHTTPTimeout}
	}
	claudeModels, err := claudemessages.NewModelCatalogSource(catalogClient)
	if err != nil {
		return fail("创建 Claude 模型目录适配器失败", err)
	}
	codexModels, err := codexresponses.NewModelCatalogSource(catalogClient)
	if err != nil {
		return fail("创建 Codex 模型目录适配器失败", err)
	}
	discovery, err := accountapp.NewModelDiscovery(
		catalog,
		[]accountapp.ProviderModelDiscoverer{claudeModels, codexModels},
	)
	if err != nil {
		return fail("创建账号模型发现注册表失败", err)
	}
	registrar, err := accountapp.NewRegistrar(catalog, store, discovery, time.Now)
	if err != nil {
		return fail("创建账号注册用例失败", err)
	}
	reader := options.ArtifactReader
	if reader == nil {
		reader = nativeartifact.New(nativeartifact.Options{})
	}
	return newApp(nativeaccount.NewDecoder(), reader, registrar, store, store)
}

// newApp 统一生产和包内测试的不变量校验。
func newApp(
	decoder *nativeaccount.Decoder,
	reader *nativeartifact.Reader,
	registrar accountRegistrar,
	models accountModelReader,
	resources ...io.Closer,
) (*App, error) {
	if decoder == nil || reader == nil || registrar == nil || models == nil {
		return nil, ErrInvalidOptions
	}
	for _, resource := range resources {
		if resource == nil {
			return nil, ErrInvalidOptions
		}
	}
	return &App{
		decoder:   decoder,
		reader:    reader,
		registrar: registrar,
		models:    models,
		resources: append([]io.Closer(nil), resources...),
	}, nil
}

// ImportOfficialLogin 把该 Provider 官方 CLI 当前登录态注册成一个 AIH 账号。
//
// 导入阶段会按账号管理契约拉取一次该账号真实可用的模型目录并落库，
// 运行期不再实时查询上游目录。
func (app *App) ImportOfficialLogin(
	ctx context.Context,
	providerID string,
) (ImportResult, error) {
	if app == nil || ctx == nil {
		return ImportResult{}, ErrInvalidImportRequest
	}
	if err := ctx.Err(); err != nil {
		return ImportResult{}, err
	}
	if !app.decoder.Supports(providerID) || !app.reader.Supports(providerID) {
		return ImportResult{}, fmt.Errorf(
			"%w: 当前只支持 codex 和 claude",
			ErrInvalidImportRequest,
		)
	}
	artifacts, err := app.reader.Read(providerID)
	if err != nil {
		return ImportResult{}, fmt.Errorf("读取 %s 官方登录态失败: %w", providerID, err)
	}
	defer clear(artifacts.Envelope)

	credential, profile, err := app.decoder.Decode(providerID, artifacts.Envelope)
	if err != nil {
		return ImportResult{}, fmt.Errorf("解码 %s 官方登录态失败: %w", providerID, err)
	}
	account, err := app.registrar.Register(ctx, credential, profile)
	if err != nil {
		return ImportResult{}, fmt.Errorf("注册 %s 账号失败: %w", providerID, err)
	}
	models, err := app.models.ListAccountModels(ctx, account.Ref())
	if err != nil {
		return ImportResult{}, fmt.Errorf("读取账号模型目录失败: %w", err)
	}
	return ImportResult{
		ProviderID:   account.ProviderID(),
		CLIAccountID: account.CLIAccountID().Int64(),
		AccountRef:   account.Ref().String(),
		Email:        profileEmail(profile),
		Models:       effectiveModelIDs(models),
		Sources:      artifacts.Sources,
	}, nil
}

// profileEmail 只在存在官方公开资料时回显登录邮箱。
func profileEmail(profile accountapp.PublicProfile) string {
	if profile == nil {
		return ""
	}
	return profile.Email()
}

// effectiveModelIDs 只返回当前真实生效的模型，供调用方选择验收模型。
func effectiveModelIDs(models []accountapp.AccountModel) []string {
	values := make([]string, 0, len(models))
	for _, model := range models {
		if model.Effective() {
			values = append(values, model.ModelID().String())
		}
	}
	return values
}

// Close 逆序释放单库等组合资源。
func (app *App) Close() error {
	if app == nil {
		return nil
	}
	var err error
	for index := len(app.resources) - 1; index >= 0; index-- {
		err = errors.Join(err, app.resources[index].Close())
	}
	app.resources = nil
	return err
}
