package sqliteaccount

import (
	"context"

	"github.com/madou1217/ai_home/core/usageledger"
)

// QueryAccountTokenUsage 读取单账号的 token 事实，并按 day/week/month/total 聚合。
//
// 为什么复用 readUsageRecords：账号行要的「今天/本周/本月/累计」和用量页是同一份
// usage_ledger 事实，只是窗口起点不同。再写一条带 CASE WHEN 的聚合 SQL，会把账号过滤、
// provider/model 过滤和 token 列再复制一遍，两处口径迟早漂移。这里只做一次账号扫描，
// 四个维度都由 core/usageledger 在同一批记录上累加。
//
// to 同时是窗口锚点：调用方用 to 表达「截至此刻的今天/本周/本月」，
// 这样回看历史日期时也能得到那一天的日/周/月，而不是永远按当前时间切。
//
// tzOffsetMinutes 是调用方的本地偏移（本地时间 = UTC + 偏移），窗口按该偏移下的
// 日历切分；账本仍是 UTC 毫秒，偏移只影响边界换算。越界偏移返回 ErrInvalidQuery。
func (store *Store) QueryAccountTokenUsage(
	ctx context.Context,
	query usageledger.Query,
	tzOffsetMinutes int,
) (usageledger.AccountTokenUsage, error) {
	// 这是按账号的端点：没有 AccountRef 就会把整库用量算进一个账号，
	// 宁可报无效查询也不返回看起来合理的错数。
	if store == nil || store.db == nil || ctx == nil || !query.AccountRef.IsValid() {
		return usageledger.AccountTokenUsage{}, usageledger.ErrInvalidQuery
	}
	if err := query.Validate(); err != nil {
		return usageledger.AccountTokenUsage{}, err
	}
	records, err := store.readUsageRecords(ctx, query)
	if err != nil {
		return usageledger.AccountTokenUsage{}, err
	}
	windows, err := usageledger.ResolveAccountTokenUsageWindows(query.To, tzOffsetMinutes)
	if err != nil {
		return usageledger.AccountTokenUsage{}, err
	}
	return usageledger.AggregateAccountTokenUsage(records, query, windows), nil
}
