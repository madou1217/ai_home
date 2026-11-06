package usagestatsapi

import (
	"context"
	"net/http"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/usageledger"
)

// BucketsPath 是 token 用量按时间桶聚合的只读接口（额度统计页图表）。
const BucketsPath = "/v1/management/usage/buckets"

// BucketsSource 是桶聚合端口。
type BucketsSource interface {
	QueryUsageBuckets(context.Context, usageledger.Query, string) ([]usageledger.BucketStats, error)
}

type BucketsHandler struct {
	authorizer Authorizer
	source     BucketsSource
}

func NewBucketsHandler(authorizer Authorizer, source BucketsSource) (*BucketsHandler, error) {
	if authorizer == nil || source == nil {
		return nil, usageledger.ErrInvalidQuery
	}
	return &BucketsHandler{authorizer: authorizer, source: source}, nil
}

func (handler *BucketsHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	granularity := usageledger.NormalizeBucketGranularity(request.URL.Query().Get("granularity"))
	if granularity == "" {
		granularity = usageledger.BucketGranularityDay
	}
	serveUsageQuery(
		response,
		request,
		handler.authorizer,
		"invalid_usage_query",
		"用量查询参数无效",
		func(ctx context.Context, query usageledger.Query) (map[string]any, error) {
			// account_ref 可选：额度统计页按账号看，传了就只统计该账号。
			if raw := strings.TrimSpace(request.URL.Query().Get("account_ref")); raw != "" {
				ref, err := accountcore.ParseAccountRef(raw)
				if err != nil {
					return nil, usageledger.ErrInvalidQuery
				}
				query.AccountRef = ref
			}
			buckets, err := handler.source.QueryUsageBuckets(ctx, query, granularity)
			if err != nil {
				return nil, err
			}
			return map[string]any{
				"granularity": granularity,
				"from":        query.From.Format(timeFormat),
				"to":          query.To.Format(timeFormat),
				"buckets":     buckets,
			}, nil
		},
	)
}

const timeFormat = "2006-01-02T15:04:05.000Z07:00"
