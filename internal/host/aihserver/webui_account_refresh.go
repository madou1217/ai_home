package aihserver

import (
	"context"
	"fmt"
	"net/http"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountrefreshapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountrefreshusageapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiquotaresetapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuirefreshjobstore"
)

// buildWebUIRefreshRoutes 装配账号刷新的三条管理路由。
//
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/refresh
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/refresh-usage
//	GET  /v1/management/webui/accounts/refresh-jobs/{jobId}
//
// 三条路由共享同一张作业表：两个写入口登记作业，查询入口按 ID 读快照。契约与 Node
// 一致——写入口立刻返回 202 + queued 作业，执行在 Go 进程内异步跑；同
// (provider, accountRef, scope) 的活动作业复用，第二个请求拿到 alreadyRunning=true。
//
// 依赖取舍：账号存储与鉴权是必需端口，缺失时整组不挂载（可选路由不阻断启动）。
// 模型/额度端口允许为 nil：执行器会把对应段标 refresh_unavailable，或让额度入口
// 直接回 501，而不是用一个假的成功掩盖「没刷新」。
func buildWebUIRefreshRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, nil
	}

	// 作业表是三条路由的共享状态，必须只建一份：各自建表会让查询入口看不到写入口
	// 登记的作业。
	jobs := webuirefreshjobstore.New(webuirefreshjobstore.Options{})

	// 额度端口用显式 nil 判断而不是直接赋值：*usageapp.Service 的 nil 指针装进接口
	// 之后接口非空，执行器会真的去调用它并 panic。
	var quotaRefresher webuiaccountrefreshapi.QuotaRefresher
	if dependencies.UsageService != nil {
		quotaRefresher = dependencies.UsageService
	}
	refreshExecutor, err := webuiaccountrefreshapi.NewHandler(webuiaccountrefreshapi.Dependencies{
		Authorizer:      dependencies.Authorizer,
		AIHomeDir:       dependencies.AIHomeDir,
		Accounts:        dependencies.Store,
		StatusRefresher: webuiAccountStatusRefresher{store: dependencies.Store},
		ModelRefresher:  dependencies.ModelRefresher,
		QuotaRefresher:  quotaRefresher,
	})
	if err != nil {
		return nil, fmt.Errorf("创建账号刷新执行器失败: %w", err)
	}
	refreshAsync, err := webuiaccountrefreshapi.NewAsyncHandler(refreshExecutor, jobs)
	if err != nil {
		return nil, fmt.Errorf("创建账号刷新异步接口失败: %w", err)
	}

	// 额度入口的账号存在性复用额度重置历史的读端口：它读的是 Node 写入的
	// account_refs，覆盖 Go 账号投影里缺失的停用/未同步账号。
	quotaSource, err := webuiquotaresetapi.OpenSource(dependencies.AIHomeDir)
	if err != nil {
		return nil, fmt.Errorf("创建额度刷新账号读端口失败: %w", err)
	}
	var quotaProbe webuiaccountrefreshusageapi.QuotaProbe
	if dependencies.UsageService != nil {
		quotaProbe = webuiQuotaProbe{usage: dependencies.UsageService}
	}
	usageExecutor, err := webuiaccountrefreshusageapi.NewHandler(webuiaccountrefreshusageapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		AIHomeDir:  dependencies.AIHomeDir,
		Accounts: refreshUsageAccountLookup{
			node:    quotaSource,
			goStore: dependencies.Store,
		},
		QuotaProbe: quotaProbe,
	})
	if err != nil {
		return nil, fmt.Errorf("创建额度刷新执行器失败: %w", err)
	}
	usageAsync, err := webuiaccountrefreshusageapi.NewAsyncHandler(usageExecutor, jobs)
	if err != nil {
		return nil, fmt.Errorf("创建额度刷新异步接口失败: %w", err)
	}

	return []webuiRoute{
		{
			Pattern: "POST " + webuiaccountrefreshapi.Path + webuiaccountrefreshapi.RefreshSuffix,
			Handler: refreshAsync,
		},
		{
			Pattern: "POST " + webuiaccountrefreshusageapi.Path + webuiaccountrefreshusageapi.RefreshUsageSuffix,
			Handler: usageAsync,
		},
		{
			Pattern: "GET " + webuirefreshjobstore.JobPath,
			Handler: http.HandlerFunc(refreshAsync.ServeJob),
		},
	}, nil
}

// refreshUsageAccountLookup 判定额度刷新路径里的账号归属。
//
// 先按 Node 写入的 account_refs（额度事件的证据源），再回落到 Go 的 accounts 表：
// Go 独有的账号（例如用 Go 完成 agy 登录的账号）只存在于 Go，只看 account_refs 会 404。
// 两张表给出的是同一事实（ref → provider），冲突时以 Node 台账为准。
type refreshUsageAccountLookup struct {
	node    webuiquotaresetapi.AccountLookup
	goStore interface {
		GetByRef(
			ctx context.Context,
			accountRef accountcore.AccountRef,
		) (accountcore.Account, error)
	}
}

func (lookup refreshUsageAccountLookup) LookupProvider(
	ctx context.Context,
	accountRef string,
) (string, bool, error) {
	if lookup.node != nil {
		provider, found, err := lookup.node.LookupProvider(ctx, accountRef)
		if err != nil || found {
			return provider, found, err
		}
	}
	if lookup.goStore == nil {
		return "", false, nil
	}
	ref, err := accountcore.ParseAccountRef(accountRef)
	if err != nil {
		return "", false, nil
	}
	account, err := lookup.goStore.GetByRef(ctx, ref)
	if err != nil {
		return "", false, nil
	}
	return account.ProviderID(), true, nil
}
