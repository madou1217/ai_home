package usagestatsapi

import (
	"context"
	"net/http"

	"github.com/madou1217/ai_home/core/usageledger"
)

// QuotaBucketsPath 是按额度档位聚合的 token 用量接口。
const QuotaBucketsPath = "/v1/management/usage/quota-buckets"

// QuotaBucketsSource 是档位聚合端口。
type QuotaBucketsSource interface {
	QueryUsageQuotaBuckets(context.Context, usageledger.Query) ([]usageledger.QuotaBucketStats, error)
}

// QuotaBucketsHandler 暴露按 (provider, 档位) 聚合的用量。
type QuotaBucketsHandler struct {
	authorizer Authorizer
	source     QuotaBucketsSource
}

// NewQuotaBucketsHandler 创建档位用量接口。
func NewQuotaBucketsHandler(authorizer Authorizer, source QuotaBucketsSource) (*QuotaBucketsHandler, error) {
	if authorizer == nil || source == nil {
		return nil, usageledger.ErrInvalidQuery
	}
	return &QuotaBucketsHandler{authorizer: authorizer, source: source}, nil
}

// ServeHTTP 返回按额度档位聚合的用量行。
func (handler *QuotaBucketsHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	serveUsageQuery(
		response,
		request,
		handler.authorizer,
		"usage_quota_buckets_failed",
		"额度档位用量统计不可用",
		func(ctx context.Context, query usageledger.Query) (map[string]any, error) {
			rows, err := handler.source.QueryUsageQuotaBuckets(ctx, query)
			if err != nil {
				return nil, err
			}
			return map[string]any{"quota_buckets": rows}, nil
		},
	)
}
