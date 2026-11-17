package inmemory

import (
	"context"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// credentialRejectionSlot 的身份、floor、归属和句柄生命周期均由 Runtime.mu 保护。
// floor 只来自已校验的提交或恢复证据；未知旧阻塞不追认为观察所属的代次。
type credentialRejectionSlot struct {
	providerID string
	floor      time.Time
	owner      accountcredentials.CredentialObservation
	unknown    bool
	handles    int
	epoch      uint64
}

type credentialRejectionWrite struct {
	runtime     *Runtime
	route       runtimecore.ModelRoute
	observation accountcredentials.CredentialObservation
	slot        *credentialRejectionSlot
	epoch       uint64
	attempted   bool
	closed      bool
}

// BeginObservedCredentialRejection 必须在外部 current-verifier 之前调用。
// 这里只登记在途身份，不以尚未校验的观察推进 floor 或绑定 provider。
func (runtime *Runtime) BeginObservedCredentialRejection(
	ctx context.Context,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
) (inferencegateway.CredentialRejectionWrite, error) {
	if err := runtime.validateRouteRequest(ctx, route); err != nil {
		return nil, err
	}
	if !observation.IsValid() || observation.IsStaticSecret() ||
		observation.AccountRef() != route.AccountRef() {
		return nil, ErrInvalidRequest
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	accountRef := route.AccountRef()
	runtime.reconcileCredentialRejectionSlot(accountRef, runtime.clock())
	slot := runtime.credentialRejections[accountRef]
	if slot == nil {
		slot = &credentialRejectionSlot{
			unknown: runtime.accountFailures[accountRef].activeAt(runtime.clock())&blockCredentialsUpdated != 0,
		}
		runtime.credentialRejections[accountRef] = slot
	}
	slot.handles++
	return &credentialRejectionWrite{
		runtime: runtime, route: route, observation: observation,
		slot: slot, epoch: slot.epoch,
	}, nil
}

// Commit 在同一锁内检查代次和 slot 身份，再写入原 accountFailures 阻塞位。
// 无论成功、过期或错误，一只句柄都只尝试一次；Close 由调用方 defer。
func (write *credentialRejectionWrite) Commit(
	ctx context.Context,
	failure inferencegateway.AttemptFailure,
) (bool, error) {
	runtime := write.runtime
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if write.closed || write.attempted {
		return false, nil
	}
	write.attempted = true
	if err := runtime.validateRouteRequest(ctx, write.route); err != nil {
		return false, err
	}
	status, known := failure.ObservedHTTPStatus()
	if !failure.IsValid() || !known || status != 401 ||
		failure.RuntimeKind() != runtimecore.FailureCredentialRejected ||
		failure.BlockDirective().Scope() != runtimecore.BlockScopeAccount ||
		failure.BlockDirective().RecoveryTrigger() != runtimecore.RecoveryCredentialsUpdated {
		return false, ErrInvalidRequest
	}
	accountRef := write.route.AccountRef()
	if runtime.credentialRejections[accountRef] != write.slot {
		return false, nil
	}
	now := runtime.clock()
	runtime.reconcileCredentialRejectionSlot(accountRef, now)
	slot := write.slot
	observation := write.observation
	if slot.epoch != write.epoch ||
		slot.providerID != "" && slot.providerID != observation.ProviderID() ||
		observation.UpdatedAt().Before(slot.floor) {
		return false, nil
	}
	if err := runtime.recordFailureLocked(ctx, write.route, failure, now); err != nil {
		return false, err
	}
	slot.providerID = observation.ProviderID()
	slot.floor = observation.UpdatedAt()
	if !slot.unknown {
		slot.owner = observation
	}
	return true, nil
}

// Close 只释放原 slot；manual/Forget 后同 ref 的新 slot 不受旧句柄影响。
func (write *credentialRejectionWrite) Close() {
	runtime := write.runtime
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if write.closed {
		return
	}
	write.closed = true
	accountRef := write.route.AccountRef()
	if runtime.credentialRejections[accountRef] != write.slot {
		return
	}
	write.slot.handles--
	runtime.reconcileCredentialRejectionSlot(accountRef, runtime.clock())
}

// ClearObservedCredentialRejection 仅比较并移除 exact owner 的内存凭据阻塞位。
// 调用方必须已取得权威 replacement；这里不清持久投影，也不恢复其它调度事实。
func (runtime *Runtime) ClearObservedCredentialRejection(
	ctx context.Context,
	rejected accountcredentials.CredentialObservation,
	replacement accountcredentials.CredentialObservation,
) (bool, error) {
	if _, err := runtime.accountRecoveryBlock(ctx, rejected.AccountRef(), runtimecore.RecoveryCredentialsUpdated); err != nil {
		return false, err
	}
	if !rejected.IsValid() || !replacement.IsValid() ||
		rejected.IsStaticSecret() || replacement.IsStaticSecret() ||
		rejected.AccountRef() != replacement.AccountRef() ||
		rejected.ProviderID() != replacement.ProviderID() ||
		!replacement.UpdatedAt().After(rejected.UpdatedAt()) {
		return false, ErrInvalidRecovery
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	accountRef := rejected.AccountRef()
	now := runtime.clock()
	runtime.reconcileCredentialRejectionSlot(accountRef, now)
	slot := runtime.credentialRejections[accountRef]
	if slot == nil || slot.unknown || !sameCredentialObservation(slot.owner, rejected) ||
		slot.providerID != rejected.ProviderID() || replacement.UpdatedAt().Before(slot.floor) ||
		runtime.accountFailures[accountRef].activeAt(now)&blockCredentialsUpdated == 0 ||
		(runtime.accountBlocks[accountRef]|runtime.persistedFailures[accountRef].activeAt(now))&blockCredentialsUpdated != 0 {
		return false, nil
	}
	// 不调用 ref-only clearer：它会清真相源位，并且无法保留在途旧句柄的 floor。
	next := runtime.accountFailures[accountRef].clear(blockCredentialsUpdated)
	if next.set == 0 {
		delete(runtime.accountFailures, accountRef)
	} else {
		runtime.accountFailures[accountRef] = next
	}
	slot.owner = accountcredentials.CredentialObservation{}
	slot.floor = replacement.UpdatedAt()
	runtime.reconcileCredentialRejectionSlot(accountRef, now)
	return true, nil
}

// reconcileCredentialRejectionSlot 只在 mu 内运行，不扫描健康账号。
// 到期后保留活句柄所需 floor，同时以 epoch 作废到期前的句柄；新的 Begin
// 可在同 slot 上登记，旧 Close 仍正确计数。没有活句柄/凭据 bit 即收回稀疏条目。
func (runtime *Runtime) reconcileCredentialRejectionSlot(accountRef accountcore.AccountRef, now time.Time) {
	slot := runtime.credentialRejections[accountRef]
	if slot == nil {
		return
	}
	active := runtime.accountFailures[accountRef].activeAt(now)&blockCredentialsUpdated != 0
	if !active && (slot.owner.IsValid() || slot.unknown) {
		slot.epoch++
		slot.owner = accountcredentials.CredentialObservation{}
		slot.unknown = false
	} else if active && !slot.owner.IsValid() {
		slot.unknown = true
	}
	if !active && slot.handles == 0 {
		delete(runtime.credentialRejections, accountRef)
	}
}

func sameCredentialObservation(left, right accountcredentials.CredentialObservation) bool {
	return left.IsValid() && right.IsValid() &&
		left.AccountRef() == right.AccountRef() && left.ProviderID() == right.ProviderID() &&
		left.UpdatedAt().Equal(right.UpdatedAt()) && left.IsStaticSecret() == right.IsStaticSecret()
}

var _ inferencegateway.ObservedCredentialRejectionRuntime = (*Runtime)(nil)
