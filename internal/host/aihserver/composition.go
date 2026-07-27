package aihserver

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/claudeoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/codexoauth"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/accountauthapi"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

const oauthHTTPTimeout = 10 * time.Second

// New 装配 Provider Catalog、aih.db、账号用例、OAuth Strategy 和 HTTP 入站适配器。
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
	accountsHandler, accountAuthHandler, err := newManagementHandlers(
		catalog,
		store,
		options.ManagementKey,
	)
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	return newServer(
		newRouter(accountsHandler, accountAuthHandler),
		store,
		options,
	), nil
}

// newManagementHandlers 共享 Registrar、Decoder 和鉴权策略，并保持两个 HTTP 接口隔离。
func newManagementHandlers(
	catalog *providers.Catalog,
	store *sqliteaccount.Store,
	managementKey func() string,
) (http.Handler, http.Handler, error) {
	registrar, err := accountapp.NewRegistrar(catalog, store, time.Now)
	if err != nil {
		return nil, nil, fmt.Errorf("创建账号注册用例失败: %w", err)
	}
	reauthenticator, err := accountapp.NewReauthenticator(
		catalog,
		store,
		time.Now,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("创建账号重新认证用例失败: %w", err)
	}
	management, err := accountapp.NewManagement(store, store, time.Now)
	if err != nil {
		return nil, nil, fmt.Errorf("创建账号管理用例失败: %w", err)
	}
	authorizer, err := accountsapi.NewBearerAuthorizer(managementKey)
	if err != nil {
		return nil, nil, fmt.Errorf("创建账号管理鉴权失败: %w", err)
	}
	decoder := nativeaccount.NewDecoder()
	accountsHandler, err := accountsapi.NewHandler(accountsapi.Dependencies{
		Management:     management,
		Registrar:      registrar,
		APIKeys:        accountsapi.NewBuiltinAPIKeyCredentialFactory(),
		NativeAccounts: decoder,
		Authorizer:     authorizer,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("创建账号 HTTP Handler 失败: %w", err)
	}
	oauthClient := &http.Client{
		Timeout:       oauthHTTPTimeout,
		CheckRedirect: rejectOAuthRedirect,
	}
	codexProvider, err := codexoauth.New(oauthClient, time.Now)
	if err != nil {
		return nil, nil, fmt.Errorf("创建 Codex OAuth Strategy 失败: %w", err)
	}
	claudeProvider, err := claudeoauth.New(oauthClient, time.Now)
	if err != nil {
		return nil, nil, fmt.Errorf("创建 Claude OAuth Strategy 失败: %w", err)
	}
	jobs, err := accountauth.NewService(accountauth.Dependencies{
		Providers: []accountauth.OAuthProvider{
			codexProvider,
			claudeProvider,
		},
		Decoder:    decoder,
		Registrar:  registrar,
		Reauth:     reauthenticator,
		Clock:      time.Now,
		GenerateID: accountauth.NewRandomJobID,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("创建 OAuth Job 服务失败: %w", err)
	}
	accountAuthHandler, err := accountauthapi.NewHandler(
		accountauthapi.Dependencies{
			Jobs:       jobs,
			Authorizer: authorizer,
		},
	)
	if err != nil {
		return nil, nil, fmt.Errorf("创建 OAuth Job HTTP Handler 失败: %w", err)
	}
	return accountsHandler, accountAuthHandler, nil
}

// rejectOAuthRedirect 防止 Token 或 Profile 请求被重定向到未审计主机。
func rejectOAuthRedirect(
	_ *http.Request,
	_ []*http.Request,
) error {
	return http.ErrUseLastResponse
}
