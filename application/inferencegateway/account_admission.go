package inferencegateway

import (
	"context"
	"errors"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	"github.com/madou1217/ai_home/application/admission"
)

var (
	errAdmittedAccountUnavailable = errors.New("排队后的账号已不可调度")
	// errAdmittedAccountConcurrency 表示排队后的账号仅因并发上限不可调度。
	errAdmittedAccountConcurrency = errors.New("排队后的账号并发已满")
)

// acquireAttemptSlots 为一次真实上游调用获取准入名额。
//
// 第二轮的准入统一由 application/admission 承担：系统/Key/账号/账号+模型四层
// 天花板与有界 FIFO 队列都在那里，这里只负责把 Canonical invocation 翻译成准入
// 请求。Claude 原有的“先账号后 Provider”串行语义由账号上限与本函数替换。
func (coordinator *Coordinator) acquireAttemptSlots(
	ctx context.Context,
	invocation Invocation,
) (*admission.Lease, error) {
	return admission.Acquire(ctx, admission.Request{
		Provider:   string(invocation.Route().ProviderID()),
		AccountRef: invocation.Account().Ref().String(),
		Model:      invocation.Route().EffectiveModel(),
	})
}

// refreshAdmittedInvocation 在排队后复核资格与凭据策略。
//
// 上一次尝试可能在排队期间限流、停用或替换了该账号的凭据；只有 Claude 账号
// 需要重新走一遍征召（与既有语义保持一致）。
func (coordinator *Coordinator) refreshAdmittedInvocation(ctx context.Context, invocation Invocation, upstream UpstreamAdapter) (Invocation, error) {
	if invocation.Route().ProviderID() != "claude" {
		return invocation, nil
	}
	request, err := accountrouting.NewPinnedRequest(
		coordinator.catalog,
		string(invocation.Route().ProviderID()),
		invocation.Route().EffectiveModel(),
		invocation.Account().Ref(),
	)
	if err != nil {
		return Invocation{}, err
	}
	request = request.WithSessionAffinity(RequestSessionKey(ctx), invocation.Request().IncludeEncryptedReasoning())
	session, err := coordinator.recruiter.Begin(ctx, request, upstream)
	if err != nil {
		return Invocation{}, err
	}
	recruited, err := session.Next(ctx)
	if errors.Is(err, accountrouting.ErrNoRoutableAccount) {
		if errors.Is(err, accountrouting.ErrConcurrencyExhausted) {
			return Invocation{}, errAdmittedAccountConcurrency
		}
		return Invocation{}, errAdmittedAccountUnavailable
	}
	if err != nil {
		return Invocation{}, err
	}
	if invocation.Request().IncludeEncryptedReasoning() &&
		recruited.CredentialObservation() != invocation.CredentialObservation() {
		return Invocation{}, accountcredentials.ErrCredentialIdentityChanged
	}
	return newInvocation(invocation.Request(), invocation.Route(), recruited.Account(),
		recruited.Binding(), recruited.CredentialObservation(), recruited.QuotaBucket())
}
