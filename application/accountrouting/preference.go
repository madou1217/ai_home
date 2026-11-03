package accountrouting

import (
	"context"
	"errors"
	"fmt"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// ErrAccountPreferenceFailed 表示账号偏好策略失败（例如插件 deny 失败或偏好越界），请求随之失败。
var ErrAccountPreferenceFailed = errors.New("账号偏好策略失败")

// PreferenceProvider 对一次请求的候选账号给出有序偏好（只能是候选的子集）。
//
// 偏好只排序：钉选账号不经过它；被偏好的账号不可用时照常回落到其余候选（公平轮转顺序）。
// 实现由请求上下文携带（插件 gateway.account，见 application/pluginruntime），本包不依赖插件。
type PreferenceProvider interface {
	Prefer(ctx context.Context, providerID string, modelID string, candidates []accountcore.AccountRef) ([]accountcore.AccountRef, error)
}

type preferenceKey struct{}

// WithPreferenceProvider 把账号偏好策略放进请求上下文。
func WithPreferenceProvider(ctx context.Context, provider PreferenceProvider) context.Context {
	return context.WithValue(ctx, preferenceKey{}, provider)
}

func preferenceProviderFrom(ctx context.Context) PreferenceProvider {
	provider, _ := ctx.Value(preferenceKey{}).(PreferenceProvider)
	return provider
}

// preferredOrder 返回扫描顺序：会话亲和账号最先，其次是插件偏好的候选，其余按公平
// 轮转起点排列。既没有会话亲和也没有偏好时返回 nil（沿用原环形扫描，不物化顺序）。
func (session *RecruitmentSession) preferredOrder(
	ctx context.Context,
	affinityOffset int,
	hasAffinity bool,
) error {
	provider := preferenceProviderFrom(ctx)
	count := session.candidates.Len()
	if count == 0 {
		return nil
	}
	if !hasAffinity && provider == nil {
		return nil
	}
	var preferred []accountcore.AccountRef
	indexOf := make(map[accountcore.AccountRef]int, count)
	if provider != nil {
		refs := make([]accountcore.AccountRef, 0, count)
		for index := 0; index < count; index++ {
			candidate, found := session.candidates.At(index)
			if !found {
				return ErrInvalidCandidateSnapshot
			}
			refs = append(refs, candidate.Ref())
			indexOf[candidate.Ref()] = index
		}
		var err error
		preferred, err = provider.Prefer(
			ctx,
			session.request.ProviderID(),
			session.request.ModelID().String(),
			refs,
		)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrAccountPreferenceFailed, err)
		}
	}
	if !hasAffinity && len(preferred) == 0 {
		return nil
	}
	order := make([]int, 0, count)
	taken := make(map[int]bool, count)
	// 会话亲和优先于插件偏好（与 Node 一致：亲和排在偏好之前）。
	if hasAffinity {
		order = append(order, affinityOffset)
		taken[affinityOffset] = true
	}
	for _, ref := range preferred {
		index, ok := indexOf[ref]
		if !ok {
			return fmt.Errorf("%w: 偏好了候选之外的账号", ErrAccountPreferenceFailed)
		}
		if !taken[index] {
			order = append(order, index)
			taken[index] = true
		}
	}
	for offset := 0; offset < count; offset++ {
		index := (session.start + offset) % count
		if !taken[index] {
			order = append(order, index)
		}
	}
	session.order = order
	return nil
}
