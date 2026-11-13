package aihserver

import (
	"context"
	"net/http"
	"os"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	agyegress "github.com/madou1217/ai_home/internal/adapters/agy/egress"
	"github.com/madou1217/ai_home/internal/adapters/kimi/desktopsession"
	"github.com/madou1217/ai_home/internal/adapters/kimi/planstats"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountkimiapi"
)

// kimiRouteHTTPTimeout 与 Node 两个模块的 DEFAULT_TIMEOUT_MS（10s）一致。
const kimiRouteHTTPTimeout = 10 * time.Second

// buildWebUIKimiRoutes 装配 kimi 的账号级路由（套餐统计 + 桌面端托管登录）。
//
// 四条能力共享同一份账号存在性校验与账号级出口解析；上游协议分别在
// internal/adapters/kimi/desktopsession 与 planstats，Node 侧不再保留本地实现。
func buildWebUIKimiRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, nil
	}

	credentialStore, err := desktopsession.NewCredentialStore(dependencies.Store, time.Now)
	if err != nil {
		return nil, err
	}

	egressResolver := agyegress.NewResolver(agyegress.Options{AIHomeDir: dependencies.AIHomeDir})
	resolveEgressClient := func(
		ctx context.Context,
		accountRef string,
	) (*http.Client, error) {
		ref, parseErr := accountcore.ParseAccountRef(strings.TrimSpace(accountRef))
		if parseErr != nil {
			return nil, parseErr
		}
		decision, resolveErr := egressResolver.Resolve(ctx, ref)
		if resolveErr != nil {
			return nil, resolveErr
		}
		if !decision.Bound {
			return nil, nil
		}
		proxyURL := ""
		if !decision.Target.Direct {
			proxyURL = decision.Target.ProxyURL
		}
		// 与 OAuth 刷新同一套出口语义：绑定存在时绝不回落到进程默认网络。
		return newOAuthEgressClient(proxyURL, kimiRouteHTTPTimeout), nil
	}

	desktop, err := desktopsession.New(credentialStore, desktopsession.Options{
		// 环境变量名与 Node 同值，只在开发/排障时覆盖官方端点。
		BaseURL: strings.TrimSpace(os.Getenv("KIMI_DESKTOP_SESSION_AUTH_BASE")),
		Transport: func(ctx context.Context, accountRef string) (desktopsession.HTTPClient, error) {
			client, resolveErr := resolveEgressClient(ctx, accountRef)
			if client == nil {
				return nil, resolveErr
			}
			return client, resolveErr
		},
	})
	if err != nil {
		return nil, err
	}

	stats, err := planstats.New(desktop, planstats.Options{
		BaseURL: strings.TrimSpace(os.Getenv("KIMI_PLAN_STATS_BASE_URL")),
		Transport: func(ctx context.Context, accountRef string) (planstats.HTTPClient, error) {
			client, resolveErr := resolveEgressClient(ctx, accountRef)
			if client == nil {
				return nil, resolveErr
			}
			return client, resolveErr
		},
	})
	if err != nil {
		return nil, err
	}

	handler, err := webuiaccountkimiapi.NewHandler(webuiaccountkimiapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		Accounts:   dependencies.Store,
		Desktop:    desktop,
		PlanStats:  stats,
	})
	if err != nil {
		return nil, err
	}

	return []webuiRoute{
		{
			Pattern: "GET " + webuiaccountkimiapi.Path + webuiaccountkimiapi.PlanStatsSuffix,
			Handler: handler,
		},
		{
			Pattern: "POST " + webuiaccountkimiapi.Path + webuiaccountkimiapi.DesktopSessionStartSuffix,
			Handler: handler,
		},
		{
			Pattern: "POST " + webuiaccountkimiapi.Path + webuiaccountkimiapi.DesktopSessionPollSuffix,
			Handler: handler,
		},
		{
			Pattern: "GET " + webuiaccountkimiapi.Path + webuiaccountkimiapi.DesktopSessionWatchSuffix,
			Handler: handler,
		},
	}, nil
}
