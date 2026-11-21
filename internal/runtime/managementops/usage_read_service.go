package managementops

import (
	"context"
	"strings"
)

// UsageSyncScanner 同步执行一次本地模型用量源扫描（会话文件 → 用量投影库）。
type UsageSyncScanner interface {
	ScanSync(ctx context.Context, provider string) (UsageScanResult, error)
}

// UsageReader 是「可选同步扫描 → 投影查询」的读编排，供管理面 HTTP 与本地 CLI 共用。
//
// 为什么独立成层：`aih usage` 与 WebUI 看板读的是同一份本机用量投影。过去 CLI
// 借本机 HTTP 管理面取数，于是仅仅想看一眼用量也被迫依赖 Management Key 和运行中
// 的 Server——首次安装还没配密钥时会直接 401。把扫描与查询的编排收敛到这里后，
// CLI 在自身进程内直接调用，HTTP 管理面只负责鉴权与序列化，两条入口不再各自复制
// 一套取数逻辑。
type UsageReader struct {
	store        *UsageStore
	scanner      UsageSyncScanner
	supportsScan func(provider string) bool
}

// PreparedUsage 是一次查询已完成扫描编排后的只读视图；查询本身不会再触发扫描。
type PreparedUsage struct {
	store *UsageStore
}

// NewUsageReader 组合用量投影库与同步扫描器；supportsScan 为 nil 时视为不支持按 Provider 扫描。
func NewUsageReader(
	store *UsageStore,
	scanner UsageSyncScanner,
	supportsScan func(provider string) bool,
) *UsageReader {
	return &UsageReader{store: store, scanner: scanner, supportsScan: supportsScan}
}

// Prepare 在查询要求扫描时先同步刷新用量源；Provider 未声明 usage_scan 能力时跳过扫描。
func (reader *UsageReader) Prepare(ctx context.Context, query UsageQuery) (*PreparedUsage, error) {
	if reader == nil || reader.store == nil {
		return nil, ErrUsageUnavailable
	}
	if query.Scan {
		if query.Provider == "" || (reader.supportsScan != nil && reader.supportsScan(query.Provider)) {
			if reader.scanner == nil {
				return nil, ErrUsageUnavailable
			}
			if _, err := reader.scanner.ScanSync(ctx, query.Provider); err != nil {
				return nil, err
			}
		}
	}
	return &PreparedUsage{store: reader.store}, nil
}

// Stats 返回查询范围内的用量汇总。
func (usage *PreparedUsage) Stats(ctx context.Context, query UsageQuery) (UsageStatsSummary, error) {
	return usage.store.QueryStats(ctx, query)
}

// Models 返回按模型分组的用量与成本。
func (usage *PreparedUsage) Models(ctx context.Context, query UsageQuery) ([]UsageModelItem, error) {
	return usage.store.QueryCostByModel(ctx, query)
}

// Sessions 返回按会话分组的用量与成本。
func (usage *PreparedUsage) Sessions(ctx context.Context, query UsageQuery) ([]UsageSessionItem, error) {
	return usage.store.QuerySessions(ctx, query)
}

// SessionDetail 返回单个会话内各模型的消耗明细；缺少 sessionId 时返回 ErrSessionIDRequired。
func (usage *PreparedUsage) SessionDetail(ctx context.Context, query UsageQuery) ([]UsageSessionModelDetail, error) {
	if strings.TrimSpace(query.SessionID) == "" {
		return nil, ErrSessionIDRequired
	}
	return usage.store.QuerySessionDetail(ctx, query)
}
