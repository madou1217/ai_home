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

// ErrInvalidOptions 表示账号管理组合根缺少唯一数据目录。
var ErrInvalidOptions = errors.New("AIH 账号管理组合配置无效")

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

// accountModelManager 隔离刷新目录与人工策略两个账号模型写端口。
type accountModelManager interface {
	RefreshAccountModels(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) ([]accountapp.AccountModel, error)
	SetManualModelPolicy(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		modelID string,
		policy accountapp.ModelManualPolicy,
	) ([]accountapp.AccountModel, error)
}

// accountReader 聚合账号管理 Host 当前需要的只读端口。
// 所有查询都由同一个 SQLite Store 实现，不引入第二份账号状态。
type accountReader interface {
	accountModelReader
	ListAccountOverviews(
		ctx context.Context,
		query accountapp.OverviewQuery,
	) ([]accountapp.AccountOverview, error)
	GetAccountOverview(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountapp.AccountOverview, error)
	GetByCLIAccountID(
		ctx context.Context,
		providerID string,
		cliAccountID accountcore.CLIAccountID,
	) (accountcore.Account, error)
}

// App 持有一次账号管理进程生命周期内的单库与用例装配。
type App struct {
	decoder   *nativeaccount.Decoder
	reader    *nativeartifact.Reader
	registrar accountRegistrar
	accounts  accountReader
	models    accountModelManager
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
	registrar, err := accountapp.NewRegistrar(catalog, store, time.Now)
	if err != nil {
		return fail("创建账号注册用例失败", err)
	}
	modelManagement, err := accountapp.NewModelManagement(
		store,
		store,
		discovery,
		time.Now,
	)
	if err != nil {
		return fail("创建账号模型管理用例失败", err)
	}
	reader := options.ArtifactReader
	if reader == nil {
		reader = nativeartifact.New(nativeartifact.Options{})
	}
	return newApp(
		nativeaccount.NewDecoder(),
		reader,
		registrar,
		store,
		modelManagement,
		store,
	)
}

// newApp 统一生产和包内测试的不变量校验。
func newApp(
	decoder *nativeaccount.Decoder,
	reader *nativeartifact.Reader,
	registrar accountRegistrar,
	accounts accountReader,
	models accountModelManager,
	resources ...io.Closer,
) (*App, error) {
	if decoder == nil ||
		reader == nil ||
		registrar == nil ||
		accounts == nil ||
		models == nil {
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
		accounts:  accounts,
		models:    models,
		resources: append([]io.Closer(nil), resources...),
	}, nil
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
