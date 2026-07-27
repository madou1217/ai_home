package aihserver

import (
	"context"
	"fmt"
	"net/http"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// New 装配 Provider Catalog、aih.db、账号用例和 HTTP 入站适配器。
func New(ctx context.Context, options Options) (*Server, error) {
	if err := validateOptions(options); err != nil {
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
	handler, err := newAccountsHandler(catalog, store, options.ManagementKey)
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	return newServer(newRouter(handler), store, options), nil
}

// newAccountsHandler 把账号应用端口装配到版本化 HTTP Handler。
func newAccountsHandler(
	catalog *providers.Catalog,
	store *sqliteaccount.Store,
	managementKey func() string,
) (http.Handler, error) {
	registrar, err := accountapp.NewRegistrar(catalog, store, time.Now)
	if err != nil {
		return nil, fmt.Errorf("创建账号注册用例失败: %w", err)
	}
	management, err := accountapp.NewManagement(store, store, time.Now)
	if err != nil {
		return nil, fmt.Errorf("创建账号管理用例失败: %w", err)
	}
	authorizer, err := accountsapi.NewBearerAuthorizer(managementKey)
	if err != nil {
		return nil, fmt.Errorf("创建账号管理鉴权失败: %w", err)
	}
	handler, err := accountsapi.NewHandler(accountsapi.Dependencies{
		Management: management,
		Registrar:  registrar,
		APIKeys:    accountsapi.NewBuiltinAPIKeyCredentialFactory(),
		Authorizer: authorizer,
	})
	if err != nil {
		return nil, fmt.Errorf("创建账号 HTTP Handler 失败: %w", err)
	}
	return handler, nil
}
