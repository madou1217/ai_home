package aihserver

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/agyoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/claudeoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/clineoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/codexoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/geminioauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/grokoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/kimioauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/kirooauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/staticcredential"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/tokenrefresh"
	"github.com/madou1217/ai_home/internal/adapters/accounts/kirocred"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	agycodeassist "github.com/madou1217/ai_home/internal/adapters/agy/codeassist"
	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
	agyprojection "github.com/madou1217/ai_home/internal/adapters/agy/projection"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/images"
	"github.com/madou1217/ai_home/internal/transport/http/codebuddyfamilyrelay"
	"github.com/madou1217/ai_home/internal/runtime/imagestudio"
	"github.com/madou1217/ai_home/internal/runtime/translation"
	"github.com/madou1217/ai_home/internal/transport/http/imagesapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiimagestudioapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuitranslationapi"
)

const translationStudioOverviewPageLimit = 200

type translationStudioOverviewLister struct {
	store *sqliteaccount.Store
}

func (l translationStudioOverviewLister) ListAccountOverviews(ctx context.Context) ([]accountapp.AccountOverview, error) {
	if l.store == nil {
		return nil, nil
	}
	var all []accountapp.AccountOverview
	cursor := accountcore.AccountRef("")
	for page := 0; page < translationStudioOverviewPageLimit; page++ {
		query, err := accountapp.NewOverviewQuery(cursor, accountapp.MaxOverviewLimit)
		if err != nil {
			return nil, err
		}
		batch, err := l.store.ListAccountOverviews(ctx, query)
		if err != nil {
			return nil, err
		}
		if len(batch) == 0 {
			break
		}
		all = append(all, batch...)
		if len(batch) < accountapp.MaxOverviewLimit {
			break
		}
		next := batch[len(batch)-1].Account().Ref()
		if next == "" || next == cursor {
			break
		}
		cursor = next
	}
	return all, nil
}

// buildWebUITranslationStudioRoutes 装配 AI 翻译页与生图工作台的全部 Go 管理端路由。
//
// 翻译设置、多语种判定、Provider 凭据/路由与流式对冲全部落在 internal/runtime/translation 与
// internal/transport/http/webuitranslationapi；Image Studio 会话、资产与生图编排落在
// internal/runtime/imagestudio 与 internal/transport/http/webuiimagestudioapi；Node 侧只做薄代理。
func buildWebUITranslationStudioRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil {
		return nil, fmt.Errorf("翻译与生图工作台路由缺少 Authorizer")
	}

	aiHomeDir := strings.TrimSpace(dependencies.AIHomeDir)
	if aiHomeDir == "" && strings.TrimSpace(dependencies.HostHomeDir) != "" {
		aiHomeDir = filepath.Join(strings.TrimSpace(dependencies.HostHomeDir), ".ai_home")
	}

	var overviewLister translationStudioOverviewLister
	var translationAccounts translation.AccountOverviewLister
	var translationModels translation.AccountModelLister
	var translationAliases translation.ModelAliasLister
	var translationExclusions translation.RoutingExclusionReader
	var studioAccounts imagestudio.AccountOverviewLister
	var studioModels imagestudio.AccountModelLister
	var studioExclusions imagestudio.RoutingExclusionReader

	if dependencies.Store != nil {
		overviewLister = translationStudioOverviewLister{store: dependencies.Store}
		translationAccounts = overviewLister
		translationModels = dependencies.Store
		translationAliases = dependencies.Store
		translationExclusions = dependencies.Store
		studioAccounts = overviewLister
		studioModels = dependencies.Store
		studioExclusions = dependencies.Store
	}

	translationRuntime, _ := dependencies.AccountRuntime.(translation.EligibilityChecker)
	studioRuntime, _ := dependencies.AccountRuntime.(imagestudio.EligibilityChecker)
	usageRecorder, _ := dependencies.AccountRuntime.(imagesapi.UsageRecorder)
	imageOutcomes, _ := dependencies.AccountRuntime.(imagesapi.ImageOutcomes)

	translationHandler, err := webuitranslationapi.NewHandler(webuitranslationapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		AIHomeDir:  aiHomeDir,
		Catalog: translation.CatalogDependencies{
			Accounts:      translationAccounts,
			AccountModels: translationModels,
			Aliases:       translationAliases,
			Exclusions:    translationExclusions,
			Runtime:       translationRuntime,
			Providers:     dependencies.Catalog,
			Modalities:    dependencies.ModelModalities,
		},
		Gateway: buildTranslationGatewayConfig(dependencies),
	})
	if err != nil {
		return nil, fmt.Errorf("创建 AI 翻译 HTTP 处理器失败: %w", err)
	}

	studioStore, err := imagestudio.NewStore(imagestudio.StoreOptions{
		AIHomeDir: aiHomeDir,
		Now:       time.Now,
	})
	if err != nil {
		return nil, fmt.Errorf("初始化 Image Studio 存储失败: %w", err)
	}

	imageAccountSource, err := buildImageStudioAccountSource(dependencies, aiHomeDir)
	if err != nil {
		return nil, fmt.Errorf("创建 Image Studio 账号征召器失败: %w", err)
	}

	imageFetcher := images.NewFetcher(http.DefaultClient)
	studioService, err := imagestudio.NewService(imagestudio.ServiceDependencies{
		Store: studioStore,
		Catalog: imagestudio.CatalogDependencies{
			Accounts:      studioAccounts,
			AccountModels: studioModels,
			Exclusions:    studioExclusions,
			Runtime:       studioRuntime,
			Providers:     dependencies.Catalog,
			Modalities:    dependencies.ModelModalities,
		},
		Registry: images.NewRegistry(
			images.ChatGPTCodexBaseURL,
			agycodeassist.GenerateContentURL,
			imageFetcher,
		),
		Accounts: imageAccountSource,
		HTTP:     http.DefaultClient,
		Fetcher:  imageFetcher,
		Usage:    usageRecorder,
		Outcomes: imageOutcomes,
		Now:      time.Now,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 Image Studio 领域服务失败: %w", err)
	}

	studioHandler, err := webuiimagestudioapi.NewHandler(webuiimagestudioapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		Service:    studioService,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 Image Studio HTTP 处理器失败: %w", err)
	}

	return []webuiRoute{
		{Pattern: "OPTIONS " + webuitranslationapi.Path + "/{rest...}", Handler: translationHandler},
		{Pattern: "GET " + webuitranslationapi.Path + "/settings", Handler: translationHandler},
		{Pattern: "POST " + webuitranslationapi.Path + "/settings", Handler: translationHandler},
		{Pattern: "GET " + webuitranslationapi.Path + "/providers", Handler: translationHandler},
		{Pattern: "POST " + webuitranslationapi.Path + "/providers", Handler: translationHandler},
		{Pattern: "GET " + webuitranslationapi.Path + "/languages", Handler: translationHandler},
		{Pattern: "POST " + webuitranslationapi.Path + "/detect", Handler: translationHandler},
		{Pattern: "GET " + webuitranslationapi.Path + "/models", Handler: translationHandler},
		{Pattern: "POST " + webuitranslationapi.Path + "/stream", Handler: translationHandler},
		{Pattern: "GET " + webuiimagestudioapi.Path + "/models", Handler: studioHandler},
		{Pattern: "GET " + webuiimagestudioapi.Path + "/sessions", Handler: studioHandler},
		{Pattern: "POST " + webuiimagestudioapi.Path + "/sessions", Handler: studioHandler},
		{Pattern: "GET " + webuiimagestudioapi.Path + "/sessions/{sessionId}", Handler: studioHandler},
		{Pattern: "PATCH " + webuiimagestudioapi.Path + "/sessions/{sessionId}", Handler: studioHandler},
		{Pattern: "DELETE " + webuiimagestudioapi.Path + "/sessions/{sessionId}", Handler: studioHandler},
		{Pattern: "POST " + webuiimagestudioapi.Path + "/sessions/{sessionId}/runs", Handler: studioHandler},
		{Pattern: "GET " + webuiimagestudioapi.Path + "/sessions/{sessionId}/assets/{assetId}", Handler: studioHandler},
	}, nil
}

func buildTranslationGatewayConfig(dependencies webuiRouteDependencies) translation.GatewayConfig {
	return translation.GatewayConfig{
		BaseURL: func() string {
			if envBase := strings.TrimSpace(os.Getenv("AIH_GATEWAY_BASE_URL")); envBase != "" {
				return envBase
			}
			host := strings.TrimSpace(os.Getenv("AIH_SERVER_HOST"))
			if host == "" {
				host = "127.0.0.1"
			}
			port := strings.TrimSpace(os.Getenv("AIH_SERVER_PORT"))
			if port != "" && port != "0" {
				return "http://" + net.JoinHostPort(host, port)
			}
			if nodeBase := strings.TrimSpace(dependencies.NodeBaseURL); nodeBase != "" {
				return nodeBase
			}
			return "http://" + net.JoinHostPort(host, "9527")
		},
		ClientKey: func() string {
			if key := strings.TrimSpace(os.Getenv("AIH_GATEWAY_API_KEY")); key != "" {
				return key
			}
			if key := strings.TrimSpace(os.Getenv("AIH_SERVER_API_KEY")); key != "" {
				return key
			}
			if dependencies.ManagementKey != nil {
				return strings.TrimSpace(dependencies.ManagementKey())
			}
			return ""
		},
	}
}

func buildImageStudioAccountSource(
	dependencies webuiRouteDependencies,
	aiHomeDir string,
) (images.AccountSource, error) {
	if dependencies.Store == nil || dependencies.Catalog == nil {
		return nil, nil
	}
	runtimeEligibility, ok := dependencies.AccountRuntime.(accountrouting.RuntimeEligibilitySource)
	if !ok || runtimeEligibility == nil {
		return nil, nil
	}
	weights, _ := dependencies.AccountRuntime.(accountrouting.AccountWeightSource)

	credentials, err := buildImageStudioCredentialResolver(dependencies.Store, aiHomeDir)
	if err != nil {
		return nil, err
	}

	strategy, err := accountrouting.ParseSelectionStrategy(os.Getenv("AIH_SERVER_STRATEGY"))
	if err != nil {
		return nil, err
	}

	var usageGate accountrouting.UsageGate
	if dependencies.UsageService != nil && aiHomeDir != "" {
		usageGate = newUsageSchedulingGate(dependencies.UsageService, aiHomeDir, time.Now)
	}

	recruiter, err := accountrouting.NewRecruiter(accountrouting.Dependencies{
		Candidates:  dependencies.Store,
		Runtime:     runtimeEligibility,
		Credentials: credentials,
		Weights:     weights,
		Usage:       usageGate,
		Strategy:    strategy,
	})
	if err != nil {
		return nil, err
	}

	return imageAccountSource{
		catalog:    dependencies.Catalog,
		recruiter:  recruiter,
		transports: imageTransportPolicy{},
	}, nil
}

func buildImageStudioCredentialResolver(
	store *sqliteaccount.Store,
	aiHomeDir string,
) (*accountcredentials.Resolver, error) {
	oauthClient := &http.Client{
		Timeout:       oauthHTTPTimeout,
		CheckRedirect: rejectOAuthRedirect,
	}
	kiroRefresher, err := kirocred.New(
		store,
		&http.Client{
			Timeout:       modelCatalogHTTPTimeout,
			CheckRedirect: rejectOAuthRedirect,
		},
		time.Now,
	)
	if err != nil {
		return nil, err
	}
	kiroProvider, err := kirooauth.New(kiroRefresher)
	if err != nil {
		return nil, err
	}
	kimiProvider, err := kimioauth.New(oauthClient, kimioauth.Options{ClientVersion: kimiClientVersion()})
	if err != nil {
		return nil, err
	}
	codexProvider, err := codexoauth.New(oauthClient, time.Now)
	if err != nil {
		return nil, err
	}
	claudeProvider, err := claudeoauth.New(oauthClient, time.Now)
	if err != nil {
		return nil, err
	}

	agyEgress := agyegress.NewResolver(agyegress.Options{AIHomeDir: aiHomeDir})
	agyProvider, err := agyoauth.NewWithEgress(
		oauthClient,
		func(proxyURL string) agyoauth.HTTPClient {
			return newOAuthEgressClient(proxyURL, oauthHTTPTimeout)
		},
		func(ctx context.Context, accountRef accountcore.AccountRef) (agyoauth.Egress, error) {
			decision, resolveErr := agyEgress.Resolve(ctx, accountRef)
			if resolveErr != nil {
				return agyoauth.Egress{}, resolveErr
			}
			if !decision.Bound {
				return agyoauth.Egress{Mode: "default"}, nil
			}
			if decision.Target.Direct || strings.TrimSpace(decision.Target.ProxyURL) == "" {
				return agyoauth.Egress{Mode: "direct"}, nil
			}
			return agyoauth.Egress{Mode: "proxy", ProxyURL: decision.Target.ProxyURL}, nil
		},
	)
	if err != nil {
		return nil, err
	}

	geminiProvider, err := geminioauth.New(oauthClient, geminioauth.Options{})
	if err != nil {
		return nil, err
	}
	grokProvider, err := grokoauth.New(oauthClient, grokoauth.Options{})
	if err != nil {
		return nil, err
	}
	clineProvider, err := clineoauth.New(oauthClient, clineoauth.Options{})
	if err != nil {
		return nil, err
	}
	geminiStrategy, err := tokenrefresh.NewStrategy(geminiProvider)
	if err != nil {
		return nil, err
	}
	grokStrategy, err := tokenrefresh.NewStrategy(grokProvider)
	if err != nil {
		return nil, err
	}
	clineStrategy, err := tokenrefresh.NewStrategy(clineProvider)
	if err != nil {
		return nil, err
	}

	strategies := []accountcredentials.RefreshStrategy{
		codexProvider,
		claudeProvider,
		agyProvider,
		kimiProvider,
		kiroProvider,
		geminiStrategy,
		grokStrategy,
		clineStrategy,
	}
	staticProviders := append(
		append([]string{}, codebuddyfamilyrelay.FamilyProviders...),
		"qoder",
		"qodercn",
		"zcode",
	)
	for _, providerID := range staticProviders {
		strategy, staticErr := staticcredential.New(providerID)
		if staticErr != nil {
			return nil, staticErr
		}
		strategies = append(strategies, strategy)
	}

	appStateDBPath, appStatePathErr := appstate.DatabasePath(aiHomeDir)
	delegateRefresh := strings.EqualFold(strings.TrimSpace(os.Getenv("AIH_SERVER_CREDENTIAL_REFRESH")), "delegated")

	return accountcredentials.NewResolver(accountcredentials.Dependencies{
		Store:            store,
		Strategies:       strategies,
		Clock:            time.Now,
		RefreshDelegated: delegateRefresh,
		OwnsRefresh: func(accountRef accountcore.AccountRef) bool {
			if overview, overviewErr := store.GetAccountOverview(context.Background(), accountRef); overviewErr == nil &&
				overview.Account().ProviderID() == "agy" {
				return true
			}
			if appStatePathErr != nil {
				return false
			}
			_, found, lookupErr := appstate.LookupNodeAccountProvider(
				context.Background(),
				appStateDBPath,
				accountRef.String(),
			)
			if lookupErr != nil {
				return false
			}
			return !found
		},
		OnCredentialRefreshed: func(accountRef accountcore.AccountRef, credential accountapp.Credential) {
			auth, ok := credential.(*agy.OAuthAuth)
			if !ok || auth == nil {
				return
			}
			if writeErr := agyprojection.Write(aiHomeDir, accountRef.String(), auth); writeErr != nil {
				log.Printf("agy 凭据投影同步失败: account=%s err=%v", accountRef, writeErr)
			}
			if hostHome, homeErr := os.UserHomeDir(); homeErr == nil {
				syncCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				_ = syncDefaultAgyAuthToHost(syncCtx, store, hostHome, accountRef, auth)
				cancel()
			}
		},
	})
}
