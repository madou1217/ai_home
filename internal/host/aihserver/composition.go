package aihserver

import (
	"context"
	"crypto/rand"
	"fmt"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/clauderelay"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/claudeoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/codexoauth"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	claudemessages "github.com/madou1217/ai_home/internal/adapters/claude/messages"
	codexresponses "github.com/madou1217/ai_home/internal/adapters/codex/responses"
	"github.com/madou1217/ai_home/internal/transport/http/accountauthapi"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/claudenativerelay"
	"github.com/madou1217/ai_home/internal/transport/http/clauderelayleaseapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelsapi"
)

const (
	oauthHTTPTimeout        = 10 * time.Second
	claudeRelayHTTPTimeout  = 10 * time.Minute
	modelCatalogHTTPTimeout = 15 * time.Second
)

// serverHandlers 保存 Composition Root 创建的五个独立 HTTP 边界。
type serverHandlers struct {
	accounts          http.Handler
	accountAuth       http.Handler
	models            http.Handler
	claudeRelayLeases http.Handler
	claudeNativeRelay http.Handler
}

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
	modelDiscovery, err := newModelDiscovery(catalog, options.ModelDiscoverers)
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	handlers, err := newHandlers(
		catalog,
		store,
		modelDiscovery,
		options.ManagementKey,
		options.ClientKey,
	)
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	return newServer(
		newRouter(handlers),
		store,
		options,
	), nil
}

// newHandlers 共享数据库、凭据刷新和鉴权端口，并保持五个 HTTP 边界隔离。
func newHandlers(
	catalog *providers.Catalog,
	store *sqliteaccount.Store,
	modelDiscovery *accountapp.ModelDiscovery,
	managementKey func() string,
	clientKey func() string,
) (serverHandlers, error) {
	registrar, err := accountapp.NewRegistrar(
		catalog,
		store,
		modelDiscovery,
		time.Now,
	)
	if err != nil {
		return serverHandlers{}, fmt.Errorf("创建账号注册用例失败: %w", err)
	}
	reauthenticator, err := accountapp.NewReauthenticator(
		catalog,
		store,
		modelDiscovery,
		time.Now,
	)
	if err != nil {
		return serverHandlers{}, fmt.Errorf("创建账号重新认证用例失败: %w", err)
	}
	management, err := accountapp.NewManagement(store, store, time.Now)
	if err != nil {
		return serverHandlers{}, fmt.Errorf("创建账号管理用例失败: %w", err)
	}
	modelManagement, err := accountapp.NewModelManagement(
		store,
		store,
		modelDiscovery,
		time.Now,
	)
	if err != nil {
		return serverHandlers{}, fmt.Errorf("创建账号模型管理用例失败: %w", err)
	}
	authorizer, err := accountsapi.NewBearerAuthorizer(managementKey)
	if err != nil {
		return serverHandlers{}, fmt.Errorf("创建账号管理鉴权失败: %w", err)
	}
	clientAuthorizer, err := accountsapi.NewBearerAuthorizer(clientKey)
	if err != nil {
		return serverHandlers{}, fmt.Errorf("创建客户端鉴权失败: %w", err)
	}
	modelsHandler, err := modelsapi.NewHandler(modelsapi.Dependencies{
		Models:     store,
		Authorizer: clientAuthorizer,
	})
	if err != nil {
		return serverHandlers{}, fmt.Errorf("创建本地模型目录 Handler 失败: %w", err)
	}
	decoder := nativeaccount.NewDecoder()
	accountsHandler, err := accountsapi.NewHandler(accountsapi.Dependencies{
		Management:     management,
		Models:         modelManagement,
		Registrar:      registrar,
		APIKeys:        accountsapi.NewBuiltinAPIKeyCredentialFactory(),
		NativeAccounts: decoder,
		Authorizer:     authorizer,
	})
	if err != nil {
		return serverHandlers{}, fmt.Errorf("创建账号 HTTP Handler 失败: %w", err)
	}
	oauthClient := &http.Client{
		Timeout:       oauthHTTPTimeout,
		CheckRedirect: rejectOAuthRedirect,
	}
	codexProvider, err := codexoauth.New(oauthClient, time.Now)
	if err != nil {
		return serverHandlers{}, fmt.Errorf("创建 Codex OAuth Strategy 失败: %w", err)
	}
	claudeProvider, err := claudeoauth.New(oauthClient, time.Now)
	if err != nil {
		return serverHandlers{}, fmt.Errorf("创建 Claude OAuth Strategy 失败: %w", err)
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
		return serverHandlers{}, fmt.Errorf("创建 OAuth Job 服务失败: %w", err)
	}
	accountAuthHandler, err := accountauthapi.NewHandler(
		accountauthapi.Dependencies{
			Jobs:       jobs,
			Authorizer: authorizer,
		},
	)
	if err != nil {
		return serverHandlers{}, fmt.Errorf("创建 OAuth Job HTTP Handler 失败: %w", err)
	}
	credentials, err := accountcredentials.NewResolver(
		accountcredentials.Dependencies{
			Store:      store,
			Strategies: []accountcredentials.RefreshStrategy{claudeProvider},
			Clock:      time.Now,
		},
	)
	if err != nil {
		return serverHandlers{}, fmt.Errorf("创建 Claude 凭据解析器失败: %w", err)
	}
	relayLeases, err := clauderelay.NewLeaseRegistry(
		clauderelay.Dependencies{
			Random: rand.Reader,
			Clock:  time.Now,
		},
	)
	if err != nil {
		return serverHandlers{}, fmt.Errorf("创建 Claude Relay 租约注册表失败: %w", err)
	}
	relayAuthorizer, err := claudenativerelay.NewScopedTokenAuthorizer(
		relayLeases,
	)
	if err != nil {
		return serverHandlers{}, fmt.Errorf("创建 Claude Relay 鉴权失败: %w", err)
	}
	relayLeaseHandler, err := clauderelayleaseapi.NewHandler(
		clauderelayleaseapi.Dependencies{
			Authorizer:  authorizer,
			Credentials: credentials,
			Leases:      relayLeases,
		},
	)
	if err != nil {
		return serverHandlers{}, fmt.Errorf("创建 Claude Relay 租约 Handler 失败: %w", err)
	}
	relayClient := &http.Client{
		Timeout:       claudeRelayHTTPTimeout,
		CheckRedirect: rejectOAuthRedirect,
	}
	nativeRelayHandler, err := claudenativerelay.NewHandler(
		claudenativerelay.Dependencies{
			Authorizer:  relayAuthorizer,
			Credentials: credentials,
			Client:      relayClient,
		},
	)
	if err != nil {
		return serverHandlers{}, fmt.Errorf("创建 Claude Native Relay Handler 失败: %w", err)
	}
	return serverHandlers{
		accounts:          accountsHandler,
		accountAuth:       accountAuthHandler,
		models:            modelsHandler,
		claudeRelayLeases: relayLeaseHandler,
		claudeNativeRelay: nativeRelayHandler,
	}, nil
}

// newModelDiscovery 创建生产 Codex/Claude 目录源，或使用测试显式注入的策略。
func newModelDiscovery(
	catalog *providers.Catalog,
	injected []accountapp.ProviderModelDiscoverer,
) (*accountapp.ModelDiscovery, error) {
	strategies := injected
	if len(strategies) == 0 {
		client := &http.Client{
			Timeout:       modelCatalogHTTPTimeout,
			CheckRedirect: rejectOAuthRedirect,
		}
		codexSource, err := codexresponses.NewModelCatalogSource(client)
		if err != nil {
			return nil, fmt.Errorf("创建 Codex 模型目录源失败: %w", err)
		}
		claudeSource, err := claudemessages.NewModelCatalogSource(client)
		if err != nil {
			return nil, fmt.Errorf("创建 Claude 模型目录源失败: %w", err)
		}
		strategies = []accountapp.ProviderModelDiscoverer{
			codexSource,
			claudeSource,
		}
	}
	discovery, err := accountapp.NewModelDiscovery(catalog, strategies)
	if err != nil {
		return nil, fmt.Errorf("创建账号模型发现注册表失败: %w", err)
	}
	return discovery, nil
}

// rejectOAuthRedirect 防止 Token 或 Profile 请求被重定向到未审计主机。
func rejectOAuthRedirect(
	_ *http.Request,
	_ []*http.Request,
) error {
	return http.ErrUseLastResponse
}
