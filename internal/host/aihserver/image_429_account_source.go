package aihserver

import (
	"context"
	"errors"
	"strings"
	"sync"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/images"
	"github.com/madou1217/ai_home/internal/runtime/imageexecution"
)

var _ imageexecution.RateLimitReacquirer = imageAccountSource{}

// NewObservedSession 为单次图片请求创建观察包装源：沿用既有 Candidates 公平/钉选逻辑，
// 并保存 Recruiter 每次真实征召产出的 CredentialObservation，绝不伪造观察。
func (source imageAccountSource) NewObservedSession() imageexecution.ObservedAccountSession {
	session := &observedImageAccountSession{
		observations: make(map[string]accountcredentials.CredentialObservation, 4),
	}
	wrapped := source
	wrapped.onObserved = session.record
	session.source = wrapped
	return session
}

type observedImageAccountSession struct {
	source       imageAccountSource
	mu           sync.Mutex
	observations map[string]accountcredentials.CredentialObservation
}

func (session *observedImageAccountSession) Candidates(
	ctx context.Context,
	provider string,
	model string,
	exclude []string,
) ([]images.Account, error) {
	return session.source.Candidates(ctx, provider, model, exclude)
}

func (session *observedImageAccountSession) record(
	accountRef accountcore.AccountRef,
	observation accountcredentials.CredentialObservation,
) {
	if session == nil || !accountRef.IsValid() || !observation.IsValid() {
		return
	}
	session.mu.Lock()
	session.observations[accountRef.String()] = observation
	session.mu.Unlock()
}

func (session *observedImageAccountSession) ObservationFor(
	accountRef string,
) (accountcredentials.CredentialObservation, bool) {
	if session == nil {
		return accountcredentials.CredentialObservation{}, false
	}
	key := strings.TrimSpace(accountRef)
	if key == "" {
		return accountcredentials.CredentialObservation{}, false
	}
	session.mu.Lock()
	obs, ok := session.observations[key]
	session.mu.Unlock()
	return obs, ok && obs.IsValid()
}

// OpenHealthyPool 打开完整 Recruiter 会话游标，跳过已在初始执行中实际派发过的账号，
// 零等待依次产出剩余健康且满足图片能力闸门的候选账号，直到真实池耗尽（不依赖 NewRequestExcluding 的 4 账号上限）。
func (source imageAccountSource) OpenHealthyPool(
	ctx context.Context,
	provider string,
	model string,
	excluded map[string]struct{},
	eligible imageexecution.AccountEligibilityFunc,
) (imageexecution.HealthyPoolCursor, error) {
	if source.recruiter == nil || source.catalog == nil {
		return nil, errImageAccountUnavailable
	}
	poolReq, err := accountrouting.NewRequest(source.catalog, provider, model)
	if err != nil {
		return nil, err
	}
	session, err := source.recruiter.Begin(ctx, poolReq, source.transports)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(excluded)+4)
	for ref := range excluded {
		trimmed := strings.TrimSpace(ref)
		if trimmed != "" {
			seen[trimmed] = struct{}{}
		}
	}
	return &imageHealthyPoolCursor{
		provider: provider,
		session:  session,
		seen:     seen,
		eligible: eligible,
	}, nil
}

type imageHealthyPoolCursor struct {
	provider string
	session  *accountrouting.RecruitmentSession
	seen     map[string]struct{}
	eligible imageexecution.AccountEligibilityFunc
}

func (cursor *imageHealthyPoolCursor) Next(ctx context.Context) (imageexecution.ObservedAccount, bool, error) {
	if cursor == nil || cursor.session == nil {
		return imageexecution.ObservedAccount{}, false, nil
	}
	for {
		result, err := cursor.session.Next(ctx)
		if errors.Is(err, accountrouting.ErrNoRoutableAccount) {
			return imageexecution.ObservedAccount{}, false, nil
		}
		if err != nil {
			return imageexecution.ObservedAccount{}, false, err
		}
		ref := result.Account().Ref().String()
		if _, already := cursor.seen[ref]; already {
			continue
		}
		account, convErr := toImageAccount(cursor.provider, result.Account(), result.Credential())
		if convErr != nil {
			continue
		}
		if cursor.eligible != nil && !cursor.eligible(account) {
			continue
		}
		cursor.seen[ref] = struct{}{}
		return imageexecution.ObservedAccount{
			Account:     account,
			Observation: result.CredentialObservation(),
		}, true, nil
	}
}

// ReacquireFor429Retry 在 429 退避等待结束后，通过完整 Recruiter 重新校验启用候选、
// UsageGate、Scheduling、硬阻塞、imageTransportPolicy、原子 RateLimitCooldownWaiver 与最新凭据。
//
// 非钉选请求优先扫描当前健康且满足图片能力闸门的替代账号（usedWaiver=false）；
// 钉选请求或池中无健康替代账号时，再使用本次请求精确持有的原子豁免凭证重征召目标账号。
func (source imageAccountSource) ReacquireFor429Retry(
	ctx context.Context,
	provider string,
	model string,
	pinned bool,
	target accountcore.AccountRef,
	receipt runtimecore.CooldownReceipt,
	originObservation accountcredentials.CredentialObservation,
	eligible imageexecution.AccountEligibilityFunc,
) (imageexecution.ObservedAccount, bool, bool, error) {
	if source.recruiter == nil || source.catalog == nil || !target.IsValid() {
		return imageexecution.ObservedAccount{}, false, false, errImageAccountUnavailable
	}
	if !pinned {
		if poolReq, reqErr := accountrouting.NewRequest(source.catalog, provider, model); reqErr == nil {
			session, beginErr := source.recruiter.Begin(ctx, poolReq, source.transports)
			if beginErr != nil {
				return imageexecution.ObservedAccount{}, false, false, beginErr
			}
			for {
				result, nextErr := session.Next(ctx)
				if errors.Is(nextErr, accountrouting.ErrNoRoutableAccount) {
					break
				}
				if nextErr != nil {
					return imageexecution.ObservedAccount{}, false, false, nextErr
				}
				account, convErr := toImageAccount(provider, result.Account(), result.Credential())
				if convErr != nil {
					continue
				}
				if eligible != nil && !eligible(account) {
					continue
				}
				return imageexecution.ObservedAccount{
					Account:     account,
					Observation: result.CredentialObservation(),
				}, false, true, nil
			}
		}
	}

	pinnedReq, err := accountrouting.NewPinnedRequest(source.catalog, provider, model, target)
	if err != nil {
		return imageexecution.ObservedAccount{}, false, false, err
	}
	waiver := accountrouting.RateLimitCooldownWaiver{
		Receipt:     receipt,
		Observation: originObservation,
	}
	if waiver.IsValid() {
		pinnedReq = pinnedReq.WithRateLimitCooldownWaiver(waiver)
	}
	result, err := source.recruiter.Recruit(ctx, pinnedReq, source.transports)
	if errors.Is(err, accountrouting.ErrNoRoutableAccount) {
		return imageexecution.ObservedAccount{}, false, false, nil
	}
	if err != nil {
		return imageexecution.ObservedAccount{}, false, false, err
	}
	account, err := toImageAccount(provider, result.Account(), result.Credential())
	if err != nil {
		return imageexecution.ObservedAccount{}, false, false, err
	}
	if eligible != nil && !eligible(account) {
		return imageexecution.ObservedAccount{}, false, false, nil
	}
	return imageexecution.ObservedAccount{
		Account:     account,
		Observation: result.CredentialObservation(),
	}, result.UsedRateLimitCooldownWaiver(), true, nil
}
