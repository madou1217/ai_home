// Package codebuddycn 实现 codebuddycn 的调度策略。
//
// 它只表达这个 Provider 自己的事实与优先级，不进入调度器：
//   - 账号级/模型级的通用规则沿用默认策略；
//   - 额度档位的消费顺序由账号自己决定（聚合 credits 档是账号级真相）。
package codebuddycn

import (
	"sort"
	"strings"

	"github.com/madou1217/ai_home/application/accountscheduling"
	schedcore "github.com/madou1217/ai_home/core/accountscheduling"
)

// ProviderID 是本策略支持的规范 Provider。
const ProviderID = "codebuddycn"

// aggregateBucket 是 codebuddycn 的账号级聚合额度档：它的剩余比例等于账号可用额度。
const aggregateBucket = "credits"

// Policy 是 codebuddycn 的策略实现。
type Policy struct {
	*accountscheduling.DefaultPolicy
}

// NewPolicy 构造 codebuddycn 策略。
func NewPolicy() *Policy {
	return &Policy{DefaultPolicy: accountscheduling.NewDefaultPolicy(ProviderID)}
}

// QuotaPlan 让账号决定先花哪一档：聚合档在前，其余明细档按剩余比例降序。
//
// 明细档（按月/活动/赠送）不参与"能不能调度"的结论，只用于观测与兜底排序；
// 这样新增套餐档位不需要改调度器。
func (policy *Policy) QuotaPlan(evidence accountscheduling.Evidence) []schedcore.Bucket {
	buckets := policy.DefaultPolicy.QuotaPlan(evidence)
	if len(buckets) < 2 {
		return buckets
	}
	ordered := make([]schedcore.Bucket, 0, len(buckets))
	rest := make([]schedcore.Bucket, 0, len(buckets))
	for _, bucket := range buckets {
		if strings.EqualFold(strings.TrimSpace(bucket.ID), aggregateBucket) {
			ordered = append(ordered, bucket)
			continue
		}
		rest = append(rest, bucket)
	}
	sort.SliceStable(rest, func(left, right int) bool {
		return rest[left].RemainingBasisPoints > rest[right].RemainingBasisPoints
	})
	return append(ordered, rest...)
}
