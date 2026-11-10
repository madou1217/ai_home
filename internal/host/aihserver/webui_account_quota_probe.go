package aihserver

import (
	"context"
	"fmt"
	"strings"

	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountrefreshusageapi"
)

// usageQuotaRefresher 是额度应用服务的窄端口：只暴露 WebUI 刷新需要的单账号刷新。
//
// 用接口而不是直接依赖 *usageapp.Service，测试才能用假实现覆盖上游错误和身份
// 不一致，接线处也不需要为测试暴露服务内部。
type usageQuotaRefresher interface {
	RefreshUsage(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (usageapp.ReadResult, error)
}

// webuiQuotaProbe 把额度应用服务适配成 WebUI 的额度探测端口。
//
// 探测本身（访问 Provider、写入额度事实表）仍由 usageapp.Service 完成；这里只做
// 身份校验和领域快照到展示快照的投影，保证响应里的窗口与 Node 的展示口径一致。
type webuiQuotaProbe struct {
	usage usageQuotaRefresher
}

// ProbeQuota 刷新一个账号的额度并返回展示层快照。
//
// 失败语义：账号引用不合法、刷新失败、快照身份与路由目标不一致都返回 error，
// 调用方不得把旧快照或别的账号的快照当成刷新成功。
func (probe webuiQuotaProbe) ProbeQuota(
	ctx context.Context,
	provider string,
	accountRef string,
) (webuiaccountrefreshusageapi.Snapshot, error) {
	ref, err := accountcore.ParseAccountRef(accountRef)
	if err != nil {
		return webuiaccountrefreshusageapi.Snapshot{}, err
	}
	result, err := probe.usage.RefreshUsage(ctx, ref)
	if err != nil {
		return webuiaccountrefreshusageapi.Snapshot{}, err
	}
	return newWebUIQuotaSnapshot(result.Snapshot(), provider, ref)
}

// newWebUIQuotaSnapshot 校验快照身份并投影成 WebUI 快照。
//
// Provider 与 AccountRef 以快照为准：两者必须回指路由里的目标账号，否则返回
// webuiaccountrefreshusageapi.ErrInvalidSnapshot，避免把别的账号的额度写进响应。
func newWebUIQuotaSnapshot(
	snapshot usagecore.Snapshot,
	provider string,
	accountRef accountcore.AccountRef,
) (webuiaccountrefreshusageapi.Snapshot, error) {
	normalizedProvider := strings.ToLower(strings.TrimSpace(provider))
	if snapshot.AccountRef() != accountRef || snapshot.ProviderID() != normalizedProvider {
		return webuiaccountrefreshusageapi.Snapshot{}, fmt.Errorf(
			"%w: 快照 %s/%s 与请求 %s/%s 不一致",
			webuiaccountrefreshusageapi.ErrInvalidSnapshot,
			snapshot.ProviderID(),
			snapshot.AccountRef().String(),
			normalizedProvider,
			accountRef.String(),
		)
	}
	if snapshot.CapturedAt().IsZero() {
		return webuiaccountrefreshusageapi.Snapshot{}, fmt.Errorf(
			"%w: 快照缺少采集时间",
			webuiaccountrefreshusageapi.ErrInvalidSnapshot,
		)
	}
	entries := snapshot.Entries()
	windows := make([]webuiaccountrefreshusageapi.Window, 0, len(entries))
	for _, entry := range entries {
		windows = append(windows, newWebUIQuotaWindow(entry))
	}
	return webuiaccountrefreshusageapi.Snapshot{
		Provider:   snapshot.ProviderID(),
		AccountRef: snapshot.AccountRef().String(),
		PlanType:   snapshot.PlanType(),
		Source:     snapshot.Source(),
		CapturedAt: snapshot.CapturedAt(),
		Windows:    windows,
	}, nil
}

// newWebUIQuotaWindow 把一个额度事实投影成展示窗口。
//
// 剩余比例从基点换算：额度事实用 0–10000 基点保存百分比，Node 的 remainingPct
// 是基点除以 100 得到的 0–100 数值，这里保持同一口径。未知比例保持 nil；零值
// ResetAt 原样保留，由展示层决定是否显示恢复时间。
func newWebUIQuotaWindow(entry usagecore.Entry) webuiaccountrefreshusageapi.Window {
	window := webuiaccountrefreshusageapi.Window{
		LimitID:       entry.LimitID(),
		LimitName:     entry.LimitName(),
		Bucket:        entry.Bucket(),
		Kind:          string(entry.Kind()),
		Scope:         string(entry.Scope()),
		ScopeKey:      entry.ScopeKey(),
		WindowSeconds: entry.WindowSeconds(),
		ResetAt:       entry.ResetAt(),
		Availability:  string(entry.Availability()),
	}
	if basisPoints, known := entry.RemainingBasisPoints(); known {
		remaining := float64(basisPoints) / 100
		window.RemainingPct = &remaining
	}
	return window
}
