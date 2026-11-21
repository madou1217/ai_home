package inferencegateway

import (
	"context"
	"errors"
	"sync"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
)

// claudeAccountGate serializes a credential's upstream calls, not the entire
// provider. Separate API Key accounts may use independent servers, while a
// single account can enforce a hard upstream concurrency limit of one.
type claudeAccountGate struct {
	mu      sync.Mutex
	entries map[accountcore.AccountRef]*claudeAccountSlot
	waiting int
}

type claudeAccountSlot struct {
	sem  chan struct{}
	refs int
}

func newClaudeAccountGate() *claudeAccountGate {
	return &claudeAccountGate{entries: make(map[accountcore.AccountRef]*claudeAccountSlot)}
}

var errAdmittedAccountUnavailable = errors.New("排队后的账号已不可调度")

// enterQueue counts both account and provider waits against the original
// provider-wide bound, without reserving any provider execution capacity.
func (gate *claudeAccountGate) enterQueue(limit int) (func(), error) {
	gate.mu.Lock()
	if gate.waiting >= limit {
		gate.mu.Unlock()
		return nil, ErrProviderQueueFull
	}
	gate.waiting++
	gate.mu.Unlock()
	return func() {
		gate.mu.Lock()
		gate.waiting--
		gate.mu.Unlock()
	}, nil
}

func (gate *claudeAccountGate) acquire(ctx context.Context, ref accountcore.AccountRef, queueLimit int) (func(), error) {
	if gate == nil {
		return func() {}, nil
	}
	gate.mu.Lock()
	slot := gate.entries[ref]
	if slot == nil {
		slot = &claudeAccountSlot{sem: make(chan struct{}, 1)}
		gate.entries[ref] = slot
	}
	if slot.refs >= queueLimit+1 {
		gate.mu.Unlock()
		return nil, ErrProviderQueueFull
	}
	slot.refs++
	gate.mu.Unlock()
	forget := func() {
		gate.mu.Lock()
		slot.refs--
		if slot.refs == 0 {
			delete(gate.entries, ref)
		}
		gate.mu.Unlock()
	}
	select {
	case slot.sem <- struct{}{}:
		return func() {
			<-slot.sem
			forget()
		}, nil
	case <-ctx.Done():
		forget()
		return nil, ctx.Err()
	}
}

// acquireRouteSlot preserves the existing route-scoped limit for other
// providers. Claude must wait for the account before acquiring its global slot.
func (coordinator *Coordinator) acquireRouteSlot(ctx context.Context, route Route) (func(), error) {
	if route.ProviderID() == inference.ProviderClaude {
		return func() {}, nil
	}
	return coordinator.gate.acquire(ctx, string(route.ProviderID()))
}

func (coordinator *Coordinator) acquireAttemptSlots(ctx context.Context, invocation Invocation) (func(), error) {
	if invocation.Route().ProviderID() != inference.ProviderClaude {
		return func() {}, nil
	}
	queueLimit := DefaultProviderQueueLimit
	if coordinator.gate != nil {
		queueLimit = coordinator.gate.queueLimit
	}
	leaveQueue, err := coordinator.accountGate.enterQueue(queueLimit)
	if err != nil {
		return nil, err
	}
	defer leaveQueue()
	releaseAccount, err := coordinator.accountGate.acquire(ctx, invocation.Account().Ref(), queueLimit)
	if err != nil {
		return nil, err
	}
	releaseProvider, err := coordinator.gate.acquire(ctx, string(inference.ProviderClaude))
	if err != nil {
		releaseAccount()
		return nil, err
	}
	return func() {
		releaseProvider()
		releaseAccount()
	}, nil
}

// refreshAdmittedInvocation repeats the existing eligibility/credential policy
// after waiting. A previous attempt may have throttled, disabled or replaced
// this account's credential while the invocation was queued.
func (coordinator *Coordinator) refreshAdmittedInvocation(ctx context.Context, invocation Invocation, upstream UpstreamAdapter) (Invocation, error) {
	if invocation.Route().ProviderID() != inference.ProviderClaude {
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
