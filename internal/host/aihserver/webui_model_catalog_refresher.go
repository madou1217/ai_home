package aihserver

import (
	"context"
	"strings"
	"sync"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/webuiopenaimodelswriteapi"
)

// 本文件把「模型目录刷新」接到 Go 的账号模型刷新用例上。
//
// 这是策略模式的组合根：webuiopenaimodelswriteapi.Refresher 是策略接口，本文件提供
// 「扇出到全部账号」的 Go 实现。每个 Provider 用哪个上游发现适配器由
// application/accounts 的模型发现注册表决定，本文件不按 Provider 写分支，也不假设
// 目录只服务某一家（路径里的 openai-models 只是 OpenAI 兼容的 /v1/models 响应形状）。
//
// 语义与 Node 旧实现一致：一次刷新枚举全部账号，逐个让 Go 用规范凭据重新探测上游并
// 落库 account_models。扇出在 Go 内完成，Node 只发一个 POST，不再逐账号打管理 API。
//
// 边界：
//   - 不按 Provider 写分支：账号来自 Store，Provider 归属由各自的 Go 适配器决定；
//   - 单账号失败不阻断其它账号，错误摘要按首个失败返回；
//   - 有界并发：上游探测是网络操作，不能一次把上万账号全部打出去。

const (
	// webuiModelRefreshConcurrency 是同时在飞的上游探测数。
	webuiModelRefreshConcurrency = 4
	// webuiModelRefreshPageSize 是账号枚举的游标分页大小（不超过 OverviewQuery 上限）。
	webuiModelRefreshPageSize = 200
	// webuiModelRefreshErrorLimit 限制错误摘要长度：只回显文案，不带路径/凭据。
	webuiModelRefreshErrorLimit = 200
)

// webuiModelRefreshAccounts 是刷新扇出需要的账号枚举端口（sqliteaccount.Store 实现）。
type webuiModelRefreshAccounts interface {
	ListAccountOverviews(
		ctx context.Context,
		query accountapp.OverviewQuery,
	) ([]accountapp.AccountOverview, error)
}

// webuiModelCatalogRefresher 是 webuiopenaimodelswriteapi.Refresher 的 Go 实现。
type webuiModelCatalogRefresher struct {
	accounts  webuiModelRefreshAccounts
	refresher accountapp.AccountModelRefresher
	now       func() time.Time
}

// newWebUIModelCatalogRefresher 创建全局模型目录刷新器。
//
// 任一依赖缺失时返回 nil：调用方据此保持 501 refresh_unavailable，而不是假装刷新成功。
func newWebUIModelCatalogRefresher(
	accounts webuiModelRefreshAccounts,
	refresher accountapp.AccountModelRefresher,
	now func() time.Time,
) webuiopenaimodelswriteapi.Refresher {
	if accounts == nil || refresher == nil {
		return nil
	}
	if now == nil {
		now = time.Now
	}
	return &webuiModelCatalogRefresher{
		accounts:  accounts,
		refresher: refresher,
		now:       now,
	}
}

// Refresh 枚举全部账号并逐个刷新模型目录。
//
// 返回的统计口径：
//   - Accounts 是实际派发的账号数（ctx 取消后不再派发）；
//   - Models 是各账号返回的模型条数之和；
//   - Sources 表示是否有账号成功且发现了模型（0/1），与 Node 的 sources 语义一致；
//   - FirstError 是首个失败摘要，全部成功时为空。
func (refresher *webuiModelCatalogRefresher) Refresh(
	ctx context.Context,
) (webuiopenaimodelswriteapi.RefreshResult, error) {
	result := webuiopenaimodelswriteapi.RefreshResult{
		UpdatedAtMS: refresher.now().UnixMilli(),
		Source:      "probe",
	}
	refs, err := refresher.listAccountRefs(ctx)
	if err != nil {
		return webuiopenaimodelswriteapi.RefreshResult{}, err
	}
	if len(refs) == 0 {
		result.Source = "empty"
		return result, nil
	}

	var (
		waitGroup  sync.WaitGroup
		mutex      sync.Mutex
		firstError string
		attempted  int
		withModels int
	)
	semaphore := make(chan struct{}, webuiModelRefreshConcurrency)
	recordFailure := func(message string) {
		mutex.Lock()
		defer mutex.Unlock()
		if firstError == "" {
			firstError = truncateRefreshError(message)
		}
	}
	for _, accountRef := range refs {
		// 取消后不再派发新任务：已经在飞的探测由 ctx 自己中断。
		// 先显式看一次 ctx：select 在信号量与 Done 同时就绪时是随机选择，
		// 只用 select 会允许取消后再派发一个任务。
		if ctx.Err() != nil {
			recordFailure("context canceled: " + ctx.Err().Error())
			break
		}
		select {
		case semaphore <- struct{}{}:
		case <-ctx.Done():
			recordFailure("context canceled: " + ctx.Err().Error())
			waitGroup.Wait()
			result.Accounts = attempted
			result.FirstError = firstError
			if withModels > 0 {
				result.Sources = 1
			}
			return result, nil
		}
		waitGroup.Add(1)
		attempted++
		go func(ref accountcore.AccountRef) {
			defer waitGroup.Done()
			defer func() { <-semaphore }()
			// 单个账号的适配器 panic 不能带走整个刷新作业。
			defer func() {
				if recovered := recover(); recovered != nil {
					recordFailure("refresh panic")
				}
			}()
			models, refreshErr := refresher.refresher.RefreshAccountModels(ctx, ref)
			mutex.Lock()
			defer mutex.Unlock()
			if refreshErr != nil {
				if firstError == "" {
					firstError = truncateRefreshError(refreshErr.Error())
				}
				return
			}
			result.Models += len(models)
			if len(models) > 0 {
				withModels++
			}
		}(accountRef)
	}
	waitGroup.Wait()
	result.Accounts = attempted
	result.FirstError = firstError
	if withModels > 0 {
		result.Sources = 1
	}
	return result, nil
}

// listAccountRefs 用稳定游标翻页枚举账号。
//
// 只看账号引用：刷新不需要概览里的凭据/用量字段，Store 的查询已经做了这一层。
func (refresher *webuiModelCatalogRefresher) listAccountRefs(
	ctx context.Context,
) ([]accountcore.AccountRef, error) {
	refs := make([]accountcore.AccountRef, 0, webuiModelRefreshPageSize)
	cursor := accountcore.AccountRef("")
	for {
		query, err := accountapp.NewOverviewQuery(cursor, webuiModelRefreshPageSize)
		if err != nil {
			return nil, err
		}
		page, err := refresher.accounts.ListAccountOverviews(ctx, query)
		if err != nil {
			return nil, err
		}
		for _, overview := range page {
			ref := overview.Account().Ref()
			if ref.IsValid() {
				refs = append(refs, ref)
			}
		}
		if len(page) < webuiModelRefreshPageSize {
			return refs, nil
		}
		last := page[len(page)-1].Account().Ref()
		// 游标不前进时立即停止：继续翻页只会重复同一批账号。
		if last == cursor {
			return refs, nil
		}
		cursor = last
	}
}

// truncateRefreshError 只保留可读文案，并限制长度。
func truncateRefreshError(message string) string {
	message = strings.TrimSpace(message)
	if message == "" {
		return ""
	}
	runes := []rune(message)
	if len(runes) <= webuiModelRefreshErrorLimit {
		return message
	}
	return string(runes[:webuiModelRefreshErrorLimit])
}
