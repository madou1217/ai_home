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

// preferredOrder 返回扫描顺序：偏好的候选在前（按偏好顺序），其余按公平轮转起点排列。
// 没有偏好时返回 nil（沿用原环形扫描）。
func (session *RecruitmentSession) preferredOrder(ctx context.Context) error {
	provider := preferenceProviderFrom(ctx)
	count := session.candidates.Len()
	if provider == nil || count == 0 {
		return nil
	}
	refs := make([]accountcore.AccountRef, 0, count)
	indexOf := make(map[accountcore.AccountRef]int, count)
	for index := 0; index < count; index++ {
		candidate, found := session.candidates.At(index)
		if !found {
			return ErrInvalidCandidateSnapshot
		}
		refs = append(refs, candidate.Ref())
		indexOf[candidate.Ref()] = index
	}
	preferred, err := provider.Prefer(ctx, session.request.ProviderID(), session.request.ModelID().String(), refs)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrAccountPreferenceFailed, err)
	}
	if len(preferred) == 0 {
		return nil
	}
	order := make([]int, 0, count)
	taken := make(map[int]bool, count)
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
